'use strict';

const { WebSocketServer } = require('ws');

// Realtime: the WebSocket fanout, its authorization, and the socket server.
//
// Wave 4 of the server/index.cjs reduction — the first module that owns MUTABLE
// STATE the test suite resets. `websocketClients` lives here now, and it is a
// LET that resetTestState() REASSIGNS rather than clears, so index.cjs cannot
// simply hold a reference: this module exports reset(), and resetTestState()
// delegates to it. 41 test files call resetTestState; a Set that outlives a test
// makes the next one pass or fail depending on order, which is the failure mode
// this wave exists to avoid introducing.
//
// A FACTORY, not a module of free functions, for the same reason coreDeps()
// exists: every dependency is injected, so the auth and RBAC decisions
// (authorizeRealtimeBinding -> enforceDbOperationAccess) stay single-sourced in
// shared/backend-core.cjs and cannot drift.
//
// sanitizeRealtimeRow is the one to read before adding a column: heavy fields are
// STRIPPED from the fanout, so a large body added to a broadcast table is a
// memory and bandwidth problem on every connected client, not just the one that
// asked for it.

function createRealtime(deps = {}) {
 const {
  agentTokenFromWsRequest,
  // The vault's secret columns, so sanitizeRealtimeRow can strip them from the
  // fanout — a third layer under the write-only routes and the meta-only select.
  VAULT_SECRET_COLUMNS,
  enforceDbOperationAccess,
  enforceWorkspaceRole,
  enqueueFlowWebhookEvents,
  ensureTable,
  forbidden,
  handleAgentCapabilitiesSync,
  handleAgentJobDelta,
  handleAgentJobResult,
  handleAgentJobSegment,
  handleAgentJobStep,
  handleAgentMemorySync,
  handleAgentPermissionRequest,
  handleAgentSkillSync,
  handlePeerListRequest,
  handlePeerTicketRequest,
  inferenceBroker,
  logMessageActivity,
  markAgentConnectionOffline,
  refreshConnectedAgentConfigs,
  registerAgentConnection,
  updateAgentHeartbeat,
  verifyAgentConnectToken,
  verifyToken,
  voiceRelay,
  voiceStreamRateLimiter,
 } = deps;

 // Owned here, not injected — see the header. reset() below is what
 // resetTestState() calls.
 let websocketClients = new Set();

 // Heartbeat cadence for agent sockets. An ungraceful drop (laptop sleep, network
 // loss) leaves ws.readyState === 1 until a ping goes unanswered, so detection
 // latency is ~1-2x this interval. 15s → a dead socket is terminated within ~30s,
 // which fires 'close' → markAgentConnectionOffline → failConnectionJobs, turning
 // what used to be a 240s silent "Thinking…" hang into a fast, explicit failure.
 const LIVENESS_PING_INTERVAL_MS = 15_000;
 // Consecutive missed pongs before a socket is terminated. 2 → a daemon has ~30s
 // to answer before it is declared dead. See the livenessInterval comment.
 const LIVENESS_MAX_MISSED_PONGS = 2;

 // One liveness tick over a set of sockets. Extracted from the interval so the
// miss-tolerance is testable without standing up a server and waiting 30s.
 function sweepLiveness(clients) {
  const terminated = [];
  for (const client of clients) {
   if (client.isAlive === false) {
    client.missedPongs = (client.missedPongs || 0) + 1;
    if (client.missedPongs >= LIVENESS_MAX_MISSED_PONGS) {
     client.terminate();
     terminated.push(client);
     continue;
    }
   }
   client.isAlive = false;
   try { client.ping(); } catch { /* socket already closing */ }
  }
  return terminated;
 }

 function sendWs(ws, message) {
  if (ws.readyState !== 1) return false;
  // Drop instead of unbounded-buffering when a slow client backs up, and never let
  // a broken-pipe send throw into the realtime loop (it would skip later clients).
  if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > 4 * 1024 * 1024) return false;
  try {
   ws.send(JSON.stringify(message));
   return true;
  } catch {
   // socket went away mid-send; its 'close' handler will clean up subscriptions
   return false;
  }
 }

 function parseFilter(filter) {
  if (!filter || typeof filter !== 'string') return null;
  const match = filter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=eq\.(.+)$/);
  if (!match) return null;
  return { column: match[1], value: match[2] };
 }

 function matchesFilter(filter, row) {
  const parsed = parseFilter(filter);
  if (!parsed) return true;
  return String(row?.[parsed.column] ?? '') === parsed.value;
 }

 // H4 (2026-07 review): realtime subscriptions are authorized only at subscribe
 // time, so a member removed (or role-changed) mid-session keeps receiving a
 // workspace's live messages/canvas/tasks on their open socket until it drops.
 // When workspace_members changes, re-authorize every affected user's live
 // subscriptions against their CURRENT role and drop the ones that no longer
 // pass — reusing the same authoritative check as the subscribe path.
 async function revokeRealtimeAccessForMember(userId) {
  for (const ws of websocketClients) {
   if (String(ws.userId || '') !== String(userId)) continue;
   const subscriptions = ws.subscriptions || [];
   if (subscriptions.length === 0) continue;
   const kept = [];
   for (const subscription of subscriptions) {
    try {
     await authorizeRealtimeBinding(ws.userId, subscription.channel, subscription);
     kept.push(subscription);
    } catch {
     try {
      sendWs(ws, { type: 'system', event: 'unsubscribed', channel: subscription.channel, reason: 'access_revoked' });
     } catch { /* socket already closing */ }
    }
   }
   if (kept.length !== subscriptions.length) ws.subscriptions = kept;
  }
 }

 // Realtime rows can be heavy: the daemon mirrors full file bodies into
 // agent_memory_files.content_cache. Clients keep a metadata-only list and fetch
 // bodies on demand (see useAgentMemory), so stripping content_cache from the
 // broadcast is the real network win — otherwise every UPSERT fans the full body
 // (plus ~1/s heartbeat re-syncs) to every subscribed client. Keep the row shape
 // otherwise intact so list metadata (path, byte_size, summary, version) updates.
 // Fields stripped from the realtime fanout. Mostly heavy bodies — and, for
 // workspace_secrets, the two columns that hold secret material.
 //
 // No client can subscribe to workspace_secrets at all (authorizeRealtimeBinding
 // calls ensureTable, and the table is deliberately absent from ALLOWED_TABLES),
 // and the vault routes broadcast `{ workspace_id, key }` rather than a row. This
 // is the third layer, and the one that survives someone later passing a full row:
 // a secret riding a broadcast into every subscribed browser is the worst outcome
 // this feature has, so it is stripped structurally rather than by convention.
 const REALTIME_HEAVY_FIELDS = {
  agent_memory_files: ['content_cache'],
  agent_jobs: ['prompt', 'response'],
  workspace_secrets: VAULT_SECRET_COLUMNS,
  // Nothing broadcasts workspace_join_links today — the mint/list/revoke routes
  // deliberately do not call notifyDbSubscribers. This entry is here for the day
  // someone adds one: workspace_invites IS broadcast, so copying that pattern
  // across is the obvious next edit, and it would put token_hash on the wire.
  workspace_join_links: ['token_hash'],
 };

 function sanitizeRealtimeRow(table, row) {
  const heavy = REALTIME_HEAVY_FIELDS[table];
  if (!heavy || !row || typeof row !== 'object') return row;
  let copy = null;
  for (const field of heavy) {
   if (field in row) {
    if (!copy) copy = { ...row };
    delete copy[field];
   }
  }
  return copy || row;
 }

 function notifyDbSubscribers(table, eventType, rows) {
  const rowList = Array.isArray(rows) ? rows : [];
  if (rowList.length === 0) return;

  // Single chokepoint: every message INSERT spawns a companion activity event.
  // Guard on table === 'messages' so the activity insert above cannot recurse.
  if (table === 'messages' && eventType === 'INSERT') {
   void logMessageActivity(rowList);
  }

  // NET-07: drive the sidebar agent-status feed with a LEAN broadcast instead of
  // forcing every client to subscribe to the full workspace `messages` db_changes
  // firehose (which streamed every row — incl. ~1/s "Thinking" heartbeats, full
  // content — to everyone for one bubble). Emit only the fields the feed needs,
  // only for agent-authored rows, on the workspace-scoped broadcast channel that
  // authorizeRealtimeBroadcast already gates (enforceWorkspaceRole read).
  if (table === 'messages' && (eventType === 'INSERT' || eventType === 'UPDATE')) {
   for (const row of rowList) {
    if (!row || row.sender_kind !== 'agent' || !row.sender_id || !row.workspace_id) continue;
    relayBroadcast(`agent-status:${row.workspace_id}`, 'agent_status', {
     id: row.id,
     agentId: row.sender_id,
     senderName: row.sender_name || null,
     content: typeof row.content === 'string' ? row.content : '',
     eventType,
    });
   }
  }

  void enqueueFlowWebhookEvents(table, eventType, rowList).catch((error) => {
   console.error('[flows] failed to queue webhook event:', error.message || error);
  });

  if (table === 'workspace_agents') {
   refreshConnectedAgentConfigs(eventType, rowList);
  }

  // Prune the affected user's now-unauthorized subscriptions before fanning the
  // change out to everyone else (removed members must stop receiving data).
  if (table === 'workspace_members' && (eventType === 'DELETE' || eventType === 'UPDATE')) {
   for (const row of rowList) {
    if (row && row.user_id) void revokeRealtimeAccessForMember(row.user_id);
   }
  }

  for (const ws of websocketClients) {
   const subscriptions = ws.subscriptions || [];
   for (const subscription of subscriptions) {
    if (subscription.type !== 'db_changes') continue;
    if (subscription.table && subscription.table !== table) continue;
    if (subscription.schema && subscription.schema !== 'public') continue;
    if (subscription.event && subscription.event !== '*' && subscription.event !== eventType) continue;

    for (const row of rowList) {
     if (!matchesFilter(subscription.filter, row)) continue;
     const outRow = sanitizeRealtimeRow(table, row);
     sendWs(ws, {
      type: 'db_changes',
      schema: 'public',
      table,
      payload: eventType === 'DELETE'
       ? { eventType, new: {}, old: outRow }
       : { eventType, new: outRow, old: {} },
     });
    }
   }
  }
 }

 function relayBroadcast(channel, event, payload) {
  for (const ws of websocketClients) {
   const subscriptions = ws.subscriptions || [];
   const matches = subscriptions.some((subscription) => (
    subscription.type === 'broadcast' && subscription.channel === channel && subscription.event === event
   ));
   if (matches) {
    sendWs(ws, { type: 'broadcast', channel, event, payload });
   }
  }
 }

 // Fan a message out to EVERY authenticated socket, ignoring channel subscriptions.
 // Used for workspace-agnostic system events (e.g. a new frontend deploy going live)
 // that every connected client should hear regardless of what they're subscribed to.
 function broadcastGlobal(message) {
  let delivered = 0;
  for (const ws of websocketClients) {
   sendWs(ws, message);
   delivered += 1;
  }
  return delivered;
 }

 function tokenFromWsRequest(req) {
  try {
   const url = new URL(req.url || '', 'http://localhost');
   return url.searchParams.get('token') || '';
  } catch {
   return '';
  }
 }

 function workspaceIdFromRealtimeChannel(channel) {
  if (typeof channel !== 'string') return null;
  const [prefix, workspaceId, ...rest] = channel.split(':');
  if (rest.length > 0 || !workspaceId) return null;
  if (!['canvas', 'cursors', 'item-presence', 'agent-presence', 'agent-status'].includes(prefix)) return null;
  return workspaceId;
 }

 async function authorizeRealtimeBinding(userId, channel, binding) {
  if (!binding || typeof binding !== 'object') throw forbidden('Invalid realtime subscription');

  if (binding.type === 'broadcast') {
   const workspaceId = workspaceIdFromRealtimeChannel(channel);
   if (!workspaceId) throw forbidden('Broadcast channel is not allowed');
   await enforceWorkspaceRole(userId, workspaceId, 'read');
   return;
  }

  if (binding.type === 'db_changes') {
   ensureTable(binding.table);
   const parsed = parseFilter(binding.filter);
   if (binding.table === 'workspaces') {
    if (!parsed) throw forbidden('Workspace realtime subscriptions require a row filter');
    if (parsed.column === 'id') {
     await enforceWorkspaceRole(userId, parsed.value, 'read');
     return;
    }
    if (parsed.column === 'user_id' && String(parsed.value) === String(userId)) return;
    throw forbidden('Workspace realtime filter is not allowed');
   }
   const filters = parsed ? [{ column: parsed.column, operator: 'eq', value: parsed.value }] : [];
   await enforceDbOperationAccess(userId, binding.table, 'select', { filters });
   return;
  }

  throw forbidden('Realtime subscription type is not allowed');
 }

 async function authorizeRealtimeBroadcast(userId, channel) {
  const workspaceId = workspaceIdFromRealtimeChannel(channel);
  if (!workspaceId) throw forbidden('Broadcast channel is not allowed');
  await enforceWorkspaceRole(userId, workspaceId, 'read');
 }

 function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/backend/ws' });

  wss.on('connection', (ws, req) => {
   // FIRST listener: ws@8 emits 'error' on the socket for any receiver-level
   // protocol violation (invalid UTF-8, bad opcode, oversized frame). The WS
   // handshake needs no credentials (auth is a first-message frame), so without a
   // handler any anonymous client could crash the process — an EventEmitter
   // 'error' with no listener throws. Log only: ws closes the socket itself and
   // the 'close' handler below already does the cleanup.
   ws.on('error', (error) => {
    console.warn('[backend] websocket error:', error?.message || error);
   });
   ws.subscriptions = [];
   // Liveness: the heartbeat interval below pings each socket and terminates any
   // that miss a pong, so an ungraceful drop still fires 'close' (→ offline).
   ws.isAlive = true;
   ws.missedPongs = 0;
   ws.on('pong', () => { ws.isAlive = true; ws.missedPongs = 0; });

   // H3/H5 — two auth paths, retained for backward compatibility:
   //  (1) Legacy query-param credentials: `agentToken=` or `token=`.
   //  (2) First-message auth frame `{ type: 'auth', token }`, used by the browser
   //      and the public agensis-agent daemon so tokens stay out of proxy logs.
   // authReady resolves true on success, false on failure/timeout; the message
   // handler gates every action on it.
   let authSettled = false;
   let resolveAuth;
   const authReady = new Promise((resolve) => { resolveAuth = resolve; });
   function settleAuth(value) {
    if (authSettled) return;
    authSettled = true;
    resolveAuth(value);
   }
   function finalizeAuthenticated(userId, agentAuth) {
    ws.userId = userId;
    ws.agentAuth = agentAuth;
    websocketClients.add(ws);
    settleAuth(true);
   }

   // Path (1): try query-param credentials up front. If absent/invalid we do NOT
   // close — we wait for an auth frame (path 2) or the timeout below.
   (async () => {
    const userId = await verifyToken(tokenFromWsRequest(req));
    const agentAuth = userId ? null : await verifyAgentConnectToken(agentTokenFromWsRequest(req), req);
    if (userId || agentAuth) finalizeAuthenticated(userId, agentAuth);
   })().catch(() => { /* fall through to the auth-frame path / timeout */ });

   // Reject if neither path authenticates within the grace window.
   const authTimer = setTimeout(() => {
    if (!authSettled) {
     settleAuth(false);
     try { ws.close(1008, 'Authentication required'); } catch { /* already closing */ }
    }
   }, 10_000);
   if (authTimer.unref) authTimer.unref();

   ws.on('message', async (raw, isBinary) => {
    // Binary frames are microphone audio for the Deepgram relay and nothing
    // else. Checked FIRST: String()-ing a PCM buffer and handing it to JSON.parse
    // is pure waste on a frame that arrives ~31 times a second (512 samples at
    // 16kHz — see FRAMES_PER_POST in src/lib/pcmTap.worklet.js, halved from 1024
    // to halve how long the last word of an utterance waits before Deepgram sees
    // it), and an authenticated socket is the only place audio may come from.
    // ws.userId is set only by finalizeAuthenticated, and only for a HUMAN
    // session token — a daemon's agent-token socket has none and can never open
    // a stream, let alone feed one.
    if (isBinary) {
     if (!ws.userId) return;
     voiceRelay.handleAudio(ws, raw);
     return;
    }

    let message;
    try {
     message = JSON.parse(String(raw || '{}'));
    } catch {
     return;
    }

    // Path (2): the first valid `auth` frame authenticates the socket. Only
    // honored while auth is still unsettled (it must be the FIRST message).
    if (!authSettled && message && message.type === 'auth') {
     try {
      const userId = await verifyToken(message.token);
      const agentAuth = userId ? null : await verifyAgentConnectToken(message.token, req);
      if (!userId && !agentAuth) {
       settleAuth(false);
       ws.close(1008, 'Authentication failed');
       return;
      }
      finalizeAuthenticated(userId, agentAuth);
      sendWs(ws, { type: 'system', event: 'authenticated' });
     } catch {
      settleAuth(false);
      try { ws.close(1008, 'Authentication failed'); } catch { /* already closing */ }
     }
     return;
    }

    try {
     const authenticated = await authReady;
     if (!authenticated) return;
     if (message.action === 'subscribe') {
      const binding = { channel: message.channel, ...(message.binding || {}) };
      await authorizeRealtimeBinding(ws.userId, message.channel, binding);
      const exists = (ws.subscriptions || []).some((subscription) => JSON.stringify(subscription) === JSON.stringify(binding));
      if (!exists) {
       ws.subscriptions.push(binding);
      }
      sendWs(ws, { type: 'system', event: 'subscribed', channel: message.channel });
      return;
     }
     if (message.action === 'unsubscribe') {
      ws.subscriptions = (ws.subscriptions || []).filter((subscription) => subscription.channel !== message.channel);
      return;
     }
     if (message.action === 'broadcast') {
      await authorizeRealtimeBroadcast(ws.userId, message.channel);
      relayBroadcast(message.channel, message.event, message.payload);
      return;
     }
     // Huddle speech-to-text. Replies ride the `system` event channel the
     // browser already listens on, so no client-side plumbing was needed to
     // receive them.
     if (message.action === 'voice_stt_start' || message.action === 'voice_stt_stop') {
      if (!ws.userId) return;
      const handled = await voiceRelay.handleControl(ws, message, {
       send: (payload) => sendWs(ws, { type: 'system', event: 'voice_stt', payload }),
       rateLimited: () => !voiceStreamRateLimiter.check(String(ws.userId)).allowed,
      });
      if (handled) return;
     }
     if (message.action === 'agent_register') {
      await registerAgentConnection(ws, message);
      return;
     }
     if (message.action === 'agent_heartbeat') {
      await updateAgentHeartbeat(ws, message.metadata || {}, {
       capabilitiesHash: message.capabilitiesHash,
       memoryHash: message.memoryHash,
       skillsHash: message.skillsHash,
      });
      return;
     }
     if (message.action === 'agent_job_result') {
      await handleAgentJobResult(ws, message);
      return;
     }
     if (message.action === 'agent_job_delta') {
      await handleAgentJobDelta(ws, message);
      return;
     }
     if (message.action === 'agent_job_step') {
      await handleAgentJobStep(ws, message);
      return;
     }
     if (message.action === 'agent_job_segment') {
      await handleAgentJobSegment(ws, message);
      return;
     }
     if (message.action === 'agent_permission_request') {
      await handleAgentPermissionRequest(ws, message);
      return;
     }
     if (['agent_inference_started', 'agent_inference_delta', 'agent_inference_result', 'agent_inference_error'].includes(message.action)) {
      inferenceBroker.handleAgentEvent(ws.agentId, message, ws.agentConnectionId);
      return;
     }
     if (message.action === 'agent_memory_sync') {
      await handleAgentMemorySync(ws, message);
      return;
     }
     if (message.action === 'agent_skill_sync') {
      await handleAgentSkillSync(ws, message);
      return;
     }
     if (message.action === 'agent_capabilities_sync') {
      await handleAgentCapabilitiesSync(ws, message);
      return;
     }
     if (message.action === 'peer_ticket_request') {
      await handlePeerTicketRequest(ws, message);
      return;
     }
     if (message.action === 'peer_list_request') {
      await handlePeerListRequest(ws);
      return;
     }
    } catch (error) {
     if (error?.code === 'runtime_mismatch') {
      const message = error?.message || 'Agent runtime mismatch';
      sendWs(ws, { type: 'agent_disabled', reason: message, code: 'runtime_mismatch' });
      try { ws.close(1008, 'Agent runtime mismatch'); } catch { /* already closing */ }
      return;
     }
     sendWs(ws, { type: 'error', code: error?.code || undefined, message: error?.message || 'Realtime request rejected' });
    }
   });

   ws.on('close', () => {
    clearTimeout(authTimer);
    settleAuth(false);
    websocketClients.delete(ws);
    // A leaked upstream keeps billing Deepgram for a browser that is gone.
    voiceRelay.teardown(ws);
    void markAgentConnectionOffline(ws);
   });
  });

  // Ping connected sockets on every LIVENESS_PING_INTERVAL_MS; terminate any that
  // missed LIVENESS_MAX_MISSED_PONGS consecutive pings. terminate() fires 'close',
  // which marks the agent connection offline — this catches daemons that vanish
  // without a clean disconnect (sleep, network loss, kill -9) and would otherwise
  // show as "online" forever. The interval also drives isConnectionSocketLive's
  // isAlive flag.
  //
  // Why a counter and not the old single-miss boolean: ONE missed pong inside 15s
  // was the entire budget, and a laptop daemon misses it routinely — a Wi-Fi roam,
  // a lid nap, or an event loop starved by the `claude -p` subprocesses it is
  // supervising. Terminating there kills every job on that connection, including a
  // turn five minutes into real work (observed live 2026-07-28: a Coder turn died
  // mid-`tsc`, taking a second DM job with it). Two misses buys ~30s, which covers
  // an ordinary blip while still catching a genuinely dead socket well inside the
  // job reaper's window.
  const livenessInterval = setInterval(() => sweepLiveness(wss.clients), LIVENESS_PING_INTERVAL_MS);
  livenessInterval.unref?.();
  wss.on('close', () => clearInterval(livenessInterval));
  // Server-level errors (a failed upgrade, an EADDR-style listen error surfaced by
  // ws) would otherwise be an unhandled 'error' and kill the process.
  wss.on('error', (error) => {
   console.warn('[backend] websocket server error:', error?.message || error);
  });

  return wss;
 }

 // Test seam: register a fake WS client so the realtime-revocation path can be
 // exercised without a live socket server.
 function registerTestWebsocketClient(ws) {
  websocketClients.add(ws);
  return ws;
 }

 // Called by index.cjs's resetTestState(). Reassigns rather than clears, exactly
 // as the original did — a caller holding the old Set must not keep receiving
 // broadcasts.
 function reset() {
  websocketClients = new Set();
 }

 return {
  sendWs,
  notifyDbSubscribers,
  sanitizeRealtimeRow,
  relayBroadcast,
  broadcastGlobal,
  attachRealtime,
  authorizeRealtimeBinding,
  authorizeRealtimeBroadcast,
  revokeRealtimeAccessForMember,
  registerTestWebsocketClient,
  sweepLiveness,
  LIVENESS_MAX_MISSED_PONGS,
  // Exported for __test in index.cjs: the channel-name parser the realtime
  // authorization tests assert directly.
  workspaceIdFromRealtimeChannel,
  reset,
 };
}

module.exports = { createRealtime };
