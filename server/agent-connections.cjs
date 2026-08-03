'use strict';

const crypto = require('crypto');

// Both pure and dependency-free, so they are required directly rather than
// threaded through `deps` like the rest of this factory's collaborators: there
// is no cycle to break and no test that wants to substitute them.
const { applyToolSharing, sharingGate } = require('../shared/agentSharing.cjs');
const { normalizeAgentDocuments } = require('./document-library.cjs');

// Agent daemon connections: who is attached right now, and everything that
// happens when that changes.
//
// Wave 4 of the server/index.cjs reduction. Owns TWO maps:
//
//   connectedAgents   — connectionId -> live entry. resetTestState() clears it,
//                       so reset() below does exactly that and index.cjs
//                       delegates. Two test seams (registerTestConnectedAgent,
//                       listTestConnectedAgents) come with it: a test asserting
//                       the one-live-daemon-per-agent invariant has to be able
//                       to count entries, not just ask whether dispatch found one.
//   mcpAgentPresence  — agentId -> last-seen ms, for external MCP runtimes that
//                       have no socket. resetTestState() did NOT clear this and
//                       reset() does not either: matching the original exactly
//                       matters more here than tidying, because a presence TTL
//                       that starts empty vs. warm changes which branch a test
//                       takes. Worth revisiting deliberately, not in a move.
//
// ONE LIVE DAEMON PER AGENT is the invariant registerAgentConnection enforces:
// registering supersedes an older live connection rather than joining it, so a
// dispatch can never be delivered to a stale process that will not answer.

function createAgentConnections(deps = {}) {
 const {
  agentRuntimePayload,
  applyIdentityDeclaration,
  bindDbParam,
  drainAgentTaskQueue,
  expireConnectionPermissionRequests,
  failConnectionJobs,
  finalizeStuckJob,
  forbidden,
  getDb,
  inferenceBroker,
  isAgentEnabled,
  logConnectionActivity,
  normalizeSkillDocuments,
  notifyDbSubscribers,
  parseJsonObject,
  publicAgentConnection,
  publicFarmEnrolledAgent,
  rehomePendingPermissionRequests,
  rehomeRunningJobs,
  replayPermissionDecisions,
  quoteIdent,
  reachFromMessage,
  repairStoredIdentity,
  resumeDaemonBridges,
  sendWs,
  sharedModelsFromMessage,
  slugHandle,
 } = deps;

 // Owned here — see the header.
 const connectedAgents = new Map();
 const mcpAgentPresence = new Map(); // agentId -> last-seen ms

 const MCP_PRESENCE_TTL_MS = 40_000;

 function touchMcpPresence(agentId) {
  if (agentId) mcpAgentPresence.set(String(agentId), Date.now());
 }

 function hasMcpPresence(agentId) {
  const seen = mcpAgentPresence.get(String(agentId));
  return Boolean(seen && (Date.now() - seen) < MCP_PRESENCE_TTL_MS);
 }

 // Close-frame text per disconnect reason. The daemon logs BOTH this and the
 // `agent_disabled` reason it receives first, so an operator whose daemon was
 // dropped can see WHY in its own log instead of debugging a phantom network
 // fault. Keep these strings stable — the released daemon pattern-matches
 // 'Agent deactivated' on the close frame as its independent stop signal.
 //
 // The 'superseded' text deliberately does NOT match that pattern: what stops a
 // superseded daemon is the `agent_disabled` message, which the daemon treats as
 // terminal (agensis-cli: message 'agent_disabled' -> stop(), no reconnect). Do
 // not drop that send in favour of the close alone — the close frame's own text
 // would then have to lie about the reason to be terminal.
 const AGENT_DISCONNECT_CLOSE_MESSAGES = {
  deactivated: 'Agent deactivated',
  disconnected: 'Agent disconnected',
  superseded: 'Replaced by a newer connection for this agent',
  runtime_mismatch: 'Agent execution runtime changed; reconnect with the new command',
 };

 // Phase 1 of a daemon disconnect: take this agent's live connections OUT of the
 // map, synchronously, and hand them back for cleanup.
 //
 // Split from the cleanup so a caller that is about to claim the agent's slot
 // (registerAgentConnection) can do take → set with NO await in between. Two
 // registers racing inside the same tick therefore still leave exactly ONE live
 // entry: whichever set() runs last, and the other side is told why.
 //
 // Every stale entry for the agent is taken, INCLUDING one belonging to `keepWs`
 // (a socket that re-registers replaces its own earlier connection row — leaving
 // that entry behind would create exactly the duplicate this is here to prevent).
 // `keepWs` only decides whether the SOCKET is closed; see closeTakenAgentDaemons.
 function takeAgentDaemonConnections(agentId, workspaceId, keepWs = null) {
  const taken = [];
  for (const [connectionId, entry] of [...connectedAgents.entries()]) {
   if (String(entry.agentId) !== String(agentId)) continue;
   if (String(entry.workspaceId) !== String(workspaceId)) continue;
   connectedAgents.delete(connectionId);
   taken.push({ ...entry, keepSocket: Boolean(keepWs) && entry.ws === keepWs });
  }
  return taken;
 }

 // Phase 2: tell each taken connection why it is going, then run the normal
 // offline bookkeeping (fail its in-flight jobs, settle its row).
 //
 // A connection marked `keepSocket` is the registering socket's own previous
 // registration: its row is retired, but the socket itself is NOT closed and is
 // told nothing — a daemon must never be able to disconnect itself by declaring
 // who it is a second time.
 async function closeTakenAgentDaemons(taken, reason) {
  if (taken.length === 0) return taken;
  const closeMessage = AGENT_DISCONNECT_CLOSE_MESSAGES[reason] || AGENT_DISCONNECT_CLOSE_MESSAGES.deactivated;
  const disabledReason = reason === 'runtime_mismatch'
   ? 'Agent execution runtime changed; reconnect the Relay host with its new connection command (desktop local runtime or CLI).'
   : reason;
  for (const entry of taken) {
   if (entry.keepSocket) continue;
   sendWs(entry.ws, { type: 'agent_disabled', reason: disabledReason, code: reason === 'runtime_mismatch' ? reason : undefined });
   try { entry.ws.close(1008, closeMessage); } catch { /* already closing */ }
  }
  // A DELIBERATE eviction, not a socket that merely dropped: every reason routed
  // here (superseded, deactivated, runtime_mismatch) has just told that daemon to
  // stop, and a released daemon treats it as terminal. Its jobs can never report
  // back, so they fail now rather than sitting through the reconnect grace window.
  //
  // Permission requests are the one exception, and only under 'superseded': that
  // reason means the SAME agent just registered a newer socket, which is what a
  // half-open drop (laptop sleep, dead tunnel) looks like from here — the daemon
  // holding those parked calls is very likely the one registering. So they are
  // left alone for registerAgentConnection to re-home or expire a few lines
  // later; it runs after this and knows which ones the daemon still holds.
  const supersede = reason === 'superseded';
  for (const entry of taken) {
   await markConnectionOffline(entry.connectionId, { evicted: true, keepPermissionRequests: supersede });
  }
  // A superseded connection is not merely offline, it has been REPLACED, so its
  // row goes now instead of sitting in the roster as a second copy of the same
  // agent until pruneOfflineConnections catches up 120s later. The other reasons
  // keep their existing behaviour (row stays, offline, and prunes on its own).
  if (reason === 'superseded') {
   try {
    const rows = await getDb().unsafe(
     `delete from agent_connections where id = any($1::uuid[]) returning *`,
     [taken.map((entry) => entry.connectionId)],
    );
    if (rows.length > 0) notifyDbSubscribers('agent_connections', 'DELETE', rows.map(publicAgentConnection));
   } catch {
    // best effort — pruneOfflineConnections is the backstop
   }
  }
  return taken;
 }

 async function disconnectAgentDaemons(agentId, workspaceId, reason = 'deactivated') {
  return closeTakenAgentDaemons(takeAgentDaemonConnections(agentId, workspaceId), reason);
 }

 async function disableFarmIntegrationAgents(workspaceId, integrationId) {
  const rows = await getDb().unsafe(
   `update workspace_agents
         set enabled = false, connect_token_hash = '', updated_at = now()
       where workspace_id = $1 and metadata->>'farmIntegrationId' = $2
       returning *`,
   [String(workspaceId), String(integrationId)],
  );
  if (rows.length > 0) notifyDbSubscribers('workspace_agents', 'UPDATE', rows.map(publicFarmEnrolledAgent));
  for (const agent of rows) await disconnectAgentDaemons(agent.id, workspaceId);
  return rows;
 }

 function findConnectedAgent(workspaceId, agentId, handle) {
  const wantedHandle = slugHandle(handle);
  for (const entry of connectedAgents.values()) {
   if (entry.workspaceId !== workspaceId) continue;
   if (entry.ws?.readyState !== 1) continue;
   if (agentId && entry.agentId === agentId) return entry;
   if (wantedHandle && slugHandle(entry.handle) === wantedHandle) return entry;
  }
  return null;
 }

 // Badge-only liveness check. A connection is "really" reachable only if its socket
 // is OPEN *and* answered the last heartbeat ping (isAlive). This is deliberately
 // MORE pessimistic than findConnectedAgent (which gates dispatch on readyState
 // alone): a healthy socket sits isAlive===false for the few ms between ping-sent
 // and pong, so gating dispatch on it would manufacture false "no daemon" replies.
 // For the badge that momentary flicker is harmless and self-corrects on next read,
 // while catching a half-open socket a full interval before 'close' fires.
 // Single-process only — consistent with reconcileAgentConnectionsAtStartup, which
 // already assumes one backend owns the connectedAgents map.
 function isConnectionSocketLive(connectionId) {
  const entry = connectedAgents.get(connectionId);
  return Boolean(entry && entry.ws?.readyState === 1 && entry.ws.isAlive !== false);
 }

 // Whether a connection's socket is still OPEN (readyState only, deliberately NOT the
 // pessimistic isAlive pong flag). Used by the burst-job guard to decide if a daemon
 // job's worker still exists. Mirroring findConnectedAgent's readyState-only gate keeps
 // the guard and dispatch in agreement: if the guard says "phantom, don't block", the
 // same connection wouldn't count as dispatchable either — so no duplicate turn can
 // slip through the brief ping/pong window. Single-process, like the connection map.
 function isConnectionSocketOpen(connectionId) {
  const entry = connectedAgents.get(connectionId);
  return Boolean(entry && entry.ws?.readyState === 1);
 }

 // Push a frame to a daemon addressed by CONNECTION ID rather than by agent.
 // Channel bridges need this: a bridge is pinned to the machine that holds the
 // WhatsApp/Signal keys, so "whichever daemon is serving this agent" — which is
 // what findConnectedAgent answers — is the wrong question. Returns false rather
 // than throwing when the socket is gone; the caller decides what a miss means.
 function sendToConnection(connectionId, payload) {
  const entry = connectedAgents.get(connectionId);
  if (!entry?.ws) return false;
  return sendWs(entry.ws, payload);
 }

 function refreshConnectedAgentConfigs(eventType, rows) {
  if (!['INSERT', 'UPDATE'].includes(eventType)) return;
  for (const row of rows || []) {
   if (!isAgentEnabled(row)) {
    void disconnectAgentDaemons(row.id, row.workspace_id);
    continue;
   }
   const agent = agentRuntimePayload(row);
   if (!agent?.id || !agent.workspace_id) continue;
   const expectedRuntime = configuredExecutionRuntime(agent);
   for (const entry of connectedAgents.values()) {
    if (String(entry.agentId) !== String(agent.id)) continue;
    if (String(entry.workspaceId) !== String(agent.workspace_id)) continue;
    const connectedRuntime = normalizeExecutionRuntime(parseJsonObject(entry.metadata).executionRuntime);
    if (expectedRuntime && connectedRuntime !== expectedRuntime) {
     // Runtime is part of the execution boundary, not a hot-reloadable agent
     // preference. Remove the stale daemon from dispatch synchronously and make
     // it reconnect with the newly generated --runtime command. Without this,
     // changing a legacy agent from Claude to Codex could leave its old Claude
     // daemon online long enough to execute one job with the wrong runtime.
     void closeTakenAgentDaemons(
      takeAgentDaemonConnections(agent.id, agent.workspace_id),
      'runtime_mismatch',
     );
     break;
    }
    entry.handle = agent.handle;
    entry.name = agent.name;
    entry.agent = agent;
    if (entry.ws?.agentAuth) {
     entry.ws.agentAuth = {
      ...entry.ws.agentAuth,
      name: agent.name,
      handle: agent.handle,
      agent,
     };
    }
    sendWs(entry.ws, { type: 'agent_config', agent });
   }
  }
 }

 async function markAgentConnectionOffline(ws) {
  return markConnectionOffline(ws.agentConnectionId);
 }

 // How long a dropped connection's running jobs and parked permission requests are
 // held before they are given up on.
 //
 // A socket drop is not proof the work stopped. The daemon keeps executing the turn
 // and reconnects ~2s later; failing its jobs on the spot threw away turns that were
 // minutes deep and about to deliver an answer. The daemon re-sends the result on its
 // new socket (handleAgentJobResult matches on agent+job, not connection), and
 // registerAgentConnection re-homes anything still running — so by the time this
 // fires, a job still marked running on a dead connection really is orphaned.
 const JOB_RECONNECT_GRACE_MS = 45_000;
 // connectionId -> { timer, agentKey }. Kept so a reconnect can cancel the pending
 // failure for the same agent instead of racing it.
 const pendingJobFailures = new Map();

 // Returns the connection ids whose cleanup was cancelled, because the caller then
 // owns them: a registration that cancels this timer has taken responsibility for
 // deciding what on those dead connections survives and what does not.
 function cancelPendingJobFailures(agentKey) {
  const cancelled = [];
  if (!agentKey) return cancelled;
  for (const [connectionId, pending] of pendingJobFailures) {
   if (pending.agentKey !== agentKey) continue;
   clearTimeout(pending.timer);
   pendingJobFailures.delete(connectionId);
   cancelled.push(connectionId);
  }
  return cancelled;
 }

 // Arm the grace-window cleanup for a connection that just dropped: fail what it
 // was running, and expire what it had parked awaiting a human.
 //
 // Permission requests ride this timer instead of being expired inline on close,
 // because close fires BEFORE the reconnect registers — so an inline expiry
 // guaranteed there was nothing left to re-home by the time the daemon was back.
 // Observed live: a request raised at 07:42:30 with a ten-minute TTL was dead at
 // 07:43:59 with eight minutes still on it, purely because the socket blipped.
 //
 // They are NOT simply left to their own TTL. A daemon that never returns must
 // stop offering the human a button reasonably promptly, and 45s is already this
 // file's answer to "was that a blip?". A click inside the window is safe either
 // way: deliverDecision only ever sends to the exact connection on the row, that
 // id is no longer in connectedAgents, so the decision is refused with the
 // existing 409 rather than being recorded against a daemon that cannot act.
 function scheduleConnectionJobFailure(connectionId, agentKey) {
  const existing = pendingJobFailures.get(connectionId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
   pendingJobFailures.delete(connectionId);
   void failConnectionJobs(connectionId, 'the daemon disconnected');
   void expireConnectionPermissionRequests(connectionId);
  }, JOB_RECONNECT_GRACE_MS);
  timer.unref?.();
  pendingJobFailures.set(connectionId, { timer, agentKey });
 }

 // Test/teardown hook: drop every armed grace timer so a suite does not leak them.
 function clearPendingJobFailures() {
  for (const pending of pendingJobFailures.values()) clearTimeout(pending.timer);
  pendingJobFailures.clear();
 }

 // Settle ONE connection id: drop it from the live map, fail what it was running,
 // flip its row offline. Takes the id rather than the socket because a socket that
 // re-registers already points at its NEW connection id — deriving the id from the
 // socket there would offline the wrong (live) row and fail the wrong jobs.
 async function markConnectionOffline(connectionId, { evicted = false, keepPermissionRequests = false } = {}) {
  if (!connectionId) return;
  const entry = connectedAgents.get(connectionId);
  const agentKey = entry ? `${entry.workspaceId}:${entry.agentId}` : null;
  connectedAgents.delete(connectionId);
  inferenceBroker.failConnection(connectionId, 'The inference agent connection disconnected.');
  if (evicted) {
   // Told to stop: nothing is coming back, so don't make the human wait out the
   // grace window for an answer that cannot arrive.
   void failConnectionJobs(connectionId, 'the daemon disconnected');
   // `keepPermissionRequests` is the SUPERSEDE case only: a registration is in
   // flight for this same agent right now, and it is about to re-home whatever
   // that daemon re-asserted and expire the rest. Expiring here would run first
   // and there would be nothing left for it to save. Every other eviction
   // (deactivated, runtime_mismatch) really is terminal, so it expires now.
   if (!keepPermissionRequests) void expireConnectionPermissionRequests(connectionId);
  } else {
   // An unexplained socket loss is NOT proof the work stopped — see
   // JOB_RECONNECT_GRACE_MS. A daemon that reconnects inside the window keeps its
   // turn; one that doesn't gets the same explicit failure it always did, 45s later.
   // The parked permission requests are on that same timer, for the same reason.
   scheduleConnectionJobFailure(connectionId, agentKey);
  }
  try {
   const rows = await getDb().unsafe(
    `update agent_connections
        set status = 'offline', updated_at = now(), last_seen_at = now()
        where id = $1
        returning *`,
    [connectionId],
   );
   notifyDbSubscribers('agent_connections', 'UPDATE', rows.map(publicAgentConnection));
   if (rows.length > 0) void logConnectionActivity(rows[0], 'agent_disconnected');
  } catch {
   // best effort during socket close
  }
 }

 // On a fresh process there are no live sockets, so any agent_connections row still
 // marked online/busy is stale — left behind when a previous process restarted,
 // crashed, or was redeployed. Reset them so the UI doesn't report agents as
 // connected when they aren't. Best-effort: a brand-new DB may not have the table
 // yet (in which case there are no connections to reconcile anyway).
 async function reconcileAgentConnectionsAtStartup() {
  try {
   const rows = await getDb().unsafe(
    `update agent_connections set status = 'offline', updated_at = now()
        where status <> 'offline'
        returning *`,
   );
   if (rows.length > 0) {
    console.log(`[backend] reset ${rows.length} stale agent connection(s) to offline on startup`);
    notifyDbSubscribers('agent_connections', 'UPDATE', rows.map(publicAgentConnection));
   }
   const stuckJobs = await getDb().unsafe(`select * from agent_jobs where status = 'running'`);
   for (const job of stuckJobs) await finalizeStuckJob(job, 'the backend restarted');
   if (stuckJobs.length > 0) console.log(`[backend] finalized ${stuckJobs.length} orphaned running job(s) on startup`);

   // A restart mid-job must not strand that agent's queue forever. finalizeStuckJob
   // already drains, but do it explicitly here too so startup is ordered and
   // logged, and so a job whose row was already finalized still gets a drain.
   //
   // Deliberately scoped to agents that were ACTUALLY mid-job at the restart — NOT
   // a blanket sweep of every 'todo' task with an agent assignee. A blanket sweep
   // would wake every stale assigned task in the workspace on every deploy, which
   // is a token bill nobody asked for.
   const restartedPairs = new Map();
   for (const job of stuckJobs) {
    if (!job.workspace_id || !job.agent_id) continue;
    restartedPairs.set(`${job.workspace_id}:${job.agent_id}`, job);
   }
   for (const job of restartedPairs.values()) {
    await drainAgentTaskQueue({ workspaceId: job.workspace_id, agentId: job.agent_id, cause: 'backend_restart' })
     .catch((error) => console.error('drainAgentTaskQueue (startup) failed', error));
   }
  } catch (error) {
   console.warn('[backend] startup agent-connection reconcile skipped:', error.message || error);
  }
 }

 // Auto-cleanup: remove offline connection rows dead for a while, so the daemon
 // "Other connections" list self-prunes instead of piling up stale entries.
 async function pruneOfflineConnections() {
  // In-memory first, and unconditionally: it must not be skipped by the DB
  // statement below throwing into the catch.
  //
  // mcpAgentPresence is written by touchMcpPresence on every MCP call and read
  // by hasMcpPresence, which compares against MCP_PRESENCE_TTL_MS. That TTL
  // makes a stale entry harmless to READ but does nothing to remove it — there
  // was no delete on this Map anywhere, so every agent id that ever made one MCP
  // call stayed resident for the lifetime of the process. Bounded by the number
  // of distinct agents rather than by traffic, so it is a slow leak rather than
  // a runaway one, but it is one that only ever grows and it already has the
  // sweep it needs sitting right here.
  //
  // Expire on the same TTL the reader uses: anything hasMcpPresence would call
  // absent is exactly what there is no reason to keep.
  const presenceCutoff = Date.now() - MCP_PRESENCE_TTL_MS;
  for (const [agentId, seenAt] of mcpAgentPresence) {
   if (seenAt < presenceCutoff) mcpAgentPresence.delete(agentId);
  }
  try {
   const rows = await getDb().unsafe(
    `delete from agent_connections where status = 'offline' and last_seen_at < now() - interval '120 seconds' returning *`,
   );
   if (rows.length > 0) notifyDbSubscribers('agent_connections', 'DELETE', rows.map(publicAgentConnection));
  } catch {
   // best effort
  }
 }

 // Columns applyIdentityDeclaration compares a declaration against. Keep in step
 // with IDENTITY_COLUMNS in shared/agentIdentity.cjs — a field missing here reads
 // as empty, so the declaration always looks like a change and rewrites the row
 // on every reconnect.
 const AGENT_IDENTITY_SELECT = 'select id, name, avatar, accent_color, description, soul, identity, run_mode, metadata, enabled, version from workspace_agents where id = $1 and workspace_id = $2 limit 1';

 const SUPPORTED_EXECUTION_RUNTIMES = new Set(['claude', 'codex', 'amp']);

 function normalizeExecutionRuntime(value) {
  const runtime = String(value || '').trim().toLowerCase();
  return SUPPORTED_EXECUTION_RUNTIMES.has(runtime) ? runtime : '';
 }

 function configuredExecutionRuntime(agent) {
  return normalizeExecutionRuntime(parseJsonObject(agent?.metadata).runtime);
 }

 function assertMatchingExecutionRuntime(agent, connectionMetadata) {
  const expected = configuredExecutionRuntime(agent);
  if (!expected) return;
  const actual = normalizeExecutionRuntime(parseJsonObject(connectionMetadata).executionRuntime);
  if (actual === expected) return;
  const detail = actual
   ? `declared ${actual}`
   : 'did not declare an execution runtime';
  const error = forbidden(`Agent requires the ${expected} runtime, but this daemon ${detail}`);
  error.code = 'runtime_mismatch';
  throw error;
 }

 // How many times a declaration re-reads and retries after losing a write race.
 // Losing three in a row means a human is actively editing the row this second;
 // give way — the next reconnect declares again anyway.
 const AGENT_IDENTITY_WRITE_ATTEMPTS = 3;

 /**
  * Apply an agent's self-declared identity to its row — THE one server-side path
  * for it. Both the daemon (agent_register) and MCP (register_agent) land here,
  * so the precedence rule in shared/agentIdentity.cjs is enforced once rather
  * than in two places that will drift.
  *
  * Writes nothing when the declaration matches what is stored or is entirely
  * locked by a human's choices — an agent that reconnects on a loop must not
  * produce an UPDATE and a realtime fanout on every loop.
  *
  * CONCURRENCY: read → merge-in-JS → write races a human edit landing between
  * the two. An unconditional UPDATE would rewrite the whole identity jsonb from
  * the stale read — destroying the human's value AND the human_set flag that was
  * just written to protect it. So the UPDATE is guarded on the `version` the
  * merge was computed from (workspace_agents is a VERSIONED_TABLE — every writer
  * bumps it), and a lost race re-reads and re-merges, so a field the human
  * locked mid-race is honoured on the retry rather than clobbered.
  */
 async function applyAgentIdentity({ workspaceId, agentId, row, declared, isNew = false }) {
  let current = row;
  for (let attempt = 0; attempt < AGENT_IDENTITY_WRITE_ATTEMPTS; attempt += 1) {
   if (!current) {
    const fresh = await getDb().unsafe(AGENT_IDENTITY_SELECT, [agentId, workspaceId]);
    current = fresh[0];
    if (!current) return null;
   }
   const result = applyIdentityDeclaration({ current, declared, isNew });
   if (!result.changed) return null;

   const params = [];
   const setParts = [];
   for (const [column, value] of Object.entries(result.columns)) {
    setParts.push(`${quoteIdent(column)} = ${bindDbParam(params, 'workspace_agents', column, value)}`);
   }
   if (result.identity) {
    setParts.push(`"identity" = ${bindDbParam(params, 'workspace_agents', 'identity', result.identity)}`);
   }
   // workspace_agents is a VERSIONED_TABLE; the generic write path bumps version
   // on every update and the offline-write reconciler relies on it moving.
   setParts.push('"version" = COALESCE("version", 0) + 1', 'updated_at = now()');
   params.push(agentId, workspaceId, Number(current.version ?? 0));

   const rows = await getDb().unsafe(
    `update workspace_agents set ${setParts.join(', ')}
       where id = $${params.length - 2} and workspace_id = $${params.length - 1}
         and COALESCE("version", 0) = $${params.length}
       returning *`,
    params,
   );
   if (rows.length > 0) {
    notifyDbSubscribers('workspace_agents', 'UPDATE', rows);
    return rows[0];
   }
   // Someone else wrote the row after our read. Drop the stale snapshot and
   // recompute against what they actually wrote.
   current = null;
  }
  return null;
 }

 /**
  * Boot-time repair for identity rows corrupted by the double-encoded jsonb
  * bind (see normalizeJsonParam): `identity` stored as a jsonb string scalar,
  * or `identity.human_set` degraded into an array by `||` against a scalar
  * patch. Those rows are not just cosmetically wrong — jsonb_set on a scalar
  * ERRORS, so a corrupted row is one a human can no longer edit at all. Runs
  * once per boot after the schema gate; the WHERE selects only diseased rows,
  * so a healthy database does zero writes.
  */
 async function repairCorruptedAgentIdentities() {
  const rows = await getDb().unsafe(
   `select id, workspace_id, identity from workspace_agents
      where jsonb_typeof(identity) is distinct from 'object'
         or (identity ? 'human_set' and jsonb_typeof(identity->'human_set') is distinct from 'object')
         or (identity ? 'voice' and jsonb_typeof(identity->'voice') is distinct from 'object')`,
  );
  for (const row of rows) {
   const repaired = repairStoredIdentity(row.identity) ?? {};
   await getDb().unsafe(
    `update workspace_agents
       set identity = $1::jsonb, "version" = COALESCE("version", 0) + 1, updated_at = now()
       where id = $2 and workspace_id = $3`,
    [repaired, row.id, row.workspace_id],
   );
  }
  if (rows.length > 0) {
   console.log(`[agensis] repaired ${rows.length} corrupted workspace_agents.identity row(s)`);
  }
  return rows.length;
 }

 async function registerAgentConnection(ws, message) {
  const auth = ws.agentAuth;
  if (!auth) throw forbidden('Agent token is required');
  const workspaceId = String(message.workspaceId || auth.workspaceId || '');
  const agentId = String(message.agentId || auth.agentId || '');
  if (workspaceId !== auth.workspaceId || agentId !== auth.agentId) {
   throw forbidden('Agent token does not match this workspace');
  }
  const agentRows = await getDb().unsafe(AGENT_IDENTITY_SELECT, [agentId, workspaceId]);
  if (!isAgentEnabled(agentRows[0])) throw forbidden('Agent is deactivated');
  const metadata = parseJsonObject(message.metadata);
  assertMatchingExecutionRuntime(agentRows[0], metadata);
  // The agent declares who it is on every connect; a human's explicit change
  // survives it. Best effort on purpose — a rejected avatar must never be the
  // reason a daemon cannot come online.
  try {
   await applyAgentIdentity({ workspaceId, agentId, row: agentRows[0], declared: message.identity });
  } catch (error) {
   console.error('[agensis] agent identity declaration failed:', error.message || error);
  }
  const handle = slugHandle(message.handle || auth.handle || auth.name);
  const name = String(message.name || auth.name || handle).trim() || handle;
  const host = String(message.host || '').slice(0, 180);
  const cwd = String(message.cwd || '').slice(0, 500);
  const connectionId = crypto.randomUUID();

  // Drop this agent's dead (offline) rows up front so a reconnect replaces them
  // rather than stacking another stale entry in the UI.
  try {
   const stale = await getDb().unsafe(
    `delete from agent_connections where workspace_id = $1 and agent_id = $2 and status = 'offline' returning *`,
    [workspaceId, agentId],
   );
   if (stale.length > 0) notifyDbSubscribers('agent_connections', 'DELETE', stale.map(publicAgentConnection));
  } catch {
   // best effort
  }
  const rows = await getDb().unsafe(
   `insert into agent_connections (id, workspace_id, agent_id, name, handle, host, cwd, status, metadata, connected_at, last_seen_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, 'online', $8::jsonb, now(), now(), now())
      returning *`,
   [connectionId, workspaceId, agentId, name, handle, host, cwd, metadata],
  );
  // Identity reconciliation and stale-row cleanup above both await. The agent's
  // selected runtime can change while those operations are in flight, so the
  // declaration we validated at the start of registration may no longer match.
  // Re-read after creating the row but BEFORE publishing it into the in-memory
  // dispatch map. There is deliberately no await between this final validation
  // and connectedAgents.set below, so a same-process config update cannot slip
  // between the check and publication.
  const finalAgentRows = await getDb().unsafe(AGENT_IDENTITY_SELECT, [agentId, workspaceId]);
  try {
   if (!isAgentEnabled(finalAgentRows[0])) throw forbidden('Agent is deactivated');
   assertMatchingExecutionRuntime(finalAgentRows[0], metadata);
  } catch (error) {
   try {
    await getDb().unsafe('delete from agent_connections where id = $1 returning *', [connectionId]);
   } catch {
    // Best effort: the rejected row was never published as live and normal
    // offline pruning remains the cleanup backstop.
   }
   throw error;
  }
  const connection = publicAgentConnection(rows[0]);
  ws.agentConnectionId = connectionId;
  ws.agentId = agentId;
  ws.workspaceId = workspaceId;
  // ONE live daemon per agent. Registering supersedes any older live connection
  // for the same agent: newest wins, deterministically.
  //
  // Why newest rather than keeping the incumbent and refusing this register: a
  // daemon that dropped through a HALF-OPEN socket (laptop sleep, dead tunnel)
  // reconnects on a new socket while the server still holds the zombie for up to
  // ~2x LIVENESS_PING_INTERVAL_MS. Refusing would leave that daemon offline for
  // the whole window while it retried every 2s. The newest socket is by
  // definition the one the daemon itself believes in, so it takes over.
  //
  // Why this converges instead of thrashing: the loser is sent `agent_disabled`,
  // which every released daemon treats as TERMINAL — it logs the reason and
  // stops; it does not reconnect. So two daemons genuinely configured for the
  // same agent settle on the last one to register rather than flapping every
  // retry interval. (A daemon under a process supervisor that restarts it will
  // win the slot back on restart; that is the supervisor's cadence, not a loop
  // this server can damp further.)
  //
  // take → set with NO await between them, so two registers racing inside one
  // tick still leave exactly one live entry.
  const superseded = takeAgentDaemonConnections(agentId, workspaceId, ws);
  connectedAgents.set(connectionId, { ws, connectionId, workspaceId, agentId, handle, name, host, cwd, metadata, agent: auth.agent });
  notifyDbSubscribers('agent_connections', 'INSERT', [connection]);
  if (superseded.length > 0) {
   // Name the loser AND the winner: an operator reading this needs to know which
   // of two machines lost its daemon, not just that something was dropped.
   for (const entry of superseded) {
    if (entry.keepSocket) continue;
    console.log(`[agensis] superseded daemon connection ${entry.connectionId} for @${handle} on ${entry.host || 'unknown host'}:${entry.cwd || '?'} — replaced by a newer register from ${host || 'unknown host'}:${cwd || '?'}`);
   }
   await closeTakenAgentDaemons(superseded, 'superseded');
  }
  // This register may be a RECONNECT after a blip, with a turn still executing on
  // the daemon. Cancel the grace-window failure armed when the old socket dropped,
  // and point those still-running rows at the connection that now exists. Order
  // matters: cancel first, so the timer cannot fire between the re-home and the
  // cancel and kill a job we just adopted.
  const cancelledConnectionIds = cancelPendingJobFailures(`${workspaceId}:${agentId}`);
  const readopted = await rehomeRunningJobs(workspaceId, agentId, connectionId);
  if (readopted.length > 0) {
   console.log(`[agensis] @${handle} reconnected with ${readopted.length} job(s) still running; kept them alive on connection ${connectionId}`);
  }
  // The same re-adoption for tool calls parked on a human's answer — but only the
  // ones this daemon says it is STILL parked on. `permissionRequestIds` is the
  // daemon's proof that the process holding those promises survived the blip;
  // "the agent reconnected" on its own is not, because a restarted daemon looks
  // identical here and would silently drop the decision after the UI recorded it.
  const resumedRequests = await rehomePendingPermissionRequests({
   workspaceId,
   agentId,
   connectionId,
   requestKeys: message.permissionRequestIds,
  });
  if (resumedRequests.length > 0) {
   console.log(`[agensis] @${handle} reconnected still parked on ${resumedRequests.length} permission request(s); moved them to connection ${connectionId}`);
  }
  // Everything left on the connections this reconnect just took over is
  // unanswerable and must stop looking like an open question. This runs AFTER the
  // re-home on purpose: the survivors already point at the live connection, so
  // they are no longer matched by these connection ids. That ordering is the
  // whole fix — expiring first is what left nothing to re-home.
  const staleConnectionIds = new Set([...cancelledConnectionIds, ...superseded.map((entry) => entry.connectionId)]);
  staleConnectionIds.delete(connectionId);
  for (const staleId of staleConnectionIds) void expireConnectionPermissionRequests(staleId);
  // A daemon restart loses every live provider socket it was holding — the
  // WhatsApp companion session, the signal-cli process, the OpenClaw client.
  // Nothing else would ever bring them back, so a reconnect re-homes this
  // workspace's daemon-lane bridges onto the new connection and starts them.
  if (resumeDaemonBridges) {
   void Promise.resolve(resumeDaemonBridges(workspaceId, connectionId))
    .then((started) => {
     if (started > 0) console.log(`[agensis] resumed ${started} channel bridge(s) on connection ${connectionId}`);
    })
    .catch((error) => console.error('resumeDaemonBridges failed', error));
  }
  void logConnectionActivity(connection, 'agent_connected');
  // Tell the daemon exactly which of its parked requests survived, so both sides
  // hold the same belief. A daemon that keeps parking on a request the server has
  // given up on would hold its turn open until its own 10-minute TTL for an answer
  // that can no longer arrive; naming the survivors lets it deny the rest at once.
  // Absent from an older server's reply, which every daemon must read as "none".
  const registeredSent = sendWs(ws, {
   type: 'agent_registered',
   connection,
   agent: auth.agent,
   resumedPermissionRequests: resumedRequests.map((row) => String(row.request_key || '')).filter(Boolean),
  });
  // Registration tells the broker which promises to keep BEFORE any phase
  // replay arrives. Preparing rows get PREPARE again; final rows get COMMIT.
  // The daemon named every key above, so a restarted process can never receive
  // a command for a promise it no longer holds.
  if (registeredSent && resumedRequests.length > 0) {
   const replayed = await replayPermissionDecisions(ws, resumedRequests);
   if (replayed > 0) {
    console.log(`[agensis] @${handle} replayed ${replayed} durable permission decision phase(s) after reconnect`);
   }
  }
 }

 // The "format we need" gate: stored capabilities must have the three array fields and a
 // string|null memoryRoot. A row that fails this (never synced, or malformed) is treated
 // as drifted so the heartbeat nudges a fresh snapshot to self-heal it.
 // `reach` (agent-mesh F2) is INTENTIONALLY excluded from this required-fields check —
 // older daemons, and reach-disabled ones, omit it. Requiring it would make
 // capabilitiesDriftNudges nudge agent_capabilities_refresh every beat forever.
 function capabilitiesShapeValid(caps) {
  return Boolean(caps)
   && Array.isArray(caps.skills)
   && Array.isArray(caps.clis)
   && Array.isArray(caps.mcpServers)
   && (caps.memoryRoot === null || typeof caps.memoryRoot === 'string');
 }

 function ampRuntimeFromMessage(value) {
  const amp = parseJsonObject(parseJsonObject(value).amp);
  if (amp.id !== 'amp') return null;
  const project = parseJsonObject(amp.project);
  return {
   id: 'amp',
   available: amp.available === true,
   version: String(amp.version || '').slice(0, 120),
   reason: amp.available === true ? null : String(amp.reason || 'amp_cli_crashed').slice(0, 100),
   project: amp.available === true && (project.id || project.name || project.repository)
    ? {
     id: String(project.id || '').slice(0, 160),
     name: String(project.name || '').slice(0, 200),
     repository: String(project.repository || '').slice(0, 500),
    }
    : null,
  };
 }

 function executionRuntimesFromMessage(value) {
  const input = parseJsonObject(value);
  const runtimes = {};
  for (const [id, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
   const runtime = parseJsonObject(input[id]);
   if (runtime.id !== id) continue;
   const available = runtime.available === true;
   runtimes[id] = {
    id,
    label,
    available,
    version: String(runtime.version || '').slice(0, 120),
    reason: available ? null : (runtime.reason ? String(runtime.reason).slice(0, 100) : null),
   };
  }
  const amp = ampRuntimeFromMessage(input);
  if (amp) runtimes.amp = { ...amp, label: 'Amp' };
  return runtimes;
 }

 // Pure drift decision, extracted so it can be unit-tested without a DB. Given the last
 // stored capabilities and the hashes the daemon just sent on its heartbeat, decide which
 // full-snapshot re-pushes to nudge. Rules:
 //  - Only act on a hash the daemon actually sent (older daemons omit them → no nudge).
 //  - Capabilities drift when the stored row is malformed OR its stored hash differs.
 //  - Memory drift when the stored memoryHash differs.
 //  - Skill-document drift when the stored skillsHash differs. capabilities.skills is a
 //    list of NAMES; the BODIES ride agent_skill_sync into agent_skill_documents, so they
 //    need their own hash — a daemon can edit a SKILL.md without the name list changing,
 //    and the capabilities hash would not move.
 //  - Document drift when the stored documentsHash differs. Third hash, same argument as
 //    the second: the markdown a daemon mirrors up (agent_document_sync ->
 //    agent_documents) is not described by either of the other two, and editing a README
 //    moves nothing else.
 // The stored reference only advances when a real snapshot lands, so a genuine mismatch
 // resolves in ~1 round-trip rather than looping every beat.
 function capabilitiesDriftNudges(stored, { capabilitiesHash, memoryHash, skillsHash, documentsHash } = {}) {
  const nudges = [];
  if (capabilitiesHash && (!capabilitiesShapeValid(stored) || capabilitiesHash !== stored.hash)) {
   nudges.push('agent_capabilities_refresh');
  }
  if (memoryHash && memoryHash !== (stored && stored.memoryHash)) {
   nudges.push('agent_memory_refresh');
  }
  if (skillsHash && skillsHash !== (stored && stored.skillsHash)) {
   nudges.push('agent_skills_refresh');
  }
  if (documentsHash && documentsHash !== (stored && stored.documentsHash)) {
   nudges.push('agent_documents_refresh');
  }
  return nudges;
 }

 /**
  * The sharing switches on one agent row, for the ingest gate.
  *
  * Read at PUSH time rather than cached on the connection, deliberately: a
  * person switching "share documents" off expects the next sync to stop, not
  * the next reconnect. A daemon syncs on a heartbeat cadence, so this is a
  * single indexed primary-key read against a row the process already touches
  * constantly.
  *
  * Fail-open on a missing row is not a decision this makes — `sharingGate`
  * normalizes `undefined` to all-shared, which is the same answer the column
  * default gives. The row only goes missing if the agent was deleted, and the
  * FK would have taken the mirror rows with it.
  */
 async function agentSharingRow(agentId) {
  const rows = await getDb().unsafe('select sharing from workspace_agents where id = $1 limit 1', [agentId]);
  return rows[0] || null;
 }

 /**
  * Refuse a withheld channel AND remove what that agent already mirrored.
  *
  * The prune is the half that matters. Refusing the push alone would freeze the
  * last snapshot in the workspace forever — every browse surface would keep
  * rendering the agent's files, with nothing to indicate they were no longer
  * being shared. "Stop sharing my memory" has to mean the memory leaves.
  *
  * Returns null when the channel is SHARED (the caller proceeds), or the rows it
  * deleted when the channel is withheld (the caller stops). The caller does its
  * own fanout with a LITERAL table name — see tests/realtime-fanout-allowlist:
  * a notifyDbSubscribers call whose table is a variable escapes the allowlist
  * check entirely, so this returns the rows rather than broadcasting them.
  */
 async function pruneWithheldMirror(agentRow, channel, { table, agentId }) {
  const { allowed } = sharingGate(agentRow, channel);
  if (allowed) return null;
  return getDb().unsafe(
   `delete from ${quoteIdent(table)} where agent_id = $1 returning *`,
   [agentId],
  );
 }

 async function updateAgentHeartbeat(ws, metadata = {}, hashes = {}) {
  const connectionId = ws.agentConnectionId;
  if (!connectionId) throw forbidden('Agent is not registered');
  const rows = await getDb().unsafe(
   `update agent_connections
      set status = $2, metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb, last_seen_at = now(), updated_at = now()
      where id = $1
      returning *`,
   [connectionId, metadata.busy ? 'busy' : 'online', metadata || {}],
  );
  notifyDbSubscribers('agent_connections', 'UPDATE', rows.map(publicAgentConnection));

  // Capability/memory drift check. The heartbeat carries the daemon's current hashes;
  // compare them against what we last stored on a snapshot (the update above leaves the
  // `capabilities` column untouched, so this reads the last synced reference). On a
  // mismatch — or malformed stored capabilities — nudge the daemon to re-push the full
  // snapshot. Guarded on hash presence so older daemons that don't send hashes never get
  // nudged. The stored reference only advances when the real snapshot lands, so a
  // mismatch resolves in ~1 round-trip rather than looping.
  if (rows.length > 0) {
   const stored = parseJsonObject(rows[0].capabilities);
   for (const nudge of capabilitiesDriftNudges(stored, hashes || {})) {
    sendWs(ws, { type: nudge });
   }
  }
 }

 // Ingest a full snapshot of an agent's file-memory palace pushed by its daemon.
 // Read-only mirror: UPSERT every file by the stable UNIQUE(agent_id, path) identity
 // (so comments anchored to (agent_id, path) stay attached), then prune rows for files
 // the daemon no longer reports. The daemon is the only writer — the browser path is
 // read-only (see DB_TABLE_ACCESS).
 async function handleAgentMemorySync(ws, message) {
  const auth = ws.agentAuth;
  if (!auth) throw forbidden('Agent token is required');
  const workspaceId = ws.workspaceId || auth.workspaceId;
  const agentId = ws.agentId || auth.agentId;
  if (!workspaceId || !agentId) throw forbidden('Agent is not registered');

  // The per-agent off switch (workspace_agents.sharing.memory). Withheld means
  // this push is dropped and whatever this agent mirrored earlier is removed —
  // see pruneWithheldMirror for why the removal is the load-bearing half.
  const withheldMemory = await pruneWithheldMirror(await agentSharingRow(agentId), 'memory', {
   table: 'agent_memory_files',
   agentId,
  });
  if (withheldMemory) {
   if (withheldMemory.length > 0) notifyDbSubscribers('agent_memory_files', 'DELETE', withheldMemory);
   return;
  }

  const incoming = Array.isArray(message.files) ? message.files : [];
  const db = getDb();
  const upserted = [];
  const keptPaths = [];
  for (const file of incoming) {
   const filePath = String(file?.path || '').slice(0, 1024);
   if (!filePath) continue;
   const kind = String(file?.kind || 'memory').slice(0, 40);
   const content = String(file?.content || '');
   const byteSize = Number.isFinite(file?.byteSize) ? Math.trunc(file.byteSize) : Buffer.byteLength(content);
   const summary = String(file?.summary || '').slice(0, 2000);
   keptPaths.push(filePath);
   const rows = await db.unsafe(
    `insert into agent_memory_files (workspace_id, agent_id, path, kind, summary, content_cache, byte_size, editable, last_synced, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, false, now(), now())
        on conflict (agent_id, path) do update set
          kind = excluded.kind,
          summary = excluded.summary,
          content_cache = excluded.content_cache,
          byte_size = excluded.byte_size,
          last_synced = now(),
          updated_at = now(),
          version = agent_memory_files.version + 1
        returning *`,
    [workspaceId, agentId, filePath, kind, summary, content, byteSize],
   );
   if (rows[0]) upserted.push(rows[0]);
  }

  // Prune rows for files the daemon no longer reports (comments survive — they key on
  // (agent_id, path), not a FK to these rows).
  const pruned = keptPaths.length > 0
   ? await db.unsafe(
    `delete from agent_memory_files where agent_id = $1 and path <> all($2::text[]) returning *`,
    [agentId, keptPaths],
   )
   : await db.unsafe(`delete from agent_memory_files where agent_id = $1 returning *`, [agentId]);

  if (upserted.length > 0) notifyDbSubscribers('agent_memory_files', 'INSERT', upserted);
  if (pruned.length > 0) notifyDbSubscribers('agent_memory_files', 'DELETE', pruned);
 }

 // Ingest the BODIES behind the skill names a daemon advertises.
 //
 // `capabilities.skills` is a list of names, which is why the Skills browser could say
 // who has a skill but never what it says. This is the same read-only mirror shape as
 // handleAgentMemorySync above — UPSERT by UNIQUE(agent_id, skill), then prune skills the
 // daemon no longer reports — deliberately, so there is one pattern for "a daemon pushed
 // files up", not two.
 //
 // Nothing is broadcast. A skill body is large and almost never looked at, so it does not
 // belong in the realtime fanout (sanitizeRealtimeRow strips bodies for exactly this
 // reason); the browser fetches one on demand from /backend/system/skill-content.
 async function handleAgentSkillSync(ws, message) {
  const auth = ws.agentAuth;
  if (!auth) throw forbidden('Agent token is required');
  const workspaceId = ws.workspaceId || auth.workspaceId;
  const agentId = ws.agentId || auth.agentId;
  if (!workspaceId || !agentId) throw forbidden('Agent is not registered');

  // Same off switch, `skills` half. A withheld agent keeps advertising skill
  // NAMES (that is capabilities.skills, governed by nothing here) but stops
  // contributing the bodies behind them. Nothing is broadcast: this table is
  // deliberately absent from ALLOWED_TABLES and its sync fans out nothing, so a
  // DELETE event would be a message to no one.
  if (await pruneWithheldMirror(await agentSharingRow(agentId), 'skills', {
   table: 'agent_skill_documents',
   agentId,
  })) return;

  const documents = normalizeSkillDocuments(message.skills);
  const db = getDb();
  const keptSkills = [];
  for (const doc of documents) {
   keptSkills.push(doc.skill);
   await db.unsafe(
    `insert into agent_skill_documents (workspace_id, agent_id, skill, path, summary, content, byte_size, truncated, last_synced, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
        on conflict (agent_id, skill) do update set
          path = excluded.path,
          summary = excluded.summary,
          content = excluded.content,
          byte_size = excluded.byte_size,
          truncated = excluded.truncated,
          last_synced = now(),
          updated_at = now(),
          version = agent_skill_documents.version + 1`,
    [workspaceId, agentId, doc.skill, doc.path, doc.summary, doc.content, doc.byteSize, doc.truncated],
   );
  }

  if (keptSkills.length > 0) {
   await db.unsafe(
    `delete from agent_skill_documents where agent_id = $1 and skill <> all($2::text[])`,
    [agentId, keptSkills],
   );
  } else {
   await db.unsafe('delete from agent_skill_documents where agent_id = $1', [agentId]);
  }

  // Advance the drift reference HERE rather than waiting for the next capabilities
  // snapshot. Without this the heartbeat would keep nudging agent_skills_refresh every
  // beat until an unrelated capabilities sync happened to carry the new hash — the daemon
  // would answer each nudge with a full re-push it had already sent.
  if (typeof message.hash === 'string' && message.hash && ws.agentConnectionId) {
   const rows = await db.unsafe(
    `update agent_connections
       set capabilities = coalesce(capabilities, '{}'::jsonb) || $2::jsonb, updated_at = now()
       where id = $1 returning *`,
    // Bound as an OBJECT: porsager turns a stringified bind into a jsonb STRING SCALAR,
    // which `||` would then concatenate into an array of fragments (see parseJsonObject).
    [ws.agentConnectionId, { skillsHash: message.hash }],
   );
   const live = connectedAgents.get(ws.agentConnectionId);
   if (live && rows[0]) live.capabilities = parseJsonObject(rows[0].capabilities);
  }
 }

 /**
  * Ingest the MARKDOWN a connected agent can see from its own locations.
  *
  * Third and last member of the daemon-mirror family, and deliberately the same
  * shape as the two above it: UPSERT by UNIQUE(agent_id, path), prune what the
  * daemon stopped reporting, advance the drift hash here so the heartbeat stops
  * nudging. One pattern for "a daemon pushed files up", not three.
  *
  * Two differences from the skill mirror, both intentional:
  *
  *   1. IT BROADCASTS (metadata only). The library is a SIDEBAR surface — a
  *      person watching it expects a document that appeared on a teammate's
  *      machine to appear here, not on next reload. `content` is stripped from
  *      the fanout in server/realtime.cjs (REALTIME_HEAVY_FIELDS), so what goes
  *      out is the path/title/domain/hash row the list actually renders.
  *   2. IT PRUNES BY PATH SET rather than deleting everything on an empty push.
  *      Same as the memory mirror. A daemon that legitimately reports zero
  *      documents (nothing markdown in its locations) still clears the agent's
  *      rows — that is the honest answer, and the sharing switch is the way to
  *      say "don't ask" rather than "answer nothing".
  */
 async function handleAgentDocumentSync(ws, message) {
  const auth = ws.agentAuth;
  if (!auth) throw forbidden('Agent token is required');
  const workspaceId = ws.workspaceId || auth.workspaceId;
  const agentId = ws.agentId || auth.agentId;
  if (!workspaceId || !agentId) throw forbidden('Agent is not registered');

  const withheldDocuments = await pruneWithheldMirror(await agentSharingRow(agentId), 'documents', {
   table: 'agent_documents',
   agentId,
  });
  if (withheldDocuments) {
   if (withheldDocuments.length > 0) notifyDbSubscribers('agent_documents', 'DELETE', withheldDocuments);
   return;
  }

  const documents = normalizeAgentDocuments(message.documents || message.files);
  const db = getDb();
  const upserted = [];
  const keptPaths = [];
  for (const doc of documents) {
   keptPaths.push(doc.path);
   const rows = await db.unsafe(
    `insert into agent_documents (
        workspace_id, agent_id, path, title, domain, summary, content, byte_size,
        truncated, content_hash, source_modified_at, last_synced, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
        on conflict (agent_id, path) do update set
          title = excluded.title,
          domain = excluded.domain,
          summary = excluded.summary,
          content = excluded.content,
          byte_size = excluded.byte_size,
          truncated = excluded.truncated,
          content_hash = excluded.content_hash,
          source_modified_at = excluded.source_modified_at,
          last_synced = now(),
          updated_at = now(),
          version = agent_documents.version + 1
        returning *`,
    [
     workspaceId, agentId, doc.path, doc.title, doc.domain, doc.summary, doc.content,
     doc.byteSize, doc.truncated, doc.contentHash, doc.sourceModifiedAt,
    ],
   );
   if (rows[0]) upserted.push(rows[0]);
  }

  const pruned = keptPaths.length > 0
   ? await db.unsafe(
    'delete from agent_documents where agent_id = $1 and path <> all($2::text[]) returning *',
    [agentId, keptPaths],
   )
   : await db.unsafe('delete from agent_documents where agent_id = $1 returning *', [agentId]);

  if (upserted.length > 0) notifyDbSubscribers('agent_documents', 'INSERT', upserted);
  if (pruned.length > 0) notifyDbSubscribers('agent_documents', 'DELETE', pruned);

  // Advance the drift reference here, for the same reason the skill mirror does:
  // otherwise the heartbeat nudges agent_documents_refresh every beat and the
  // daemon answers each one with a full re-push it has already sent.
  if (typeof message.hash === 'string' && message.hash && ws.agentConnectionId) {
   const rows = await db.unsafe(
    `update agent_connections
       set capabilities = coalesce(capabilities, '{}'::jsonb) || $2::jsonb, updated_at = now()
       where id = $1 returning *`,
    [ws.agentConnectionId, { documentsHash: message.hash }],
   );
   const live = connectedAgents.get(ws.agentConnectionId);
   if (live && rows[0]) live.capabilities = parseJsonObject(rows[0].capabilities);
  }
 }

 async function handleAgentCapabilitiesSync(ws, message) {
  const auth = ws.agentAuth;
  if (!auth) throw forbidden('Agent token is required');
  const workspaceId = ws.workspaceId || auth.workspaceId;
  const connectionId = ws.agentConnectionId;
  if (!workspaceId || !connectionId) throw forbidden('Agent is not registered');

  const capabilities = {
   skills: Array.isArray(message.skills) ? message.skills : [],
   // Slash commands the daemon enumerated on the user's machine: [{name, parent}].
   // Optional (older daemons don't send it) — the slash-commands endpoint tolerates absence.
   commands: Array.isArray(message.commands) ? message.commands : [],
   clis: Array.isArray(message.clis) ? message.clis : [],
   mcpServers: Array.isArray(message.mcpServers) ? message.mcpServers : [],
   runtimes: executionRuntimesFromMessage(message.runtimes),
   sharedModels: sharedModelsFromMessage(message.sharedModels),
   codingRoute: message.codingRoute === true,
   shared: message.shared === true,
   memoryRoot: typeof message.memoryRoot === 'string' ? message.memoryRoot : null,
   // Direct-reachability advert (agent-mesh F2). Rides the SAME drift channel as the
   // rest of capabilities; the daemon folds JSON.stringify(reach) into its
   // capabilitiesHash so a reach change re-pushes via the existing
   // agent_capabilities_refresh nudge — no new sync channel. Optional: older daemons
   // omit it, stays undefined, capabilitiesShapeValid ignores it. Redacted from
   // browsers by publicAgentConnection; the FULL block (LAN host/port) reaches peer
   // daemons only via the hub peer_list_request/peer_list channel (F7).
   reach: reachFromMessage(message.reach),
   // Daemon-owned drift hashes. Stored as the reference the heartbeat drift-check
   // compares against; the server never recomputes these (avoids a cross-runtime
   // canonicalization contract). Advances only when a real snapshot lands here.
   hash: typeof message.hash === 'string' ? message.hash : null,
   memoryHash: typeof message.memoryHash === 'string' ? message.memoryHash : null,
   skillsHash: typeof message.skillsHash === 'string' ? message.skillsHash : null,
   // Third mirror's drift reference. Carried HERE as well as advanced by
   // handleAgentDocumentSync because this statement REPLACES the whole
   // capabilities blob — omitting it would blank the reference on every
   // capabilities push and leave the heartbeat nudging documents forever.
   documentsHash: typeof message.documentsHash === 'string' ? message.documentsHash : null,
  };

  // The `tools` sharing switch, applied at INGEST rather than at render.
  //
  // publicAgentConnection is a pure row mapper on the fanout path with no agent
  // row in hand, so a render-time gate there would need a database read inside
  // realtime broadcast. Redacting here means the withheld advert is never
  // stored at all, which is also the stronger property. Turning the switch back
  // on re-nudges the daemon (see the agent update route) so the full advert
  // returns on the next push rather than at the next unrelated drift.
  const shareable = applyToolSharing(capabilities, await agentSharingRow(ws.agentId || auth.agentId));

  const rows = await getDb().unsafe(
   `update agent_connections set capabilities = $2::jsonb, updated_at = now()
      where id = $1 returning *`,
   [connectionId, shareable],
  );
  const liveConnection = connectedAgents.get(connectionId);
  if (liveConnection) liveConnection.capabilities = shareable;
  if (rows.length > 0) notifyDbSubscribers('agent_connections', 'UPDATE', rows.map(publicAgentConnection));
 }

 /**
  * Ask an agent's live daemons to re-push everything, after its sharing changed.
  *
  * Switching a channel ON is the case that needs this. Switching OFF takes
  * effect immediately (the ingest gate prunes on the next push, and the update
  * route prunes eagerly), but switching back on leaves the agent with nothing
  * mirrored and a drift hash that still MATCHES — so the heartbeat sees no
  * drift and would never ask for the snapshot that is now allowed. The daemon
  * has to be told.
  *
  * All four nudges are sent rather than only the changed one: they are cheap
  * frames on a socket that already exists, and a daemon that ignores an unknown
  * one loses nothing. Returns how many connections were told.
  */
 function nudgeAgentSharingResync(workspaceId, agentId, handle = null) {
  let told = 0;
  for (const entry of connectedAgents.values()) {
   if (String(entry.agentId) !== String(agentId)) continue;
   if (workspaceId && String(entry.workspaceId) !== String(workspaceId)) continue;
   for (const type of ['agent_capabilities_refresh', 'agent_memory_refresh', 'agent_skills_refresh', 'agent_documents_refresh']) {
    sendWs(entry.ws, { type });
   }
   told += 1;
  }
  if (told === 0 && handle) {
   const fallback = findConnectedAgent(workspaceId, agentId, handle);
   if (fallback) {
    for (const type of ['agent_capabilities_refresh', 'agent_memory_refresh', 'agent_skills_refresh', 'agent_documents_refresh']) {
     sendWs(fallback.ws, { type });
    }
    told = 1;
   }
  }
  return told;
 }

 // Test seams. connectedAgents is private, so a test that needs to assert HOW
 // MANY live connections an agent has goes through these.
 function registerTestConnectedAgent(entry) {
  connectedAgents.set(entry.connectionId, entry);
  return entry;
 }

 function listTestConnectedAgents() {
  return [...connectedAgents.values()];
 }

 // Called by index.cjs's resetTestState(). Clears connectedAgents only, exactly
 // as the original did.
 function reset() {
  connectedAgents.clear();
 }

 return {
  applyAgentIdentity,
  ampRuntimeFromMessage,
  executionRuntimesFromMessage,
  capabilitiesDriftNudges,
  capabilitiesShapeValid,
  clearPendingJobFailures,
  closeTakenAgentDaemons,
  disableFarmIntegrationAgents,
  disconnectAgentDaemons,
  findConnectedAgent,
  handleAgentCapabilitiesSync,
  handleAgentDocumentSync,
  handleAgentMemorySync,
  handleAgentSkillSync,
  nudgeAgentSharingResync,
  hasMcpPresence,
  isConnectionSocketLive,
  isConnectionSocketOpen,
  markAgentConnectionOffline,
  markConnectionOffline,
  pruneOfflineConnections,
  reconcileAgentConnectionsAtStartup,
  refreshConnectedAgentConfigs,
  registerAgentConnection,
  sendToConnection,
  repairCorruptedAgentIdentities,
  takeAgentDaemonConnections,
  touchMcpPresence,
  updateAgentHeartbeat,
  AGENT_DISCONNECT_CLOSE_MESSAGES,
  AGENT_IDENTITY_SELECT,
  AGENT_IDENTITY_WRITE_ATTEMPTS,
  MCP_PRESENCE_TTL_MS,
  connectedAgents,
  registerTestConnectedAgent,
  listTestConnectedAgents,
  reset,
 };
}

module.exports = { createAgentConnections };
