// Dithering off the main thread for BatchUpload.vue (cachypc fork). A full
// frame takes ~0.6 s on a fast desktop and blocked the page while it ran.
//
// The library takes its Node.js path when given a canvas factory, which is
// what lets it run without `document`: frames arrive at the exact display
// size, so the browser-only multi-step downscale branch is never needed.
import { createEPDGZ, processImage } from "@aitjcize/epaper-image-convert";

const createCanvas = (w, h) => new OffscreenCanvas(w, h);

function toCanvas(bitmap) {
  const canvas = createCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

self.onmessage = async ({ data }) => {
  const { id, kind, bitmap, options } = data;
  try {
    const result = processImage(toCanvas(bitmap), { ...options, createCanvas });
    if (kind === "preview") {
      const blob = await result.canvas.convertToBlob({ type: "image/png" });
      self.postMessage({ id, blob });
    } else {
      // Upload: device-ready EPDGZ plus the pre-dither layout for the thumbnail.
      const epdgz = await createEPDGZ(result.canvas, { grayscale: options.grayscale });
      const original = result.originalCanvas.transferToImageBitmap();
      self.postMessage({ id, epdgz, original }, [epdgz.buffer, original]);
    }
  } catch (e) {
    self.postMessage({ id, error: String(e?.stack || e) });
  }
};
