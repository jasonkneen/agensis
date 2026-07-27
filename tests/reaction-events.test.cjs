'use strict';

// ============================================================================
// tests/reaction-events.test.cjs
// ----------------------------------------------------------------------------
// `messages.reactions` was written and emitted nothing: no `reaction.*` entry in
// FLOW_EVENTS and no notify on the write path, so approval/acknowledgement —
// the one signal a human gives without typing — was invisible to every
// integration.
//
// A reaction is not a row. The UI replaces the whole jsonb map through the
// generic /backend/db/update route, so the event is the DIFFERENCE between the
// stored map and the written one. That has consequences this file pins:
//
//   * re-writing a map the row already holds is not a change and emits nothing
//     (so a retry, or a double-click landing twice, cannot duplicate an event)
//   * removal IS an event — a settlement mechanism keyed on a tick has to learn
//     when the tick is withdrawn — and is separately subscribable, so an
//     integration that does not want it never sees it
//   * the payload is a SIGNAL, not a content export: no message body
//   * an event reaches only connections entitled to that workspace
//
// The route tests run the real Express handler against a fake DB, so they cover
// the wiring (before-image read, fire-and-forget emission) and not just the
// pure diff. `netlify/functions/backend.mjs` gets the same treatment in
// tests/reaction-events-netlify.test.cjs — one lane emitting and the other
// silently not is this repo's most repeated bug.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');
const { FLOW_EVENTS } = require('../server/flow-integration.cjs');
const {
  MAX_REACTION_EVENTS_PER_WRITE,
  MAX_REACTION_LENGTH,
  REACTION_CREATED,
  REACTION_REMOVED,
  buildReactionFlowEvent,
  diffReactionMaps,
  normalizeReactionMap,
} = require('../shared/reaction-events.cjs');

const USER = 'user-1';
const OTHER_USER = 'user-2';
const WORKSPACE = 'w1';
const OTHER_WORKSPACE = 'w2';
const SESSION = 'chan-1';
const MESSAGE = 'msg-1';

test.afterEach(() => __test.resetTestState());

// ---------------------------------------------------------------------------
// The diff itself.
// ---------------------------------------------------------------------------

test('the reaction names are part of the FLOW_EVENTS vocabulary', () => {
  assert.ok(FLOW_EVENTS.includes(REACTION_CREATED), 'reaction.created is subscribable');
  assert.ok(FLOW_EVENTS.includes(REACTION_REMOVED), 'reaction.removed is subscribable');
  // The vocabulary is `<resource>.<verb>` — a reaction event that read
  // `reactionAdded` or `reactions:create` would be a second style.
  for (const event of FLOW_EVENTS) {
    assert.match(event, /^[a-z]+\.[a-z]+$/, `${event} does not match the existing event naming`);
  }
});

test('adding a reaction is exactly one created change', () => {
  const changes = diffReactionMaps({}, { '✅': [USER] });
  assert.deepEqual(changes, [{ type: REACTION_CREATED, reaction: '✅', userId: USER, count: 1 }]);
});

test('writing the same map again is not a change', () => {
  const map = { '✅': [USER] };
  assert.deepEqual(diffReactionMaps(map, map), []);
  assert.deepEqual(diffReactionMaps(map, { '✅': [USER] }), []);
  // Even when the stored value arrived as a jsonb string rather than an object.
  assert.deepEqual(diffReactionMaps(JSON.stringify(map), map), []);
});

test('removing a reaction is a removed change carrying the remaining count', () => {
  assert.deepEqual(
    diffReactionMaps({ '✅': [USER, OTHER_USER] }, { '✅': [OTHER_USER] }),
    [{ type: REACTION_REMOVED, reaction: '✅', userId: USER, count: 1 }],
  );
  // The browser deletes the key when the last holder un-reacts.
  assert.deepEqual(
    diffReactionMaps({ '✅': [USER] }, {}),
    [{ type: REACTION_REMOVED, reaction: '✅', userId: USER, count: 0 }],
  );
});

test('a reaction nobody holds is the same as no reaction at all', () => {
  // Rows written before the UI started deleting empty keys still carry `[]`.
  assert.deepEqual(normalizeReactionMap({ '✅': [] }), {});
  assert.deepEqual(diffReactionMaps({ '✅': [] }, {}), []);
  assert.deepEqual(diffReactionMaps({}, { '✅': [] }), []);
  // Duplicates in the list are one holder, not two.
  assert.deepEqual(normalizeReactionMap({ '✅': [USER, USER] }), { '✅': [USER] });
});

test('a single write can carry several changes, deterministically ordered', () => {
  const changes = diffReactionMaps(
    { b: [USER], a: [OTHER_USER] },
    { a: [OTHER_USER, USER], c: [USER] },
  );
  assert.deepEqual(changes, [
    { type: REACTION_CREATED, reaction: 'a', userId: USER, count: 2 },
    { type: REACTION_REMOVED, reaction: 'b', userId: USER, count: 0 },
    { type: REACTION_CREATED, reaction: 'c', userId: USER, count: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// The route.
// ---------------------------------------------------------------------------

function connectionRow(overrides = {}) {
  return {
    id: 'conn-1',
    workspace_id: WORKSPACE,
    channel_id: null,
    events: [...FLOW_EVENTS],
    ...overrides,
  };
}

function messageRow(overrides = {}) {
  return {
    id: MESSAGE,
    session_id: SESSION,
    reactions: {},
    sender_kind: 'agent',
    sender_id: 'agent-7',
    sender_name: 'Coder',
    thread_parent_id: null,
    created_at: '2026-07-01T00:00:00.000Z',
    content: 'the secret contents of this message',
    ...overrides,
  };
}

// Answers exactly the statements this route issues, and records every delivery
// insert so the assertions can prove what was queued.
function makeDb({ message, connections = [connectionRow()], failDeliveryInsert = false } = {}) {
  const deliveries = [];
  const messageUpdates = [];
  const db = {
    deliveries,
    messageUpdates,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      const q = n.toLowerCase();
      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'reaction-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.startsWith('select 1 from workspaces where id')) {
        return String(params[1]) === USER ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select role from workspace_members')) return [];
      // enforceDbOperationAccess resolves the message's workspace via its session.
      if (q.startsWith('select workspace_id from chat_sessions where id')) {
        return String(params[0]) === SESSION ? [{ workspace_id: WORKSPACE }] : [];
      }
      // The event path re-resolves it (messages has no workspace_id column).
      if (q.startsWith('select id, workspace_id from chat_sessions where id')) {
        return String(params[0]) === SESSION ? [{ id: SESSION, workspace_id: WORKSPACE }] : [];
      }
      // The route's before-image read.
      if (q.startsWith('select id, session_id, reactions, sender_kind')) {
        return [{ ...message }];
      }
      if (q.startsWith('update "messages" set')) {
        messageUpdates.push({ sql: n, params });
        if (q.includes('"reactions" =')) message.reactions = params[0];
        return [{ ...message }];
      }
      if (q.startsWith('select id, channel_id, events from flow_connections')) {
        return connections.filter(c => String(c.workspace_id) === String(params[0]));
      }
      if (q.startsWith('insert into flow_webhook_deliveries')) {
        if (failDeliveryInsert) throw new Error('deliveries table is unavailable');
        deliveries.push({
          connectionId: params[0],
          workspaceId: params[1],
          eventId: params[2],
          eventType: params[3],
          payload: params[4],
        });
        return [];
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

async function writeReactions(baseUrl, token, reactions) {
  return fetch(`${baseUrl}/backend/db/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'messages',
      values: { reactions },
      filters: [
        { column: 'id', operator: 'eq', value: MESSAGE },
        { column: 'session_id', operator: 'eq', value: SESSION },
      ],
    }),
  });
}

// The emission is fire-and-forget so the response never waits on it.
async function settle(check, ms = 500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return check();
}

test('adding a reaction queues exactly one event, with the signal and not the message body', async () => {
  const db = makeDb({ message: messageRow() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await writeReactions(baseUrl, token, { '✅': [USER] });
    assert.equal(res.status, 200, 'the reaction is saved');
    assert.ok(await settle(() => db.deliveries.length > 0), 'an event was queued');
    await settle(() => false, 80); // let any extra (unwanted) delivery appear
  });

  assert.equal(db.deliveries.length, 1, 'exactly one delivery');
  const [delivery] = db.deliveries;
  assert.equal(delivery.eventType, REACTION_CREATED);
  assert.equal(delivery.connectionId, 'conn-1');
  assert.equal(delivery.workspaceId, WORKSPACE);

  const payload = delivery.payload;
  // porsager binds the OBJECT — a stringified jsonb bind becomes a string scalar.
  assert.equal(typeof payload, 'object', 'the Fly lane binds the payload object, not a string');
  assert.equal(payload.type, REACTION_CREATED);
  assert.equal(payload.id, delivery.eventId);
  assert.equal(payload.workspaceId, WORKSPACE);
  assert.equal(payload.channelId, SESSION);
  assert.match(payload.occurredAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(payload.data, {
    messageId: MESSAGE,
    reaction: '✅',
    userId: USER,
    actorUserId: USER,
    count: 1,
    messageSenderKind: 'agent',
    messageSenderId: 'agent-7',
    messageSenderName: 'Coder',
    messageThreadParentId: null,
    messageCreatedAt: '2026-07-01T00:00:00.000Z',
  });

  // The one thing a reaction event must never quietly widen.
  assert.ok(
    !JSON.stringify(payload).includes('the secret contents'),
    'a reaction event is a signal, not a content export',
  );
});

test('the same reaction written twice does not emit twice', async () => {
  const db = makeDb({ message: messageRow() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await writeReactions(baseUrl, token, { '✅': [USER] })).status, 200);
    assert.ok(await settle(() => db.deliveries.length > 0));
    // The same map again — a retry, or a second click that lost the race.
    assert.equal((await writeReactions(baseUrl, token, { '✅': [USER] })).status, 200);
    await settle(() => db.deliveries.length > 1, 200);
  });

  assert.equal(db.deliveries.length, 1, 'the second write is not a change');
  assert.equal(db.messageUpdates.length, 2, 'but both writes were saved');
});

test('withdrawing a reaction emits reaction.removed', async () => {
  const db = makeDb({ message: messageRow({ reactions: { '✅': [USER] } }) });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await writeReactions(baseUrl, token, {})).status, 200);
    assert.ok(await settle(() => db.deliveries.length > 0));
  });

  assert.equal(db.deliveries.length, 1);
  assert.equal(db.deliveries[0].eventType, REACTION_REMOVED);
  assert.equal(db.deliveries[0].payload.data.userId, USER);
  assert.equal(db.deliveries[0].payload.data.count, 0);
});

test('a connection that did not subscribe to removals never receives one', async () => {
  const db = makeDb({
    message: messageRow(),
    connections: [connectionRow({ events: ['message.created', REACTION_CREATED] })],
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await writeReactions(baseUrl, token, { '✅': [USER] })).status, 200);
    assert.ok(await settle(() => db.deliveries.length > 0));
    assert.equal((await writeReactions(baseUrl, token, {})).status, 200);
    await settle(() => db.deliveries.length > 1, 200);
  });

  assert.deepEqual(db.deliveries.map(d => d.eventType), [REACTION_CREATED]);
});

test('a failed delivery enqueue does not prevent the reaction being saved', async () => {
  const db = makeDb({ message: messageRow(), failDeliveryInsert: true });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await writeReactions(baseUrl, token, { '✅': [USER] });
    assert.equal(res.status, 200, 'the write succeeds even though the event cannot be queued');
    const body = await res.json();
    assert.equal(body.error, null);
    assert.deepEqual(body.data[0].reactions, { '✅': [USER] }, 'the reaction is persisted');
    await settle(() => false, 150); // give the rejected fire-and-forget time to land
  });

  assert.equal(db.deliveries.length, 0);
  assert.equal(db.messageUpdates.length, 1, 'the reaction row was written');
});

test('a reaction event does not reach a connection in another workspace', async () => {
  const db = makeDb({
    message: messageRow(),
    connections: [
      connectionRow({ id: 'conn-mine', workspace_id: WORKSPACE }),
      connectionRow({ id: 'conn-theirs', workspace_id: OTHER_WORKSPACE }),
    ],
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await writeReactions(baseUrl, token, { '✅': [USER] })).status, 200);
    assert.ok(await settle(() => db.deliveries.length > 0));
    await settle(() => db.deliveries.length > 1, 150);
  });

  assert.deepEqual(db.deliveries.map(d => d.connectionId), ['conn-mine']);
  assert.deepEqual([...new Set(db.deliveries.map(d => d.workspaceId))], [WORKSPACE]);
});

test('a channel-scoped connection only receives reactions in its own channel', async () => {
  const db = makeDb({
    message: messageRow(),
    connections: [
      connectionRow({ id: 'conn-here', channel_id: SESSION }),
      connectionRow({ id: 'conn-elsewhere', channel_id: 'chan-other' }),
    ],
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await writeReactions(baseUrl, token, { '✅': [USER] })).status, 200);
    assert.ok(await settle(() => db.deliveries.length > 0));
    await settle(() => db.deliveries.length > 1, 150);
  });

  assert.deepEqual(db.deliveries.map(d => d.connectionId), ['conn-here']);
});

test('a message edit that does not touch reactions never reads or emits', async () => {
  const db = makeDb({ message: messageRow() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/db/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'messages',
        values: { content: 'edited' },
        filters: [{ column: 'session_id', operator: 'eq', value: SESSION }],
      }),
    });
    assert.equal(res.status, 200);
    await settle(() => db.deliveries.length > 0, 150);
  });

  assert.equal(db.deliveries.length, 0, 'an ordinary edit pays for no reaction query');
});

test('one write cannot amplify into an unbounded flood of signed deliveries', async () => {
  const flood = {};
  for (let i = 0; i < MAX_REACTION_EVENTS_PER_WRITE + 20; i += 1) flood[`r${i}`] = [USER];
  const db = makeDb({ message: messageRow() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await writeReactions(baseUrl, token, flood)).status, 200);
    assert.ok(await settle(() => db.deliveries.length >= MAX_REACTION_EVENTS_PER_WRITE));
    await settle(() => db.deliveries.length > MAX_REACTION_EVENTS_PER_WRITE, 200);
  });

  assert.equal(db.deliveries.length, MAX_REACTION_EVENTS_PER_WRITE);
});

test('an oversized reaction value is truncated and says so', async () => {
  const huge = 'x'.repeat(MAX_REACTION_LENGTH + 500);
  const db = makeDb({ message: messageRow() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await writeReactions(baseUrl, token, { [huge]: [USER] })).status, 200);
    assert.ok(await settle(() => db.deliveries.length > 0));
  });

  const { data } = db.deliveries[0].payload;
  assert.equal(data.reaction.length, MAX_REACTION_LENGTH);
  assert.equal(data.reactionTruncated, true);
});

test('truncating never leaves half an emoji behind', () => {
  // An astral-plane character is two UTF-16 units, so a blind slice at the
  // limit can cut one in half.
  const pair = '\u{1F600}';
  const reaction = 'x'.repeat(MAX_REACTION_LENGTH - 1) + pair.repeat(4);
  const event = buildReactionFlowEvent({
    change: { type: REACTION_CREATED, reaction, userId: USER, count: 1 },
    workspaceId: WORKSPACE,
    channelId: SESSION,
    message: { id: MESSAGE },
    occurredAtMs: 0,
  });
  assert.equal(event.data.reactionTruncated, true);
  assert.equal(event.data.reaction.length, MAX_REACTION_LENGTH - 1, 'the split pair was dropped whole');
  assert.ok(!/[\uD800-\uDBFF]$/.test(event.data.reaction), 'no trailing lone surrogate');
});

test('a toggle sequence stays observable — re-adding a withdrawn reaction is a new event', async () => {
  const db = makeDb({ message: messageRow() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    await writeReactions(baseUrl, token, { '✅': [USER] });
    assert.ok(await settle(() => db.deliveries.length >= 1));
    await new Promise(resolve => setTimeout(resolve, 3));
    await writeReactions(baseUrl, token, {});
    assert.ok(await settle(() => db.deliveries.length >= 2));
    await new Promise(resolve => setTimeout(resolve, 3));
    await writeReactions(baseUrl, token, { '✅': [USER] });
    assert.ok(await settle(() => db.deliveries.length >= 3));
  });

  assert.deepEqual(
    db.deliveries.map(d => d.eventType),
    [REACTION_CREATED, REACTION_REMOVED, REACTION_CREATED],
  );
  // Deliveries dedupe on (connection_id, event_id): if the id were derived from
  // the resulting map, the third event would collide with the first and the
  // integration would be left believing the reaction is still withdrawn.
  assert.equal(new Set(db.deliveries.map(d => d.eventId)).size, 3, 'three distinct event ids');
});
