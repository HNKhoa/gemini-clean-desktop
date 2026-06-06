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
backend/server.py   → FastAPI: /api/save, /api/settings, /api/history, /api/open-output (+ serves dist/ in prod)
src/                → React + MUI app  (App.jsx, engine.js wrapper, theme.js)
public/engine/      → reused watermark engine (gwr + mp4box/mp4-muxer + workers)
```

## Prerequisites
- Node.js 18+ and npm
- Python 3.9+

## Setup
```bash
npm install
pip install -r backend/requirements.txt
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
The Gemini watermark is a translucent logo composited at a known position. The engine inverts the blend (`original = (watermarked − α·255)/(1−α)`) using embedded alpha maps and inpaints the outline. Videos are cleaned frame-by-frame with WebCodecs.

## Notes & limitations
- Removes the **visible** watermark only — invisible provenance marks (e.g. **SynthID**) remain.
- Reconstruction under the logo is approximate; busy backgrounds may show slight artifacts.
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
