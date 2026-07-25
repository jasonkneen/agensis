// ============================================================================
// tests/task-assign-dispatch.test.cjs
// ----------------------------------------------------------------------------
// Assigning a task to an agent DISPATCHES it (2026-07): setting assignee_id to a
// workspace agent wakes that agent in its DM, inside the task's own subthread,
// and stamps source_type='chat' / source_id=<session id> so the task can offer
// "Open chat". This is a trigger that spends tokens, so the guarantees under
// test are mostly about NOT firing:
//   1. assigning an agent dispatches exactly once and stamps the chat link;
//   2. re-saving the SAME assignee does not dispatch (idempotent);
//   3. assigning a human user does not dispatch;
//   4. a done/cancelled task never dispatches;
//   5. a disabled agent does not dispatch;
//   6. a second dispatch of the same (task, agent) inside the claim window is
//      refused — this is what stops the comment-@mention path and the
//      assignee-write path (one human action, two writes) running the agent
//      twice, and what stops an agent's own task updates re-arming dispatch;
//   7. an existing provenance (source_type 'ai'/'canvas') is NOT overwritten.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const AGENT = {
  id: 'agent-1',
  workspace_id: 'w1',
  name: 'Coder',
  handle: 'coder',
  enabled: true,
  model: 'claude-sonnet-4-6',
};

// Minimal fake DB covering only the statements dispatchTaskAssignment issues.
// Records every write so the assertions can prove what did (and didn't) happen.
function dispatchDb({ task, agent = AGENT, session = { id: 'dm-1', workspace_id: 'w1' } } = {}) {
  const writes = { taskUpdates: [], messageInserts: [], sessionInserts: [] };
  let seq = 0;
  return {
    writes,
    db: {
      async unsafe(sql, params) {
        const n = String(sql).replace(/\s+/g, ' ').trim();
        if (n.startsWith('select id, workspace_id, title, description, status, assignee_id, source_type, source_id from tasks')) {
          return task ? [task] : [];
        }
        if (n.startsWith('select * from workspace_agents where id')) {
          return agent && String(agent.id) === String(params[0]) ? [agent] : [];
        }
        if (n.startsWith('select * from chat_sessions')) return [session];
        if (n.startsWith('select display_name, email from app_users')) {
          return [{ display_name: 'Jason', email: 'jason@example.com' }];
        }
        if (n.startsWith('update tasks set')) {
          writes.taskUpdates.push({ sql: n, params });
          return [{ ...task, id: params[params.length - 1] }];
        }
        if (n.startsWith('select id from messages where session_id')) return [];
        if (n.startsWith('insert into messages')) {
          seq += 1;
          writes.messageInserts.push({ id: `m-${seq}`, sql: n, params });
          return [{ id: `m-${seq}` }];
        }
        if (n.startsWith('insert into chat_sessions')) {
          writes.sessionInserts.push({ sql: n, params });
          return [session];
        }
        return [];
      },
    },
  };
}

function taskRow(overrides = {}) {
  return {
    id: 't-1',
    workspace_id: 'w1',
    title: 'Ship the thing',
    description: 'With tests.',
    status: 'todo',
    assignee_id: AGENT.id,
    source_type: 'manual',
    source_id: null,
    ...overrides,
  };
}

// Collects continueConversation calls instead of running a real agent turn.
function recorder() {
  const runs = [];
  return { runs, run: async (args) => { runs.push(args); } };
}

// --- (1) the happy path -----------------------------------------------------

test('assigning a task to an agent dispatches it once and links the chat', async () => {
  const { db, writes } = dispatchDb({ task: taskRow() });
  __test.setTestDb(db);
  const { runs, run } = recorder();

  const out = await __test.dispatchTaskAssignment({
    workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, actorUserId: null, run,
  });

  assert.equal(out.dispatched, true, 'the agent was dispatched');
  assert.equal(runs.length, 1, 'the agent runs exactly once');
  assert.equal(runs[0].sessionId, 'dm-1', 'it runs in the agent DM');
  assert.equal(runs[0].threadParentId, writes.messageInserts[0].id, 'inside the task subthread');
  assert.equal(writes.messageInserts.length, 1, 'one seed message, not a flood');

  // the task is stamped with the chat it is being worked in
  assert.equal(writes.taskUpdates.length, 1, 'one task write');
  const update = writes.taskUpdates[0];
  assert.ok(update.sql.includes("source_type = 'chat'"), 'source_type is stamped chat');
  assert.ok(update.params.includes('dm-1'), 'source_id is the DM session id');
  assert.ok(update.params.includes('in_progress'), 'a fresh task moves into progress');
});

test('the dispatch message names the task so the agent knows what to do', async () => {
  const { db, writes } = dispatchDb({ task: taskRow() });
  __test.setTestDb(db);
  const { run } = recorder();

  await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, run });

  const content = writes.messageInserts[0].params.find(p => typeof p === 'string' && p.includes('@coder'));
  assert.ok(content, 'the seed message addresses the agent');
  assert.ok(content.includes('Ship the thing'), 'it carries the task title');
  assert.ok(content.includes('agensis://task/t-1'), 'it links back to the task');
});

// --- (2) idempotency: nothing else may re-run the agent ---------------------

test('re-saving the same assignee does not dispatch again', async () => {
  const { db, writes } = dispatchDb({ task: taskRow() });
  __test.setTestDb(db);
  const { runs, run } = recorder();

  const first = await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, run });
  // A second write of the same assignee (a re-save, a title edit that carries
  // assignee_id along, or the agent's own update_task) reaches dispatch again.
  const second = await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(first.dispatched, true);
  assert.equal(second.dispatched, false, 'the duplicate is refused');
  assert.equal(second.reason, 'duplicate');
  assert.equal(runs.length, 1, 'the agent still ran only once');
  assert.equal(writes.messageInserts.length, 1, 'no second message in the DM');
});

test('the dispatch claim is shared, so one human action cannot fire two paths', () => {
  // The comment-@mention path claims the same (task, agent) pair before it runs.
  assert.equal(__test.claimTaskDispatch('t-1', 'agent-1', 5_000), true, 'first claim wins');
  assert.equal(
    __test.claimTaskDispatch('t-1', 'agent-1', __test.TASK_ASSIGN_CLAIM_MS), false,
    'the assignee-write path is refused right behind it',
  );
  assert.equal(__test.claimTaskDispatch('t-1', 'agent-2', 5_000), true, 'a different agent is unaffected');
  assert.equal(__test.claimTaskDispatch('t-2', 'agent-1', 5_000), true, 'a different task is unaffected');
});

// --- (3) humans are not agents ---------------------------------------------

test('assigning a task to a human user does not dispatch', async () => {
  // assignee_id has no FK: 'user-7' is a real app_user, and workspace_agents has
  // no such row.
  const { db, writes } = dispatchDb({ task: taskRow({ assignee_id: 'user-7' }) });
  __test.setTestDb(db);
  const { runs, run } = recorder();

  const out = await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: 'user-7', run });

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'not_an_agent');
  assert.equal(runs.length, 0, 'no agent ran');
  assert.equal(writes.taskUpdates.length, 0, 'the task was not touched');
  assert.equal(writes.messageInserts.length, 0, 'nothing was posted');
});

// --- (4) finished work stays finished ---------------------------------------

test('a done or cancelled task never dispatches', async () => {
  for (const status of ['done', 'cancelled']) {
    const { db, writes } = dispatchDb({ task: taskRow({ status }) });
    __test.setTestDb(db);
    const { runs, run } = recorder();

    const out = await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, run });

    assert.equal(out.dispatched, false, `${status} must not dispatch`);
    assert.equal(out.reason, 'terminal');
    assert.equal(runs.length, 0);
    assert.equal(writes.taskUpdates.length, 0, `a ${status} task is not re-opened`);
    __test.resetTestState();
  }
});

test('an assignment that lost a race to a later one does not dispatch', async () => {
  // The row is read after the write, so the task now belongs to someone else.
  const { db } = dispatchDb({ task: taskRow({ assignee_id: 'agent-2' }) });
  __test.setTestDb(db);
  const { runs, run } = recorder();

  const out = await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'stale_assignee');
  assert.equal(runs.length, 0);
});

// --- (5) a disabled agent cannot run ----------------------------------------

test('assigning a disabled agent does not dispatch', async () => {
  const { db, writes } = dispatchDb({ task: taskRow(), agent: { ...AGENT, enabled: false } });
  __test.setTestDb(db);
  const { runs, run } = recorder();

  const out = await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'agent_disabled');
  assert.equal(runs.length, 0);
  assert.equal(writes.messageInserts.length, 0);
});

// --- (6) status and provenance are never clobbered --------------------------

test('dispatch does not clobber a task that is already in progress', async () => {
  const { db, writes } = dispatchDb({ task: taskRow({ status: 'in_progress' }) });
  __test.setTestDb(db);
  const { run } = recorder();

  await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(writes.taskUpdates[0].params[0], 'in_progress', 'status is left as-is');
});

test('an existing provenance is preserved instead of being rewritten to chat', async () => {
  // source_id means something different per source_type ('ai' stores the
  // authoring agent's id), so it must not be reinterpreted as a session id.
  const { db, writes } = dispatchDb({ task: taskRow({ source_type: 'ai', source_id: 'agent-9' }) });
  __test.setTestDb(db);
  const { runs, run } = recorder();

  const out = await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: AGENT.id, run });

  assert.equal(out.dispatched, true, 'the agent still runs');
  assert.equal(runs.length, 1);
  assert.ok(!writes.taskUpdates[0].sql.includes('source_type'), 'source_type is untouched');
  assert.ok(!writes.taskUpdates[0].params.includes('dm-1'), 'source_id keeps its own meaning');
});

// --- (7) bad input is inert -------------------------------------------------

test('dispatch is inert without a task or an assignee', async () => {
  const { db } = dispatchDb({ task: taskRow() });
  __test.setTestDb(db);
  const { runs, run } = recorder();

  assert.equal((await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: '', agentId: AGENT.id, run })).reason, 'missing_input');
  assert.equal((await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-1', agentId: '', run })).reason, 'missing_input');
  assert.equal(runs.length, 0);
});

test('a task that no longer exists does not dispatch', async () => {
  const { db } = dispatchDb({ task: null });
  __test.setTestDb(db);
  const { runs, run } = recorder();

  const out = await __test.dispatchTaskAssignment({ workspaceId: 'w1', taskId: 't-gone', agentId: AGENT.id, run });

  assert.equal(out.dispatched, false);
  assert.equal(out.reason, 'task_not_found');
  assert.equal(runs.length, 0);
});
