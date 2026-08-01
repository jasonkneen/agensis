'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AUTH_SECRET = 'netlify-derived-session-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SPLIT_PARENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARENT_MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DERIVED_SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TOP_LEVEL_SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let handler;
let calls = [];
let failInheritanceLookup = false;
let failParticipantInsert = false;
let parentAvailable = true;
let inTransaction = false;

test.before(async () => {
  process.env.AUTH_SECRET = AUTH_SECRET;
  delete process.env.AGENSIS_AUTH_SECRET;
  mock.module('@netlify/database', {
    exports: {
      getDatabase: () => {
        const execute = async (sql, params = []) => {
            const normalized = String(sql).replace(/\s+/g, ' ').trim();
            const q = normalized.toLowerCase();
            calls.push({ sql: normalized, q, params, inTransaction });
            if (q === 'begin') {
              inTransaction = true;
              return { rows: [] };
            }
            if (q === 'commit' || q === 'rollback') {
              inTransaction = false;
              return { rows: [] };
            }
            if (q.startsWith('alter table') || q.startsWith('create table')
              || q.startsWith('create index') || q.startsWith('create unique index')) {
              return { rows: [] };
            }
            if (q.startsWith('select token_version from app_users')) return { rows: [{ token_version: '1' }] };
            if (q.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
              return { rows: [{ ok: 1 }] };
            }
            if (q.startsWith('select id, parent_id, user_id from workspaces')) {
              return { rows: [{ id: WORKSPACE, parent_id: null, user_id: USER }] };
            }
            if (q.startsWith('select role from workspace_members')) {
              return { rows: [{ role: 'owner' }] };
            }
            if (q.startsWith('select m.session_id from messages m')) {
              if (failInheritanceLookup) throw new Error('temporary parent lookup failure');
              return { rows: [{ session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] };
            }
            if (q.startsWith('select m.id from messages m')) {
              if (failInheritanceLookup) throw new Error('temporary parent lookup failure');
              return { rows: parentAvailable ? [{ id: PARENT_MESSAGE }] : [] };
            }
            if (q.startsWith('select s.id, s.workspace_id, s.title')) {
              if (failInheritanceLookup) throw new Error('temporary parent lookup failure');
              return {
                rows: parentAvailable
                  ? [{
                    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    workspace_id: WORKSPACE,
                    title: 'Parent conversation',
                    model: 'auto',
                    folder: 'Direct messages',
                    description: '',
                    icon: '',
                    intent: '',
                    participants: [],
                    conversation_mode: 'auto',
                    max_agent_turns: 10,
                    auto_rounds: 3,
                    canvas_id: null,
                    visibility: 'private',
                    deleted_at: null,
                  }]
                  : [],
              };
            }
            if (q.startsWith('select user_id, source, granted_by, expires_at from chat_session_members')) {
              return { rows: [{ user_id: USER, source: 'participant', granted_by: null, expires_at: null }] };
            }
            if (q.startsWith('select 1 from chat_session_members')) {
              return { rows: [{ ok: 1 }] };
            }
            if (q.startsWith('select parent_session.id, parent_session.visibility, parent_session.folder from chat_sessions parent_session')) {
              if (failInheritanceLookup) throw new Error('temporary parent lookup failure');
              return {
                rows: parentAvailable
                  ? [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', visibility: 'workspace', folder: 'Direct messages' }]
                  : [],
              };
            }
            if (q.startsWith('insert into "chat_sessions"')) {
              const columns = normalized.match(/insert into "chat_sessions" \(([^)]+)\)/i)[1]
                .split(',')
                .map((column) => column.replaceAll('"', '').trim());
              const inserted = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
              return {
                rows: [{
                  ...inserted,
                  __integrity_id: inserted.id,
                  __integrity_workspace_id: inserted.workspace_id,
                  __integrity_visibility: inserted.visibility,
                  __integrity_folder: inserted.folder || 'Threads',
                  __integrity_parent_message_id: inserted.parent_message_id || null,
                  __integrity_split_parent_id: inserted.split_parent_id || null,
                }],
              };
            }
            if (q.startsWith('insert into chat_session_members')) {
              if (failParticipantInsert && q.includes("values ($1::uuid, $2::uuid, 'participant'")) {
                throw new Error('membership write failed');
              }
              return { rows: [] };
            }
            throw new Error(`Unexpected derived-session query: ${normalized}`);
        };
        return {
          pool: {
            query: execute,
            async connect() {
              return {
                query: execute,
                release() {},
              };
            },
          },
        };
      },
    },
  });
  const backend = await import(
    pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href
  );
  handler = backend.default;
});

test.beforeEach(() => {
  calls = [];
  failInheritanceLookup = false;
  failParticipantInsert = false;
  parentAvailable = true;
  inTransaction = false;
});

function token() {
  const payload = `${USER}.1.${Math.floor(Date.now() / 1000)}`;
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

async function createDerived() {
  return handler(new Request('http://localhost/backend/db/insert', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'chat_sessions',
      values: {
        id: DERIVED_SESSION,
        workspace_id: WORKSPACE,
        title: 'Private offshoot',
        folder: 'Threads',
        visibility: 'workspace',
        parent_message_id: PARENT_MESSAGE,
      },
      single: true,
    }),
  }));
}

async function createTopLevelPrivate() {
  return handler(new Request('http://localhost/backend/db/insert', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'chat_sessions',
      values: {
        id: TOP_LEVEL_SESSION,
        workspace_id: WORKSPACE,
        title: 'Top-level DM',
        folder: 'Direct messages',
        visibility: 'workspace',
      },
      single: true,
    }),
  }));
}

test('Netlify commits a top-level private session and creator membership together', async () => {
  const response = await createTopLevelPrivate();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.data.id, TOP_LEVEL_SESSION);

  const insertIndex = calls.findIndex(call => call.q.startsWith('insert into "chat_sessions"'));
  const membershipIndex = calls.findIndex(call => call.q.startsWith('insert into chat_session_members'));
  const commitIndex = calls.findIndex(call => call.q === 'commit');
  assert.ok(insertIndex >= 0);
  assert.ok(membershipIndex > insertIndex);
  assert.equal(calls[membershipIndex].inTransaction, true);
  assert.deepEqual(calls[membershipIndex].params, [TOP_LEVEL_SESSION, USER]);
  assert.ok(commitIndex > membershipIndex);
});

test('Netlify rolls back a top-level private session when creator membership cannot be written', async () => {
  failParticipantInsert = true;
  const response = await createTopLevelPrivate();
  assert.equal(response.status, 500, await response.clone().text());
  const body = await response.json();
  assert.match(String(body.error?.message || ''), /membership write failed/i);
  assert.equal(calls.at(-1).q, 'rollback');
  assert.equal(calls.some(call => call.q === 'commit'), false);
});

test('Netlify rejects an ambiguous derived session before opening a transaction', async () => {
  const response = await handler(new Request('http://localhost/backend/db/insert', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'chat_sessions',
      values: {
        id: DERIVED_SESSION,
        workspace_id: WORKSPACE,
        title: 'Ambiguous offshoot',
        parent_message_id: PARENT_MESSAGE,
        split_parent_id: SPLIT_PARENT,
      },
      single: true,
    }),
  }));
  assert.equal(response.status, 400, await response.clone().text());
  const body = await response.json();
  assert.match(String(body.error?.message || ''), /cannot have both|only one parent/i);
  assert.equal(calls.some(call => call.q === 'begin'), false);
  assert.equal(calls.some(call => call.q.startsWith('insert into "chat_sessions"')), false);
});

test('Netlify overrides a client-public derived session and copies the private parent audience', async () => {
  const response = await createDerived();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.data.visibility, 'private');

  const lookup = calls.find((call) => call.q.startsWith(
    'select s.id, s.workspace_id, s.title',
  ));
  assert.ok(lookup);
  assert.match(lookup.q, /s\.workspace_id = \$2::uuid/);
  assert.match(lookup.q, /for share of s/);
  const messageLock = calls.find((call) => call.q.startsWith('select m.id from messages m'));
  assert.ok(messageLock);
  assert.match(messageLock.q, /m\.session_id = \$2::uuid/);
  assert.ok(calls.some((call) => call.q === 'begin'));
  assert.equal(calls.at(-1).q, 'commit');

  const membershipWrites = calls.filter((call) => call.q.startsWith('insert into chat_session_members'));
  assert.equal(membershipWrites.length, 1, 'the inherited roster is copied atomically');
  assert.deepEqual(membershipWrites[0].params, [DERIVED_SESSION, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
});

test('an inheritance lookup fault rejects the derived session before insert', async () => {
  failInheritanceLookup = true;
  const response = await createDerived();
  assert.equal(response.status, 500, await response.clone().text());
  const body = await response.json();
  assert.match(String(body.error?.message || ''), /temporary parent lookup failure/i);
  assert.equal(calls.some((call) => call.q.startsWith('insert into "chat_sessions"')), false);
  assert.equal(calls.some((call) => call.q.startsWith('insert into chat_session_members')), false);
  assert.equal(calls.at(-1).q, 'rollback');
});

test('an unavailable parent is rejected before the derived session is inserted', async () => {
  parentAvailable = false;
  const response = await createDerived();
  assert.equal(response.status, 400, await response.clone().text());
  const body = await response.json();
  assert.match(String(body.error?.message || ''), /parent conversation is unavailable/i);
  assert.equal(calls.some((call) => call.q.startsWith('insert into "chat_sessions"')), false);
  assert.equal(calls.some((call) => call.q.startsWith('insert into chat_session_members')), false);
  assert.equal(calls.at(-1).q, 'rollback');
});
