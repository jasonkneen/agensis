'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

const USER = '11111111-1111-4111-8111-111111111111';
const OUTSIDER = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SPLIT_PARENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARENT_MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DERIVED_SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TOP_LEVEL_SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

test.afterEach(() => __test.resetTestState());

function makeDb() {
  const calls = [];
  let parentAvailable = true;
  let failParentLookup = false;
  let failParticipantInsert = false;
  let inTransaction = false;

  const db = {
    calls,
    set parentAvailable(value) { parentAvailable = value; },
    set failParentLookup(value) { failParentLookup = value; },
    set failParticipantInsert(value) { failParticipantInsert = value; },
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      const q = normalized.toLowerCase();
      calls.push({ q, sql: normalized, params, inTransaction });

      if (q.startsWith('alter table') || q.startsWith('create table')
        || q.startsWith('create index') || q.startsWith('create unique index')
        || q.startsWith('do $$')) {
        return [];
      }
      if (q.startsWith('update session_read_state receipt set last_seen_message_id')) {
        return [];
      }
      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'fly-derived-session-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) {
        return [{ token_version: '1' }];
      }
      if (q.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return params[0] === WORKSPACE && params[1] === USER ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select workspace_id from "chat_sessions" where id = $1 limit 1')) {
        return params[0] === TOP_LEVEL_SESSION ? [{ workspace_id: WORKSPACE }] : [];
      }
      if (q.startsWith('select id, visibility, folder, deleted_at from chat_sessions where id = $1 limit 1')) {
        return params[0] === TOP_LEVEL_SESSION
          ? [{ id: TOP_LEVEL_SESSION, visibility: 'workspace', folder: 'Channels', deleted_at: null }]
          : [];
      }
      if (q.startsWith('select id, workspace_id, visibility, folder, deleted_at from "chat_sessions"')) {
        return params[0] === TOP_LEVEL_SESSION
          ? [{
            id: TOP_LEVEL_SESSION,
            workspace_id: WORKSPACE,
            visibility: 'workspace',
            folder: 'Channels',
            deleted_at: null,
          }]
          : [];
      }
      if (q.startsWith('select parent_session.id, parent_session.visibility, parent_session.folder')) {
        if (failParentLookup) throw new Error('temporary parent lookup failure');
        return parentAvailable
          ? [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', visibility: 'workspace', folder: 'Direct messages' }]
          : [];
      }
      if (q.startsWith('insert into "chat_sessions"')) {
        const columns = normalized.match(/insert into "chat_sessions" \(([^)]+)\)/i)[1]
          .split(',')
          .map((column) => column.replaceAll('"', '').trim());
        const inserted = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
        const partialReturning = /returning "id", "workspace_id", "title",/i.test(normalized);
        return [{
          ...(partialReturning
            ? { id: inserted.id, workspace_id: inserted.workspace_id, title: inserted.title }
            : inserted),
          __integrity_id: inserted.id,
          __integrity_workspace_id: inserted.workspace_id,
          __integrity_visibility: inserted.visibility,
          __integrity_folder: inserted.folder,
          __integrity_parent_message_id: inserted.parent_message_id || null,
          __integrity_split_parent_id: inserted.split_parent_id || null,
        }];
      }
      if (q.startsWith('insert into chat_session_members')) {
        if (failParticipantInsert && q.includes("values ($1, $2, 'participant')")) {
          throw new Error('membership write failed');
        }
        return [];
      }
      if (q.startsWith('select id, workspace_id, channel_id, events from flow_connections')) {
        return [];
      }
      if (q.startsWith('select user_id from chat_session_members')) {
        return [{ user_id: USER }];
      }
      if (q.startsWith('select close_session_scope.id from chat_sessions close_session_scope')) {
        return params[0] === TOP_LEVEL_SESSION ? [{ id: TOP_LEVEL_SESSION }] : [];
      }
      if (q.startsWith('select huddle.id, huddle.workspace_id')) return [];
      if (q.startsWith('select child_session.id')) return [];
      if (q.startsWith('update agent_schedules')) return [];
      if (q.startsWith('update agent_jobs')) return [];
      if (q.startsWith('update agent_permission_requests')) return [];
      if (q.startsWith('with cleared_messages')) return [{ cleared_messages: 0 }];
      if (q.startsWith('with scrubbed_activity')) return [{ scrubbed_activity: 0 }];
      if (q.startsWith('update "chat_sessions" set')) {
        assert.match(normalized, /returning "id", id as "__integrity_id"$/i);
        return [{ id: TOP_LEVEL_SESSION, __integrity_id: TOP_LEVEL_SESSION }];
      }
      if (q.startsWith('select id, workspace_id, title, model, folder, description, icon, intent,')) {
        assert.equal(inTransaction, true, 'canonical closure row is read before commit');
        assert.deepEqual(params, [`{"${TOP_LEVEL_SESSION}"}`]);
        return [{
          id: TOP_LEVEL_SESSION,
          workspace_id: WORKSPACE,
          title: 'Closed channel',
          model: 'auto',
          folder: 'Channels',
          description: '',
          icon: null,
          intent: '',
          participants: [],
          conversation_mode: 'auto',
          deleted_at: '2026-07-31T12:00:00.000Z',
          visibility: 'workspace',
          updated_at: '2026-07-31T12:00:00.000Z',
        }];
      }
      if (q.startsWith('insert into audit_log')) return [];
      throw new Error(`Unexpected Fly derived-session query: ${normalized}`);
    },
    async begin(callback) {
      assert.equal(inTransaction, false);
      calls.push({ q: 'begin', sql: 'BEGIN', params: [], inTransaction: false });
      inTransaction = true;
      try {
        const result = await callback({ unsafe: db.unsafe.bind(db) });
        calls.push({ q: 'commit', sql: 'COMMIT', params: [], inTransaction: true });
        return result;
      } catch (error) {
        calls.push({ q: 'rollback', sql: 'ROLLBACK', params: [], inTransaction: true });
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };
  return db;
}

async function withServer(db, callback) {
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`, token);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function createDerived(baseUrl, token) {
  return fetch(`${baseUrl}/backend/db/insert`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
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
  });
}

function createTopLevelPrivate(baseUrl, token, returning = '*') {
  return fetch(`${baseUrl}/backend/db/insert`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      table: 'chat_sessions',
      values: {
        id: TOP_LEVEL_SESSION,
        workspace_id: WORKSPACE,
        title: 'Top-level DM',
        folder: 'Direct messages',
        visibility: 'workspace',
      },
      returning,
      single: true,
    }),
  });
}

test('Fly commits a top-level private session with creator membership before realtime fanout', async () => {
  const db = makeDb();
  const delivered = [];
  const socket = (userId) => ({
    userId,
    readyState: 1,
    subscriptions: [{
      type: 'db_changes',
      table: 'chat_sessions',
      filter: `workspace_id=eq.${WORKSPACE}`,
    }],
    send: (raw) => delivered.push({ userId, row: JSON.parse(raw).payload.new }),
  });
  __test.registerTestWebsocketClient(socket(USER));
  __test.registerTestWebsocketClient(socket(OUTSIDER));
  await withServer(db, async (baseUrl, token) => {
    const response = await createTopLevelPrivate(baseUrl, token, 'id,workspace_id,title');
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.data.id, TOP_LEVEL_SESSION);
    assert.equal(body.data.visibility, undefined, 'the HTTP response keeps its requested projection');
    assert.equal(body.data.folder, undefined, 'internal privacy fields never widen the HTTP response');
    assert.equal(Object.keys(body.data).some(key => key.startsWith('__integrity_')), false);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const insertIndex = db.calls.findIndex(call => call.q.startsWith('insert into "chat_sessions"'));
  const membershipIndex = db.calls.findIndex(call => call.q.startsWith('insert into chat_session_members'));
  const commitIndex = db.calls.findIndex(call => call.q === 'commit');
  const audienceIndex = db.calls.findIndex(call => call.q.startsWith('select user_id from chat_session_members'));
  assert.ok(insertIndex >= 0);
  assert.ok(membershipIndex > insertIndex);
  assert.equal(db.calls[membershipIndex].inTransaction, true);
  assert.deepEqual(db.calls[membershipIndex].params, [TOP_LEVEL_SESSION, USER]);
  assert.ok(commitIndex > membershipIndex);
  assert.ok(audienceIndex > commitIndex, 'private realtime audience lookup must start only after commit');
  assert.equal(db.calls[audienceIndex].inTransaction, false);
  assert.deepEqual(delivered.map(({ userId }) => userId), [USER]);
  assert.equal(delivered[0].row.visibility, 'workspace');
  assert.equal(delivered[0].row.folder, 'Direct messages');
});

test('Fly canonicalizes a partial-returning session close before realtime fanout', async () => {
  const db = makeDb();
  const delivered = [];
  __test.registerTestWebsocketClient({
    userId: USER,
    readyState: 1,
    subscriptions: [{
      type: 'db_changes',
      table: 'chat_sessions',
      filter: `workspace_id=eq.${WORKSPACE}`,
    }],
    send(raw) {
      delivered.push(JSON.parse(raw).payload.new);
    },
  });

  await withServer(db, async (baseUrl, token) => {
    const response = await fetch(`${baseUrl}/backend/db/update`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        table: 'chat_sessions',
        values: { deleted_at: '2026-07-31T12:00:00.000Z' },
        filters: [{ column: 'id', operator: 'eq', value: TOP_LEVEL_SESSION }],
        returning: 'id',
        single: true,
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      data: { id: TOP_LEVEL_SESSION },
      error: null,
    });
  });

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    id: TOP_LEVEL_SESSION,
    workspace_id: WORKSPACE,
    title: 'Closed channel',
    model: 'auto',
    folder: 'Channels',
    description: '',
    icon: null,
    intent: '',
    participants: [],
    conversation_mode: 'auto',
    deleted_at: '2026-07-31T12:00:00.000Z',
    visibility: 'workspace',
    updated_at: '2026-07-31T12:00:00.000Z',
  });
  const canonicalRead = db.calls.find(call => call.q.startsWith(
    'select id, workspace_id, title, model, folder, description, icon, intent,',
  ));
  const commit = db.calls.findIndex(call => call.q === 'commit');
  assert.ok(canonicalRead);
  assert.ok(db.calls.indexOf(canonicalRead) < commit);
});

test('Fly rolls back a top-level private session when creator membership cannot be written', async () => {
  const db = makeDb();
  db.failParticipantInsert = true;
  await withServer(db, async (baseUrl, token) => {
    const response = await createTopLevelPrivate(baseUrl, token);
    assert.equal(response.status, 503, await response.clone().text());
    const body = await response.json();
    assert.match(String(body.error?.message || ''), /establish the conversation audience/i);
  });

  assert.equal(db.calls.at(-1).q, 'rollback');
  assert.equal(db.calls.some(call => call.q === 'commit'), false);
  assert.equal(
    db.calls.some(call => call.q.startsWith('select user_id from chat_session_members')),
    false,
    'a rolled-back private session must never enter realtime fanout',
  );
});

test('Fly rejects an ambiguous derived session before opening a transaction', async () => {
  const db = makeDb();
  await withServer(db, async (baseUrl, token) => {
    const response = await fetch(`${baseUrl}/backend/db/insert`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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
    });
    assert.equal(response.status, 400, await response.clone().text());
    const body = await response.json();
    assert.match(String(body.error?.message || ''), /cannot have both/i);
  });
  assert.equal(db.calls.some(call => call.q === 'begin'), false);
  assert.equal(db.calls.some(call => call.q.startsWith('insert into "chat_sessions"')), false);
});

test('Fly proves and locks a same-workspace readable parent through insert and audience copy', async () => {
  const db = makeDb();
  await withServer(db, async (baseUrl, token) => {
    const response = await createDerived(baseUrl, token);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.data.visibility, 'private');
    assert.equal(Object.keys(body.data).some(key => key.startsWith('__integrity_')), false);
  });

  const lookup = db.calls.find(call => call.q.startsWith(
    'select parent_session.id, parent_session.visibility, parent_session.folder',
  ));
  assert.ok(lookup);
  assert.equal(lookup.inTransaction, true);
  assert.match(lookup.q, /parent_session\.workspace_id = \$3::uuid/);
  assert.match(lookup.q, /parent_message\.deleted_at is null/);
  assert.match(lookup.q, /chat_session_members/);
  assert.match(lookup.q, /for share of parent_session$/);
  assert.deepEqual(lookup.params, [null, PARENT_MESSAGE, WORKSPACE, USER]);

  const insert = db.calls.find(call => call.q.startsWith('insert into "chat_sessions"'));
  assert.ok(insert);
  assert.equal(insert.inTransaction, true);
  const membershipWrites = db.calls.filter(call => call.q.startsWith('insert into chat_session_members'));
  assert.equal(membershipWrites.length, 2);
  assert.equal(membershipWrites.every(call => call.inTransaction), true);
  const commitIndex = db.calls.findIndex(call => call.q === 'commit');
  const finalMembershipIndex = db.calls.findLastIndex(
    call => call.q.startsWith('insert into chat_session_members'),
  );
  assert.ok(commitIndex > finalMembershipIndex);
});

test('Fly rejects an unavailable parent before insert and rolls back', async () => {
  const db = makeDb();
  db.parentAvailable = false;
  await withServer(db, async (baseUrl, token) => {
    const response = await createDerived(baseUrl, token);
    assert.equal(response.status, 403, await response.clone().text());
    const body = await response.json();
    assert.match(String(body.error?.message || ''), /parent conversation is unavailable/i);
  });
  assert.equal(db.calls.some(call => call.q.startsWith('insert into "chat_sessions"')), false);
  assert.equal(db.calls.at(-1).q, 'rollback');
});

test('Fly fails closed on parent-proof faults and private-audience write faults', async (t) => {
  await t.test('parent proof fault', async () => {
    const db = makeDb();
    db.failParentLookup = true;
    await withServer(db, async (baseUrl, token) => {
      const response = await createDerived(baseUrl, token);
      assert.equal(response.status, 503, await response.clone().text());
      assert.equal(db.calls.some(call => call.q.startsWith('insert into "chat_sessions"')), false);
    });
    assert.equal(db.calls.at(-1).q, 'rollback');
  });

  await t.test('audience write fault', async () => {
    const db = makeDb();
    db.failParticipantInsert = true;
    await withServer(db, async (baseUrl, token) => {
      const response = await createDerived(baseUrl, token);
      assert.equal(response.status, 503, await response.clone().text());
      const body = await response.json();
      assert.match(String(body.error?.message || ''), /establish the derived conversation audience/i);
    });
    assert.equal(db.calls.at(-1).q, 'rollback');
    assert.equal(db.calls.some(call => call.q === 'commit'), false);
  });
});
