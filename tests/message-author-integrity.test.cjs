'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const core = require('../shared/backend-core.cjs');
const { createApp, __test } = require('../server/index.cjs');

const USER_1 = '11111111-1111-4111-8111-111111111111';
const USER_2 = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CROSS_SESSION_PARENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const eq = (column, value) => ({ column, operator: 'eq', value });

function authorizationDb({ privateSession = false, members = [USER_1], owner = USER_1 } = {}) {
  return async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (q.startsWith('select workspace_id from chat_sessions where id')) {
      return String(params[0]) === SESSION ? [{ workspace_id: WORKSPACE }] : [];
    }
    if (q.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
      return String(params[0]) === WORKSPACE && String(params[1]) === owner ? [{ ok: 1 }] : [];
    }
    if (q.startsWith('select role from workspace_members where workspace_id')) {
      return [USER_1, USER_2].includes(String(params[1])) ? [{ role: 'editor' }] : [];
    }
    if (q.startsWith('select id, visibility, folder, deleted_at from chat_sessions where id')) {
      return String(params[0]) === SESSION
        ? [{ id: SESSION, visibility: privateSession ? 'private' : 'workspace', folder: privateSession ? 'Direct messages' : 'Channels', deleted_at: null }]
        : [];
    }
    if (q.startsWith('select 1 from chat_session_members')) {
      return members.includes(String(params[1])) ? [{ ok: 1 }] : [];
    }
    if (q.startsWith('select role, sender_kind, sender_id from messages')) {
      return String(params[0]) === MESSAGE && String(params[1]) === SESSION
        ? [{ role: 'user', sender_kind: 'user', sender_id: USER_1 }]
        : [];
    }
    if (q.includes('with recursive chain as')) return [];
    throw new Error(`Unexpected authorization query: ${sql}`);
  };
}

function messageOperation(userId, op, db, values) {
  return core.enforceDbOperationAccess({
    userId,
    table: 'messages',
    op,
    filters: [eq('id', MESSAGE), eq('session_id', SESSION)],
    payload: values ? { values } : undefined,
    db,
  });
}

test('browser message identity is loaded and stamped server-side', async () => {
  const author = await core.loadBrowserMessageAuthor({
    userId: USER_1,
    db: async () => [{ id: USER_1, email: 'alice@example.test', display_name: 'Alice' }],
  });
  const stamped = core.stampBrowserMessageInsert({
    id: MESSAGE,
    session_id: SESSION,
    role: 'assistant',
    sender_kind: 'agent',
    sender_id: 'agent-1',
    sender_name: 'Forged Agent',
    content: 'hello',
  }, author);
  assert.deepEqual(
    {
      role: stamped.role,
      sender_kind: stamped.sender_kind,
      sender_id: stamped.sender_id,
      sender_name: stamped.sender_name,
    },
    { role: 'user', sender_kind: 'user', sender_id: USER_1, sender_name: 'Alice' },
  );

  const stripped = core.stripPrivilegedDbValues('messages', stamped);
  for (const column of ['role', 'sender_kind', 'sender_id', 'sender_name', 'message_kind', 'tool_name', 'tool_detail', 'deleted_at']) {
    assert.equal(Object.hasOwn(stripped, column), false, `${column} is not client-editable`);
  }

  assert.deepEqual(
    core.stripImmutableDbUpdateValues('messages', {
      id: 'replacement',
      session_id: 'other-session',
      thread_parent_id: 'other-thread',
      content: 'allowed edit',
    }),
    { content: 'allowed edit' },
  );
  assert.deepEqual(
    core.stripImmutableDbUpdateValues('chat_sessions', {
      title: 'Allowed rename',
      visibility: 'private',
      folder: 'Direct messages',
    }),
    { title: 'Allowed rename' },
    'generic session writes must not change either half of the privacy classification',
  );
});

test('author-only mutations carry the authenticated author into the SQL filters', () => {
  const base = [eq('id', MESSAGE), eq('session_id', SESSION)];
  assert.deepEqual(
    core.appendMessageAuthorshipFilters({
      userId: USER_1,
      table: 'messages',
      op: 'update',
      filters: base,
      values: { content: 'edited' },
    }),
    [
      ...base,
      eq('role', 'user'),
      eq('sender_kind', 'user'),
      eq('sender_id', USER_1),
    ],
  );
  assert.equal(
    core.appendMessageAuthorshipFilters({
      userId: USER_1,
      table: 'messages',
      op: 'update',
      filters: base,
      values: { pinned: true },
    }),
    base,
    'collaborative pinning is not accidentally made author-only',
  );

  const finalWhere = core.appendMessageMutationAccessClause(
    { clause: ' where id = $1', params: [MESSAGE] },
    USER_1,
    'messages',
  );
  assert.match(finalWhere.clause, /chat_sessions message_session_scope/);
  assert.match(finalWhere.clause, /chat_session_members/);
  assert.match(finalWhere.clause, /message_session_scope\.deleted_at is null/);
  assert.match(finalWhere.clause, /messages\.deleted_at is null/);
  assert.match(finalWhere.clause, /for share/);
  assert.deepEqual(finalWhere.params, [MESSAGE, USER_1]);
});

test('own message content update and delete pass the shared Fly/Netlify guard', async () => {
  const db = authorizationDb();
  await messageOperation(USER_1, 'update', db, { content: 'edited' });
  await messageOperation(USER_1, 'delete', db);
});

test('another workspace editor cannot edit or delete somebody else message', async () => {
  const db = authorizationDb();
  await assert.rejects(
    () => messageOperation(USER_2, 'update', db, { content: 'forged edit' }),
    { status: 403, message: 'You can only edit or delete your own messages' },
  );
  await assert.rejects(
    () => messageOperation(USER_2, 'delete', db),
    { status: 403, message: 'You can only edit or delete your own messages' },
  );
});

test('private-session membership is required before insert, edit, or delete', async () => {
  const db = authorizationDb({ privateSession: true, members: [USER_1] });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: USER_2,
      table: 'messages',
      op: 'insert',
      payload: { values: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', session_id: SESSION, content: 'intrusion' } },
      db,
    }),
    { status: 403, message: 'This conversation is private' },
  );
  await assert.rejects(
    () => messageOperation(USER_2, 'update', db, { content: 'intrusion' }),
    { status: 403, message: 'This conversation is private' },
  );
  await assert.rejects(
    () => messageOperation(USER_2, 'delete', db),
    { status: 403, message: 'This conversation is private' },
  );
});

function flyDb() {
  const writes = [];
  const mutations = [];
  const insertAttempts = [];
  const activityScrubs = [];
  const db = {
    writes,
    mutations,
    insertAttempts,
    activityScrubs,
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      const q = normalized.toLowerCase();
      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'message-integrity-test-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.startsWith('select workspace_id from chat_sessions where id')) return [{ workspace_id: WORKSPACE }];
      if (q.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) return [{ ok: 1 }];
      if (q.startsWith('select id, visibility, folder, deleted_at from chat_sessions where id')) {
        return [{ id: SESSION, visibility: 'workspace', folder: 'Channels', deleted_at: null }];
      }
      if (q.startsWith('select id, email, display_name from app_users')) {
        return [{ id: USER_1, email: 'alice@example.test', display_name: 'Alice' }];
      }
      if (q.startsWith('select role, sender_kind, sender_id from messages')) {
        return String(params[0]) === MESSAGE && String(params[1]) === SESSION
          ? [{ role: 'user', sender_kind: 'user', sender_id: USER_1 }]
          : [];
      }
      if (q.startsWith('select "id", "content", "attachments", "thread_parent_id", "deleted_at" from "messages"')) {
        return [{
          id: MESSAGE,
          session_id: SESSION,
          role: 'user',
          content: 'deleted secret',
          attachments: [{ id: 'file-1', name: 'secret.txt' }],
          thread_parent_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          sender_kind: 'user',
          sender_id: USER_1,
          sender_name: 'Alice',
          deleted_at: '2026-07-31T12:00:00.000Z',
        }];
      }
      if (q.startsWith('insert into "messages"')) {
        insertAttempts.push({ sql: normalized, params });
        if (String(params.at(-1) || '') === CROSS_SESSION_PARENT) return [];
        const columns = normalized.match(/insert into "messages" \(([^)]+)\)/i)[1]
          .split(',')
          .map(column => column.replaceAll('"', '').trim());
        const row = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
        writes.push(row);
        return [row];
      }
      if (q.startsWith('update "messages"')) {
        mutations.push({ sql: normalized, params });
        return [{
          id: MESSAGE,
          session_id: SESSION,
          role: 'user',
          sender_kind: 'user',
          sender_id: USER_1,
          content: 'hello',
          deleted_at: new Date().toISOString(),
        }];
      }
      if (q.startsWith('update activity_events')) {
        activityScrubs.push({ sql: normalized, params });
        return [{
          id: 'activity-1',
          workspace_id: WORKSPACE,
          event_type: 'message_sent',
          entity_type: 'message',
          entity_id: MESSAGE,
          title: 'Message deleted',
          metadata: { session_id: SESSION, deleted: true },
        }];
      }
      return [];
    },
  };
  db.begin = async (callback) => callback(db);
  return db;
}

async function withServer(fn) {
  const server = http.createServer(createApp());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('the Fly generic insert route overwrites forged assistant and agent attribution', async () => {
  const db = flyDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(USER_1, '1');
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/backend/db/insert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'messages',
        values: {
          id: MESSAGE,
          session_id: SESSION,
          role: 'assistant',
          sender_kind: 'agent',
          sender_id: 'agent-forgery',
          sender_name: 'Forged Agent',
          message_kind: 'tool_step',
          content: 'forged',
        },
        single: true,
      }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(db.writes.length, 1);
  assert.deepEqual(
    {
      role: db.writes[0].role,
      sender_kind: db.writes[0].sender_kind,
      sender_id: db.writes[0].sender_id,
      sender_name: db.writes[0].sender_name,
    },
    { role: 'user', sender_kind: 'user', sender_id: USER_1, sender_name: 'Alice' },
  );
  assert.equal(Object.hasOwn(db.writes[0], 'message_kind'), false);
  assert.match(db.insertAttempts[0].sql, /from messages message_parent_scope/i);
  assert.match(
    db.insertAttempts[0].sql,
    /message_parent_scope\.session_id = message_session_scope\.id/i,
  );
});

test('the Fly generic insert rejects a parent from another conversation in the insert statement', async () => {
  const db = flyDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(USER_1, '1');
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/backend/db/insert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'messages',
        values: {
          id: MESSAGE,
          session_id: SESSION,
          thread_parent_id: CROSS_SESSION_PARENT,
          content: 'cross-session reply',
        },
        single: true,
      }),
    });
    assert.equal(response.status, 403, await response.clone().text());
  });
  assert.equal(db.writes.length, 0);
  assert.equal(db.insertAttempts.length, 1);
  assert.equal(db.insertAttempts[0].params.at(-1), CROSS_SESSION_PARENT);
  assert.match(
    db.insertAttempts[0].sql,
    /message_parent_scope\.session_id = message_session_scope\.id/i,
  );
});

test('the Fly generic edit and delete routes reject another authenticated author', async () => {
  const db = flyDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(USER_2, '1');
  const body = (values) => JSON.stringify({
    table: 'messages',
    ...(values ? { values } : {}),
    filters: [eq('id', MESSAGE), eq('session_id', SESSION)],
  });

  await withServer(async baseUrl => {
    const update = await fetch(`${baseUrl}/backend/db/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body({ content: 'forged edit' }),
    });
    assert.equal(update.status, 403);

    const remove = await fetch(`${baseUrl}/backend/db/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body(),
    });
    assert.equal(remove.status, 403);
  });
});

test('the Fly generic delete route soft-deletes an owned message without FK cascades', async () => {
  const db = flyDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(USER_1, '1');
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/backend/db/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'messages',
        filters: [eq('id', MESSAGE), eq('session_id', SESSION)],
        single: true,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  });
  const tombstones = db.mutations.filter(({ sql }) => /^update "messages" set deleted_at/i.test(sql));
  assert.equal(tombstones.length, 1);
  assert.doesNotMatch(tombstones[0].sql, /delete from/i);
  assert.match(tombstones[0].sql, /chat_session_members/i);
  const messageActivityScrubs = db.activityScrubs.filter(({ sql }) =>
    /where event_type = 'message_sent'/i.test(sql)
    && /entity_id = \$1::text/i.test(sql));
  assert.equal(messageActivityScrubs.length, 1);
  assert.match(messageActivityScrubs[0].sql, /metadata = jsonb_build_object/i);
  assert.ok(!messageActivityScrubs[0].params.some(value => String(value).includes('deleted secret')));
});

test('deleted_at cannot be set or cleared through generic update', async () => {
  const db = flyDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(USER_1, '1');
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/backend/db/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'messages',
        values: { deleted_at: null },
        filters: [eq('id', MESSAGE), eq('session_id', SESSION)],
      }),
    });
    assert.equal(response.status, 400, await response.clone().text());
  });
  assert.deepEqual(db.mutations, []);
});

test('the Fly generic select returns a redacted tombstone for retained deleted content', async () => {
  const db = flyDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(USER_1, '1');
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/backend/db/select`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'messages',
        columns: 'id, content, attachments, thread_parent_id',
        filters: [eq('session_id', SESSION)],
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.data[0].content, core.DELETED_MESSAGE_CONTENT);
    assert.deepEqual(payload.data[0].attachments, []);
    assert.equal(payload.data[0].id, MESSAGE);
    assert.equal(payload.data[0].thread_parent_id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.equal(Object.hasOwn(payload.data[0], 'deleted_at'), false);
  });
});

test.afterEach(() => __test.resetTestState());
