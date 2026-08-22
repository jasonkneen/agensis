'use strict';

// Capturing long-running chat work as a task.
//
// The gap this closes: asking an agent to do something real in a channel or a
// DM produced no task. Assigning a task to an agent has always opened a chat
// (server/task-dispatch.cjs), but the far more common direction — someone types
// the request straight into the conversation — left the work visible only as a
// "Thinking …" bubble in one thread. Nothing in the task list, nothing on the
// agent's card, nothing to look at a day later.
//
// WHAT COUNTS AS A TASK IS DECIDED BY BEHAVIOUR, NOT BY TEXT.
//
// This is the whole design and it is worth being explicit about, because the
// obvious alternative is wrong. Reading the message and guessing "is this a
// request or a remark" needs either a keyword list (which fires on "can you
// explain how X works" and misses "the deploy is red") or a model call on every
// single message in the workspace — latency and spend on the hot path, to
// answer a question the turn itself answers for free a minute later.
//
// So nothing is classified up front. A job that is STILL RUNNING after
// CAPTURE_AFTER_SECONDS is, definitionally, the long-running non-conversational
// work Jason described: a chat reply is a handful of seconds and a burst of
// tokens, while real work opens files, runs commands and takes minutes. The
// threshold is the classifier, it costs nothing, and it cannot be fooled by
// phrasing.
//
// The cost of that choice, stated plainly: a task appears about a minute after
// the work starts rather than instantly, and a genuinely long conversational
// answer is occasionally captured. Both are recoverable in one click. The
// reverse errors — a paid classifier on every message, or a task for every
// "thanks!" — are not.
//
// IDEMPOTENCY IS THE DATABASE'S JOB. The sweep runs every 30 seconds against
// jobs that stay running for many minutes, so it re-sees the same job perhaps
// forty times, and every Fly machine sweeps independently. `tasks.origin_job_id`
// carries a unique index and the insert is ON CONFLICT DO NOTHING; a duplicate
// is a no-op row count, not a second task. No application-level "does one exist
// already" check could survive two machines sweeping the same second.

// A conversational turn does not survive this. Deliberately well clear of a
// slow-but-ordinary reply (a daemon-backed agent thinking hard about a question
// can take 30-40s) so the common case is never captured.
const CAPTURE_AFTER_SECONDS = Number(process.env.AGENSIS_CHAT_TASK_CAPTURE_SECONDS || 90);
// One sweep's budget. The sweep is a backstop, not a queue: anything missed is
// picked up 30 seconds later, so there is no reason to let one tick do unbounded
// work against the database.
const CAPTURE_BATCH_LIMIT = 25;
const TASK_TITLE_MAX_CHARS = 90;
const TASK_DESCRIPTION_MAX_CHARS = 4000;

// Machine-authored messages. A schedule firing every ten minutes, an automation
// step or an integration webhook is not "someone posting a message", and each
// would mint a task on every single firing — the task list would become a log.
// Note what is NOT here: 'bridge' (a human typing from Telegram) and '' (the
// default a browser message carries) both count as people.
const NON_HUMAN_SENDER_KINDS = new Set(['agent', 'system', 'automation', 'integration']);

/** Strip the addressing so the title reads as the request, not as "@claude ...". */
function stripLeadingMentions(text) {
 return String(text || '').replace(/^(?:\s*@[a-z0-9_.-]+[,:]?\s*)+/i, '');
}

/**
 * First meaningful line of the request, as the task title.
 *
 * Same shape as feedbackTaskTitle in shared/backend-core.cjs — one line, capped,
 * ellipsised — because these rows sit in the same list and a task whose title is
 * four paragraphs makes the list unreadable. The full text is kept in
 * `description`, which the expanded row renders.
 */
function chatTaskTitle(content) {
 const firstLine = stripLeadingMentions(content)
  .split('\n')
  .map((line) => line.trim())
  .find(Boolean) || '';
 if (!firstLine) return 'Agent work from chat';
 return firstLine.length <= TASK_TITLE_MAX_CHARS
  ? firstLine
  : `${firstLine.slice(0, TASK_TITLE_MAX_CHARS - 1)}…`;
}

/** The body: what was asked, and where it is being worked. */
function chatTaskDescription({ content, agentName, sessionTitle, isDirectMessage }) {
 const where = isDirectMessage
  ? `a direct message with ${agentName || 'the agent'}`
  : `#${sessionTitle || 'a channel'}`;
 return [
  stripLeadingMentions(content).trim(),
  '',
  `Captured automatically from ${where} — ${agentName || 'an agent'} was already working on this when the task was created.`,
 ].join('\n').slice(0, TASK_DESCRIPTION_MAX_CHARS);
}

function createChatTaskCapture(deps = {}) {
 const {
  getDb,
  notifyDbSubscribers = () => {},
  captureAfterSeconds = CAPTURE_AFTER_SECONDS,
 } = deps;

 /**
  * Candidate jobs: running long enough to count, in a real conversation, and
  * not already captured.
  *
  * `created_by is not null` matters more than it looks. It is the human the job
  * is attributed to, and it becomes the task's `created_by` — a task with no
  * creator cannot be filtered by "mine", so a capture with nothing to put there
  * is not worth making.
  */
 async function selectCaptureCandidates(db) {
  return db.unsafe(
   `select j.id, j.workspace_id, j.agent_id, j.session_id, j.created_by, j.metadata,
             s.title as session_title, s.folder as session_folder,
             a.name as agent_name
        from agent_jobs j
        join chat_sessions s on s.id = j.session_id
        left join workspace_agents a on a.id = j.agent_id
       where j.status = 'running'
         and j.agent_id is not null
         and j.created_by is not null
         and j.started_at is not null
         and j.started_at < now() - make_interval(secs => $1::int)
         and coalesce(j.metadata->>'mode', '') <> 'farm'
         and not exists (select 1 from tasks t where t.origin_job_id = j.id)
       order by j.started_at asc
       limit $2`,
   [Math.max(1, Math.round(captureAfterSeconds)), CAPTURE_BATCH_LIMIT],
  );
 }

 /**
  * The message that started this turn, plus the one fact that decides whether a
  * task already exists for it.
  *
  * `threadTaskId` is the task-dispatch direction's fingerprint: when a task is
  * assigned to an agent, postTaskSubthreadMention seeds a thread whose ROOT
  * carries source_task_id (server/index.cjs). Capturing that would create a
  * second task for work that already has one, and — since the new task would
  * also be assigned to the same agent — the assignment would dispatch again.
  * That is the loop this join exists to prevent, so it checks the seed message
  * AND the thread root it hangs under.
  */
 async function loadSeedMessage(db, messageId, threadParentId) {
  if (!messageId) return null;
  const rows = await db.unsafe(
   `select m.id, m.content, m.sender_kind, m.deleted_at,
             coalesce(m.source_task_id, root.source_task_id, parent.source_task_id) as thread_task_id
        from messages m
        left join messages parent on parent.id = $2
        left join messages root on root.id = m.thread_parent_id
       where m.id = $1
       limit 1`,
   [String(messageId), threadParentId ? String(threadParentId) : null],
  );
  return rows[0] || null;
 }

 /**
  * Create the task for one job. Returns the row, or null when the job was
  * skipped or another sweep won the race.
  */
 async function captureOne(db, job) {
  const metadata = job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
  // A spoken huddle turn is conversation by definition, whatever it costs in
  // wall-clock. Someone talking for two minutes has not filed a ticket.
  if (metadata.voiceHuddle === true) return null;

  const threadParentId = metadata.workThreadParentId || metadata.threadParentId || null;
  const seed = await loadSeedMessage(db, metadata.lastSeenMessageId, threadParentId);
  // No seed message means no request to title the task with, and no way to show
  // the human what the agent is doing. Nothing worth writing.
  if (!seed || seed.deleted_at) return null;
  if (NON_HUMAN_SENDER_KINDS.has(String(seed.sender_kind || ''))) return null;
  // Already a task's work — this is the dispatch direction, coming back around.
  if (seed.thread_task_id) return null;
  // Judged AFTER stripping the addressing, not before. A bare "@claude" is a
  // summons, not a request: there is no sentence to title the row with, and a
  // list of tasks all called "Agent work from chat" is worse than no rows at
  // all. (chatTaskTitle keeps that fallback anyway so it stays total for its
  // other callers — this guard is what makes it unreachable from here.)
  const content = String(seed.content || '').trim();
  if (!stripLeadingMentions(content).trim()) return null;

  const isDirectMessage = String(job.session_folder || '') === 'Direct messages';
  // status 'in_progress' and assignee set from the outset: the work IS running,
  // by the agent named here. Writing it as 'todo' would describe a state that
  // was already false when the row was written.
  //
  // source_type 'chat' + source_id = the session is the SAME back-link
  // task-dispatch stamps, which is what makes the existing "Open chat" button
  // and TaskActivityChip work on these rows for free.
  //
  // ON CONFLICT DO NOTHING on the origin_job_id unique index: see the header.
  const rows = await db.unsafe(
   `insert into tasks
        (workspace_id, created_by, assignee_id, title, description, status, priority,
         source_type, source_id, origin_job_id)
      values ($1, $2, $3, $4, $5, 'in_progress', 'normal', 'chat', $6, $7)
      on conflict (origin_job_id) where origin_job_id is not null do nothing
      returning *`,
   [
    job.workspace_id,
    job.created_by,
    job.agent_id,
    chatTaskTitle(content),
    chatTaskDescription({
     content,
     agentName: job.agent_name,
     sessionTitle: job.session_title,
     isDirectMessage,
    }),
    job.session_id,
    job.id,
   ],
  );
  return rows[0] || null;
 }

 /**
  * The sweep. Registered beside the job reapers in server/index.cjs, so it runs
  * on the same 30-second tick.
  *
  * Per-job try/catch: one malformed job (or the origin_job_id column missing on
  * a database whose migration failed) must not stop the rest of the batch, and
  * must not turn capture into a boot-time hard dependency.
  */
 async function captureLongRunningChatTasks() {
  const db = getDb();
  let candidates = [];
  try {
   candidates = await selectCaptureCandidates(db);
  } catch (error) {
   console.warn('[chat-task-capture] candidate scan failed:', error?.message || error);
   return [];
  }

  const created = [];
  for (const job of candidates) {
   try {
    const task = await captureOne(db, job);
    if (!task) continue;
    created.push(task);
    // Same fanout tasks created any other way get, so the list and the agent
    // card update without a reload.
    notifyDbSubscribers('tasks', 'INSERT', [task]);
   } catch (error) {
    console.warn(`[chat-task-capture] capture failed for job ${job.id}:`, error?.message || error);
   }
  }
  return created;
 }

 /**
  * Close the captured task when its turn finishes. Called from every terminal
  * job transition (server/agent-jobs.cjs).
  *
  * Three deliberate narrownesses in the WHERE clause:
  *   * `origin_job_id = $1` — only ever a row this module created. A task a
  *     human typed is untouchable here, which is the entire reason the column
  *     exists rather than matching on session or assignee.
  *   * `status = 'in_progress'` — if someone has already moved it (to done, or
  *     back to todo because the answer was wrong) that judgement stands.
  *   * only on 'done' — an errored or cancelled turn leaves the task in
  *     progress ON PURPOSE. The work was not completed, and a task sitting in
  *     progress is exactly the signal that somebody should look at it. Silently
  *     closing it would hide the failure.
  */
 async function settleCapturedChatTask(jobId, status) {
  if (!jobId || status !== 'done') return null;
  try {
   const rows = await getDb().unsafe(
    `update tasks set status = 'done', completed_at = now(), updated_at = now()
        where origin_job_id = $1 and status = 'in_progress'
        returning *`,
    [String(jobId)],
   );
   if (rows.length === 0) return null;
   notifyDbSubscribers('tasks', 'UPDATE', rows);
   return rows[0];
  } catch (error) {
   console.warn('[chat-task-capture] settle failed:', error?.message || error);
   return null;
  }
 }

 return { captureLongRunningChatTasks, settleCapturedChatTask };
}

module.exports = {
 createChatTaskCapture,
 chatTaskTitle,
 chatTaskDescription,
 stripLeadingMentions,
 CAPTURE_AFTER_SECONDS,
 NON_HUMAN_SENDER_KINDS,
};
