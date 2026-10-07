'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/mcp.cjs');

const { toolContent, toolError, MCP_TOOL_TEXT_MAX_CHARS } = __test;

test('small tool results pass through untouched', () => {
  assert.deepEqual(toolContent('ok'), { content: [{ type: 'text', text: 'ok' }] });
  assert.equal(toolContent({ a: 1 }).content[0].text, JSON.stringify({ a: 1 }, null, 2));
});

test('an oversized result is capped with an elision marker', () => {
  const text = 'x'.repeat(MCP_TOOL_TEXT_MAX_CHARS + 345);
  const out = toolContent(text).content[0].text;
  assert.ok(out.startsWith('x'.repeat(MCP_TOOL_TEXT_MAX_CHARS)));
  assert.ok(out.endsWith('[truncated: 345 chars elided - re-call with a narrower query]'));
  assert.equal(toolContent(text).isError, undefined);
});

test('an oversized error is capped and stays an error', () => {
  const out = toolError('e'.repeat(MCP_TOOL_TEXT_MAX_CHARS + 10));
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /\[truncated: 10 chars elided/);
});

test('exactly at the cap is not truncated', () => {
  const text = 'y'.repeat(MCP_TOOL_TEXT_MAX_CHARS);
  assert.equal(toolContent(text).content[0].text, text);
});
