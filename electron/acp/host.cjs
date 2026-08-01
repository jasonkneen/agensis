'use strict';

// Desktop ACP host — process pool keyed by agentId.
// One ACP child per agent. Start = spawn + initialize + session/new.
// Prompt = session/prompt. Stop = kill.

const path = require('path');
const { createAcpClient } = require('./client.cjs');
const { listHarnesses, resolveHarness } = require('./harnesses.cjs');
const { refreshLoginShellPath } = require('../../shared/local-agent-discovery.cjs');

/** @type {Map<string, { agentId: string, harnessId: string, client: ReturnType<typeof createAcpClient>, cwd: string, startedAt: string, label: string, path: string }>} */
const sessions = new Map();

function publicStatus(entry) {
  if (!entry) return null;
  return {
    agentId: entry.agentId,
    harnessId: entry.harnessId,
    label: entry.label,
    path: entry.path,
    cwd: entry.cwd,
    sessionId: entry.client.sessionId,
    pid: entry.client.pid,
    startedAt: entry.startedAt,
    running: !entry.client.closed,
  };
}

function listRunning() {
  return [...sessions.values()].map(publicStatus).filter(Boolean);
}

function status(agentId) {
  return publicStatus(sessions.get(String(agentId || '')));
}

/**
 * @param {{
 *   agentId: string,
 *   harnessId: string,
 *   cwd?: string,
 *   model?: string,
 *   autoApprove?: boolean,
 *   onUpdate?: (params: object) => void,
 *   onLog?: (line: string) => void,
 * }} opts
 */
async function start(opts) {
  const agentId = String(opts.agentId || '').trim();
  if (!agentId) throw new Error('agentId is required');
  const harnessId = String(opts.harnessId || '').trim();
  if (!harnessId) throw new Error('harnessId is required');

  // Replace any previous session for this agent.
  if (sessions.has(agentId)) {
    await stop(agentId);
  }

  refreshLoginShellPath();
  const harness = resolveHarness(harnessId);
  if (!harness) {
    throw new Error(
      `Harness "${harnessId}" is not available on this machine. Install its CLI/adapter, then Rescan.`,
    );
  }

  const cwd = path.resolve(opts.cwd || process.cwd());
  const model = String(opts.model || 'auto').trim() || 'auto';
  // Inject model for harnesses that honor CLI flags / env (Codex ACP accepts
  // CODEX_MODEL; Claude adapter often uses ANTHROPIC_MODEL). ACP session
  // config can still override later.
  const env = { ...process.env };
  if (model && model !== 'auto') {
    if (harness.id === 'codex') env.CODEX_MODEL = model;
    if (harness.id === 'claude') env.ANTHROPIC_MODEL = model;
    env.AGENSIS_AGENT_MODEL = model;
  }
  const client = createAcpClient({
    command: harness.command,
    args: harness.args,
    cwd,
    env,
    autoApprove: opts.autoApprove !== false,
    onUpdate: opts.onUpdate,
    onLog: opts.onLog,
  });

  try {
    await client.initialize();
    await client.newSession(cwd);
  } catch (err) {
    client.dispose();
    throw err;
  }

  const entry = {
    agentId,
    harnessId: harness.id,
    label: harness.label,
    path: harness.path,
    client,
    cwd,
    model,
    startedAt: new Date().toISOString(),
  };
  sessions.set(agentId, entry);

  // If the ACP child dies, drop the session so restore/reconnect can respawn.
  const child = client._child;
  if (child && typeof child.on === 'function') {
    child.on('exit', (code, signal) => {
      const current = sessions.get(agentId);
      if (current?.client !== client) return;
      sessions.delete(agentId);
      console.warn(
        `[desktop-acp] harness exited agent=${agentId} harness=${harness.id} code=${code} signal=${signal || 'none'}`,
      );
      if (typeof opts.onExit === 'function') {
        try {
          opts.onExit({ agentId, harnessId: harness.id, code, signal });
        } catch {
          // ignore
        }
      }
    });
  }

  return publicStatus(entry);
}

async function stop(agentId) {
  const key = String(agentId || '');
  const entry = sessions.get(key);
  if (!entry) return { stopped: false };
  sessions.delete(key);
  try {
    entry.client.cancel();
  } catch { /* ignore */ }
  entry.client.dispose();
  return { stopped: true, agentId: key };
}

/**
 * @param {string} agentId
 * @param {string} text
 * @param {{ onChunk?: (t: string) => void }} [opts]
 */
async function prompt(agentId, text, opts = {}) {
  const entry = sessions.get(String(agentId || ''));
  if (!entry) throw new Error('No local ACP session for this agent — Start it first');
  if (entry.client.closed) {
    sessions.delete(String(agentId));
    throw new Error('ACP process has exited — Start the agent again');
  }
  return entry.client.prompt(text, opts);
}

function stopAll() {
  for (const id of [...sessions.keys()]) {
    void stop(id);
  }
}

module.exports = {
  listHarnesses,
  listRunning,
  status,
  start,
  stop,
  prompt,
  stopAll,
};
