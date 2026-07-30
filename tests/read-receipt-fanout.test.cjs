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
// server/realtime.cjs applies its private-session filter ONLY when
// `table === 'chat_sessions'`; every other table fans out to whatever sockets
// hold a matching subscription. That is a live, known property of the fanout and
// this feature must not widen it.
//
// It does not, and the reason is structural rather than a second filter:
// `session_read_state` has NO workspace_id column, so a subscription cannot be
// expressed except by naming a session — and naming a private session has to
// clear enforceSessionReadAccess at SUBSCRIBE time
// (authorizeRealtimeBinding -> enforceDbOperationAccess with op 'select'). A
// non-member therefore never holds a subscription for the row to match against.
// That refusal is pinned in tests/session-read-state.test.cjs; this file pins
// the other half — that a socket which DID name a different session gets
// nothing, and that a workspace-shaped filter matches no receipt row at all.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const SESSION_A = 'chan-a';
const SESSION_B = 'chan-b';
const WORKSPACE = 'w1';

test.afterEach(() => __test.resetTestState());

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

function marker(sessionId, userId) {
  return { session_id: sessionId, user_id: userId, read_at: '2026-07-01T00:00:00.000Z' };
}

const framesFor = (ws, table) => ws.sent.filter(m => m.type === 'db_changes' && m.table === table);

test('a receipt reaches the socket that named its session, and only that one', () => {
  const inSession = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  const elsewhere = __test.registerTestWebsocketClient(fakeClient('u2', [receiptSub(SESSION_B)]));

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u1')]);

  assert.equal(framesFor(inSession, 'session_read_state').length, 1, 'the subscriber to this session gets it');
  assert.deepEqual(framesFor(elsewhere, 'session_read_state'), [], 'a subscriber to another session gets NOTHING');

  const [frame] = framesFor(inSession, 'session_read_state');
  assert.equal(frame.payload.eventType, 'INSERT');
  assert.deepEqual(frame.payload.new, marker(SESSION_A, 'u1'));
});

test('a subscription to a DIFFERENT table never receives a receipt', () => {
  const other = __test.registerTestWebsocketClient(fakeClient('u2', [{
    channel: `messages:${SESSION_A}`,
    type: 'db_changes',
    table: 'messages',
    filter: `session_id=eq.${SESSION_A}`,
  }]));

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u1')]);
  assert.deepEqual(other.sent, [], 'same session, wrong table');
});

test('a workspace-shaped filter matches no receipt row, so it cannot be used to widen the audience', () => {
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
  assert.deepEqual(workspaceWide.sent, [], 'a filter on a column the row does not have matches nothing');
});

test('a receipt row carries no message content and no second clock', () => {
  // What the wire may say about a person: which conversation, who, how far. Not
  // WHICH message (the high-water mark never records that) and not `updated_at`,
  // which records when the marker last moved and is a finer clock than the
  // disclosure this feature makes.
  const socket = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  __test.notifyDbSubscribers('session_read_state', 'INSERT', [marker(SESSION_A, 'u1')]);

  const [frame] = framesFor(socket, 'session_read_state');
  assert.deepEqual(Object.keys(frame.payload.new).sort(), ['read_at', 'session_id', 'user_id']);
});

test('a reaction still rides the messages lane, session-filtered', () => {
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

  assert.equal(framesFor(inSession, 'messages').length, 1);
  assert.deepEqual(framesFor(elsewhere, 'messages'), []);
});

test('two sessions changing at once do not cross over', () => {
  // A single notify carrying rows for more than one session is the shape where a
  // loop that hoisted the filter check out would leak, and it would look correct
  // in every single-row test above.
  const a = __test.registerTestWebsocketClient(fakeClient('u1', [receiptSub(SESSION_A)]));
  const b = __test.registerTestWebsocketClient(fakeClient('u2', [receiptSub(SESSION_B)]));

  __test.notifyDbSubscribers('session_read_state', 'INSERT', [
    marker(SESSION_A, 'u1'),
    marker(SESSION_B, 'u2'),
  ]);

  assert.deepEqual(
    framesFor(a, 'session_read_state').map(f => f.payload.new.session_id),
    [SESSION_A],
  );
  assert.deepEqual(
    framesFor(b, 'session_read_state').map(f => f.payload.new.session_id),
    [SESSION_B],
  );
});
