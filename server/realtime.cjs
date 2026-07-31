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
  // Optional so the existing realtime tests can build this without one; the
  // engine itself no-ops when AGENSIS_AUTOMATIONS is off.
  enqueueAutomationRuns = async () => [],
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
  handleBridgeMessage,
  handlePeerListRequest,
  handlePeerTicketRequest,
  inferenceBroker,
  // Is this session members-only, and who are they? Injected rather than
  // imported so the read rule stays single-sourced in shared/backend-core.cjs —
  // a second copy here is exactly how the fanout would drift back open.
  isPrivateSessionRow = () => false,
  sessionMemberUserIds = async () => new Set(),
  logMessageActivity,
  markAgentConnectionOffline,
  refreshConnectedAgentConfigs,
  registerAgentConnection,
  // Resolves a session's workspace AND canonical private/open classification.
  // The production injection bypasses its ordinary workspace cache because
  // privacy is mutable and Netlify can update the shared DB without notifying
  // this Fly process. Keeping the two values together prevents a message from
  // being routed on workspace alone and forgetting the session boundary.
  resolveSessionActivityContext = async () => null,
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
 // Consecutive missed pongs before a socket is terminated.
 //
 // Was 2 (~30s), which killed HEALTHY daemons mid-turn. A daemon is a Node
 // process that shells out: `npx vite build`, `npx vitest run`, a long grep. While
 // it pipes a child's stdout its event loop can stall for far longer than 30s, and
 // a pong is answered ON that event loop — so "hasn't ponged in 30s" does not mean
 // "gone", it very often means "busy doing exactly what it was asked to do".
 //
 // Terminating fires 'close' → failConnectionJobs → the turn is marked error and
 // its work is LOST (observed live 2026-07-29: job 4c065aaa killed at 6m07s with
 // "the daemon disconnected" while the agent was mid-build).
 //
 // 8 → ~120s of grace. Still an order of magnitude faster than the 240s silent
 // "Thinking…" hang this heartbeat replaced, and a genuinely dead socket (laptop
 // asleep, network gone) is still reaped automatically — just not while a build
 // is running. Detection latency is the cheap side of this trade; a destroyed
 // turn is the expensive one.
 const LIVENESS_MAX_MISSED_PONGS = 8;

 // Per-socket subscription ceiling. See the subscribe handler for why this is a
 // fanout-cost bound rather than an abuse bound.
 const MAX_SUBSCRIPTIONS_PER_SOCKET = 200;

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
  // channel_bridges.config is jsonb holding Slack/Telegram botToken, Slack
  // signingSecret and OpenClaw authToken. The REST projection publicBridge drops
  // it — "a bot token in a JSON response ends up in devtools, in logs, and in a
  // screenshot" — but all four notifyDbSubscribers('channel_bridges', …) calls
  // pass raw `returning *` rows and never touch that projection. The tokens are
  // already on the broadcast payload; they reach nobody today only because the
  // table is deliberately absent from ALLOWED_TABLES, which makes one line in
  // that Set the whole distance between here and handing every workspace member
  // with `read` a live Slack bot token.
  //
  // The whole column, not named fields: a new provider added to PROVIDER_FIELDS
  // in server/bridge-admin-routes.cjs would otherwise leak by default.
  channel_bridges: ['config'],
  // gateway_configs is now subscribable (src/hooks/useGateways.ts), so this one
  // is live rather than pre-emptive.
  //
  // The three dedicated routes in server/workspaces-routes.cjs already map their
  // fanout through publicGatewayConfig, which drops api_key_cipher — but the
  // GENERIC /backend/db/update|delete routes fan out raw `returning *` rows, and
  // allowlisting the table is exactly what opened those. So the encrypted provider
  // key reaches this function on the generic path and nowhere else strips it.
  //
  // `headers` goes too, for the reason publicGatewayConfig does NOT strip it and
  // should: an operator can put `Authorization: Bearer …` in that jsonb. Nothing
  // is lost — useGateways ignores the payload and refetches over REST, so the
  // realtime row is a change notification, not data.
  gateway_configs: ['api_key_cipher', 'headers'],
  // Nothing broadcasts workspace_join_links today — the mint/list/revoke routes
  // deliberately do not call notifyDbSubscribers. This entry is here for the day
  // someone adds one: workspace_invites IS broadcast, so copying that pattern
  // across is the obvious next edit, and it would put token_hash on the wire.
  workspace_join_links: ['token_hash'],
  // workspace_invites.token is NAMED token and HOLDS hashAgentToken(token) — the
  // same value workspace_join_links spells token_hash, under a name that reads
  // like the raw credential. All five fanout calls in
  // server/members-invites-routes.cjs pass raw `returning *` rows. Nothing
  // subscribes (the table is deliberately absent from ALLOWED_TABLES), so this is
  // pre-emptive in exactly the way the line above it is — and it is the entry that
  // makes the pair consistent, which is what stops the next reader concluding the
  // omission was a judgement rather than an oversight.
  workspace_invites: ['token'],
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

 // Broadcast the sidebar's lean agent-status payload for agent-authored rows.
 //
 // One session-context lookup per distinct session_id per batch, not per row: a
 // turn that writes several rows at once resolves once. Privacy is read
 // authoritatively on every batch: workspace id is stable, visibility is not.
 //
 // Best-effort by construction. A failed or missing lookup means no broadcast —
 // the same outcome as before this worked — and must never reject into the
 // fanout, which is why the whole body is wrapped and the caller uses `void`.
 async function emitAgentStatus(rowList, eventType) {
  try {
   const agentRows = rowList.filter((row) => row && row.sender_kind === 'agent' && row.sender_id && row.session_id);
   if (agentRows.length === 0) return;
   const contextBySession = new Map();
   for (const sessionId of new Set(agentRows.map((row) => String(row.session_id)))) {
    try {
     const context = await resolveSessionActivityContext(sessionId);
     if (!context?.workspaceId) continue;
     if (!context.isPrivate) {
      contextBySession.set(sessionId, context);
      continue;
     }
     // Private sessions take the SAME membership path as private chat-session
     // rows. The lookup includes grant expiry, and any failure withholds the
     // status entirely — missing a sidebar update is recoverable; publishing a
     // DM's words to a workspace reader is not.
     const allowedUserIds = await sessionMemberUserIds(sessionId);
     if (!(allowedUserIds instanceof Set)) continue;
     contextBySession.set(sessionId, { ...context, allowedUserIds });
    } catch {
     // Fail closed per session. The production context resolver catches its own
     // DB errors and returns null, but sessionMemberUserIds can still throw, and
     // an injected replacement has no enforced contract.
    }
   }
   for (const row of agentRows) {
    const context = contextBySession.get(String(row.session_id));
    if (!context) continue;
    const payload = {
     id: row.id,
     agentId: row.sender_id,
     senderName: row.sender_name || null,
     content: typeof row.content === 'string' ? row.content : '',
     eventType,
    };
    const channel = `agent-status:${context.workspaceId}`;
    if (context.isPrivate) {
     relayBroadcastToUserIds(channel, 'agent_status', payload, context.allowedUserIds);
    } else {
     relayBroadcast(channel, 'agent_status', payload);
    }
   }
  } catch (error) {
   console.error('[agent-status] broadcast failed:', error?.message || error);
  }
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
  //
  // The workspace is RESOLVED, not read off the row. `messages` has no
  // workspace_id column and never has — verified against the live database, not
  // just the DDL — so the guard this replaced (`!row.workspace_id`) short-
  // circuited on every row and this broadcast had never fired in production.
  // Its consumer (src/hooks/useAgentStatusFeed.ts) has been waiting for a
  // payload that could not arrive, which is why the sidebar's activity line sat
  // on two generic presence strings for a whole job.
  //
  // Async, fire-and-forget, exactly like logMessageActivity above:
  // notifyDbSubscribers is synchronous and holds no DB handle, and enriching the
  // ~18 call sites that pass `insert ... returning *` rows straight through
  // would be 18 chances to forget.
  if (table === 'messages' && (eventType === 'INSERT' || eventType === 'UPDATE')) {
   void emitAgentStatus(rowList, eventType);
  }

  void enqueueFlowWebhookEvents(table, eventType, rowList).catch((error) => {
   console.error('[flows] failed to queue webhook event:', error.message || error);
  });

  // Workspace automations, alongside the outbound webhook enqueue and with the
  // same failure posture: fire-and-forget, caught and logged. An automation that
  // cannot be queued must never cost the user the write that triggered it.
  // Enqueue only ever INSERTS a queue row — execution is the bounded 30s drain
  // in server/automations.cjs, so this chokepoint (every workspace write in the
  // product passes through it) stays fast.
  void enqueueAutomationRuns(table, eventType, rowList).catch((error) => {
   console.error('[automations] failed to queue run:', error.message || error);
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

  // A PRIVATE chat_sessions row cannot ride the synchronous lane.
  //
  // Subscribing is gated (authorizeRealtimeBinding -> enforceDbOperationAccess),
  // but a `chat_sessions` subscription filtered on workspace_id is legitimate —
  // that is how the sidebar stays live — and every row matching that filter is
  // fanned out below. Without this split, opening a DM would push its title and
  // roster to every socket in the workspace, which is the same disclosure the
  // bootstrap payload was just fixed to withhold. `messages` needs no equivalent:
  // an unfiltered messages subscription cannot be established at all, so a
  // message only ever reaches a socket that named its session.
  //
  // Answering "who may see this" needs the DB, and this function is synchronous
  // and holds no handle (see emitAgentStatus above for the same constraint), so
  // these rows leave through an async lane instead.
  const privateRows = table === 'chat_sessions' ? rowList.filter(isPrivateSessionRow) : [];
  const openRows = privateRows.length > 0 ? rowList.filter((row) => !isPrivateSessionRow(row)) : rowList;

  const deliver = (ws, row) => {
   const outRow = sanitizeRealtimeRow(table, row);
   sendWs(ws, {
    type: 'db_changes',
    schema: 'public',
    table,
    payload: eventType === 'DELETE'
     ? { eventType, new: {}, old: outRow }
     : { eventType, new: outRow, old: {} },
   });
  };

  for (const ws of websocketClients) {
   const subscriptions = ws.subscriptions || [];
   for (const subscription of subscriptions) {
    if (subscription.type !== 'db_changes') continue;
    if (subscription.table && subscription.table !== table) continue;
    if (subscription.schema && subscription.schema !== 'public') continue;
    if (subscription.event && subscription.event !== '*' && subscription.event !== eventType) continue;

    for (const row of openRows) {
     if (!matchesFilter(subscription.filter, row)) continue;
     deliver(ws, row);
    }
   }
  }

  if (privateRows.length > 0) void fanoutPrivateSessionRows(privateRows, eventType, deliver);
 }

 /**
  * Fan private `chat_sessions` rows out to their members only.
  *
  * ONE membership query per row rather than one per (row, socket): a private
  * session changes rarely compared with the message traffic this loop normally
  * carries, so the cost lands where it is cheapest.
  *
  * Silence on failure is deliberate and is the fail-CLOSED direction: a member
  * who misses a live update sees it on their next load, whereas guessing
  * "deliver anyway" would publish the thing this exists to withhold.
  */
 async function fanoutPrivateSessionRows(rows, eventType, deliver) {
  for (const row of rows) {
   let allowed;
   try {
    allowed = await sessionMemberUserIds(row.id);
   } catch (error) {
    console.error('private session fanout membership lookup failed', error?.message || error);
    continue;
   }
   if (!allowed || allowed.size === 0) continue;
   for (const ws of websocketClients) {
    if (!ws.userId || !allowed.has(String(ws.userId))) continue;
    for (const subscription of ws.subscriptions || []) {
     if (subscription.type !== 'db_changes') continue;
     if (subscription.table && subscription.table !== 'chat_sessions') continue;
     if (subscription.schema && subscription.schema !== 'public') continue;
     if (subscription.event && subscription.event !== '*' && subscription.event !== eventType) continue;
     if (!matchesFilter(subscription.filter, row)) continue;
     deliver(ws, row);
    }
   }
  }
 }

 function relayBroadcast(channel, event, payload) {
  relayBroadcastToUserIds(channel, event, payload, null);
 }

 function relayBroadcastToUserIds(channel, event, payload, allowedUserIds) {
  for (const ws of websocketClients) {
   if (allowedUserIds && (!ws.userId || !allowedUserIds.has(String(ws.userId)))) continue;
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
  const wss = new WebSocketServer({
   server,
   path: '/backend/ws',
   // The WS handshake needs no credentials — auth is a first-message frame (see
   // the 'connection' handler) — so until that frame arrives ANY anonymous
   // client is talking to us. ws defaults maxPayload to 100MB, and it buffers a
   // fragmented message until the final frame before this code sees anything, so
   // a handful of unauthenticated sockets each dribbling a 100MB message is
   // hundreds of megabytes of server memory that no route, rate limiter or auth
   // check ever gets a chance to refuse. ws closes the socket with 1009 when the
   // cap is exceeded, before allocating past it.
   //
   // 8MB is far above anything real: the largest legitimate frames on this
   // socket are microphone PCM (a few KB per frame) and agent job results, and
   // file uploads go over HTTP, not here.
   maxPayload: 8 * 1024 * 1024,
  });

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
    // Both auth paths AWAIT the token verification (a DB round-trip). A socket
    // that drops during that await has already fired 'close' — and 'close' is
    // what removes a socket from this Set. Adding it afterwards puts a DEAD
    // socket in the fanout set with nothing left to take it out again, so it
    // stays for the process's lifetime holding its subscriptions and agentAuth.
    // sendWs's readyState check makes each one harmless individually; the cost
    // is that every notifyDbSubscribers walks them forever, so a flaky client
    // reconnecting all day is an unbounded leak on the hottest loop we have.
    if (ws.readyState !== 0 && ws.readyState !== 1) {
     settleAuth(false);
     return;
    }
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
      const bindingKey = JSON.stringify(binding);
      const exists = (ws.subscriptions || []).some((subscription) => JSON.stringify(subscription) === bindingKey);
      if (!exists) {
       // Cap it. Every entry here is walked for EVERY row of EVERY broadcast on
       // this socket, so the list is a multiplier on the hottest loop in the
       // server — and nothing else bounds it: a client that subscribes with a
       // slightly different filter each time grows it without ever repeating.
       // The real UI opens well under 50 (one per hook per scope); a client that
       // wants more is malfunctioning, and telling it so beats quietly degrading
       // every other socket's fanout.
       if (ws.subscriptions.length >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
        sendWs(ws, {
         type: 'error',
         code: 'subscription_limit',
         message: `This connection is already at its limit of ${MAX_SUBSCRIPTIONS_PER_SOCKET} realtime subscriptions`,
        });
        return;
       }
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
     // The daemon lane's inbound: a WhatsApp/Signal/OpenClaw message the daemon
     // received on the user's machine, relayed up the socket it already holds.
     // Scoped to the connection that sent it (handleBridgeInbound re-checks the
     // bridge belongs to this connection), so one daemon cannot post into
     // another workspace's bridged channel.
     if (message.action === 'bridge_inbound' || message.action === 'bridge_status') {
      await handleBridgeMessage(ws, message);
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

 // Test seam: how many sockets the fanout would walk. The only way to observe
 // the leak this guards — a socket that closed mid-authentication and was added
 // afterwards is invisible from the outside, because sendWs skips it silently
 // and it simply makes every broadcast a little slower forever.
 function websocketClientCount() {
  return websocketClients.size;
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
  websocketClientCount,
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  sweepLiveness,
  LIVENESS_MAX_MISSED_PONGS,
  LIVENESS_PING_INTERVAL_MS,
  // Exported for __test in index.cjs: the channel-name parser the realtime
  // authorization tests assert directly.
  workspaceIdFromRealtimeChannel,
  reset,
 };
}

module.exports = { createRealtime };
