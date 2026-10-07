'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const AGENT = { id: 'a1', name: 'Ada' };

function row(over) {
  return { id: over.id || Math.random().toString(36).slice(2), role: 'assistant', sender_kind: 'agent', sender_id: 'a1', sender_name: 'Ada', content: 'x', message_kind: null, ...over };
}

test('snapshot drops tool_step chips instead of replaying them as assistant prose', () => {
  const out = __test.snapshotFromChannelRows([
    row({ role: 'user', sender_kind: 'human', sender_id: 'u1', sender_name: 'Jo', content: 'hi', id: 'm1' }),
    row({ message_kind: 'tool_step', content: 'read_channel', tool_name: 'read_channel' }),
    row({ content: 'Here you go' }),
  ], AGENT);
  const joined = out.messages.map((m) => m.content).join('\n');
  assert.ok(!joined.includes('read_channel'));
  assert.ok(joined.includes('Here you go'));
});

test('snapshot strips the agent\'s own failure notice but keeps its partial answer', () => {
  const out = __test.snapshotFromChannelRows([
    row({ role: 'user', sender_kind: 'human', sender_id: 'u1', sender_name: 'Jo', content: 'hi', id: 'm1' }),
    row({ content: 'Partial answer\n\n@ada failed: HTTP 500' }),
    row({ role: 'user', sender_kind: 'human', sender_id: 'u1', sender_name: 'Jo', content: 'again', id: 'm2' }),
    row({ content: '@ada failed: boom' }),
  ], AGENT);
  const joined = out.messages.map((m) => m.content).join('\n');
  assert.ok(joined.includes('Partial answer'));
  assert.ok(!joined.includes('failed:'));
});

test('a tool call aborted after callTool settles its chip as failed, not success', async () => {
  const ac = new AbortController();
  const results = [];
  await assert.rejects(() => __test.runToolUseLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 't', description: '', input_schema: {} }],
    signal: ac.signal,
    callModel: async () => ({ text: '', toolUses: [{ id: 'u1', name: 't', input: {}, inputError: '' }] }),
    callTool: async () => { ac.abort(); return { ok: true, value: {} }; },
    onToolStart: async () => 'handle',
    onToolResult: async (handle, outcome) => { results.push({ handle, outcome }); },
  }));
  assert.equal(results.length, 1);
  assert.equal(results[0].handle, 'handle');
  assert.equal(results[0].outcome.ok, false);
  assert.match(results[0].outcome.error, /Interrupted/);
});

test('every job-metadata site in builtin-turn carries dispatchedBy', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server/builtin-turn.cjs'), 'utf8');
  const wake = (src.match(/\.\.\.\(dispatchWakeId \? \{ dispatchWakeId \} : \{\}\),/g) || []).length;
  const by = (src.match(/\.\.\.\(dispatchedBy \? \{ dispatchedBy \} : \{\}\),/g) || []).length;
  assert.equal(wake, 4);
  assert.equal(by, wake);
});
