'use strict';

// Documents + agent-status bandwidth: heavy fields and truncated status payloads.
// Drives the shipped createRealtime / sanitizeRealtimeRow / truncateAgentStatusContent.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

test('documents.content is stripped from realtime fanout', () => {
  assert.ok(
    Array.isArray(__test.REALTIME_HEAVY_FIELDS.documents),
    'documents must be listed in REALTIME_HEAVY_FIELDS',
  );
  assert.ok(
    __test.REALTIME_HEAVY_FIELDS.documents.includes('content'),
    'documents.content must be a heavy field',
  );

  const row = {
    id: 'doc-1',
    workspace_id: 'ws-1',
    title: 'Spec',
    content: '<p>' + 'x'.repeat(5000) + '</p>',
    version: 3,
  };
  const sanitized = __test.sanitizeRealtimeRow('documents', row);
  assert.equal('content' in sanitized, false, 'content must be deleted from the fanout copy');
  assert.equal(sanitized.title, 'Spec');
  assert.equal(sanitized.id, 'doc-1');
  assert.equal(sanitized.version, 3);
  // Original row is not mutated in place when fields are stripped (copy-on-write).
  assert.equal(typeof row.content, 'string');
  assert.ok(row.content.length > 100);
});

test('agent-status content is truncated at AGENT_STATUS_CONTENT_MAX', () => {
  const max = __test.AGENT_STATUS_CONTENT_MAX;
  assert.equal(typeof max, 'number');
  assert.ok(max >= 80 && max <= 200, 'cap should be a short UI line, not multi-KB');

  const short = 'Thinking 12s';
  assert.equal(__test.truncateAgentStatusContent(short), short);

  const long = 'A'.repeat(max + 50);
  const out = __test.truncateAgentStatusContent(long);
  assert.ok(out.length <= max, `truncated length ${out.length} exceeds ${max}`);
  assert.ok(out.endsWith('…') || out.length < long.length);
  assert.equal(__test.truncateAgentStatusContent(''), '');
  assert.equal(__test.truncateAgentStatusContent(null), '');
});

test('emitAgentStatus puts only truncated content on the wire', async () => {
  // Fixture must use real message columns only (see agentStatusBroadcast.test.cjs).
  const longBody = 'stream-body-' + 'z'.repeat(500);
  __test.setTestDb({
    async unsafe(sql) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select workspace_id') && n.includes('from chat_sessions')) {
        return [{ workspace_id: 'ws-1', visibility: 'workspace', folder: 'Channels' }];
      }
      return [];
    },
  });
  const sent = [];
  __test.registerTestWebsocketClient({
    userId: 'user-1',
    readyState: 1,
    subscriptions: [
      { type: 'broadcast', channel: 'agent-status:ws-1', event: 'agent_status' },
    ],
    send: (str) => sent.push(JSON.parse(str)),
  });

  __test.notifyDbSubscribers('messages', 'UPDATE', [{
    id: 'msg-1',
    session_id: 'sess-1',
    role: 'assistant',
    content: longBody,
    sender_kind: 'agent',
    sender_id: 'agent-1',
    sender_name: 'Coder',
  }]);

  await new Promise((r) => setTimeout(r, 40));
  const frame = sent.find((m) => m.type === 'broadcast' && m.channel === 'agent-status:ws-1');
  assert.ok(frame, 'expected an agent_status broadcast frame');
  assert.equal(frame.event, 'agent_status');
  assert.ok(frame.payload.content.length <= __test.AGENT_STATUS_CONTENT_MAX);
  assert.equal(frame.payload.content.includes(longBody), false);
  assert.ok(frame.payload.content.startsWith('stream-body-'));
});
