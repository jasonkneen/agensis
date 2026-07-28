'use strict';

const crypto = require('crypto');

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
  forbidden,
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
 } = deps;

 // Insert an agent_job, tolerating the partial unique index that enforces one
 // active job per (session, agent) (M15). A unique violation means a concurrent
 // trigger already created the turn's job (won the race), so we clean up the
 // just-created "Thinking" placeholder message (if any) and return null; callers
 // treat null like the pending path and stop the drain loop.
 async function insertActiveAgentJob(sql, params, placeholderMessageId = null) {
  try {
   return await getDb().unsafe(sql, params);
  } catch (error) {
   if (error && error.code === '23505') {
    if (placeholderMessageId) {
     try {
      const del = await getDb().unsafe('delete from messages where id = $1 returning *', [placeholderMessageId]);
      if (del.length > 0) notifyDbSubscribers('messages', 'DELETE', del);
     } catch { /* best effort placeholder cleanup */ }
    }
    return null;
   }
   throw error;
  }
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
   await finalizeStuckJob(job, 'the previous turn was abandoned');
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
 async function clearStrandedPlaceholders(job, keepMessageId = null) {
  if (!job || !job.session_id || !job.agent_id) return;
  const since = job.started_at || job.created_at;
  if (!since) return;
  try {
   const rows = await getDb().unsafe(
    `delete from messages
       where session_id = $1
         and sender_id = $2
         and sender_kind = 'agent'
         and coalesce(message_kind, '') = ''
         and content ~ $3
         -- The eager placeholder is inserted just BEFORE the job row it belongs to,
         -- so the window has to open slightly ahead of the job's own clock.
         and created_at >= $4::timestamptz - interval '1 minute'
         and ($5::text is null or id::text <> $5::text)
       returning *`,
    [job.session_id, String(job.agent_id), PLACEHOLDER_CONTENT_RE, since, keepMessageId || null],
   );
   if (rows.length > 0) notifyDbSubscribers('messages', 'DELETE', rows);
  } catch {
   // best effort — tidy-up must never fail a job that otherwise finished correctly
  }
 }

 // Finalize a stuck/abandoned daemon job: mark it failed and rewrite its still-
 // pending "Thinking …" placeholder with a clear message, so a chat never hangs on
 // a spinner when the daemon disconnects, crashes, or simply never answers.
 async function finalizeStuckJob(job, reason) {
  try {
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
    `update agent_jobs set status = 'error', error = $2, finished_at = now(), updated_at = now() where id = $1 and status in ('queued', 'running') returning *`,
    [job.id, `Agent stopped responding (${reason})`],
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
   const meta = parseJsonObject(job.metadata);
   const responseMessageId = meta.responseMessageId || null;
   if (responseMessageId) {
    const handle = meta.handle || 'agent';
    const content = `@${handle} stopped responding (${reason}). Send again to retry — if it keeps happening, reconnect the daemon from AI Agents.`;
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
   for (const job of rows) await finalizeStuckJob(job, reason);
  } catch {
   // best effort
  }
 }

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
            ((metadata->>'mode') = 'farm' and updated_at < now() - interval '31 minutes')
            or (
              coalesce(metadata->>'mode', '') <> 'farm'
              and (
                coalesce((metadata->>'lastContentAt')::timestamptz, started_at) < now() - interval '10 minutes'
                or started_at < now() - interval '30 minutes'
              )
            )
          )`,
   );
   for (const job of rows) await finalizeStuckJob(job, 'timed out');
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

 async function finalizeAgentJobResult(job, { responseText = '', errorText = '', fallbackName = null, fallbackHandle = null, resultMetadata = null } = {}) {
  const jobMetadata = parseJsonObject(job.metadata);
  const validatedAmp = validateAmpJobResult(jobMetadata, resultMetadata, errorText);
  const finalErrorText = validatedAmp.errorText;
  const storedResponseText = !errorText && finalErrorText ? '' : responseText;
  const status = finalErrorText ? 'error' : 'done';
  const mergedMetadata = { ...jobMetadata, ...validatedAmp.metadata };
  const statusGuard = jobMetadata.mode === 'farm'
   ? "status in ('queued', 'running')"
   : "status in ('queued', 'running', 'error')";
  const updatedRows = await getDb().unsafe(
   `update agent_jobs set status = $2, response = $3, error = $4, metadata = $5::jsonb, finished_at = now(), updated_at = now()
      where id = $1 and ${statusGuard} returning *`,
   [job.id, status, storedResponseText, finalErrorText, mergedMetadata],
  );
  if (updatedRows.length === 0) return null;
  notifyDbSubscribers('agent_jobs', 'UPDATE', updatedRows);

  // The agent just freed its one active-job slot: give it the next task waiting on
  // it. Fire-and-forget, before the early returns below so farm/sessionless jobs
  // drain too — a job finishing is a job finishing.
  scheduleTaskQueueDrain(job.workspace_id, job.agent_id, `job_${status}`);

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
  const content = finalErrorText
   ? `@${handle} failed: ${finalErrorText}`
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
  // A segmented turn (see handleAgentJobSegment) has already posted every completed
  // text block as its own message and left a FRESH placeholder waiting for the next
  // one. A turn that ends right after a block leaves that placeholder with nothing
  // to say — the result is either empty or a repeat of the block already on screen —
  // so it is DELETED rather than left behind as an orphan "Thinking …" bubble, and
  // the block's own message stands in for it in Activity and task mirroring. A turn
  // whose tail streamed on past the last segment still lands in the placeholder as
  // before, and so does an error.
  const lastSegmentText = Number(jobMetadata.segmentCount || 0) > 0
   ? textFromValue(jobMetadata.lastSegmentText).trim()
   : '';
  const finalText = textFromValue(responseText).trim();
  const trailingPlaceholderIsSpent = !errorText && !!lastSegmentText && (!finalText || finalText === lastSegmentText);
  if (responseMessageId && trailingPlaceholderIsSpent) {
   const removedRows = await getDb().unsafe(
    'delete from messages where id = $1 and session_id = $2 returning *',
    [responseMessageId, job.session_id],
   );
   if (removedRows.length > 0) notifyDbSubscribers('messages', 'DELETE', removedRows);
   // The last completed BLOCK stands in as the turn's reply, so it is the row that
   // gets broadcast — the placeholder that would have carried the flag is gone.
   // UPDATE ... returning so the flip fans out to clients like any other change.
   const segmentRows = jobMetadata.lastSegmentMessageId
    ? await getDb().unsafe(
     ampThreadLink
      ? `update messages
          set broadcast_to_channel = case when $3 then true else broadcast_to_channel end,
              content = case when position($4 in content) = 0 then content || $4 else content end
          where id = $1 and session_id = $2 returning *`
      : broadcastToChannel
       ? `update messages set broadcast_to_channel = true
            where id = $1 and session_id = $2 returning *`
       : 'select * from messages where id = $1 and session_id = $2 limit 1',
     ampThreadLink
      ? [String(jobMetadata.lastSegmentMessageId), job.session_id, broadcastToChannel, ampThreadLink]
      : [String(jobMetadata.lastSegmentMessageId), job.session_id],
    )
    : [];
   if (segmentRows.length > 0) {
    if (broadcastToChannel || ampThreadLink) notifyDbSubscribers('messages', 'UPDATE', segmentRows);
    void logMessageActivity(segmentRows);
    void mirrorAgentReplyToTaskComment(segmentRows[0]);
   }
  } else if (responseMessageId) {
   const messageRows = await getDb().unsafe(
    `update messages set content = $2, sender_kind = 'agent', sender_id = $3, sender_name = $4,
                         broadcast_to_channel = $6
        where id = $1 and session_id = $5 returning *`,
    [responseMessageId, content, String(job.agent_id || ''), senderName, job.session_id, broadcastToChannel],
   );
   if (messageRows.length > 0) {
    notifyDbSubscribers('messages', 'UPDATE', messageRows);
    void logMessageActivity(messageRows);
    void mirrorAgentReplyToTaskComment(messageRows[0]);
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
    const createdRows = await getDb().unsafe(
     `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel)
         values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6, $7)
         on conflict (id) do nothing
         returning *`,
     [
      responseMessageId, job.session_id, content,
      jobMetadata.pendingPlaceholderParentId || workThreadParentId,
      String(job.agent_id || ''), senderName, broadcastToChannel,
     ],
    );
    if (createdRows.length > 0) {
     notifyDbSubscribers('messages', 'INSERT', createdRows);
     void logMessageActivity(createdRows);
     void mirrorAgentReplyToTaskComment(createdRows[0]);
    }
   }
  } else {
   // No placeholder was ever created (an 'external' agent queued with nobody
   // attached, claimed later). The answer still belongs in the work thread, still
   // broadcast — otherwise it would land top-level and lose the thread it answered.
   const messageRows = await getDb().unsafe(
    `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel)
        values ($1, 'assistant', $2, $3, 'agent', $4, $5, $6) returning *`,
    [job.session_id, content, workThreadParentId, String(job.agent_id || ''), senderName, broadcastToChannel],
   );
   notifyDbSubscribers('messages', 'INSERT', messageRows);
   void mirrorAgentReplyToTaskComment(messageRows[0]);
  }
  // The turn is over, so nothing in it may still be counting. The branches above
  // resolve the placeholder the job was TRACKING; a segmented turn rotated through
  // others, and a tick that raced this finalization can re-create one moments after
  // it was deleted. Sweep whatever is left rather than leaving a chip ticking at a
  // run that has finished. `responseMessageId` is held back because that row now
  // holds the real reply — which, on the day an agent opens one with "Thinking 5s",
  // would otherwise match the placeholder pattern and be deleted as debris.
  await clearStrandedPlaceholders(job, responseMessageId);
  void continueConversation({ workspaceId: job.workspace_id, sessionId: job.session_id, threadParentId })
   .catch((error) => console.error('continueConversation (job finalize) failed', error));
  return updatedRows[0] || null;
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
  if (!agent || !isAgentEnabled(agent) || agent.run_mode !== 'daemon') throw badRequest('Farm jobs require an enabled daemon agent');
  const target = connection || findConnectedAgent(String(workspaceId), String(agentId), agent.handle || agent.name);
  if (!target) throw Object.assign(new Error('The selected agent daemon is offline'), { status: 503, code: 'agent_offline' });
  if (target.capabilities?.codingRoute === false) {
   throw Object.assign(new Error('The selected agent does not advertise coding support'), { status: 409, code: 'coding_route_unavailable' });
  }
  const metadata = { mode: 'farm', source: 'agensis-farm', cwd: String(cwd || '').slice(0, 1000) || null };
  const jobRows = await getDb().unsafe(
   `insert into agent_jobs (workspace_id, agent_id, connection_id, session_id, prompt, status, started_at, metadata)
      values ($1, $2, $3, null, $4, 'running', now(), $5::jsonb) returning *`,
   [String(workspaceId), String(agentId), target.connectionId, String(prompt).trim(), metadata],
  );
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
  const rows = await getDb().unsafe(
   `select j.*, a.name as agent_name, a.handle as agent_handle
      from agent_jobs j left join workspace_agents a on a.id = j.agent_id
      where j.id = $1 and j.agent_id = $2 and j.workspace_id = $3 limit 1`,
   [jobId, auth.agentId, auth.workspaceId],
  );
  const job = rows[0];
  if (!job) throw forbidden('Agent job not found');
  // A cancelled control-plane job may still race with process teardown and
  // report one final result. Cancellation is authoritative; discard the late
  // frame rather than changing it back to done/error.
  if (job.status === 'cancelled') {
   await updateAgentHeartbeat(ws, { busy: false }).catch(() => { });
   return;
  }
  await finalizeAgentJobResult(job, {
   responseText: textFromValue(message.response).trim(),
   errorText: textFromValue(message.error).trim(),
   fallbackName: auth.name,
   fallbackHandle: auth.handle,
   resultMetadata: message.metadata,
  });
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
   `update agent_jobs set status = 'running', started_at = now(), updated_at = now()
      where id = (
        select id from agent_jobs
         where workspace_id = $1 and agent_id = $2 and status = 'queued' and (metadata->>'mode') = 'mcp'
         order by created_at asc limit 1 for update skip locked
      ) returning *`,
   [workspaceId, agentId],
  );
  const job = claimed[0];
  if (!job) return null;
  notifyDbSubscribers('agent_jobs', 'UPDATE', claimed);
  const agentRows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [agentId]);
  const meta = parseJsonObject(job.metadata);
  return {
   jobId: job.id,
   prompt: job.prompt || '',
   sessionId: job.session_id,
   threadParentId: meta.threadParentId || null,
   agent: agentRows[0] ? agentRuntimePayload(agentRows[0]) : null,
  };
 }

 async function submitMcpJobResult({ workspaceId, agentId, jobId, responseText = '', errorText = '' }) {
  if (!jobId) throw badRequest('jobId is required');
  if (!agentId) throw badRequest('Agent job not found');
  const rows = await getDb().unsafe(
   `select j.*, a.name as agent_name, a.handle as agent_handle
      from agent_jobs j left join workspace_agents a on a.id = j.agent_id
      where j.id = $1 and j.workspace_id = $2 and j.agent_id = $3 limit 1`,
   [jobId, workspaceId, agentId],
  );
  const job = rows[0];
  if (!job) throw badRequest('Agent job not found');
  if (parseJsonObject(job.metadata).mode !== 'mcp') throw badRequest('Job is not an MCP job');
  // Accept a late result even after the reaper force-failed the job to 'error'
  // (the client wasn't actually dead, just slow) — recovering the real response
  // is better than discarding it. Only a job that already completed successfully
  // ('done') or was never claimed ('queued') is genuinely not awaiting a result.
  // (M3, 2026-07 review.)
  if (job.status !== 'running' && job.status !== 'error') {
   throw badRequest(`Job is ${job.status}, not awaiting a result`);
  }
  touchMcpPresence(agentId); // a submitting client is alive
  await finalizeAgentJobResult(job, { responseText, errorText });
  return { jobId: job.id, status: errorText ? 'error' : 'done' };
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
    await finalizeAgentJobResult(job, { errorText: 'the MCP client stopped responding' }).catch(() => { });
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
  const rows = await getDb().unsafe(
   `select j.*, a.name as agent_name, a.handle as agent_handle
      from agent_jobs j
      left join workspace_agents a on a.id = j.agent_id
      where j.id = $1 and j.agent_id = $2 and j.workspace_id = $3
      limit 1`,
   [jobId, auth.agentId, auth.workspaceId],
  );
  const job = rows[0];
  if (!job) throw forbidden('Agent job not found');
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
  const deltaRows = await getDb().unsafe(
   `update agent_jobs
      set response = $2,
          updated_at = now(),
          metadata = $3::jsonb
      where id = $1 and status in ('queued', 'running')
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
   ],
  );
  // Either the job already finished, or a segment moved the placeholder on between
  // the read above and this write. Everything below is stale either way.
  if (deltaRows.length === 0) return;
  if (responseMessageId) {
   const content = agentLiveMessageContent(message);
   const updatedRows = await getDb().unsafe(
    `update messages
        set content = $2,
            sender_kind = 'agent',
            sender_id = $3,
            sender_name = $4
        where id = $1 and session_id = $5
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
    notifyDbSubscribers('messages', 'UPDATE', updatedRows);
   } else if (metadata.pendingPlaceholder && deltaText) {
    // A segment handed us an id but deliberately did not create the row, so the
    // thread is not littered with empty "Thinking …" bubbles while the agent runs
    // tools. This is the first content for that block: materialise it now.
    //
    // `deltaText` is the whole of "lazily". Without it, a content-free tick
    // materialised the row as "Thinking Ns" — re-creating the very bubble lazy
    // creation exists to prevent, and minting the row that then strands when the
    // turn rotates past it.
    const createdRows = await getDb().unsafe(
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
    if (createdRows.length > 0) notifyDbSubscribers('messages', 'INSERT', createdRows);
   }
  }
  await updateAgentHeartbeat(ws, { busy: true }).catch(() => { });
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
  const rows = await getDb().unsafe(
   `select j.*, a.name as agent_name, a.handle as agent_handle
      from agent_jobs j
      left join workspace_agents a on a.id = j.agent_id
      where j.id = $1 and j.agent_id = $2 and j.workspace_id = $3
      limit 1`,
   [jobId, auth.agentId, auth.workspaceId],
  );
  const job = rows[0];
  if (!job) throw forbidden('Agent job not found');
  if (!job.session_id) return; // farm/control-plane jobs have no conversation to post into
  const content = agentStepContent(message);
  if (!content) return;
  const step = agentStepParts(message);
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
   const parentRows = await getDb().unsafe(
    'select thread_parent_id from messages where id = $1 and session_id = $2 limit 1',
    [responseMessageId, job.session_id],
   );
   if (parentRows[0]) {
    threadParentId = parentRows[0].thread_parent_id || responseMessageId;
   }
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
  const stepRows = await getDb().unsafe(
   `update agent_jobs
      set updated_at = now(),
          metadata = $2::jsonb
      where id = $1 and status in ('queued', 'running')
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
   [jobId, nextMetadata, responseMessageId || ''],
  );
  // The job already finished, or a segment moved the placeholder on under us. The
  // step's thread parent was resolved from the old placeholder either way, so it
  // would land in the wrong place.
  if (stepRows.length === 0) return;
  const messageRows = await getDb().unsafe(
   `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail)
      values ($1, 'assistant', $2, $3, 'agent', $4, $5, 'tool_step', $6, $7) returning *`,
   [job.session_id, content, threadParentId, String(job.agent_id || ''), job.agent_name || auth.name || auth.handle || 'Agent', step.name, step.detail],
  );
  notifyDbSubscribers('messages', 'INSERT', messageRows);
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
  const rows = await getDb().unsafe(
   `select j.*, a.name as agent_name, a.handle as agent_handle
      from agent_jobs j
      left join workspace_agents a on a.id = j.agent_id
      where j.id = $1 and j.agent_id = $2 and j.workspace_id = $3
      limit 1`,
   [jobId, auth.agentId, auth.workspaceId],
  );
  const job = rows[0];
  if (!job) throw forbidden('Agent job not found');
  if (!job.session_id) return; // farm/control-plane jobs have no conversation to post into
  const text = textFromValue(message.text ?? message.content ?? message.response).trim();
  if (!text) return; // an empty block is not a message; never rotate the placeholder on one
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
  const segmentRows = await getDb().unsafe(
   `update agent_jobs
      set updated_at = now(),
          metadata = $2::jsonb
      where id = $1 and status in ('queued', 'running')
      returning id`,
   // Bind the merged OBJECT, never JSON.stringify — a stringified bind becomes a
   // jsonb string scalar and corrupts the column (see handleAgentJobDelta).
   [jobId, nextMetadata],
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
   const finalizedRows = await getDb().unsafe(
    `update messages
        set content = $2,
            sender_kind = 'agent',
            sender_id = $3,
            sender_name = $4
        where id = $1 and session_id = $5
        returning *`,
    [responseMessageId, text, String(job.agent_id || ''), senderName, job.session_id],
   );
   if (finalizedRows.length > 0) {
    notifyDbSubscribers('messages', 'UPDATE', finalizedRows);
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
    const blockRows = await getDb().unsafe(
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
     notifyDbSubscribers('messages', 'INSERT', blockRows);
     threadParentId = blockRows[0].thread_parent_id || null;
    }
   }
  } else {
   const blockRows = await getDb().unsafe(
    `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
       values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6) returning *`,
    [blockMessageId, job.session_id, text, threadParentId, String(job.agent_id || ''), senderName],
   );
   notifyDbSubscribers('messages', 'INSERT', blockRows);
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
  await getDb().unsafe(
   `update agent_jobs
      set updated_at = now(),
          metadata = $2::jsonb
      where id = $1 and status in ('queued', 'running')
      returning id`,
   // Bind the merged OBJECT, never JSON.stringify — a stringified bind becomes a
   // jsonb STRING scalar, after which metadata->>'…' reads NULL for every key.
   [jobId, { ...nextMetadata, pendingPlaceholder: true, pendingPlaceholderParentId: threadParentId }],
  );
 }

 return {
  agentHasActiveJob,
  agentHasAnyActiveJob,
  agentStepContent,
  agentStepParts,
  ampResultMetadata,
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
