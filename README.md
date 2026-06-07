# Gemini Clean — Desktop (Electron + React + MUI + Python)

A desktop app to remove the **visible** Gemini watermark from **local** images and videos. Drop files in → cleaned files are saved to a folder. Everything runs locally; nothing is uploaded.

This is the desktop port of the "Gemini Clean Downloader" extension. The downloading-from-Gemini step is browser-only (it needs a content script in your Gemini session), so the desktop app focuses on cleaning files you already have: download from Gemini in your browser (watermarked), then drop the file here.

## Architecture
- **Electron** — desktop window + app lifecycle. In production it launches the Python backend and opens a window to it.
- **React + MUI** (Vite) — the UI (drag-drop, job list, progress, settings).
- **Watermark engine (JS)** — reused **unchanged** from the validated extension. Lives in `public/engine/` and is loaded as raw ES modules at runtime (Canvas for images, WebCodecs for video). Runs in the renderer.
- **Python (FastAPI)** — serves the built app + engine in production, saves cleaned files to disk, keeps settings + history (SQLite), and opens the output folder.

```
electron/main.cjs   → window + spawns backend (prod) + loads the UI
backend/server.py   → FastAPI: /api/save, /api/settings, /api/history, /api/open-output,
                       /api/process-video-ai + /api/ai-job + /api/ai-status (AI inpaint), serves dist/ in prod
backend/lama_video.py → AI inpaint pipeline (ffmpeg decode → LaMa ONNX per frame → encode)
src/                → React + MUI app  (App.jsx, engine.js wrapper, theme.js)
public/engine/      → reused watermark engine (gwr + mp4box/mp4-muxer + workers)
```

## Prerequisites
- Node.js 18+ and npm
- Python 3.9+ for the core app (**Python 3.10+** for the optional **AI inpaint** mode — onnxruntime has no 3.9 wheel)
- **ffmpeg** on PATH — only needed for the optional **AI inpaint** video mode

## Setup
```bash
npm install
pip install -r backend/requirements.txt
pip install -r backend/requirements-ai.txt   # optional: AI inpaint (Python 3.10+, needs ffmpeg)
```

## Run (development)
```bash
npm run dev
```
This starts Vite (5173), the FastAPI backend (8000), and Electron together. Electron opens the Vite dev server; `/api` is proxied to FastAPI; the engine is served from `public/engine`.

## Build (production)
```bash
npm run build        # Vite builds the React app + engine into dist/
npm start            # Electron launches: spawns backend (serves dist/ + /api) and opens the window
```

To package as a single distributable later, add `electron-builder` and bundle the Python backend with PyInstaller as a sidecar (see "Packaging" notes below).

## How it works
The Gemini watermark is a translucent logo composited at a known position. The engine inverts the blend (`original = (watermarked − α·C)/(1−α)`) using embedded alpha maps, with the position auto-detected (NCC) and the removal strength **calibrated per video**, then inpaints the residual outline. Videos are cleaned frame-by-frame with WebCodecs.

## AI inpaint (optional — highest quality on patterned/coloured backgrounds)
Reverse-alpha removes the logo but can leave a faint trace on sharp/structured backgrounds (grids, textures). Enable **Settings → “AI inpaint cho video”** to instead **reconstruct** the background under the logo with a **LaMa** inpainting model — this fully removes the mark and rebuilds grid lines / textures of any colour.

- Runs in the **Python backend** (onnxruntime + ffmpeg), frame by frame, then re-encodes with the original audio.
- The model (~88 MB, Apache-2.0 `opencv/inpainting_lama`) is **downloaded once** to `%USERPROFILE%\.gemini-clean\models\` on first use, then works offline.
- **GPU**: on Windows `onnxruntime-directml` uses your GPU automatically (CPU fallback is much slower).
- Slower than the instant reverse-alpha path — intended for when you need a perfectly clean result. The toggle is off by default; the app falls back to reverse-alpha if ffmpeg/onnxruntime are unavailable.

> AI inpaint is verified via the **`update.bat` (source) run**, which installs onnxruntime/numpy/Pillow. The current `package.bat` portable build ships the standard reverse-alpha method only.

## Notes & limitations
- Removes the **visible** watermark only — invisible provenance marks (e.g. **SynthID**) remain.
- The default (reverse-alpha) reconstruction under the logo is approximate; busy/patterned backgrounds may show a slight trace — enable **AI inpaint** (above) for a fully clean result.
- Video processing needs a Chromium-based webview with WebCodecs (Electron provides this).
- The newer Gemini 2816×1536 `20260520` watermark variant is not specially handled (offline engine); standard sizes work.

## One-click scripts (Windows)
Two `.bat` files in the project root:

- **`update.bat`** — daily use. Installs/updates deps, rebuilds the frontend, and launches the app. Run it after editing code. Keep the console window open while using the app.
- **`package.bat`** — builds a **standalone** app that runs on a PC **without Node/Python**. It always rebuilds first (latest code + engine), bundles the Python backend with PyInstaller, then packages with electron-builder:
  - Output **single file** → `release\GeminiClean-1.0.0-portable.exe` (requires Windows **Developer Mode ON**, because electron-builder's signing helper extracts symlinks).
  - If Developer Mode is OFF it **automatically falls back** to a folder build → `release\win-unpacked\Gemini Clean.exe` (zip the folder to share). Both are fully standalone.
  - To get the single file: Windows **Settings → Privacy & security → For developers → Developer Mode = On**, then run `package.bat` again.

> Note: the standalone app still saves cleaned files to `Downloads\GeminiClean` and stores settings/history in `%USERPROFILE%\.gemini-clean`.

## Credits & license
Watermark engine: gemini-watermark-remover (MIT — see `public/engine/vendor/gwr/LICENSE`).
