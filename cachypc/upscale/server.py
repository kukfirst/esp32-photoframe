"""Helper service for the cachypc photo-frame UI: AI upscale and the library
of originals.

The frame stores only the finished, dithered frame. To re-edit a photo later
(framing, caption, processing), the page saves the source image and its edit
settings here, keyed by the frame path ("Album/name.epdgz"):

    PUT/GET    /library/source?key=K   source image bytes
    PUT/GET    /library/meta?key=K     edit settings (JSON)
    DELETE     /library/item?key=K
    GET        /library/keys           all keys

Sort tab data: GET /sortdata/<file> serves the face models and the gazetteer
from ~/models/photoframe (whitelisted names); GET/PUT /faces keeps the people
the owner tagged (reference face embeddings), in the library folder.

POST /upscale with a PNG/JPEG body -> 4x PNG, or a JSON error the page shows
as is. Before every job it checks free VRAM with nvidia-smi and refuses to
start when no GPU has enough (the local LLM often holds most of it). Each job
runs in a separate process (job.py) so no VRAM stays allocated afterwards.

Env: UPSCALE_PORT (18087), UPSCALE_MODEL, UPSCALE_PYTHON (a venv with torch +
spandrel), UPSCALE_NEED_MB (3000), PHOTOFRAME_LIBRARY (~/Pictures/photoframe-library).
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("UPSCALE_PORT", "18087"))
MODEL = os.environ.get("UPSCALE_MODEL", str(Path.home() / "models/comfyui/upscale_models/4x-UltraSharp.pth"))
PYTHON = os.environ.get("UPSCALE_PYTHON", str(Path.home() / "ComfyUI/.venv/bin/python"))
NEED_MB = int(os.environ.get("UPSCALE_NEED_MB", "3000"))
MAX_INPUT_BYTES = 40 * 1024 * 1024
MAX_SIDE = 1600  # input side limit: 4x of this is already far beyond the panel
JOB_TIMEOUT = 180
LIBRARY = Path(os.environ.get("PHOTOFRAME_LIBRARY", str(Path.home() / "Pictures/photoframe-library")))
MAX_SOURCE_BYTES = 80 * 1024 * 1024
SORTDATA = Path(os.environ.get("PHOTOFRAME_SORTDATA", str(Path.home() / "models/photoframe")))
SORTDATA_FILES = {
    "det_500m.onnx": "application/octet-stream",
    "w600k_mbf.onnx": "application/octet-stream",
    "gazetteer.json": "application/json",
}
FACES = LIBRARY / "_people.json"

busy = threading.Lock()


class Refused(Exception):
    """An error meant for the user; `status` is the HTTP code."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def gpu_free_mb() -> list[tuple[int, int]]:
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=index,memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=10, check=True,
    ).stdout
    return [tuple(int(x) for x in line.split(",")) for line in out.strip().splitlines()]


def llm_active() -> bool:
    r = subprocess.run(["systemctl", "--user", "is-active", "llama-qwen38.service"],
                       capture_output=True, text=True)
    return r.stdout.strip() == "active"


def pick_gpu() -> int:
    try:
        gpus = gpu_free_mb()
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused(503, f"Cannot read GPU memory (nvidia-smi failed: {e}).")
    best = max(gpus, key=lambda g: g[1])
    if best[1] >= NEED_MB:
        return best[0]
    free = ", ".join(f"GPU{i} {mb / 1024:.1f} GB" for i, mb in gpus)
    hint = (
        " The local LLM (llama-qwen38) is loaded; it unloads itself after 15 minutes without "
        "requests, or stop it with: systemctl --user stop llama-qwen38.service"
        if llm_active() else ""
    )
    raise Refused(503, f"Not enough free GPU memory: {free} free, need {NEED_MB / 1024:.1f} GB.{hint}")


def run_job(data: bytes) -> bytes:
    from_size = image_size(data)
    if max(from_size) > MAX_SIDE:
        raise Refused(413, f"Region too large to upscale ({from_size[0]}×{from_size[1]}); "
                           f"the limit is {MAX_SIDE} px per side.")
    gpu = pick_gpu()
    with tempfile.TemporaryDirectory(prefix="upscale-") as tmp:
        src, dst = Path(tmp, "in.png"), Path(tmp, "out.png")
        src.write_bytes(data)
        try:
            r = subprocess.run([PYTHON, str(HERE / "job.py"), "--gpu", str(gpu), "--model", MODEL, str(src), str(dst)],
                               capture_output=True, text=True, timeout=JOB_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise Refused(504, f"Upscale took longer than {JOB_TIMEOUT} s and was stopped.")
        if r.returncode != 0:
            tail = (r.stderr.strip().splitlines() or ["(no output)"])[-1]
            if "out of memory" in r.stderr.lower():
                raise Refused(503, f"GPU{gpu} ran out of memory during the upscale "
                                   "(something else took VRAM meanwhile). Try again.")
            raise Refused(500, f"Upscale failed on GPU{gpu}: {tail}")
        return dst.read_bytes()


def image_size(data: bytes) -> tuple[int, int]:
    # PNG IHDR or JPEG SOFn, enough to enforce the size limit without decoding.
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                break
            marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
            i += 2 + length
    raise Refused(415, "Send a PNG or JPEG image.")


def entry_dir(key: str) -> Path:
    if not key or len(key) > 300 or "\0" in key:
        raise Refused(400, "Missing or invalid library key.")
    # Album names may hold any characters; a hash keeps paths safe. meta.json keeps the key.
    return LIBRARY / hashlib.sha256(key.encode()).hexdigest()[:24]


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _route(self) -> tuple[str, str]:
        url = urlsplit(self.path)
        return url.path.rstrip("/"), (parse_qs(url.query).get("key") or [""])[0]

    def _body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= limit:
            raise Refused(413, f"Body missing or larger than {limit // 1048576} MB.")
        return self.rfile.read(length)

    def _library(self, method: str, path: str, key: str) -> None:
        try:
            if path == "/library/keys" and method == "GET":
                keys = []
                for meta in LIBRARY.glob("*/meta.json"):
                    try:
                        keys.append(json.loads(meta.read_text())["key"])
                    except (OSError, ValueError, KeyError):
                        continue
                return self._json(200, {"keys": sorted(keys)})
            d = entry_dir(key)
            if path == "/library/item" and method == "DELETE":
                shutil.rmtree(d, ignore_errors=True)
                return self._json(200, {"deleted": key})
            if path == "/library/source" and method == "PUT":
                d.mkdir(parents=True, exist_ok=True)
                (d / "source").write_bytes(self._body(MAX_SOURCE_BYTES))
                (d / "source.type").write_text(self.headers.get("Content-Type") or "application/octet-stream")
                return self._json(200, {"saved": key})
            if path == "/library/meta" and method == "PUT":
                meta = json.loads(self._body(1048576))
                meta["key"] = key
                d.mkdir(parents=True, exist_ok=True)
                (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
                return self._json(200, {"saved": key})
            if path in ("/library/source", "/library/meta") and method == "GET":
                f = d / ("source" if path.endswith("source") else "meta.json")
                if not f.is_file():
                    return self._json(404, {"error": f"No original stored for {key}."})
                body = f.read_bytes()
                ctype = (d / "source.type").read_text() if path.endswith("source") else "application/json"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return None
            return self._json(404, {"error": "not found"})
        except Refused as e:
            return self._json(e.status, {"error": str(e)})
        except ValueError:
            return self._json(400, {"error": "Invalid JSON."})

    def _send_file(self, f: Path, ctype: str) -> None:
        # Serve a pre-compressed copy when there is one (the gazetteer is 4.6 MB raw).
        gz = f.with_name(f.name + ".gz")
        use_gz = gz.is_file() and "gzip" in (self.headers.get("Accept-Encoding") or "")
        body = (gz if use_gz else f).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "max-age=86400")
        if use_gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):  # noqa: N802
        path, key = self._route()
        if path == "/faces":
            try:
                people = json.loads(self._body(4 * 1048576))
                if not isinstance(people, dict):
                    raise ValueError
            except Refused as e:
                return self._json(e.status, {"error": str(e)})
            except ValueError:
                return self._json(400, {"error": "Invalid JSON."})
            LIBRARY.mkdir(parents=True, exist_ok=True)
            tmp = FACES.with_suffix(".tmp")
            tmp.write_text(json.dumps(people))
            tmp.replace(FACES)
            return self._json(200, {"saved": len(people.get("people", []))})
        self._library("PUT", path, key)

    def do_DELETE(self):  # noqa: N802
        path, key = self._route()
        self._library("DELETE", path, key)

    def do_GET(self):  # noqa: N802 - http.server naming
        path, key = self._route()
        if path.startswith("/library/"):
            return self._library("GET", path, key)
        if path == "/faces":
            return self._json(200, json.loads(FACES.read_text()) if FACES.is_file() else {"people": []})
        if path.startswith("/sortdata/"):
            name = path.removeprefix("/sortdata/")
            f = SORTDATA / name
            if name not in SORTDATA_FILES or not f.is_file():
                return self._json(404, {"error": f"{name} is not in {SORTDATA} (see cachypc/sort/README)."})
            return self._send_file(f, SORTDATA_FILES[name])
        if path == "/upscale/status":
            try:
                gpus = gpu_free_mb()
                ok = max(mb for _, mb in gpus) >= NEED_MB
                self._json(200, {"ok": ok, "need_mb": NEED_MB, "llm_active": llm_active(),
                                 "gpus": [{"index": i, "free_mb": mb} for i, mb in gpus]})
            except (OSError, subprocess.SubprocessError) as e:
                self._json(503, {"ok": False, "error": f"nvidia-smi failed: {e}"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/upscale":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_INPUT_BYTES:
            return self._json(413, {"error": "Image missing or larger than 40 MB."})
        data = self.rfile.read(length)
        if not busy.acquire(blocking=False):
            return self._json(429, {"error": "Another upscale is running; try again in a few seconds."})
        try:
            png = run_job(data)
        except Refused as e:
            return self._json(e.status, {"error": str(e)})
        finally:
            busy.release()
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(png)))
        self.end_headers()
        self.wfile.write(png)

    def log_message(self, fmt, *args):
        sys.stderr.write("upscale: " + fmt % args + "\n")


if __name__ == "__main__":
    if not Path(MODEL).is_file():
        sys.exit(f"model not found: {MODEL}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
