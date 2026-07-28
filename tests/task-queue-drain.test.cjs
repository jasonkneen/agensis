// ============================================================================
// tests/task-queue-drain.test.cjs
// ----------------------------------------------------------------------------
// "I need to be able to assign tasks and they get done."
//
// Every task an agent is given lands in ONE DM session, and agent_jobs carries a
// partial unique index allowing ONE active job per (session_id, agent_id). So
// assigning three tasks to @coder at once used to run the first and SILENTLY DROP
// the other two: insertActiveAgentJob caught the 23505, returned null, and
// nothing retried — while taskStatusOnDispatch had already flipped all three to
// 'in_progress'. Two tasks read as "being worked on" with no job attached, and no
// agent would ever pick them up.
//
// The fix is a DB-backed FIFO queue: a task that is 'todo' AND assigned to an
// agent is waiting its turn, and every terminal job transition dispatches that
// agent's oldest waiting task. What is under test here:
//   1. three concurrent assignments dispatch exactly one and leave two WAITING
//      ('todo', not 'in_progress'-with-nothing-running);
//   2. a completed job dispatches exactly the SECOND task, not the whole backlog;
//   3. FIFO — assignment order is honoured;
//   4. the drain is a no-op while the agent still has a live job;
//   5. a task reassigned while it waited is never dispatched to the old agent,
//      and a done/cancelled one is never dispatched at all;
//   6. the 15s claim window does not swallow a legitimate later drain;
//   7. a dispatch that keeps failing for a non-queue reason is retired instead of
//      being retried on every future job completion;
//   8. the terminal hooks are really wired: finalizeAgentJobResult (completion),
//      finalizeStuckJob (timeout / daemon drop / restart) and cancelFarmAgentJob
//      each drain, and a refused turn leaves the task back at 'todo' with no
//      orphan seed message.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const WS = 'w1';
const AGENT = {
  id: 'agent-1',
  workspace_id: WS,
  name: 'Coder',
  handle: 'coder',
  enabled: true,
  model: 'claude-sonnet-4-6',
  run_mode: 'daemon',
};
const OTHER_AGENT = { ...AGENT, id: 'agent-2', name: 'Buzz', handle: 'buzz' };
const SESSION = { id: 'dm-1', workspace_id: WS, folder: 'Direct messages' };

function taskRow(id, overrides = {}) {
  return {
    id,
    workspace_id: WS,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    assignee_id: AGENT.id,
    source_type: 'manual',
    source_id: null,
    created_at: `2026-07-24T10:0${id.replace(/\D/g, '')}:00.000Z`,
    ...overrides,
  };
}

// In-memory stand-in for the handful of statements the queue touches. Mutates
// real rows, so the assertions read the same state the server would.
function makeWorld({ tasks = [], jobs = [], agents = [AGENT] } = {}) {
  const state = { tasks, jobs, agents, messages: [], session: { ...SESSION } };
  const log = { sql: [], taskWrites: [] };
  let seq = 0;
  const findTask = (id) => state.tasks.find((t) => t.id === String(id));
  const active = (j) => j.status === 'queued' || j.status === 'running';

  // "Waiting for its agent", modelled from the message thread rather than from the
  // server's WHERE clause — a mock that re-states the filter under test only ever
  // proves the mock. Only human messages carry source_task_id; the agent's replies
  // hang off that root, so the thread is root + its children, newest last.
  const threadOf = (taskId) => {
    const root = state.messages.find((m) => String(m.source_task_id) === String(taskId) && !m.thread_parent_id);
    if (!root) return [];
    return state.messages.filter((m) => m.id === root.id || m.thread_parent_id === root.id);
  };
  const hadLastWord = (taskId) => {
    const thread = threadOf(taskId);
    return thread.length > 0 && (thread[thread.length - 1].sender_kind || 'user') === 'agent';
  };
  const isWaiting = (t) => t.status !== 'done' && t.status !== 'cancelled'
    && (t.status === 'todo' || !hadLastWord(t.id));

  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      log.sql.push({ n, params });

      // --- tasks -----------------------------------------------------------
      if (n.startsWith('select id, workspace_id, title, description, status, assignee_id, source_type, source_id from tasks')) {
        const task = findTask(params[0]);
        return task ? [{ ...task }] : [];
      }
      if (n.startsWith('select id, title, workspace_id, created_at from tasks')) {
        return state.tasks
          .filter((t) => t.workspace_id === params[0] && String(t.assignee_id || '') === String(params[1]) && isWaiting(t))
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id))
          .slice(0, Number(params[2]))
          .map((t) => ({ id: t.id, title: t.title, workspace_id: t.workspace_id, created_at: t.created_at }));
      }
      if (n.startsWith('select (select count(*)::int from tasks t')) {
        const self = findTask(params[2]);
        if (!self) return [];
        const ahead = state.tasks.filter((t) => t.workspace_id === params[0]
          && String(t.assignee_id || '') === String(params[1]) && isWaiting(t)
          && (String(t.created_at) < String(self.created_at)
            || (t.created_at === self.created_at && t.id < self.id))).length;
        return [{ ahead, waiting: isWaiting(self) }];
      }
      if (n.startsWith("update tasks set status = $1, source_type = 'chat', source_id = $2")) {
        const task = findTask(params[2]);
        if (!task) return [];
        task.status = params[0];
        task.source_type = 'chat';
        task.source_id = params[1];
        log.taskWrites.push({ id: task.id, status: task.status, source_id: task.source_id });
        return [{ ...task }];
      }
      // The rollback is a compare-and-swap: it only fires while the status is
      // still the one the dispatch wrote.
      if (n.startsWith('update tasks set status = $1, source_type = $2, source_id = $3, updated_at = now() where id = $4 and status = $5')) {
        const task = findTask(params[3]);
        if (!task || task.status !== params[4]) return [];
        task.status = params[0];
        task.source_type = params[1];
        task.source_id = params[2];
        log.taskWrites.push({ id: task.id, status: task.status, source_id: task.source_id, undo: true });
        return [{ ...task }];
      }
      if (n.startsWith('update tasks set status = $1, updated_at = now() where id = $2 and status = $3')) {
        const task = findTask(params[1]);
        if (!task || task.status !== params[2]) return [];
        task.status = params[0];
        log.taskWrites.push({ id: task.id, status: task.status, undo: true });
        return [{ ...task }];
      }
      if (n.startsWith('update tasks set status = $1, updated_at = now() where id = $2')) {
        const task = findTask(params[1]);
        if (!task) return [];
        task.status = params[0];
        log.taskWrites.push({ id: task.id, status: task.status });
        return [{ ...task }];
      }
      if (n.startsWith('update tasks set updated_at = now()')) return [];

      // --- agents / sessions / users ---------------------------------------
      if (n.startsWith('select * from workspace_agents where id = $1 and workspace_id = $2')) {
        const agent = state.agents.find((a) => a.id === String(params[0]) && a.workspace_id === String(params[1]));
        return agent ? [{ ...agent }] : [];
      }
      if (n.startsWith('select * from workspace_agents')) return state.agents.map((a) => ({ ...a }));
      if (n.startsWith('select * from chat_sessions where workspace_id')) {
        return [{ ...state.session, participants: [{ kind: 'agent', agent_id: AGENT.id, handle: 'coder', direct: true }] }];
      }
      // continueConversation's own session lookup: left empty so the REAL
      // continueConversation is an inert no-op in the hook tests below.
      if (n.startsWith('select id, workspace_id, participants')) return [];
      if (n.startsWith('select display_name, email from app_users')) return [{ display_name: 'Jason' }];

      // --- agent_jobs -------------------------------------------------------
      if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs where session_id')) {
        return state.jobs.filter((j) => j.session_id === String(params[0]) && j.agent_id === String(params[1]) && active(j));
      }
      if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs where workspace_id')) {
        return state.jobs.filter((j) => j.workspace_id === String(params[0]) && j.agent_id === String(params[1]) && active(j));
      }
      if (n.startsWith("update agent_jobs set status = 'error', error = $2, finished_at = now(), updated_at = now() where id = $1 and status in ('queued', 'running')")) {
        const job = state.jobs.find((j) => j.id === String(params[0]) && active(j));
        if (!job) return [];
        job.status = 'error';
        return [{ id: job.id }];
      }
      if (n.startsWith("update agent_jobs set status = 'cancelled'")) {
        const job = state.jobs.find((j) => j.id === String(params[0]) && active(j));
        if (!job) return [];
        job.status = 'cancelled';
        return [{ ...job }];
      }
      if (n.startsWith('update agent_jobs set status = $2, response = $3')) {
        const job = state.jobs.find((j) => j.id === String(params[0]));
        if (!job) return [];
        job.status = params[1];
        return [{ ...job }];
      }
      if (n.startsWith("select * from agent_jobs where id = $1 and workspace_id = $2 and (metadata->>'mode') = 'farm'")) {
        const job = state.jobs.find((j) => j.id === String(params[0]));
        return job ? [{ ...job }] : [];
      }

      // --- messages ---------------------------------------------------------
      if (n.startsWith('select id from messages where session_id')) {
        const root = state.messages.find((m) => m.session_id === params[0]
          && String(m.source_task_id) === String(params[1]) && !m.thread_parent_id);
        return root ? [{ id: root.id }] : [];
      }
      if (n.startsWith('insert into messages')) {
        seq += 1;
        const nested = n.includes('thread_parent_id, source_task_id');
        // sender_kind is a literal in both inserts: every message a task dispatch
        // writes is the human's nag. The agent's reply arrives on the daemon
        // result path instead — see postAgentReply.
        const row = nested
          ? { id: `m-${seq}`, session_id: params[0], content: params[1], thread_parent_id: params[2], source_task_id: params[3], sender_kind: 'user' }
          : { id: `m-${seq}`, session_id: params[0], content: params[1], thread_parent_id: null, source_task_id: params[2], sender_kind: 'user' };
        state.messages.push(row);
        return [{ ...row }];
      }
      if (n.startsWith('delete from messages where id = $1 and session_id = $2')) {
        const index = state.messages.findIndex((m) => m.id === String(params[0]));
        if (index === -1) return [];
        return state.messages.splice(index, 1);
      }
      if (n.startsWith('update messages set content')) return [];

      return [];
    },
  };
  return { state, log, db };
}

// Stands in for continueConversation. Models the ONE thing that made tasks
// vanish: a turn is refused when the agent already holds a live job for that
// session (the partial unique index), and the job simply never exists.
function jobRunner(world, { mode = 'builtin' } = {}) {
  const runs = [];
  let seq = 0;
  const run = async ({ workspaceId, sessionId, threadParentId }) => {
    runs.push({ workspaceId, sessionId, threadParentId });
    const busy = world.state.jobs.some((j) => j.session_id === sessionId
      && (j.status === 'queued' || j.status === 'running'));
    if (busy) return { started: false, reason: 'refused' };
    seq += 1;
    world.state.jobs.push({
      id: `job-${seq}`,
      workspace_id: workspaceId,
      agent_id: AGENT.id,
      session_id: sessionId,
      status: 'running',
      metadata: { mode, threadParentId },
    });
    // Every real turn path writes the agent's "Thinking 0s" placeholder into the
    // work thread as the job is created (builtin-turn.cjs, all three lanes), and
    // insertActiveAgentJob DELETES it again if the job is refused. That is what
    // takes a task out of the waiting set the moment it starts being worked —
    // without it the drain would hand the same task out over and over.
    if (threadParentId) {
      world.state.messages.push({
        id: `m-placeholder-${seq}`,
        session_id: sessionId,
        content: 'Thinking 0s',
        thread_parent_id: threadParentId,
        source_task_id: null,
        sender_kind: 'agent',
      });
    }
    return { started: true, reason: 'dispatched' };
  };
  return { runs, run };
}

// Let the fire-and-forget drain settle. Polls instead of sleeping a fixed time so
// it cannot flake, and never waits longer than it has to.
async function settle(predicate, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

const statuses = (world) => world.state.tasks.map((t) => `${t.id}:${t.status}`).sort();

// What a task that has ALREADY been started looks like: the human's seed nag plus
// the agent's "Thinking 0s" placeholder in its subthread. `status: 'in_progress'`
// alone is not that — a task can also be in progress with no thread at all, which
// is precisely the assigned-but-never-dispatched case the drain now has to catch.
// Fixtures that mean "this one is being worked on" have to say so.
function seedStartedThread(world, taskId) {
  const rootId = `m-seed-${taskId}`;
  world.state.messages.push(
    { id: rootId, session_id: SESSION.id, content: `@coder — task ${taskId}`, thread_parent_id: null, source_task_id: taskId, sender_kind: 'user' },
    { id: `m-thinking-${taskId}`, session_id: SESSION.id, content: 'Thinking 0s', thread_parent_id: rootId, source_task_id: null, sender_kind: 'agent' },
  );
}

// The agent answering in the task's subthread. Written by the daemon result path,
// not by continueConversation, so it is posted explicitly rather than folded into
// jobRunner — and it is what takes a task back OUT of the queue.
function postAgentReply(world, taskId) {
  const root = world.state.messages.find((m) => String(m.source_task_id) === String(taskId) && !m.thread_parent_id);
  assert.ok(root, `no subthread exists for ${taskId} to reply in`);
  world.state.messages.push({
    id: `m-agent-${world.state.messages.length + 1}`,
    session_id: SESSION.id,
    content: 'Done.',
    thread_parent_id: root.id,
    source_task_id: null,
    sender_kind: 'agent',
  });
}

// --- (0) queued at a status the drain could not see --------------------------
//
// The live failure this file was extended for: BOTH queue-admission paths leave
// the task's status alone, and the drain only ever selected `status = 'todo'`.
// Assign or nag anything that is already in progress and it was admitted to the
// queue, logged with a confident position, and then never looked at again.

test('a task queued while it is already in progress is drained, not stranded', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-1', { status: 'in_progress' })],
    jobs: [{ id: 'job-live', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'running', metadata: { mode: 'builtin' } }],
  });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  const out = await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-1', agentId: AGENT.id, run });
  assert.equal(out.reason, 'queued', 'the agent is mid-turn, so it goes into the queue');
  assert.equal(runs.length, 0);

  // The agent frees up. This is the moment the task used to vanish for good.
  world.state.jobs[0].status = 'done';
  const drained = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run });

  assert.equal(drained.dispatched, true, 'the in-progress task is picked up');
  assert.equal(drained.taskId, 't-1');
  assert.equal(runs.length, 1, 'and a real turn runs for it');
});

test('a task assigned but never dispatched is waiting, whatever status it carries', async () => {
  // Two tasks left over from a dropped dispatch: assigned, in_progress, no thread.
  const world = makeWorld({ tasks: [taskRow('t-1', { status: 'in_progress' }), taskRow('t-2', { status: 'in_progress' })] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  const first = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run });
  assert.equal(first.taskId, 't-1', 'oldest first, exactly as for todo tasks');

  world.state.jobs[0].status = 'done';
  const second = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run });
  assert.equal(second.taskId, 't-2', 'and the backlog keeps draining');
  assert.equal(runs.length, 2);
});

test('an in-progress task the agent has already answered is NOT re-dispatched', async () => {
  // The loop the status widening would otherwise open: without the last-word test
  // this task would be re-run on every single job completion, forever.
  const world = makeWorld({ tasks: [taskRow('t-1', { status: 'in_progress' })] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  const first = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run });
  assert.equal(first.dispatched, true, 'it starts once');

  postAgentReply(world, 't-1');
  world.state.jobs[0].status = 'done';

  const again = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run });
  assert.equal(again.dispatched, false, 'the agent had the last word, so it is done here');
  assert.equal(again.reason, 'empty');
  assert.equal(runs.length, 1, 'exactly one turn was ever spent on it');
});

test('a human nagging an answered task puts it back in the queue', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1', { status: 'in_progress' })] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run });
  postAgentReply(world, 't-1');
  world.state.jobs[0].status = 'done';
  assert.equal((await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run })).dispatched, false);

  // A successful dispatch KEEPS its claim for 15s so a re-save cannot double-run
  // it. A human nag minutes later is past that window; the test is not.
  __test.releaseTaskDispatch('t-1', AGENT.id);

  // A human replies in the subthread — the @mention path's queue admission.
  const root = world.state.messages.find((m) => String(m.source_task_id) === 't-1' && !m.thread_parent_id);
  world.state.messages.push({
    id: 'm-human-nag', session_id: SESSION.id, content: 'any update?',
    thread_parent_id: root.id, source_task_id: 't-1', sender_kind: 'user',
  });

  const woken = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run });
  assert.equal(woken.dispatched, true, 'the human has the last word again, so the agent owes a reply');
  assert.equal(runs.length, 2);
});

test('taskQueuePosition never invents a position for a task the drain will not take', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1', { status: 'in_progress' }), taskRow('t-2')] });
  __test.setTestDb(world.db);
  const { run } = jobRunner(world);

  await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, run });
  postAgentReply(world, 't-1');

  // t-1 is answered, so it is out of the queue — and must not report a position.
  assert.equal(await __test.taskQueuePosition(WS, AGENT.id, 't-1'), 0, 'answered means no position, not "1"');
  // t-2 is genuinely first in line now that t-1 has dropped out.
  assert.equal(await __test.taskQueuePosition(WS, AGENT.id, 't-2'), 1, 'and the number ahead reflects the same set the drain reads');
});

// --- (1) three tasks, one agent ---------------------------------------------

test('assigning three tasks to one agent runs the first and leaves two WAITING, not half-started', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1'), taskRow('t-2'), taskRow('t-3')] });
  __test.setTestDb(world.db);
  const { run } = jobRunner(world);

  // Three assignments landing at once — the shape that used to drop two.
  const outcomes = await Promise.all(['t-1', 't-2', 't-3'].map((taskId) =>
    __test.dispatchTaskAssignment({ workspaceId: WS, taskId, agentId: AGENT.id, run })));

  assert.equal(outcomes.filter((o) => o.dispatched).length, 1, 'exactly one task starts');
  assert.equal(outcomes.filter((o) => o.reason === 'queued').length, 2, 'the other two report as queued');
  assert.equal(world.state.jobs.length, 1, 'one agent job exists, because only one can');

  // The whole point: nothing is left claiming to be in progress with no job.
  const inProgress = world.state.tasks.filter((t) => t.status === 'in_progress');
  assert.equal(inProgress.length, 1, 'exactly one task reads as in progress');
  assert.equal(world.state.tasks.filter((t) => t.status === 'todo').length, 2, 'two are still waiting');

  // ...and the running one is the one the job belongs to.
  assert.equal(world.state.jobs[0].session_id, SESSION.id);
  assert.equal(inProgress[0].source_id, SESSION.id, 'the started task is linked to the chat it runs in');

  // No orphan seed messages for the two that never started. (Seed nags carry
  // source_task_id; the agent's own placeholder does not.)
  assert.equal(world.state.messages.filter((m) => m.source_task_id).length, 1, 'only the dispatched task was nagged about');
});

test('a queued task keeps the status the human left it in and gains no chat link', async () => {
  // The agent is already mid-turn, so this assignment cannot start.
  const world = makeWorld({
    tasks: [taskRow('t-9')],
    jobs: [{ id: 'job-live', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'running', metadata: { mode: 'builtin' } }],
  });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  const out = await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-9', agentId: AGENT.id, run });

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'queued');
  assert.equal(runs.length, 0, 'no turn was even attempted');
  assert.equal(world.state.tasks[0].status, 'todo', 'still waiting, exactly as assigned');
  assert.equal(world.state.tasks[0].source_id, null, 'and not pretending to be worked in a chat');
  assert.equal(world.log.taskWrites.length, 0, 'the task row was not touched at all');
  assert.equal(world.state.messages.length, 0, 'and nothing was posted into the DM');
});

// --- (2) draining on completion ---------------------------------------------

test('completing the first task dispatches exactly the second, never the whole backlog', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1'), taskRow('t-2'), taskRow('t-3')] });
  __test.setTestDb(world.db);
  const { run } = jobRunner(world);

  await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-1', agentId: AGENT.id, run });
  await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-2', agentId: AGENT.id, run });
  await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-3', agentId: AGENT.id, run });
  assert.deepEqual(statuses(world), ['t-1:in_progress', 't-2:todo', 't-3:todo']);

  // t-1's JOB finishes (the task's own status is the agent's to close).
  world.state.jobs[0].status = 'done';
  const drained = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });

  assert.equal(drained.dispatched, true);
  assert.equal(drained.taskId, 't-2', 'the OLDEST waiting task goes next');
  assert.deepEqual(statuses(world), ['t-1:in_progress', 't-2:in_progress', 't-3:todo'],
    'exactly one more task started; t-3 is still waiting its turn');
  assert.equal(world.state.jobs.filter((j) => j.status === 'running').length, 1, 'never two live jobs');

  // ...and again, once t-2's job is done.
  world.state.jobs[1].status = 'done';
  const second = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });
  assert.equal(second.taskId, 't-3', 'FIFO all the way down');
  assert.deepEqual(statuses(world), ['t-1:in_progress', 't-2:in_progress', 't-3:in_progress']);
  assert.equal(world.state.jobs.filter((j) => j.status === 'running').length, 1, 'still only one at a time');
});

test('FIFO follows assignment order, not id order', async () => {
  const world = makeWorld({
    tasks: [
      taskRow('t-1', { created_at: '2026-07-24T12:00:00.000Z' }),
      taskRow('t-2', { created_at: '2026-07-24T09:00:00.000Z' }),
    ],
  });
  __test.setTestDb(world.db);
  const { run } = jobRunner(world);

  const out = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });
  assert.equal(out.taskId, 't-2', 'the task assigned first runs first');
});

// --- (3) never burn a turn on a busy agent ----------------------------------

test('draining is a no-op while the agent still has a live job', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-1')],
    jobs: [{ id: 'job-live', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'running', metadata: { mode: 'builtin' } }],
  });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  const out = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'busy');
  assert.equal(runs.length, 0, 'no second turn was started');
  assert.equal(world.state.tasks[0].status, 'todo');
});

test('draining an agent with nothing waiting is free and silent', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1', { status: 'in_progress' })] });
  seedStartedThread(world, 't-1'); // already being worked on — not waiting
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  const out = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });
  assert.equal(out.reason, 'empty');
  assert.equal(runs.length, 0);
});

// --- (4) the queue must not resurrect or misroute work ----------------------

test('a task reassigned while it waited is never dispatched to the old agent', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-1'), taskRow('t-2', { assignee_id: OTHER_AGENT.id })],
    agents: [AGENT, OTHER_AGENT],
  });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  // t-1 is queued behind nothing, so it goes. Then it is handed to @buzz while
  // the drain is looking at it.
  world.state.tasks[0].assignee_id = OTHER_AGENT.id;
  const out = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'empty', "@coder's queue is empty once the task moved");
  assert.equal(runs.length, 0, '@coder was not woken for work that is no longer its own');
  assert.equal(world.state.tasks[0].status, 'todo');
});

test('a reassignment that races the drain is refused at dispatch, not just at select', async () => {
  // Belt AND braces: the drain picked the task up while it was still @coder's,
  // and the row changed underneath it before dispatchTaskAssignment re-read it.
  const world = makeWorld({ tasks: [taskRow('t-1', { assignee_id: OTHER_AGENT.id })], agents: [AGENT, OTHER_AGENT] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  const out = await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'stale_assignee');
  assert.equal(runs.length, 0);
  assert.equal(world.log.taskWrites.length, 0, 'the task was not touched');
});

test('a done or cancelled task is never dispatched by the queue', async () => {
  for (const status of ['done', 'cancelled']) {
    const world = makeWorld({ tasks: [taskRow('t-1', { status }), taskRow('t-2')] });
    __test.setTestDb(world.db);
    const { runs, run } = jobRunner(world);

    const out = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });

    assert.equal(out.taskId, 't-2', `a ${status} task is skipped, the live one runs`);
    assert.equal(runs.length, 1);
    assert.equal(world.state.tasks[0].status, status, `the ${status} task is untouched`);
    __test.resetTestState();
  }
});

test('a done task is not dispatched even if it is handed straight to dispatch', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1', { status: 'done' })] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  const out = await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(out.reason, 'terminal');
  assert.equal(runs.length, 0);
  assert.equal(world.state.jobs.length, 0);
});

test('rolling back a refused dispatch never re-opens a task somebody just closed', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  // The turn is refused, but the human marked the task done while it was in
  // flight. The rollback must lose that race, not win it.
  const run = async () => {
    world.state.tasks[0].status = 'done';
    return { started: false, reason: 'refused' };
  };

  const out = await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(out.dispatched, false);
  assert.equal(world.state.tasks[0].status, 'done', 'the human wins; the task is not dragged back to todo');
  assert.equal(world.state.messages.length, 0, 'the seed message is still cleaned up');
});

// --- (5) the claim window must not swallow a real drain ---------------------

test('a refused dispatch releases its claim, so the drain seconds later is not a "duplicate"', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-1')],
    jobs: [{ id: 'job-live', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'running', metadata: { mode: 'builtin' } }],
  });
  __test.setTestDb(world.db);
  const { run } = jobRunner(world);

  // Refused: the agent is busy. The 15s claim window is still wide open.
  const first = await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-1', agentId: AGENT.id, run });
  assert.equal(first.reason, 'queued');

  // The job finishes a moment later and the queue drains — well inside the claim
  // window, which was only ever meant to swallow a double-fire from one click.
  world.state.jobs[0].status = 'done';
  const out = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });

  assert.equal(out.dispatched, true, 'the drain is not mistaken for a duplicate click');
  assert.equal(out.taskId, 't-1');
  assert.equal(world.state.tasks[0].status, 'in_progress');
});

test('a successful dispatch KEEPS its claim, so a re-save still cannot double-run it', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-1', agentId: AGENT.id, run });
  const again = await __test.dispatchTaskAssignment({ workspaceId: WS, taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(again.reason, 'duplicate');
  assert.equal(runs.length, 1);
});

// --- (6) a non-queue failure must not spin forever -------------------------

test('a dispatch that keeps failing for a non-queue reason is retired after N tries', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1'), taskRow('t-2')] });
  __test.setTestDb(world.db);
  // A run that never starts, for a reason the queue cannot fix (e.g. the
  // subthread's turn budget is spent). Not a "busy" reason, so it counts strikes.
  const runs = [];
  const run = async (args) => { runs.push(args); return { started: false, reason: 'budget_exhausted' }; };

  for (let i = 0; i < __test.TASK_QUEUE_MAX_STRIKES; i++) {
    const out = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });
    assert.equal(out.taskId, 't-1', 'the head of the queue is retried a bounded number of times');
    assert.equal(out.reason, 'not_started');
    assert.equal(world.state.tasks[0].status, 'todo', 'and is put back each time, not left half-started');
    assert.equal(world.state.messages.length, 0, 'with no orphan seed message piling up');
  }

  // Attempt N+1: the poisoned task is skipped and the queue moves on instead of
  // burning every future job completion on it.
  const after = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });
  assert.equal(after.taskId, 't-2', 'the head of the queue no longer blocks the rest');
  assert.equal(runs.length, __test.TASK_QUEUE_MAX_STRIKES + 1, 'exactly one attempt per drain');
});

test('one completed job produces at most one dispatch attempt', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1'), taskRow('t-2'), taskRow('t-3')] });
  __test.setTestDb(world.db);
  const runs = [];
  const run = async (args) => { runs.push(args); return { started: false, reason: 'error' }; };

  await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });

  assert.equal(runs.length, 1, 'a failed attempt does not cascade through the backlog');
  assert.deepEqual(statuses(world), ['t-1:todo', 't-2:todo', 't-3:todo'], 'and nothing is left half-started');
});

// --- (7) the terminal hooks are really wired -------------------------------
//
// These drive the REAL terminal paths. The drain they fire uses the real
// continueConversation, which is inert against this fake DB — so the observable
// proof is that the drain reached the oldest waiting task (FIFO) and, because the
// turn did not start, put it straight back to 'todo' with no orphan message. That
// is both "the hook fires" and "a refused dispatch stays visibly queued".

async function assertHookDrained(world, taskId) {
  const attempted = await settle(() => world.log.taskWrites.some((w) => w.id === taskId));
  assert.equal(attempted, true, `the drain reached ${taskId}`);
  await settle(() => world.state.tasks.find((t) => t.id === taskId)?.status === 'todo');
  const task = world.state.tasks.find((t) => t.id === taskId);
  assert.equal(task.status, 'todo', `${taskId} is back to waiting, not stuck in_progress`);
  assert.equal(task.source_id, null, `${taskId} does not claim to be worked in a chat`);
  const orphans = world.state.messages.filter((m) => String(m.source_task_id) === taskId);
  assert.equal(orphans.length, 0, 'and the seed message nobody could answer was removed');
}

test('finishing a job drains the queue (finalizeAgentJobResult)', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-1', { status: 'in_progress' }), taskRow('t-2'), taskRow('t-3')],
    jobs: [{ id: 'job-1', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'running', metadata: { mode: 'daemon' } }],
  });
  seedStartedThread(world, 't-1'); // t-1 is what job-1 is working on
  __test.setTestDb(world.db);

  await __test.finalizeAgentJobResult(
    { ...world.state.jobs[0], agent_name: 'Coder', agent_handle: 'coder' },
    { responseText: 'done' },
  );

  await assertHookDrained(world, 't-2');
  assert.equal(world.state.tasks.find((t) => t.id === 't-3').status, 'todo', 't-3 was never touched');
  assert.ok(!world.log.taskWrites.some((w) => w.id === 't-3'), 't-3 was not even attempted');
});

test('a timed-out or abandoned job drains the queue (finalizeStuckJob)', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-1', { status: 'in_progress' }), taskRow('t-2')],
    jobs: [{ id: 'job-1', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'running', metadata: { mode: 'daemon', handle: 'coder' } }],
  });
  seedStartedThread(world, 't-1'); // t-1 is what the wedged job was working on
  __test.setTestDb(world.db);

  // The same path the reaper, the socket-close sweep and startup reconcile use.
  await __test.finalizeStuckJob(world.state.jobs[0], 'timed out');

  assert.equal(world.state.jobs[0].status, 'error', 'the wedged job was finalized');
  await assertHookDrained(world, 't-2');
});

test('a job that was already finalized does not drain twice', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-2')],
    jobs: [{ id: 'job-1', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'done', metadata: { mode: 'daemon' } }],
  });
  __test.setTestDb(world.db);

  await __test.finalizeStuckJob(world.state.jobs[0], 'timed out');
  await settle(() => false, 20);

  assert.equal(world.log.taskWrites.length, 0, 'a no-op finalize is a no-op drain');
});

test('cancelling a job drains the queue (cancelFarmAgentJob)', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-2')],
    jobs: [{ id: 'job-1', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'running', metadata: { mode: 'farm' } }],
  });
  __test.setTestDb(world.db);

  await __test.cancelFarmAgentJob({ workspaceId: WS, jobId: 'job-1' });

  assert.equal(world.state.jobs[0].status, 'cancelled');
  await assertHookDrained(world, 't-2');
});

// --- (8) the drain never breaks the write that triggered it -----------------

test('a drain that throws cannot fail the job completion that fired it', async () => {
  const world = makeWorld({
    tasks: [taskRow('t-2')],
    jobs: [{ id: 'job-1', workspace_id: WS, agent_id: AGENT.id, session_id: SESSION.id, status: 'running', metadata: { mode: 'daemon' } }],
  });
  const exploding = {
    async unsafe(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id, title, workspace_id, created_at from tasks')) throw new Error('queue lookup exploded');
      return world.db.unsafe(sql, params);
    },
  };
  __test.setTestDb(exploding);

  const out = await __test.finalizeAgentJobResult(
    { ...world.state.jobs[0], agent_name: 'Coder', agent_handle: 'coder' },
    { responseText: 'done' },
  );

  assert.ok(out, 'the job result was still written');
  assert.equal(world.state.jobs[0].status, 'done');
  await settle(() => false, 20); // let the failed drain settle; it must not reject
});

// --- (9) inputs -------------------------------------------------------------

test('draining without a workspace or an agent is inert', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  assert.equal((await __test.drainAgentTaskQueue({ workspaceId: '', agentId: AGENT.id, run })).reason, 'missing_input');
  assert.equal((await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: '', run })).reason, 'missing_input');
  assert.equal(runs.length, 0);
});

test('the drain reads no more than TASK_QUEUE_SCAN_LIMIT candidates', async () => {
  const world = makeWorld({ tasks: [] });
  __test.setTestDb(world.db);
  await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test' });
  const select = world.log.sql.find((entry) => entry.n.startsWith('select id, title, workspace_id, created_at from tasks'));
  assert.ok(select, 'the queue was queried');
  assert.equal(select.params[2], __test.TASK_QUEUE_SCAN_LIMIT, 'bounded, so a huge backlog is still one cheap read');
});
