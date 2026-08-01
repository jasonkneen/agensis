'use strict';

// ============================================================================
// tests/read-receipt-fanout.test.cjs
// ----------------------------------------------------------------------------
// Does a read receipt reach ONLY the sockets entitled to it?
//
// This is the test that would have caught the "eight tables broadcast but not
// subscribable" class of bug, and it is the one that matters most for receipts
// specifically: a receipt says who read what and when, so a row landing on the
// wrong socket is a disclosure about a person, not a stale list.
//
// HOW THE MOCK TRAP IS AVOIDED, since this is where it usually lands.
//
// The tempting shape is a fake DB that itself applies the scoping WHERE clause,
// then asserting the result is scoped. That tests the fake. So the scoping rule
// is kept OUT of any fake here. Instead:
//
//   1. two REAL fake sockets are registered through the real
//      registerTestWebsocketClient seam, with different session_id filters;
//   2. the REAL notifyDbSubscribers is called with a row;
//   3. the assertion is on which socket received a frame.
//
// The code under test is therefore `matchesFilter` and the subscription loop in
// server/realtime.cjs — real code, no mock in the path. Deleting the
// `matchesFilter` guard turns this file red, which is checked by mutation and
// not merely hoped for.
//
// WHERE THE DM GATE ACTUALLY IS, and why it is not in this file.
//
// `session_read_state` has NO workspace_id column, so a subscription must name
// a session and clear enforceSessionReadAccess at bind time. Fanout then resolves
// that session's CURRENT audience again, because a socket bound while a channel
// was public must not retain access after it becomes private.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const { createRealtime } = require('../server/realtime.cjs');

const SESSION_A = 'chan-a';
const SESSION_B = 'chan-b';
const WORKSPACE = 'w1';

let privateMembers = null;
let optedOutUsers = null;

function pgArrayValues(value) {
  return [...String(value || '').matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map(match => match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}

test.beforeEach(() => {
  privateMembers = null;
  optedOutUsers = new Set();
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.startsWith('select id, visibility, folder from chat_sessions')
        && q.includes('where id = any')) {
        return pgArrayValues(params[0])
          .filter(id => [SESSION_A, SESSION_B].includes(id))
          .map(id => ({
            id,
            visibility: privateMembers === null ? 'workspace' : 'private',
            folder: privateMembers === null ? 'General' : 'Direct messages',
          }));
      }
      if (q.startsWith('select session_id, user_id from chat_session_members')) {
        return pgArrayValues(params[0]).flatMap(session_id =>
          [...(privateMembers || [])].map(user_id => ({ session_id, user_id })));
      }
      if (q.startsWith('select id from app_users where id = any')) {
        const ids = String(params[0]).match(/"([^"]+)"/g)?.map(value => value.slice(1, -1)) || [];
        return ids.filter(id => !optedOutUsers.has(id)).map(id => ({ id }));
      }
      return [];
    },
  });
});
test.afterEach(() => __test.resetTestState());
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function fakeClient(userId, subscriptions) {
  const sent = [];
  return {
    userId,
    readyState: 1,
    subscriptions,
    sent,
    send: str => sent.push(JSON.parse(str)),
  };
}

function receiptSub(sessionId) {
  return {
    channel: `session_read_state:${sessionId}`,
    type: 'db_changes',
    table: 'session_read_state',
    filter: `session_id=eq.${sessionId}`,
  };
}

function marker(sessionId, userId, {
  markerId = `marker-${sessionId}-${userId}`,
  eventVersion = '1',
  threadParentId = null,
  lastSeenMessageId = `message-${sessionId}`,
  readAt = '2026-07-01T00:00:00.000Z',
} = {}) {
  return {
    marker_id: markerId,
    event_version: eventVersion,
    session_id: sessionId,
    user_id: userId,
    agent_id: null,
    thread_parent_id: threadParentId,
    last_seen_message_id: lastSeenMessageId,
    read_at: readAt,
  };
}

const framesFor = (ws, table) => ws.sent.filter(m => m.type === 'db_changes' && m.table === table);

test('a receipt reaches the socket that named its session, and only that one', async () => {
  const inSession = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  const elsewhere = __test.registerTestWebsocketClient(fakeClient('u2', [receiptSub(SESSION_B)]));

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u1')]);
  await settle();

  assert.equal(framesFor(inSession, 'session_read_state').length, 1, 'the subscriber to this session gets it');
  assert.deepEqual(framesFor(elsewhere, 'session_read_state'), [], 'a subscriber to another session gets NOTHING');

  const [frame] = framesFor(inSession, 'session_read_state');
  assert.equal(frame.payload.eventType, 'INSERT');
  assert.deepEqual(frame.payload.new, marker(SESSION_A, 'u1'));
});

test('a subscription to a DIFFERENT table never receives a receipt', async () => {
  const other = __test.registerTestWebsocketClient(fakeClient('u2', [{
    channel: `messages:${SESSION_A}`,
    type: 'db_changes',
    table: 'messages',
    filter: `session_id=eq.${SESSION_A}`,
  }]));

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u1')]);
  await settle();
  assert.deepEqual(other.sent, [], 'same session, wrong table');
});

test('a workspace-shaped filter matches no receipt row, so it cannot be used to widen the audience', async () => {
  // The one uncertainty in the design that had to be executed rather than
  // reasoned about. A caller could try `workspace_id=eq.<ws>` as a filter:
  // resolveOperationWorkspace WOULD accept it (it reads the filter, not the
  // schema), so the subscription can authorize — but the row has no such field,
  // and matchesFilter compares `String(row[column] ?? '')` against the value.
  // Missing field means '' !== 'w1', so it fails CLOSED.
  //
  // If that ever changed to a permissive default, this socket would receive
  // every receipt in the workspace INCLUDING DMs it is not in. That is the whole
  // reason the assertion is here rather than in a comment.
  const workspaceWide = __test.registerTestWebsocketClient(fakeClient('u3', [{
    channel: `session_read_state:${WORKSPACE}`,
    type: 'db_changes',
    table: 'session_read_state',
    filter: `workspace_id=eq.${WORKSPACE}`,
  }]));

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u1')]);
  await settle();
  assert.deepEqual(workspaceWide.sent, [], 'a filter on a column the row does not have matches nothing');
});

test('a receipt row carries marker identity, generation, exact scope, and no second clock', async () => {
  // The exact message id is needed to order equal-time messages and the marker id
  // plus generation lets consumers reject stale delivery. `updated_at` remains an
  // operational second clock and must not ride the wire.
  const socket = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u1')]);
  await settle();

  const [frame] = framesFor(socket, 'session_read_state');
  assert.deepEqual(Object.keys(frame.payload.new).sort(), [
    'agent_id', 'event_version', 'last_seen_message_id', 'marker_id', 'read_at',
    'session_id', 'thread_parent_id', 'user_id',
  ]);
  assert.equal('updated_at' in frame.payload.new, false);
});

test('successive generations preserve one marker identity and advance the exact message', async () => {
  const socket = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  const first = marker(SESSION_A, 'u2', {
    markerId: 'stable-marker',
    eventVersion: '41',
    lastSeenMessageId: 'message-1',
  });
  const second = marker(SESSION_A, 'u2', {
    markerId: 'stable-marker',
    eventVersion: '42',
    lastSeenMessageId: 'message-2',
  });

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [first, second]);
  await settle();

  const delivered = framesFor(socket, 'session_read_state').map(frame => frame.payload.new);
  assert.deepEqual(delivered.map(row => row.marker_id), ['stable-marker', 'stable-marker']);
  assert.deepEqual(delivered.map(row => row.event_version), ['41', '42']);
  assert.deepEqual(delivered.map(row => row.last_seen_message_id), ['message-1', 'message-2']);
});

test('a reaction still rides the messages lane, session-filtered', async () => {
  // Reactions did not move lanes and must not: `messages` is already
  // session-scoped and an UNFILTERED messages subscription cannot be established
  // at all, so the audience is correct by construction. The alternative someone
  // will re-propose — a lean workspace-wide `reactions:<workspaceId>` broadcast
  // — would fan DM reaction activity to every member and ride a path with no
  // rate limiter. This asserts the lane, so that proposal has to delete a test.
  const inSession = __test.registerTestWebsocketClient(fakeClient('u1', [{
    channel: `messages:${SESSION_A}`,
    type: 'db_changes',
    table: 'messages',
    filter: `session_id=eq.${SESSION_A}`,
  }]));
  const elsewhere = __test.registerTestWebsocketClient(fakeClient('u2', [{
    channel: `messages:${SESSION_B}`,
    type: 'db_changes',
    table: 'messages',
    filter: `session_id=eq.${SESSION_B}`,
  }]));

  __test.notifyDbSubscribers('messages', 'UPDATE', [
    { id: 'm1', session_id: SESSION_A, reactions: { '✅': ['u1'] }, sender_kind: 'human' },
  ]);
  await settle();

  assert.equal(framesFor(inSession, 'messages').length, 1);
  assert.deepEqual(framesFor(elsewhere, 'messages'), []);
});

test('two sessions changing at once do not cross over', async () => {
  // A single notify carrying rows for more than one session is the shape where a
  // loop that hoisted the filter check out would leak, and it would look correct
  // in every single-row test above.
  const a = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  const b = __test.registerTestWebsocketClient(fakeClient('u2', [receiptSub(SESSION_B)]));

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [
    marker(SESSION_A, 'u1'),
    marker(SESSION_B, 'u2'),
  ]);
  await settle();

  assert.deepEqual(
    framesFor(a, 'session_read_state').map(f => f.payload.new.session_id),
    [SESSION_A],
  );
  assert.deepEqual(
    framesFor(b, 'session_read_state').map(f => f.payload.new.session_id),
    [SESSION_B],
  );
});

test('a receipt binding made while public does not survive a private transition', async () => {
  const member = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  const outsider = __test.registerTestWebsocketClient(fakeClient('u2', [receiptSub(SESSION_A)]));
  privateMembers = new Set(['u1']);

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u1')]);
  await settle();

  assert.equal(framesFor(member, 'session_read_state').length, 1);
  assert.equal(framesFor(outsider, 'session_read_state').length, 0);
});

test('an existing receipt binding stops receiving immediately after opt-out', async () => {
  const socket = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  optedOutUsers.add('u1');

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u2')]);
  await settle();

  assert.deepEqual(framesFor(socket, 'session_read_state'), []);
});

test('receipt DELETE frames carry the removed marker in old', async () => {
  const socket = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  const removed = marker(SESSION_A, 'u2');

  __test.notifyDbSubscribers('session_read_state', 'DELETE', [removed]);
  await settle();

  const [frame] = framesFor(socket, 'session_read_state');
  assert.equal(frame.payload.eventType, 'DELETE');
  assert.deepEqual(frame.payload.new, {});
  assert.deepEqual(frame.payload.old, removed);
});

test('receipt subscription authorization requires both a session filter and current opt-in', async () => {
  let optedIn = false;
  const forbidden = (message) => Object.assign(new Error(message), { status: 403 });
  const realtime = createRealtime({
    ensureTable() {},
    async enforceDbOperationAccess() {},
    async readReceiptOptedInUserIds(ids) {
      return optedIn ? new Set(ids.map(String)) : new Set();
    },
    forbidden,
  });
  const binding = receiptSub(SESSION_A);

  await assert.rejects(
    () => realtime.authorizeRealtimeBinding('u1', binding.channel, binding),
    { status: 403, message: 'Read receipts are disabled' },
  );

  optedIn = true;
  await realtime.authorizeRealtimeBinding('u1', binding.channel, binding);

  const socket = realtime.registerTestWebsocketClient(fakeClient('u1', [binding]));
  optedIn = false;
  await realtime.revokeRealtimeAccessForMember('u1');
  assert.deepEqual(socket.subscriptions, []);
  assert.deepEqual(socket.sent, [{
    type: 'system',
    event: 'unsubscribed',
    channel: binding.channel,
    reason: 'access_revoked',
  }]);

  optedIn = true;
  await assert.rejects(
    () => realtime.authorizeRealtimeBinding('u1', 'session_read_state:all', {
      ...binding,
      filter: 'workspace_id=eq.w1',
    }),
    { status: 403, message: 'Read receipt subscriptions require a session filter' },
  );
});

test('the default receipt opt-in resolver fails closed at bind and delivery time', async () => {
  const forbidden = message => Object.assign(new Error(message), { status: 403 });
  const realtime = createRealtime({
    ensureTable() {},
    async enforceDbOperationAccess() {},
    async enqueueFlowWebhookEvents() { return []; },
    async enqueueAutomationRuns() { return []; },
    async sessionRealtimeAudiences(ids) {
      return new Map(ids.map(id => [String(id), { memberUserIds: null }]));
    },
    forbidden,
  });
  const binding = receiptSub(SESSION_A);

  await assert.rejects(
    () => realtime.authorizeRealtimeBinding('u1', binding.channel, binding),
    { status: 403, message: 'Read receipts are disabled' },
  );

  const socket = realtime.registerTestWebsocketClient(fakeClient('u1', [binding]));
  realtime.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u2')]);
  await settle();
  assert.deepEqual(socket.sent, [], 'an injected audience cannot make the default opt-in guess true');
});

test('receipt fanout resolves only candidate sessions and batches audience plus opt-in lookups', async () => {
  const audienceCalls = [];
  const optInCalls = [];
  const realtime = createRealtime({
    async enqueueFlowWebhookEvents() { return []; },
    async enqueueAutomationRuns() { return []; },
    async sessionRealtimeAudiences(ids) {
      audienceCalls.push([...ids]);
      return new Map([
        [SESSION_A, { memberUserIds: null }],
        [SESSION_B, { memberUserIds: new Set(['u2']) }],
      ]);
    },
    async readReceiptOptedInUserIds(ids) {
      optInCalls.push([...ids]);
      return new Set(ids.map(String));
    },
  });
  const a = realtime.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  const b = realtime.registerTestWebsocketClient(fakeClient('u2', [receiptSub(SESSION_B)]));
  const noMatchingRow = realtime.registerTestWebsocketClient(fakeClient('u3', [receiptSub('chan-c')]));

  realtime.notifyDbSubscribers('session_read_state', 'INSERT', [
    marker(SESSION_A, 'reader-a'),
    marker(SESSION_B, 'reader-b'),
  ]);
  await settle();

  assert.deepEqual(audienceCalls, [[SESSION_A, SESSION_B]], 'one audience batch, only for sessions with rows and subscribers');
  assert.deepEqual(optInCalls, [['u1', 'u2']], 'recipient privacy is resolved once for the candidate socket set');
  assert.deepEqual(framesFor(a, 'session_read_state').map(frame => frame.payload.new.session_id), [SESSION_A]);
  assert.deepEqual(framesFor(b, 'session_read_state').map(frame => frame.payload.new.session_id), [SESSION_B]);
  assert.deepEqual(noMatchingRow.sent, []);
});

test('account opt-out invalidates a live device even when it has no receipt subscription', async () => {
  const realtime = createRealtime({
    ensureTable() {},
    async enforceDbOperationAccess() {},
    async readReceiptOptedInUserIds() { return new Set(); },
    forbidden(message) { return Object.assign(new Error(message), { status: 403 }); },
  });
  const socket = realtime.registerTestWebsocketClient(fakeClient('u1', []));

  await realtime.revokeRealtimeAccessForMember('u1', {
    reason: 'read_receipts_disabled',
  });

  assert.deepEqual(socket.sent, [
    {
      type: 'system',
      event: 'unsubscribed',
      channel: 'session_read_state:*',
      reason: 'read_receipts_disabled',
    },
    {
      type: 'system',
      event: 'read_receipts_preference',
      userId: 'u1',
      enabled: false,
    },
  ]);
});
