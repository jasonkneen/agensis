'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');

test('agent conversation context keeps newest turns within the byte budget', () => {
  const messages = [
    { role: 'user', content: `old request ${'a'.repeat(20_000)}` },
    { role: 'assistant', content: `old answer ${'b'.repeat(2_000)}` },
    { role: 'user', content: `latest request ${'c'.repeat(4_000)}` },
  ];
  const bounded = __test.boundAgentContextMessages(messages);
  assert.equal(bounded.at(-1).content, messages.at(-1).content);
  assert.equal(bounded[0].role, 'user');
  assert.ok(__test.agentContextBytes(bounded) <= __test.CHANNEL_CONTEXT_MAX_BYTES);
  assert.equal(bounded.length, 1);
  assert.equal(bounded[0].content, messages[2].content);
});

test('a single oversized latest message is explicitly end-truncated on UTF-8 boundaries', () => {
  const content = `BEGIN-${'x'.repeat(40_000)}-${'\u{1F680}'.repeat(8_000)}-END`;
  const bounded = __test.boundAgentContextMessages([{ role: 'user', content }]);
  assert.equal(bounded.length, 1);
  assert.match(bounded[0].content, /^BEGIN-/);
  assert.doesNotMatch(bounded[0].content, /-END$/);
  assert.match(bounded[0].content, /message truncated at the agent context limit/);
  assert.doesNotMatch(bounded[0].content, /\uFFFD/);
  assert.ok(__test.agentContextBytes(bounded) <= __test.CHANNEL_CONTEXT_MAX_BYTES);
});
