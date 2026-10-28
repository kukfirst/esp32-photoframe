// Frame composition for batch uploads: the photo fitted (or cropped) into the
// logical display, the remaining area filled with a blurred copy of the photo,
// and a date/place caption placed only on that fill area -- never on the photo.

export const MODES = ["fit", "crop", "manual"];

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function coverRect(sw, sh, w, h) {
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  return [(w - dw) / 2, (h - dh) / 2, dw, dh];
}

// Blur by down- then up-sampling: works in every browser, unlike ctx.filter.
function drawBlurFill(ctx, img, w, h) {
  const small = makeCanvas(Math.max(1, Math.round(w / 40)), Math.max(1, Math.round(h / 40)));
  const sctx = small.getContext("2d");
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(img, ...coverRect(img.width, img.height, small.width, small.height));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, w, h);
  ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
  ctx.fillRect(0, 0, w, h);
}

function captionMetrics(h) {
  const px = Math.round(h * 0.026);
  const pad = Math.round(px * 0.5);
  const lineH = Math.round(px * 1.3);
  return { px, pad, lineH, strip: 2 * pad + 2 * lineH + pad };
}

// Black plate, white text: both are exact panel inks, so the caption survives
// dithering as solid shapes instead of speckle.
function drawCaption(ctx, box, lines, m) {
  const [x0, , x1, y1] = box;
  ctx.font = `600 ${m.px}px "Noto Sans", "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = "top";
  const maxW = x1 - x0 - 4 * m.pad;
  const fitted = lines.map((line) => {
    let s = line;
    while (ctx.measureText(s).width > maxW && s.length > 4) s = s.slice(0, -2).trimEnd() + "…";
    return s;
  });
  const textW = Math.max(...fitted.map((s) => ctx.measureText(s).width));
  const plateW = Math.ceil(textW + 2 * m.pad);
  const plateH = m.lineH * fitted.length + m.pad;
  const px1 = x1 - m.pad;
  const py1 = y1 - m.pad;
  ctx.fillStyle = "#000";
  ctx.fillRect(px1 - plateW, py1 - plateH, plateW, plateH);
  ctx.fillStyle = "#fff";
  fitted.forEach((s, i) =>
    ctx.fillText(s, px1 - plateW + m.pad, py1 - plateH + m.pad / 2 + i * m.lineH + m.px * 0.08)
  );
}

// Zoom is relative to "fit" (1 = whole photo visible); this is the zoom at
// which the photo covers the whole frame.
export function coverZoom(img, W, H) {
  return Math.max(W / img.width, H / img.height) / Math.min(W / img.width, H / img.height);
}

export const MAX_ZOOM = 6;

// Keep the requested view inside sane bounds: zoom in [1, MAX_ZOOM] and the
// photo centre (u, v, in photo-relative 0..1 units) such that the photo never
// leaves a gap on a side where it is larger than the frame.
export function clampView(img, W, H, view) {
  const fit = Math.min(W / img.width, H / img.height);
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
  const sw = img.width * fit * zoom;
  const sh = img.height * fit * zoom;
  const clampAxis = (c, size, frame) => {
    if (size <= frame) return 0.5;
    const half = frame / 2 / size;
    return Math.min(1 - half, Math.max(half, c));
  };
  return { zoom, u: clampAxis(view.u, sw, W), v: clampAxis(view.v, sh, H) };
}

/**
 * @param img     decoded image (EXIF orientation already applied by the browser)
 * @param width   logical display width (orientation applied)
 * @param height  logical display height
 * @param mode    "fit" keeps the whole photo, "crop" fills the frame,
 *                "manual" uses `view`
 * @param view    for "manual": { zoom (1 = fit), u, v (photo point at the frame centre) }
 * @param lines   caption lines; empty strings are dropped
 * @returns canvas of exactly width x height
 */
export function composeFrame(img, { width: W, height: H, mode = "fit", view = null, lines = [] }) {
  const caption = lines.filter(Boolean);
  const m = captionMetrics(H);
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext("2d");
  drawBlurFill(ctx, img, W, H);

  const pw = img.width;
  const ph = img.height;
  const fit = Math.min(W / pw, H / ph);
  let v = { zoom: 1, u: 0.5, v: 0.5 };
  if (mode === "crop") v.zoom = coverZoom(img, W, H);
  if (mode === "manual" && view) v = clampView(img, W, H, view);

  let scale = fit * v.zoom;
  let sw = pw * scale;
  let sh = ph * scale;
  let x = W / 2 - v.u * sw;
  let y = H / 2 - v.v * sh;

  let capBox = null;
  if (caption.length) {
    const right = W - (x + sw);
    const bottom = H - (y + sh);
    if (right >= W * 0.15) {
      capBox = [x + sw, H - m.strip - m.pad, W, H]; // right bar
    } else if (bottom >= m.strip) {
      capBox = [0, y + sh, W, H]; // bottom bar
    } else if (x >= W * 0.15) {
      capBox = [0, H - m.strip - m.pad, x, H]; // left bar
    } else if (mode === "fit") {
      // Same aspect as the frame: shrink until a bottom strip exists.
      scale = Math.min(W / pw, (H - m.strip) / ph);
      sw = pw * scale;
      sh = ph * scale;
      x = (W - sw) / 2;
      y = (H - m.strip - sh) / 2;
      capBox = [0, H - m.strip, W, H];
    } else {
      // The photo covers the frame: a small plate in the corner, over the photo.
      capBox = [0, 0, W, H];
    }
  }

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, Math.round(x), Math.round(y), Math.round(sw), Math.round(sh));
  if (capBox) drawCaption(ctx, capBox, caption, m);
  return canvas;
}
