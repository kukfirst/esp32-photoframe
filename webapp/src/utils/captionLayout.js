// Frame composition for batch uploads: the photo fitted (or cropped) into the
// logical display, the remaining area filled with a blurred copy of the photo,
// and a date/place caption placed only on that fill area -- never on the photo.

export const MODES = ["fit", "crop"];

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

/**
 * @param img     decoded image (EXIF orientation already applied by the browser)
 * @param width   logical display width (orientation applied)
 * @param height  logical display height
 * @param mode    "fit" keeps the whole photo, "crop" fills the frame
 * @param lines   caption lines; empty strings are dropped
 * @returns canvas of exactly width x height
 */
export function composeFrame(img, { width: W, height: H, mode = "fit", lines = [] }) {
  const caption = lines.filter(Boolean);
  const m = captionMetrics(H);
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext("2d");
  drawBlurFill(ctx, img, W, H);

  const pw = img.width;
  const ph = img.height;
  let box;
  let capBox = null;

  if (mode === "crop") {
    const areaH = caption.length ? H - m.strip : H;
    const scale = Math.max(W / pw, areaH / ph);
    const sw = W / scale;
    const sh = areaH / scale;
    ctx.drawImage(img, (pw - sw) / 2, (ph - sh) / 2, sw, sh, 0, 0, W, areaH);
    if (caption.length) capBox = [0, areaH, W, H];
  } else {
    let scale = Math.min(W / pw, H / ph);
    let sw = Math.round(pw * scale);
    let sh = Math.round(ph * scale);
    let side = Math.floor((W - sw) / 2);
    let top = Math.floor((H - sh) / 2);
    if (caption.length) {
      if (side >= W * 0.15) {
        // Portrait on a landscape frame: bottom of the right bar.
        capBox = [W - side, H - m.strip - m.pad, W, H];
      } else if (top >= m.strip) {
        // Wide photo: the bottom bar.
        capBox = [0, top + sh, W, H];
      } else {
        // Same aspect as the frame: shrink until a bottom strip exists.
        scale = Math.min(W / pw, (H - m.strip) / ph);
        sw = Math.round(pw * scale);
        sh = Math.round(ph * scale);
        side = Math.floor((W - sw) / 2);
        top = Math.floor((H - m.strip - sh) / 2);
        capBox = [0, H - m.strip, W, H];
      }
    }
    box = [side, top, sw, sh];
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, ...box);
  }

  if (capBox) drawCaption(ctx, capBox, caption, m);
  return canvas;
}
