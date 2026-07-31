'use strict';

// ============================================================================
// tests/session-derived-scope.test.cjs
// ----------------------------------------------------------------------------
// `thread_items`, `agent_jobs` and `agent_schedules` carry a workspace_id for
// convenient lists, but their CONTENT belongs to `session_id`. Workspace RBAC
// is therefore necessary and insufficient: workspace-wide reads need a SQL
// projection, item-id writes need to resolve their parent, and workspace-wide
// realtime bindings need a per-row audience.
//
// This file pins all three doors. The positive controls matter as much as the
// refusals: an ordinary channel remains workspace-visible and a real member can
// still edit its thread rail.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const core = require('../shared/backend-core.cjs');
const { createRealtime } = require('../server/realtime.cjs');
const { createApp, __test } = require('../server/index.cjs');

const WS = 'workspace-1';
const DM = 'private-session-1';
const CHANNEL = 'public-session-1';
const MEMBER = 'member-1';
const OTHER = 'other-1';
const OWNER = 'owner-1';
const priorRuntimeSchema = process.env.AGENSIS_RUNTIME_SCHEMA;

test.before(() => {
  process.env.AGENSIS_RUNTIME_SCHEMA = 'false';
});

test.after(() => {
  if (priorRuntimeSchema === undefined) delete process.env.AGENSIS_RUNTIME_SCHEMA;
  else process.env.AGENSIS_RUNTIME_SCHEMA = priorRuntimeSchema;
});

const eq = (column, value) => ({ column, operator: 'eq', value });

function makeCoreDb({
  members = [MEMBER],
  roles = { [MEMBER]: 'editor', [OTHER]: 'editor' },
  sessions = {
    [DM]: { id: DM, workspace_id: WS, visibility: 'private', folder: 'Direct messages' },
    [CHANNEL]: { id: CHANNEL, workspace_id: WS, visibility: 'workspace', folder: 'Channels' },
  },
  itemSessions = { 'item-private': DM, 'item-public': CHANNEL },
} = {}) {
  const calls = [];
  async function db(sql, params = []) {
    const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    calls.push({ sql: String(sql), params });

    if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
      return String(params[1]) === OWNER ? [{ ok: 1 }] : [];
    }
    if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
      const role = roles[String(params[1])];
      return role ? [{ role }] : [];
    }
    if (n.includes('with recursive chain as')) return [];
    if (n.startsWith('select workspace_id from chat_sessions where id = $1')) {
      const row = sessions[String(params[0])];
      return row ? [{ workspace_id: row.workspace_id }] : [];
    }
    if (n.startsWith('select id, visibility, folder from chat_sessions where id = $1')) {
      const row = sessions[String(params[0])];
      return row ? [{ id: row.id, visibility: row.visibility, folder: row.folder }] : [];
    }
    if (n.startsWith('select 1 from chat_session_members')) {
      return String(params[0]) === DM && members.includes(String(params[1])) ? [{ ok: 1 }] : [];
    }
    if (n.startsWith('select workspace_id from "thread_items" where id = $1')) {
      return itemSessions[String(params[0])] ? [{ workspace_id: WS }] : [];
    }
    if (n.startsWith('select session_id from "thread_items" where id = $1')) {
      const sessionId = itemSessions[String(params[0])];
      return sessionId ? [{ session_id: sessionId }] : [];
    }
    throw new Error(`Unexpected SQL in session-derived test: ${sql}`);
  }
  db.calls = calls;
  return db;
}

test('thread item INSERT is allowed for a private-session member and denied to another editor', async () => {
  const values = { workspace_id: WS, session_id: DM, kind: 'blocker', content: 'Decide' };

  await assert.doesNotReject(() => core.enforceDbOperationAccess({
    userId: MEMBER,
    table: 'thread_items',
    op: 'insert',
    payload: { values },
    db: makeCoreDb(),
  }));

  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: OTHER,
      table: 'thread_items',
      op: 'insert',
      payload: { values },
      db: makeCoreDb(),
    }),
    { status: 403, message: 'This conversation is private' },
  );
});

test('thread item UPDATE and DELETE resolve an id-only filter back to its private session', async () => {
  for (const op of ['update', 'delete']) {
    const db = makeCoreDb();
    const args = {
      userId: OTHER,
      table: 'thread_items',
      op,
      filters: [eq('id', 'item-private')],
      db,
    };
    if (op === 'update') args.payload = { values: { status: 'done' } };

    await assert.rejects(() => core.enforceDbOperationAccess(args), {
      status: 403,
      message: 'This conversation is private',
    });
    assert.ok(
      db.calls.some((call) => /select session_id from "thread_items"/i.test(call.sql)),
      `${op} must resolve the source row's session before authorizing`,
    );
  }
});

test('moving a thread item checks both its source and destination sessions', async () => {
  const db = makeCoreDb({ members: [] });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: OTHER,
      table: 'thread_items',
      op: 'update',
      filters: [eq('id', 'item-public')],
      payload: { values: { session_id: DM } },
      db,
    }),
    { status: 403, message: 'This conversation is private' },
  );
});

test('unknown or unresolvable thread-item associations fail closed', async () => {
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: MEMBER,
      table: 'thread_items',
      op: 'insert',
      payload: { values: { workspace_id: WS, session_id: 'missing-session', content: 'orphan' } },
      db: makeCoreDb(),
    }),
    { status: 403 },
  );

  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: MEMBER,
      table: 'thread_items',
      op: 'update',
      filters: [eq('id', 'missing-item')],
      payload: { values: { status: 'done' } },
      db: makeCoreDb(),
    }),
    { status: 400 },
  );
});

test('agent job and schedule lifecycle writes are not reachable through generic DB operations', async () => {
  const db = async () => {
    throw new Error('server-owned refusal must run before any DB lookup');
  };
  for (const table of ['agent_jobs', 'agent_schedules', 'agent_schedule_runs']) {
    for (const op of ['insert', 'update', 'delete']) {
      const args = {
        userId: OWNER,
        table,
        op,
        filters: op === 'insert' ? [] : [eq('id', 'row-1')],
        payload: op === 'insert'
          ? { values: { workspace_id: WS, session_id: DM } }
          : { values: { status: 'done' } },
        db,
      };
      await assert.rejects(() => core.enforceDbOperationAccess(args), { status: 403 });
    }
  }
});

test('direct session reads are member-gated and agent job bodies are not generically selectable', async () => {
  for (const table of ['thread_items', 'agent_jobs', 'agent_schedules']) {
    await assert.rejects(
      () => core.enforceDbOperationAccess({
        userId: OTHER,
        table,
        op: 'select',
        filters: [eq('session_id', DM)],
        db: makeCoreDb(),
      }),
      { status: 403, message: 'This conversation is private' },
      table,
    );
    await assert.doesNotReject(() => core.enforceDbOperationAccess({
      userId: MEMBER,
      table,
      op: 'select',
      filters: [eq('session_id', DM)],
      db: makeCoreDb(),
    }));
  }

  const projected = core.safeSelectColumns('agent_jobs', '*').split(',').map((value) => value.trim());
  assert.ok(projected.includes('status'));
  assert.ok(projected.includes('metadata'));
  for (const sensitive of ['prompt', 'response', 'error', 'connection_id']) {
    assert.equal(projected.includes(sensitive), false);
    assert.throws(
      () => core.safeSelectColumns('agent_jobs', sensitive),
      { status: 403 },
      `${sensitive} must stay off the generic read surface`,
    );
  }
});

function makeRouteDb() {
  const coreDb = makeCoreDb();
  const writes = [];
  return {
    writes,
    calls: coreDb.calls,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (n.startsWith('select value from app_settings')) return [{ value: 'session-derived-test-secret' }];
      if (n.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (n.startsWith('select id, workspace_id, identity from workspace_agents')) return [];
      if (n.startsWith('select user_id from chat_session_members')) {
        return String(params[0]) === DM ? [{ user_id: MEMBER }] : [];
      }
      if (n.startsWith('select * from "thread_items"')) {
        coreDb.calls.push({ sql: String(sql), params });
        return String(params.at(-1)) === MEMBER
          ? [{ id: 'item-private', workspace_id: WS, session_id: DM, kind: 'blocker', content: 'Decide' }]
          : [];
      }
      if (n.startsWith('update "thread_items"')) {
        writes.push({ sql: String(sql), params });
        return [{ id: 'item-private', workspace_id: WS, session_id: DM, status: params[0] }];
      }
      return coreDb(sql, params);
    },
  };
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

async function dbRequest(baseUrl, token, operation, body) {
  return fetch(`${baseUrl}/backend/db/${operation}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('the actual generic routes project workspace lists and gate id-only writes', async () => {
  const db = makeRouteDb();
  __test.setTestDb(db);
  const memberToken = await __test.issueToken(MEMBER, '1');
  const otherToken = await __test.issueToken(OTHER, '1');
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const list = await dbRequest(baseUrl, memberToken, 'select', {
      table: 'thread_items',
      filters: [eq('workspace_id', WS)],
    });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data.length, 1);
    const listSql = db.calls.find((call) => /select \* from "thread_items"/i.test(call.sql))?.sql || '';
    assert.match(listSql, /chat_session_members/i, 'the SQL result set, not just the preflight, must be scoped');
    assert.match(listSql, /"thread_items"\."session_id"/i);

    const denied = await dbRequest(baseUrl, otherToken, 'update', {
      table: 'thread_items',
      values: { status: 'done' },
      filters: [eq('id', 'item-private')],
      single: true,
    });
    assert.equal(denied.status, 403);
    assert.equal(db.writes.length, 0, 'a non-member must not reach the UPDATE');

    const allowed = await dbRequest(baseUrl, memberToken, 'update', {
      table: 'thread_items',
      values: { status: 'done' },
      filters: [eq('id', 'item-private')],
      single: true,
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).data.status, 'done');
    assert.equal(db.writes.length, 1);
  });
});

function realtimeClient(userId, tables) {
  const sent = [];
  return {
    userId,
    readyState: 1,
    subscriptions: tables.map((table) => ({
      type: 'db_changes',
      table,
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${WS}`,
    })),
    sent,
    send(raw) { sent.push(JSON.parse(raw)); },
  };
}

function frameIds(client, table) {
  return client.sent
    .filter((frame) => frame.type === 'db_changes' && frame.table === table)
    .map((frame) => frame.payload?.new?.id || frame.payload?.old?.id);
}

test('thread items, agent jobs and schedules fan out through their live session audience', async () => {
  const tables = ['thread_items', 'agent_jobs', 'agent_schedules'];
  const realtime = createRealtime({
    VAULT_SECRET_COLUMNS: [],
    enqueueFlowWebhookEvents: async () => [],
    enqueueAutomationRuns: async () => [],
    refreshConnectedAgentConfigs: () => {},
    sessionRealtimeAudience: async (sessionId) => {
      if (sessionId === CHANNEL) return { memberUserIds: null };
      if (sessionId === DM) return { memberUserIds: new Set([MEMBER]) };
      return null;
    },
  });
  const member = realtime.registerTestWebsocketClient(realtimeClient(MEMBER, tables));
  const other = realtime.registerTestWebsocketClient(realtimeClient(OTHER, tables));

  for (const table of tables) {
    realtime.notifyDbSubscribers(table, 'INSERT', [
      { id: `${table}-public`, workspace_id: WS, session_id: CHANNEL, prompt: 'public prompt' },
      { id: `${table}-private`, workspace_id: WS, session_id: DM, prompt: 'private prompt' },
      { id: `${table}-orphan`, workspace_id: WS, session_id: 'missing-session', prompt: 'orphan prompt' },
      { id: `${table}-unscoped`, workspace_id: WS, prompt: 'missing association' },
    ]);
  }
  await new Promise((resolve) => setTimeout(resolve, 40));

  for (const table of tables) {
    assert.deepEqual(
      frameIds(member, table).sort(),
      [`${table}-private`, `${table}-public`].sort(),
      `${table}: a member receives public plus their private row, never an orphan`,
    );
    assert.deepEqual(
      frameIds(other, table),
      [`${table}-public`],
      `${table}: another workspace member receives only the public-session row`,
    );
  }
});

test('a session audience lookup failure sends the derived row to nobody', async () => {
  const realtime = createRealtime({
    VAULT_SECRET_COLUMNS: [],
    enqueueFlowWebhookEvents: async () => [],
    enqueueAutomationRuns: async () => [],
    refreshConnectedAgentConfigs: () => {},
    sessionRealtimeAudience: async () => {
      throw new Error('database unavailable');
    },
  });
  const client = realtime.registerTestWebsocketClient(realtimeClient(MEMBER, ['agent_jobs']));
  realtime.notifyDbSubscribers('agent_jobs', 'UPDATE', [{
    id: 'job-private',
    workspace_id: WS,
    session_id: DM,
  }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(frameIds(client, 'agent_jobs'), []);
});

test.afterEach(() => __test.resetTestState());
