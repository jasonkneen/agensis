'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('broadcastCapture', {
  onStart: callback => ipcRenderer.on('capture:start', (_event, config) => callback(config)),
  onStop: callback => ipcRenderer.on('capture:stop', () => callback()),
  write: (id, bytes) => ipcRenderer.invoke('capture:write', id, bytes),
  failure: (id, code) => ipcRenderer.send('capture:failure', id, code),
});
