'use strict';

// Desktop local runtime supervisor.
//
// "Start on this Mac" spawns the real @agensis/agensis-agent CLI so turns run
// through whatever each tool supports best:
//   - Claude → Agent SDK warm connection (--no-acp --runtime claude)
//   - Codex  → app-server (--no-acp --runtime codex)
//   - Amp    → --runtime amp (+ optional ACP harness)
//   - Grok / Hermes / Goose / Cursor / OpenCode / Kimi / OpenClaw → ACP harness
//   - Oh My Pi (omp) → coding-cmd until an ACP harness exists
//
// Desktop owns process lifecycle + autostart only. Job wire protocol lives in
// the CLI — one implementation instead of a second host.

const { spawn } = require('node:child_process');
const {
  resolveAgensisBinary,
  probeAgensisBinary,
  normalizeRuntime,
  resolveHttpBackendBase,
  desktopPathEnv,
} = require('./resolveBinary.cjs');
const {
  listDesktopRuntimes,
  getRuntimeDef,
  buildConnectFlags,
  runtimeStatusLabel,
  isClassicRuntime,
} = require('./runtimeCatalog.cjs');

/** @type {Map<string, ReturnType<typeof createSession>>} */
const sessions = new Map();

// child_process.spawn's shell:true does NOT escape args on Windows (Node
// warns about this — DEP0190): it hands cmd.exe a plain space-joined command
// line, so any arg with a space or shell metacharacter needs its own quoting.
// Unlike a static harness argv, the connect args below carry real user input
// (--name, --handle, --cwd, --token), so this is load-bearing, not defensive.
//
// cmd.exe expands %VAR% while it parses the command line, even inside a
// double-quoted argument. The usual %% escape for a literal percent does NOT
// survive here — Node's shell:true wraps the whole command line in an extra
// layer of quoting for `cmd /d /s /c "..."`, and that extra layer changes how
// the %-scan interacts with quote boundaries (verified empirically:
// %%USERPROFILE%% still expands to the real path through it). Rather than ship
// an escape that only looks safe, refuse a literal "%".
function quoteWindowsShellArg(value) {
  const str = String(value);
  if (str === '') return '""';
  if (str.includes('%')) {
    throw new Error(`Refusing to pass "%" through the Windows shell (cmd.exe would expand it as %VAR%): ${str}`);
  }
  if (!/[\s"^&|<>()]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function createSession(config, child, binary) {
  return {
    agentId: config.agentId,
    runtime: config.runtime || 'claude',
    mode: config.mode || 'sdk',
    workspaceId: config.workspaceId,
    handle: config.handle || '',
    name: config.name || '',
    model: config.model || 'auto',
    cwd: config.cwd || process.cwd(),
    baseUrl: config.baseUrl,
    permissionMode: config.permissionMode || 'default',
    pid: child.pid,
    startedAt: new Date().toISOString(),
    child,
    binary,
    lastError: null,
    lastLog: '',
    registeredHint: false,
    stopping: false,
    exitCode: null,
    exitSignal: null,
  };
}

function listRuntimes() {
  // Light path only: one login-shell PATH gather, no `agensis --version` spawn.
  // Heavy probes on this handler were freezing Electron (beachball) whenever
  // Agents / Connect opened.
  const pathEnv = desktopPathEnv();
  const probe = probeAgensisBinary({ pathEnv, light: true });
  return {
    daemon: {
      available: probe.ok,
      version: probe.version || null,
      error: probe.ok ? null : (probe.error || 'agensis CLI not found'),
      source: probe.binary?.source || null,
      path: probe.binary?.path || null,
    },
    runtimes: listDesktopRuntimes({ pathEnv }),
  };
}

function status(agentId) {
  const id = String(agentId || '').trim();
  const session = sessions.get(id);
  if (!session) return null;
  const alive = Boolean(session.child && session.child.exitCode === null && !session.child.killed);
  return {
    agentId: session.agentId,
    runtime: session.runtime,
    mode: session.mode,
    label: runtimeStatusLabel(session.runtime),
    cwd: session.cwd,
    baseUrl: session.baseUrl,
    model: session.model,
    pid: session.pid,
    startedAt: session.startedAt,
    running: alive && !session.stopping,
    lastError: session.lastError,
    registeredHint: session.registeredHint,
    binarySource: session.binary?.source || null,
  };
}

function listRunning() {
  return [...sessions.keys()]
    .map((id) => status(id))
    .filter((s) => s && s.running);
}

function appendLog(session, chunk, onLog) {
  const text = String(chunk || '');
  if (!text) return;
  session.lastLog = (session.lastLog + text).slice(-8000);
  if (/registered|authenticated|online/i.test(text)) {
    session.registeredHint = true;
  }
  if (/error|failed|refused/i.test(text) && !session.registeredHint) {
    const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (line) session.lastError = line.slice(0, 400);
  }
  if (typeof onLog === 'function') {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) onLog(line);
    }
  }
}

/**
 * Normalize caller runtime id (accept harnessId / requiredRuntime aliases).
 */
function pickRuntimeId(options = {}) {
  const raw = String(
    options.runtime || options.harnessId || options.requiredRuntime || options.acpHarness || '',
  ).trim().toLowerCase();
  if (getRuntimeDef(raw)) return getRuntimeDef(raw).id;
  // Legacy: classic pin only.
  const classic = normalizeRuntime(raw);
  if (classic) return classic;
  return 'claude';
}

/**
 * Start a local Relay daemon for one agent.
 *
 * @param {{
 *   agentId: string,
 *   workspaceId: string,
 *   token: string,
 *   baseUrl: string,
 *   handle?: string,
 *   name?: string,
 *   model?: string,
 *   cwd?: string,
 *   runtime?: string,
 *   harnessId?: string,
 *   requiredRuntime?: string,
 *   permissionMode?: string,
 *   onLog?: (line: string) => void,
 *   onExit?: (info: { agentId: string, code: number|null, signal: string|null }) => void,
 * }} options
 */
async function start(options = {}) {
  const agentId = String(options.agentId || '').trim();
  if (!agentId) throw new Error('agentId is required');
  if (!options.token) throw new Error('token is required');
  if (!options.workspaceId) throw new Error('workspaceId is required');

  const runtime = pickRuntimeId(options);
  const connect = buildConnectFlags(runtime);
  const baseUrl = resolveHttpBackendBase(options.baseUrl);
  const permissionMode = String(options.permissionMode || options.permission_mode || 'default').trim() || 'default';
  const cwd = options.cwd ? String(options.cwd) : process.cwd();
  const model = String(options.model || 'auto').trim() || 'auto';
  const handle = String(options.handle || '').trim();
  const name = String(options.name || handle || 'Desktop agent').trim();

  await stop(agentId).catch(() => {});

  const pathEnv = desktopPathEnv();
  const binary = resolveAgensisBinary({ pathEnv });
  if (!binary) {
    throw new Error(
      'agensis CLI not found on this Mac. Install the Relay host:\n'
      + '  npm install -g @agensis/agensis-agent\n'
      + 'Then reopen this dialog and Start again.',
    );
  }

  // Soft warning if the chosen tool is not on PATH (CLI may still fail later).
  const listed = listDesktopRuntimes({ pathEnv }).find((r) => r.id === runtime);
  if (listed && !listed.available) {
    console.warn(
      `[desktop-local] runtime ${runtime} not found on PATH (${listed.installHint || 'install the CLI'})`,
    );
  }

  const args = [
    ...binary.argsPrefix,
    'connect',
    '--url', baseUrl,
    '--token', String(options.token),
    '--workspace', String(options.workspaceId),
    '--agent', agentId,
    ...connect.args,
    '--permission-mode', permissionMode,
    '--model', model,
  ];
  if (handle) args.push('--handle', handle);
  if (name) args.push('--name', name);
  if (cwd) args.push('--cwd', cwd);

  console.log(
    `[desktop-local] start agent=${agentId} runtime=${runtime} mode=${connect.def.mode} url=${baseUrl} via=${binary.source}`,
  );

  // resolveAgensisBinary resolves through PATH, and on Windows that turns
  // `agensis`/`npx` into the npm-installed .cmd/.bat shim (see the win32 branch
  // in shared/local-agent-discovery.cjs). Those are batch files, not PE
  // executables, so child_process.spawn cannot exec them without shell:true.
  // Only shim extensions get shell:true — a resolved .exe still spawns
  // directly, with no argument re-quoting risk.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary.command);

  const child = spawn(
    needsShell ? quoteWindowsShellArg(binary.command) : binary.command,
    needsShell ? args.map(quoteWindowsShellArg) : args,
    {
      cwd,
      env: {
        ...process.env,
        PATH: pathEnv,
        ...connect.env,
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: needsShell,
      windowsHide: true,
    },
  );

  const session = createSession(
    {
      agentId,
      runtime,
      mode: connect.def.mode,
      workspaceId: String(options.workspaceId),
      handle,
      name,
      model,
      cwd,
      baseUrl,
      permissionMode,
    },
    child,
    binary,
  );
  sessions.set(agentId, session);

  child.stdout?.on('data', (buf) => appendLog(session, buf, options.onLog));
  child.stderr?.on('data', (buf) => appendLog(session, buf, options.onLog));

  child.on('error', (error) => {
    session.lastError = error?.message || String(error);
    console.error(`[desktop-local] spawn error agent=${agentId}:`, session.lastError);
  });

  child.on('exit', (code, signal) => {
    session.exitCode = code;
    session.exitSignal = signal;
    session.pid = undefined;
    if (!session.stopping && code !== 0) {
      session.lastError = session.lastError
        || `daemon exited (code=${code}, signal=${signal || 'none'})`;
    }
    console.log(
      `[desktop-local] exit agent=${agentId} code=${code} signal=${signal || 'none'}`,
    );
    if (typeof options.onExit === 'function') {
      options.onExit({ agentId, code, signal });
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 400));
  if (child.exitCode !== null || child.killed) {
    const detail = session.lastError || session.lastLog.trim().split('\n').pop() || 'daemon exited immediately';
    sessions.delete(agentId);
    throw new Error(detail);
  }

  return {
    ok: true,
    agentId,
    runtime,
    mode: connect.def.mode,
    classicRuntime: connect.classicRuntime || null,
    acpHarness: connect.acpHarness || null,
    pid: child.pid,
    baseUrl,
    binarySource: binary.source,
    label: runtimeStatusLabel(runtime),
  };
}

async function stop(agentId) {
  const id = String(agentId || '').trim();
  const session = sessions.get(id);
  if (!session) return { stopped: false, agentId: id };

  session.stopping = true;
  const child = session.child;
  if (child && child.exitCode === null && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  sessions.delete(id);
  console.log(`[desktop-local] stop agent=${id}`);
  return { stopped: true, agentId: id };
}

function stopAll() {
  const ids = [...sessions.keys()];
  for (const id of ids) {
    const session = sessions.get(id);
    if (!session?.child) continue;
    session.stopping = true;
    try {
      session.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  sessions.clear();
}

module.exports = {
  quoteWindowsShellArg,
  listRuntimes,
  status,
  listRunning,
  start,
  stop,
  stopAll,
  resolveHttpBackendBase,
  normalizeRuntime,
  pickRuntimeId,
  isClassicRuntime,
  getRuntimeDef,
};
