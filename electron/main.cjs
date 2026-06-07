'use strict';
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const DEV = process.env.ELECTRON_DEV === '1';
let PORT = 8000; // prod: replaced with a free port at startup to avoid conflicts
let backendProc = null;

// Ask the OS for a free localhost TCP port (the prod backend binds to it).
function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

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
    // Discard stdio in the packaged GUI app (no console attached); inherit for
    // local/dev runs so logs show in the terminal. windowsHide stops a console
    // window from flashing when launching the bundled backend exe.
    stdio: app.isPackaged ? 'ignore' : 'inherit',
    windowsHide: true,
    env: { ...process.env, GCD_DIST_DIR: distDir, GCD_PORT: String(PORT) },
  });
  backendProc.on('error', (err) => console.error('[electron] backend spawn error:', err));
  backendProc.on('exit', () => { backendProc = null; });
}

// Reliably stop the backend. On Windows backendProc.kill() (SIGTERM) doesn't
// terminate the child reliably — and the PyInstaller onefile exe spawns a child
// bootloader process — so kill the whole tree with taskkill /T /F. Otherwise an
// orphaned server keeps a port (and its /api write endpoint) alive after quit.
function killBackend() {
  const proc = backendProc;
  backendProc = null;
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      proc.kill();
    }
  } catch (_) { /* ignore */ }
}

function waitForBackend(done, tries = 0) {
  const req = http.get(`http://127.0.0.1:${PORT}/api/health`, { headers: { 'X-GCD': '1' } }, (res) => {
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

app.whenReady().then(async () => {
  if (!DEV) {
    const free = await getFreePort();
    if (free) PORT = free;
  }
  startBackend();
  if (DEV) {
    createWindow();
  } else {
    waitForBackend((err) => {
      if (err) {
        console.error('[electron]', err.message);
        dialog.showErrorBox('Gemini Clean', 'Không khởi động được dịch vụ nền (backend). Vui lòng mở lại ứng dụng.');
        killBackend();
        app.quit();
        return;
      }
      createWindow();
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killBackend);
app.on('will-quit', killBackend);
process.on('exit', killBackend);
