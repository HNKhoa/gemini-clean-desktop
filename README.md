# Gemini Clean — Desktop (Electron + React + MUI + Python)

A desktop app to **remove** the visible Gemini watermark from **local** images and videos, and (second tab) to **add** your own watermark to videos. Drop files in → results are saved to a folder. Everything runs locally; nothing is uploaded.

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
                       /api/add-watermark + /api/wm-job + /api/wm-status (Add-watermark tab)
backend/lama_video.py → AI inpaint pipeline (ffmpeg decode → LaMa ONNX per frame → encode)
backend/watermark/  → "add watermark" toolkit (visible overlay + invisible payload, ffmpeg)
src/                → React + MUI app  (App.jsx, AddWatermarkTab.jsx, engine.js wrapper, theme.js)
public/engine/      → reused watermark engine (gwr + mp4box/mp4-muxer + workers)
```

## Prerequisites
- Node.js 18+ and npm
- Python 3.9+ for the core app (**Python 3.10+** for the optional **AI inpaint** mode — onnxruntime has no 3.9 wheel)
- **ffmpeg** — needed for AI inpaint + Add-watermark; if it isn't on PATH the app downloads a pinned, checksum-verified build once on first use (to `%USERPROFILE%\.gemini-clean\bin`)

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
- **GPU**: run **`setup-gpu.bat`** once — it detects your card and lets you pick **NVIDIA (CUDA)**, **AMD/Intel (DirectML)**, or **CPU**. Only **NVIDIA CUDA** actually accelerates the LaMa AI inpaint (`onnxruntime-gpu` + CUDA 12 libs via pip); DirectML cannot run LaMa's Fourier-conv ops, so AMD/Intel auto-fall back to CPU (a startup warm-up validates the provider). The normal (non-AI) video watermark-removal mode needs no GPU.
  - For **other / many machines**, run it unattended with an argument (no menu, no pause): `setup-gpu.bat auto` (auto-pick by detected card) — or force a build with `setup-gpu.bat nvidia` | `amd` | `intel` | `cpu`. The script still needs the project folder (it reads `backend\requirements-ai*.txt`), so copy/clone the repo first and have Python on PATH.
- **Quality**: Settings → "Chất lượng video AI" — Standard (CRF 18, default), High (CRF 16), or Near-lossless (CRF 12, ~2–3× the file, slower). Resolution is preserved and the original audio is copied losslessly at every level; only the (unavoidable) single video re-encode differs. The source is already lossy, so CRF 12 is the practical ceiling.
- Slower than the instant reverse-alpha path — intended for when you need a perfectly clean result. The toggle is off by default; the app falls back to reverse-alpha if ffmpeg/onnxruntime are unavailable.

> AI inpaint works in **both** the `update.bat` (source) run **and** the `package.bat` standalone build (which bundles a CPU `onnxruntime`). It runs on CPU; for NVIDIA-GPU speed run `setup-gpu.bat` on the source instead.

## Add watermark (second tab)
Adds your own watermark to a video, in the backend (numpy + Pillow + ffmpeg):
- **Visible**: text and/or a logo PNG — position, opacity, colour, font size, diagonal tile, drop-shadow, a Gemini/Veo-style spark ✦ + glow, and motion (static / random jumps / DVD bounce). The original audio is copied untouched.
- **Invisible (advanced)**: a robust, blind payload embedded in the frequency domain (survives re-encode); extract later with the same password + byte count.
- Needs numpy + Pillow (core deps, installed by `update.bat`) and **ffmpeg** (auto-downloaded on first use if missing). Works in the `update.bat` (source) run **and** the `package.bat` standalone build. Output filename follows the "Tên file" option (default: original name + watermark text).

## Notes & limitations
- Removes the **visible** watermark only — invisible provenance marks (e.g. **SynthID**) remain.
- The default (reverse-alpha) reconstruction under the logo is approximate; busy/patterned backgrounds may show a slight trace — enable **AI inpaint** (above) for a fully clean result.
- Video processing needs a Chromium-based webview with WebCodecs (Electron provides this).
- The newer Gemini 2816×1536 `20260520` watermark variant is not specially handled (offline engine); standard sizes work.

## One-click scripts (Windows)
Two `.bat` files in the project root:

- **`update.bat`** — daily use. Installs/updates deps, rebuilds the frontend, and launches the app. Run it after editing code. Keep the console window open while using the app.
- **`package.bat`** — builds a **full standalone** app that runs on a PC with **nothing installed** (no Node, Python or ffmpeg). It rebuilds the frontend, bundles the Python backend with PyInstaller (`--onedir`, CPU `onnxruntime`) in an isolated build venv, then packages a folder with electron-builder:
  - Output **folder** → `release\win-unpacked\` (run `Gemini Clean.exe`). **Zip the whole folder and send it** — the other PC needs nothing installed.
  - Includes **everything**: watermark removal, **Add-watermark**, and **AI inpaint** (runs on CPU; for NVIDIA-GPU speed run `setup-gpu.bat` on the source instead).
  - **~370 MB.** Downloadable parts are fetched on the client on **first use** (once, needs internet that one time): **ffmpeg** (~100 MB, for Add-watermark + AI inpaint) and the **AI model** (~88 MB). Watermark removal works fully offline immediately.

> Note: the standalone app saves cleaned/output files to `Downloads\GeminiClean` and stores settings/history in `%USERPROFILE%\.gemini-clean`.

## Credits & license
Watermark engine: gemini-watermark-remover (MIT — see `public/engine/vendor/gwr/LICENSE`).
