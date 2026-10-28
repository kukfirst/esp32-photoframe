"""One AI upscale in its own process: load the model, upscale, write PNG, exit.

Run by server.py. A fresh process per job means the CUDA context and all VRAM
are released as soon as the job ends, so nothing lingers next to the local LLM.

    job.py --gpu N --model PATH INPUT.png OUTPUT.png
"""

import argparse

import numpy as np
import torch
from PIL import Image
from spandrel import ModelLoader

TILE = 512
OVERLAP = 32


def upscale(model, img: torch.Tensor) -> torch.Tensor:
    """Tiled inference so VRAM stays bounded regardless of input size."""
    _, _, h, w = img.shape
    scale = model.scale
    out = torch.zeros((1, 3, h * scale, w * scale), dtype=torch.float32)
    step = TILE - 2 * OVERLAP
    for y0 in range(0, h, step):
        for x0 in range(0, w, step):
            # Tile with overlap, clipped to the image.
            ty0, tx0 = max(0, y0 - OVERLAP), max(0, x0 - OVERLAP)
            ty1, tx1 = min(h, y0 + step + OVERLAP), min(w, x0 + step + OVERLAP)
            tile = img[:, :, ty0:ty1, tx0:tx1]
            with torch.inference_mode():
                res = model(tile).float().cpu()
            # Keep only the tile's own area (drop the overlap) in output space.
            oy0, ox0 = (y0 - ty0) * scale, (x0 - tx0) * scale
            oh, ow = (min(y0 + step, h) - y0) * scale, (min(x0 + step, w) - x0) * scale
            out[:, :, y0 * scale : y0 * scale + oh, x0 * scale : x0 * scale + ow] = res[
                :, :, oy0 : oy0 + oh, ox0 : ox0 + ow
            ]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gpu", type=int, required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("input")
    ap.add_argument("output")
    args = ap.parse_args()

    device = torch.device(f"cuda:{args.gpu}")
    model = ModelLoader().load_from_file(args.model).to(device).eval()
    if model.supports_half:
        model.half()
    dtype = torch.float16 if model.supports_half else torch.float32

    rgb = np.asarray(Image.open(args.input).convert("RGB"), dtype=np.float32) / 255.0
    img = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0).to(device, dtype)
    out = upscale(model, img)
    arr = (out.squeeze(0).permute(1, 2, 0).clamp(0, 1).numpy() * 255.0).round().astype(np.uint8)
    Image.fromarray(arr).save(args.output)


if __name__ == "__main__":
    main()
