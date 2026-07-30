// ============================================================================
// tests/task-thread-broadcast.test.cjs
// ----------------------------------------------------------------------------
// A thread the agent OPENS for you must answer where you can see it.
//
// `threadParentId` arrives at runAgentTurn meaning two opposite things:
//
//   a human typing in an open thread panel -> "I am already looking at this",
//     so the reply stays in the thread. Broadcasting would duplicate it.
//   dispatchTaskAssignment / a comment @mention -> "I am OPENING a thread for
//     you". Nobody is looking at it; the human is on the task board.
//
// The second took the first's branch, so `broadcast: false` was hardcoded for
// both. Measured against production before the fix: 22 task thread roots
// platform-wide, 0 that ever broadcast an answer. Every task since the feature
// shipped answered into a thread the DM view is structurally unable to render,
// which is exactly what "I assigned it and nothing happened" looks like.
//
// These pin the wiring at each hop. They are source-level assertions, and that
// is a real limitation — they prove the flag is passed and consulted, not that
// a full turn broadcasts end to end. Each match is scoped to the specific call
// site rather than the whole file, because a file-wide match stays green when
// the predicate it is guarding gets replaced.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

test('builtin-turn decides broadcast from the caller flag, not from having a parent', () => {
  const src = read('server/builtin-turn.cjs');
  const i = src.indexOf('const workThread = threadParentId');
  assert.ok(i > 0, 'the work-thread decision moved; re-point this test');
  const decision = src.slice(i, i + 220);

  assert.match(
    decision,
    /broadcast:\s*broadcastOverride === true/,
    'the threaded branch must honour the caller flag',
  );
  assert.doesNotMatch(
    decision,
    /broadcast:\s*false/,
    'a hardcoded false here is the original bug: it cannot tell the two callers apart',
  );

  // The flag has to actually arrive.
  assert.match(
    src,
    /async function runAgentTurn\(agent, \{[^}]*broadcastToChannel: broadcastOverride[^}]*\}\)/,
    'runAgentTurn must accept the flag',
  );
});

test('the two callers that OPEN a thread ask for the answer to be broadcast', () => {
  // Task assignment.
  const dispatch = read('server/task-dispatch.cjs');
  const dispatchCall = /await run\(\{[^}]*sessionId: session\.id[^}]*\}\)/.exec(dispatch);
  assert.ok(dispatchCall, 'the dispatch call moved; re-point this test');
  assert.match(
    dispatchCall[0],
    /broadcastToChannel:\s*true/,
    'dispatchTaskAssignment opens the thread, so its answer must reach the conversation',
  );

  // Comment @mention — the same shape, and it had the identical bug.
  const index = read('server/index.cjs');
  const mentionCall = /await run\(\{ workspaceId, sessionId: session\.id[^}]*\}\)/.exec(index);
  assert.ok(mentionCall, 'the comment-mention dispatch moved; re-point this test');
  assert.match(mentionCall[0], /broadcastToChannel:\s*true/);
});

test('continueConversation forwards the flag rather than swallowing it', () => {
  const src = read('server/index.cjs');
  assert.match(
    src,
    /async function continueConversation\(\{[^}]*broadcastToChannel = null[^}]*\}\)/,
    'continueConversation must accept the flag',
  );
  const turnCall = /await runAgentTurn\(nextAgent, \{[^}]*\}\)/.exec(src);
  assert.ok(turnCall, 'the runAgentTurn call moved; re-point this test');
  assert.match(
    turnCall[0],
    /broadcastToChannel/,
    'a flag accepted and not forwarded is the same bug one layer up',
  );
});

test('CONTROL: the default is still NOT to broadcast', () => {
  // The fix must not turn every threaded reply into a channel post. A human
  // replying inside an open thread passes no flag, and that path has to keep
  // its old behaviour or every thread duplicates itself into the channel.
  const src = read('server/index.cjs');
  assert.match(
    src,
    /broadcastToChannel = null/,
    'the parameter must default to not-broadcasting for callers that do not set it',
  );
  const builtin = read('server/builtin-turn.cjs');
  assert.match(
    builtin,
    /broadcastToChannel: broadcastOverride = null/,
    'and default to null at the turn, so only an explicit true broadcasts',
  );
});
