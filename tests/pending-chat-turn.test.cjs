// ============================================================================
// tests/pending-chat-turn.test.cjs
// ----------------------------------------------------------------------------
// Dropped-DM-turn regression (2026-08-03). A human message addressed to an agent
// that was already mid-turn used to be DROPPED: continueConversation returned
// { reason: 'agent_busy' } and nothing ever retried it.
//
// That is survivable in a channel and silent data loss in a DM, because every
// thread of one DM shares ONE chat_session and therefore ONE active-job slot
// (uq_agent_jobs_active_per_session_agent). Live evidence from the day of the
// fix, workspace 3a9ce2ab:
//   * session eab3341e — "yes release it", "yes finish it", "what?" all posted
//     while the agent worked in a sibling thread; none ever answered.
//   * session ac9a4eab — "and?" at 12:06, no reply; the human re-asked at 12:38
//     and was told the work had been finished the whole time.
//
// The guarantee locked in here: a refused turn is PARKED and replayed when the
// agent's job reaches a terminal state — bounded by an attempt cap and an age
// limit so a permanently-busy agent cannot produce an unbounded retry loop, and
// so a turn a human has given up on is never answered late.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const { parkChatTurn, drainPendingChatTurn, pendingChatTurns } = __test;

const SESSION = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const WORKSPACE = '33333333-3333-3333-3333-333333333333';

function park(overrides = {}) {
  parkChatTurn({
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    threadParentId: 'thread-a',
    broadcastToChannel: null,
    targetAgentId: AGENT,
    agentId: AGENT,
    ...overrides,
  });
}

test.afterEach(() => pendingChatTurns.clear());

test('a refused turn is parked rather than dropped', () => {
  assert.equal(pendingChatTurns.size, 0);
  park();
  assert.equal(pendingChatTurns.size, 1, 'the turn must be retained for replay');
});

test('the replay re-runs the conversation, pinned to the agent that was busy', async () => {
  park();
  const calls = [];
  await drainPendingChatTurn(SESSION, AGENT, 'job_done', async (args) => {
    calls.push(args);
    return { started: true };
  });
  assert.equal(calls.length, 1, 'the parked turn must be replayed exactly once');
  assert.equal(calls[0].sessionId, SESSION);
  assert.equal(calls[0].threadParentId, 'thread-a', 'replay must land in the thread it was asked in');
  assert.equal(calls[0].targetAgentId, AGENT, 'replay must be pinned to the agent that was busy');
  assert.equal(pendingChatTurns.size, 0, 'a replayed turn must not stay parked');
});

test('several messages while busy collapse to ONE replay', async () => {
  // continueConversation re-reads the conversation from the database, so the
  // parked entry is a wake-up and not a copy of the message. Three messages must
  // not become three turns.
  park({ threadParentId: 'thread-a' });
  park({ threadParentId: 'thread-a' });
  park({ threadParentId: 'thread-b' });
  assert.equal(pendingChatTurns.size, 1, 'one slot per (session, agent)');

  let runs = 0;
  await drainPendingChatTurn(SESSION, AGENT, 'job_done', async (args) => {
    runs += 1;
    assert.equal(args.threadParentId, 'thread-b', 'the newest context wins');
    return { started: true };
  });
  assert.equal(runs, 1);
});

test('draining with nothing parked is a no-op', async () => {
  let runs = 0;
  await drainPendingChatTurn(SESSION, AGENT, 'job_done', async () => { runs += 1; return { started: true }; });
  assert.equal(runs, 0);
});

test('a turn parked longer than the age limit is dropped, never answered late', async () => {
  park();
  const entry = pendingChatTurns.get([...pendingChatTurns.keys()][0]);
  entry.parkedAt = Date.now() - (16 * 60_000); // older than PENDING_CHAT_TURN_MAX_AGE_MS

  let runs = 0;
  await drainPendingChatTurn(SESSION, AGENT, 'job_done', async () => { runs += 1; return { started: true }; });
  assert.equal(runs, 0, 'a turn the human has given up on must not be replayed');
  assert.equal(pendingChatTurns.size, 0, 'and it must not linger');
});

test('a still-busy agent re-parks, and the attempt cap ends the loop', async () => {
  park();
  const stillBusy = async () => {
    // Mirrors production: continueConversation re-parks on agent_busy.
    park();
    return { started: false, reason: 'agent_busy' };
  };

  await drainPendingChatTurn(SESSION, AGENT, 'attempt-1', stillBusy);
  assert.equal(pendingChatTurns.size, 1, 'a still-refused turn stays parked');
  assert.equal([...pendingChatTurns.values()][0].attempts, 1);

  await drainPendingChatTurn(SESSION, AGENT, 'attempt-2', stillBusy);
  assert.equal([...pendingChatTurns.values()][0].attempts, 2);

  await drainPendingChatTurn(SESSION, AGENT, 'attempt-3', stillBusy);
  assert.equal([...pendingChatTurns.values()][0].attempts, 3);

  // Cap reached: the next drain must give up instead of running forever.
  let runs = 0;
  await drainPendingChatTurn(SESSION, AGENT, 'attempt-4', async () => { runs += 1; return { started: true }; });
  assert.equal(runs, 0, 'the attempt cap must stop the retry loop');
  assert.equal(pendingChatTurns.size, 0);
});

test('a replay that throws never escapes as a rejection', async () => {
  park();
  await assert.doesNotReject(
    drainPendingChatTurn(SESSION, AGENT, 'job_done', async () => { throw new Error('boom'); }),
    'a replay must never be able to fail the job-completion write that triggered it',
  );
});
