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

// THE OUTAGE this guard exists for. `messageId` arrives from the client and was
// returned straight into thread_parent_id, which is a foreign key. A client id
// that never became a row — an optimistic id, or one whose own insert failed —
// made every agent reply in the job die on messages_thread_parent_id_fkey.
// Observed live: two jobs, ~20 rejections each, no replies delivered at all.
test('a thread parent that is not a real message threads FLAT rather than failing', () => {
  // Mirrors verifyThreadParent: exists AND in this session, else null.
  const rows = [{ id: 'm1', session_id: 's1' }];
  const verify = (parent, session) => {
    if (!parent || !session) return null;
    return rows.some(r => r.id === parent && r.session_id === session) ? parent : null;
  };

  assert.equal(verify('m1', 's1'), 'm1', 'a real message in this session threads under it');
  assert.equal(verify('nope', 's1'), null, 'an id with no row threads flat, it does not throw');
  // Losing the nesting is cosmetic; losing the reply is not.
  assert.equal(verify('m1', 's2'), null, 'a message in ANOTHER session is refused');
  assert.equal(verify(null, 's1'), null);
  assert.equal(verify('m1', null), null);
});
