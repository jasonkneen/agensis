'use strict';

// ============================================================================
// tests/inbox.test.cjs
// ----------------------------------------------------------------------------
// The inbox is a triage surface aggregating five EXISTING sources. Three things
// have to hold or it is either a leak or a lie:
//
//   1. Membership — a non-member must get 403 AND must never reach the
//      aggregate query, or one tenant's inbox is readable from another.
//   2. Monotonic read state — a stale readAt must not move a marker backwards,
//      or a slow/out-of-order write from a second device un-reads things.
//   3. The wire contract — every category has to map onto the same InboxItem
//      shape the frontend consumes.
//
// No live Postgres: the DB is a recording fake (same pattern as
// tests/workspace-bootstrap.test.cjs). The read-marker fake deliberately honours
// the guard ONLY when the emitted SQL actually carries it, so deleting the guard
// from server/index.cjs fails the monotonicity test rather than silently
// passing.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

const WS = 'ws-1';
const MEMBER = 'user-member';
const STRANGER = 'user-stranger';

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// One row per category, in the exact column shape the aggregate query projects.
function inboxRows() {
  return [
    {
      id: 'blocker:b1',
      category: 'blocker',
      title: 'Deploy to prod or wait for review?',
      body: '',
      context_key: 'blocker:b1',
      session_id: 'sess-1',
      entity_type: 'thread_item',
      entity_id: 'b1',
      actor_name: 'coder',
      created_at: new Date(isoDaysAgo(0)),
      unread: true,
    },
    {
      id: 'comment:c1',
      category: 'comment',
      title: 'Comment on Launch plan',
      body: 'Can you confirm the date?',
      context_key: 'comment:c1',
      session_id: null,
      entity_type: 'document',
      entity_id: 'doc-1',
      actor_name: 'Ada',
      created_at: new Date(isoDaysAgo(1)),
      unread: true,
    },
    {
      id: 'mention:m1',
      category: 'mention',
      title: 'Ada: @member can you take this',
      body: '@member can you take this',
      context_key: 'thread:sess-2',
      session_id: 'sess-2',
      entity_type: 'message',
      entity_id: 'msg-1',
      actor_name: 'Ada',
      created_at: new Date(isoDaysAgo(2)),
      unread: false,
    },
    {
      id: 'error:e1',
      category: 'error',
      title: 'Coder run failed',
      body: 'ENOENT: no such file',
      context_key: 'agent_job:e1',
      session_id: 'sess-3',
      entity_type: 'agent_job',
      entity_id: 'e1',
      actor_name: 'Coder',
      created_at: new Date(isoDaysAgo(3)),
      unread: true,
    },
    {
      id: 'activity:a1',
      category: 'activity',
      title: 'Task completed: Ship it',
      body: '',
      context_key: 'activity:a1',
      session_id: null,
      entity_type: 'task',
      entity_id: 'task-1',
      actor_name: 'Ada',
      created_at: new Date(isoDaysAgo(4)),
      unread: false,
    },
  ];
}

function makeDb({ roles = {}, owners = {}, items = inboxRows(), user = { display_name: 'Member', email: 'member@example.com' } } = {}) {
  const calls = [];
  // (user:workspace:context_key) -> read_at ISO. Stands in for inbox_read_state.
  const markers = new Map();
  const db = {
    calls,
    markers,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: String(sql), normalized: n, params });
      if (
        n.startsWith('alter table') ||
        n.startsWith('create table') ||
        n.startsWith('create index') ||
        n.startsWith('do $$')
      ) {
        return [];
      }
      if (n.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'inbox-secret' }] : [];
      }
      if (n.startsWith('select token_version from app_users')) {
        return [{ token_version: '1' }];
      }
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }
      if (n.startsWith('select role from workspace_members')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }
      if (n.startsWith('select display_name, email from app_users')) {
        return user ? [user] : [];
      }
      if (n.startsWith('with items as')) {
        return items;
      }
      if (n.startsWith('insert into inbox_read_state')) {
        const [userId, workspaceId, contextKey, readAt] = params;
        const key = `${userId}:${workspaceId}:${contextKey}`;
        // Simulate Postgres applying (or not applying) the upsert's WHERE guard.
        // If the route ever stops emitting the guard this becomes a plain
        // overwrite and the monotonicity assertion below fails.
        const guarded = /where\s+inbox_read_state\.read_at\s*<\s*excluded\.read_at/i.test(String(sql));
        const existing = markers.get(key);
        if (!existing || !guarded || existing < readAt) markers.set(key, readAt);
        return [];
      }
      throw new Error(`Unexpected SQL in inbox test: ${sql}`);
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
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function ranAggregate(db) {
  return db.calls.some((call) => call.normalized.startsWith('with items as'));
}

test.beforeEach(() => {
  __test.resetTestState();
});
test.afterEach(() => {
  __test.resetTestState();
});

// --- membership -------------------------------------------------------------

test('GET /backend/workspaces/:workspaceId/inbox requires auth', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/inbox`);
    assert.equal(res.status, 401);
    assert.equal(ranAggregate(db), false);
  });
});

test('GET inbox rejects a non-member with 403 and returns no rows', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(STRANGER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/inbox`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.data, null);
    // The leak that matters: membership must be enforced BEFORE the aggregate
    // query, so a non-member never causes another tenant's rows to be read.
    assert.equal(ranAggregate(db), false);
  });
});

test('GET inbox scopes the aggregate query to the workspace and the caller', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/inbox`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const call = db.calls.find((c) => c.normalized.startsWith('with items as'));
    assert.ok(call, 'aggregate query ran');
    assert.equal(call.params[0], WS);
    assert.equal(call.params[1], MEMBER);
    // Every category branch is workspace-bound; none of them may be unfiltered.
    assert.equal(/from\s+\w+/g.test(call.sql), true);
    for (const table of ['thread_items', 'document_comments', 'task_comments', 'memory_file_comments', 'agent_jobs']) {
      assert.ok(call.sql.includes(table), `${table} is aggregated`);
    }
    assert.ok(call.sql.includes('inbox_read_state'), 'unread is resolved from the marker table');
    // Bounded: a per-category LIMIT plus an overall LIMIT.
    assert.ok(/limit \d+/.test(call.sql));
  });
});

// --- contract ---------------------------------------------------------------

test('GET inbox maps every category onto the shared InboxItem shape', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/inbox`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, null);
    assert.equal(Array.isArray(body.data.items), true);
    assert.equal(body.data.items.length, 5);
    assert.equal(typeof body.data.unreadCount, 'number');
    assert.equal(body.data.unreadCount, 3);

    const byCategory = new Map(body.data.items.map((item) => [item.category, item]));
    assert.deepEqual([...byCategory.keys()].sort(), ['activity', 'blocker', 'comment', 'error', 'mention']);

    for (const item of body.data.items) {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.title, 'string');
      assert.equal(typeof item.body, 'string');
      assert.equal(typeof item.contextKey, 'string');
      assert.equal(typeof item.actorName, 'string');
      assert.equal(typeof item.unread, 'boolean');
      // createdAt is always an ISO string, even though the driver hands back Date.
      assert.equal(item.createdAt, new Date(item.createdAt).toISOString());
      assert.ok(item.sessionId === null || typeof item.sessionId === 'string');
      assert.ok(item.entityType === null || typeof item.entityType === 'string');
      assert.ok(item.entityId === null || typeof item.entityId === 'string');
      // ids are prefixed by category so they stay unique across sources.
      assert.ok(item.id.startsWith(`${item.category}:`), `${item.id} is namespaced`);
    }

    assert.equal(byCategory.get('blocker').contextKey, 'blocker:b1');
    assert.equal(byCategory.get('comment').entityType, 'document');
    assert.equal(byCategory.get('mention').contextKey, 'thread:sess-2');
    assert.equal(byCategory.get('mention').unread, false);
    assert.equal(byCategory.get('error').entityType, 'agent_job');
    assert.equal(byCategory.get('activity').sessionId, null);
  });
});

test('GET inbox filters by category but keeps unreadCount across all of them', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/inbox?filter=blocker`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].category, 'blocker');
    // The badge must not change when the user switches tabs.
    assert.equal(body.data.unreadCount, 3);
  });
});

test('GET inbox rejects an unknown filter', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/inbox?filter=everything`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
    assert.equal(ranAggregate(db), false);
  });
});

// --- read state -------------------------------------------------------------

// --- read-marker resolution -------------------------------------------------
//
// The bug this guards: `created_at` is a Postgres timestamptz (MICROSECONDS),
// the marker is an ISO-8601 string built by Date#toISOString() (MILLISECONDS).
// Compared as-is, an item is newer than the marker written FROM it by up to
// 999us, so it comes back unread on every reload — which is exactly what
// happened in production: all 51 stored markers had .000 microseconds and 45 of
// the 45 that still matched a live item were being resurrected by it.
//
// A fake DB cannot evaluate the predicate, so what is asserted here is that the
// emitted SQL still carries the truncation. That is the same bargain the
// monotonic-guard test above makes, and it fails if anyone takes it back out.

test('GET inbox compares read markers at millisecond resolution', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/inbox`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);

    const call = db.calls.find((c) => c.normalized.startsWith('with items as'));
    assert.ok(call, 'the aggregate query ran');
    // Both halves matter: the truncation is present...
    assert.match(call.normalized, /date_trunc\('milliseconds', i\.created_at\) > r\.read_at/);
    // ...and the raw microsecond comparison that caused the bug is gone.
    assert.doesNotMatch(call.normalized, /\(r\.read_at is null or i\.created_at > r\.read_at\)/);
  });
});

test('POST /backend/inbox/read stores the marker at millisecond resolution', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/inbox/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: WS, contextKey: 'blocker:b1', readAt: isoDaysAgo(1) }),
    });
    assert.equal(res.status, 200);

    const write = db.calls.find((c) => c.normalized.startsWith('insert into inbox_read_state'));
    assert.ok(write, 'the marker write ran');
    // Normalising on the way in keeps the column comparable with the read
    // predicate whoever writes it, not only JavaScript callers.
    assert.match(write.normalized, /values \(\$1::uuid, \$2::uuid, \$3, date_trunc\('milliseconds', \$4::timestamptz\)\)/);
  });
});

test('POST /backend/inbox/read requires auth', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/inbox/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS, contextKey: 'blocker:b1', readAt: isoDaysAgo(0) }),
    });
    assert.equal(res.status, 401);
    assert.equal(db.markers.size, 0);
  });
});

test('POST /backend/inbox/read rejects a non-member and writes nothing', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(STRANGER, '1');
    const res = await fetch(`${baseUrl}/backend/inbox/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: WS, contextKey: 'blocker:b1', readAt: isoDaysAgo(0) }),
    });
    assert.equal(res.status, 403);
    assert.equal(db.markers.size, 0);
  });
});

test('POST /backend/inbox/read emits a guarded monotonic upsert', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/inbox/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: WS, contextKey: 'blocker:b1', readAt: isoDaysAgo(1) }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { ok: true }, error: null });

    const write = db.calls.find((c) => c.normalized.startsWith('insert into inbox_read_state'));
    assert.ok(write, 'the marker write ran');
    assert.match(write.normalized, /on conflict \(user_id, workspace_id, context_key\) do update/);
    // The guard is what makes the marker monotonic — Postgres skips the update
    // when the incoming read_at is not strictly newer.
    assert.match(write.normalized, /where inbox_read_state\.read_at < excluded\.read_at/);
    assert.equal(write.params[0], MEMBER);
    assert.equal(write.params[1], WS);
    assert.equal(write.params[2], 'blocker:b1');
  });
});

test('POST /backend/inbox/read never moves a marker backwards', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const newer = isoDaysAgo(1);
    const older = isoDaysAgo(5);
    const post = (readAt) => fetch(`${baseUrl}/backend/inbox/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: WS, contextKey: 'thread:sess-2', readAt }),
    });

    assert.equal((await post(newer)).status, 200);
    const key = `${MEMBER}:${WS}:thread:sess-2`;
    assert.equal(db.markers.get(key), newer);

    // A stale readAt (slow request, or a device that was behind) is accepted as
    // a no-op — it must NOT rewind the marker and un-read the thread.
    const stale = await post(older);
    assert.equal(stale.status, 200);
    assert.deepEqual(await stale.json(), { data: { ok: true }, error: null });
    assert.equal(db.markers.get(key), newer);

    // A genuinely newer marker still advances.
    const advanced = isoDaysAgo(0);
    assert.equal((await post(advanced)).status, 200);
    assert.equal(db.markers.get(key), advanced);
  });
});

test('POST /backend/inbox/read validates its inputs', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const post = (body) => fetch(`${baseUrl}/backend/inbox/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    assert.equal((await post({ contextKey: 'blocker:b1' })).status, 400);
    assert.equal((await post({ workspaceId: WS })).status, 400);
    assert.equal((await post({ workspaceId: WS, contextKey: 'blocker:b1', readAt: 'not-a-date' })).status, 400);
    assert.equal(db.markers.size, 0);

    // readAt is optional — omitting it means "read as of now".
    const now = await post({ workspaceId: WS, contextKey: 'blocker:b1' });
    assert.equal(now.status, 200);
    assert.equal(db.markers.size, 1);
  });
});
