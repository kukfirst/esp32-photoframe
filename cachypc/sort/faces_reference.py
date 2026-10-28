"""Reference face pipeline (numpy + onnxruntime) to check the browser worker.

SCRFD det_500m -> boxes + 5 landmarks; similarity-align to 112x112; ArcFace
w600k_mbf -> 512-d L2-normalised embedding. Same maths as webapp's
src/workers/faces.worker.js, so their outputs can be compared.

    python faces_reference.py IMAGE... [--json out.json]
"""

import json
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

MODELS = __import__("pathlib").Path.home() / "models/photoframe"
DET_SIZE = 640
SCORE_TH = 0.5
NMS_TH = 0.4
ARCFACE_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                        [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


def detect(sess, img: Image.Image):
    w, h = img.size
    scale = DET_SIZE / max(w, h)
    nw, nh = round(w * scale), round(h * scale)
    canvas = np.zeros((DET_SIZE, DET_SIZE, 3), dtype=np.float32)
    canvas[:nh, :nw] = np.asarray(img.resize((nw, nh), Image.BILINEAR), dtype=np.float32)
    blob = ((canvas - 127.5) / 128.0).transpose(2, 0, 1)[None]
    outs = sess.run(None, {sess.get_inputs()[0].name: blob})
    boxes, scores, kpss = [], [], []
    for i, stride in enumerate((8, 16, 32)):
        sc, bb, kp = outs[i][:, 0], outs[i + 3] * stride, outs[i + 6] * stride
        g = DET_SIZE // stride
        ys, xs = np.mgrid[0:g, 0:g]
        centers = np.stack([xs, ys], -1).reshape(-1, 2).astype(np.float32) * stride
        centers = np.repeat(centers, 2, axis=0)
        keep = sc >= SCORE_TH
        c = centers[keep]
        b = bb[keep]
        boxes.append(np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], 1))
        scores.append(sc[keep])
        k = kp[keep].reshape(-1, 5, 2)
        kpss.append(k + c[:, None, :])
    boxes, scores, kpss = np.concatenate(boxes), np.concatenate(scores), np.concatenate(kpss)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0]); yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2]); yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
        iou = inter / (area(boxes[i]) + area(boxes[order[1:]]) - inter)
        order = order[1:][iou <= NMS_TH]
    return boxes[keep] / scale, scores[keep], kpss[keep] / scale


def similarity(src, dst):
    """Umeyama: 2x3 matrix mapping src points onto dst (rotation, scale, shift)."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    s, d = src - mu_s, dst - mu_d
    a = (d[:, 0] * s[:, 0] + d[:, 1] * s[:, 1]).sum() / (s ** 2).sum()
    b = (d[:, 1] * s[:, 0] - d[:, 0] * s[:, 1]).sum() / (s ** 2).sum()
    m = np.array([[a, -b, 0], [b, a, 0]], dtype=np.float32)
    m[:, 2] = mu_d - m[:, :2] @ mu_s
    return m


def embed(sess, img: Image.Image, kps):
    m = similarity(kps, ARCFACE_DST)
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))[:2]  # PIL wants output->input
    face = img.transform((112, 112), Image.AFFINE, inv.flatten(), Image.BILINEAR)
    blob = ((np.asarray(face, dtype=np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[None]
    e = sess.run(None, {sess.get_inputs()[0].name: blob})[0][0]
    return e / np.linalg.norm(e)


def main(paths):
    det = ort.InferenceSession(str(MODELS / "det_500m.onnx"), providers=["CPUExecutionProvider"])
    rec = ort.InferenceSession(str(MODELS / "w600k_mbf.onnx"), providers=["CPUExecutionProvider"])
    out = {}
    for p in paths:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
        boxes, scores, kpss = detect(det, img)
        faces = []
        for b, s, k in zip(boxes, scores, kpss):
            faces.append({"box": [round(float(x)) for x in b], "score": round(float(s), 3),
                          "embedding": embed(rec, img, k).round(5).tolist()})
        out[p] = {"size": img.size, "faces": faces}
        print(p.split("/")[-1], img.size, [(f["box"], f["score"]) for f in faces])
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    dump = None
    if "--json" in args:
        i = args.index("--json"); dump = args[i + 1]; args = args[:i] + args[i + 2:]
    res = main(args)
    if dump:
        json.dump(res, open(dump, "w"))
