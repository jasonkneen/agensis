// ============================================================================
// tests/dispatch-auto-thread.test.cjs
// ----------------------------------------------------------------------------
// Option A auto-threading (2026-07): a plain main-box message in a channel/DM
// should have the agent's reply threaded UNDER it, so the main timeline stays a
// list of topics with each answer tucked beneath — only genuinely new
// (unrelated) messages land on the main timeline. The decision lives in the pure
// helper resolveDispatchThreadParent, exercised here in isolation.
//
// Guarantees locked in:
//   1. An explicit threadParentId (a follow-up from an open thread panel) always
//      wins — that reply stays in its existing thread.
//   2. A main-box message flagged autoThread + messageId threads under messageId.
//   3. Callers that omit autoThread (sub-thread sessions, MCP, legacy clients)
//      keep flat, main-timeline replies even when a messageId is present.
//   4. Missing/blank inputs fall back to null (flat) — never throws.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const { resolveDispatchThreadParent } = __test;

test('explicit threadParentId always wins (thread-panel follow-up stays in its thread)', () => {
  assert.equal(
    resolveDispatchThreadParent({ threadParentId: 'root-1', autoThread: true, messageId: 'm-9' }),
    'root-1',
  );
  // Even without autoThread, an explicit thread parent is honoured.
  assert.equal(
    resolveDispatchThreadParent({ threadParentId: 'root-2', autoThread: false, messageId: 'm-9' }),
    'root-2',
  );
});

test('a main-box message with autoThread threads the reply under its messageId', () => {
  assert.equal(
    resolveDispatchThreadParent({ threadParentId: null, autoThread: true, messageId: 'm-42' }),
    'm-42',
  );
  assert.equal(
    resolveDispatchThreadParent({ autoThread: true, messageId: 'm-42' }),
    'm-42',
  );
});

test('messageId is coerced to a string', () => {
  assert.strictEqual(
    resolveDispatchThreadParent({ autoThread: true, messageId: 123 }),
    '123',
  );
});

test('without autoThread the reply stays flat even if a messageId is present', () => {
  // Sub-thread sessions (useSubThreads) and MCP/legacy callers post messageId but
  // never set autoThread — their replies must remain on the session timeline.
  assert.equal(
    resolveDispatchThreadParent({ threadParentId: null, messageId: 'm-7' }),
    null,
  );
  assert.equal(
    resolveDispatchThreadParent({ autoThread: false, messageId: 'm-7' }),
    null,
  );
});

test('missing/blank inputs fall back to a flat (null) reply and never throw', () => {
  assert.equal(resolveDispatchThreadParent(), null);
  assert.equal(resolveDispatchThreadParent({}), null);
  assert.equal(resolveDispatchThreadParent({ autoThread: true }), null); // no messageId
  assert.equal(resolveDispatchThreadParent({ threadParentId: '' }), null); // blank string is falsy
});
