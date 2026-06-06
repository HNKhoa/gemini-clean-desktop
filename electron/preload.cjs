'use strict';
const { contextBridge } = require('electron');

// Minimal, safe bridge. The app talks to the Python backend over HTTP (/api/*),
// so the renderer needs almost nothing privileged here.
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
});
