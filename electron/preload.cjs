const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  /**
   * A real shell on THIS machine. The pty lives in the main process; only these
   * four verbs and a data stream cross into the renderer, and every one of them
   * is keyed by an id the main process minted — the renderer can neither name a
   * session it was not given nor reach one belonging to another window.
   */
  pty: {
    spawn: options => ipcRenderer.invoke('pty:spawn', options ?? {}),
    write: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
    kill: id => ipcRenderer.invoke('pty:kill', { id }),
    /** Returns an unsubscribe fn — call it on unmount or the listener leaks. */
    onData: (id, callback) => {
      const channel = `pty:data:${id}`;
      const handler = (_event, chunk) => callback(chunk);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onExit: (id, callback) => {
      const channel = `pty:exit:${id}`;
      const handler = (_event, code) => callback(code);
      ipcRenderer.once(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
});
