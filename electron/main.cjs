const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { AGENT_BUNDLE_MAX_COMPRESSED_BYTES } = require('../shared/agentBundles.cjs');

// Diagnostic A/B for desktop paint corruption. Electron requires this before
// app readiness; leave normal launches accelerated until the cause is verified.
if (process.env.AGENSIS_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  console.info('[agensis] Hardware acceleration disabled for rendering diagnosis');
}

const isDev = !app.isPackaged;
let backendServer = null;
let mainWindow = null;
let rendererReady = false;
const pendingAgentBundlePaths = [];
const rendererFile = path.resolve(__dirname, '..', 'dist', 'index.html');

function isAgentBundlePath(value) {
 return typeof value === 'string' && path.extname(value).toLowerCase() === '.agn';
}

async function flushAgentBundlePaths() {
 if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
 while (pendingAgentBundlePaths.length > 0 && rendererReady && mainWindow && !mainWindow.isDestroyed()) {
  const filePath = pendingAgentBundlePaths.shift();
  try {
   const stat = await fs.promises.stat(filePath);
   if (!stat.isFile() || stat.size > AGENT_BUNDLE_MAX_COMPRESSED_BYTES) {
    throw new Error('the .agn file is missing or larger than 5 MB');
   }
   const data = new Uint8Array(await fs.promises.readFile(filePath));
   mainWindow.webContents.send('agent-bundle:open', {
    name: path.basename(filePath),
    bytes: data,
   });
  } catch (error) {
   if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent-bundle:open', {
     name: path.basename(filePath || 'agent.agn'),
     error: error?.message || 'Could not open that .agn file',
    });
   }
  }
 }
}

function queueAgentBundlePath(filePath) {
 if (!isAgentBundlePath(filePath)) return;
 pendingAgentBundlePaths.push(filePath);
 void flushAgentBundlePaths();
}

// A second desktop process must hand its file to the first one. On macOS the
// open-file event covers Finder, while Windows/Linux commonly deliver the path
// through the second-instance command line.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
 app.quit();
} else {
 for (const argument of process.argv.slice(1)) queueAgentBundlePath(argument);
 app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueAgentBundlePath(filePath);
 });
 app.on('second-instance', (_event, commandLine) => {
  for (const argument of commandLine.slice(1)) queueAgentBundlePath(argument);
  const win = mainWindow || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
   if (win.isMinimized()) win.restore();
   win.show();
   win.focus();
  }
 });
}

function computeTrustedRendererUrl(value) {
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

// Every pty keystroke and every resize frame reaches main through
// trustedIpcSender, and the check above is a URL parse + fileURLToPath +
// path.resolve each time. The verdict is a pure function of the URL string —
// isDev and VITE_DEV_SERVER_URL are fixed for the life of the process — so
// remembering it cannot change what is trusted; it only stops re-deriving the
// same answer thousands of times a second. Bounded, because will-navigate feeds
// this URLs an untrusted page chose.
const trustedRendererUrlMemo = new Map();

function trustedRendererUrl(value) {
  const key = String(value || '');
  const cached = trustedRendererUrlMemo.get(key);
  if (cached !== undefined) return cached;
  const verdict = computeTrustedRendererUrl(key);
  if (trustedRendererUrlMemo.size >= 32) trustedRendererUrlMemo.clear();
  trustedRendererUrlMemo.set(key, verdict);
  return verdict;
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
    // Stay off screen until the renderer has painted (see 'ready-to-show'
    // below). A window that is shown immediately composites — and on macOS runs
    // its open animation — over the empty background fill while the bundle is
    // still parsing and executing, which is the heaviest moment of the launch,
    // and it flashes empty chrome on the way.
    show: false,
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
    trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 18 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium's default: renderer timers and rAF are throttled while the
      // window is hidden or occluded. Pinned explicitly because it is load-
      // bearing for idle CPU here (the app keeps realtime timers running) and
      // because turning it off is the tempting "fix" for a background stall.
      backgroundThrottling: true,
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
  mainWindow = win;
  rendererReady = false;
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  // Belt and braces for the `show: false` above: a load that never paints (dev
  // server down, missing dist/) never fires ready-to-show, and a permanently
  // hidden window is indistinguishable from a hung app.
  win.webContents.on('did-fail-load', () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  });
  win.webContents.once('did-finish-load', () => {
    rendererReady = true;
    void flushAgentBundlePaths();
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      rendererReady = false;
    }
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
    // Detached DevTools is a SECOND renderer whose whole job is to consume a
    // CDP firehose (DOM mutations, style recalcs, console, network) from this
    // one, so it materially inflates the renderer CPU anyone is trying to
    // measure — and agent streaming is a continuous mutation stream. On by
    // default because that is what a dev wants; AGENSIS_DEVTOOLS=0 opts out for
    // a clean profiling run.
    if (process.env.AGENSIS_DEVTOOLS !== '0') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
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

// node-pty emits one `data` event per read from the master fd, so a build log,
// a `cat` or an npm install is hundreds to thousands of small chunks a second.
// One webContents.send each meant one structured clone + IPC hop + renderer
// task + xterm write each, to paint at most 60 frames — so chunks are coalesced
// into a single send per short window. Nothing is dropped or reordered: the
// renderer receives exactly the same byte stream, in far fewer messages, and
// the buffer is flushed before the exit notice.
/** Coalescing window for pty output, in ms — under half a 60Hz frame. */
const PTY_FLUSH_MS = 8;
/** A firehose flushes at this size instead of growing a string for the window. */
const PTY_FLUSH_MAX_CHARS = 64 * 1024;

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

  let pendingData = '';
  let flushTimer = null;
  const flushPtyData = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingData) return;
    const payload = pendingData;
    pendingData = '';
    // The window can be gone before the shell notices; writing to a destroyed
    // sender throws and would take the main process with it.
    if (!sender.isDestroyed()) sender.send(`pty:data:${id}`, payload);
  };

  session.onData(chunk => {
    pendingData += chunk;
    if (pendingData.length >= PTY_FLUSH_MAX_CHARS) {
      flushPtyData();
      return;
    }
    if (flushTimer === null) flushTimer = setTimeout(flushPtyData, PTY_FLUSH_MS);
  });

  session.onExit(({ exitCode }) => {
    // Trailing output has to reach the terminal before the exit notice does.
    flushPtyData();
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

// Both probes below are SYNCHRONOUS filesystem work on the main thread — a
// discover sweep is ~30-40 PATH resolutions (statSync/accessSync across every
// PATH dir, plus an nvm readdirSync per miss) and a `--version` child process
// for every CLI that resolves; listRuntimes() is another ~15-17. Nothing in
// them is memoised downstream, and the renderer re-asks constantly: App.tsx
// re-runs discover on every workspace/layer switch, the Agents window fires its
// own on mount, and the Connect dialog's effect re-runs listRuntimes on every
// realtime agent UPDATE. Same answer, browser process blocked each time.
//
// So both answers are cached for a minute and concurrent callers share one
// in-flight sweep. A Rescan (options.refresh — Settings → Tools) always bypasses
// and refills BOTH, because "I just installed something" invalidates every
// probe in this process, not only the one being asked for.
const LOCAL_PROBE_TTL_MS = 60_000;
/** @type {Map<string, { at: number, promise: Promise<unknown> }>} */
const localCapabilityCache = new Map();
/** @type {{ at: number, data: unknown } | null} */
let localRuntimeListCache = null;

function invalidateLocalProbeCaches() {
  localCapabilityCache.clear();
  localRuntimeListCache = null;
}

ipcMain.handle('local-agents:discover', async (event, options = {}) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  try {
    const workspacePath = typeof options?.workspacePath === 'string' ? options.workspacePath : '';
    const refresh = Boolean(options?.refresh);
    if (refresh) {
      refreshLoginShellPath();
      invalidateLocalProbeCaches();
    }
    const cached = localCapabilityCache.get(workspacePath);
    if (cached && Date.now() - cached.at < LOCAL_PROBE_TTL_MS) {
      return { ok: true, data: await cached.promise };
    }
    const entry = {
      at: Date.now(),
      promise: detectLocalAgentCapabilities({ workspacePath, refresh }),
    };
    // A failed sweep must not be remembered for the whole TTL, and the rejection
    // needs an owner even when no caller is awaiting this entry any more.
    entry.promise.catch(() => {
      if (localCapabilityCache.get(workspacePath) === entry) {
        localCapabilityCache.delete(workspacePath);
      }
    });
    // Keys are workspace paths, so growth is bounded by the workspaces visited
    // in a session — but bound it anyway rather than hold snapshots forever.
    if (localCapabilityCache.size >= 8) {
      localCapabilityCache.delete(localCapabilityCache.keys().next().value);
    }
    localCapabilityCache.set(workspacePath, entry);
    return { ok: true, data: await entry.promise };
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
    if (options?.refresh) {
      refreshLoginShellPath();
      invalidateLocalProbeCaches();
    }
    const now = Date.now();
    if (localRuntimeListCache && now - localRuntimeListCache.at < LOCAL_PROBE_TTL_MS) {
      return { ok: true, data: localRuntimeListCache.data };
    }
    const data = localRuntime.listRuntimes();
    localRuntimeListCache = { at: now, data };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

// The agent detail pane polls local-runtime:status every 4s for as long as it
// is open. store.list() and store.shouldOpenAtLogin() each do their OWN
// readFileSync + JSON.parse of the autostart manifest, so every tick was two
// synchronous disk reads on the thread that also serves window events and IPC.
// The manifest only ever changes when this process writes it, so the derived
// view is cached behind a single statSync: unchanged mtime+size (or a still-
// absent file) answers from memory. Our own writes also invalidate explicitly,
// because a rewrite inside the same millisecond that happens to land on the
// same byte length would not move the stamp.
/** @type {{ stamp: string, agents: unknown[], openAtLogin: boolean } | null} */
let autostartViewCache = null;

function invalidateAutostartView() {
  autostartViewCache = null;
}

function readAutostartView() {
  const store = getLocalRuntimeAutostart();
  let stamp;
  try {
    const stat = fs.statSync(store.manifestPath());
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    stamp = 'absent';
  }
  if (autostartViewCache && autostartViewCache.stamp === stamp) return autostartViewCache;
  autostartViewCache = {
    stamp,
    agents: store.list().map((a) => ({
      agentId: a.agentId,
      runtime: a.runtime,
      autoStart: a.autoStart !== false,
      savedAt: a.savedAt,
    })),
    openAtLogin: store.shouldOpenAtLogin(),
  };
  return autostartViewCache;
}

ipcMain.handle('local-runtime:status', async (event, agentId) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  // `agents` is shared with the cache rather than rebuilt per poll; it crosses
  // the IPC boundary by structured clone, so the renderer still gets its own
  // copy and nothing here mutates it.
  const autostart = readAutostartView();
  return {
    ok: true,
    data: {
      session: localRuntime.status(agentId),
      running: localRuntime.listRunning(),
      autostart: autostart.agents,
      openAtLogin: autostart.openAtLogin,
    },
  };
});

// Daemon stdout/stderr used to reach the renderer one IPC message per LINE:
// supervisor.appendLog splits every chunk and calls onLog for each non-empty
// line, and each call was a structured clone + IPC hop + renderer task — for a
// channel nothing in the renderer subscribes to, so all of it was discarded on
// arrival. The fan-out is therefore opt-in: a window asks for an agent's log
// with 'local-runtime:log-subscribe' (and drops it with the -unsubscribe
// twin), and with no subscriber the emitter returns on a single Map size read
// before allocating anything. The supervisor still keeps lastLog/lastError for
// the status UI, so nothing that is displayed depends on this stream.
/** @type {Map<string, Set<Electron.WebContents>>} */
const localRuntimeLogSubscribers = new Map();

/** Flush window for a watched log — ~6 messages a second instead of thousands. */
const LOCAL_RUNTIME_LOG_FLUSH_MS = 100;
/** Flush early rather than grow an unbounded string for a storming daemon. */
const LOCAL_RUNTIME_LOG_MAX_CHARS = 64 * 1024;

/** Live subscribers for one agent, pruning windows that have gone away. */
function localRuntimeLogTargets(agentId) {
  const subs = localRuntimeLogSubscribers.get(String(agentId || ''));
  if (!subs) return null;
  for (const sender of subs) {
    if (sender.isDestroyed()) subs.delete(sender);
  }
  if (subs.size === 0) {
    localRuntimeLogSubscribers.delete(String(agentId || ''));
    return null;
  }
  return subs;
}

function createLocalRuntimeLogEmitter(agentId) {
  const key = String(agentId || '');
  const channel = `local-runtime:log:${agentId}`;
  let queued = [];
  let queuedChars = 0;
  let timer = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (queued.length === 0) return;
    // One message per window instead of one per line. The payload stays a
    // string — the onLog(line) bridge contract — with the lines rejoined in
    // order, so a subscriber appending them sees exactly the text the
    // unbatched path produced, nothing dropped and nothing reordered.
    const payload = queued.join('\n');
    queued = [];
    queuedChars = 0;
    const targets = localRuntimeLogTargets(agentId);
    if (!targets) return;
    for (const sender of targets) sender.send(channel, payload);
  };

  return (line) => {
    // Two-tier gate. The size read costs nothing and covers the normal case,
    // where nothing anywhere is watching a daemon log; the per-agent lookup
    // only runs when some agent's log IS being watched.
    if (localRuntimeLogSubscribers.size === 0) return;
    if (!localRuntimeLogSubscribers.has(key)) return;
    queued.push(line);
    queuedChars += line.length + 1;
    if (queuedChars >= LOCAL_RUNTIME_LOG_MAX_CHARS) {
      flush();
      return;
    }
    if (timer === null) timer = setTimeout(flush, LOCAL_RUNTIME_LOG_FLUSH_MS);
  };
}

ipcMain.handle('local-runtime:log-subscribe', (event, agentId) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  const id = String(agentId || '').trim();
  if (!id) return { ok: false, error: 'agentId is required' };
  let subs = localRuntimeLogSubscribers.get(id);
  if (!subs) {
    subs = new Set();
    localRuntimeLogSubscribers.set(id, subs);
  }
  // No 'destroyed' listener per subscription: several agents share one
  // webContents and that would trip Node's max-listeners warning the way the
  // pty owners map already documents. Dead senders are pruned on the next
  // flush instead.
  subs.add(event.sender);
  return { ok: true };
});

ipcMain.handle('local-runtime:log-unsubscribe', (event, agentId) => {
  if (!trustedIpcSender(event)) return { ok: false, error: 'Untrusted renderer' };
  const id = String(agentId || '').trim();
  const subs = localRuntimeLogSubscribers.get(id);
  if (subs) {
    subs.delete(event.sender);
    if (subs.size === 0) localRuntimeLogSubscribers.delete(id);
  }
  return { ok: true };
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
        invalidateAutostartView();
        syncLoginItemFromAutostart();
        console.log('[desktop-local] autostart saved', autostart, getLocalRuntimeAutostart().manifestPath());
      } catch (persistError) {
        console.warn('[desktop-local] autostart persist failed:', persistError?.message || persistError);
        autostart = { saved: false, error: persistError?.message || String(persistError) };
      }
    }

    const emitLog = createLocalRuntimeLogEmitter(options.agentId);
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
      onLog: emitLog,
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
    invalidateAutostartView();
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
  if (!singleInstanceLock) return;
  // Opt-in only. Default packaged behaviour talks to the hosted backend baked
  // into the renderer; AGENSIS_BACKEND_EXTERNAL (set by electron:dev) is still
  // honoured as a hard "never start local" so dev's own `npm run backend`
  // sidecar isn't double-started.
  if (process.env.AGENSIS_BACKEND_LOCAL && !process.env.AGENSIS_BACKEND_EXTERNAL) {
    backendServer = startLocalBackend();
  }
  createWindow();
  void flushAgentBundlePaths();

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
      // Before spawning anything, kill hung orphans (alive pid, silent
      // heartbeat) and scrub stale state left by a previous force-quit. The
      // CLI connect path does the same sweep; doing it here means a cold
      // desktop launch does not sit next to five storming connect processes.
      try {
        const { sweepDaemonHealthOnStartup } = require('./local-runtime/daemonHealth.cjs');
        const health = sweepDaemonHealthOnStartup({
          log: (line) => console.log(line),
        });
        console.log(
          `[desktop-local] health (${reason}) scanned=${health.scanned} `
          + `healthy=${health.healthy} hung=${health.hung} staleDead=${health.staleDead} `
          + `fixed=${health.actions.length}`,
        );
      } catch (healthError) {
        console.error('[desktop-local] health sweep failed:', healthError?.message || healthError);
      }

      syncLoginItemFromAutostart();
      const store = getLocalRuntimeAutostart();
      const pending = store.list();
      console.log(`[desktop-local] restore (${reason}) pending=${pending.length} path=${store.manifestPath()}`);
      if (pending.length === 0) return;
      const report = await restoreAutostartAgents(store, {
        maxAttempts: 6,
        attemptDelayMs: 3000,
        // restore.cjs pipes every daemon stdout LINE through this same log
        // (prefixed `[desktop-local:<agentId>] `), and its default is
        // console.log — a synchronous write on the main thread for every line
        // every restored daemon ever prints, for as long as the app runs, while
        // the user is idle. Keep restore's own progress lines, which are the
        // ones worth having, and drop the per-line firehose; the supervisor
        // still holds lastLog/lastError for the UI.
        log: (line) => {
          if (typeof line === 'string' && line.startsWith('[desktop-local:')) return;
          console.log(line);
        },
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

function tearDownLocalRuntimes() {
  // Tear down live daemons on quit (clean). Disk autostart list is preserved
  // so the next launch / reboot restore brings them back. The CLI also watches
  // AGENSIS_SUPERVISOR_PID and exits if this process disappears without us
  // getting here (force-quit / crash).
  try {
    localRuntime.stopAll();
  } catch {
    // ignore teardown races
  }
}

app.on('before-quit', () => {
  tearDownLocalRuntimes();
  if (backendServer) {
    backendServer.close();
    backendServer = null;
  }
});

// before-quit is not guaranteed on every platform path (e.g. some SIGTERM
// routes). Belt-and-braces with the supervisor-pid watchdog in the CLI.
app.on('will-quit', () => {
  tearDownLocalRuntimes();
});

process.once('SIGTERM', () => {
  tearDownLocalRuntimes();
});
process.once('SIGINT', () => {
  tearDownLocalRuntimes();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
