'use strict';

// ============================================================================
// tests/task-assign-route.test.cjs
// ----------------------------------------------------------------------------
// The UI writes tasks through the generic POST /backend/db/update. This covers
// the TRIGGER that lives in that route: dispatch only when assignee_id genuinely
// CHANGES to a workspace agent, and never as a side effect of an ordinary edit.
//   1. assignee_id null -> agent  => dispatched once (and the row is written)
//   2. assignee_id agent -> SAME agent (a re-save) => no dispatch
//   3. an edit that doesn't touch assignee_id (title/status) => no dispatch
//   4. assignee_id -> a human user id => no dispatch
//   5. the user's edit is persisted even when the dispatch can't run
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

const USER = 'user-1';
const WORKSPACE = 'w1';
const AGENT = {
  id: 'agent-1',
  workspace_id: WORKSPACE,
  name: 'Coder',
  handle: 'coder',
  enabled: true,
  model: 'claude-sonnet-4-6',
};

test.afterEach(() => __test.resetTestState());

// Fake DB answering exactly the statements this route (and the dispatch behind
// it) issues. Every write is recorded so the assertions can prove what ran.
function makeDb({ task, agent = AGENT }) {
  const writes = { taskInserts: [], taskUpdates: [], messageInserts: [], sessionInserts: [] };
  let seq = 0;
  const db = {
    writes,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      const q = n.toLowerCase();
      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'assign-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.startsWith('select 1 from workspaces where id')) {
        return String(params[1]) === USER ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select role from workspace_members')) return [];
      // the access check resolves the row's workspace (quoted identifier)
      if (/^select workspace_id from "?tasks"? where id/.test(q)) return [{ workspace_id: WORKSPACE }];
      // the route's before-image read (dispatch change detection)
      if (q.startsWith('select id, workspace_id, assignee_id from "tasks"')) {
        return [{ id: task.id, workspace_id: task.workspace_id, assignee_id: task.assignee_id }];
      }
      // dispatchTaskAssignment's own read of the task
      if (q.startsWith('select id, workspace_id, title, description, status, assignee_id, source_type, source_id')) {
        return [task];
      }
      if (q.startsWith('select * from workspace_agents where id')) {
        return agent && String(agent.id) === String(params[0]) ? [agent] : [];
      }
      if (q.startsWith('select * from chat_sessions')) return [{ id: 'dm-1', workspace_id: WORKSPACE }];
      if (q.startsWith('insert into chat_sessions')) {
        writes.sessionInserts.push({ sql: n, params });
        return [{ id: 'dm-1', workspace_id: WORKSPACE }];
      }
      if (q.startsWith('select display_name, email from app_users')) {
        return [{ display_name: 'Jason', email: 'jason@example.com' }];
      }
      if (q.startsWith('update "tasks" set') || q.startsWith('update tasks set')) {
        writes.taskUpdates.push({ sql: n, params });
        // PostgreSQL evaluates every SET expression against the OLD row. Mirror
        // the conditional requester stamp so this fake catches a form re-save
        // stealing a queued task from the human who actually assigned it.
        const requesterCase = n.match(
          /"assignee_id" IS DISTINCT FROM \$(\d+)\s+THEN \$(\d+)\s+ELSE "dispatch_requested_by"/i,
        );
        if (requesterCase) {
          const comparedAssignee = params[Number(requesterCase[1]) - 1];
          const nextRequester = params[Number(requesterCase[2]) - 1];
          if (String(task.assignee_id ?? '') !== String(comparedAssignee ?? '')) {
            task.dispatch_requested_by = nextRequester;
          }
        }
        // Reflect the write so a follow-up read sees the new assignee.
        if (q.includes('assignee_id')) task.assignee_id = params[0];
        return [{ ...task }];
      }
      if (q.startsWith('insert into "tasks"') || q.startsWith('insert into tasks')) {
        writes.taskInserts.push({ sql: n, params });
        return [{ ...task }];
      }
      if (q.startsWith('select id from messages where session_id')) return [];
      if (q.startsWith('insert into messages')) {
        seq += 1;
        writes.messageInserts.push({ id: `m-${seq}`, sql: n, params });
        return [{ id: `m-${seq}`, session_id: 'dm-1' }];
      }
      return [];
    },
  };
  return db;
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function updateTask(baseUrl, token, values) {
  return fetch(`${baseUrl}/backend/db/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: 'tasks', values, filters: [{ column: 'id', operator: 'eq', value: 't-1' }] }),
  });
}

async function insertTask(baseUrl, token, values) {
  return fetch(`${baseUrl}/backend/db/insert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: 'tasks', values, single: true }),
  });
}

// The dispatch is deliberately fire-and-forget (the response must not wait on
// it), so give it a bounded moment to land before asserting.
async function settle(check, ms = 400) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return check();
}

function taskRow(overrides = {}) {
  return {
    id: 't-1',
    workspace_id: WORKSPACE,
    title: 'Ship the thing',
    description: '',
    status: 'todo',
    assignee_id: null,
    source_type: 'manual',
    source_id: null,
    ...overrides,
  };
}

test('assigning a task to an agent through /backend/db/update dispatches it', async () => {
  const task = taskRow({ assignee_id: null, dispatch_requested_by: 'older-requester' });
  const db = makeDb({ task });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await updateTask(baseUrl, token, { assignee_id: AGENT.id });
    assert.equal(res.status, 200, 'the edit is saved');
    assert.ok(await settle(() => db.writes.messageInserts.length > 0), 'the agent was woken in its DM');
  });

  assert.equal(db.writes.messageInserts.length, 1, 'exactly one dispatch message');
  assert.equal(task.dispatch_requested_by, USER, 'the authenticated assigning human owns delayed routing');
  const stamp = db.writes.taskUpdates.find(u => u.sql.includes("source_type = 'chat'"));
  assert.ok(stamp, 'the task records the chat it is being worked in');
  assert.ok(stamp.params.includes('dm-1'), 'source_id is the session id');
});

test('re-saving a task with the assignee it already has does not dispatch', async () => {
  const task = taskRow({ assignee_id: AGENT.id, dispatch_requested_by: 'original-assigner' });
  const db = makeDb({ task });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await updateTask(baseUrl, token, { assignee_id: AGENT.id, title: 'Ship the thing (edited)' });
    assert.equal(res.status, 200);
    await settle(() => false, 120); // give any (unwanted) dispatch time to appear
  });

  assert.equal(db.writes.messageInserts.length, 0, 'no agent run for an unchanged assignee');
  assert.equal(db.writes.taskUpdates.length, 1, 'only the user edit was written');
  assert.equal(
    task.dispatch_requested_by,
    'original-assigner',
    'a later editor cannot steal a queued assignment by re-saving the same assignee',
  );
});

test('an edit that does not touch assignee_id never dispatches', async () => {
  const db = makeDb({ task: taskRow({ assignee_id: AGENT.id }) });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    // exactly what an agent does while working: report progress on its own task
    const res = await updateTask(baseUrl, token, { status: 'in_progress' });
    assert.equal(res.status, 200);
    await settle(() => false, 120);
  });

  assert.equal(db.writes.messageInserts.length, 0, 'a status write cannot re-arm dispatch');
});

test('assigning a task to a human teammate does not dispatch', async () => {
  const db = makeDb({ task: taskRow({ assignee_id: null }) });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await updateTask(baseUrl, token, { assignee_id: 'user-7' });
    assert.equal(res.status, 200, 'the human is still assigned');
    await settle(() => false, 150);
  });

  assert.equal(db.writes.messageInserts.length, 0, 'no agent ran for a human assignee');
});

test('creating a task already assigned to an agent dispatches it', async () => {
  const task = taskRow({ assignee_id: AGENT.id });
  const db = makeDb({ task });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await insertTask(baseUrl, token, {
      workspace_id: WORKSPACE, title: task.title, assignee_id: AGENT.id, source_type: 'manual',
    });
    assert.equal(res.status, 200, 'the task is created');
    assert.ok(await settle(() => db.writes.messageInserts.length > 0), 'the agent was woken');
  });

  assert.equal(db.writes.messageInserts.length, 1, 'exactly one dispatch message');
});

test('creating an unassigned task dispatches nothing', async () => {
  const db = makeDb({ task: taskRow({ assignee_id: null }) });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await insertTask(baseUrl, token, { workspace_id: WORKSPACE, title: 'Just a note', source_type: 'manual' });
    assert.equal(res.status, 200);
    await settle(() => false, 150);
  });

  assert.equal(db.writes.messageInserts.length, 0, 'no agent ran');
});

test("a task assigned to an agent while done stays done and silent", async () => {
  const db = makeDb({ task: taskRow({ assignee_id: null, status: 'done' }) });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await updateTask(baseUrl, token, { assignee_id: AGENT.id });
    assert.equal(res.status, 200, 'the assignment itself is still saved');
    await settle(() => false, 150);
  });

  assert.equal(db.writes.messageInserts.length, 0, 'a finished task is never re-opened');
  assert.equal(db.writes.taskUpdates.length, 1, 'only the user edit was written');
});
