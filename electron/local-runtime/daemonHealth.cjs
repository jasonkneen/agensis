'use strict';

// Desktop-side mirror of packages/agensis-cli/src/daemonHealth.mjs.
//
// Electron main is CJS and must not depend on a particular CLI package layout
// to clean hung daemons on launch. Keep the classification rules in lockstep
// with the CLI module (STALE_HEARTBEAT_MS, verdicts, actions). Tests pin both.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DAEMON_PID_FILE = 'daemon.pid';
const HEARTBEAT_FILE = 'heartbeat.json';
const STALE_HEARTBEAT_MS = 90_000;

const RESERVED_ROOT_ENTRIES = new Set([
  'daemon-profiles',
  'versions',
  'bridges',
  'cursorbuddy',
  'services',
  'w',
]);

function isProcessAlive(pid, killFn = process.kill) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    killFn(n, 0);
    return true;
  } catch {
    return false;
  }
}

function classifyDaemonState({
  heartbeat = null,
  pidFromFile = null,
  now = Date.now(),
  staleAfterMs = STALE_HEARTBEAT_MS,
  selfPid = process.pid,
  killFn = process.kill,
} = {}) {
  const beatPid = Number(heartbeat?.pid || 0);
  const filePid = Number(pidFromFile || 0);
  const pid = (Number.isInteger(filePid) && filePid > 0)
    ? filePid
    : (Number.isInteger(beatPid) && beatPid > 0 ? beatPid : null);

  if (!pid && !heartbeat) {
    return { verdict: 'absent', action: 'none', pid: null, ageMs: null, reason: 'no state' };
  }

  const ts = Number(heartbeat?.ts || 0);
  const ageMs = ts > 0 ? Math.max(0, now - ts) : null;
  const fresh = ts > 0 && ageMs != null && ageMs <= staleAfterMs;
  const status = String(heartbeat?.status || '');
  const claimsLive = status === 'online' || status === 'busy'
    || Boolean(heartbeat?.connected)
    || Boolean(heartbeat?.busy)
    || Number(heartbeat?.active || 0) > 0;

  if (pid && pid === selfPid) {
    return { verdict: 'healthy', action: 'none', pid, ageMs, reason: 'this process' };
  }

  const alive = pid ? isProcessAlive(pid, killFn) : false;

  if (alive && !fresh) {
    return {
      verdict: 'hung',
      action: 'kill',
      pid,
      ageMs,
      reason: ts
        ? `process ${pid} alive but heartbeat stale (${Math.round((ageMs || 0) / 1000)}s)`
        : `process ${pid} alive but no heartbeat`,
    };
  }

  if (alive && fresh) {
    return { verdict: 'healthy', action: 'none', pid, ageMs, reason: 'fresh heartbeat' };
  }

  if (status === 'stopped' && !pidFromFile) {
    return { verdict: 'stopped', action: 'none', pid, ageMs, reason: 'clean stop' };
  }

  if (pid || claimsLive || pidFromFile) {
    return {
      verdict: 'stale_dead',
      action: 'clean',
      pid,
      ageMs,
      reason: pid
        ? `pid ${pid} is dead; leftover state still claims liveness`
        : 'leftover liveness state with no live process',
    };
  }

  return { verdict: 'stopped', action: 'none', pid, ageMs, reason: 'idle' };
}

function readDaemonStateDir(dir) {
  let pidFromFile = null;
  try {
    const raw = fs.readFileSync(path.join(dir, DAEMON_PID_FILE), 'utf8').trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) pidFromFile = n;
  } catch {
    // absent
  }
  let heartbeat = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, HEARTBEAT_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) heartbeat = parsed;
  } catch {
    // absent
  }
  return { pidFromFile, heartbeat };
}

function listDaemonStateDirs({ homedir = os.homedir() } = {}) {
  const root = path.join(homedir, '.agensis');
  const out = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory() || ws.name.startsWith('.')) continue;
    if (RESERVED_ROOT_ENTRIES.has(ws.name)) continue;
    const wsPath = path.join(root, ws.name);
    let agents;
    try {
      agents = fs.readdirSync(wsPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ag of agents) {
      if (!ag.isDirectory() || ag.name.startsWith('.')) continue;
      const dir = path.join(wsPath, ag.name);
      if (!fs.existsSync(path.join(dir, DAEMON_PID_FILE))
        && !fs.existsSync(path.join(dir, HEARTBEAT_FILE))) {
        continue;
      }
      out.push({ dir, workspace: ws.name, agent: ag.name });
    }
  }
  return out;
}

function cleanDaemonStateDir(dir, { heartbeat = null } = {}) {
  try { fs.unlinkSync(path.join(dir, DAEMON_PID_FILE)); } catch { /* absent */ }
  const now = Date.now();
  const base = heartbeat && typeof heartbeat === 'object' ? heartbeat : {};
  const payload = {
    ...base,
    ts: now,
    iso: new Date(now).toISOString(),
    status: 'stopped',
    busy: false,
    active: 0,
    queueSize: 0,
    connected: false,
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, HEARTBEAT_FILE),
      `${JSON.stringify(payload, null, 2)}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

function stopDaemonPidSync(pid, { killFn = process.kill, waitMs = 2500 } = {}) {
  if (!pid || pid === process.pid) return { stopped: false };
  if (!isProcessAlive(pid, killFn)) return { stopped: true };
  try { killFn(pid, 'SIGTERM'); } catch { /* gone */ }
  const deadline = Date.now() + waitMs;
  while (isProcessAlive(pid, killFn) && Date.now() < deadline) {
    // busy-wait is intentional: before-restore on the main process must finish
    // quickly and we only run this for hung pids, not every launch path forever.
    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }
  }
  if (isProcessAlive(pid, killFn)) {
    try { killFn(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  return { stopped: !isProcessAlive(pid, killFn) };
}

/**
 * Scan + fix hung/stale local daemons. Called on desktop launch before autostart.
 * @param {{ fix?: boolean, log?: (line: string) => void, homedir?: string }} [opts]
 */
function runDaemonHealthCheck({
  fix = true,
  log = (line) => console.log(line),
  homedir = os.homedir(),
  now = Date.now(),
  staleAfterMs = STALE_HEARTBEAT_MS,
  killFn = process.kill,
} = {}) {
  const entries = listDaemonStateDirs({ homedir });
  const findings = [];
  const actions = [];
  let hung = 0;
  let staleDead = 0;
  let healthy = 0;

  for (const entry of entries) {
    const { pidFromFile, heartbeat } = readDaemonStateDir(entry.dir);
    const classified = classifyDaemonState({
      heartbeat,
      pidFromFile,
      now,
      staleAfterMs,
      killFn,
    });
    const row = {
      workspace: entry.workspace,
      agent: entry.agent,
      dir: entry.dir,
      handle: heartbeat?.handle || null,
      ...classified,
    };
    findings.push(row);
    if (row.verdict === 'healthy') healthy += 1;
    if (row.verdict === 'hung') hung += 1;
    if (row.verdict === 'stale_dead') staleDead += 1;

    if (!fix || row.action === 'none') continue;

    if (row.action === 'kill' && row.pid) {
      log(`[desktop-local] health: killing hung pid ${row.pid} (${row.handle || row.agent}) — ${row.reason}`);
      const stop = stopDaemonPidSync(row.pid, { killFn });
      cleanDaemonStateDir(entry.dir, { heartbeat });
      actions.push({
        workspace: row.workspace,
        agent: row.agent,
        handle: row.handle,
        action: 'killed',
        pid: row.pid,
        stopped: stop.stopped,
        reason: row.reason,
      });
      continue;
    }

    if (row.action === 'clean') {
      log(`[desktop-local] health: cleaning stale state for ${row.handle || row.agent} — ${row.reason}`);
      cleanDaemonStateDir(entry.dir, { heartbeat });
      actions.push({
        workspace: row.workspace,
        agent: row.agent,
        handle: row.handle,
        action: 'cleaned',
        pid: row.pid,
        reason: row.reason,
      });
    }
  }

  return {
    ok: hung === 0,
    scanned: findings.length,
    healthy,
    hung,
    staleDead,
    findings,
    actions,
    fixed: fix,
  };
}

function sweepDaemonHealthOnStartup(opts = {}) {
  try {
    return runDaemonHealthCheck({ fix: true, ...opts });
  } catch (error) {
    opts.log?.(`[desktop-local] health sweep failed: ${error?.message || error}`);
    return {
      ok: false,
      scanned: 0,
      healthy: 0,
      hung: 0,
      staleDead: 0,
      findings: [],
      actions: [],
      fixed: true,
      error: String(error?.message || error),
    };
  }
}

module.exports = {
  STALE_HEARTBEAT_MS,
  DAEMON_PID_FILE,
  classifyDaemonState,
  readDaemonStateDir,
  listDaemonStateDirs,
  cleanDaemonStateDir,
  runDaemonHealthCheck,
  sweepDaemonHealthOnStartup,
  isProcessAlive,
};
