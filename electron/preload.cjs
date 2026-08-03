const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  /**
   * Probe this machine for local agent CLIs (claude, codex, amp, grok, …).
   * Runs in the main process — not the remote backend — so Homebrew / nvm /
   * ~/.local/bin / login-shell PATH installs are visible inside the desktop app.
   * Pass `{ refresh: true }` after an install (Settings → Tools → Rescan).
   */
  discoverLocalAgents: (options) => ipcRenderer.invoke('local-agents:discover', options ?? {}),

  /**
   * Local Relay runtime on this Mac — spawns `agensis connect --no-acp` so jobs
   * run through Claude Agent SDK (warm connection) or Codex app-server.
   * Replaces the former desktop ACP host.
   */
  localRuntime: {
    listRuntimes: () => ipcRenderer.invoke('local-runtime:list'),
    status: (agentId) => ipcRenderer.invoke('local-runtime:status', agentId),
    start: (options) => ipcRenderer.invoke('local-runtime:start', options ?? {}),
    stop: (agentId) => ipcRenderer.invoke('local-runtime:stop', agentId),
    listAutostart: () => ipcRenderer.invoke('local-runtime:list-autostart'),
    onLog: (agentId, callback) => {
      const channel = `local-runtime:log:${agentId}`;
      const handler = (_event, line) => callback(line);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onExit: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('local-runtime:exit', handler);
      return () => ipcRenderer.removeListener('local-runtime:exit', handler);
    },
    onRestoreComplete: (callback) => {
      const handler = (_event, report) => callback(report);
      ipcRenderer.on('local-runtime:restore-complete', handler);
      return () => ipcRenderer.removeListener('local-runtime:restore-complete', handler);
    },
  },

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
