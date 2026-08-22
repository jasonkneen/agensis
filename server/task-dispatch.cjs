'use strict';

// Task dispatch and reply cadence: turning an assignment into a running agent
// turn, and holding a turn back when the agent is already busy.
//
// Wave 4 of the server/index.cjs reduction. Owns FOUR of the maps
// resetTestState() clears — recentTaskDispatches, taskQueueStrikes,
// taskQueueSelecting and cadenceWakes — so reset() clears all four and
// index.cjs delegates. cadenceWakes additionally holds live TIMERS, and
// clearCadenceWakes cancels them; a wake left armed across tests fires into the
// next one.
//
// THE DECISION IS NOT HERE. Whether a reply is held, and for how long, is
// shared/replyCadence.cjs — pure, and unit-tested as such. This module is only
// the bookkeeping that proves a held turn is BOOKED rather than dropped, and
// never double-booked.
//
// claimTaskDispatch is a lease, not a lock: TASK_ASSIGN_CLAIM_MS bounds it so a
// crashed dispatch cannot wedge a task forever. taskQueueStrikes bounds the
// other direction — an agent that keeps refusing work stops being offered it
// rather than spinning the queue.

function createTaskDispatch(deps = {}) {
 const {
  agentHasActiveJob,
  agentHasAnyActiveJob,
  continueConversation,
  dispatchRateLimiter,
  findOrCreateDirectSession,
  getDb,
  getWorkspaceRole,
  isAgentEnabled,
  notifyDbSubscribers,
  parseAgentMentions,
  postTaskSubthreadMention,
  roleHasWorkspaceCapability,
  slugHandle,
 } = deps;

 // Owned here; all four are cleared by reset() below.
 // --- reply cadence: the pending wakes ---------------------------------------
 //
 // A social channel's turn is HELD, never dropped: continueConversation returns
 // without dispatching and books a wake for itself here, keyed by the same
 // `sessionId::threadParentId` the conversation lock uses. On the wake it re-reads
 // the whole conversation and re-decides from scratch — which is why the wait is
 // derived from the message id rather than from Math.random (a fresh draw each
 // pass would compound or reset it), and why an agent that has been overtaken in
 // the meantime stands down naturally instead of needing to be cancelled.
 //
 // IN MEMORY, deliberately, with no persisted schedule:
 //   * The wait is at most replyCadence.MAX_DELAY_MS, and only in channels an
 //     operator explicitly set to 'social'.
 //   * A restart inside that window loses the automatic reply, never the message.
 //     The burst is unchanged in the database, so the very next @mention re-drives
 //     it and pickMentionNextAgent still picks the agent that was waiting.
 //   * A blind periodic sweep would be worse than the gap it closes: re-driving an
 //     un-addressed social post every tick means a paid relevance call every tick,
 //     forever, for a message everyone already declined.
 //   * A durable `next_reply_at` column would have to be cleared on every one of
 //     continueConversation's exits; one missed clear is a channel that re-answers
 //     an old message on a timer, which is a worse bug than the one it prevents.
 // Restarts already truncate an in-flight burst today (the finalize-to-continue
 // chain is in memory too, and reapStuckAgentJobs fails running jobs), so this
 // widens an existing window by seconds rather than adding a new kind of loss.
 const cadenceWakes = new Map();

 /**
  * Book ONE wake for this conversation. Returns false when a wake is already
  * pending — the earlier one is kept rather than pushed back, so a busy channel
  * cannot starve a reply by repeatedly re-scheduling it.
  */
 function scheduleCadenceWake(lockKey, delayMs, target) {
  if (cadenceWakes.has(lockKey)) return false;
  const timer = setTimeout(() => {
   cadenceWakes.delete(lockKey);
   void continueConversation(target).catch(
    (error) => console.error('continueConversation (reply cadence) failed', error),
   );
  }, delayMs);
  // Unref'd so a pending social reply never holds the process (or a test runner)
  // open. On a clean exit the reply is deferred to the next thing that drives the
  // channel, which is the same trade the note above accepts for a restart.
  if (typeof timer.unref === 'function') timer.unref();
  cadenceWakes.set(lockKey, timer);
  return true;
 }

 /** Drop every pending wake. Called by resetTestState so suites do not bleed. */
 function clearCadenceWakes() {
  for (const timer of cadenceWakes.values()) clearTimeout(timer);
  cadenceWakes.clear();
 }

 /** Whole milliseconds since a timestamp column; 0 for anything unreadable. */
 function msSinceTimestamp(value) {
  const at = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Date.now() - at);
 }

 /**
  * Was this agent named by handle anywhere in the burst? `@channel` does NOT
  * count — that is the whole distinction cadence turns on: being named is a
  * question addressed to you, being included in a broadcast is not.
  * parseAgentMentions already strips the reserved `channel` handle.
  */
 function agentNamedInBurst(agent, burst) {
  if (!agent) return false;
  const selfHandles = new Set([slugHandle(agent.handle || agent.name), slugHandle(agent.name)]);
  for (const row of burst || []) {
   for (const handle of parseAgentMentions(row.content)) {
    if (selfHandles.has(handle)) return true;
   }
  }
  return false;
 }

 // The status a task moves to when an agent is dispatched onto it via an @mention.
 // A fresh ('todo') task starts progressing; a task that has already started, or is
 // done/cancelled, is left exactly as-is — dispatch must never resurrect or
 // un-finish a task.
 function taskStatusOnDispatch(current) {
  return current === 'todo' ? 'in_progress' : current;
 }

 // One human action can reach dispatch twice: the task UI posts a comment that
 // @mentions an agent AND writes assignee_id, milliseconds apart. Each dispatch
 // path CLAIMS the (task, agent) pair first, so the second one is a no-op instead
 // of a second agent run (and a second bill). Process-local, like the other
 // in-memory maps here.
 const recentTaskDispatches = new Map(); // `${taskId}:${agentId}` -> ms
 const TASK_ASSIGN_CLAIM_MS = 15_000;


 function claimTaskDispatch(taskId, agentId, windowMs) {
  const now = Date.now();
  for (const [key, at] of recentTaskDispatches) {
   if (now - at > TASK_ASSIGN_CLAIM_MS) recentTaskDispatches.delete(key);
  }
  const key = `${taskId}:${agentId}`;
  const last = recentTaskDispatches.get(key);
  if (last && (now - last) < windowMs) return false;
  recentTaskDispatches.set(key, now);
  return true;
 }

 // Hand the claim back when the dispatch did NOT happen. The window exists to
 // swallow a double-fire from ONE human click; it must never swallow a queue
 // drain minutes later. Without this, a task refused because the agent was busy
 // would keep its 15s claim and be refused again as a "duplicate" by the drain
 // that fires the moment the agent frees up — which is a second way to strand it.
 function releaseTaskDispatch(taskId, agentId) {
  recentTaskDispatches.delete(`${taskId}:${agentId}`);
 }

 // source_type/source_id are the task's PROVENANCE, and source_id's meaning
 // depends on source_type ('ai' stores the authoring agent's id, 'canvas' the
 // canvas object's). Dispatch only claims the pair when there is no real
 // provenance to destroy — so an 'ai'/'canvas'/'document' task keeps its origin
 // and simply doesn't offer "Open chat".
 const TASK_SOURCE_LINK_OVERWRITABLE = new Set(['', 'manual', 'chat']);

 /**
  * Whether this dispatch may claim the task's source_type/source_id pair.
  *
  * 'chat' is in the overwritable set because a task dispatched twice should
  * point at the CURRENT DM. But a task CAPTURED from a conversation
  * (server/chat-task-capture.cjs) is also 'chat', and its source_id is the
  * channel the human actually asked in — the only record of where the work came
  * from. Overwriting that with the agent's DM id is a straight loss: "Open chat"
  * then lands in a DM that never mentions the request.
  *
  * Observed exactly once and immediately: the capture of "Can we check queued
  * messages…" was linked to #testtest at 18:09, dispatched at 18:19, and its
  * back-link silently became the Coder DM.
  *
  * origin_job_id is the discriminator because it is server-owned (a browser
  * cannot set it — see PRIVILEGED_DB_COLUMNS_BY_TABLE) and it means precisely
  * "this row's provenance was written by the capture sweep, not by a dispatch".
  */
 function dispatchMayStampSourceLink(task) {
  if (task && task.origin_job_id) return false;
  return TASK_SOURCE_LINK_OVERWRITABLE.has(String((task && task.source_type) || ''));
 }

 // --- the task queue ---------------------------------------------------------
 //
 // THE DB IS THE QUEUE. A task that is 'todo' AND assigned to an agent is waiting
 // for that agent; the oldest one is next. Nothing is held in memory, so a Fly
 // restart loses no work.
 //
 // Why no new 'queued' status: 'todo' + an agent assignee already encodes exactly
 // "assigned, waiting its turn", and it is the state the human left the task in.
 // A new status value would mean a CHECK-constraint change on tasks.status in all
 // three schema places, a new TaskStatus member, and a new column/label/filter in
 // every tasks view (List, Kanban, Gantt) — for no information the pair
 // (status, assignee_id) does not already carry. The invariant this file now
 // upholds is what makes the distinction readable: 'in_progress' means a job is
 // actually running, 'todo' + assignee means waiting. Before this, a dropped
 // dispatch left the task 'in_progress' with nothing working it, which is what
 // made "assignment doesn't work" indistinguishable from "it's being worked on".
 const TASK_QUEUE_SCAN_LIMIT = 5;

 const TASK_QUEUE_MAX_STRIKES = 3;

 // What "waiting for this agent" means, in ONE place: drainAgentTaskQueue SELECTs
 // it and taskQueuePosition counts it. The two drifting apart is exactly how
 // assigned tasks disappeared — the drain read `status = 'todo'`, while BOTH
 // queue-admission paths (dispatchTaskAssignment's mid-turn branch and the
 // task-comment @mention branch in index.cjs) deliberately leave the status alone.
 // A task queued at anything other than 'todo' was invisible to the drain forever,
 // and taskQueuePosition — which never checked the task's OWN status — still
 // logged a confident "queue position 1" over the top of it.
 //
 // Assigned + unfinished + the agent has not had the last word = waiting.
 //
 // That last clause is the loop guard. After a turn, the agent's reply — or, on a
 // failed turn, its rewritten placeholder — is the newest message in the task's
 // thread, so the task drops out of the queue until a human says something else.
 // Without it, widening the status filter would re-dispatch every in_progress task
 // on every job completion, forever. A task nobody has posted about yet has no
 // thread at all, and coalesce()'s 'user' default makes that waiting — which is
 // the assigned-but-never-dispatched case (the one that reads as "I assigned it
 // and nothing happened").
 //
 // Only human messages carry source_task_id; the agent's replies are children of
 // that root, hence the join through coalesce(thread_parent_id, id).
 //
 // sender_kind is deliberately in the WHERE and never in the projection: the guard
 // in tests/message-tool-steps.test.cjs requires any message column list naming it
 // to carry the tool-step columns too, since a projection that omits them renders
 // blank chips. This reads a timestamp, not a message.
 const taskThreadLastWordAt = (t, cmp) => `(
           select max(m.created_at)
             from messages m
             join messages root on root.id = coalesce(m.thread_parent_id, m.id)
            where root.source_task_id = ${t}.id
              and root.thread_parent_id is null
              and root.deleted_at is null
              and m.deleted_at is null
              and m.sender_kind ${cmp} 'agent'
         )`;

 // '-infinity' makes "never spoke" lose every comparison, which is what puts a
 // task with no thread at all — assigned but never dispatched — into the queue.
 // Note the direction: on a tie the task is WAITING. An ambiguous thread should
 // cost a turn, never a lost task.
 const taskWaitingSql = (t) => `${t}.status not in ('done', 'cancelled')
        and (
          ${t}.status = 'todo'
          or coalesce(${taskThreadLastWordAt(t, '=')}, '-infinity'::timestamptz)
             <= coalesce(${taskThreadLastWordAt(t, '<>')}, '-infinity'::timestamptz)
        )`;

 // Per-process failure counter, keyed `${taskId}:${agentId}`. A task whose
 // dispatch keeps failing for a reason the queue cannot fix (agent misconfigured,
 // turn budget exhausted, DB error) is dropped from the drain after this many
 // tries, so it cannot burn a turn on every future job completion. A human touch
 // (re-assign) or a backend restart gives it a fresh chance.
 const taskQueueStrikes = new Map();

 // Re-entrancy guard, keyed `${workspaceId}:${agentId}`. Covers the DECISION only
 // (see drainAgentTaskQueue) — never the dispatch itself.
 const taskQueueSelecting = new Set();

 // A run outcome that means "the agent is busy, try again when it frees up".
 // These requeue the task with no strike.
 // 'cadence_*' cannot happen on the task path — task work lands in the agent's DM
 // (findOrCreateDirectSession) and replyCadencePlan answers immediately for a DM
 // before it reads the mode. Listed anyway so that if a task ever IS dispatched
 // into a social channel, the task is REQUEUED rather than reported as a failure:
 // a paced turn is one the agent will get to, which is exactly what 'busy' means
 // here. Silence on this list would have logged it as "could not start".
 const TASK_QUEUE_BUSY_RUN_REASONS = new Set(['agent_busy', 'locked', 'refused', 'cadence_deferred', 'cadence_stand_down']);

 // Dispatch refusals that are about THIS task, not the agent: move to the next
 // candidate. (The drain's own SQL already filters most of them out.)
 const TASK_QUEUE_SKIP_REASONS = new Set(['task_not_found', 'terminal', 'stale_assignee', 'not_an_agent', 'missing_input', 'no_workspace']);

 // Dispatch refusals that are about the AGENT: stop the whole drain, since no
 // task of this agent's could start either.
 const TASK_QUEUE_STOP_REASONS = new Set(['queued', 'duplicate', 'agent_disabled', 'not_permitted', 'rate_limited']);

 // 1-based position of a task in its agent's FIFO queue, for the log line. Ordered
 // exactly like drainAgentTaskQueue's SELECT, so the number a human reads is the
 // number of drains they have to wait through. Best-effort: 0 means "unknown".
 async function taskQueuePosition(workspaceId, agentId, taskId) {
  const rows = await getDb().unsafe(
   `select
        (select count(*)::int
           from tasks t
          where t.workspace_id = $1 and t.assignee_id = $2
            and ${taskWaitingSql('t')}
            and (t.created_at, t.id) < (self.created_at, self.id)) as ahead,
        (${taskWaitingSql('self')}) as waiting
      from tasks self
     where self.id = $3`,
   [String(workspaceId || ''), String(agentId), String(taskId)],
  ).catch(() => []);
  // Never quote a position for a task the drain would not pick up: the number a
  // human reads has to be a number of drains they will actually be served by.
  if (!rows[0] || rows[0].waiting !== true) return 0;
  const ahead = Number(rows[0].ahead);
  return Number.isFinite(ahead) ? ahead + 1 : 0;
 }

 // Put a task back exactly as the human left it after a dispatch that never
 // started. Restores the status (and the provenance stamp, if this dispatch wrote
 // it) and removes the seed message nobody is going to answer — so the next
 // dispatch nags once, not twice.
 //
 // Compare-and-swap on `wroteStatus`: if the human (or the agent) changed the
 // status while the refused turn was in flight, THAT wins — a rollback must never
 // re-open a task somebody just closed. Best-effort: never throws.
 async function undoTaskDispatch({ task, priorStatus, wroteStatus, stampedSource, messageId, sessionId }) {
  try {
   const restored = stampedSource
    ? await getDb().unsafe(
     'update tasks set status = $1, source_type = $2, source_id = $3, updated_at = now() where id = $4 and status = $5 returning *',
     [priorStatus, task.source_type || null, task.source_id || null, String(task.id), wroteStatus],
    )
    : await getDb().unsafe(
     'update tasks set status = $1, updated_at = now() where id = $2 and status = $3 returning *',
     [priorStatus, String(task.id), wroteStatus],
    );
   if (restored[0]) notifyDbSubscribers('tasks', 'UPDATE', restored);
   if (messageId) {
    const removed = await getDb().unsafe(
     'delete from messages where id = $1 and session_id = $2 returning *',
     [String(messageId), sessionId],
    );
    if (removed.length > 0) notifyDbSubscribers('messages', 'DELETE', removed);
   }
  } catch (error) {
   console.error('undoTaskDispatch failed', error);
  }
 }

 // Assigning a task to an agent IS a dispatch: the agent wakes in its DM, inside
 // that task's own subthread, exactly as a task-comment @mention does — and the
 // task records the session so the UI can jump to that chat. Never throws, so
 // callers can stay fire-and-forget; returns a {dispatched, reason} descriptor.
 // `run` is a test seam; production always uses continueConversation.
 async function dispatchTaskAssignment({
  workspaceId, taskId, agentId, actorUserId = null, actorName = null, cause = 'assigned', run = continueConversation,
 }) {
  // Released on every path that does NOT end in a running turn — the claim's job
  // is to dedupe one human click, not to lock a task out of the queue.
  let claim = null;
  try {
   if (!taskId || !agentId) return { dispatched: false, reason: 'missing_input' };
   const taskRows = await getDb().unsafe(
    'select id, workspace_id, title, description, status, assignee_id, source_type, source_id, origin_job_id, dispatch_requested_by from tasks where id = $1 limit 1',
    [String(taskId)],
   );
   const task = taskRows[0];
   if (!task) return { dispatched: false, reason: 'task_not_found' };
   const wsId = String(workspaceId || task.workspace_id || '');
   if (!wsId) return { dispatched: false, reason: 'no_workspace' };
   // A finished task must never be resurrected by an assignment.
   if (task.status === 'done' || task.status === 'cancelled') return { dispatched: false, reason: 'terminal' };
   // The row is read AFTER the write that triggered this, so a later update that
   // re-assigned the task wins — never run an agent that is no longer the assignee.
   if (String(task.assignee_id || '') !== String(agentId)) return { dispatched: false, reason: 'stale_assignee' };

   // assignee_id has no FK: a human user id is a perfectly valid assignee, and a
   // human being assigned must never run an agent.
   const agentRows = await getDb().unsafe(
    'select * from workspace_agents where id = $1 and workspace_id = $2 limit 1',
    [String(agentId), wsId],
   );
   const agent = agentRows[0];
   if (!agent) return { dispatched: false, reason: 'not_an_agent' };
   // Mirrors the @mention path, which resolves through enabled agents only.
   if (!isAgentEnabled(agent)) return { dispatched: false, reason: 'agent_disabled' };

   // Running an agent is an agent-dispatch action, so it carries the same
   // capability + throttle as the @mention path: a commenter/viewer who can edit
   // a task still cannot run agents with it.
   // A delayed drain carries the server-stamped assigning human from the task
   // row. Never infer this from created_by: A may create a task that B later
   // assigns, and each human owns a distinct private DM with the same agent.
   // The row stamp is authoritative. Generic updates determine the real
   // assignee edge atomically in SQL, while their pre-read used only to decide
   // whether to schedule this asynchronous call can be stale. If two humans
   // race null -> same agent, only the first UPDATE owns the edge; both
   // callbacks must therefore route to that same stored requester. actorUserId
   // remains a compatibility fallback for legacy rows written before the
   // routing column existed.
   const storedRequester = task.dispatch_requested_by || null;
   const routingUserId = storedRequester || actorUserId || null;
   if (routingUserId) {
    const role = await getWorkspaceRole(routingUserId, wsId);
    if (!roleHasWorkspaceCapability(role, 'run_agents')) return { dispatched: false, reason: 'not_permitted' };
    if (!dispatchRateLimiter.check(String(routingUserId)).allowed) return { dispatched: false, reason: 'rate_limited' };
   }
   if (!claimTaskDispatch(task.id, agent.id, TASK_ASSIGN_CLAIM_MS)) return { dispatched: false, reason: 'duplicate' };
   claim = [task.id, agent.id];

   const session = await findOrCreateDirectSession(wsId, agent, routingUserId);
   if (!session) return { dispatched: false, reason: 'no_session' };

   let who = actorName || '';
   if (!who && routingUserId) {
    const u = await getDb()
     .unsafe('select display_name, email from app_users where id = $1 limit 1', [routingUserId])
     .catch(() => []);
    who = u[0]?.display_name || u[0]?.email || '';
   }
   who = who || 'A teammate';

   const handle = slugHandle(agent.handle || agent.name);
   const details = String(task.description || '').trim();
   const content =
    `@${handle} — ${who} assigned you the task "${task.title}".` +
    (details ? `\n\n> ${details.replace(/\n/g, '\n> ')}` : '') +
    '\n\nPick this up and reply here in your DM.' +
    `\n\nSource: agensis://task/${task.id}`;

   // All of an agent's task work lands in ONE DM session, and agent_jobs carries a
   // partial unique index (one active job per session+agent), so a second dispatch
   // while the agent is mid-turn physically cannot create a job. Find that out
   // BEFORE writing anything: the task stays 'todo' + assigned, which is what
   // "waiting its turn" looks like, and the drain picks it up when the agent frees
   // up. The old code flipped it to 'in_progress' first and then dropped the turn.
   if (await agentHasActiveJob(session.id, agent.id)) {
    const position = await taskQueuePosition(wsId, agent.id, task.id);
    console.log(`[task-queue] queued task=${task.id} ${JSON.stringify(String(task.title || ''))} for @${handle}: agent is mid-turn${position ? ` (queue position ${position})` : ''} (cause=${cause})`);
    return { dispatched: false, reason: 'queued' };
   }

   // Move a fresh task into progress (never clobbering a started status) and stamp
   // the chat this task is being worked in, so the UI can offer "Open chat".
   const priorStatus = String(task.status || 'todo');
   const nextStatus = taskStatusOnDispatch(priorStatus);
   const stampSource = dispatchMayStampSourceLink(task);
   const updated = stampSource
    ? await getDb().unsafe(
     "update tasks set status = $1, source_type = 'chat', source_id = $2, updated_at = now() where id = $3 returning *",
     [nextStatus, String(session.id), String(task.id)],
    )
    : await getDb().unsafe(
     'update tasks set status = $1, updated_at = now() where id = $2 returning *',
     [nextStatus, String(task.id)],
    );
   if (updated[0]) notifyDbSubscribers('tasks', 'UPDATE', updated);

   const { threadParentId, messageRow } = await postTaskSubthreadMention({
    session, taskId: task.id, content, authorUserId: routingUserId, authorName: who,
   });

   // AWAITED, unlike the fire-and-forget it replaces: the turn can still be
   // refused inside continueConversation (the agent won its own one-active-job
   // slot in the window between the check above and the job insert, or the turn
   // budget is spent). Nothing retried that, so the task sat 'in_progress' with no
   // job attached, forever. Callers are all `void`-ed, so awaiting costs no
   // request latency. An older `run` seam that returns nothing still counts as
   // started.
   let outcome = null;
   try {
    // We are OPENING this thread, not answering inside one somebody is reading.
    // Whoever assigned the task is on the task board, so the answer has to reach
    // the conversation itself; without this it lands in a thread the DM view
    // cannot render and the task looks like it went nowhere.
    outcome = await run({ workspaceId: wsId, sessionId: session.id, threadParentId, broadcastToChannel: true });
   } catch (error) {
    console.error('continueConversation (task assignment) failed', error);
    outcome = { started: false, reason: 'error' };
   }
   if (outcome && outcome.started === false) {
    await undoTaskDispatch({
     task, priorStatus, wroteStatus: nextStatus, stampedSource: stampSource,
     messageId: messageRow?.id || null, sessionId: session.id,
    });
    const busy = TASK_QUEUE_BUSY_RUN_REASONS.has(String(outcome.reason || ''));
    console.log(`[task-queue] ${busy ? 'requeued' : 'could not start'} task=${task.id} for @${handle}: run=${outcome.reason || 'unknown'} (cause=${cause}); status back to ${priorStatus}`);
    return { dispatched: false, reason: busy ? 'queued' : 'not_started', runReason: String(outcome.reason || '') };
   }

   claim = null; // a real turn is running; keep the claim so a re-save can't double-run it
   console.log(`[task-queue] dispatched task=${task.id} ${JSON.stringify(String(task.title || ''))} to @${handle} (cause=${cause}, session=${session.id})`);
   return { dispatched: true, reason: 'dispatched', sessionId: session.id, threadParentId };
  } catch (error) {
   console.error('dispatchTaskAssignment failed', error);
   return { dispatched: false, reason: 'error' };
  } finally {
   if (claim) releaseTaskDispatch(claim[0], claim[1]);
  }
 }

 // Dispatch the OLDEST task still waiting on this agent — FIFO, so the order the
 // human assigned them is the order they run. Called from every terminal job
 // transition; at most ONE task is dispatched per call, so a backlog is walked one
 // completion at a time rather than fired off all at once.
 async function drainAgentTaskQueue({ workspaceId, agentId, cause = 'job_finished', run = continueConversation } = {}) {
  const wsId = String(workspaceId || '');
  const aId = String(agentId || '');
  if (!wsId || !aId) return { dispatched: false, reason: 'missing_input' };
  const key = `${wsId}:${aId}`;
  let waiting = [];

  // The guard covers only the decision — which task is next, and is the agent free
  // — never the dispatch. Holding it across the dispatch would swallow the drain
  // fired by that very job's completion, which is exactly how a builtin agent
  // finishes: synchronously, inside the dispatch being awaited. Two drains racing
  // past the guard are still safe: claimTaskDispatch, the session-scoped active-job
  // check and the unique index each refuse the second one.
  if (taskQueueSelecting.has(key)) return { dispatched: false, reason: 'reentrant' };
  taskQueueSelecting.add(key);
  try {
   waiting = await getDb().unsafe(
    `select id, title, workspace_id, created_at from tasks t
        where t.workspace_id = $1 and t.assignee_id = $2
          and ${taskWaitingSql('t')}
        order by t.created_at asc, t.id asc
        limit $3`,
    [wsId, aId, TASK_QUEUE_SCAN_LIMIT],
   );
   if (!Array.isArray(waiting) || waiting.length === 0) return { dispatched: false, reason: 'empty' };
   // Belt: the unique index is the braces. A drain that fires while the agent is
   // still mid-turn somewhere must not spend a turn.
   if (await agentHasAnyActiveJob(wsId, aId)) {
    console.log(`[task-queue] hold ${waiting.length} task(s) for agent=${aId}: still mid-turn (cause=${cause})`);
    return { dispatched: false, reason: 'busy' };
   }
  } catch (error) {
   console.error('drainAgentTaskQueue lookup failed', error);
   return { dispatched: false, reason: 'error' };
  } finally {
   taskQueueSelecting.delete(key);
  }

  for (const task of waiting) {
   const strikeKey = `${task.id}:${aId}`;
   const strikes = Number(taskQueueStrikes.get(strikeKey) || 0);
   if (strikes >= TASK_QUEUE_MAX_STRIKES) {
    console.log(`[task-queue] skipping task=${task.id} for agent=${aId}: ${strikes} failed dispatch attempts, needs a human`);
    continue;
   }
   const out = await dispatchTaskAssignment({
    workspaceId: wsId,
    taskId: task.id,
    agentId: aId,
    cause: `drain:${cause}`,
    run,
   });
   if (out.dispatched) {
    taskQueueStrikes.delete(strikeKey);
    return { dispatched: true, reason: 'dispatched', taskId: task.id, waiting: waiting.length };
   }
   if (TASK_QUEUE_STOP_REASONS.has(out.reason)) {
    console.log(`[task-queue] drain stopped for agent=${aId} at task=${task.id}: ${out.reason} (cause=${cause})`);
    return { dispatched: false, reason: out.reason };
   }
   if (TASK_QUEUE_SKIP_REASONS.has(out.reason)) {
    // Task-level ineligibility, and costs nothing to skip past: try the next one.
    console.log(`[task-queue] skipping task=${task.id} for agent=${aId}: ${out.reason}`);
    continue;
   }
   // Anything else (turn budget spent, no session, DB error) is a real failed
   // attempt. Strike it and STOP: these causes are agent/session-level, so the
   // next task would fail identically, and one completed job must not turn into
   // five failed attempts. After TASK_QUEUE_MAX_STRIKES this task is skipped
   // instead, which is what stops a poisoned head-of-line blocking the queue.
   taskQueueStrikes.set(strikeKey, strikes + 1);
   console.log(`[task-queue] task=${task.id} did not start for agent=${aId} (${out.reason}${out.runReason ? `/${out.runReason}` : ''}); strike ${strikes + 1}/${TASK_QUEUE_MAX_STRIKES}`);
   return { dispatched: false, reason: out.reason, taskId: task.id, strikes: strikes + 1 };
  }
  return { dispatched: false, reason: 'no_eligible' };
 }

 // Fire-and-forget wrapper. A drain must never be able to fail — or even slow —
 // the job-completion write that triggered it.
 function scheduleTaskQueueDrain(workspaceId, agentId, cause) {
  if (!workspaceId || !agentId) return;
  void drainAgentTaskQueue({ workspaceId, agentId, cause }).catch((error) =>
   console.error('drainAgentTaskQueue failed', error),
  );
 }

 // Called by index.cjs's resetTestState(). clearCadenceWakes() also CANCELS the
 // pending timers, which is why it is called rather than cadenceWakes.clear().
 function reset() {
  recentTaskDispatches.clear();
  taskQueueStrikes.clear();
  taskQueueSelecting.clear();
  clearCadenceWakes();
 }

 return {
  agentNamedInBurst,
  claimTaskDispatch,
  clearCadenceWakes,
  dispatchTaskAssignment,
  drainAgentTaskQueue,
  msSinceTimestamp,
  releaseTaskDispatch,
  scheduleCadenceWake,
  scheduleTaskQueueDrain,
  taskQueuePosition,
  taskStatusOnDispatch,
  undoTaskDispatch,
  TASK_ASSIGN_CLAIM_MS,
  TASK_QUEUE_BUSY_RUN_REASONS,
  TASK_QUEUE_MAX_STRIKES,
  TASK_QUEUE_SCAN_LIMIT,
  TASK_QUEUE_SKIP_REASONS,
  TASK_QUEUE_STOP_REASONS,
  TASK_SOURCE_LINK_OVERWRITABLE,
  dispatchMayStampSourceLink,
  cadenceWakes,
  recentTaskDispatches,
  taskQueueSelecting,
  taskQueueStrikes,
  reset,
 };
}

module.exports = { createTaskDispatch };
