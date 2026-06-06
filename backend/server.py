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

import uvicorn
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

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

app = FastAPI(title="Gemini Clean Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://127.0.0.1:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    return {"output_dir": get_setting("output_dir", DEFAULT_OUTPUT_DIR)}


@app.post("/api/settings")
def settings_set(output_dir: str = Form(...)):
    set_setting("output_dir", output_dir.strip() or DEFAULT_OUTPUT_DIR)
    return {"ok": True, "output_dir": get_setting("output_dir")}


@app.post("/api/save")
async def save(file: UploadFile = File(...), name: str = Form(...), kind: str = Form("image")):
    folder = output_dir()
    target = unique_path(folder, safe_name(name))
    data = await file.read()
    with open(target, "wb") as f:
        f.write(data)
    conn = db()
    conn.execute(
        "INSERT INTO history (name, path, kind, size, created_at) VALUES (?, ?, ?, ?, ?)",
        (target.name, str(target), kind, len(data), int(time.time())),
    )
    conn.commit()
    conn.close()
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
            os.system(f'open "{folder}"')
        else:
            os.system(f'xdg-open "{folder}"')
        return {"ok": True, "path": str(folder)}
    except Exception as e:  # pragma: no cover
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


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
