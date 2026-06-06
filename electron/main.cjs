'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEV = process.env.ELECTRON_DEV === '1';
const PORT = 8000;
let backendProc = null;

// In production we launch the Python backend (it serves the built React app +
// engine + /api). In dev the backend is started by the npm "dev" script and
// Vite serves the frontend, so we don't spawn it here.
function startBackend() {
  if (DEV) return; // npm runs the backend in dev mode

  let cmd;
  let args;
  let distDir;
  if (app.isPackaged) {
    // Packaged: run the PyInstaller backend exe + serve the bundled frontend,
    // both shipped as extraResources next to the app.
    cmd = path.join(process.resourcesPath, 'gcd-backend.exe');
    args = [];
    distDir = path.join(process.resourcesPath, 'app-dist');
  } else {
    // Local prod (npm start): run Python on the source, serve ./dist.
    cmd = process.platform === 'win32' ? 'python' : 'python3';
    args = [path.join(__dirname, '..', 'backend', 'server.py')];
    distDir = path.join(__dirname, '..', 'dist');
  }

  backendProc = spawn(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, GCD_DIST_DIR: distDir, GCD_PORT: String(PORT) },
  });
  backendProc.on('error', (err) => console.error('[electron] backend spawn error:', err));
}

function waitForBackend(done, tries = 0) {
  const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
    res.resume();
    done();
  });
  req.on('error', () => {
    if (tries > 80) return done(new Error('backend did not start in time'));
    setTimeout(() => waitForBackend(done, tries + 1), 250);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'Gemini Clean',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the system browser, not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  win.loadURL(DEV ? 'http://localhost:5173' : `http://127.0.0.1:${PORT}`);
}

app.whenReady().then(() => {
  startBackend();
  if (DEV) {
    createWindow();
  } else {
    waitForBackend((err) => {
      if (err) console.error('[electron]', err.message);
      createWindow();
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backendProc) { try { backendProc.kill(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProc) { try { backendProc.kill(); } catch (_) {} }
});
