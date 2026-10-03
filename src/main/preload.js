'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Narrow bridge: the page only receives cursor samples, pause state and settings.
contextBridge.exposeInMainWorld('luna', {
  onPointer: (cb) => ipcRenderer.on('pointer', (_e, p) => cb(p)),
  onPause: (cb) => ipcRenderer.on('pause', (_e, v) => cb(v)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  ready: () => ipcRenderer.send('ready'),
});
