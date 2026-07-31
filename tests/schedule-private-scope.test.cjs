'use strict';

// Scheduled prompts are conversation content. A workspace role may manage a
// schedule only when the caller can also read its target session, and a timer
// must re-check the standing grant when it actually fires.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { mountSchedulesRoutes } = require('../server/schedules-routes.cjs');
const core = require('../shared/backend-core.cjs');
const { __test } = require('../server/index.cjs');

const WS = 'workspace-1';
const DM = 'private-session-1';
const CHANNEL = 'public-session-1';
const SCHEDULE = 'schedule-1';
const AGENT = 'agent-1';
const MEMBER = 'member-1';
const OTHER = 'other-1';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function jsonError(res, status, error) {
  return res.status(status).json({ data: null, error: { message: error.message } });
}

function requireAuth(req, _res, next) {
  req.userId = String(req.headers['x-test-user'] || '');
  next();
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function request(baseUrl, pathname, { method = 'GET', user = MEMBER, body } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'x-test-user': user,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function scheduleRow(overrides = {}) {
  return {
    id: SCHEDULE,
    workspace_id: WS,
    agent_id: AGENT,
    session_id: DM,
    created_by: MEMBER,
    name: 'Private review',
    prompt: 'Summarise the confidential channel',
    interval_seconds: 3600,
    enabled: true,
    running: false,
    ...overrides,
  };
}

test('the schedule list SQL removes sessions the caller cannot read', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  mountSchedulesRoutes(app, {
    requireAuth,
    jsonError,
    enforceWorkspaceRole: async () => {},
    enforceSessionRead: async () => {},
    sessionReadableSql: core.sessionReadableSql,
    getDb: () => ({
      unsafe: async (sql, params = []) => {
        calls.push({ sql: String(sql), params });
        return [];
      },
    }),
    notifyDbSubscribers: () => {},
    runDueSchedules: async () => {},
  });

  await withServer(app, async (baseUrl) => {
    const response = await request(baseUrl, `/backend/workspaces/${WS}/schedules`);
    assert.equal(response.status, 200);
  });

  const select = calls.find((call) => /from agent_schedules s/i.test(call.sql));
  assert.ok(select);
  assert.match(select.sql, /join chat_sessions cs on cs\.id = s\.session_id/i);
  assert.match(select.sql, /chat_session_members/i);
  assert.deepEqual(select.params, [WS, MEMBER]);
});

test('every dedicated schedule read or mutation applies the target-session gate', async () => {
  const writes = [];
  const checked = [];
  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (n.startsWith('select * from agent_schedules where id = $1')) return [scheduleRow()];
      if (n.startsWith('select workspace_id, session_id from agent_schedules where id = $1')) {
        return [{ workspace_id: WS, session_id: DM }];
      }
      if (n.startsWith('select 1 from workspace_agents')) return [{ ok: 1 }];
      if (n.startsWith('select id, workspace_id, visibility, folder from chat_sessions')) {
        return [{ id: DM, workspace_id: WS, visibility: 'private', folder: 'Direct messages' }];
      }
      if (/^(insert|update|delete) /.test(n)) {
        writes.push({ sql: String(sql), params });
        return [scheduleRow()];
      }
      return [];
    },
  };
  const app = express();
  app.use(express.json());
  let runnerCalls = 0;
  mountSchedulesRoutes(app, {
    requireAuth,
    jsonError,
    enforceWorkspaceRole: async () => {},
    enforceSessionRead: async (userId, sessionId, sessionRow) => {
      checked.push({ userId, sessionId, sessionRow });
      if (userId !== MEMBER) throw httpError(403, 'This conversation is private');
    },
    sessionReadableSql: core.sessionReadableSql,
    getDb: () => db,
    notifyDbSubscribers: () => {},
    runDueSchedules: async () => { runnerCalls += 1; },
  });

  const cases = [
    ['GET', `/backend/schedules/${SCHEDULE}/runs`, undefined],
    ['POST', `/backend/workspaces/${WS}/schedules`, {
      agentId: AGENT, sessionId: DM, prompt: 'no', intervalSeconds: 60,
    }],
    ['PATCH', `/backend/schedules/${SCHEDULE}`, { prompt: 'no' }],
    ['DELETE', `/backend/schedules/${SCHEDULE}`, undefined],
    ['POST', `/backend/schedules/${SCHEDULE}/run`, undefined],
  ];

  await withServer(app, async (baseUrl) => {
    for (const [method, pathname, body] of cases) {
      const response = await request(baseUrl, pathname, {
        method,
        user: OTHER,
        body,
      });
      assert.equal(response.status, 403, `${method} ${pathname}`);
    }
  });

  assert.equal(checked.length, cases.length, 'every route must reach the session gate');
  assert.ok(checked.every((entry) => entry.sessionId === DM));
  assert.equal(writes.length, 0, 'no denied route reaches a write');
  assert.equal(runnerCalls, 0);
});

test('a current private-session member can still update a schedule', async () => {
  const writes = [];
  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (n.startsWith('select * from agent_schedules where id = $1')) return [scheduleRow()];
      if (n.startsWith('update agent_schedules')) {
        writes.push({ sql: String(sql), params });
        return [scheduleRow({ prompt: String(params[2]) })];
      }
      return [];
    },
  };
  const app = express();
  app.use(express.json());
  mountSchedulesRoutes(app, {
    requireAuth,
    jsonError,
    enforceWorkspaceRole: async () => {},
    enforceSessionRead: async () => {},
    sessionReadableSql: core.sessionReadableSql,
    getDb: () => db,
    notifyDbSubscribers: () => {},
    runDueSchedules: async () => {},
  });

  await withServer(app, async (baseUrl) => {
    const response = await request(baseUrl, `/backend/schedules/${SCHEDULE}`, {
      method: 'PATCH',
      body: { prompt: 'Allowed update' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.prompt, 'Allowed update');
  });
  assert.equal(writes.length, 1);
});

test('the timer re-checks creator role and private-session membership before posting', async () => {
  const calls = [];
  let claimed = false;
  const due = scheduleRow({ created_by: MEMBER });
  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: String(sql), params });
      if (n.startsWith('update agent_schedules s set running = true')) {
        if (claimed) return [];
        claimed = true;
        return [due];
      }
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) return [];
      if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
        return [{ role: 'editor' }];
      }
      if (n.includes('with recursive chain as')) return [];
      if (n.startsWith('select * from workspace_agents')) {
        return [{ id: AGENT, workspace_id: WS, name: 'Coder', handle: 'coder', enabled: true }];
      }
      if (n.startsWith('select id, workspace_id, visibility, folder from chat_sessions')) {
        return [{ id: DM, workspace_id: WS, visibility: 'private', folder: 'Direct messages' }];
      }
      if (n.startsWith('select 1 from chat_session_members')) return []; // membership was revoked
      if (n.startsWith('update agent_schedules set running = false')) {
        return [{ ...due, running: false, last_status: params[1] }];
      }
      if (n.startsWith('insert into agent_schedule_runs')) {
        return [{ id: 'run-1', schedule_id: SCHEDULE, workspace_id: WS, status: params[2], detail: params[3] }];
      }
      if (n.startsWith('select id, visibility, folder from chat_sessions')) {
        return [{ id: DM, visibility: 'private', folder: 'Direct messages' }];
      }
      if (n.startsWith('select user_id from chat_session_members')) return [];
      return [];
    },
  };
  __test.setTestDb(db);

  await __test.runDueSchedules();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(
    calls.some((call) => /^\s*insert into messages/i.test(call.sql)),
    false,
    'a revoked creator must not post the scheduled prompt',
  );
  const runInsert = calls.find((call) => /^\s*insert into agent_schedule_runs/i.test(call.sql));
  assert.ok(runInsert, 'the failed attempt remains visible in schedule history');
  assert.equal(runInsert.params[2], 'error');
  assert.match(String(runInsert.params[3]), /private/i);
});

test.afterEach(() => __test.resetTestState());
