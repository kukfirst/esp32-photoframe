// Dithering workers, one per lane: "preview" for the selected photo, so it
// never waits behind anything; "tiles" for the strip; "upload" for sending, so
// a send never queues behind dozens of tile redraws. Each lane runs one job at
// a time; queuing a job whose key is already waiting replaces the waiting one
// (its promise resolves to { stale: true }), so dragging a slider does not
// pile up renders nobody will see.
//
// A worker that crashes (e.g. out of memory on a huge photo) or does not answer
// within JOB_TIMEOUT_MS is replaced; its job fails with a readable error
// instead of leaving the caller waiting forever.

const JOB_TIMEOUT_MS = 120_000;
const lanes = {};
let nextId = 1;

function startWorker(state) {
  const worker = new Worker(new URL("../workers/dither.worker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = ({ data }) => {
    const job = state.running;
    if (!job || job.id !== data.id) return;
    finish(state);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data);
    pump(state);
  };
  const fail = (message) => {
    const job = state.running;
    worker.terminate();
    state.worker = startWorker(state);
    finish(state);
    job?.reject(new Error(message));
    pump(state);
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    fail(
      `image processing crashed (${e.message || "worker error"}); try again or use a smaller photo`
    );
  };
  worker.onmessageerror = () => fail("image processing returned unreadable data");
  state.fail = fail;
  return worker;
}

function finish(state) {
  clearTimeout(state.timer);
  state.running = null;
}

function lane(name) {
  if (!lanes[name]) {
    const state = { queue: [], running: null, timer: null };
    state.worker = startWorker(state);
    lanes[name] = state;
  }
  return lanes[name];
}

function pump(state) {
  if (state.running || !state.queue.length) return;
  const job = state.queue.shift();
  state.running = job;
  state.timer = setTimeout(
    () =>
      state.fail(`image processing took longer than ${JOB_TIMEOUT_MS / 1000} s and was stopped`),
    JOB_TIMEOUT_MS
  );
  state.worker.postMessage(
    { id: job.id, kind: job.kind, bitmap: job.bitmap, options: job.options },
    [job.bitmap]
  );
}

/**
 * @param laneName  "preview", "tiles" or "upload"
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
