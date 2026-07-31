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
// resolveSessionActivityContext, driven here by a fake db so the REAL resolver
// and canonical privacy helper run, rather than a stub that would restate them.
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

function fakeClient(subscriptions, userId = 'user-1') {
 const sent = [];
 return { userId, readyState: 1, subscriptions, sent, send: (str) => sent.push(JSON.parse(str)) };
}

/**
 * Fake db backing the REAL resolveSessionActivityContext. Counts lookups so the
 * "one per session per batch" claim is measured rather than asserted.
 */
function sessionDb(sessionToWorkspace, { fail = false, failMembers = false } = {}) {
 const lookups = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   // The session lookup also selects `visibility`/`folder` now: activity rows
   // have to know at WRITE time whether they came out of a members-only
   // conversation, because nothing downstream of activity_events can re-derive
   // it. Matched loosely on the leading column so this mock does not have to
   // track the exact projection.
   if (n.startsWith('select workspace_id') && n.includes('from chat_sessions')) {
    lookups.push(params[0]);
    if (fail) throw new Error('chat_sessions lookup exploded');
    const context = sessionToWorkspace[params[0]];
    if (!context) return [];
    if (typeof context === 'string') {
     return [{ workspace_id: context, visibility: 'workspace', folder: 'Channels' }];
    }
    return [{
     workspace_id: context.workspaceId,
     visibility: context.visibility ?? 'workspace',
     folder: context.folder ?? 'Channels',
    }];
   }
   if (n.startsWith('select user_id from chat_session_members')) {
    if (failMembers) throw new Error('chat_session_members lookup exploded');
    const context = sessionToWorkspace[params[0]];
    const members = context && typeof context === 'object' && Array.isArray(context.members)
     ? context.members
     : [];
    return members.map((userId) => ({ user_id: userId }));
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

test('a private-session status reaches members only, never another workspace reader', async () => {
 sessionDb({
  'sess-private': {
   workspaceId: 'ws-1',
   visibility: 'private',
   folder: 'Direct messages',
   members: ['member-1'],
  },
 });
 const subscription = [
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ];
 const member = __test.registerTestWebsocketClient(fakeClient(subscription, 'member-1'));
 const outsider = __test.registerTestWebsocketClient(fakeClient(subscription, 'workspace-reader'));

 __test.notifyDbSubscribers('messages', 'UPDATE', [messageRow({
  id: 'msg-private',
  session_id: 'sess-private',
  sender_kind: 'agent',
  sender_id: 'agent-1',
  sender_name: 'Coder',
  content: 'Reading a private file',
 })]);
 await settle();

 const memberFrame = member.sent.find((message) => message.type === 'broadcast');
 assert.ok(memberFrame, 'a private-session member still receives agent status');
 assert.equal(memberFrame.payload.content, 'Reading a private file');
 assert.equal(
  outsider.sent.length,
  0,
  'a workspace reader outside the private session receives no frame or session metadata',
 );
});

test('a private-session status fails closed when membership cannot be resolved', async () => {
 sessionDb({
  'sess-private-db-failure': {
   workspaceId: 'ws-1',
   visibility: 'private',
   members: ['member-1'],
  },
 }, { failMembers: true });
 const subscription = [
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ];
 const member = __test.registerTestWebsocketClient(fakeClient(subscription, 'member-1'));
 const outsider = __test.registerTestWebsocketClient(fakeClient(subscription, 'workspace-reader'));

 __test.notifyDbSubscribers('messages', 'UPDATE', [messageRow({
  id: 'msg-private-db-failure',
  session_id: 'sess-private-db-failure',
  sender_kind: 'agent',
  sender_id: 'agent-1',
  content: 'Never guess who may read this',
 })]);
 await settle();

 assert.equal(member.sent.length, 0, 'a missed update is safer than guessing membership');
 assert.equal(outsider.sent.length, 0, 'membership failure cannot fall back to workspace fanout');
});

test('a cross-process visibility change cannot reuse a public session classification', async () => {
 const context = {
  workspaceId: 'ws-1',
  visibility: 'workspace',
  folder: 'Channels',
  members: ['member-1'],
 };
 sessionDb({ 'sess-visibility-change': context });
 const subscription = [
  { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
 ];
 const member = __test.registerTestWebsocketClient(fakeClient(subscription, 'member-1'));
 const outsider = __test.registerTestWebsocketClient(fakeClient(subscription, 'workspace-reader'));

 __test.notifyDbSubscribers('messages', 'UPDATE', [messageRow({
  id: 'msg-before-private',
  session_id: 'sess-visibility-change',
  sender_kind: 'agent',
  sender_id: 'agent-1',
  content: 'Visible while this is a channel',
 })]);
 await settle();
 assert.equal(outsider.sent.length, 1, 'workspace-visible behavior is unchanged');

 member.sent.length = 0;
 outsider.sent.length = 0;
 context.visibility = 'private';
 context.folder = 'Direct messages';
 // Deliberately no local chat_sessions notification: the Netlify mirror can
 // update the shared database without sending a frame through this Fly process.
 __test.notifyDbSubscribers('messages', 'UPDATE', [messageRow({
  id: 'msg-after-private',
  session_id: 'sess-visibility-change',
  sender_kind: 'agent',
  sender_id: 'agent-1',
  content: 'Private after the visibility change',
 })]);
 await settle();

 assert.equal(member.sent.filter((message) => message.type === 'broadcast').length, 1);
 assert.equal(outsider.sent.length, 0, 'agent status bypasses the stale public cache');
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

test('an unresolvable session is also looked up once per batch', async () => {
 // A failed/missing context must not cause one retry per row. The batch resolves
 // each distinct session once, then withholds every row it could not place.
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

 assert.deepEqual(lookups, ['sess-miss'], 'a missing session must still be resolved once, not once per row');
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

// The reachable failure mode: the DB query throws, resolveSessionActivityContext
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
