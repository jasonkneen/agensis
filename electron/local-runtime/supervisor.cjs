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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
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

/**
 * 'auth-rejected' { agentId, handle }: the hub refused this agent's stored token
 * (it is rotated whenever a connect command is minted anywhere else), so the
 * daemon stopped itself. Only a signed-in renderer can mint a replacement.
 */
const events = new EventEmitter();
const AUTH_REJECTED = /authentication failed|rejected this agent connection/i;
function noteExit(session) {
  try { session.flushLog?.(); } catch { /* best effort */ }
  if (session.authRejected && !session.stopping) {
    events.emit('auth-rejected', { agentId: session.agentId, handle: session.handle });
  }
}

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
  // Two parsers see this string and they want different escapes, so neither
  // textbook answer works alone (all of the below verified empirically by
  // round-tripping through a real cmd.exe + .cmd shim):
  //
  //   - The CRT parser treats a backslash as an escape only when it precedes a
  //     quote. So every backslash run that lands before a quote — including the
  //     closing one we add — has to be doubled, or `--cwd "C:\proj\"` reads the
  //     final \" as a literal quote and swallows the following args. A --cwd
  //     with a trailing separator is the everyday way to hit that.
  //   - The quote itself must still be escaped as "" and not \". cmd.exe does
  //     not understand \", so it counts the quote as ending the quoted region
  //     and resumes treating metacharacters as syntax: `name\"&calc` would run
  //     calc. "" keeps cmd.exe's quote parity intact and the CRT still folds it
  //     to one literal quote.
  return `"${str.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`;
}


// ---------------------------------------------------------------------------
// DAEMONS OUTLIVE THIS PROCESS.
//
// A daemon used to be a piped, non-detached child that exited the moment this
// process did (AGENSIS_SUPERVISOR_PID watchdog) — so every desktop restart and
// every dev hot-reload dropped every connected agent and cold-started it again.
//
// Now each daemon is spawned detached with stdout/stderr going to a log file in
// its own state dir (a pipe nobody reads is what used to kill orphans), with no
// supervisor-pid watchdog. A sidecar file records what it was started with. On
// the next launch start() ADOPTS a daemon whose pid is alive, whose heartbeat is
// fresh and whose settings match, instead of killing and respawning it. A clean
// Quit still stops them (stopAll); a crash, SIGTERM or hot-reload releases them
// (releaseAll) and they keep their hub connection across the gap.
// ---------------------------------------------------------------------------

const SIDECAR_FILE = 'desktop-session.json';
const LOG_FILE = 'desktop-daemon.log';
const HEARTBEAT_FILE = 'heartbeat.json';
const ADOPT_MAX_HEARTBEAT_AGE_MS = 90_000;
const LOG_POLL_MS = 1000;
const EXIT_POLL_MS = 2000;

// Mirrors the CLI's state.mjs safeSegment so both sides agree on the directory.
function safeSegment(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 96);
  return cleaned || fallback;
}

function stateDirFor(workspaceId, agentId, homedir = os.homedir()) {
  return path.join(homedir, '.agensis', safeSegment(workspaceId, 'workspace'), safeSegment(agentId, 'agent'));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSidecar(dir, data) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, SIDECAR_FILE), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Without a sidecar the next launch simply respawns instead of adopting.
  }
}

function removeSidecar(dir) {
  try { fs.unlinkSync(path.join(dir, SIDECAR_FILE)); } catch { /* absent */ }
}

/**
 * The daemon this agent already has running from a previous desktop session, if
 * it is safe to keep: same agent, same settings, live pid, fresh heartbeat.
 * Anything doubtful returns null and the caller falls back to stop + respawn.
 */
function findAdoptable(dir, wanted, now = Date.now()) {
  const sidecar = readJson(path.join(dir, SIDECAR_FILE));
  if (!sidecar || !pidAlive(sidecar.pid)) return null;
  for (const key of ['baseUrl', 'runtime', 'model', 'permissionMode', 'cwd', 'tokenHash', 'workspaceId']) {
    if (String(sidecar[key] ?? '') !== String(wanted[key] ?? '')) return null;
  }
  const beat = readJson(path.join(dir, HEARTBEAT_FILE));
  if (!beat || Number(beat.pid) !== Number(sidecar.pid)) return null;
  const age = now - Number(beat.ts || 0);
  if (!(age >= 0 && age <= ADOPT_MAX_HEARTBEAT_AGE_MS)) return null;
  if (String(beat.status || '') === 'stopped') return null;
  return sidecar;
}

/** Feed new bytes appended to the daemon's log file into appendLog. */
function startLogTail(session, onLog, { fromEnd }) {
  const file = session.logPath;
  if (!file) return;
  let offset = session.logOffsetStart || 0;
  try {
    const size = fs.statSync(file).size;
    if (fromEnd) {
      offset = size;
      const start = Math.max(0, size - 8000);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        session.lastLog = buf.toString('utf8');
        if (/registered|authenticated|online/i.test(session.lastLog)) session.registeredHint = true;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // no log yet
  }
  const tick = () => {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < offset) offset = 0; // truncated / rotated
    if (size === offset) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(size - offset, 256 * 1024));
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      offset += read;
      appendLog(session, buf.subarray(0, read).toString('utf8'), onLog);
    } catch {
      // next tick
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  };
  session.flushLog = tick;
  session.logTimer = setInterval(tick, LOG_POLL_MS);
  session.logTimer.unref?.();
}

function stopTimers(session) {
  if (session.logTimer) clearInterval(session.logTimer);
  if (session.exitTimer) clearInterval(session.exitTimer);
  session.logTimer = null;
  session.exitTimer = null;
}

function sessionAlive(session) {
  if (session.adopted) return pidAlive(session.pid) && !session.exited;
  return Boolean(session.child && session.child.exitCode === null && !session.child.killed);
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
    pid: config.pid ?? child?.pid,
    startedAt: config.startedAt || new Date().toISOString(),
    adopted: Boolean(config.adopted),
    stateDir: config.stateDir || null,
    logPath: config.logPath || null,
    logTimer: null,
    exitTimer: null,
    exited: false,
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
  const alive = sessionAlive(session);
  return {
    agentId: session.agentId,
    adopted: session.adopted,
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
  if (AUTH_REJECTED.test(text)) session.authRejected = true;
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

  const stateDir = stateDirFor(options.workspaceId, agentId);
  const wanted = {
    workspaceId: String(options.workspaceId),
    baseUrl,
    runtime,
    model,
    permissionMode,
    cwd,
    tokenHash: hashToken(options.token),
  };

  // A daemon left running by the previous desktop session (restart, crash or
  // hot-reload) keeps its hub connection; take it over rather than replace it.
  // A second Start for an agent this process already runs still restarts it.
  if (!sessions.has(agentId)) {
    const existing = findAdoptable(stateDir, wanted);
    if (existing) return adopt(existing, { agentId, handle, name, runtime, connect, stateDir, wanted, options });
  }

  await stop(agentId).catch(() => {});
  // Settings changed (or the heartbeat went quiet): retire the old daemon so two
  // never serve one agent. The CLI also claims the pid file, this is the tidy path.
  await retireStaleDaemon(stateDir);

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

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDir, LOG_FILE);
  const logFd = fs.openSync(logPath, 'a', 0o600);
  const logStart = (() => { try { return fs.fstatSync(logFd).size; } catch { return 0; } })();

  let child;
  try {
    child = spawn(
      needsShell ? quoteWindowsShellArg(binary.command) : binary.command,
      needsShell ? args.map(quoteWindowsShellArg) : args,
      {
        cwd,
        env: {
          ...process.env,
          PATH: pathEnv,
          ...connect.env,
          ELECTRON_RUN_AS_NODE: undefined,
          // Deliberately NOT setting AGENSIS_SUPERVISOR_PID: the daemon must
          // outlive this process. Its own process guard still exits it on a
          // broken console, which is why output goes to a file, not a pipe.
          AGENSIS_SUPERVISOR_PID: undefined,
        },
        stdio: ['ignore', logFd, logFd],
        detached: true,
        shell: needsShell,
        windowsHide: true,
      },
    );
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();

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
      stateDir,
      logPath,
    },
    child,
    binary,
  );
  sessions.set(agentId, session);
  session.logOffsetStart = logStart;
  startLogTail(session, options.onLog, { fromEnd: false });

  child.on('error', (error) => {
    session.lastError = error?.message || String(error);
    console.error(`[desktop-local] spawn error agent=${agentId}:`, session.lastError);
  });

  child.on('exit', (code, signal) => {
    noteExit(session);
    stopTimers(session);
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

  writeSidecar(stateDir, { ...wanted, pid: child.pid, agentId, startedAt: session.startedAt, logPath });

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


async function terminatePid(pid, graceMs = 4000) {
  if (!pidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Stop whatever daemon a previous session recorded for this agent. */
async function retireStaleDaemon(stateDir) {
  const sidecar = readJson(path.join(stateDir, SIDECAR_FILE));
  if (sidecar && pidAlive(sidecar.pid) && Number(sidecar.pid) !== process.pid) {
    console.log(`[desktop-local] retiring previous daemon pid=${sidecar.pid}`);
    await terminatePid(Number(sidecar.pid));
  }
  removeSidecar(stateDir);
}

function adopt(sidecar, { agentId, handle, name, runtime, connect, stateDir, wanted, options }) {
  const session = createSession(
    {
      agentId,
      runtime,
      mode: connect.def.mode,
      workspaceId: wanted.workspaceId,
      handle,
      name,
      model: wanted.model,
      cwd: wanted.cwd,
      baseUrl: wanted.baseUrl,
      permissionMode: wanted.permissionMode,
      pid: Number(sidecar.pid),
      startedAt: sidecar.startedAt,
      adopted: true,
      stateDir,
      logPath: sidecar.logPath || path.join(stateDir, LOG_FILE),
    },
    null,
    null,
  );
  session.registeredHint = true; // it was already heartbeating when we found it
  sessions.set(agentId, session);
  startLogTail(session, options.onLog, { fromEnd: true });

  // No child handle to listen on, so watch the pid.
  session.exitTimer = setInterval(() => {
    if (pidAlive(session.pid)) return;
    noteExit(session);
    stopTimers(session);
    session.exited = true;
    session.pid = undefined;
    if (!session.stopping) session.lastError = session.lastError || 'daemon exited';
    console.log(`[desktop-local] exit agent=${agentId} (adopted daemon)`);
    if (typeof options.onExit === 'function') options.onExit({ agentId, code: null, signal: null });
  }, EXIT_POLL_MS);
  session.exitTimer.unref?.();

  console.log(`[desktop-local] adopted agent=${agentId} pid=${session.pid} runtime=${runtime}`);
  return {
    ok: true,
    agentId,
    runtime,
    mode: connect.def.mode,
    classicRuntime: connect.classicRuntime || null,
    acpHarness: connect.acpHarness || null,
    pid: session.pid,
    baseUrl: wanted.baseUrl,
    binarySource: null,
    adopted: true,
    label: runtimeStatusLabel(runtime),
  };
}

async function stop(agentId) {
  const id = String(agentId || '').trim();
  const session = sessions.get(id);
  if (!session) return { stopped: false, agentId: id };

  session.stopping = true;
  stopTimers(session);
  if (session.adopted) {
    await terminatePid(session.pid);
    removeSidecar(session.stateDir);
    sessions.delete(id);
    console.log(`[desktop-local] stop agent=${id} (adopted daemon)`);
    return { stopped: true, agentId: id };
  }
  const child = session.child;
  if (child && child.exitCode === null && child.signalCode == null) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode == null) child.kill('SIGKILL');
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
  removeSidecar(session.stateDir);
  sessions.delete(id);
  console.log(`[desktop-local] stop agent=${id}`);
  return { stopped: true, agentId: id };
}

function stopAll() {
  // The caller waits through escalation before allowing Electron to exit.
  return Promise.all([...sessions.keys()].map(id => stop(id)));
}

/**
 * Let go of every daemon WITHOUT stopping it: crash, SIGTERM and dev hot-reload
 * paths. They keep running and the next launch adopts them.
 */
function releaseAll() {
  for (const session of sessions.values()) stopTimers(session);
  sessions.clear();
}

module.exports = {
  events,
  releaseAll,
  findAdoptable,
  stateDirFor,
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
