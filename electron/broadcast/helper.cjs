'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createEngine } = require('./engine.cjs');
const { createStore } = require('./store.cjs');
const { createService } = require('./service.cjs');
const { controlPath, privateDirectory, serve } = require('./control.cjs');
const { resolveCommandPath } = require('../../shared/local-agent-discovery.cjs');
const { desktopPathEnv } = require('../local-runtime/resolveBinary.cjs');
const CAPTURE_ERRORS = {
  permission: 'Capture denied or unavailable. Allow Screen Recording and microphone access, then restart the broadcast helper.',
  ended: 'Selected screen or window disappeared. Broadcast stopped; select a source and start explicitly. Use a screen to survive an app-window restart.',
  recording: 'Capture recorder failed. Broadcast stopped.',
  queue: 'Capture cannot keep up. Broadcast stopped because the media queue exceeded its limit.',
  delivery: 'Media delivery failed. Check the server URL and stream key in the service dashboard.',
};
function boot({ home, capturePage = path.join(__dirname, 'capture.html'), sourceProvider, storage, onReady } = {}) {
  const { app, BrowserWindow, ipcMain, desktopCapturer, safeStorage, powerSaveBlocker } = require('electron');
  home ||= process.argv.find(arg => arg.startsWith('--broadcast-home='))?.slice('--broadcast-home='.length);
  if (!home || !path.isAbsolute(home) || process.platform === 'win32') { app.exit(1); return; }
  privateDirectory(home);
  app.setPath('userData', home);
  app.setPath('sessionData', home);
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let service; let server; let watch; let blocker; let captureWindow; let selected = null;
  const sources = sourceProvider || (async () => (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })).map(({ id, name }) => ({ id, name })));
  const send = (verb, data) => {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.webContents.send(`capture:${verb}`, data);
  };
  const release = () => {
    selected = null; send('stop');
    if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
    blocker = undefined;
  };
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { clearInterval(watch); service?.close(); void server?.close(); });
  process.once('SIGTERM', () => app.quit()); process.once('SIGINT', () => app.quit());
  void app.whenReady().then(async () => {
    app.dock?.hide();
    captureWindow = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: {
      preload: path.join(__dirname, 'capture-preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false,
    } });
    const pageUrl = pathToFileURL(capturePage).href;
    const trusted = event => event.sender === captureWindow.webContents && event.senderFrame === captureWindow.webContents.mainFrame && event.senderFrame.url === pageUrl;
    captureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    captureWindow.webContents.on('will-navigate', event => event.preventDefault());
    captureWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === captureWindow.webContents && contents.getURL() === pageUrl && ['media', 'display-capture'].includes(permission)));
    captureWindow.webContents.session.setPermissionCheckHandler((contents, permission) => contents === captureWindow.webContents && contents.getURL() === pageUrl && ['media', 'display-capture'].includes(permission));
    const engine = createEngine({ resolveBinary: () => resolveCommandPath('ffmpeg', { pathEnv: desktopPathEnv(), skipLoginShell: true }) });
    service = createService({ engine, store: createStore(home, storage || safeStorage), sources, capture: {
      start(config) { selected = config; blocker = powerSaveBlocker.start('prevent-app-suspension'); send('start', config); },
      stop: release,
    } });
    ipcMain.handle('capture:write', async (event, id, bytes) => {
      if (!trusted(event) || id !== selected?.id) return { state: 'stopped' };
      return service.write(id, bytes);
    });
    ipcMain.on('capture:failure', (event, id, code) => {
      if (trusted(event) && id === selected?.id) service.fail(CAPTURE_ERRORS[code] || CAPTURE_ERRORS.recording);
    });
    captureWindow.webContents.on('render-process-gone', () => service.fail(CAPTURE_ERRORS.recording));
    await captureWindow.loadFile(capturePage);
    server = await serve(controlPath(home), service.dispatch);
    let checking = false;
    watch = setInterval(async () => {
      if (!selected || checking) return;
      const current = selected;
      if (!['starting', 'running'].includes(service.status().state)) { release(); return; }
      checking = true;
      try {
        const list = await sources();
        if (selected === current && !list.some(source => source.id === current.sourceId)) service.fail(CAPTURE_ERRORS.ended);
      } catch { if (selected === current) service.fail(CAPTURE_ERRORS.permission); }
      finally { checking = false; }
    }, 1000);
    onReady?.({ app, service, captureWindow });
  }).catch(() => { service?.close(); app.exit(1); });
}
module.exports = { boot, CAPTURE_ERRORS };
