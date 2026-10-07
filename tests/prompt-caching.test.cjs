'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const { createBuiltinTurn } = require('../server/builtin-turn.cjs');

const SSE_OK = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n';

function makeTurn(requests) {
  const unexpected = () => { throw new Error('unexpected'); };
  return createBuiltinTurn({
    getDb: unexpected, recordAudit: unexpected, drainAgentTaskQueue: unexpected,
    drainPendingChatTurn: unexpected, enforceWorkspaceRole: unexpected,
    getAnthropicApiKey: async () => 'k',
    resolveAnthropicModel: (m) => m || 'claude-test',
    buildSystemPrompt: (...a) => __test.buildSystemPrompt(...a),
    buildSystemPromptParts: (...a) => __test.buildSystemPromptParts(...a),
    createAnthropicUsageAccumulator: () => ({ event: () => {}, result: () => ({}) }),
    recordAnthropicUsage: async () => {},
    dbQuery: () => {},
    anthropicFetch: async (request) => { requests.push(request); return new Response(SSE_OK, { status: 200 }); },
  });
}

const baseAgent = () => ({
  name: 'Ada', soul: 'curious', systemPrompt: 'be useful', instructions: 'do X',
  tools: [], skills: [], coParticipants: [{ handle: 'bo', name: 'Bo' }],
});

test('two turns differing only in volatile material share a byte-identical cached prefix', async () => {
  const requests = [];
  const turn = makeTurn(requests);
  const a = { ...baseAgent(), volatilePrompt: '<your_recent_activity>\nmonday\n</your_recent_activity>' };
  const b = { ...baseAgent(), volatilePrompt: '<your_recent_activity>\ntuesday\n</your_recent_activity>\n\n<channel_intent>\nterse\n</channel_intent>' };
  await turn.streamAnthropicTurn({ model: 'm', messages: [{ role: 'user', content: 'hi' }], agentContext: a });
  await turn.streamAnthropicTurn({ model: 'm', messages: [{ role: 'user', content: 'hi' }], agentContext: b });
  const [s1, s2] = requests.map((r) => r.body.system);
  assert.ok(Array.isArray(s1));
  assert.deepEqual(s1[0].cache_control, { type: 'ephemeral' });
  assert.equal(s1[0].text, s2[0].text, 'static block must be byte-identical');
  assert.equal(s1.filter((blk) => blk.cache_control).length, 1, 'only the static block is a breakpoint');
  assert.match(s1[1].text, /monday/);
  assert.match(s2[1].text, /tuesday/);
  assert.ok(!s1[0].text.includes('monday'));
});

test('volatile blocks (voice rules, channel intent) never leak into the static prefix', () => {
  const parts = __test.buildSystemPromptParts('', '', null, {
    ...baseAgent(), volatilePrompt: '<voice_huddle>\nspoken\n</voice_huddle>',
  });
  assert.ok(!parts.static.includes('voice_huddle'));
  assert.ok(!parts.static.includes('voice_output_rules'));
  assert.match(parts.volatile, /voice_output_rules/);
  assert.match(parts.static, /curious/);
  assert.match(parts.static, /do X/);
  const plain = __test.buildSystemPromptParts('', '', null, baseAgent());
  assert.match(plain.static, /@bo/);
  assert.equal(plain.volatile, '');
});

test('buildSystemPrompt still returns one string with volatile material last', () => {
  const text = __test.buildSystemPrompt('', '', null, { ...baseAgent(), volatilePrompt: 'VOLATILE_TAIL' });
  assert.equal(typeof text, 'string');
  assert.ok(text.indexOf('curious') < text.indexOf('Guidelines:'));
  assert.ok(text.indexOf('Guidelines:') < text.indexOf('VOLATILE_TAIL'));
});

test('the last history message carries a cache breakpoint; the caller\'s messages are not mutated', async () => {
  const requests = [];
  const turn = makeTurn(requests);
  const history = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ];
  const snapshot = JSON.stringify(history);
  await turn.streamAnthropicTurn({ model: 'm', messages: history, agentContext: baseAgent() });
  const sent = requests[0].body.messages;
  assert.deepEqual(sent[2].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(sent[0].content, 'first');
  assert.equal(JSON.stringify(history), snapshot);

  await turn.streamAnthropicTurn({ model: 'm', messages: [{ role: 'user', content: 'plain' }], agentContext: baseAgent() });
  assert.deepEqual(requests[1].body.messages[0].content, [{ type: 'text', text: 'plain', cache_control: { type: 'ephemeral' } }]);
});

test('default system prompt stays within its size budget', () => {
  // Measured 757 chars (no agent) / ~1155 with a typical agent, plus the tool note.
  const noAgent = __test.buildSystemPrompt('', '', null, null);
  assert.ok(noAgent.length <= 833, `default prompt grew to ${noAgent.length} chars`);
  const withAgent = __test.buildSystemPrompt('', '', null, baseAgent());
  assert.ok(withAgent.length <= 1400, `agent prompt grew to ${withAgent.length} chars`);
});

test('the tool note carries efficiency guidance and stays small', () => {
  const turn = makeTurn([]);
  assert.match(turn.BUILTIN_TOOL_NOTE, /Be efficient: call independent tools together/);
  assert.ok(turn.BUILTIN_TOOL_NOTE.length <= 1300, `tool note is ${turn.BUILTIN_TOOL_NOTE.length} chars`);
});
