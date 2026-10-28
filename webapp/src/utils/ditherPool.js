// Two dithering workers: "preview" for the selected photo, so it never waits
// behind tiles or uploads, and "background" for tiles and uploads. Each lane
// runs one job at a time; queuing a job whose key is already waiting replaces
// the waiting one (its promise resolves to { stale: true }), so dragging a
// slider does not pile up renders nobody will see.

const lanes = {};
let nextId = 1;

function lane(name) {
  if (!lanes[name]) {
    const worker = new Worker(new URL("../workers/dither.worker.js", import.meta.url), {
      type: "module",
    });
    const state = { worker, queue: [], running: null };
    worker.onmessage = ({ data }) => {
      const job = state.running;
      state.running = null;
      if (job && job.id === data.id) {
        if (data.error) job.reject(new Error(data.error));
        else job.resolve(data);
      }
      pump(state);
    };
    lanes[name] = state;
  }
  return lanes[name];
}

function pump(state) {
  if (state.running || !state.queue.length) return;
  const job = state.queue.shift();
  state.running = job;
  state.worker.postMessage(
    { id: job.id, kind: job.kind, bitmap: job.bitmap, options: job.options },
    [job.bitmap]
  );
}

/**
 * @param laneName  "preview" or "background"
 * @param key       jobs with the same key replace each other while waiting
 * @param kind      "preview" -> { blob } (PNG), "upload" -> { epdgz, original }
 * @param bitmap    ImageBitmap of the composed frame (transferred)
 * @param options   processImage options (plain, structured-cloneable)
 */
export function dither(laneName, key, kind, bitmap, options) {
  const state = lane(laneName);
  return new Promise((resolve, reject) => {
    const waiting = state.queue.findIndex((j) => j.key === key);
    if (waiting >= 0) {
      const [old] = state.queue.splice(waiting, 1);
      old.bitmap.close();
      old.resolve({ stale: true });
    }
    state.queue.push({ id: nextId++, key, kind, bitmap, options, resolve, reject });
    pump(state);
  });
}
