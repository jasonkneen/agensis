'use strict';

// ============================================================================
// tests/agentStatusBroadcast.test.cjs
// ----------------------------------------------------------------------------
// NET-07 — the sidebar agent-status feed is driven by a lean `agent-status`
// BROADCAST instead of a workspace-wide `messages` db_changes firehose.
//
// WHY THIS FILE WAS REWRITTEN (F3)
//
// The previous version passed while the feature was completely dead. Its
// fixtures hand-built message rows carrying `workspace_id` (and `metadata`),
// and `messages` has NEITHER column — verified against the live database, not
// just the DDL. The emitter's guard was `!row.workspace_id`, so on every real
// row it short-circuited and the broadcast never fired. The test asserted a row
// shape no caller produces, which is the textbook vacuous mock: it restated the
// guard instead of exercising the caller.
//
// So the rule here is that fixtures may only carry REAL message columns. That
// is enforced mechanically by `messageRow()` below, not by reviewer attention:
// adding `workspace_id` to a fixture now throws.
//
// The workspace is resolved from the row's session through the injected
// resolveWorkspaceIdForSession, driven here by a fake db so the REAL resolver
// (and its real LRU) runs, rather than a stub that would just restate it.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

/**
 * Every column `messages` actually has, read off the live database. If you are
 * here because a fixture threw, the fix is to stop using that field — not to
 * add it to this list. Adding a name the table does not have is precisely the
 * bug this file exists to stop coming back.
 */
const MESSAGE_COLUMNS = new Set([
 'id', 'session_id', 'role', 'content', 'created_at', 'thread_parent_id',
 'sender_kind', 'sender_id', 'sender_name', 'pinned', 'deleted_at', 'reactions',
 'source_task_id', 'message_kind', 'tool_name', 'tool_detail',
 'broadcast_to_channel', 'huddle_id', 'attachments', 'permission_request_id',
]);

function messageRow(fields) {
 for (const key of Object.keys(fields)) {
  assert.ok(
   MESSAGE_COLUMNS.has(key),
   `messages has no column "${key}" — a fixture inventing one is how this feature stayed dead`,
  );
 }
 return fields;
}

function fakeClient(subscriptions) {
 const sent = [];
 return { userId: 'user-1', readyState: 1, subscriptions, sent, send: (str) => sent.push(JSON.parse(str)) };
}

/**
 * Fake db backing the REAL resolveWorkspaceIdForSession. Counts lookups so the
 * "one per session per batch" claim is measured rather than asserted.
 */
function sessionDb(sessionToWorkspace, { fail = false } = {}) {
 const lookups = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('select workspace_id from chat_sessions')) {
    lookups.push(params[0]);
    if (fail) throw new Error('chat_sessions lookup exploded');
    const ws = sessionToWorkspace[params[0]];
    return ws ? [{ workspace_id: ws }] : [];
   }
   return [];
  },
 });
 return lookups;
}

/** The emitter is fire-and-forget, so let its microtasks and the db settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('agent-status channel resolves to its workspace id', () => {
 assert.equal(__test.workspaceIdFromRealtimeChannel('agent-status:ws-1'), 'ws-1');
 // A trailing segment (would be a table-style channel) is rejected.
 assert.equal(__test.workspaceIdFromRealtimeChannel('agent-status:ws-1:extra'), null);
 // An unknown prefix is still rejected.
 assert.equal(__test.workspaceIdFromRealtimeChannel('bogus:ws-1'), null);
});

// THE TEST THAT WOULD HAVE CAUGHT F3. Restore the `!row.workspace_id` guard —
// the behaviour that actually shipped — and this must go red.
test('a row with only REAL message columns still broadcasts', async () => {
 const lookups = sessionDb({ 'sess-a': 'ws-1' });
 const client = __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ]));

 __test.notifyDbSubscribers('messages', 'INSERT', [messageRow({
  id: 'msg-1',
  session_id: 'sess-a',
  role: 'assistant',
  sender_kind: 'agent',
  sender_id: 'agent-1',
  sender_name: 'Coder',
  content: 'Reading src/App.tsx',
 })]);
 await settle();

 const frame = client.sent.find((m) => m.type === 'broadcast' && m.channel === 'agent-status:ws-1');
 assert.ok(frame, 'expected an agent_status broadcast frame');
 assert.equal(frame.event, 'agent_status');
 assert.deepEqual(Object.keys(frame.payload).sort(), ['agentId', 'content', 'eventType', 'id', 'senderName']);
 assert.equal(frame.payload.agentId, 'agent-1');
 assert.equal(frame.payload.content, 'Reading src/App.tsx');
 assert.equal(frame.payload.senderName, 'Coder');
 assert.equal(frame.payload.id, 'msg-1');
 // The row itself carries no workspace, so the ONLY way this frame exists is
 // the session lookup. (INSERT also drives logMessageActivity, which resolves
 // the same session through the same query, so this counts membership rather
 // than an exact call count — the exact count is measured on UPDATE below,
 // where the emitter is the sole caller.)
 assert.ok(lookups.includes('sess-a'), 'the workspace came from the row session, not the row');
});

test('the payload stays lean — a heavy column never rides along', async () => {
 sessionDb({ 'sess-lean': 'ws-1' });
 const client = __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ]));

 __test.notifyDbSubscribers('messages', 'INSERT', [messageRow({
  id: 'msg-lean',
  session_id: 'sess-lean',
  sender_kind: 'agent',
  sender_id: 'agent-1',
  sender_name: 'Coder',
  content: 'hi',
  // Real, genuinely heavy columns — the whole reason this broadcast exists
  // instead of a db_changes firehose.
  attachments: [{ blob: 'x'.repeat(1000) }],
  reactions: { '+1': ['user-1'] },
 })]);
 await settle();

 const frame = client.sent.find((m) => m.type === 'broadcast');
 assert.ok(frame);
 assert.equal(frame.payload.attachments, undefined);
 assert.equal(frame.payload.reactions, undefined);
});

// Measured on UPDATE deliberately: logMessageActivity is INSERT-only and
// resolves the same session through the same query, so UPDATE is the one path
// where emitAgentStatus is the sole caller and the count means what it says.
test('one workspace lookup per SESSION per batch, not per row', async () => {
 const lookups = sessionDb({ 'sess-b': 'ws-1', 'sess-c': 'ws-1' });
 const client = __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ]));

 __test.notifyDbSubscribers('messages', 'UPDATE', [
  messageRow({ id: 'm1', session_id: 'sess-b', sender_kind: 'agent', sender_id: 'a1', content: 'one' }),
  messageRow({ id: 'm2', session_id: 'sess-b', sender_kind: 'agent', sender_id: 'a1', content: 'two' }),
  messageRow({ id: 'm3', session_id: 'sess-b', sender_kind: 'agent', sender_id: 'a1', content: 'three' }),
  messageRow({ id: 'm4', session_id: 'sess-c', sender_kind: 'agent', sender_id: 'a1', content: 'four' }),
 ]);
 await settle();

 assert.deepEqual(lookups.sort(), ['sess-b', 'sess-c'], 'three rows on one session cost one lookup');
 assert.equal(client.sent.filter((m) => m.type === 'broadcast').length, 4, 'every row still broadcasts');
});

test('the de-duplication is real, not just the resolver cache masking it', async () => {
 // The previous test cannot actually distinguish per-row from per-session
 // resolution: resolveWorkspaceIdForSession memoises SUCCESSES, so rows 2 and 3
 // would hit the LRU and never reach the db either way. An UNRESOLVABLE session
 // is never cached, so it is the one case where the difference is observable —
 // per-row would issue three lookups here, per-session issues one.
 const lookups = sessionDb({}); // nothing resolves
 __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ]));

 __test.notifyDbSubscribers('messages', 'UPDATE', [
  messageRow({ id: 'n1', session_id: 'sess-miss', sender_kind: 'agent', sender_id: 'a1', content: 'one' }),
  messageRow({ id: 'n2', session_id: 'sess-miss', sender_kind: 'agent', sender_id: 'a1', content: 'two' }),
  messageRow({ id: 'n3', session_id: 'sess-miss', sender_kind: 'agent', sender_id: 'a1', content: 'three' }),
 ]);
 await settle();

 assert.deepEqual(lookups, ['sess-miss'], 'an uncacheable session must still be resolved once, not once per row');
});

test('a human (non-agent) message row does NOT broadcast, and costs no lookup', async () => {
 const lookups = sessionDb({ 'sess-d': 'ws-1' });
 const client = __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ]));

 // UPDATE for the same reason as the batch test above: it isolates the emitter.
 __test.notifyDbSubscribers('messages', 'UPDATE', [messageRow({
  id: 'msg-2', session_id: 'sess-d', role: 'user', sender_kind: 'user', sender_id: 'user-1', content: 'hello',
 })]);
 await settle();

 assert.equal(client.sent.some((m) => m.type === 'broadcast'), false);
 assert.deepEqual(lookups, [], 'a non-agent row must not even reach the resolver');
});

test('an UPDATE to an agent row also broadcasts (activity refinement)', async () => {
 sessionDb({ 'sess-e': 'ws-1' });
 const client = __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ]));

 __test.notifyDbSubscribers('messages', 'UPDATE', [messageRow({
  id: 'msg-3', session_id: 'sess-e', sender_kind: 'agent', sender_id: 'agent-1', sender_name: 'Coder', content: 'Done.',
 })]);
 await settle();

 const frame = client.sent.find((m) => m.type === 'broadcast');
 assert.ok(frame);
 assert.equal(frame.payload.eventType, 'UPDATE');
 assert.equal(frame.payload.content, 'Done.');
});

test('a client subscribed to a DIFFERENT workspace gets nothing', async () => {
 sessionDb({ 'sess-f': 'ws-1' });
 const client = __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-2', event: 'agent_status' },
 ]));

 __test.notifyDbSubscribers('messages', 'INSERT', [messageRow({
  id: 'msg-4', session_id: 'sess-f', sender_kind: 'agent', sender_id: 'agent-1', sender_name: 'Coder', content: 'hi',
 })]);
 await settle();

 assert.equal(client.sent.some((m) => m.type === 'broadcast'), false);
});

test('an unresolvable session broadcasts nothing rather than guessing', async () => {
 sessionDb({}); // no mapping at all
 const client = __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ]));

 __test.notifyDbSubscribers('messages', 'INSERT', [messageRow({
  id: 'msg-5', session_id: 'sess-unknown', sender_kind: 'agent', sender_id: 'agent-1', content: 'hi',
 })]);
 await settle();

 assert.equal(client.sent.some((m) => m.type === 'broadcast'), false);
});

// The reachable failure mode: the DB query throws, resolveWorkspaceIdForSession
// catches it and returns null, and the emitter broadcasts nothing. What matters
// is that the ORDINARY fanout on the same batch is untouched — the agent-status
// emitter is a side effect, not a gate.
test('a resolver failure does not break the rest of the fanout', async () => {
 sessionDb({ 'sess-g': 'ws-1' }, { fail: true });
 // A plain db_changes subscriber on the same batch must still get its row: the
 // agent-status emitter is a side effect, not a gate.
 const client = __test.registerTestWebsocketClient(fakeClient([
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
  { type: 'db_changes', table: 'messages', filter: 'session_id=eq.sess-g' },
 ]));

 assert.doesNotThrow(() => {
  __test.notifyDbSubscribers('messages', 'INSERT', [messageRow({
   id: 'msg-6', session_id: 'sess-g', sender_kind: 'agent', sender_id: 'agent-1', content: 'hi',
  })]);
 });
 await settle();

 assert.equal(client.sent.some((m) => m.type === 'broadcast'), false, 'no workspace, no broadcast');
 assert.ok(
  client.sent.some((m) => m.table === 'messages' || m.type === 'db_changes'),
  'the ordinary db_changes fanout is unaffected by the failed lookup',
 );
});

// Closes the loop from the other direction: F3 is only un-reintroducible if
// `messages` genuinely never grows a workspace_id. If someone adds one, this
// goes red and they decide deliberately rather than by accident.
test('messages has no workspace_id column in any schema place', () => {
 const fs = require('node:fs');
 const path = require('node:path');
 const schema = fs.readFileSync(path.resolve(__dirname, '../database/neon-schema.sql'), 'utf8');

 const create = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS messages'));
 const body = create.slice(0, create.indexOf(');'));
 assert.ok(!/workspace_id/.test(body), 'messages must reach its tenant only through session_id');

 const alters = schema.split('\n').filter((line) => /^ALTER TABLE messages ADD COLUMN/.test(line));
 assert.ok(alters.length > 0, 'the ALTER block moved; this guard is now blind');
 for (const line of alters) {
  assert.ok(!/workspace_id/.test(line), `a workspace_id was added to messages: ${line}`);
 }
});
