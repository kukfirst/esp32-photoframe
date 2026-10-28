// Sort tab helpers (cachypc fork): face worker pool, scoring, bursts, people.

export const FACE = {
  minScore: 0.6, // detector confidence
  minSize: 0.06, // face height / image height
  minSharpness: 15, // Laplacian variance on the aligned 112 px face (sharp faces 30-490, blurry 5-12 on the owner's photos)
  match: 0.3, // cosine to a tagged person (same person 0.37-0.77, others <= 0.20 on the owner's photos)
  cluster: 0.35,
};
// Near-identical shots (dHash distance over 64 bits) and the same scene from a
// slightly different angle shortly after; only the best of such a run is pre-checked.
export const BURST = { seconds: 20, hamming: 12, sceneSeconds: 90, sceneHamming: 22 };

// ---------- worker pool ----------

export function createFacePool(size, { modelBase, wasmBase }) {
  const workers = Array.from({ length: size }, () => ({
    worker: new Worker(new URL("../workers/faces.worker.js", import.meta.url), { type: "module" }),
    pending: new Map(),
  }));
  let nextId = 1;
  for (const w of workers) {
    w.worker.onmessage = ({ data }) => {
      const p = w.pending.get(data.id);
      w.pending.delete(data.id);
      if (data.ok) p?.resolve(data.result);
      else p?.reject(new Error(data.error));
    };
  }
  const call = (w, msg) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      w.pending.set(id, { resolve, reject });
      w.worker.postMessage({ ...msg, id });
    });
  return {
    size,
    init: () => Promise.all(workers.map((w) => call(w, { type: "init", modelBase, wasmBase }))),
    analyse: (i, file) => call(workers[i % size], { type: "analyse", file }),
    terminate: () => workers.forEach((w) => w.worker.terminate()),
  };
}

// ---------- faces and people ----------

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function isGoodFace(f) {
  const height = f.box[3] - f.box[1];
  const inside = f.box[0] > 0.005 && f.box[1] > 0.005 && f.box[2] < 0.995 && f.box[3] < 0.995;
  return (
    f.score >= FACE.minScore && height >= FACE.minSize && f.sharpness >= FACE.minSharpness && inside
  );
}

/** Which tagged person a face is, or null. */
export function whoIs(face, people) {
  let best = null;
  let bestSim = FACE.match;
  for (const p of people) {
    for (const e of p.embeddings) {
      const s = cosine(face.embedding, e);
      if (s >= bestSim) {
        bestSim = s;
        best = p.id;
      }
    }
  }
  return best;
}

/**
 * Score one analysed photo. `us` = every tagged person is among the good faces.
 * Returns { good, people: [ids], us, score }.
 */
export function scorePhoto(photo, people) {
  const good = photo.faces.filter(isGoodFace);
  const ids = new Set();
  for (const f of good) {
    f.person = whoIs(f, people);
    if (f.person) ids.add(f.person);
  }
  const us = people.length > 0 && people.every((p) => ids.has(p.id));
  const sharp = good.length ? Math.min(...good.map((f) => f.sharpness)) : 0;
  const size = good.reduce((s, f) => s + (f.box[3] - f.box[1]), 0);
  const score =
    (us ? 1000 : 0) +
    ids.size * 100 +
    Math.min(good.length, 4) * 20 +
    Math.min(sharp, 400) / 20 +
    size * 50;
  return { good: good.length, people: [...ids], us, score };
}

/** Should a photo start checked? Tagged people known: only "us"; else two or more good faces. */
export function preselect(photo, peopleCount) {
  return peopleCount ? photo.us : photo.good >= 2;
}

// ---------- bursts ----------

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Mark near-identical shots taken seconds apart: photos sorted by time; a photo
 * joins the previous burst when close in time and in dHash. The best-scored
 * photo of a burst keeps `burstBest`; the others get `dupOf`.
 */
export function markBursts(photos) {
  let burst = [];
  const flush = () => {
    if (burst.length > 1) {
      const best = burst.reduce((a, b) => (b.score > a.score ? b : a));
      for (const p of burst) p.dupOf = p === best ? null : best.id;
      best.burstSize = burst.length;
    }
    burst = [];
  };
  let prev = null;
  for (const p of photos) {
    p.dupOf = null;
    p.burstSize = 1;
    const dt = p.time != null && prev?.time != null ? Math.abs(p.time - prev.time) / 1000 : null;
    const dist = prev ? hamming(p.hash, prev.hash) : 64;
    const close =
      dt != null &&
      ((dt <= BURST.seconds && dist <= BURST.hamming) ||
        (dt <= BURST.sceneSeconds && dist <= BURST.sceneHamming));
    if (!close) flush();
    burst.push(p);
    prev = p;
  }
  flush();
}

// ---------- face clusters for tagging ----------

/** Greedy clusters of good faces across photos, biggest first. */
export function clusterFaces(photos) {
  const clusters = [];
  for (const photo of photos) {
    for (const face of photo.faces.filter(isGoodFace)) {
      let best = null;
      let bestSim = FACE.cluster;
      for (const c of clusters) {
        const s = cosine(face.embedding, c.centre);
        if (s >= bestSim) {
          bestSim = s;
          best = c;
        }
      }
      if (!best) {
        best = { members: [], centre: Float32Array.from(face.embedding) };
        clusters.push(best);
      }
      best.members.push({ photo, face });
      // Running mean, renormalised.
      const n = best.members.length;
      let norm = 0;
      for (let i = 0; i < best.centre.length; i++) {
        best.centre[i] = best.centre[i] + (face.embedding[i] - best.centre[i]) / n;
        norm += best.centre[i] ** 2;
      }
      norm = Math.sqrt(norm);
      for (let i = 0; i < best.centre.length; i++) best.centre[i] /= norm;
    }
  }
  return clusters.sort((a, b) => b.members.length - a.members.length);
}

/** EXIF "2015:04:20 17:35:51" -> ms (local time), else null. */
export function exifTime(tag) {
  const m =
    typeof tag === "string" && tag.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1990) return null; // camera clock reset defaults
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

export function exifGps(exif) {
  const lat = Number(exif.lat);
  const lon = Number(exif.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return {
    lat: String(exif.latRef || "N").startsWith("S") ? -Math.abs(lat) : Math.abs(lat),
    lon: String(exif.lonRef || "E").startsWith("W") ? -Math.abs(lon) : Math.abs(lon),
  };
}
