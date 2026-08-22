'use strict';

const crypto = require('crypto');
const { ADVANCE_AGENT_READ_MARKER_SQL } = require('../shared/read-receipts.cjs');

// Agent jobs: the row that says a turn is RUNNING, everything that streams into
// it, and the reapers that close one out when the process behind it stops.
//
// Wave 4 of the server/index.cjs reduction. Unlike the other Wave 4 modules this
// one owns NO state — the jobs live in Postgres, which is the point. A job's
// liveness is a database fact so a restart cannot lose it, and so two processes
// cannot disagree about whether an agent is busy.
//
// LIVENESS IS lastContentAt, NOT A TICK. reapStuckAgentJobs closes a job on
// silence, not on the absence of a heartbeat: a daemon that pings once a second
// while producing nothing is not making progress, and treating its ping as
// progress is how a wedged turn stayed "running" forever.
//
// finalizeStuckJob writes status='error', never 'failed'. 'failed' is not in the
// column's constraint, so the UPDATE was rejected and swallowed, and the job
// stayed 'running' — which made the agent look permanently busy and its DM stop
// responding. That is why the value is asserted in tests rather than assumed.
//
// insertActiveAgentJob returns null on a unique violation and deletes the
// placeholder it created. Two dispatches racing for one agent must leave exactly
// one job and no orphaned "Thinking …" row.

function createAgentJobs(deps = {}) {
 const {
  PLACEHOLDER_CONTENT_RE,
  agentLiveMessageContent,
  agentPermissionFlags,
  agentRuntimePayload,
  badRequest,
  continueConversation,
  findConnectedAgent,
  // The rest of the connection + queue surface these handlers reach into. All
  // forwarded as thunks from index.cjs: agent-connections and task-dispatch are
  // constructed around this module, so a captured binding would be undefined.
  hasMcpPresence, touchMcpPresence, isConnectionSocketOpen, updateAgentHeartbeat,
  // A THUNK, not the Map. index.cjs constructs this module before
  // agent-connections, and destructuring `deps` INVOKES a getter — so passing
  // `get connectedAgents()` read the binding during its TDZ and threw
  // "Cannot access 'agentConnections' before initialization" at require time.
  // Every other cross-module dep here is a thunk for the same reason.
  getConnectedAgents,
  scheduleTaskQueueDrain,
  // Replays a human turn parked because this agent was already mid-turn. Paired
  // with scheduleTaskQueueDrain at every terminal-status site: the two answer the
  // same question — "the one active-job slot just freed, what was waiting on
  // it?" — for the two kinds of waiting work, tasks and chat.
  drainPendingChatTurn = () => {},
  // Closes the task server/chat-task-capture.cjs minted for this turn, if the
  // turn ran long enough to have been captured at all. Defaulted to a no-op for
  // the same reason as drainPendingChatTurn: the unit tests construct this
  // module with a partial dep set, and capture is an enhancement rather than
  // something a job transition may depend on.
  settleCapturedChatTask = () => {},
  forbidden,
  ensureTable = (table) => table,
  getDb,
  isAgentEnabled,
  logMessageActivity,
  mirrorAgentReplyToTaskComment,
  normalizeAgentPermissionMode,
  notifyDbSubscribers,
  parseJsonObject,
  sendWs,
  slugHandle,
  textFromValue,
  verifyThreadParent,
  // Fail-open metering. Optional so unit tests that construct this module with a
  // thin deps bag still work; production always wires recordAnthropicUsage.
  recordAnthropicUsage = null,
  // Ephemeral speakable-sentence fanout for live huddles. Optional for tests.
  publishHuddleVoiceText = async (_args) => String(_args?.previousSpoken || ''),
 } = deps;

 function publishCommittedFanout(pendingFanout) {
  for (const [table, eventType, rows] of pendingFanout) {
   // Pending events are assembled by internal orchestration code, but the
   // table name is still dynamic at this boundary. Re-run the same allowlist
   // gate as the generic DB routes before anything reaches a socket.
   ensureTable(table);
   notifyDbSubscribers(table, eventType, rows);
  }
 }

 // A pull worker has read only after claimMcpJob returns its prompt. Its metadata
 // carries the exact newest inbound message in that bounded prompt, so the marker
 // cannot widen to a later or out-of-thread message while the job is running.
 async function advanceAgentReadMarker(
  sessionId,
  agentId,
  lastSeenMessageId,
  threadParentId = null,
  db = getDb(),
  publish = notifyDbSubscribers,
 ) {
  if (!sessionId || !agentId || !lastSeenMessageId) return;
  try {
   const rows = await db.unsafe(
    ADVANCE_AGENT_READ_MARKER_SQL,
    [String(sessionId), String(agentId), String(lastSeenMessageId), threadParentId || null],
   );
   if (rows.length > 0) publish('session_read_state', 'INSERT', rows);
  } catch (error) {
   console.error('advanceAgentReadMarker (job claim) failed', error);
  }
 }

 // Insert an agent_job, tolerating the partial unique index that enforces one
 // active job per (session, agent) (M15). A unique violation means a concurrent
 // trigger already created the turn's job (won the race), so we clean up the
 // just-created "Thinking" placeholder message (if any) and return null; callers
 // treat null like the pending path and stop the drain loop.
 async function insertActiveAgentJob(sql, params, placeholderMessageId = null, reservation = {}) {
  const workspaceId = String(reservation.workspaceId || '').trim();
  const agentId = String(reservation.agentId || '').trim();
  const sessionId = String(reservation.sessionId || '').trim();
  if (!workspaceId || !agentId || !sessionId) {
   throw new Error('insertActiveAgentJob requires workspaceId, agentId, and sessionId');
  }

  const cleanupPlaceholder = async () => {
   if (!placeholderMessageId) return;
   try {
    const del = await getDb().unsafe(
     'delete from messages where id = $1 and deleted_at is null returning *',
     [placeholderMessageId],
    );
    if (del.length > 0) notifyDbSubscribers('messages', 'DELETE', del);
   } catch { /* best effort placeholder cleanup */ }
  };

  try {
   const inserted = await getDb().begin(async (tx) => {
    // This is the FINAL reservation proof, deliberately after any eager
    // placeholder write. Holding both rows through the INSERT closes the race
    // where clear could otherwise delete the conversation between the caller's
    // optimistic setup and a raw agent_jobs insert. Roster membership lives on
    // the session row, so its lock also serializes participant removal.
    const live = await tx.unsafe(
     `select s.id
        from chat_sessions s
        join workspace_agents a
          on a.id = $2
         and a.workspace_id = s.workspace_id
         and a.enabled is true
         and ($4::boolean is false or a.mcp_approved is true)
       where s.id = $3
         and s.workspace_id = $1
         and s.deleted_at is null
         and exists (
           select 1
             from jsonb_array_elements(
               case when jsonb_typeof(s.participants) = 'array'
                    then s.participants else '[]'::jsonb end
             ) participant
            where participant->>'agent_id' = a.id::text
         )
       for share of s, a`,
     [workspaceId, agentId, sessionId, reservation.requireMcpApproval === true],
    );
    if (live.length !== 1) return null;
    return tx.unsafe(sql, params);
   });
   if (!inserted) await cleanupPlaceholder();
   return inserted;
  } catch (error) {
   if (error && error.code === '23505') {
    await cleanupPlaceholder();
    return null;
   }
   throw error;
  }
 }

 /**
  * Run one daemon-originated mutation while the exact live job scope is locked.
  *
  * The websocket token supplies workspace/agent identity; the connection id
  * binds the frame to the process currently assigned to the job. The database
  * supplies every mutable fact: running status, live same-workspace session,
  * enabled agent, and current roster participation. Holding all three rows until
  * the callback commits makes clear, disable, re-home and roster removal wait.
  */
 async function withCurrentDaemonJob(ws, jobId, work, { allowSessionlessFarm = false } = {}) {
  const auth = ws.agentAuth;
  const pendingFanout = [];
  const pendingAfterCommit = [];
  const outcome = await getDb().begin(async (tx) => {
   let rows = await tx.unsafe(
    `select j.*, a.name as agent_name, a.handle as agent_handle
       from agent_jobs j
       join chat_sessions s
         on s.id = j.session_id
        and s.workspace_id = j.workspace_id
        and s.deleted_at is null
       join workspace_agents a
         on a.id = j.agent_id
        and a.workspace_id = j.workspace_id
        and a.enabled is true
      where j.id = $1
        and j.agent_id = $2
        and j.workspace_id = $3
        and j.connection_id = $4
        and j.status = 'running'
        and exists (
          select 1
            from jsonb_array_elements(
              case when jsonb_typeof(s.participants) = 'array'
                   then s.participants else '[]'::jsonb end
            ) participant
           where participant->>'agent_id' = a.id::text
        )
      limit 1
      for update of j, s, a`,
    [jobId, auth.agentId, auth.workspaceId, ws.agentConnectionId],
   );
   if (!rows[0] && allowSessionlessFarm) {
    rows = await tx.unsafe(
     `select j.*, a.name as agent_name, a.handle as agent_handle
        from agent_jobs j
        join workspace_agents a
          on a.id = j.agent_id
         and a.workspace_id = j.workspace_id
         and a.enabled is true
       where j.id = $1
         and j.agent_id = $2
         and j.workspace_id = $3
         and j.connection_id = $4
         and j.session_id is null
         and (j.metadata->>'mode') = 'farm'
         and j.status = 'running'
       limit 1
       for update of j, a`,
     [jobId, auth.agentId, auth.workspaceId, ws.agentConnectionId],
    );
   }
   if (!rows[0]) {
    // A frame already in flight when a terminal transition commits is stale,
    // not an authorization failure. Diagnose that narrow case by the exact
    // immutable websocket identity, but never use this weaker lookup to admit a
    // write: a RUNNING row that failed the live-scope proof means the session
    // was cleared, the agent was disabled/removed, or roster participation was
    // revoked, and must fail closed.
    const current = await tx.unsafe(
     `select status from agent_jobs
        where id = $1
          and agent_id = $2
          and workspace_id = $3
          and connection_id = $4
        limit 1`,
     [jobId, auth.agentId, auth.workspaceId, ws.agentConnectionId],
    );
    if (current[0] && current[0].status !== 'running') return { stale: true, value: undefined };
    throw forbidden('Agent job not found');
   }
   const publishAfterCommit = (table, eventType, eventRows) => {
    if (Array.isArray(eventRows) && eventRows.length > 0) {
     pendingFanout.push([table, eventType, eventRows]);
    }
   };
   const afterCommit = (callback) => {
    if (typeof callback === 'function') pendingAfterCommit.push(callback);
   };
   return { stale: false, value: await work({ tx, job: rows[0], publishAfterCommit, afterCommit }) };
  });
  if (outcome?.stale) return undefined;
  publishCommittedFanout(pendingFanout);
  for (const callback of pendingAfterCommit) {
   try {
    callback();
   } catch (error) {
    console.error('daemon job post-commit callback failed', error);
   }
  }
  return outcome?.value;
 }

 // A queued/running job is "live" only if the worker meant to answer it still exists.
 // Trusting status alone let a phantom job (a daemon that vanished, or an MCP client
 // that left) wedge a session forever — new turns were silently dropped while a
 // healthy, reconnected agent sat unable to speak in its own DM.
 function isAgentJobLive(job, agentId) {
  const mode = parseJsonObject(job.metadata).mode;
  if (mode === 'mcp') {
   // A CLAIMED (running) MCP turn keeps no heartbeat — presence (40s TTL) is only
   // touched on claim/submit, but a turn can legitimately run up to the 240s MCP
   // reaper window. So treat running MCP jobs as live (the reaper is the backstop);
   // only gate QUEUED ones on presence, since an unclaimed job needs a live client
   // to ever be answered. Gating running jobs on presence would kill a live turn
   // mid-flight and dispatch a duplicate.
   return job.status === 'running' ? true : hasMcpPresence(agentId);
  }
  if (mode === 'builtin') return true; // runs in-process; an interrupted one is cleared by startup reconcile
  // daemon (or legacy rows with no explicit mode): live only while its socket is open.
  return job.connection_id ? isConnectionSocketOpen(job.connection_id) : false;
 }

 // Read-only "does this agent already have a live turn in flight?".
 //
 // Deliberately NOT hasActiveBurstJob: that one finalizes phantom jobs as a side
 // effect, and a queue drain must not be able to kill a turn it merely asked
 // about. Liveness still matters (a job whose worker vanished must not look
 // active forever) — the reaper, the socket-close sweep and startup reconcile are
 // what clear those, and each of them drains the queue afterwards.
 async function agentHasActiveJob(sessionId, agentId) {
  const rows = await getDb().unsafe(
   `select id, status, connection_id, metadata, started_at from agent_jobs
       where session_id = $1 and agent_id = $2 and status in ('queued', 'running')`,
   [sessionId, String(agentId)],
  );
  return rows.some((job) => isAgentJobLive(job, agentId));
 }

 // Same question, workspace-wide. The queue drain uses this rather than the
 // session-scoped check: an agent that is mid-turn anywhere (a channel, another
 // DM) is busy, and starting a task turn on top of it would run two turns at
 // once. Stricter than the unique index, and self-healing — every job completion
 // drains again.
 async function agentHasAnyActiveJob(workspaceId, agentId) {
  const rows = await getDb().unsafe(
   `select id, status, connection_id, metadata, started_at from agent_jobs
       where workspace_id = $1 and agent_id = $2 and status in ('queued', 'running')`,
   [String(workspaceId), String(agentId)],
  );
  return rows.some((job) => isAgentJobLive(job, agentId));
 }

 async function hasActiveBurstJob(sessionId, agentId) {
  // Include 'queued', not just 'running': an MCP-backed agent's job sits in
  // 'queued' until its client polls and claims it, so two rapid triggers for the
  // same session/agent (two quick DMs, or dispatch + comment-mention) would both
  // pass a running-only guard and produce a duplicate turn (M14, 2026-07 review).
  const rows = await getDb().unsafe(
   `select id, status, connection_id, metadata, started_at from agent_jobs
       where session_id = $1 and agent_id = $2 and status in ('queued', 'running')`,
   [sessionId, String(agentId)],
  );
  let blocking = false;
  for (const job of rows) {
   if (isAgentJobLive(job, agentId)) { blocking = true; continue; }
   // Phantom: its worker is gone, so it can never produce a result and must not
   // wedge the session. Finalize it now — awaited so the row is 'error' before the
   // caller dispatches a fresh turn, otherwise the M15 one-active-job unique index
   // would bounce the retry and the human would have to send again.
   await finalizeStuckJob(job, 'the previous turn was abandoned', 'connection_lost');
  }
  return blocking;
 }

 // Remove any "Thinking …" placeholder this turn left standing, except the one the
 // caller has already resolved itself.
 //
 // Only the CURRENT placeholder is tracked, in metadata.responseMessageId — but a
 // turn rotates through a fresh one per text block (handleAgentJobSegment), so a
 // job that dies, or a write that races its own finalization, can leave an earlier
 // one behind with nothing to finish it. Those rows then read "Thinking 2m 11s"
 // forever: a present-tense claim that an agent is working, made hours after it
 // stopped. That is worse than no row at all, because a human acts on it. They hold
 // nothing recoverable either — by the time one strands, the block that should have
 // been in it is already lost — so removing them is the honest resolution.
 //
 // Scoped hard: this agent, this session, this turn's own window. The M15 unique
 // index allows only one queued/running job per (session, agent), so no live turn's
 // placeholder can be inside that window while this one terminates.
 async function clearStrandedPlaceholders(job, keepMessageId = null, db = getDb(), publish = notifyDbSubscribers) {
  if (!job || !job.session_id || !job.agent_id) return;
  const since = job.started_at || job.created_at;
  if (!since) return;
  try {
   const rows = await db.unsafe(
    `delete from messages
       where session_id = $1
         and sender_id = $2
         and sender_kind = 'agent'
         and coalesce(message_kind, '') = ''
         and deleted_at is null
         and content ~ $3
         -- The eager placeholder is inserted just BEFORE the job row it belongs to,
         -- so the window has to open slightly ahead of the job's own clock.
         and created_at >= $4::timestamptz - interval '1 minute'
         and ($5::text is null or id::text <> $5::text)
       returning *`,
    [job.session_id, String(job.agent_id), PLACEHOLDER_CONTENT_RE, since, keepMessageId || null],
   );
   if (rows.length > 0) publish('messages', 'DELETE', rows);
  } catch {
   // best effort — tidy-up must never fail a job that otherwise finished correctly
  }
 }

 // Finalize a stuck/abandoned daemon job: mark it failed and rewrite its still-
 // pending "Thinking …" placeholder with a clear message, so a chat never hangs on
 // a spinner when the daemon disconnects, crashes, or simply never answers.
 async function finalizeStuckJob(job, reason, stopReason = 'connection_lost') {
  try {
   // A reaped job is now distinguishable from one that ended on its own. The
   // reason is server-authored here (not daemon-supplied), but it goes through
   // the same validator so there is exactly one way a stopReason enters a row.
   const stuckMetadata = {
    ...parseJsonObject(job.metadata),
    ...(normalizeStopReason(stopReason) ? { stopReason: normalizeStopReason(stopReason) } : {}),
   };
   // Use 'error' (not 'failed'): the agent_jobs.status CHECK constraint only permits
   // queued/running/done/error/cancelled. Writing 'failed' throws a constraint
   // violation that the surrounding try/catch swallows, so the job would stay
   // 'running' forever — the exact bug that let a phantom job wedge a DM indefinitely
   // (reaper, connection-drop cleanup, and startup reconcile all funnel through here).
   const updated = await getDb().unsafe(
    // 'queued' is in the guard as well as 'running': hasActiveBurstJob awaits this
    // for phantom jobs that never got claimed (the MCP case), specifically so the
    // one-active-job unique index won't bounce the retry. A running-only guard
    // matched zero rows there, leaving the queued row holding the
    // (session_id, agent_id) active slot and silently dropping the next message.
    // 'error' (not 'failed') is load-bearing — see the comment above.
    // Bind the merged OBJECT, never JSON.stringify: a stringified bind becomes a
    // jsonb string scalar and corrupts the column.
    `update agent_jobs set status = 'error', error = $2, metadata = $3::jsonb, finished_at = now(), updated_at = now() where id = $1 and status in ('queued', 'running') returning *`,
    [job.id, `Agent stopped responding (${reason})`, stuckMetadata],
   );
   if (updated.length === 0) return; // a real result already finalized it
   // The only job-terminating path that never notified subscribers. A wedged job's
   // elapsed badge would otherwise tick forever, because the client never learns the
   // job stopped — the timeout, dropped daemon, phantom cleanup and restart reconcile
   // all land here.
   notifyDbSubscribers('agent_jobs', 'UPDATE', updated);
   // A timeout, a dropped daemon, a phantom cleanup and a backend restart all land
   // here — each one frees the agent's active-job slot, and each one used to strand
   // whatever was queued behind it. Fire-and-forget, so it cannot fail this write.
   scheduleTaskQueueDrain(job.workspace_id, job.agent_id, `job_stuck:${reason}`);
   drainPendingChatTurn(job.session_id, job.agent_id, `job_stuck:${reason}`);
   const meta = parseJsonObject(job.metadata);
   const responseMessageId = meta.responseMessageId || null;
   if (responseMessageId) {
    const handle = meta.handle || 'agent';
    // "It produced nothing for several minutes" and "it hit the maximum time
    // allowed for one turn" send a human to two different places, and the old
    // text — one word, "timed out" — said neither.
    //
    // connection_lost deliberately keeps the ORIGINAL wording: "stopped
    // responding" is exactly what happened there, and `reason` already carries
    // the specific cause ("the daemon disconnected", "the backend restarted").
    // Rewording it would be churn that tells the reader nothing new.
    const stuckSentence = stuckMetadata.stopReason === 'connection_lost'
     ? ''
     : STOP_REASON_TEXT[stuckMetadata.stopReason] || '';
    const content = stuckSentence
     ? `@${handle} stopped: ${stuckSentence}. Send again to retry — if it keeps happening, reconnect the daemon from AI Agents.`
     : `@${handle} stopped responding (${reason}). Send again to retry — if it keeps happening, reconnect the daemon from AI Agents.`;
    // Broadcast it for the same reason the reply is broadcast: the placeholder was
    // working inside a thread, and a channel that shows nothing at all after the
    // human's message reads as "still thinking" forever.
    const rows = await getDb().unsafe(
     `update messages set content = $2, broadcast_to_channel = $4
         where id = $1 and session_id = $3 and content ~ $5
         returning *`,
     [responseMessageId, content, job.session_id, meta.broadcastToChannel === true, PLACEHOLDER_CONTENT_RE],
    );
    if (rows.length > 0) notifyDbSubscribers('messages', 'UPDATE', rows);
   }
   // A job that died leaves the human with something honest in the placeholder it
   // was tracking — but a turn that had already rotated through several has others
   // standing behind it, and those are not covered by the id above. No placeholder
   // this turn wrote may outlive it still claiming to be live.
   await clearStrandedPlaceholders(job, responseMessageId);
  } catch {
   // best effort
  }
 }

 // Move an agent's still-running jobs onto the connection it just reconnected on.
 //
 // A dropped socket does NOT mean the work stopped: the daemon keeps executing the
 // turn and reconnects ~2s later on a fresh connection id. Without this, the job row
 // still points at the dead connection, so the deferred failure in markConnectionOffline
 // would eventually kill a turn that is alive and streaming. handleAgentJobResult
 // already looks jobs up by (jobId, agentId, workspaceId) rather than by connection,
 // so the reconnected daemon can deliver the result — this just keeps the row's
 // bookkeeping pointing at a connection that actually exists.
 async function rehomeRunningJobs(workspaceId, agentId, connectionId) {
  if (!workspaceId || !agentId || !connectionId) return [];
  try {
   return await getDb().unsafe(
    `update agent_jobs set connection_id = $1, updated_at = now()
        where workspace_id = $2 and agent_id = $3 and status = 'running'
          and connection_id is distinct from $1
        returning id`,
    [connectionId, workspaceId, agentId],
   );
  } catch {
   return [];
  }
 }

 // Fail every running job tied to a connection that just dropped.
 async function failConnectionJobs(connectionId, reason) {
  if (!connectionId) return;
  try {
   const rows = await getDb().unsafe(
    `select * from agent_jobs where connection_id = $1 and status = 'running'`,
    [connectionId],
   );
   for (const job of rows) await finalizeStuckJob(job, reason, 'connection_lost');
  } catch {
   // best effort
  }
 }

 // The server's content-silence window. This is a BACKSTOP, not the primary
 // control: the server can only rewrite the row, while the daemon is the only
 // side that can actually stop the work.
 //
 // It is paired with DEFAULT_IDLE_TIMEOUT_MS in the agensis-agent repo
 // (packages/agensis-cli/src/agensis.mjs), which is deliberately set to NINE
 // minutes so the daemon always decides first and reports a real reason. If this
 // number ever drops to or below the daemon's, the server starts winning the
 // race and every silent turn is reported as a guess again — while a CLI keeps
 // running on someone's laptop for another twenty minutes. Move the two together
 // or not at all.
 const AGENT_JOB_IDLE_REAP_MINUTES = 10;
 // The absolute stop, measured from started_at, that no amount of ticking can
 // extend. Matches the daemon's DEFAULT_TIMEOUT_MS (30 minutes).
 const AGENT_JOB_HARD_CEILING_MINUTES = 30;
 const AGENT_JOB_FARM_CEILING_MINUTES = 31;

 // Backstop: time out jobs whose result/progress has gone stale.
 //
 // Staleness is measured from the last delta that carried actual CONTENT, not from
 // updated_at. A waiting daemon sends a content-free "Thinking Ns" tick every second,
 // and each one bumps updated_at — so an updated_at-based guard never fires and a
 // wedged agent spins forever (observed live: 8 minutes, 0 bytes of response, the
 // reaper never touched it). The earlier started_at-based guard had the opposite
 // bug: it killed healthy turns that were streaming happily at the 4-minute mark.
 // lastContentAt is written by handleAgentJobDelta only when the delta has text.
 //
 // The window is 10 minutes rather than 4: a coding agent can legitimately think
 // for minutes without emitting a token, and killing those was the original
 // complaint. NO_PROGRESS covers "alive but producing nothing"; HARD_CEILING is an
 // absolute stop measured from started_at, so no amount of ticking can keep a job
 // alive indefinitely. Farm coding jobs keep sharing the CLI's 30-minute budget.
 async function reapStuckAgentJobs() {
  try {
   const rows = await getDb().unsafe(
    `select * from agent_jobs
        where status = 'running'
          and (
            ((metadata->>'mode') = 'farm' and updated_at < now() - make_interval(mins => $3::int))
            or (
              coalesce(metadata->>'mode', '') <> 'farm'
              and (
                coalesce((metadata->>'lastContentAt')::timestamptz, started_at) < now() - make_interval(mins => $1::int)
                or started_at < now() - make_interval(mins => $2::int)
              )
            )
          )`,
    // make_interval with an explicit ::int cast rather than building a string
    // (`$1 || ' minutes'`). Both parse — checked against the real database, not
    // just the mock — but this form states the parameter's type outright instead
    // of leaving it to operator resolution, and reads as a number, which is what
    // the constants above are.
    [AGENT_JOB_IDLE_REAP_MINUTES, AGENT_JOB_HARD_CEILING_MINUTES, AGENT_JOB_FARM_CEILING_MINUTES],
   );
   for (const job of rows) {
    // Two different failures wear the same 'timed out' label today: a job that
    // went SILENT (no content for AGENT_JOB_IDLE_REAP_MINUTES) and one that ran
    // past the absolute ceiling. Only started_at can tell them apart here.
    const startedAt = job.started_at ? new Date(job.started_at).getTime() : 0;
    const hitCeiling = startedAt > 0 && Date.now() - startedAt >= AGENT_JOB_HARD_CEILING_MINUTES * 60_000;
    await finalizeStuckJob(job, 'timed out', hitCeiling ? 'hard_timeout' : 'idle_timeout');
   }
  } catch {
   // best effort
  }
 }

 // Finalize ONE agent job (daemon push OR MCP pull) with its result, then resume the
 // conversation. Shared so both paths render replies identically: mark the job done/error,
 // rewrite the "Thinking …" placeholder (or insert a fresh message), log to Activity, and
 // continue the channel turn loop. `job` must carry agent_name/agent_handle (join on load).
 const AMP_THREAD_ID_RE = /^T-[A-Za-z0-9-]{20,100}$/;
 const AMP_ERROR_CODE_RE = /^amp_[a-z0-9_]{1,80}$/;

 // Why a turn ended, in the vocabulary the daemon reports it in
 // (packages/agensis-cli/src/stopReasons.mjs in the agensis-agent repo). This
 // list is the SERVER's copy and the two must stay identical — there is no
 // shared module across the two repos, so a value added on one side and not the
 // other is silently dropped here rather than stored.
 const STOP_REASONS = new Set([
  'completed', 'cancelled', 'max_tokens', 'max_turns', 'max_budget', 'refused',
  'idle_timeout', 'hard_timeout', 'permission_denied', 'agent_error', 'connection_lost',
 ]);

 // One human sentence per reason, used in the chat message a failed turn leaves
 // behind. This is the ONLY place the wording lives, and it is deliberately
 // server-side: the text is baked into messages.content when the job finalizes,
 // so the client renders a plain string and never has to know the vocabulary.
 const STOP_REASON_TEXT = {
  cancelled: 'the turn was cancelled',
  max_tokens: 'the conversation grew past its context limit',
  max_turns: 'it used up its allowed steps for one turn',
  max_budget: 'it reached its spending limit for this turn',
  refused: 'the model declined to answer',
  idle_timeout: 'it produced nothing for several minutes',
  hard_timeout: 'it hit the maximum time allowed for one turn',
  permission_denied: 'a tool it needed was not approved',
  agent_error: 'the coding agent errored',
  connection_lost: 'the connection to the daemon dropped mid-turn',
 };

 /**
  * A stop reason is UNTRUSTED input: it arrives on a websocket frame from
  * someone else's machine and ends up rendered into a human's transcript. It is
  * matched against the closed set above and anything else becomes '' — never a
  * passthrough, exactly like AMP_ERROR_CODE_RE next door.
  */
 function normalizeStopReason(value) {
  return typeof value === 'string' && STOP_REASONS.has(value) ? value : '';
 }

 /**
  * The runtime's own wording for the same event, kept for diagnosis only. Never
  * rendered, so the bar is "cannot corrupt the row": a conservative charset and
  * a hard length cap. An empty result simply means no detail was stored.
  */
 // Reasons whose raw runtime message is jargon that merely restates the reason
 // ("claude-agent-sdk result error: error_max_turns", "timed out after 1800000ms").
 // For these the sentence REPLACES the raw text; for the rest it leads and the
 // raw text follows, because there the raw text is the actual information.
 const SELF_EXPLANATORY_STOP_REASONS = new Set([
  'cancelled', 'max_tokens', 'max_turns', 'max_budget', 'refused',
  'idle_timeout', 'hard_timeout', 'connection_lost',
 ]);

 function failureSentence(stopReason, errorText) {
  const sentence = STOP_REASON_TEXT[stopReason] || '';
  if (!sentence) return errorText; // no reason reported: exactly today's text
  if (SELF_EXPLANATORY_STOP_REASONS.has(stopReason)) return sentence;
  return errorText ? `${sentence} — ${errorText}` : sentence;
 }

 function normalizeStopDetail(value) {
  const detail = typeof value === 'string' ? value.trim().slice(0, 120) : '';
  return /^[a-z0-9_.:-]*$/i.test(detail) ? detail : '';
 }

 function finiteNumber(value, max) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.min(num, max) : 0;
 }

 /**
  * Daemon-reported Anthropic-shaped usage on an agent_job_result frame.
  * Untrusted: only the four Messages-API count fields survive, positive finite
  * only. Returns null when there is nothing countable (rule 3 of usage-metering:
  * never invent a row).
  */
 function daemonStopUsage(message) {
  const raw = message && message.usage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = {};
  for (const key of [
   'input_tokens',
   'output_tokens',
   'cache_creation_input_tokens',
   'cache_read_input_tokens',
  ]) {
   const num = Number(raw[key]);
   if (Number.isFinite(num) && num > 0) usage[key] = Math.round(num);
  }
  return Object.keys(usage).length > 0 ? usage : null;
 }

 /**
  * The result metadata the daemon used to throw away, validated for storage.
  *
  * Returns an EMPTY object when there is no recognised reason, so a job from an
  * older daemon (or from LocalExecutor, which has no structured result to read)
  * produces byte-identical metadata to what it produced before this existed.
  */
 function stopResultMetadata(message) {
  const stopReason = normalizeStopReason(message && message.stopReason);
  if (!stopReason) return {};
  const stopDetail = normalizeStopDetail(message && message.stopDetail);
  // Normalize FIRST, then decide whether to store. Testing the raw value would
  // store a 0 for input that is merely unusable (a negative count, 'lots'),
  // which reads as a real measurement of zero rather than as "not reported".
  const numTurns = finiteNumber(message.numTurns, 100_000);
  // Per-turn spend is STORED but never rendered in v1. agent_jobs.metadata is
  // fanned out to clients by notifyDbSubscribers, so putting a cost in front of
  // a human is a product decision nobody has made yet.
  const costUsd = finiteNumber(message.costUsd, 10_000);
  const permissionDenials = finiteNumber(message.permissionDenials, 10_000);
  const usage = daemonStopUsage(message);
  return {
   stopReason,
   ...(stopDetail ? { stopDetail } : {}),
   ...(numTurns ? { numTurns } : {}),
   ...(costUsd ? { costUsd } : {}),
   ...(permissionDenials ? { permissionDenials } : {}),
   ...(usage ? { usage } : {}),
  };
 }

 /**
  * Pipe daemon-reported token counts into usage_events. Counts only — never
  * dollars (costUsd stays on job metadata). Fail-open; never blocks finalize.
  * Model comes from the result frame first (daemon knows what it ran), then
  * job/agent metadata. Non-Anthropic runtimes that omit usage simply no-op.
  */
 async function recordDaemonJobUsage(job, message, db) {
  if (typeof recordAnthropicUsage !== 'function') return null;
  const usage = daemonStopUsage(message);
  if (!usage) return null;
  const jobMeta = parseJsonObject(job && job.metadata);
  const model = String(
   (message && message.model)
   || jobMeta.model
   || (job && job.agent_model)
   || '',
  ).trim().slice(0, 120);
  if (!model || model === 'auto') return null;
  // jobDb is postgres.js-style `.unsafe`; metering expects a bare (sql, params) fn.
  const dbFn = typeof db === 'function'
   ? db
   : (db && typeof db.unsafe === 'function'
    ? (sql, params) => db.unsafe(sql, params)
    : null);
  if (!dbFn) return null;
  return recordAnthropicUsage(dbFn, {
   workspaceId: job && job.workspace_id,
   model,
   kind: 'agent_job',
   usage,
  });
 }

 // A daemon result is an untrusted websocket message. Persist only the Amp
 // fields Agensis understands, validate the opaque id, and derive the URL here
 // rather than accepting a daemon-supplied link.
 function ampResultMetadata(value) {
  const metadata = parseJsonObject(value);
  if (metadata.runtime !== 'amp') return {};
  const ampThreadId = String(metadata.ampThreadId || '').trim();
  const ampErrorCode = String(metadata.ampErrorCode || '').trim();
  return {
   runtime: 'amp',
   ...(AMP_THREAD_ID_RE.test(ampThreadId) ? {
    ampThreadId,
    ampThreadUrl: `https://ampcode.com/threads/${ampThreadId}`,
   } : {}),
   ...(AMP_ERROR_CODE_RE.test(ampErrorCode) ? { ampErrorCode } : {}),
  };
 }

 // Bind daemon-reported Amp metadata to the job that was actually dispatched.
 // A valid-looking thread id on a non-Amp result is ignored. Conversely, an Amp
 // success without a valid id (or with a different id on a continuation) is an
 // error: accepting either would make the next turn silently lose continuity.
 function validateAmpJobResult(jobMetadataValue, resultMetadata, errorText = '') {
  const jobMetadata = parseJsonObject(jobMetadataValue);
  if (jobMetadata.runtime !== 'amp') return { metadata: {}, errorText };

  const metadata = ampResultMetadata(resultMetadata);
  const expectedThreadId = AMP_THREAD_ID_RE.test(String(jobMetadata.ampThreadId || '').trim())
   ? String(jobMetadata.ampThreadId).trim()
   : '';
  const receivedThreadId = String(metadata.ampThreadId || '');
  const threadMismatch = Boolean(expectedThreadId && receivedThreadId && expectedThreadId !== receivedThreadId);
  if (!errorText && (!receivedThreadId || threadMismatch)) {
   return {
    metadata: { runtime: 'amp', ampErrorCode: 'amp_stream_invalid' },
    errorText: 'Amp completed without returning the thread linked to this conversation.',
   };
  }
  if (threadMismatch) {
   const safeMetadata = { ...metadata };
   delete safeMetadata.ampThreadId;
   delete safeMetadata.ampThreadUrl;
   return { metadata: safeMetadata, errorText };
  }
  return {
   metadata: metadata.runtime === 'amp' ? metadata : { runtime: 'amp' },
   errorText,
  };
 }

 async function finalizeAgentJobResult(job, {
  responseText = '', errorText = '', fallbackName = null, fallbackHandle = null,
  resultMetadata = null, resultStop = null,
  db = null, publish = notifyDbSubscribers, statusGuardOverride = '', afterCommit = null,
 } = {}) {
  const jobDb = db || getDb();
  // Most callers use autocommit statements, so their side effects can run
  // immediately. The daemon result path holds a wider transaction across the
  // terminal job row and transcript writes; it supplies a queue here so task
  // draining, mirroring and continuation cannot race ahead of that commit and
  // observe the old running state.
  const afterDurableWrite = typeof afterCommit === 'function'
   ? afterCommit
   : (callback) => callback();
  const jobMetadata = parseJsonObject(job.metadata);
  const validatedAmp = validateAmpJobResult(jobMetadata, resultMetadata, errorText);
  const finalErrorText = validatedAmp.errorText;
  const storedResponseText = !errorText && finalErrorText ? '' : responseText;
  const status = finalErrorText ? 'error' : 'done';
  // {} for a daemon that reported no reason, so an OLD daemon against this
  // server produces byte-identical metadata to what it produced before.
  const stopMetadata = stopResultMetadata(resultStop);
  const mergedMetadata = { ...jobMetadata, ...validatedAmp.metadata, ...stopMetadata };
  // Terminal states are monotonic. In particular, an MCP timeout is recorded as
  // `error`; a worker result arriving after that reaper commit must not resurrect
  // the job to `done` or append a second terminal transcript. Callers may narrow
  // this guard (daemon/MCP results require exactly `running`) but must never widen
  // it to a terminal state.
  const statusGuard = statusGuardOverride || "status in ('queued', 'running')";
  // Callers that need a wider authority proof (daemon/MCP) hold the live
  // session/agent/job rows in the transaction supplied as `db`. This guarded
  // transition and every transcript write below therefore commit or roll back
  // together.
  const updatedRows = await jobDb.unsafe(
    `update agent_jobs set status = $2, response = $3, error = $4, metadata = $5::jsonb, finished_at = now(), updated_at = now()
       where id = $1 and ${statusGuard} returning *`,
    [job.id, status, storedResponseText, finalErrorText, mergedMetadata],
  );
  if (updatedRows.length === 0) return null;
  publish('agent_jobs', 'UPDATE', updatedRows);

  // Meter daemon token usage when the CLI forwarded it. Awaited so a thin
  // transaction still includes the insert; recordAnthropicUsage never throws.
  await recordDaemonJobUsage(job, resultStop, jobDb);

  // The agent just freed its one active-job slot: give it the next task waiting on
  // it. Fire-and-forget, before the early returns below so farm/sessionless jobs
  // drain too — a job finishing is a job finishing.
  afterDurableWrite(() => scheduleTaskQueueDrain(job.workspace_id, job.agent_id, `job_${status}`));
  // Same moment, the other queue: a human message that arrived mid-turn is
  // waiting on this exact slot. Inside afterDurableWrite so the replay cannot see
  // the job still 'running' and immediately re-park itself.
  afterDurableWrite(() => drainPendingChatTurn(job.session_id, job.agent_id, `job_${status}`));
  // And the third thing this moment settles: if the turn ran long enough to have
  // been captured as a task, that task is still sitting in progress. Same
  // afterDurableWrite queue so it cannot commit ahead of the terminal row.
  // Only 'done' closes it — settleCapturedChatTask leaves an errored turn's task
  // open on purpose, so the failure stays visible in the list.
  afterDurableWrite(() => { void settleCapturedChatTask(job.id, status); });

  // Farm-originated coding jobs are control-plane work, not chat turns. They
  // deliberately have no session and are polled through the integration API;
  // writing a message with a null session would both violate the FK contract
  // and leak an automation result into an unrelated conversation.
  if (jobMetadata.mode === 'farm' || !job.session_id) return updatedRows[0] || null;

  const handle = job.agent_handle || fallbackHandle || slugHandle(job.agent_name);
  const senderName = job.agent_name || fallbackName || handle;
  const ampThreadLink = !finalErrorText && mergedMetadata.ampThreadUrl
   ? `\n\n[Amp thread](${mergedMetadata.ampThreadUrl})`
   : '';
  const lastSegmentText = Number(jobMetadata.segmentCount || 0) > 0
   ? textFromValue(jobMetadata.lastSegmentText).trim()
   : '';
  const finalText = textFromValue(responseText).trim();
  // This discriminator is the durable success receipt consumed by merge
  // cleanup. It is server-authored in the SAME statement that commits the
  // answer row. Failure/stop/empty-output notices stay ordinary messages, so
  // their human-readable wording can never become a data-deletion decision.
  const resultMessageKind = !finalErrorText && (finalText || lastSegmentText)
   ? 'agent_result'
   : '';
  const content = finalErrorText
   ? `@${handle} failed: ${failureSentence(mergedMetadata.stopReason, finalErrorText)}`
   : `${responseText || `@${handle} finished without output.`}${ampThreadLink}`;
  const threadParentId = jobMetadata.threadParentId || null;
  const responseMessageId = jobMetadata.responseMessageId || null;
  // "Send to channel": the agent has been working inside a thread, so THIS write is
  // the moment its answer becomes public. Flagging the row adds it to the channel
  // view without moving it out of the thread. False for a turn that was already
  // running inside a thread (nothing to broadcast) and for jobs written before this
  // feature existed, which keeps their behaviour identical.
  const broadcastToChannel = jobMetadata.broadcastToChannel === true;
  const workThreadParentId = jobMetadata.workThreadParentId || threadParentId;
  let transcriptDurable = false;

  // A placeholder can disappear while a turn is running (for example, a human
  // deletes it, or an older client never created a lazy placeholder). The job
  // result still needs one durable transcript row. This fallback deliberately
  // gets a fresh database id: reusing a tombstoned/conflicting placeholder id
  // would make ON CONFLICT look like success while preserving no visible reply.
  const insertReplacementTranscript = async (replacementContent = content) => {
   const rows = await jobDb.unsafe(
    `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel, message_kind)
        values ($1, 'assistant', $2, $3, 'agent', $4, $5, $6, $7) returning *`,
    [
     job.session_id,
     replacementContent,
     workThreadParentId,
     String(job.agent_id || ''),
     senderName,
     broadcastToChannel,
     resultMessageKind,
    ],
   );
   if (rows.length !== 1) throw new Error('Agent result transcript row was not created');
   publish('messages', 'INSERT', rows);
   afterDurableWrite(() => {
    void logMessageActivity(rows);
    void mirrorAgentReplyToTaskComment(rows[0]);
   });
   transcriptDurable = true;
   return rows;
  };
  // A segmented turn (see handleAgentJobSegment) has already posted every completed
  // text block as its own message and left a FRESH placeholder waiting for the next
  // one. A turn that ends right after a block leaves that placeholder with nothing
  // to say — the result is either empty or a repeat of the block already on screen —
  // so it is DELETED rather than left behind as an orphan "Thinking …" bubble, and
  // the block's own message stands in for it in Activity and task mirroring. A turn
  // whose tail streamed on past the last segment still lands in the placeholder as
  // before, and so does an error.
  const trailingPlaceholderIsSpent = !finalErrorText && !!lastSegmentText
   && (!finalText || finalText === lastSegmentText);
  if (responseMessageId && trailingPlaceholderIsSpent) {
   const removedRows = await jobDb.unsafe(
    'delete from messages where id = $1 and session_id = $2 and deleted_at is null returning *',
    [responseMessageId, job.session_id],
   );
   if (removedRows.length > 0) publish('messages', 'DELETE', removedRows);
   // The last completed BLOCK stands in as the turn's reply, so it is the row that
   // gets broadcast — the placeholder that would have carried the flag is gone.
   // UPDATE ... returning so the flip fans out to clients like any other change.
   const segmentRows = jobMetadata.lastSegmentMessageId
    ? await jobDb.unsafe(
     ampThreadLink
      ? `update messages
          set broadcast_to_channel = case when $3 then true else broadcast_to_channel end,
              content = case when position($4 in content) = 0 then content || $4 else content end,
              message_kind = $5
          where id = $1 and session_id = $2
            and messages.deleted_at is null
         returning *`
      : broadcastToChannel
       ? `update messages set broadcast_to_channel = true, message_kind = $3
           where id = $1 and session_id = $2
             and messages.deleted_at is null
          returning *`
       : `update messages set message_kind = $3
           where id = $1 and session_id = $2 and deleted_at is null
          returning *`,
     ampThreadLink
      ? [
       String(jobMetadata.lastSegmentMessageId),
       job.session_id,
       broadcastToChannel,
       ampThreadLink,
       resultMessageKind,
      ]
      : [String(jobMetadata.lastSegmentMessageId), job.session_id, resultMessageKind],
    )
    : [];
   if (segmentRows.length > 0) {
    transcriptDurable = true;
    publish('messages', 'UPDATE', segmentRows);
    afterDurableWrite(() => {
     void logMessageActivity(segmentRows);
     void mirrorAgentReplyToTaskComment(segmentRows[0]);
    });
   } else {
    // The metadata said a completed segment carried the answer, but its row is
    // no longer present. Preserve the work instead of committing a terminal job
    // whose transcript contains nothing.
    await insertReplacementTranscript(`${lastSegmentText || finalText || content}${ampThreadLink}`);
   }
  } else if (responseMessageId) {
   const messageRows = await jobDb.unsafe(
    `update messages set content = $2, sender_kind = 'agent', sender_id = $3, sender_name = $4,
                         broadcast_to_channel = $6, message_kind = $7
      where id = $1 and session_id = $5
        and messages.deleted_at is null
     returning *`,
    [
     responseMessageId,
     content,
     String(job.agent_id || ''),
     senderName,
     job.session_id,
     broadcastToChannel,
     resultMessageKind,
    ],
   );
   if (messageRows.length > 0) {
    transcriptDurable = true;
    publish('messages', 'UPDATE', messageRows);
    afterDurableWrite(() => {
     void logMessageActivity(messageRows);
     void mirrorAgentReplyToTaskComment(messageRows[0]);
    });
   } else if (jobMetadata.pendingPlaceholder) {
    // The placeholder was reserved by a segment but never written, because it is
    // created LAZILY by the first delta that has text for it (handleAgentJobDelta)
    // — that is what keeps an empty "Thinking …" bubble out of the thread while
    // the agent runs tools.
    //
    // If the turn ends before any such delta arrives, the UPDATE above matches
    // nothing and the reply is silently DROPPED. That took the final block of a
    // turn with it, and worse, swallowed the failure message on the error path:
    // a crashed agent said nothing at all. Materialise the row instead.
    const createdRows = await jobDb.unsafe(
     `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel, message_kind)
         values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6, $7, $8)
         on conflict (id) do nothing
         returning *`,
     [
      responseMessageId, job.session_id, content,
      jobMetadata.pendingPlaceholderParentId || workThreadParentId,
      String(job.agent_id || ''), senderName, broadcastToChannel, resultMessageKind,
     ],
    );
    if (createdRows.length > 0) {
     transcriptDurable = true;
     publish('messages', 'INSERT', createdRows);
     afterDurableWrite(() => {
      void logMessageActivity(createdRows);
      void mirrorAgentReplyToTaskComment(createdRows[0]);
     });
    } else {
     await insertReplacementTranscript();
    }
   } else {
    await insertReplacementTranscript();
   }
  } else {
   // No placeholder was ever created (an 'external' agent queued with nobody
   // attached, claimed later). The answer still belongs in the work thread, still
   // broadcast — otherwise it would land top-level and lose the thread it answered.
   // The job CAS above and this insert are one transaction on daemon/MCP paths.
   // Since the CAS no longer admits terminal rows, a retry can never reach this
   // unkeyed insert after the first transaction commits.
   await insertReplacementTranscript();
  }
  if (!transcriptDurable) throw new Error('Agent result did not produce a durable transcript row');
  // The turn is over, so nothing in it may still be counting. The branches above
  // resolve the placeholder the job was TRACKING; a segmented turn rotated through
  // others, and a tick that raced this finalization can re-create one moments after
  // it was deleted. Sweep whatever is left rather than leaving a chip ticking at a
  // run that has finished. `responseMessageId` is held back because that row now
  // holds the real reply — which, on the day an agent opens one with "Thinking 5s",
  // would otherwise match the placeholder pattern and be deleted as debris.
  await clearStrandedPlaceholders(job, responseMessageId, jobDb, publish);
  // Work asked for in a huddle outlives the call. If the huddle has since been
  // hung up, this answer landed in a transcript session nobody is watching any
  // more — so put it where the person who asked for it will actually see it.
  afterDurableWrite(() => {
   void relayEndedHuddleWorkToChannel(job, content, senderName);
   void continueConversation({ workspaceId: job.workspace_id, sessionId: job.session_id, threadParentId })
    .catch((error) => console.error('continueConversation (job finalize) failed', error));
  });
  return updatedRows[0] || null;
 }

 /**
  * Carry a finished huddle turn back into the channel the huddle was called from.
  *
  * A huddle dispatches into its OWN transcript session (huddles.transcript_session_id),
  * which is only on screen while the call is up. Ending the call therefore used to
  * strand any turn still running: the job kept going and nothing cancelled it, but
  * its answer landed in a closed room. The only trace was the channel marker's
  * "Open transcript" link — so in practice the work was done and never read.
  *
  * The answer is copied VERBATIM rather than summarised or linked: it is the work
  * product, and a pointer the reader has to click is how it got lost in the first
  * place. `huddle_id` records where it came from; no message_kind, because this is
  * an ordinary agent message in the channel and should read as one (the marker's
  * own kind is what the client renders specially).
  *
  * Only for ENDED huddles — while the call is live the transcript panel is showing
  * it already, and copying would double every answer.
  *
  * Best-effort: a turn that finished must not fail because its echo could not be
  * written.
  */
 async function relayEndedHuddleWorkToChannel(job, content, senderName) {
  try {
   if (!job || !job.session_id || !content) return null;
   const rows = await getDb().unsafe(
    `select huddles.id, huddles.session_id
       from huddles
       join chat_sessions transcript_session
         on transcript_session.id = huddles.transcript_session_id
        and transcript_session.deleted_at is null
       join chat_sessions host_session
         on host_session.id = huddles.session_id
        and host_session.deleted_at is null
      where huddles.transcript_session_id = $1
        and huddles.ended_at is not null
      order by huddles.ended_at desc
      limit 1`,
    [job.session_id],
   );
   const huddle = rows[0];
   // No row means this session is not a huddle transcript, or its huddle is still
   // live. Either way there is nothing to carry.
   if (!huddle || !huddle.session_id) return null;
   // A huddle whose transcript IS its host channel (older huddles had no separate
   // transcript session) would otherwise get the answer twice in one place.
   if (huddle.session_id === job.session_id) return null;
   const inserted = await getDb().unsafe(
    `insert into messages (session_id, role, content, sender_kind, sender_id, sender_name, huddle_id)
        values ($1, 'assistant', $2, 'agent', $3, $4, $5) returning *`,
    [huddle.session_id, content, String(job.agent_id || ''), senderName, huddle.id],
   );
   if (inserted[0]) {
    notifyDbSubscribers('messages', 'INSERT', inserted);
    void logMessageActivity(inserted);
   }
   return inserted[0] || null;
  } catch (error) {
   console.warn('[agent-jobs] could not carry huddle work into the channel:', (error && error.message) || error);
   return null;
  }
 }

 function publicFarmAgentJob(job) {
  if (!job) return null;
  return {
   id: job.id,
   workspaceId: job.workspace_id,
   agentId: job.agent_id,
   connectionId: job.connection_id,
   sessionId: job.session_id || null,
   prompt: job.prompt || '',
   status: job.status,
   response: job.response || '',
   error: job.error || '',
   metadata: parseJsonObject(job.metadata),
   startedAt: job.started_at || null,
   finishedAt: job.finished_at || null,
   createdAt: job.created_at || null,
   updatedAt: job.updated_at || null,
  };
 }

 async function dispatchFarmAgentJob({ workspaceId, agentId, prompt, model = '', permissionMode = '', cwd = '', connection = null } = {}) {
  if (!workspaceId || !agentId || !String(prompt || '').trim()) throw badRequest('workspaceId, agentId, and prompt are required');
  const agentRows = await getDb().unsafe(
   'select * from workspace_agents where id = $1 and workspace_id = $2 limit 1',
   [String(agentId), String(workspaceId)],
  );
  const agent = agentRows[0];
  if (!agent || !isAgentEnabled(agent) || agent.run_mode !== 'daemon') throw badRequest('Farm jobs require an enabled Relay agent');
  const target = connection || findConnectedAgent(String(workspaceId), String(agentId), agent.handle || agent.name);
  if (!target) throw Object.assign(new Error('The selected Relay host is offline'), { status: 503, code: 'agent_offline' });
  if (target.capabilities?.codingRoute === false) {
   throw Object.assign(new Error('The selected agent does not advertise coding support'), { status: 409, code: 'coding_route_unavailable' });
  }
  const metadata = { mode: 'farm', source: 'agensis-farm', cwd: String(cwd || '').slice(0, 1000) || null };
  const jobRows = await getDb().begin(async (tx) => {
   // Sessionless Farm jobs cannot use the normal partial uniqueness constraint.
   // A transaction-scoped advisory lock makes the check+insert atomic across all
   // server processes without runtime DDL. Include workspace to avoid cross-
   // workspace UUID assumptions and keep the chosen connection on the row.
   await tx.unsafe(
    'select pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`farm:${String(workspaceId)}:${String(agentId)}`],
   );
   const active = await tx.unsafe(
    `select * from agent_jobs
       where workspace_id = $1 and agent_id = $2
         and session_id is null and (metadata->>'mode') = 'farm'
         and status in ('queued', 'running')
       limit 1`,
    [String(workspaceId), String(agentId)],
   );
   if (active[0]) {
    throw Object.assign(new Error('The selected Relay agent is already running a Farm job'), {
     status: 409,
     code: 'agent_busy',
    });
   }
   return tx.unsafe(
    `insert into agent_jobs (workspace_id, agent_id, connection_id, session_id, prompt, status, started_at, metadata)
       values ($1, $2, $3, null, $4, 'running', now(), $5::jsonb) returning *`,
    [String(workspaceId), String(agentId), target.connectionId, String(prompt).trim(), metadata],
   );
  });
  const job = jobRows[0];
  notifyDbSubscribers('agent_jobs', 'INSERT', jobRows);
  const agentPayload = agentRuntimePayload(agent);
  const requestedPermission = permissionMode ? normalizeAgentPermissionMode(permissionMode) : agentPayload.permissionMode;
  const sent = sendWs(target.ws, {
   type: 'agent_job',
   job: {
    id: job.id,
    workspaceId: String(workspaceId),
    sessionId: null,
    threadParentId: null,
    prompt: String(prompt).trim(),
    cwd: String(cwd || '').trim() || null,
    handle: slugHandle(agent.handle || agent.name),
    model: String(model || '').trim() || agentPayload.model,
    permissionMode: requestedPermission,
    permission_mode: requestedPermission,
    permissionFlags: agentPermissionFlags(requestedPermission),
    agent: { ...agentPayload, model: String(model || '').trim() || agentPayload.model, permissionMode: requestedPermission, permission_mode: requestedPermission },
   },
  });
  if (!sent) {
   const failed = await getDb().unsafe(
    `update agent_jobs set status = 'error', error = 'Agent connection could not accept the job', finished_at = now(), updated_at = now()
        where id = $1 and status = 'running' returning *`,
    [job.id],
   );
   notifyDbSubscribers('agent_jobs', 'UPDATE', failed);
   throw Object.assign(new Error('The selected agent connection could not accept the job'), { status: 503, code: 'agent_offline' });
  }
  await updateAgentHeartbeat(target.ws, { busy: true }).catch(() => { });
  return publicFarmAgentJob(job);
 }

 async function getFarmAgentJob({ workspaceId, jobId } = {}) {
  const rows = await getDb().unsafe(
   `select * from agent_jobs where id = $1 and workspace_id = $2 and (metadata->>'mode') = 'farm' limit 1`,
   [String(jobId || ''), String(workspaceId || '')],
  );
  if (!rows[0]) throw Object.assign(new Error('Farm job was not found'), { status: 404 });
  return publicFarmAgentJob(rows[0]);
 }

 async function cancelFarmAgentJob({ workspaceId, jobId, connection = null } = {}) {
  const rows = await getDb().unsafe(
   `select * from agent_jobs where id = $1 and workspace_id = $2 and (metadata->>'mode') = 'farm' limit 1`,
   [String(jobId || ''), String(workspaceId || '')],
  );
  const job = rows[0];
  if (!job) throw Object.assign(new Error('Farm job was not found'), { status: 404 });
  if (!['queued', 'running'].includes(job.status)) return publicFarmAgentJob(job);
  const updated = await getDb().unsafe(
   `update agent_jobs set status = 'cancelled', error = 'Cancelled by Farm', finished_at = now(), updated_at = now()
      where id = $1 and status in ('queued', 'running') returning *`,
   [job.id],
  );
  if (updated.length === 0) {
   const current = await getDb().unsafe(
    `select * from agent_jobs where id = $1 and workspace_id = $2 and (metadata->>'mode') = 'farm' limit 1`,
    [job.id, String(workspaceId || '')],
   );
   return publicFarmAgentJob(current[0] || job);
  }
  notifyDbSubscribers('agent_jobs', 'UPDATE', updated);
  // Cancelling frees the agent exactly like finishing does.
  scheduleTaskQueueDrain(job.workspace_id, job.agent_id, 'job_cancelled');
  const exactConnection = getConnectedAgents().get(job.connection_id);
  const target = connection || (exactConnection?.ws?.readyState === 1 ? exactConnection : null) || findConnectedAgent(String(workspaceId), String(job.agent_id), '');
  if (target) sendWs(target.ws, { type: 'agent_job_cancel', jobId: job.id, reason: 'Cancelled by Farm' });
  return publicFarmAgentJob(updated[0] || { ...job, status: 'cancelled', error: 'Cancelled by Farm' });
 }

 async function handleAgentJobResult(ws, message) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const jobId = String(message.jobId || '');
  if (!jobId) throw badRequest('jobId is required');
  // A cancelled control-plane job may still race with process teardown and
  // report one final result. Cancellation is authoritative; discard the late
  // frame rather than changing it back to done/error.
  const diagnosticRows = await getDb().unsafe(
   `select status from agent_jobs
      where id = $1 and agent_id = $2 and workspace_id = $3 and connection_id = $4 limit 1`,
   [jobId, auth.agentId, auth.workspaceId, ws.agentConnectionId],
  );
  if (diagnosticRows[0]?.status === 'cancelled') {
   await updateAgentHeartbeat(ws, { busy: false }).catch(() => { });
   return;
  }
  await withCurrentDaemonJob(ws, jobId, ({ tx, job, publishAfterCommit, afterCommit }) => (
   finalizeAgentJobResult(job, {
    // Classic daemon sends `response`. Desktop ACP v0.1 mistakenly sent only
    // `content` (which deltas use); accept both so a final frame cannot wipe a
    // live stream with "finished without output". Prefer the frame body; if both
    // are empty, keep whatever the last delta wrote on the job row.
    responseText: (
     textFromValue(message.response).trim()
     || textFromValue(message.content).trim()
     || textFromValue(job.response).trim()
    ),
    errorText: textFromValue(message.error).trim(),
    fallbackName: auth.name,
    fallbackHandle: auth.handle,
    resultMetadata: message.metadata,
    // Untrusted, validated in stopResultMetadata. The whole frame is passed
    // rather than pre-picked fields so there is one validator, not two.
    resultStop: message,
    db: tx,
    publish: publishAfterCommit,
    afterCommit,
    // The locked scope admitted a running job. The terminal CAS must preserve a
    // cancellation even if this helper is changed to use a weaker lock later.
    statusGuardOverride: "status = 'running'",
   })
  ), { allowSessionlessFarm: true });
  await updateAgentHeartbeat(ws, { busy: false }).catch(() => { });
 }

 // --- MCP pull worker API (backs the claim_job / submit_job_result tools) ----------
 // A client working AS an agent polls claimMcpJob; the poll refreshes presence (so
 // dispatch keeps enqueuing) and atomically claims the oldest queued MCP job for that
 // agent. FOR UPDATE SKIP LOCKED means N clients polling as the same agent never double-
 // claim — that's how "3× Q" share one queue.
 async function claimMcpJob({ workspaceId, agentId }) {
  if (!agentId) return null;
  touchMcpPresence(agentId);
  const claimed = await getDb().unsafe(
   `with claimable_job as materialized (
      select j.id, to_jsonb(a) as current_agent
        from agent_jobs j
        join chat_sessions s
          on s.id = j.session_id
         and s.workspace_id = j.workspace_id
         and s.deleted_at is null
        join workspace_agents a
          on a.id = j.agent_id
         and a.workspace_id = j.workspace_id
         and a.enabled is true
         and a.mcp_approved is true
       where j.workspace_id = $1
         and j.agent_id = $2
         and j.status = 'queued'
         and (j.metadata->>'mode') = 'mcp'
         and exists (
           select 1
             from jsonb_array_elements(
               case when jsonb_typeof(s.participants) = 'array'
                    then s.participants else '[]'::jsonb end
             ) participant
            where participant->>'agent_id' = a.id::text
         )
       order by j.created_at asc
       limit 1
       for update of j, s, a skip locked
    )
    update agent_jobs j
       set status = 'running', started_at = now(), updated_at = now()
      from claimable_job current_job
     where j.id = current_job.id
       and j.status = 'queued'
    returning j.*, current_job.current_agent`,
   [workspaceId, agentId],
  );
  const claimedRow = claimed[0];
  if (!claimedRow) return null;
  const currentAgent = parseJsonObject(claimedRow.current_agent);
  const { current_agent: _currentAgent, ...job } = claimedRow;
  if (!job) return null;
  // `current_agent` is a private proof artifact from the locking CTE, not an
  // agent_jobs column. Never fan the full agent row out on the jobs channel.
  notifyDbSubscribers('agent_jobs', 'UPDATE', [job]);
  const meta = parseJsonObject(job.metadata);
  // This is the point the external worker actually receives the prompt. The id
  // was captured with that prompt; resolving "latest" now would claim messages
  // that arrived while the job sat queued.
  await advanceAgentReadMarker(
   job.session_id,
   job.agent_id,
   meta.lastSeenMessageId,
   meta.readScopeThreadParentId || null,
  );
  return {
   jobId: job.id,
   prompt: job.prompt || '',
   sessionId: job.session_id,
   threadParentId: meta.threadParentId || null,
   agent: currentAgent.id ? agentRuntimePayload(currentAgent) : null,
  };
 }

 async function submitMcpJobResult({ workspaceId, agentId, jobId, responseText = '', errorText = '' }) {
  if (!jobId) throw badRequest('jobId is required');
  if (!agentId) throw badRequest('Agent job not found');
  const status = errorText ? 'error' : 'done';
  const pendingFanout = [];
  const pendingAfterCommit = [];
  // Lock/prove the live MCP scope, rewrite (or replace) its transcript row, and
  // transition the job in ONE transaction. The old path committed the terminal
  // job first and only then touched the placeholder; a transient transcript
  // failure made the result unretryable while the conversation stayed on
  // "Thinking …" forever. A failure below now rolls the job back to its
  // awaiting state, so submitting the same result again is safe.
  const outcome = await getDb().begin(async (tx) => {
   const currentRows = await tx.unsafe(
    `select j.*, a.name as agent_name, a.handle as agent_handle
       from agent_jobs j
       join chat_sessions s
         on s.id = j.session_id
        and s.workspace_id = j.workspace_id
        and s.deleted_at is null
       join workspace_agents a
         on a.id = j.agent_id
        and a.workspace_id = j.workspace_id
        and a.enabled is true
        and a.mcp_approved is true
      where j.id = $1
        and j.workspace_id = $2
        and j.agent_id = $3
        and j.status = 'running'
        and (j.metadata->>'mode') = 'mcp'
        and exists (
          select 1
            from jsonb_array_elements(
              case when jsonb_typeof(s.participants) = 'array'
                   then s.participants else '[]'::jsonb end
            ) participant
           where participant->>'agent_id' = a.id::text
        )
      limit 1
      for update of j, s, a`,
    [jobId, workspaceId, agentId],
   );
   const current = currentRows[0];
   if (!current) return null;
   const publishAfterCommit = (table, eventType, rows) => {
    if (Array.isArray(rows) && rows.length > 0) pendingFanout.push([table, eventType, rows]);
   };
   const afterCommit = (callback) => {
    if (typeof callback === 'function') pendingAfterCommit.push(callback);
   };
   const finalized = await finalizeAgentJobResult(current, {
    responseText,
    errorText,
    db: tx,
    publish: publishAfterCommit,
    afterCommit,
    statusGuardOverride: "status = 'running'",
   });
   if (!finalized) throw new Error('MCP job result could not be finalized');
   return finalized;
  });
  if (!outcome) {
   // Preserve the route's useful diagnostics without using a stale preflight
   // read as authority. This SELECT explains a failed CAS; it never authorizes a
   // write and deliberately cannot turn a zero-row proof into success.
   const currentRows = await getDb().unsafe(
    `select status, metadata from agent_jobs
       where id = $1 and workspace_id = $2 and agent_id = $3 limit 1`,
    [jobId, workspaceId, agentId],
   );
   const current = currentRows[0];
   if (!current) throw badRequest('Agent job not found');
   if (parseJsonObject(current.metadata).mode !== 'mcp') throw badRequest('Job is not an MCP job');
   if (current.status !== 'running') {
    throw badRequest(`Job is ${current.status}, not awaiting a result`);
   }
   throw badRequest('Agent job is no longer attached to a live approved session');
  }
  publishCommittedFanout(pendingFanout);
  for (const callback of pendingAfterCommit) {
   try {
    callback();
   } catch (error) {
    console.error('MCP job post-commit callback failed', error);
   }
  }
  touchMcpPresence(agentId); // a submitting client is alive
  return { jobId: outcome.id, status };
 }

 // Backstop: an MCP job whose client vanished mid-flight (or nobody ever claimed it)
 // gets finalized with an error so the chat doesn't hang on "Thinking …".
 async function reapStuckMcpJobs() {
  try {
   const rows = await getDb().unsafe(
    // Time out on run duration (started_at), not creation, so a legitimately
    // long coding/research turn isn't force-failed just because it queued for
    // a while first; queued-but-never-claimed jobs fall back to created_at.
    // (M3, 2026-07 review — mirrors the daemon's started_at-based reaper.)
    `select j.*, a.name as agent_name, a.handle as agent_handle
        from agent_jobs j left join workspace_agents a on a.id = j.agent_id
        where (j.metadata->>'mode') = 'mcp' and j.status in ('queued', 'running')
          and coalesce(j.started_at, j.created_at) < now() - interval '240 seconds'`,
   );
   for (const job of rows) {
    const pendingFanout = [];
    const pendingAfterCommit = [];
    try {
     const finalized = await getDb().begin(async (tx) => {
      const currentRows = await tx.unsafe(
       `select j.*, a.name as agent_name, a.handle as agent_handle
          from agent_jobs j
          join chat_sessions s
            on s.id = j.session_id
           and s.workspace_id = j.workspace_id
           and s.deleted_at is null
          left join workspace_agents a on a.id = j.agent_id
         where j.id = $1
           and (j.metadata->>'mode') = 'mcp'
           and j.status in ('queued', 'running')
         for update of j, s`,
       [job.id],
      );
      const current = currentRows[0];
      if (!current) return null;
      const publishAfterCommit = (table, eventType, eventRows) => {
       if (Array.isArray(eventRows) && eventRows.length > 0) {
        pendingFanout.push([table, eventType, eventRows]);
       }
      };
      const afterCommit = (callback) => {
       if (typeof callback === 'function') pendingAfterCommit.push(callback);
      };
      return finalizeAgentJobResult(current, {
       errorText: 'the MCP client stopped responding',
       db: tx,
       publish: publishAfterCommit,
       afterCommit,
       statusGuardOverride: "status in ('queued', 'running')",
      });
     });
     if (!finalized) continue;
     publishCommittedFanout(pendingFanout);
     for (const callback of pendingAfterCommit) callback();
    } catch {
     // Leave the job awaiting a result. The next sweep retries the whole atomic
     // finalization; committing terminal state without its failure transcript is
     // worse than a delayed timeout card.
    }
   }
  } catch {
   // best effort
  }
 }

 async function handleAgentJobDelta(ws, message) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const jobId = String(message.jobId || '');
  if (!jobId) throw badRequest('jobId is required');
  const wrote = await withCurrentDaemonJob(ws, jobId, async ({ tx, job, publishAfterCommit, afterCommit }) => {
  const metadata = parseJsonObject(job.metadata);
  const responseMessageId = metadata.responseMessageId || null;
  const deltaText = textFromValue(message.content ?? message.response ?? '').trim();
  // lastDeltaAt marks "the daemon is alive"; lastContentAt marks "the agent produced
  // something". Only the latter counts as progress for the stuck-job reaper — a
  // waiting daemon ticks once a second with empty content, and treating that as
  // progress is what let a wedged turn spin forever.
  const nextMetadata = {
   ...metadata,
   lastDeltaAt: new Date().toISOString(),
   elapsedMs: Number(message.elapsedMs || 0),
  };
  if (deltaText) nextMetadata.lastContentAt = nextMetadata.lastDeltaAt;
  // Content-free ticks are pure liveness (lastDeltaAt above). Rewriting
  // messages.content every second as "Thinking Ns" forced full-row fanout +
  // agent-status at ~1 Hz for a clock digit. Throttle display rewrites to 10s;
  // text deltas still apply immediately. lastClockAt rides the job metadata
  // write so the throttle survives restarts without a second UPDATE.
  const CLOCK_MESSAGE_THROTTLE_MS = 10_000;
  let skipClockMessageUpdate = false;
  if (!deltaText && responseMessageId) {
   const lastClockMs = Date.parse(String(metadata.lastClockAt || '')) || 0;
   if (Date.now() - lastClockMs < CLOCK_MESSAGE_THROTTLE_MS) {
    skipClockMessageUpdate = true;
   } else {
    nextMetadata.lastClockAt = nextMetadata.lastDeltaAt;
   }
  }
  const deltaRows = await tx.unsafe(
   `update agent_jobs
      set response = $2,
          updated_at = now(),
          metadata = $3::jsonb
      where id = $1 and status = 'running'
        and connection_id = $5
        and (jsonb_typeof(metadata) <> 'object'
             or coalesce(metadata->>'responseMessageId', '') = $4)
      returning id`,
   [
    jobId,
    deltaText,
    // Write the whole merged object rather than SQL-side `metadata || patch`.
    // `||` only merges when BOTH sides are jsonb objects; a metadata column that
    // was double-encoded into a jsonb STRING scalar appends instead, turning the
    // column into an array — after which metadata->>'mode' and
    // metadata->>'lastContentAt' both read NULL in SQL. `metadata` here comes from
    // parseJsonObject(), which already flattens that corruption back into an
    // object, so writing it wholesale also self-heals any row still in the bad
    // shape. Pass the OBJECT: postgres.js encodes it as real jsonb, whereas a
    // JSON.stringify'd value re-creates the string-scalar bug.
    nextMetadata,
    // Compare-and-set on the placeholder this tick was written against. The write
    // above is a WHOLESALE object (see the note directly above — it has to stay that
    // way to keep self-healing a corrupted column), so a tick that read the job just
    // before a concurrent `agent_job_segment` rotated the placeholder would REVERT
    // that rotation, and then stream "Thinking Ns" over the text block the segment
    // had only just finalised. That is precisely how a live-looking chip ended up
    // stranded where an agent's reply should have been, taking the reply with it.
    // Dropping the tick instead costs nothing — another lands a second later.
    //
    // The `jsonb_typeof` escape keeps the self-heal reachable: a column corrupted
    // into a string scalar reads NULL for every key, so a strict comparison would
    // wedge the job permanently in the one state that most needs repairing.
    responseMessageId || '',
    ws.agentConnectionId,
   ],
  );
  // Either the job already finished, or a segment moved the placeholder on between
  // the read above and this write. Everything below is stale either way.
  if (deltaRows.length === 0) return false;
  if (responseMessageId && !skipClockMessageUpdate) {
   const content = agentLiveMessageContent(message);
   const updatedRows = await tx.unsafe(
    `update messages
        set content = $2,
            sender_kind = 'agent',
            sender_id = $3,
            sender_name = $4
        where id = $1 and session_id = $5 and deleted_at is null
          and ($6::boolean or content ~ $7)
        returning *`,
    [
     responseMessageId, content, String(job.agent_id || ''),
     job.agent_name || auth.name || auth.handle || 'Agent', job.session_id,
     // A tick carrying TEXT owns the row and overwrites whatever is in it. A
     // content-free liveness tick carries nothing but a clock, so it may only
     // refresh a row that is STILL a placeholder — never overwrite words already on
     // screen. The window is narrow (a segment finalising the block between this
     // handler's two statements) but it is exactly the one that turned a finished
     // paragraph back into "Thinking 2m 11s" and left it standing there.
     deltaText.length > 0,
     PLACEHOLDER_CONTENT_RE,
    ],
   );
   if (updatedRows.length > 0) {
    publishAfterCommit('messages', 'UPDATE', updatedRows);
    // Live huddle: push completed sentences so Cartesia can start without
    // waiting on this fanout. Gated by metadata.voiceHuddle (set at job create).
    if (deltaText && metadata.voiceHuddle === true) {
     const prevVoice = String(metadata.voiceSpokenPrefix || '');
     const voiceArgs = {
      workspaceId: String(job.workspace_id || ''),
      sessionId: String(job.session_id || ''),
      messageId: String(responseMessageId),
      agentId: String(job.agent_id || ''),
      agentName: job.agent_name || auth.name || auth.handle || 'Agent',
      fullText: deltaText,
      previousSpoken: prevVoice,
      jobId: String(jobId),
     };
     afterCommit(() => {
      void publishHuddleVoiceText(voiceArgs).then((nextVoice) => {
       if (typeof nextVoice !== 'string' || nextVoice === prevVoice) return;
       return getDb().unsafe(
        `update agent_jobs
            set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
                updated_at = now()
          where id = $1 and status = 'running'`,
        [jobId, { voiceSpokenPrefix: nextVoice }],
       );
      }).catch(() => { /* durable path remains the fallback */ });
     });
    }
   } else if (metadata.pendingPlaceholder && deltaText) {
    // A segment handed us an id but deliberately did not create the row, so the
    // thread is not littered with empty "Thinking …" bubbles while the agent runs
    // tools. This is the first content for that block: materialise it now.
    //
    // `deltaText` is the whole of "lazily". Without it, a content-free tick
    // materialised the row as "Thinking Ns" — re-creating the very bubble lazy
    // creation exists to prevent, and minting the row that then strands when the
    // turn rotates past it.
    const createdRows = await tx.unsafe(
     `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
        values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6)
        on conflict (id) do nothing
        returning *`,
     [
      responseMessageId, job.session_id, content,
      metadata.pendingPlaceholderParentId || null,
      String(job.agent_id || ''), job.agent_name || auth.name || auth.handle || 'Agent',
     ],
    );
    if (createdRows.length > 0) publishAfterCommit('messages', 'INSERT', createdRows);
   }
  }
  return true;
  }, { allowSessionlessFarm: true });
  if (wrote) await updateAgentHeartbeat(ws, { busy: true }).catch(() => { });
 }

 // The two halves of a step, normalized to one clipped line each: the tool name
 // (`Read`) and its detail (`src/App.tsx`). Stored as their own columns so the UI
 // can render a compact chip instead of re-parsing the joined `content` line.
 function agentStepParts(message) {
  const name = textFromValue(message?.name).replace(/\s+/g, ' ').trim();
  const rawDetail = textFromValue(message?.detail).replace(/\s+/g, ' ').trim();
  const detail = rawDetail.length > 160 ? `${rawDetail.slice(0, 159)}…` : rawDetail;
  return { name, detail };
 }

 // Render one step as a single plain-text line, e.g. `Read · src/App.tsx`. Either
 // half may be missing (a tool with no arguments, or a daemon that sent no detail);
 // a step carrying neither is not worth a message. This stays the human-readable
 // FALLBACK: clients that predate tool_name/tool_detail (and rows inserted before
 // those columns existed) still read sensibly off `content` alone.
 function agentStepContent(message) {
  const { name, detail } = agentStepParts(message);
  if (name && detail) return `${name} · ${detail}`;
  return name || detail;
 }

 // A daemon turn that reads files, greps and runs bash produces no text at all, so
 // the delta pump (text only) leaves the human staring at the "Thinking …"
 // placeholder in silence. Each step lands as its OWN message threaded under the
 // agent's reply — one row per round trip, never an update of the placeholder.
 async function handleAgentJobStep(ws, message) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const jobId = String(message.jobId || '');
  if (!jobId) throw badRequest('jobId is required');
  const content = agentStepContent(message);
  if (!content) return;
  const step = agentStepParts(message);
  return withCurrentDaemonJob(ws, jobId, async ({ tx, job, publishAfterCommit }) => {
  const metadata = parseJsonObject(job.metadata);
  // Steps hang off the reply's THREAD ROOT, not off the reply itself. The
  // "Thinking …" placeholder is itself a thread reply (a channel turn works in the
  // thread on the human's message — see resolveWorkThreadParent — and a thread turn
  // already did), so parenting steps to it buried them two levels deep: the thread
  // panel renders one level, so every chip was invisible exactly when the human was
  // watching the thread. Resolving to the placeholder's own parent keeps steps as
  // its SIBLINGS, in the thread already on screen — the same thread the reply will
  // be broadcast from. A placeholder with no parent at all (a session with nothing
  // to hang a work thread off) still nests steps directly under it as before.
  // Missing responseMessageId means the reply bubble is unknown; post the step at
  // the top level rather than dropping it.
  const responseMessageId = metadata.responseMessageId || null;
  // responseMessageId comes from JOB METADATA, i.e. from the daemon, i.e. from a
  // client. The lookup below asked whether that row has a PARENT, and answered
  // "no parent" identically whether the row has none or the row does not exist —
  // so a stale or optimistic id fell through and was written straight into
  // thread_parent_id, which is a foreign key. Every tool step in the job then
  // died on messages_thread_parent_id_fkey.
  //
  // Now existence and parentage are one question: no row means no parent id at
  // all, and the step posts at the top level. A step that cannot be nested is
  // still worth showing; a step that cannot be WRITTEN is lost.
  let threadParentId = null;
  if (responseMessageId) {
   const parentRows = await tx.unsafe(
    'select thread_parent_id from messages where id = $1 and session_id = $2 and deleted_at is null limit 1',
    [responseMessageId, job.session_id],
   );
   if (parentRows[0]) {
    threadParentId = parentRows[0].thread_parent_id || responseMessageId;
   }
  }
  // The placeholder is GONE, not merely unknown: a segment rotates it every text
  // block, and clearStrandedPlaceholders removes leftovers, so a long turn spends
  // real time pointing at a row that no longer exists. Falling flat here dumped
  // every tool chip into the DM root while the same turn's text sat correctly in
  // the thread — the work split across two places, and the thread looking idle
  // while the channel filled with context-free chips.
  //
  // metadata.workThreadParentId is the same fallback handleAgentJobSegment has
  // used all along (see the block above the segment insert); the step path never
  // got it. Verified against a real row in THIS session before it can reach the
  // foreign key, so an unknown id still posts flat rather than killing the write.
  if (!threadParentId) {
   threadParentId = await verifyThreadParent(
    metadata.workThreadParentId || metadata.threadParentId || null,
    job.session_id,
   );
  }
  // A tool step is the agent demonstrably doing work, so — unlike a content-free
  // "Thinking Ns" liveness tick — it counts as progress for the stuck-job reaper
  // and sets lastContentAt exactly like a content-bearing delta does. `response` is
  // deliberately left alone: only the delta pump and the final result own it.
  const nextMetadata = {
   ...metadata,
   lastDeltaAt: new Date().toISOString(),
   elapsedMs: Number(message.elapsedMs || 0),
  };
  nextMetadata.lastContentAt = nextMetadata.lastDeltaAt;
  const stepRows = await tx.unsafe(
   `update agent_jobs
      set updated_at = now(),
          metadata = $2::jsonb
      where id = $1 and status = 'running'
        and connection_id = $4
        and (jsonb_typeof(metadata) <> 'object'
             or coalesce(metadata->>'responseMessageId', '') = $3)
      returning id`,
   // Bind the merged OBJECT, never JSON.stringify — a stringified bind becomes a
   // jsonb string scalar and corrupts the column (see handleAgentJobDelta).
   //
   // Compare-and-set for the same reason as the delta pump: this is a wholesale
   // object write, and steps fire every few seconds, so a step that read the job
   // just before a segment rotated the placeholder would silently put the OLD id
   // back — after which the next liveness tick streams "Thinking Ns" over the block
   // the segment had just finalised.
   [jobId, nextMetadata, responseMessageId || '', ws.agentConnectionId],
  );
  // The job already finished, or a segment moved the placeholder on under us. The
  // step's thread parent was resolved from the old placeholder either way, so it
  // would land in the wrong place.
  if (stepRows.length === 0) return;
  const messageRows = await tx.unsafe(
   `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail)
      values ($1, 'assistant', $2, $3, 'agent', $4, $5, 'tool_step', $6, $7) returning *`,
   [job.session_id, content, threadParentId, String(job.agent_id || ''), job.agent_name || auth.name || auth.handle || 'Agent', step.name, step.detail],
  );
  publishAfterCommit('messages', 'INSERT', messageRows);
  });
 }

 // An agent turn is really [text][tool][text][tool][text]. The delta pump owns ONE
 // placeholder for the WHOLE turn, so every text block was concatenated into a
 // single ever-growing bubble — five separate thoughts run together with no
 // boundary the human could read, let alone steer between. `agent_job_segment`
 // says "that text block is finished": the current placeholder is finalised with
 // the block's text (it becomes a normal, complete agent message) and a FRESH
 // placeholder takes its place for the next block. Deltas, steps and segments that
 // follow flow into the new one, so the turn renders as message · chips · message
 // instead of one bubble that grows.
 async function handleAgentJobSegment(ws, message) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const jobId = String(message.jobId || '');
  if (!jobId) throw badRequest('jobId is required');
  const text = textFromValue(message.text ?? message.content ?? message.response).trim();
  if (!text) return; // an empty block is not a message; never rotate the placeholder on one
  return withCurrentDaemonJob(ws, jobId, async ({ tx, job, publishAfterCommit }) => {
  const metadata = parseJsonObject(job.metadata);
  const responseMessageId = metadata.responseMessageId || null;
  const nextPlaceholderId = crypto.randomUUID();
  // Where the block itself lands: normally the placeholder that has been streaming
  // it (now final). A job with no placeholder at all still gets its own message
  // rather than losing the text.
  const blockMessageId = responseMessageId || crypto.randomUUID();
  // A completed text block is the agent demonstrably producing output, so it counts
  // as progress for the stuck-job reaper exactly like a tool step does.
  // lastSegmentText/lastSegmentMessageId let finalizeAgentJobResult recognise a final
  // result that merely repeats the block already on screen. `response` is deliberately
  // left alone: only the delta pump and the final result own it.
  const nextMetadata = {
   ...metadata,
   responseMessageId: nextPlaceholderId,
   lastDeltaAt: new Date().toISOString(),
   elapsedMs: Number(message.elapsedMs || 0),
   segmentCount: Number(metadata.segmentCount || 0) + 1,
   lastSegmentText: text,
   lastSegmentMessageId: blockMessageId,
  };
  nextMetadata.lastContentAt = nextMetadata.lastDeltaAt;
  const segmentRows = await tx.unsafe(
   `update agent_jobs
      set updated_at = now(),
          metadata = $2::jsonb
      where id = $1 and status = 'running'
        and connection_id = $3
      returning id`,
   // Bind the merged OBJECT, never JSON.stringify — a stringified bind becomes a
   // jsonb string scalar and corrupts the column (see handleAgentJobDelta).
   [jobId, nextMetadata, ws.agentConnectionId],
  );
  if (segmentRows.length === 0) return; // the job already finished; the segment is stale
  const senderName = job.agent_name || auth.name || auth.handle || 'Agent';
  // Blocks and the next placeholder belong in the WORK thread, not at the dispatch
  // level: a channel turn works inside the thread on the human's message and only
  // its final answer is broadcast, so falling back to metadata.threadParentId (null
  // for a channel turn) would drop every intermediate block into the channel. The
  // row-derived parent below still wins whenever a placeholder exists.
  // Same disease as the tool-step path: these ids come from job metadata, i.e.
  // from the daemon. Verified against a real row in THIS session before any of
  // them reaches the foreign key; an unknown id posts flat rather than killing
  // the write.
  let threadParentId = await verifyThreadParent(
   metadata.workThreadParentId || metadata.threadParentId || null,
   job.session_id,
  );
  if (responseMessageId) {
   const finalizedRows = await tx.unsafe(
    `update messages
        set content = $2,
            sender_kind = 'agent',
            sender_id = $3,
            sender_name = $4
        where id = $1 and session_id = $5 and deleted_at is null
        returning *`,
    [responseMessageId, text, String(job.agent_id || ''), senderName, job.session_id],
   );
   if (finalizedRows.length > 0) {
    publishAfterCommit('messages', 'UPDATE', finalizedRows);
    // The replacement has to sit in exactly the same place as the message it
    // succeeds, so read the parent off the row instead of recomputing one: inside
    // a thread the placeholder is itself a reply (the same reason a tool step
    // resolves the thread root from this column rather than assuming top level).
    threadParentId = finalizedRows[0].thread_parent_id || null;
   } else if (metadata.pendingPlaceholder) {
    // The previous segment reserved this id but deliberately left the row
    // unwritten (see the lazy placeholder note below). If the agent produced a
    // second text block without any delta in between, the UPDATE above matches
    // nothing and the block is silently DROPPED — a turn of three blocks showed
    // only the first. Write the row this segment was going to finalise.
    const blockRows = await tx.unsafe(
     `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
        values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6)
        on conflict (id) do nothing
        returning *`,
     [
      responseMessageId, job.session_id, text,
      metadata.pendingPlaceholderParentId || threadParentId,
      String(job.agent_id || ''), senderName,
     ],
    );
    if (blockRows.length > 0) {
     publishAfterCommit('messages', 'INSERT', blockRows);
     threadParentId = blockRows[0].thread_parent_id || null;
    }
   }
  } else {
   const blockRows = await tx.unsafe(
    `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
       values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6) returning *`,
    [blockMessageId, job.session_id, text, threadParentId, String(job.agent_id || ''), senderName],
   );
   publishAfterCommit('messages', 'INSERT', blockRows);
  }
  // The next placeholder is created LAZILY, by the first delta that actually has
  // text for it (see handleAgentJobDelta). Creating it here left a visible
  // "Thinking 29s" bubble sitting in the thread for as long as the agent spent on
  // tool calls between two text blocks — a real turn produced three of them. The
  // id and parent are recorded on the job so the delta can materialise the row in
  // the right place when there is finally something to show.
  //
  // Written as a SECOND update rather than folded into the one above, because the
  // parent is only known once the block's own row has been written and we can read
  // it back. Build a fresh object rather than mutating `nextMetadata` — that one
  // was already bound by the first statement, and mutating it after the fact is a
  // trap waiting for anyone who later reads the bind back.
  await tx.unsafe(
   `update agent_jobs
      set updated_at = now(),
          metadata = $2::jsonb
      where id = $1 and status = 'running'
        and connection_id = $3
      returning id`,
   // Bind the merged OBJECT, never JSON.stringify — a stringified bind becomes a
   // jsonb STRING scalar, after which metadata->>'…' reads NULL for every key.
   [jobId, { ...nextMetadata, pendingPlaceholder: true, pendingPlaceholderParentId: threadParentId }, ws.agentConnectionId],
  );
  });
 }

 return {
  agentHasActiveJob,
  agentHasAnyActiveJob,
  agentStepContent,
  agentStepParts,
  ampResultMetadata,
  normalizeStopReason,
  stopResultMetadata,
  daemonStopUsage,
  failureSentence,
  validateAmpJobResult,
  cancelFarmAgentJob,
  claimMcpJob,
  clearStrandedPlaceholders,
  dispatchFarmAgentJob,
  failConnectionJobs,
  finalizeAgentJobResult,
  finalizeStuckJob,
  getFarmAgentJob,
  handleAgentJobDelta,
  handleAgentJobResult,
  handleAgentJobSegment,
  handleAgentJobStep,
  hasActiveBurstJob,
  rehomeRunningJobs,
  insertActiveAgentJob,
  isAgentJobLive,
  publicFarmAgentJob,
  reapStuckAgentJobs,
  reapStuckMcpJobs,
  submitMcpJobResult,
 };
}

module.exports = { createAgentJobs };
