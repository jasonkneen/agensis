'use strict';

// NET-07 — the sidebar agent-status feed is driven by a lean `agent-status`
// BROADCAST instead of a workspace-wide `messages` db_changes firehose. Verifies:
//   (1) the channel prefix is authorized (workspaceIdFromRealtimeChannel), and
//   (2) an agent-authored message INSERT/UPDATE delivers ONLY the lean payload
//       to a client subscribed to the broadcast — and a NON-agent row does not.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

test('agent-status channel resolves to its workspace id', () => {
  assert.equal(__test.workspaceIdFromRealtimeChannel('agent-status:ws-1'), 'ws-1');
  // A trailing segment (would be a table-style channel) is rejected.
  assert.equal(__test.workspaceIdFromRealtimeChannel('agent-status:ws-1:extra'), null);
  // An unknown prefix is still rejected.
  assert.equal(__test.workspaceIdFromRealtimeChannel('bogus:ws-1'), null);
});

function fakeClient(subscriptions) {
  const sent = [];
  return { userId: 'user-1', readyState: 1, subscriptions, sent, send: (str) => sent.push(JSON.parse(str)) };
}

test('an agent message row broadcasts a lean agent_status payload to subscribers', () => {
  const client = __test.registerTestWebsocketClient(fakeClient([
    { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
  ]));

  __test.notifyDbSubscribers('messages', 'INSERT', [{
    id: 'msg-1',
    workspace_id: 'ws-1',
    sender_kind: 'agent',
    sender_id: 'agent-1',
    sender_name: 'Coder',
    content: 'Reading src/App.tsx',
    // Deliberately include a heavy field the lean payload must NOT carry through.
    metadata: { huge: 'x'.repeat(1000) },
  }]);

  const frame = client.sent.find(m => m.type === 'broadcast' && m.channel === 'agent-status:ws-1');
  assert.ok(frame, 'expected an agent_status broadcast frame');
  assert.equal(frame.event, 'agent_status');
  assert.deepEqual(Object.keys(frame.payload).sort(), ['agentId', 'content', 'eventType', 'id', 'senderName']);
  assert.equal(frame.payload.agentId, 'agent-1');
  assert.equal(frame.payload.content, 'Reading src/App.tsx');
  assert.equal(frame.payload.senderName, 'Coder');
  assert.equal(frame.payload.id, 'msg-1');
  // The lean payload must not leak the heavy message fields.
  assert.equal(frame.payload.metadata, undefined);
});

test('a human (non-agent) message row does NOT broadcast agent_status', () => {
  const client = __test.registerTestWebsocketClient(fakeClient([
    { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
  ]));

  __test.notifyDbSubscribers('messages', 'INSERT', [{
    id: 'msg-2',
    workspace_id: 'ws-1',
    sender_kind: 'user',
    sender_id: 'user-1',
    content: 'hello',
  }]);

  assert.equal(client.sent.some(m => m.type === 'broadcast' && m.channel === 'agent-status:ws-1'), false);
});

test('an UPDATE to an agent row also broadcasts (activity refinement)', () => {
  const client = __test.registerTestWebsocketClient(fakeClient([
    { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
  ]));

  __test.notifyDbSubscribers('messages', 'UPDATE', [{
    id: 'msg-3', workspace_id: 'ws-1', sender_kind: 'agent', sender_id: 'agent-1', sender_name: 'Coder', content: 'Done.',
  }]);

  const frame = client.sent.find(m => m.type === 'broadcast' && m.channel === 'agent-status:ws-1');
  assert.ok(frame);
  assert.equal(frame.payload.eventType, 'UPDATE');
  assert.equal(frame.payload.content, 'Done.');
});

test('a client subscribed to a DIFFERENT workspace gets nothing', () => {
  const client = __test.registerTestWebsocketClient(fakeClient([
    { type: 'broadcast', channel: 'agent-status:ws-2', event: 'agent_status' },
  ]));

  __test.notifyDbSubscribers('messages', 'INSERT', [{
    id: 'msg-4', workspace_id: 'ws-1', sender_kind: 'agent', sender_id: 'agent-1', sender_name: 'Coder', content: 'hi',
  }]);

  assert.equal(client.sent.some(m => m.type === 'broadcast'), false);
});
