"""
Gemini Clean — Python backend (FastAPI).

Roles:
  • Serve the built React app + the watermark engine (production).
  • Persist cleaned files chosen by the user to an output folder.
  • Keep settings + a small history (SQLite).
  • Open the output folder in the OS file explorer.

The watermark removal itself runs in the webview (JS engine); this backend only
receives the already-cleaned bytes and writes them to disk. Nothing is uploaded
anywhere on the network.
"""
import os
import re
import sys
import time
import sqlite3
import pathlib
import subprocess
import shutil
import uuid
import hashlib
import threading
import importlib.util
import urllib.request

import uvicorn
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

BASE_DIR = pathlib.Path(__file__).resolve().parent.parent
# In a packaged build Electron passes GCD_DIST_DIR pointing at the bundled
# frontend (extraResources). In dev/local it falls back to ./dist.
DIST_DIR = pathlib.Path(os.environ.get("GCD_DIST_DIR", str(BASE_DIR / "dist")))
HOME = pathlib.Path.home()

DATA_DIR = HOME / ".gemini-clean"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "app.db"

DEFAULT_OUTPUT_DIR = str(HOME / "Downloads" / "GeminiClean")
PORT = int(os.environ.get("GCD_PORT", "8000"))

# Optional AI inpaint (LaMa). Model is downloaded once to the data dir, then offline.
MODELS_DIR = DATA_DIR / "models"
LAMA_PATH = MODELS_DIR / "inpainting_lama.onnx"
ALPHA_FILE = pathlib.Path(__file__).resolve().parent / "lama_alpha96.f32"
os.environ.setdefault("GCD_LAMA_MODEL", str(LAMA_PATH))
# Pin an immutable revision + SHA-256 so a corrupt or substituted (MITM) download
# can never be loaded as an executable ONNX graph.
LAMA_REV = "aee6d22f0a13e5e35af1c9a1c3afd62841fc6f3f"
LAMA_URL = f"https://huggingface.co/opencv/inpainting_lama/resolve/{LAMA_REV}/inpainting_lama_2025jan.onnx"
LAMA_SIZE = 92591623  # bytes (Apache-2.0, opencv/inpainting_lama)
LAMA_SHA256 = "7df918ac3921d3daf0aae1d219776cf0dc4e4935f035af81841b40adcf74fdf2"
ai_jobs = {}  # job_id -> progress dict (in-memory; single-user desktop)
_ai_sema = threading.Semaphore(1)  # at most one heavy AI job runs at a time

app = FastAPI(title="Gemini Clean Backend")
# The renderer is served by this backend (same-origin) in production, so CORS is
# not the primary control — the X-GCD guard below is. Scope origins to the dev
# Vite server plus this backend's own port (derived from GCD_PORT) so a stale
# fixed port can't silently diverge from the real one.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def api_guard(request, call_next):
    """CSRF / drive-by protection. Every /api/* request must carry `X-GCD: 1`.
    A cross-origin web page can only send a custom header by triggering a CORS
    preflight, which this backend's origin allow-list denies; a request without
    the header is rejected here BEFORE any side effect (file write, settings
    change, opening a folder). Same-origin renderer calls include the header and
    pass through. Static assets (the SPA + /engine) are not under /api."""
    if request.url.path.startswith("/api/") and request.method not in ("OPTIONS", "HEAD"):
        if request.headers.get("x-gcd") != "1":
            return JSONResponse({"ok": False, "error": "forbidden"}, status_code=403)
    return await call_next(request)


@app.middleware("http")
async def no_store_dynamic(request, call_next):
    """Engine modules + worker + index.html use stable filenames, so the renderer
    could serve a stale cached copy after an update. Force fresh fetches for
    everything except Vite's content-hashed /assets (safe to cache)."""
    resp = await call_next(request)
    if not request.url.path.startswith("/assets"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ── DB helpers ──────────────────────────────────────────────────────────────
def db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT, path TEXT, kind TEXT, size INTEGER,
            created_at INTEGER
        )"""
    )
    conn.commit()
    conn.close()


def get_setting(key, default=None):
    conn = db()
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else default


def set_setting(key, value):
    conn = db()
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
    conn.commit()
    conn.close()


def output_dir() -> pathlib.Path:
    p = pathlib.Path(get_setting("output_dir", DEFAULT_OUTPUT_DIR))
    p.mkdir(parents=True, exist_ok=True)
    return p


def validate_output_dir(raw: str) -> str:
    """Reject paths that should never be a writable output target (UNC shares,
    the Windows directory, the Startup autostart folder). Any other absolute
    local path the user picks is allowed — this is a single-user desktop tool."""
    raw = (raw or "").strip()
    if not raw:
        return DEFAULT_OUTPUT_DIR
    if raw.startswith("\\\\") or raw.startswith("//"):
        raise ValueError("UNC paths are not allowed")
    p = pathlib.Path(raw)
    if not p.is_absolute():
        raise ValueError("path must be absolute")
    resolved = str(p.resolve())
    low = resolved.lower()
    windir = os.environ.get("WINDIR", r"C:\Windows").lower()
    if low == windir or low.startswith(windir + "\\"):
        raise ValueError("system directory is not allowed")
    if "\\start menu\\programs\\startup" in low or "/.config/autostart" in low:
        raise ValueError("startup directory is not allowed")
    return resolved


def safe_name(name: str) -> str:
    name = os.path.basename(name or "")
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(". ")
    return name or f"clean_{int(time.time())}.png"


def unique_path(folder: pathlib.Path, name: str) -> pathlib.Path:
    target = folder / name
    if not target.exists():
        return target
    stem, ext = os.path.splitext(name)
    i = 1
    while True:
        cand = folder / f"{stem} ({i}){ext}"
        if not cand.exists():
            return cand
        i += 1


# ── API ─────────────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/settings")
def settings_get():
    return {
        "output_dir": get_setting("output_dir", DEFAULT_OUTPUT_DIR),
        "ai_inpaint": get_setting("ai_inpaint", "0"),
    }


@app.post("/api/settings")
def settings_set(output_dir: str = Form(...), ai_inpaint: str = Form(None)):
    try:
        validated = validate_output_dir(output_dir)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    set_setting("output_dir", validated)
    if ai_inpaint is not None:
        set_setting("ai_inpaint", "1" if str(ai_inpaint) in ("1", "true", "on", "yes") else "0")
    return {"ok": True, "output_dir": get_setting("output_dir"), "ai_inpaint": get_setting("ai_inpaint", "0")}


@app.post("/api/save")
async def save(file: UploadFile = File(...), name: str = Form(...), kind: str = Form("image")):
    data = await file.read()

    def _persist():
        folder = output_dir()
        target = unique_path(folder, safe_name(name))
        with open(target, "wb") as f:
            f.write(data)
        conn = db()
        conn.execute(
            "INSERT INTO history (name, path, kind, size, created_at) VALUES (?, ?, ?, ?, ?)",
            (target.name, str(target), kind, len(data), int(time.time())),
        )
        conn.commit()
        conn.close()
        return target

    try:
        # Run the blocking disk write + SQLite insert off the event loop so a large
        # save doesn't stall other requests on the single-worker server.
        target = await run_in_threadpool(_persist)
    except Exception:  # pragma: no cover
        return JSONResponse({"ok": False, "error": "could not save file"}, status_code=500)
    return {"ok": True, "path": str(target), "name": target.name, "size": len(data)}


@app.get("/api/history")
def history(limit: int = 100):
    conn = db()
    rows = conn.execute("SELECT * FROM history ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return {"items": [dict(r) for r in rows]}


@app.post("/api/open-output")
def open_output():
    folder = output_dir()
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(folder))  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.run(["open", str(folder)], check=False)
        else:
            subprocess.run(["xdg-open", str(folder)], check=False)
        return {"ok": True, "path": str(folder)}
    except Exception as e:  # pragma: no cover
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.post("/api/open-path")
def open_path(path: str = Form(...)):
    """Open one cleaned file with the OS default app (must be inside output folder)."""
    try:
        p = pathlib.Path(path).resolve()
        out = output_dir().resolve()
        if out != p and out not in p.parents:
            return JSONResponse({"ok": False, "error": "path outside output folder"}, status_code=403)
        if not p.exists():
            return JSONResponse({"ok": False, "error": "file not found"}, status_code=404)
        if sys.platform.startswith("win"):
            os.startfile(str(p))  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.run(["open", str(p)], check=False)
        else:
            subprocess.run(["xdg-open", str(p)], check=False)
        return {"ok": True}
    except Exception as e:  # pragma: no cover
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── AI inpaint (LaMa) — optional high-quality video watermark removal ─────────
def _model_ready() -> bool:
    try:
        return LAMA_PATH.exists() and abs(LAMA_PATH.stat().st_size - LAMA_SIZE) < (1 << 20)
    except Exception:
        return False


def _download_model(job=None):
    if _model_ready():
        return
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = str(LAMA_PATH) + ".part"
    try:
        req = urllib.request.Request(LAMA_URL, headers={"User-Agent": "gemini-clean"})
        h = hashlib.sha256()
        with urllib.request.urlopen(req, timeout=60) as r:
            total = int(r.headers.get("Content-Length", LAMA_SIZE) or LAMA_SIZE)
            done = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    done += len(chunk)
                    if job is not None:
                        job["stage"] = "download"
                        job["progress"] = round(done / total, 4)
        digest = h.hexdigest()
        if digest != LAMA_SHA256:
            raise RuntimeError(f"model checksum mismatch (got {digest[:12]}…)")
        os.replace(tmp, str(LAMA_PATH))
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _ai_available():
    """The AI feature can actually run only if onnxruntime + the lama_video module +
    the alpha template + ffmpeg are all present (e.g. NOT in the portable build)."""
    try:
        ort_ok = importlib.util.find_spec("onnxruntime") is not None
    except Exception:
        ort_ok = False
    try:
        lama_ok = importlib.util.find_spec("lama_video") is not None
    except Exception:
        lama_ok = False
    ffmpeg_ok = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
    return ort_ok and lama_ok and ffmpeg_ok and ALPHA_FILE.exists()


@app.get("/api/ai-status")
def ai_status():
    try:
        import onnxruntime as ort
        providers = ort.get_available_providers()
    except Exception:
        providers = []
    return {
        "available": _ai_available(),
        "model_ready": _model_ready(),
        "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
        "providers": providers,
        "enabled": get_setting("ai_inpaint", "0") == "1",
    }


def _run_ai_job(job_id, in_path, orig_name, job_dir):
    job = ai_jobs[job_id]
    out_tmp = os.path.join(job_dir, "out.mp4")
    acquired = False
    try:
        _ai_sema.acquire()  # serialize heavy jobs (one GPU/CPU run at a time)
        acquired = True
        if job.get("cancel"):
            raise RuntimeError("cancelled")
        job["status"] = "downloading"
        _download_model(job)
        job["status"] = "processing"
        job["stage"] = "inpaint"
        job["progress"] = 0
        import lama_video

        def prog(d, t, stage):
            job["frame"] = d
            job["total"] = t
            job["stage"] = stage
            job["progress"] = round(d / t, 4) if t else 0

        info = lama_video.process_video(in_path, out_tmp, progress=prog,
                                        should_cancel=lambda: bool(job.get("cancel")))
        if job.get("cancel"):
            raise RuntimeError("cancelled")
        folder = output_dir()
        base = safe_name(os.path.splitext(orig_name)[0]) or "video"
        target = unique_path(folder, f"clean_{base}.mp4")
        os.replace(out_tmp, str(target))
        size = target.stat().st_size
        conn = db()
        conn.execute(
            "INSERT INTO history (name, path, kind, size, created_at) VALUES (?, ?, ?, ?, ?)",
            (target.name, str(target), "video", size, int(time.time())),
        )
        conn.commit()
        conn.close()
        job.update({"status": "done", "progress": 1, "path": str(target),
                    "name": target.name, "provider": info.get("provider"), "box": info.get("box")})
    except Exception as e:  # pragma: no cover
        # A user cancel (flag or lama_video.Cancelled) is reported as 'cancelled',
        # NOT 'error', and no output / history row is produced.
        if job.get("cancel") or e.__class__.__name__ == "Cancelled":
            job.update({"status": "cancelled", "error": "cancelled"})
        else:
            job.update({"status": "error", "error": str(e)})
    finally:
        if acquired:
            _ai_sema.release()
        shutil.rmtree(job_dir, ignore_errors=True)  # removes upload + any partial out
        threading.Timer(180, lambda: ai_jobs.pop(job_id, None)).start()  # evict terminal job


@app.post("/api/process-video-ai")
async def process_video_ai(file: UploadFile = File(...), name: str = Form(...)):
    job_id = uuid.uuid4().hex
    job_dir = DATA_DIR / "tmp" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    in_path = str(job_dir / safe_name(name))

    def _persist():
        # Stream the upload to disk off the event loop (avoids buffering a whole
        # video in RAM and stalling the single-worker server).
        with open(in_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

    await run_in_threadpool(_persist)
    ai_jobs[job_id] = {"status": "queued", "progress": 0, "frame": 0, "total": 0, "cancel": False}
    threading.Thread(target=_run_ai_job, args=(job_id, in_path, name, str(job_dir)), daemon=True).start()
    return {"ok": True, "job_id": job_id}


@app.get("/api/ai-job/{job_id}")
def ai_job(job_id: str):
    job = ai_jobs.get(job_id)
    if not job:
        return JSONResponse({"ok": False, "error": "unknown job"}, status_code=404)
    return {"ok": True, **job}


@app.post("/api/ai-cancel/{job_id}")
def ai_cancel(job_id: str):
    job = ai_jobs.get(job_id)
    if not job:
        return JSONResponse({"ok": False, "error": "unknown job"}, status_code=404)
    job["cancel"] = True  # the worker checks this per frame and stops cleanly
    return {"ok": True}


# ── Static (production): serve the built React app + /engine. Mount LAST so the
#    /api routes above take precedence. In dev, Vite serves the frontend. ──────
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")


if __name__ == "__main__":
    init_db()
    output_dir()  # ensure default output exists
    # Pin loop/http and disable websockets so the frozen (PyInstaller) build has
    # no dynamic-import surprises — asyncio + h11 are pure-Python and bundle cleanly.
    uvicorn.run(app, host="127.0.0.1", port=PORT, loop="asyncio", http="h11", ws="none", log_level="info")
