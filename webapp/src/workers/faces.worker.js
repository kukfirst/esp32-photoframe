// Sort tab analysis of one photo, off the main thread (cachypc fork):
// thumbnail, EXIF date/GPS, a perceptual hash for bursts, and faces with
// ArcFace embeddings. The maths mirrors cachypc/sort/faces_reference.py,
// which was checked on the owner's photos (same person 0.37-0.77 cosine,
// different people <= 0.20).
import * as ort from "onnxruntime-web/wasm";
import ExifReader from "exifreader";

const DET_SIZE = 640;
const SCORE_TH = 0.5;
const NMS_TH = 0.4;
const WORK_MAX = 1600; // decoded size used for face crops
const THUMB_MAX = 360;
const ARCFACE_DST = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let sessions = null;

async function init({ modelBase, wasmBase }) {
  ort.env.wasm.wasmPaths = wasmBase;
  ort.env.wasm.numThreads = 1; // threads need cross-origin isolation; one is fast enough here
  const load = async (name) => {
    const resp = await fetch(`${modelBase}${name}`);
    if (!resp.ok) throw new Error(`model ${name}: HTTP ${resp.status} — ${await resp.text()}`);
    return ort.InferenceSession.create(new Uint8Array(await resp.arrayBuffer()), {
      executionProviders: ["wasm"],
    });
  };
  sessions = { det: await load("det_500m.onnx"), rec: await load("w600k_mbf.onnx") };
}

function canvasOf(w, h) {
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext("2d", { willReadFrequently: true })];
}

// ---------- detection (SCRFD) ----------

async function detect(bitmap) {
  const scale = DET_SIZE / Math.max(bitmap.width, bitmap.height);
  const nw = Math.round(bitmap.width * scale);
  const nh = Math.round(bitmap.height * scale);
  const [, ctx] = canvasOf(DET_SIZE, DET_SIZE);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, DET_SIZE, DET_SIZE);
  ctx.drawImage(bitmap, 0, 0, nw, nh);
  const px = ctx.getImageData(0, 0, DET_SIZE, DET_SIZE).data;
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane);
  // RGB, (v - 127.5) / 128; the black padding matches the reference's zero canvas.
  for (let i = 0; i < plane; i++) {
    input[i] = (px[i * 4] - 127.5) / 128;
    input[plane + i] = (px[i * 4 + 1] - 127.5) / 128;
    input[2 * plane + i] = (px[i * 4 + 2] - 127.5) / 128;
  }
  const det = sessions.det;
  const out = await det.run({
    [det.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, DET_SIZE, DET_SIZE]),
  });
  const o = det.outputNames.map((n) => out[n].data);
  const found = [];
  [8, 16, 32].forEach((stride, s) => {
    const scores = o[s];
    const boxes = o[s + 3];
    const kps = o[s + 6];
    const grid = DET_SIZE / stride;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] < SCORE_TH) continue;
      const cell = Math.floor(i / 2); // two anchors per cell
      const cx = (cell % grid) * stride;
      const cy = Math.floor(cell / grid) * stride;
      const b = boxes.subarray(i * 4, i * 4 + 4);
      const k = kps.subarray(i * 10, i * 10 + 10);
      found.push({
        score: scores[i],
        box: [cx - b[0] * stride, cy - b[1] * stride, cx + b[2] * stride, cy + b[3] * stride].map(
          (v) => v / scale
        ),
        kps: Array.from({ length: 5 }, (_, j) => [
          (cx + k[j * 2] * stride) / scale,
          (cy + k[j * 2 + 1] * stride) / scale,
        ]),
      });
    }
  });
  return nms(found);
}

function nms(list) {
  list.sort((a, b) => b.score - a.score);
  const keep = [];
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  for (const f of list) {
    const overlaps = keep.some((k) => {
      const w = Math.min(f.box[2], k.box[2]) - Math.max(f.box[0], k.box[0]);
      const h = Math.min(f.box[3], k.box[3]) - Math.max(f.box[1], k.box[1]);
      if (w <= 0 || h <= 0) return false;
      const inter = w * h;
      return inter / (area(f.box) + area(k.box) - inter) > NMS_TH;
    });
    if (!overlaps) keep.push(f);
  }
  return keep;
}

// ---------- recognition (ArcFace) ----------

// Umeyama similarity: [a, b, tx, ty] with x' = a*x - b*y + tx, y' = b*x + a*y + ty.
function similarity(src, dst) {
  const mean = (pts) =>
    pts.reduce((m, p) => [m[0] + p[0] / pts.length, m[1] + p[1] / pts.length], [0, 0]);
  const ms = mean(src);
  const md = mean(dst);
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  src.forEach((p, i) => {
    const sx = p[0] - ms[0];
    const sy = p[1] - ms[1];
    const dx = dst[i][0] - md[0];
    const dy = dst[i][1] - md[1];
    num1 += dx * sx + dy * sy;
    num2 += dy * sx - dx * sy;
    den += sx * sx + sy * sy;
  });
  const a = num1 / den;
  const b = num2 / den;
  return [a, b, md[0] - (a * ms[0] - b * ms[1]), md[1] - (b * ms[0] + a * ms[1])];
}

async function embedAndSharpness(bitmap, kps) {
  const [a, b, tx, ty] = similarity(kps, ARCFACE_DST);
  const [, ctx] = canvasOf(112, 112);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.setTransform(a, b, -b, a, tx, ty);
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, 112, 112).data;
  const plane = 112 * 112;
  const input = new Float32Array(3 * plane);
  const gray = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    input[i] = (px[i * 4] - 127.5) / 127.5;
    input[plane + i] = (px[i * 4 + 1] - 127.5) / 127.5;
    input[2 * plane + i] = (px[i * 4 + 2] - 127.5) / 127.5;
    gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  const rec = sessions.rec;
  const out = await rec.run({
    [rec.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 112, 112]),
  });
  const e = out[rec.outputNames[0]].data;
  const norm = Math.hypot(...e);
  // Sharpness: variance of the Laplacian on the aligned face (the inner area).
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 20; y < 100; y++) {
    for (let x = 20; x < 92; x++) {
      const i = y * 112 + x;
      const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - 112] - gray[i + 112];
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  return { embedding: Float32Array.from(e, (v) => v / norm), sharpness: sum2 / n - (sum / n) ** 2 };
}

// ---------- the rest: thumbnail, dHash, EXIF ----------

function dhash(bitmap) {
  const [, ctx] = canvasOf(9, 8);
  ctx.drawImage(bitmap, 0, 0, 9, 8);
  const px = ctx.getImageData(0, 0, 9, 8).data;
  const lum = (i) => px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
  let bits = "";
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) bits += lum(y * 9 + x) > lum(y * 9 + x + 1) ? "1" : "0";
  return bits;
}

function exifInfo(buffer) {
  try {
    const t = ExifReader.load(buffer);
    return {
      dateTag: ["DateTimeOriginal", "DateTimeDigitized", "DateTime"]
        .map((n) => t[n]?.description)
        .find((d) => typeof d === "string"),
      lat: t.GPSLatitude?.description,
      latRef: t.GPSLatitudeRef?.value?.[0],
      lon: t.GPSLongitude?.description,
      lonRef: t.GPSLongitudeRef?.value?.[0],
    };
  } catch {
    return {};
  }
}

async function analyse(file) {
  const buffer = await file.arrayBuffer();
  const exif = exifInfo(buffer);
  const full = await createImageBitmap(new Blob([buffer]), { imageOrientation: "from-image" });
  const width = full.width;
  const height = full.height;
  const k = Math.min(1, WORK_MAX / Math.max(width, height));
  const work = await createImageBitmap(full, {
    resizeWidth: Math.round(width * k),
    resizeHeight: Math.round(height * k),
    resizeQuality: "high",
  });
  full.close();

  const tk = THUMB_MAX / Math.max(work.width, work.height);
  const [tc, tctx] = canvasOf(Math.round(work.width * tk), Math.round(work.height * tk));
  tctx.drawImage(work, 0, 0, tc.width, tc.height);
  const thumb = await tc.convertToBlob({ type: "image/jpeg", quality: 0.8 });

  const faces = [];
  for (const f of await detect(work)) {
    const { embedding, sharpness } = await embedAndSharpness(work, f.kps);
    faces.push({
      score: f.score,
      // Normalised box: independent of the decoded size.
      box: [
        f.box[0] / work.width,
        f.box[1] / work.height,
        f.box[2] / work.width,
        f.box[3] / work.height,
      ],
      embedding,
      sharpness,
    });
  }
  const hash = dhash(work);
  work.close();
  return { width, height, exif, thumb, faces, hash };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      await init(data);
      self.postMessage({ id: data.id, ok: true });
    } else {
      self.postMessage({ id: data.id, ok: true, result: await analyse(data.file) });
    }
  } catch (e) {
    self.postMessage({ id: data.id, ok: false, error: String(e?.message || e) });
  }
};
