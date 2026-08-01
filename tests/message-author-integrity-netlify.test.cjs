'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AUTH_SECRET = 'netlify-message-integrity-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CROSS_SESSION_PARENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let handler;
let inserted;
let mutation;
let insertAttempt;
let activityScrub;
let transactionFrames;

test.before(async () => {
  process.env.AUTH_SECRET = AUTH_SECRET;
  delete process.env.AGENSIS_AUTH_SECRET;
  mock.module('@netlify/database', {
    exports: {
      getDatabase: () => ({
        pool: {
          async query(sql, params = []) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim();
            const q = normalized.toLowerCase();
            if (['begin', 'commit', 'rollback'].includes(q)) {
              transactionFrames.push(q);
              return { rows: [] };
            }
            if (q.startsWith('alter table') || q.startsWith('create table') || q.startsWith('create index') || q.startsWith('create unique index')) {
              return { rows: [] };
            }
            if (q.startsWith('select token_version from app_users')) return { rows: [{ token_version: '1' }] };
            if (q.startsWith('select workspace_id from chat_sessions where id')) {
              return { rows: [{ workspace_id: WORKSPACE }] };
            }
            if (q.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
              return { rows: [{ ok: 1 }] };
            }
            if (q.startsWith('select id, visibility, folder, deleted_at from chat_sessions where id')) {
              return { rows: [{ id: SESSION, visibility: 'workspace', folder: 'Channels', deleted_at: null }] };
            }
            if (q.startsWith('select id, email, display_name from app_users')) {
              return { rows: [{ id: USER, email: 'alice@example.test', display_name: 'Alice' }] };
            }
            if (q.startsWith('select role, sender_kind, sender_id from messages')) {
              return {
                rows: String(params[0]) === MESSAGE && String(params[1]) === SESSION
                  ? [{ role: 'user', sender_kind: 'user', sender_id: USER }]
                  : [],
              };
            }
            if (q.startsWith('select "id", "content", "attachments", "thread_parent_id", "deleted_at" from "messages"')) {
              return {
                rows: [{
                  id: MESSAGE,
                  session_id: SESSION,
                  role: 'user',
                  content: 'deleted secret',
                  attachments: [{ id: 'file-1', name: 'secret.txt' }],
                  thread_parent_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                  sender_kind: 'user',
                  sender_id: USER,
                  sender_name: 'Alice',
                  deleted_at: '2026-07-31T12:00:00.000Z',
                }],
              };
            }
            if (q.startsWith('insert into "messages"')) {
              insertAttempt = { sql: normalized, params };
              if (String(params.at(-1) || '') === CROSS_SESSION_PARENT) return { rows: [] };
              const columns = normalized.match(/insert into "messages" \(([^)]+)\)/i)[1]
                .split(',')
                .map(column => column.replaceAll('"', '').trim());
              inserted = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
              return { rows: [inserted] };
            }
            if (q.startsWith('update "messages"')) {
              mutation = { sql: normalized, params };
              return {
                rows: [{
                  id: MESSAGE,
                  session_id: SESSION,
                  role: 'user',
                  sender_kind: 'user',
                  sender_id: USER,
                  deleted_at: new Date().toISOString(),
                }],
              };
            }
            if (q.startsWith('update activity_events')) {
              activityScrub = { sql: normalized, params };
              return {
                rows: [{
                  id: 'activity-1',
                  workspace_id: WORKSPACE,
                  event_type: 'message_sent',
                  entity_type: 'message',
                  entity_id: MESSAGE,
                  title: 'Message deleted',
                  metadata: { session_id: SESSION, deleted: true },
                }],
              };
            }
            // Message activity is best-effort and is not the subject of this
            // route test. Return no source context so it exits without a write.
            if (q.startsWith('select workspace_id, visibility, folder, deleted_at from chat_sessions')) {
              return { rows: [] };
            }
            throw new Error(`Unexpected Netlify query: ${normalized}`);
          },
          async connect() {
            return {
              query: (sql, params = []) => this.query(sql, params),
              release() {},
            };
          },
        },
      }),
    },
  });
  const backend = await import(pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href);
  handler = backend.default;
});

function token(userId = USER) {
  const payload = `${userId}.1.${Math.floor(Date.now() / 1000)}`;
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

test('the Netlify generic insert route applies the same authenticated human identity', async () => {
  inserted = null;
  insertAttempt = null;
  const response = await handler(new Request('http://localhost/backend/db/insert', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'messages',
      values: {
        id: MESSAGE,
        session_id: SESSION,
        role: 'assistant',
        sender_kind: 'automation',
        sender_id: 'somebody-else',
        sender_name: 'Forged Automation',
        message_kind: 'permission_request',
        content: 'forged',
      },
      single: true,
    }),
  }));
  const responseText = await response.clone().text();
  assert.equal(response.status, 200, responseText);
  assert.ok(inserted);
  assert.deepEqual(
    {
      role: inserted.role,
      sender_kind: inserted.sender_kind,
      sender_id: inserted.sender_id,
      sender_name: inserted.sender_name,
    },
    { role: 'user', sender_kind: 'user', sender_id: USER, sender_name: 'Alice' },
  );
  assert.equal(Object.hasOwn(inserted, 'message_kind'), false);
  assert.match(insertAttempt.sql, /from messages message_parent_scope/i);
  assert.match(insertAttempt.sql, /message_parent_scope\.session_id = message_session_scope\.id/i);
});

test('the Netlify generic insert rejects a parent from another conversation in the insert statement', async () => {
  inserted = null;
  insertAttempt = null;
  const response = await handler(new Request('http://localhost/backend/db/insert', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
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
  }));
  assert.equal(response.status, 403, await response.clone().text());
  assert.equal(inserted, null);
  assert.equal(insertAttempt.params.at(-1), CROSS_SESSION_PARENT);
  assert.match(insertAttempt.sql, /message_parent_scope\.session_id = message_session_scope\.id/i);
});

test('the Netlify generic edit and delete routes reject another authenticated author', async () => {
  const request = (path, payload) => handler(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(OTHER_USER)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'messages',
      ...payload,
      filters: [
        { column: 'id', operator: 'eq', value: MESSAGE },
        { column: 'session_id', operator: 'eq', value: SESSION },
      ],
    }),
  }));

  assert.equal((await request('/backend/db/update', { values: { content: 'forged edit' } })).status, 403);
  assert.equal((await request('/backend/db/delete', {})).status, 403);
});

test('the Netlify generic delete route mirrors the ownership-scoped soft delete', async () => {
  mutation = null;
  activityScrub = null;
  transactionFrames = [];
  const response = await handler(new Request('http://localhost/backend/db/delete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'messages',
      filters: [
        { column: 'id', operator: 'eq', value: MESSAGE },
        { column: 'session_id', operator: 'eq', value: SESSION },
      ],
      single: true,
    }),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(mutation);
  assert.match(mutation.sql, /^update "messages" set deleted_at/i);
  assert.doesNotMatch(mutation.sql, /delete from/i);
  assert.match(mutation.sql, /chat_session_members/i);
  assert.ok(activityScrub);
  assert.match(activityScrub.sql, /metadata = jsonb_build_object/i);
  assert.deepEqual(transactionFrames, ['begin', 'commit']);
});

test('the Netlify generic select returns only a redacted deleted-message tombstone', async () => {
  const response = await handler(new Request('http://localhost/backend/db/select', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'messages',
      columns: 'id, content, attachments, thread_parent_id',
      filters: [{ column: 'session_id', operator: 'eq', value: SESSION }],
    }),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.data[0].content, 'This message was deleted.');
  assert.deepEqual(payload.data[0].attachments, []);
  assert.equal(payload.data[0].id, MESSAGE);
  assert.equal(payload.data[0].thread_parent_id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(Object.hasOwn(payload.data[0], 'deleted_at'), false);
});
