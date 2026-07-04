const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
let backendServer = null;

// Thin-shell model (approach A): the packaged desktop app is a native window
// onto the SAME hosted backend the web app uses — the backend URL is baked into
// the renderer at build time via VITE_BACKEND_BASE_URL (see scripts/electron-
// build.mjs). It does NOT run a local copy of the Fly/Neon backend, so it needs
// no DATABASE_URL and can't die on a user's machine that lacks one.
//
// An in-process backend is opt-in only (AGENSIS_BACKEND_LOCAL=1) for offline /
// self-hosted experiments. The server module is required lazily so the normal
// thin shell never loads express/postgres or their native deps at all.
function startLocalBackend() {
  const { startBackendServer } = require('../server/index.cjs');
  return startBackendServer();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0c0c0c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Nudge the macOS traffic lights left + up so they sit inside the app's top
    // strip (the renderer reserves ELECTRON_TITLEBAR_INSET px of clear space at
    // the top when window.electronAPI is present) instead of over the sidebar
    // WORKSPACE header. Ignored on non-darwin platforms.
    trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 14 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Open external links in the user's default browser instead of a new
  // Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (isDev && devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('pick-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select project folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(() => {
  // Opt-in only. Default packaged behaviour talks to the hosted backend baked
  // into the renderer; AGENSIS_BACKEND_EXTERNAL (set by electron:dev) is still
  // honoured as a hard "never start local" so dev's own `npm run backend`
  // sidecar isn't double-started.
  if (process.env.AGENSIS_BACKEND_LOCAL && !process.env.AGENSIS_BACKEND_EXTERNAL) {
    backendServer = startLocalBackend();
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendServer) {
    backendServer.close();
    backendServer = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
