'use strict';

// Connects a local ACP session to the Agensis backend as a daemon-shaped
// WebSocket agent. When the server dispatches agent_job frames, we run them
// through the ACP host and stream agent_job_delta / agent_job_result back.
//
// This is the Electron-only job bridge. The separate agensis-agent CLI can
// adopt the same ACP host later.

const os = require('os');
const WebSocket = require('ws');
const acpHost = require('./host.cjs');

/** @type {Map<string, ReturnType<typeof createBridgeState>>} */
const bridges = new Map();

const CLASSIC_RUNTIMES = new Set(['claude', 'codex', 'amp']);

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]';
}

/**
 * Renderer often hands us the Vite origin (http://127.0.0.1:5173) from
 * apiBaseUrl(). Electron main must talk to the real backend (3142), not the
 * Vite WS proxy — proxy drops look like "online for a second then offline".
 */
function resolveHttpBackendBase(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return 'http://127.0.0.1:3142';
  try {
    const u = new URL(raw);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (isLoopbackHost(u.hostname) && (port === '5173' || port === '8888' || port === '80')) {
      return 'http://127.0.0.1:3142';
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw;
  }
}

function toWsUrl(baseUrl) {
  const httpBase = resolveHttpBackendBase(baseUrl);
  if (httpBase.startsWith('ws://') || httpBase.startsWith('wss://')) {
    return httpBase.includes('/backend/ws') ? httpBase : `${httpBase.replace(/\/+$/, '')}/backend/ws`;
  }
  const u = new URL(httpBase);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/backend/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

function createBridgeState(config) {
  return {
    ws: null,
    agentId: String(config.agentId || '').trim(),
    config: { ...config },
    heartbeatTimer: null,
    reconnectTimer: null,
    authTimer: null,
    stopped: false,
    registered: false,
    lastError: null,
    /** Bumps on every connect attempt so stale sockets cannot reconnect. */
    generation: 0,
    harnessId: config.harnessId || acpHost.status(config.agentId)?.harnessId || 'unknown',
    /** Server-enforced pin from agent.metadata.runtime when classic. */
    requiredRuntime: normalizeClassicRuntime(config.requiredRuntime),
  };
}

function capabilitiesPayload(state) {
  const caps = buildCapabilities(state.harnessId);
  const hash = `desktop-acp:${state.harnessId}:v1`;
  return {
    ...caps,
    // Server stores `hash` on capabilities_sync; heartbeats send `capabilitiesHash`.
    hash,
    capabilitiesHash: hash,
    memoryHash: 'none',
  };
}

function sendRegister(ws, state) {
  send(ws, {
    action: 'agent_register',
    workspaceId: state.config.workspaceId,
    agentId: state.agentId,
    handle: state.config.handle || '',
    name: state.config.name || state.config.handle || 'Desktop ACP',
    host: os.hostname(),
    cwd: state.config.cwd || process.cwd(),
    metadata: {
      runtime: 'agensis-desktop-acp',
      ...(state.executionRuntime ? { executionRuntime: state.executionRuntime } : {}),
      version: 'desktop-acp-0.1',
      model: state.config.model || 'auto',
      harnessId: state.harnessId,
    },
  });
}

function pushCapabilities(ws, state) {
  send(ws, {
    action: 'agent_capabilities_sync',
    ...capabilitiesPayload(state),
  });
}

function startHeartbeat(ws, state) {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  const beat = () => {
    if (state.stopped || state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    send(ws, {
      action: 'agent_heartbeat',
      capabilitiesHash: `desktop-acp:${state.harnessId}:v1`,
      memoryHash: 'none',
      metadata: {
        runtime: 'agensis-desktop-acp',
        ...(state.executionRuntime ? { executionRuntime: state.executionRuntime } : {}),
        harnessId: state.harnessId,
      },
    });
  };
  // First beat soon so last_seen moves even if the UI is idle.
  beat();
  state.heartbeatTimer = setInterval(beat, 12_000);
  // Keep the timer referenced so Electron does not drop it under load.
}

function normalizeClassicRuntime(value) {
  const runtime = String(value || '').trim().toLowerCase();
  return CLASSIC_RUNTIMES.has(runtime) ? runtime : '';
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function buildCapabilities(harnessId) {
  const clis = [harnessId].filter(Boolean);
  return {
    skills: [],
    commands: [],
    clis,
    mcpServers: [],
    memoryRoot: null,
    runtimes: {
      // Map harness → execution runtime for server mismatch checks.
      // Grok/hermes/goose are desktop-only harnesses; report as available custom.
      claude: { id: 'claude', label: 'Claude', available: harnessId === 'claude' },
      codex: { id: 'codex', label: 'Codex', available: harnessId === 'codex' },
      amp: { id: 'amp', label: 'Amp', available: harnessId === 'amp' },
    },
    codingRoute: true,
    shared: false,
  };
}

/**
 * Start (or replace) the WS bridge for an agent that already has a local ACP session.
 *
 * @param {{
 *   agentId: string,
 *   workspaceId: string,
 *   token: string,
 *   baseUrl: string,
 *   handle?: string,
 *   name?: string,
 *   harnessId?: string,
 *   cwd?: string,
 *   model?: string,
 * }} config
 */
/**
 * Resolve the executionRuntime we must declare so the server does not kick us.
 * Server rule: if agent.metadata.runtime is claude|codex|amp, the daemon MUST
 * declare the same executionRuntime or register fails / connection is closed.
 */
function resolveDeclaredRuntime(harnessId, requiredRuntime) {
  const harnessRuntime = normalizeClassicRuntime(harnessId);
  const required = normalizeClassicRuntime(requiredRuntime);
  if (required) {
    if (harnessRuntime && harnessRuntime !== required) {
      throw new Error(
        `This agent is pinned to the ${required} runtime, but you selected harness "${harnessId}". `
        + `Pick harness ${required}, or clear the agent runtime pin in the agent editor.`,
      );
    }
    // Non-classic harness (e.g. grok) cannot satisfy a classic pin.
    if (!harnessRuntime) {
      throw new Error(
        `This agent requires runtime "${required}", but harness "${harnessId}" is not a ${required} ACP adapter. `
        + `Select harness ${required}, or clear metadata.runtime on the agent.`,
      );
    }
    return required;
  }
  return harnessRuntime;
}

function startBridge(config) {
  const agentId = String(config.agentId || '').trim();
  if (!agentId) throw new Error('agentId is required');
  if (!config.token) throw new Error('token is required');
  if (!config.workspaceId) throw new Error('workspaceId is required');
  if (!config.baseUrl) throw new Error('baseUrl is required');

  const harnessId = config.harnessId || acpHost.status(agentId)?.harnessId || 'unknown';
  // Fail fast before opening a socket that would only flash online then die.
  const executionRuntime = resolveDeclaredRuntime(harnessId, config.requiredRuntime);

  stopBridge(agentId);

  const state = createBridgeState({ ...config, harnessId, requiredRuntime: config.requiredRuntime });
  state.executionRuntime = executionRuntime;
  state.httpBase = resolveHttpBackendBase(config.baseUrl);
  state.wsUrl = toWsUrl(config.baseUrl);
  bridges.set(agentId, state);
  console.log(`[desktop-acp] bridge start agent=${agentId} harness=${harnessId} runtime=${executionRuntime || '(none)'} ws=${state.wsUrl}`);
  connect(state);
  return {
    ok: true,
    agentId,
    wsUrl: state.wsUrl,
    httpBase: state.httpBase,
    executionRuntime: executionRuntime || null,
    harnessId,
  };
}

function connect(state) {
  if (state.stopped) return;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.authTimer) {
    clearTimeout(state.authTimer);
    state.authTimer = null;
  }
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  // Close any prior socket so two sockets cannot register and supersede each other.
  const prior = state.ws;
  if (prior) {
    try {
      prior.removeAllListeners();
      prior.close();
    } catch {
      // ignore
    }
  }

  const generation = (state.generation || 0) + 1;
  state.generation = generation;

  const url = state.wsUrl || toWsUrl(state.config.baseUrl);
  // F14: first frame carries the aga_ token so it never rides the WS query string.
  const ws = new WebSocket(url);
  state.ws = ws;
  state.registered = false;

  const isCurrent = () => !state.stopped && state.generation === generation && state.ws === ws;

  ws.on('open', () => {
    if (!isCurrent()) return;
    // Auth FIRST only. Server requires auth to settle before agent_register;
    // firing both immediately races and can leave a half-open "online then gone".
    send(ws, { type: 'auth', token: state.config.token });
    state.authTimer = setTimeout(() => {
      if (!isCurrent() || state.registered) return;
      state.lastError = 'Authentication timed out';
      console.error(`[desktop-acp] auth timeout agent=${state.agentId}`);
      try { ws.close(1008, 'Authentication timed out'); } catch { /* ignore */ }
    }, 12_000);
  });

  ws.on('message', (data) => {
    if (!isCurrent()) return;
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    // Wait for the server's auth ack before registering (see realtime.cjs path 2).
    if (message.type === 'system' && message.event === 'authenticated') {
      if (state.authTimer) {
        clearTimeout(state.authTimer);
        state.authTimer = null;
      }
      console.log(`[desktop-acp] authenticated agent=${state.agentId}`);
      sendRegister(ws, state);
      return;
    }

    if (message.type === 'agent_registered') {
      state.registered = true;
      state.lastError = null;
      if (state.authTimer) {
        clearTimeout(state.authTimer);
        state.authTimer = null;
      }
      console.log(`[desktop-acp] registered agent=${state.agentId} connection=${message.connection?.id || '?'}`);
      pushCapabilities(ws, state);
      startHeartbeat(ws, state);
      return;
    }

    // Server drift nudge — re-push the same snapshot (hash must match heartbeats).
    if (message.type === 'agent_capabilities_refresh') {
      if (state.registered) pushCapabilities(ws, state);
      return;
    }

    if (message.type === 'agent_disabled') {
      // Terminal: same as the classic daemon — do not reconnect with a bad pin.
      state.lastError = message.reason || message.code || 'agent_disabled';
      console.error(`[desktop-acp] agent_disabled: ${state.lastError}`);
      state.stopped = true;
      try { ws.close(); } catch { /* ignore */ }
      return;
    }

    if (message.type === 'agent_job' && message.job?.id) {
      void runJob(state, message.job);
      return;
    }

    if (message.type === 'error') {
      state.lastError = message.message || 'server error';
      console.error('[desktop-acp] server error:', state.lastError, message.code || '');
      if (message.code === 'runtime_mismatch' || /runtime/i.test(String(message.message || ''))) {
        state.stopped = true;
      }
      // Auth failures sometimes arrive as error frames before close.
      if (/auth|token|forbidden/i.test(String(message.message || ''))) {
        state.stopped = true;
      }
    }
  });

  ws.on('close', (code, reasonBuf) => {
    if (state.generation !== generation) return; // stale socket
    const reason = String(reasonBuf || '');
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    state.registered = false;
    console.log(`[desktop-acp] ws close agent=${state.agentId} code=${code || 'n/a'} reason=${reason || 'n/a'}`);
    if (state.stopped) return;
    // Auth / policy failures must not spin reconnect forever.
    if (code === 1008 || code === 4401 || code === 4403) {
      state.stopped = true;
      state.lastError = reason || `ws closed ${code}`;
      return;
    }
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!state.stopped && state.generation === generation) connect(state);
    }, 2000);
  });

  ws.on('error', (err) => {
    if (state.generation !== generation) return;
    state.lastError = err?.message || String(err);
    console.error('[desktop-acp] ws error:', state.lastError);
  });
}

function mapHarnessToRuntime(harnessId) {
  return normalizeClassicRuntime(harnessId);
}

async function runJob(state, job) {
  const jobId = job.id;
  const promptText = String(job.prompt || job.message || job.input || '').trim()
    || String(job.content || '').trim();
  if (!promptText) {
    send(state.ws, {
      action: 'agent_job_result',
      jobId,
      // Server reads `response` / `error` (classic daemon wire). `content` alone is ignored.
      response: '',
      error: 'Job had no prompt text',
      stopReason: 'agent_error',
    });
    return;
  }

  // Ensure ACP session exists (should already from Start).
  if (!acpHost.status(state.agentId)) {
    send(state.ws, {
      action: 'agent_job_result',
      jobId,
      response: '',
      error: 'Local ACP session is not running',
      stopReason: 'connection_lost',
    });
    return;
  }

  try {
    let streamed = '';
    const result = await acpHost.prompt(state.agentId, promptText, {
      onChunk: (chunk) => {
        streamed += chunk;
        send(state.ws, {
          action: 'agent_job_delta',
          jobId,
          // Deltas accept content OR response; content matches the classic daemon.
          content: streamed,
        });
      },
    });
    const text = String(result?.text || streamed || '').trim();
    send(state.ws, {
      action: 'agent_job_result',
      jobId,
      // MUST be `response` — handleAgentJobResult only reads message.response.
      // Sending `content` left response empty, so the server overwrote the live
      // stream with "@handle finished without output."
      response: text,
      error: '',
      stopReason: result?.stopReason === 'end_turn' ? 'completed' : (result?.stopReason || 'completed'),
      metadata: { harnessId: state.harnessId, executor: 'desktop-acp' },
    });
  } catch (err) {
    send(state.ws, {
      action: 'agent_job_result',
      jobId,
      response: '',
      error: err?.message || String(err),
      stopReason: 'agent_error',
    });
  }
}

function stopBridge(agentId) {
  const key = String(agentId || '');
  const state = bridges.get(key);
  if (!state) return { stopped: false };
  state.stopped = true;
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  try {
    state.ws?.close();
  } catch { /* ignore */ }
  bridges.delete(key);
  return { stopped: true, agentId: key };
}

function bridgeStatus(agentId) {
  const state = bridges.get(String(agentId || ''));
  if (!state) return null;
  return {
    agentId: state.agentId,
    connected: state.ws?.readyState === WebSocket.OPEN,
    registered: Boolean(state.registered),
    stopped: Boolean(state.stopped),
    harnessId: state.harnessId,
    executionRuntime: state.executionRuntime || null,
    wsUrl: state.wsUrl || null,
    lastError: state.lastError || null,
  };
}

function stopAllBridges() {
  for (const id of [...bridges.keys()]) stopBridge(id);
}

module.exports = {
  startBridge,
  stopBridge,
  bridgeStatus,
  stopAllBridges,
  toWsUrl,
  resolveHttpBackendBase,
  mapHarnessToRuntime,
  resolveDeclaredRuntime,
};
