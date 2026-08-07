const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require('electron');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const isDev = !app.isPackaged;
let backendServer = null;
const rendererFile = path.resolve(__dirname, '..', 'dist', 'index.html');

function trustedRendererUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (isDev && devUrl) {
      return url.origin === new URL(devUrl).origin;
    }
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === rendererFile;
  } catch {
    return false;
  }
}

function trustedIpcSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
  return trustedRendererUrl(senderUrl);
}

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
    // strip (the renderer reserves DESKTOP_TITLEBAR_INSET px of clear space at
    // the top when isDesktopShell()) instead of over the sidebar WORKSPACE
    // header. Ignored on non-darwin platforms.
    //
    // `hiddenInset` above removes the system title bar, so that band is also the
    // ONLY thing that can move the window: it carries -webkit-app-region: drag
    // in the rail and the collapsed sidebar. Reserving the space without the
    // drag region leaves the window immovable.
    trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 14 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // The reason the desktop shell exists: <webview> is a Chromium guest
      // composited INSIDE the page, so it obeys CSS z-index (app chrome can sit
      // over it) AND it is a top-level browsing context, so `X-Frame-Options` /
      // `frame-ancestors` do not apply — sites that refuse an <iframe> (Google,
      // GitHub) load normally. No native-view shell can do both; see
      // src/components/windows/BrowserPanel.tsx for the web fallback.
      webviewTag: true,
    },
  });

  // Guests are UNTRUSTED remote pages. Electron would otherwise let the tag's
  // attributes ask for a preload or Node integration; strip both so a hostile
  // page cannot reach into the app. Runs for every <webview> the renderer
  // attaches, so it cannot be bypassed from the page.
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Keep guests off file:// regardless of what the page asked for.
    if (params.src && !/^https?:\/\//i.test(params.src)) params.src = 'about:blank';
  });

  // Open external links in the user's default browser instead of a new
  // Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    // Never create a second privileged renderer, including for file:// or a
    // custom scheme a hostile page supplied.
    return { action: 'deny' };
  });

  // The preload exposes local PTY and folder-picker capability. A main-frame
  // navigation to a remote origin would keep that preload attached and turn an
  // ordinary link into local shell access, so only the exact packaged file or
  // configured dev origin may ever become the main document.
  win.webContents.on('will-navigate', (event, url) => {
    if (trustedRendererUrl(url)) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (isDev && devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ── Terminal sessions ────────────────────────────────────────────────────────
// node-pty is an OPTIONAL dependency and a native module: it is required lazily
// so a machine (or a Netlify build) where it failed to compile still runs the
// app — the terminal panel just reports itself unavailable instead of the whole
// shell failing to boot.
const ptySessions = new Map();
/** webContents -> the session ids it owns, so one window teardown reaps them all. */
const ptyOwners = new Map();
let ptyCounter = 0;

function loadPty() {
  try {
    return require('node-pty');
  } catch {
    return null;
  }
}

ipcMain.handle('pty:spawn', async (event, options) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  const pty = loadPty();
  if (!pty) return { ok: false, error: 'node-pty is not installed for this build' };

  const shell = process.platform === 'win32'
    ? (process.env.COMSPEC || 'powershell.exe')
    : (process.env.SHELL || '/bin/zsh');
  const id = `pty-${++ptyCounter}`;
  const sender = event.sender;

  const session = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: Math.max(2, Number(options.cols) || 80),
    rows: Math.max(1, Number(options.rows) || 24),
    cwd: options.cwd || os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  session.onData(chunk => {
    // The window can be gone before the shell notices; writing to a destroyed
    // sender throws and would take the main process with it.
    if (!sender.isDestroyed()) sender.send(`pty:data:${id}`, chunk);
  });

  session.onExit(({ exitCode }) => {
    ptySessions.delete(id);
    ptyOwners.get(sender)?.delete(id);
    if (!sender.isDestroyed()) sender.send(`pty:exit:${id}`, exitCode);
  });

  ptySessions.set(id, session);

  // A closed window must not leave live shells behind. ONE listener per window,
  // not per session: several terminals share a webContents, and registering a
  // `destroyed` handler per spawn would trip Node's max-listeners warning at the
  // tenth terminal and leak a listener for every session that already exited.
  if (!ptyOwners.has(sender)) {
    const owned = new Set();
    ptyOwners.set(sender, owned);
    sender.once('destroyed', () => {
      for (const ownedId of owned) {
        const live = ptySessions.get(ownedId);
        if (!live) continue;
        try {
          live.kill();
        } catch {
          // already gone
        }
        ptySessions.delete(ownedId);
      }
      ptyOwners.delete(sender);
    });
  }
  ptyOwners.get(sender).add(id);

  return { ok: true, id, shell };
});

ipcMain.handle('pty:write', (event, { id, data }) => {
  if (!trustedIpcSender(event) || !ptyOwners.get(event.sender)?.has(id)) return;
  ptySessions.get(id)?.write(String(data || '').slice(0, 1_048_576));
});

ipcMain.handle('pty:resize', (event, { id, cols, rows }) => {
  if (!trustedIpcSender(event) || !ptyOwners.get(event.sender)?.has(id)) return;
  // A zero or negative dimension is a hard error inside the pty; the renderer
  // can legitimately measure 0 while the panel is hidden or mid-layout.
  const session = ptySessions.get(id);
  if (session) session.resize(Math.max(2, cols | 0), Math.max(1, rows | 0));
});

ipcMain.handle('pty:kill', (event, { id }) => {
  if (!trustedIpcSender(event) || !ptyOwners.get(event.sender)?.has(id)) return;
  const session = ptySessions.get(id);
  if (!session) return;
  try {
    session.kill();
  } catch {
    // already exited
  }
  ptySessions.delete(id);
  ptyOwners.get(event.sender)?.delete(id);
});

ipcMain.handle('pick-folder', async (event) => {
  if (!trustedIpcSender(event)) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select project folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── Local agent discovery (Claude / Codex / Amp / Grok / …) ─────────────────
// Runs in the main process on THIS machine. The hosted backend would probe
// Fly's PATH, which is useless for a desktop user who has `claude` under
// ~/.local/bin. Same discovery module the local backend uses; refresh=true
// invalidates the login-shell PATH cache so Rescan picks up mid-session installs.
const {
  detectLocalAgentCapabilities,
  refreshLoginShellPath,
} = require('../shared/local-agent-discovery.cjs');

const localRuntime = require('./local-runtime/supervisor.cjs');
const { createAutostartStore } = require('./local-runtime/autostart.cjs');
const { restoreAutostartAgents } = require('./local-runtime/restore.cjs');

/** @type {ReturnType<typeof createAutostartStore> | null} */
let localRuntimeAutostart = null;

function getLocalRuntimeAutostart() {
  if (localRuntimeAutostart) return localRuntimeAutostart;
  localRuntimeAutostart = createAutostartStore({
    userDataDir: app.getPath('userData'),
    encrypt: (plain) => {
      try {
        if (!safeStorage?.isEncryptionAvailable?.()) return null;
        return safeStorage.encryptString(plain);
      } catch {
        return null;
      }
    },
    decrypt: (buf) => {
      try {
        if (!safeStorage?.isEncryptionAvailable?.()) return null;
        return safeStorage.decryptString(buf);
      } catch {
        return null;
      }
    },
  });
  return localRuntimeAutostart;
}

function syncLoginItemFromAutostart() {
  try {
    const store = getLocalRuntimeAutostart();
    const want = store.shouldOpenAtLogin();
    app.setLoginItemSettings({
      openAtLogin: want,
      openAsHidden: want,
    });
  } catch (error) {
    console.warn('[desktop-local] login item update failed:', error?.message || error);
  }
}

ipcMain.handle('local-agents:discover', async (event, options = {}) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  try {
    if (options?.refresh) refreshLoginShellPath();
    const data = await detectLocalAgentCapabilities({
      workspacePath: typeof options?.workspacePath === 'string' ? options.workspacePath : '',
      refresh: Boolean(options?.refresh),
    });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

// ── Desktop local runtime (Relay on this Mac) ───────────────────────────────
// Spawns `agensis connect --no-acp` so jobs use Claude Agent SDK (warm SSE-like
// streaming connection) or `codex app-server` — not the old ACP host.

ipcMain.handle('local-runtime:list', async (event, options = {}) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  try {
    // Only re-probe login-shell PATH on explicit refresh — every open of Agents
    // used to spawnSync zsh -l and freeze the UI (beachball).
    if (options?.refresh) refreshLoginShellPath();
    return { ok: true, data: localRuntime.listRuntimes() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('local-runtime:status', async (event, agentId) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  const store = getLocalRuntimeAutostart();
  return {
    ok: true,
    data: {
      session: localRuntime.status(agentId),
      running: localRuntime.listRunning(),
      autostart: store.list().map((a) => ({
        agentId: a.agentId,
        runtime: a.runtime,
        autoStart: a.autoStart !== false,
        savedAt: a.savedAt,
      })),
      openAtLogin: store.shouldOpenAtLogin(),
    },
  };
});

ipcMain.handle('local-runtime:start', async (event, options = {}) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  try {
    const permissionMode = String(options.permissionMode || options.permission_mode || '').trim()
      || (options.autoApprove === true ? 'yolo' : 'default');
    // Full catalog: claude/codex/amp (SDK/app-server) or grok/hermes/omp/… (ACP/CLI).
    const runtime = localRuntime.pickRuntimeId(options);

    let autostart = null;
    if (options.token && options.baseUrl && options.workspaceId && options.autoStart !== false) {
      try {
        autostart = getLocalRuntimeAutostart().remember({
          agentId: options.agentId,
          runtime,
          workspaceId: options.workspaceId,
          handle: options.handle,
          name: options.name,
          model: options.model,
          cwd: options.cwd,
          baseUrl: options.baseUrl,
          permissionMode,
          autoStart: true,
        }, options.token);
        syncLoginItemFromAutostart();
        console.log('[desktop-local] autostart saved', autostart, getLocalRuntimeAutostart().manifestPath());
      } catch (persistError) {
        console.warn('[desktop-local] autostart persist failed:', persistError?.message || persistError);
        autostart = { saved: false, error: persistError?.message || String(persistError) };
      }
    }

    const session = await localRuntime.start({
      agentId: options.agentId,
      workspaceId: options.workspaceId,
      token: options.token,
      baseUrl: options.baseUrl,
      handle: options.handle,
      name: options.name,
      model: options.model,
      cwd: options.cwd,
      runtime,
      harnessId: options.harnessId,
      requiredRuntime: options.requiredRuntime,
      permissionMode,
      onLog: (line) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(`local-runtime:log:${options.agentId}`, line);
        }
      },
      onExit: ({ agentId }) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('local-runtime:exit', { agentId });
        }
      },
    });

    return {
      ok: true,
      data: {
        session,
        autostart,
      },
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('local-runtime:stop', async (event, agentId) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  try {
    const result = await localRuntime.stop(agentId);
    // Explicit Stop removes reboot restore (user chose offline).
    const forgotten = getLocalRuntimeAutostart().forget(agentId);
    syncLoginItemFromAutostart();
    return { ok: true, data: { ...result, autostart: forgotten } };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('local-runtime:list-autostart', async (event) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  const store = getLocalRuntimeAutostart();
  return {
    ok: true,
    data: {
      agents: store.list(),
      openAtLogin: store.shouldOpenAtLogin(),
    },
  };
});

app.whenReady().then(async () => {
  // Opt-in only. Default packaged behaviour talks to the hosted backend baked
  // into the renderer; AGENSIS_BACKEND_EXTERNAL (set by electron:dev) is still
  // honoured as a hard "never start local" so dev's own `npm run backend`
  // sidecar isn't double-started.
  if (process.env.AGENSIS_BACKEND_LOCAL && !process.env.AGENSIS_BACKEND_EXTERNAL) {
    backendServer = startLocalBackend();
  }
  createWindow();

  // Warm login-shell PATH off the critical path so the first Agents/Connect
  // list does not pay a sync zsh -l on the main thread mid-interaction.
  setImmediate(() => {
    try {
      const { loginShellPath } = require('../shared/local-agent-discovery.cjs');
      loginShellPath();
    } catch {
      // ignore warm failures
    }
  });

  // Reboot / relaunch: restore local-runtime agents that were started with
  // autostart. Retries while the backend (local 3142 or Fly) is still coming up.
  const runRestore = async (reason) => {
    try {
      syncLoginItemFromAutostart();
      const store = getLocalRuntimeAutostart();
      const pending = store.list();
      console.log(`[desktop-local] restore (${reason}) pending=${pending.length} path=${store.manifestPath()}`);
      if (pending.length === 0) return;
      const report = await restoreAutostartAgents(store, {
        maxAttempts: 6,
        attemptDelayMs: 3000,
      });
      console.log(
        `[desktop-local] restore complete attempted=${report.attempted} ok=${report.ok} failed=${report.failed}`,
        JSON.stringify(report.results),
      );
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('local-runtime:restore-complete', report);
        }
      }
    } catch (error) {
      console.error('[desktop-local] restore failed:', error?.message || error);
    }
  };

  // Don't unref: we want restore to keep the event loop active until done.
  setTimeout(() => { void runRestore('launch'); }, 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Tear down live daemons on quit (clean). Disk autostart list is preserved
  // so the next launch / reboot restore brings them back.
  try {
    localRuntime.stopAll();
  } catch {
    // ignore teardown races
  }
  if (backendServer) {
    backendServer.close();
    backendServer = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
