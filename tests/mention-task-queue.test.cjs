// ============================================================================
// tests/mention-task-queue.test.cjs
// ----------------------------------------------------------------------------
// @mention is how work actually gets assigned in this product: a human comments
// "@coder pick this up" on a task. That path had the same bug the assignment path
// had — it flipped the task todo -> in_progress inline and then fired
// continueConversation fire-and-forget. When the agent was already mid-turn the
// one-active-job unique index bounced the job, the refused turn was discarded, and
// the task sat at 'in_progress' with nothing running it: indistinguishable from a
// task being worked on, and nothing would ever pick it up.
//
// What is under test here:
//   1. an @mention on a task while the agent is busy writes NO status, posts NO
//      message and runs NO turn — the task stays 'todo' + assigned, which is what
//      drainAgentTaskQueue selects;
//   2. the drain really does pick that task up once the agent frees up (which also
//      proves the mention released its dispatch claim);
//   3. an @mention on a FREE agent still dispatches immediately;
//   4. a turn refused in the race window rolls the task back to 'todo' and removes
//      the seed message nobody will answer;
//   5. that rollback is a compare-and-swap: it never re-opens a task a human closed
//      while the refused turn was in flight;
//   6. a mention with NO task (a plain DM mention on a document/memory comment) is
//      not gated by the task queue at all — it dispatches immediately, busy or not.
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
const SESSION = { id: 'dm-1', workspace_id: WS, folder: 'Direct messages' };

// The rate limiter is process-wide (60/min) and deliberately survives
// resetTestState, so every test comments as a different human.
let userSeq = 0;
const nextUser = () => `user-${++userSeq}`;

function taskRow(id, overrides = {}) {
  return {
    id,
    workspace_id: WS,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    assignee_id: null,
    source_type: 'manual',
    source_id: null,
    created_at: `2026-07-24T10:0${id.replace(/\D/g, '')}:00.000Z`,
    ...overrides,
  };
}

function liveJob(overrides = {}) {
  return {
    id: 'job-live',
    workspace_id: WS,
    agent_id: AGENT.id,
    session_id: SESSION.id,
    status: 'running',
    metadata: { mode: 'builtin' },
    ...overrides,
  };
}

// In-memory stand-in for the statements the mention + queue paths touch. Mutates
// real rows, so the assertions read the same state the server would.
function makeWorld({
  tasks = [],
  jobs = [],
  agents = [AGENT],
  sessions = [{
    ...SESSION,
    participants: [{ kind: 'agent', agent_id: AGENT.id, handle: 'coder', direct: true }],
  }],
  members = [],
} = {}) {
  const state = { tasks, jobs, agents, messages: [], sessions, members };
  const log = { sql: [], taskWrites: [] };
  let seq = 0;
  const findTask = (id) => state.tasks.find((t) => t.id === String(id));
  const active = (j) => j.status === 'queued' || j.status === 'running';

  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      log.sql.push({ n, params });

      // --- auth / actor ----------------------------------------------------
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) return [{ one: 1 }];
      if (n.startsWith('select role from workspace_members')) return [];
      if (n.startsWith('select display_name, email from app_users')) return [{ display_name: 'Jason' }];

      // --- tasks -----------------------------------------------------------
      if (n.startsWith('select title from tasks where id = $1')) {
        const task = findTask(params[0]);
        return task ? [{ title: task.title }] : [];
      }
      if (n.startsWith('select title from documents where id = $1')) return [{ title: 'Spec' }];
      if (n.startsWith('select id, status, source_type, source_id from tasks where id = $1')) {
        const task = findTask(params[0]);
        return task ? [{ id: task.id, status: task.status, source_type: task.source_type, source_id: task.source_id }] : [];
      }
      if (n.startsWith('select id, workspace_id, title, description, status, assignee_id, source_type, source_id')) {
        const task = findTask(params[0]);
        return task ? [{ ...task }] : [];
      }
      if (n.startsWith('select dispatch_requested_by from tasks')) {
        const task = findTask(params[0]);
        return task ? [{ dispatch_requested_by: task.dispatch_requested_by || null }] : [];
      }
      if (n.startsWith('select id, title, workspace_id, created_at from tasks')) {
        return state.tasks
          .filter((t) => t.workspace_id === params[0] && String(t.assignee_id || '') === String(params[1]) && t.status === 'todo')
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id))
          .slice(0, Number(params[2]))
          .map((t) => ({ id: t.id, title: t.title, workspace_id: t.workspace_id, created_at: t.created_at }));
      }
      if (n.startsWith('select count(*)::int as ahead from tasks')) {
        const self = findTask(params[2]);
        if (!self) return [{ ahead: 0 }];
        const ahead = state.tasks.filter((t) => t.workspace_id === params[0]
          && String(t.assignee_id || '') === String(params[1]) && t.status === 'todo'
          && (String(t.created_at) < String(self.created_at)
            || (t.created_at === self.created_at && t.id < self.id))).length;
        return [{ ahead }];
      }
      // The queued @mention: assignee only, so the drain owns the task. NO status.
      if (n.startsWith('update tasks set assignee_id = $1, dispatch_requested_by = $2, updated_at = now() where id = $3')) {
        const task = findTask(params[2]);
        if (!task) return [];
        task.assignee_id = params[0];
        task.dispatch_requested_by = params[1];
        log.taskWrites.push({ id: task.id, assignee_id: task.assignee_id, status: task.status, queued: true });
        return [{ ...task }];
      }
      if (n.startsWith("update tasks set assignee_id = $1, dispatch_requested_by = $2, status = $3, source_type = 'chat', source_id = $4")) {
        const task = findTask(params[4]);
        if (!task) return [];
        task.assignee_id = params[0];
        task.dispatch_requested_by = params[1];
        task.status = params[2];
        task.source_type = 'chat';
        task.source_id = params[3];
        log.taskWrites.push({ id: task.id, status: task.status, source_id: task.source_id });
        return [{ ...task }];
      }
      if (n.startsWith('update tasks set assignee_id = $1, dispatch_requested_by = $2, status = $3, updated_at = now() where id = $4')) {
        const task = findTask(params[3]);
        if (!task) return [];
        task.assignee_id = params[0];
        task.dispatch_requested_by = params[1];
        task.status = params[2];
        log.taskWrites.push({ id: task.id, status: task.status });
        return [{ ...task }];
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
      // The rollback is a compare-and-swap: it only fires while the status is still
      // the one the dispatch wrote.
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

      // --- agents / sessions ------------------------------------------------
      if (n.startsWith('select * from workspace_agents where workspace_id = $1 and enabled = true')) {
        return state.agents.filter((a) => a.workspace_id === String(params[0]) && a.enabled).map((a) => ({ ...a }));
      }
      if (n.startsWith('select * from workspace_agents where id = $1 and workspace_id = $2')) {
        const agent = state.agents.find((a) => a.id === String(params[0]) && a.workspace_id === String(params[1]));
        return agent ? [{ ...agent }] : [];
      }
      if (n.startsWith('select * from workspace_agents')) return state.agents.map((a) => ({ ...a }));
      if (n.startsWith('select * from chat_sessions where workspace_id')) {
        return state.sessions.map((session) => ({ ...session }));
      }
      if (n.startsWith('select user_id, source, (user_id = $2::uuid) as requested_user')) {
        return state.members
          .filter((member) => String(member.session_id) === String(params[0]))
          .map((member) => ({ user_id: member.user_id, source: member.source }));
      }

      // --- agent_jobs -------------------------------------------------------
      if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs where session_id')) {
        return state.jobs.filter((j) => j.session_id === String(params[0]) && j.agent_id === String(params[1]) && active(j));
      }
      if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs where workspace_id')) {
        return state.jobs.filter((j) => j.workspace_id === String(params[0]) && j.agent_id === String(params[1]) && active(j));
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
        const tagged = n.includes('source_task_id');
        const row = nested
          ? {
            id: `m-${seq}`,
            session_id: params[0],
            content: params[1],
            thread_parent_id: params[2],
            source_task_id: params[3],
            sender_id: params[4],
          }
          : tagged
            ? {
              id: `m-${seq}`,
              session_id: params[0],
              content: params[1],
              thread_parent_id: null,
              source_task_id: params[2],
              sender_id: params[3],
            }
            : {
              id: `m-${seq}`,
              session_id: params[0],
              content: params[1],
              thread_parent_id: null,
              source_task_id: null,
              sender_id: params[2],
            };
        state.messages.push(row);
        return [{ ...row }];
      }
      if (n.startsWith('delete from messages where id = $1 and session_id = $2')) {
        const index = state.messages.findIndex((m) => m.id === String(params[0]));
        if (index === -1) return [];
        return state.messages.splice(index, 1);
      }

      return [];
    },
  };
  return { state, log, db };
}

// Stands in for continueConversation. Models the ONE thing that made mentions
// vanish: a turn is refused when the agent already holds a live job for that
// session (the partial unique index), and the job simply never exists.
function jobRunner(world) {
  const runs = [];
  let seq = 0;
  const run = async ({ workspaceId, sessionId, threadParentId = null }) => {
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
      metadata: { mode: 'builtin', threadParentId },
    });
    return { started: true, reason: 'dispatched' };
  };
  return { runs, run };
}

const taskComment = (taskId, content = '@coder please pick this up') => ({
  id: 'c-1', task_id: taskId, workspace_id: WS, content, agent_id: null,
});
const documentComment = (content = '@coder thoughts on this?') => ({
  id: 'dc-1', document_id: 'doc-1', workspace_id: WS, content, agent_id: null,
});

const mention = (row, table, run) => __test.dispatchCommentMentions({
  table, row, authorUserId: nextUser(), run,
});

// --- (1) busy agent: the mention must not fake progress ----------------------

test('@mention on a task while the agent is busy leaves it todo and dispatches nothing', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')], jobs: [liveJob()] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await mention(taskComment('t-1'), 'task_comments', run);

  assert.equal(runs.length, 0, 'no turn was even attempted');
  const task = world.state.tasks[0];
  assert.equal(task.status, 'todo', 'still waiting, exactly as the human left it');
  assert.equal(task.source_id, null, 'and not pretending to be worked in a chat');
  assert.equal(task.source_type, 'manual', 'provenance untouched');
  assert.equal(task.assignee_id, AGENT.id, 'but it IS the mentioned agent\'s work now, so the drain owns it');
  assert.equal(world.state.messages.length, 0, 'nothing was posted into the DM');
  assert.equal(world.state.jobs.length, 1, 'no second job');
  // The exact state drainAgentTaskQueue selects on.
  assert.ok(world.state.tasks.some((t) => t.status === 'todo' && t.assignee_id === AGENT.id),
    "the task matches the drain's SELECT (todo + assigned)");
});

test('a busy @mention writes no status at all', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')], jobs: [liveJob()] });
  __test.setTestDb(world.db);
  const { run } = jobRunner(world);

  await mention(taskComment('t-1'), 'task_comments', run);

  const writes = world.log.taskWrites;
  assert.equal(writes.length, 1, 'exactly one task write: the assignment');
  assert.equal(writes[0].queued, true, 'and it is the assignee-only write');
  assert.equal(writes[0].status, 'todo', 'the status the human left it in is what stands');
  assert.ok(!world.log.sql.some((entry) => entry.n.includes("status = $2, source_type = 'chat'")),
    'the in_progress + chat-link write never ran');
});

// --- (2) the drain must be able to pick it up -------------------------------

test('the drain picks up a mention-queued task once the agent frees up', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')], jobs: [liveJob()] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await mention(taskComment('t-1'), 'task_comments', run);
  assert.equal(world.state.tasks[0].status, 'todo');

  // The agent's job finishes and the queue drains — well inside the mention claim
  // window, which only ever existed to swallow a double-fire from one human action.
  world.state.jobs[0].status = 'done';
  const drained = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });

  assert.equal(drained.dispatched, true, 'the drain is not refused as a "duplicate" — the claim was released');
  assert.equal(drained.taskId, 't-1');
  assert.equal(world.state.tasks[0].status, 'in_progress', 'now it really is being worked');
  assert.equal(world.state.tasks[0].source_id, SESSION.id, 'and linked to the chat it runs in');
  assert.equal(runs.length, 1, 'exactly one turn, on the drain');
});

test('two busy @mentions on different tasks both stay queued and drain FIFO', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1'), taskRow('t-2')], jobs: [liveJob()] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await mention(taskComment('t-1'), 'task_comments', run);
  await mention(taskComment('t-2'), 'task_comments', run);

  assert.equal(runs.length, 0);
  assert.deepEqual(world.state.tasks.map((t) => `${t.id}:${t.status}`), ['t-1:todo', 't-2:todo']);

  world.state.jobs[0].status = 'done';
  const first = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });
  assert.equal(first.taskId, 't-1', 'the task mentioned first runs first');
  assert.equal(world.state.tasks[1].status, 'todo', 't-2 is still waiting its turn');

  world.state.jobs.find((j) => j.id === 'job-1').status = 'done';
  const second = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });
  assert.equal(second.taskId, 't-2', 'and then t-2, one per completion');
});

// --- (3) a free agent still runs straight away ------------------------------

test('@mention on a task with a free agent dispatches immediately', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await mention(taskComment('t-1'), 'task_comments', run);

  assert.equal(runs.length, 1, 'the turn ran');
  assert.equal(world.state.tasks[0].status, 'in_progress');
  assert.equal(world.state.tasks[0].assignee_id, AGENT.id);
  assert.equal(world.state.tasks[0].source_id, SESSION.id);
  assert.equal(world.state.messages.length, 1, 'the agent was nagged exactly once');
  assert.equal(String(world.state.messages[0].source_task_id), 't-1', 'inside the task subthread');
  assert.equal(runs[0].threadParentId, world.state.messages[0].id, 'and the turn targets that subthread');
  assert.match(world.state.messages[0].content, /tagged you in a comment/, 'the comment is quoted, not a generic assignment');
});

test('a comment mention runs in the author’s own private DM with the agent', async () => {
  const authorA = 'human-a';
  const authorB = 'human-b';
  const sessionA = {
    ...SESSION,
    id: 'dm-a',
    participants: [{ kind: 'agent', agent_id: AGENT.id, handle: 'coder', direct: true }],
  };
  const sessionB = { ...sessionA, id: 'dm-b' };
  const world = makeWorld({
    tasks: [taskRow('t-1')],
    sessions: [sessionA, sessionB],
    members: [
      { session_id: sessionA.id, user_id: authorA, source: 'participant' },
      { session_id: sessionB.id, user_id: authorB, source: 'participant' },
    ],
  });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await __test.dispatchCommentMentions({
    table: 'task_comments',
    row: taskComment('t-1'),
    authorUserId: authorB,
    run,
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].sessionId, sessionB.id, 'the mention follows B, not the first DM for this agent');
  assert.equal(world.state.messages[0].session_id, sessionB.id);
  assert.equal(world.state.messages[0].sender_id, authorB);
  assert.equal(world.state.tasks[0].dispatch_requested_by, authorB);
  assert.equal(world.state.tasks[0].source_id, sessionB.id);
});

// --- (4) the race window: a refused turn must not strand the task -----------

test('a turn refused in the race window puts the task back to todo with no orphan message', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  // The busy check passed (no live job yet), but the job insert lost the race —
  // exactly what the one-active-job unique index does. This is the outcome the old
  // fire-and-forget threw away.
  const runs = [];
  const run = async (args) => { runs.push(args); return { started: false, reason: 'refused' }; };

  await mention(taskComment('t-1'), 'task_comments', run);

  assert.equal(runs.length, 1, 'the turn was attempted');
  const task = world.state.tasks[0];
  assert.equal(task.status, 'todo', 'and rolled back, not left in_progress with nothing running');
  assert.equal(task.source_type, 'manual', 'the provenance stamp was rolled back too');
  assert.equal(task.source_id, null);
  assert.equal(task.assignee_id, AGENT.id, 'still assigned, so the drain can retry it');
  assert.equal(world.state.messages.length, 0, 'the seed message nobody would answer was removed');
});

test('a mention-queued task refused in the race window is still drainable', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  let refuse = true;
  const runs = [];
  const run = async (args) => {
    runs.push(args);
    if (refuse) return { started: false, reason: 'refused' };
    return { started: true, reason: 'dispatched' };
  };

  await mention(taskComment('t-1'), 'task_comments', run);
  assert.equal(world.state.tasks[0].status, 'todo');

  refuse = false;
  const drained = await __test.drainAgentTaskQueue({ workspaceId: WS, agentId: AGENT.id, cause: 'test', run });
  assert.equal(drained.dispatched, true, 'the released claim lets the drain retry it');
  assert.equal(drained.taskId, 't-1');
  assert.equal(world.state.tasks[0].status, 'in_progress');
});

test('rolling back a refused mention never re-opens a task somebody just closed', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  // The human marked the task done while the refused turn was in flight. The
  // compare-and-swap rollback must lose that race, not win it.
  const run = async () => {
    world.state.tasks[0].status = 'done';
    return { started: false, reason: 'refused' };
  };

  await mention(taskComment('t-1'), 'task_comments', run);

  assert.equal(world.state.tasks[0].status, 'done', 'the human wins; the task is not dragged back to todo');
  assert.equal(world.state.messages.length, 0, 'the seed message is still cleaned up');
});

// --- (5) a mention with no task must not be gated ---------------------------

test('a mention with no task dispatches immediately, exactly as before', async () => {
  const world = makeWorld({ tasks: [] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await mention(documentComment(), 'document_comments', run);

  assert.equal(runs.length, 1, 'the agent was woken');
  assert.equal(runs[0].threadParentId, null, 'in the main DM timeline, not a task subthread');
  assert.equal(world.state.messages.length, 1);
  assert.equal(world.state.messages[0].source_task_id, null, 'no task attached');
  assert.equal(world.log.taskWrites.length, 0, 'and no task row was touched');
});

test('a mention with no task is not held back by a busy agent', async () => {
  // The task queue must not leak into the plain-DM path: this dispatch is
  // fire-and-forget and ungated, as it always was.
  const world = makeWorld({ tasks: [], jobs: [liveJob()] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await mention(documentComment(), 'document_comments', run);

  assert.equal(world.state.messages.length, 1, 'the message was posted regardless');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 1, 'and the turn was still attempted');
  assert.equal(world.log.taskWrites.length, 0);
});

// --- (6) the guards that were already there still hold ----------------------

test('an agent-authored comment never re-arms the mention dispatch', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await mention({ ...taskComment('t-1'), agent_id: AGENT.id }, 'task_comments', run);

  assert.equal(runs.length, 0, 'a mirrored agent reply cannot wake the agent again');
  assert.equal(world.log.taskWrites.length, 0);
});

test('a repeated @mention inside the claim window does not double-run the agent', async () => {
  const world = makeWorld({ tasks: [taskRow('t-1')] });
  __test.setTestDb(world.db);
  const { runs, run } = jobRunner(world);

  await mention(taskComment('t-1'), 'task_comments', run);
  await mention(taskComment('t-1'), 'task_comments', run);

  assert.equal(runs.length, 1, 'the second comment is swallowed by the claim, as before');
  assert.equal(world.state.messages.length, 1);
});
