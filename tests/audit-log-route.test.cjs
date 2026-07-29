'use strict';

// ============================================================================
// tests/audit-log-route.test.cjs
// ----------------------------------------------------------------------------
// GET /backend/workspaces/:id/audit — the only way out of audit_log.
//
// Runs the REAL express app against a fake db, so the assertions cover the route
// as mounted (auth middleware, role gate, projection, clamps) rather than a
// re-implementation of it. The db records every statement, so what the route
// actually asked Postgres for is checkable.
//
// Covered:
//   - viewer / commenter / editor  -> 403 (this is manage-only material)
//   - non-member                   -> 403
//   - unauthenticated              -> 401
//   - owner / admin                -> 200
//   - limit clamps to 200, defaults to 50
//   - request_ip is stored but never projected to a client
//   - action filter and keyset `before` cursor are BOUND, not interpolated
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');
const { auditLimit, AUDIT_SELECT_COLUMNS } = require('../server/audit-routes.cjs');

const USER = 'user-1';
const WORKSPACE = 'w1';

test.afterEach(() => __test.resetTestState());

const AUDIT_ROW = {
  id: 'audit-1',
  seq: 1,
  workspace_id: WORKSPACE,
  actor_user_id: USER,
  actor_agent_id: null,
  actor_label: '',
  action: 'agent.permission_mode_changed',
  target_type: 'agent',
  target_id: 'agent-1',
  target_label: 'scout',
  before_value: 'default',
  after_value: 'yolo',
  detail: {},
  entry_hash: 'a'.repeat(64),
  created_at: '2026-07-29T10:00:00.000Z',
};

/** `role` is the caller's role in WORKSPACE; 'owner' answers the owner check. */
function makeDb({ role = 'owner' } = {}) {
  const queries = [];
  const db = {
    queries,
    async unsafe(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'audit-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.startsWith('select 1 from workspaces where id')) {
        return role === 'owner' && String(params[1]) === USER ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select role from workspace_members')) {
        return role && role !== 'owner' && role !== 'none' ? [{ role }] : [];
      }
      if (q.includes('with recursive chain as')) return [];
      if (q.includes('from audit_log')) return [AUDIT_ROW];
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
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

function auditGet(baseUrl, token, query = '') {
  return fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/audit${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** The one statement that actually touched the table. */
function auditQuery(db) {
  return db.queries.find(entry => entry.sql.toLowerCase().includes('from audit_log'));
}

for (const role of ['viewer', 'commenter', 'editor']) {
  test(`a ${role} cannot read the audit log`, async () => {
    // MUTATION: change 'manage' to 'read' in the route -> these three fail.
    // Audit rows say who changed whose role and which vault key was written.
    const db = makeDb({ role });
    __test.setTestDb(db);
    const token = await __test.issueToken(USER, '1');
    await withServer(async (baseUrl) => {
      const res = await auditGet(baseUrl, token);
      assert.equal(res.status, 403);
    });
    assert.equal(auditQuery(db), undefined, 'the table must not be read at all on a refusal');
  });
}

test('a non-member cannot read the audit log', async () => {
  // MUTATION: drop the enforceWorkspaceRole call -> this fails.
  const db = makeDb({ role: 'none' });
  __test.setTestDb(db);
  const token = await __test.issueToken('someone-else', '1');
  await withServer(async (baseUrl) => {
    assert.equal((await auditGet(baseUrl, token)).status, 403);
  });
  assert.equal(auditQuery(db), undefined);
});

test('an unauthenticated caller gets 401 before any database work', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    assert.equal((await auditGet(baseUrl, null)).status, 401);
  });
  assert.equal(auditQuery(db), undefined);
});

test('an admin reads the log', async () => {
  const db = makeDb({ role: 'admin' });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    const res = await auditGet(baseUrl, token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, null);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].action, 'agent.permission_mode_changed');
    assert.equal(body.data[0].before_value, 'default');
    assert.equal(body.data[0].after_value, 'yolo');
  });
});

test('request_ip is stored but never projected to a client', async () => {
  // MUTATION: widen the projection to `select *` -> this fails. An IP in a panel
  // any admin can open turns the audit log into a colleague-location tracker.
  assert.equal(AUDIT_SELECT_COLUMNS.includes('request_ip'), false);
  const db = makeDb({ role: 'owner' });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    assert.equal((await auditGet(baseUrl, token)).status, 200);
  });
  const query = auditQuery(db);
  assert.equal(query.sql.includes('request_ip'), false);
  assert.equal(query.sql.includes('select *'), false);
});

test('limit clamps to 200 and defaults to 50', async () => {
  // MUTATION: remove the Math.min clamp -> the 5000 case fails. An unbounded
  // limit is how a stolen admin session pulls the whole log in one request.
  assert.equal(auditLimit(undefined), 50);
  assert.equal(auditLimit(''), 50);
  assert.equal(auditLimit('0'), 50);
  assert.equal(auditLimit('-3'), 50);
  assert.equal(auditLimit('nonsense'), 50);
  assert.equal(auditLimit('10'), 10);
  assert.equal(auditLimit('5000'), 200);

  const db = makeDb({ role: 'owner' });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    assert.equal((await auditGet(baseUrl, token, '?limit=5000')).status, 200);
  });
  const query = auditQuery(db);
  assert.equal(query.params[query.params.length - 1], 200);
});

test('the action filter is bound as a parameter, never interpolated', async () => {
  const db = makeDb({ role: 'owner' });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    const injection = encodeURIComponent("x' or '1'='1");
    assert.equal((await auditGet(baseUrl, token, `?action=${injection}`)).status, 200);
  });
  const query = auditQuery(db);
  assert.equal(query.sql.includes("or '1'='1"), false, 'the filter reached the SQL text');
  assert.equal(query.params.includes("x' or '1'='1"), true, 'the filter must arrive as a bind');
  assert.equal(query.sql.includes('and action = $2'), true);
});

test('the keyset cursor pages backwards and rejects a bad timestamp', async () => {
  // Keyset on (created_at, id), never OFFSET: the table only grows.
  const db = makeDb({ role: 'owner' });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    const res = await auditGet(baseUrl, token, '?before=2026-07-29T10:00:00.000Z&beforeId=audit-1');
    assert.equal(res.status, 200);
    const bad = await auditGet(baseUrl, token, '?before=not-a-date');
    assert.equal(bad.status, 400);
  });
  const query = auditQuery(db);
  assert.equal(query.sql.includes('(created_at, id) <'), true);
  assert.equal(query.sql.toLowerCase().includes('offset'), false);
  assert.equal(query.params.includes('2026-07-29T10:00:00.000Z'), true);
});

test('the route reads only its own workspace', async () => {
  const db = makeDb({ role: 'owner' });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    assert.equal((await auditGet(baseUrl, token)).status, 200);
  });
  const query = auditQuery(db);
  assert.equal(query.sql.includes('where workspace_id = $1'), true);
  assert.equal(query.params[0], WORKSPACE);
});

test('there is no write route on the audit surface', async () => {
  // Entries are written server-side at the privileged action itself. Nothing
  // accepts one from a client, at any role.
  const db = makeDb({ role: 'owner' });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/audit`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'member.role_changed', after_value: 'admin' }),
      });
      assert.equal(res.status, 404, `${method} must not be routed`);
    }
  });
  assert.equal(db.queries.some(q => q.sql.toLowerCase().includes('insert into audit_log')), false);
});

test('the generic db routes refuse audit_log outright', async () => {
  // The strongest control in the design: the table is absent from ALLOWED_TABLES,
  // so ensureTable rejects it before authorization is even consulted.
  // MUTATION: add 'audit_log' to ALLOWED_TABLES -> the selects start returning 200.
  const db = makeDb({ role: 'owner' });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  const attempt = (baseUrl, route, table) => fetch(`${baseUrl}/backend/db/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table,
      values: { action: 'member.role_changed' },
      filters: [{ column: 'id', operator: 'eq', value: 'audit-1' }],
    }),
  });

  await withServer(async (baseUrl) => {
    for (const route of ['select', 'insert', 'update', 'delete']) {
      const res = await attempt(baseUrl, route, 'audit_log');
      assert.ok(res.status >= 400, `/backend/db/${route} must refuse audit_log`);
      const body = await res.json();
      assert.match(String(body.error?.message || body.error), /Table not allowed: audit_log/);

      // Identical posture to workspace_secrets, the other table deliberately kept
      // out of ALLOWED_TABLES. Anchoring to it makes this test about audit_log's
      // membership of that set, not about which status code ensureTable happens
      // to produce (it throws without a .status, so the generic route 500s).
      const vault = await attempt(baseUrl, route, 'workspace_secrets');
      assert.equal(vault.status, res.status);
    }
  });
  // No DML ever reached the table. (The bootstrap DDL does mention it — that is
  // ensureRuntimeSchema creating it, and it is excluded here on purpose.)
  const dml = db.queries.filter(q => /\b(select|insert|update|delete)\b[\s\S]*\baudit_log\b/i.test(q.sql)
    && !/^\s*create /i.test(q.sql));
  assert.deepEqual(dml, []);
});
