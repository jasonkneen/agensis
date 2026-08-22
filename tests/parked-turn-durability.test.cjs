// ============================================================================
// tests/parked-turn-durability.test.cjs
// ----------------------------------------------------------------------------
// Two ways a message could still be lost after the 2026-08-03 park/replay fix,
// both observed for real on 2026-08-22:
//
//   1. RESTART. The park lived only in process memory. A request parked at
//      18:10 while the agent was busy; a deploy restarted the backend at 18:17;
//      the turn was gone, inside the 15-minute window where it was still owed an
//      answer. The human noticed the silence before the server did.
//
//   2. THE LOCK. continueConversation returned { reason: 'locked' } and parked
//      NOTHING, so a message arriving while an election for the same
//      session/thread was in flight had nothing recorded and nothing to retry
//      it. drainPendingChatTurn already treated 'locked' as retryable — but only
//      for a turn that was ALREADY parked, so a first-attempt collision fell
//      straight through.
//
// tests/pending-chat-turn.test.cjs still owns the original contract (park,
// collapse, age cap, attempt cap, no escaping rejection). This file covers only
// what survives a restart and what happens with no elected agent.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { __test } = require('../server/index.cjs');

const {
  parkChatTurn, drainPendingChatTurn, pendingChatTurns, replayOrphanedChatTurns,
} = __test;

const SESSION = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const WORKSPACE = '33333333-3333-3333-3333-333333333333';

test.afterEach(() => pendingChatTurns.clear());

// --- 2. the lock branch ----------------------------------------------------

test('a turn parked with no agent is keyed session-level and kept', () => {
  // What the `locked` branch now does: no election has happened, so there is no
  // agent to pin to.
  parkChatTurn({
    workspaceId: WORKSPACE, sessionId: SESSION, threadParentId: null,
    broadcastToChannel: null, targetAgentId: null, agentId: null,
  });
  assert.equal(pendingChatTurns.size, 1, 'a lock-refused turn must not be dropped');
  const [key, entry] = [...pendingChatTurns.entries()][0];
  assert.equal(key, `${SESSION}::`, 'session-level key');
  assert.equal(entry.agentId, '');
  // Replay must re-elect rather than pin to nobody.
  assert.equal(entry.targetAgentId, null);
});

test('the lock branch really parks — asserted at the call site', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.cjs'), 'utf8');
  const at = source.indexOf("if (conversationLocks.has(lockKey))");
  assert.ok(at > 0, 'lock branch not found');
  const branch = source.slice(at, at + 1400);
  assert.match(branch, /parkChatTurn\(/, 'the lock branch drops the turn again');
  assert.match(branch, /agentId: null/);
});

// --- 1. surviving a restart ------------------------------------------------

test('the orphan sweep replays a turn whose waker died with the process', async () => {
  // Exactly the restored shape: restorePendingChatTurns puts entries back into
  // the Map, and no job terminal-transition is ever coming for them because the
  // job died with the old process.
  pendingChatTurns.set(`${SESSION}::`, {
    workspaceId: WORKSPACE, sessionId: SESSION, agentId: '',
    threadParentId: null, broadcastToChannel: null, targetAgentId: null,
    attempts: 0, parkedAt: Date.now(),
  });
  const calls = [];
  await replayOrphanedChatTurns({ run: async (args) => { calls.push(args); return { started: true }; } });
  assert.equal(calls.length, 1, 'the restored turn was never replayed');
  assert.equal(calls[0].sessionId, SESSION);
  assert.equal(pendingChatTurns.size, 0, 'a replayed turn must not stay parked');
});

test('the sweep drops a restored turn that is already too old to answer', async () => {
  pendingChatTurns.set(`${SESSION}::`, {
    workspaceId: WORKSPACE, sessionId: SESSION, agentId: '',
    threadParentId: null, broadcastToChannel: null, targetAgentId: null,
    attempts: 0, parkedAt: Date.now() - (16 * 60_000),
  });
  const calls = [];
  await replayOrphanedChatTurns({ run: async (a) => { calls.push(a); return { started: true }; } });
  assert.equal(calls.length, 0, 'answering 16 minutes late is its own bug');
  assert.equal(pendingChatTurns.size, 0);
});

test('the sweep leaves a genuinely busy agent alone', async () => {
  // drainPendingChatTurn fires on that job's terminal transition; racing it here
  // would replay the same turn twice.
  pendingChatTurns.set(`${SESSION}::${AGENT}`, {
    workspaceId: WORKSPACE, sessionId: SESSION, agentId: AGENT,
    threadParentId: null, broadcastToChannel: null, targetAgentId: AGENT,
    attempts: 0, parkedAt: Date.now(),
  });
  const calls = [];
  await replayOrphanedChatTurns({
    run: async (a) => { calls.push(a); return { started: true }; },
    isAgentBusy: async () => true,
  });
  assert.equal(calls.length, 0, 'the sweep raced the terminal drain');
  assert.equal(pendingChatTurns.size, 1, 'the turn must stay parked for that drain');
});

test('the sweep does replay once that agent is free', async () => {
  pendingChatTurns.set(`${SESSION}::${AGENT}`, {
    workspaceId: WORKSPACE, sessionId: SESSION, agentId: AGENT,
    threadParentId: null, broadcastToChannel: null, targetAgentId: AGENT,
    attempts: 0, parkedAt: Date.now(),
  });
  const calls = [];
  await replayOrphanedChatTurns({
    run: async (a) => { calls.push(a); return { started: true }; },
    isAgentBusy: async () => false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].targetAgentId, AGENT, 'a known-busy park must stay pinned');
});

// --- the shadow must never break the path it protects ----------------------

test('persistence failure cannot break park or replay', async () => {
  // There is no DATABASE_URL in the test env, so getDb() THROWS SYNCHRONOUSLY.
  // This is not hypothetical: with the getDb() call outside its try/catch the
  // delete threw straight into drainPendingChatTurn and killed five replay
  // assertions in the original suite.
  parkChatTurn({
    workspaceId: WORKSPACE, sessionId: SESSION, threadParentId: 'thread-a',
    broadcastToChannel: null, targetAgentId: AGENT, agentId: AGENT,
  });
  assert.equal(pendingChatTurns.size, 1, 'park must survive a dead shadow store');
  const calls = [];
  await drainPendingChatTurn(SESSION, AGENT, 'job_done', async (a) => { calls.push(a); return { started: true }; });
  assert.equal(calls.length, 1, 'replay must survive a dead shadow store');
});

test('the orphan sweep never throws, whatever it is handed', async () => {
  pendingChatTurns.set('malformed', { parkedAt: Date.now() });
  await assert.doesNotReject(() => replayOrphanedChatTurns({
    run: async () => { throw new Error('boom'); },
    isAgentBusy: async () => false,
  }));
});

// --- the table is in all three places --------------------------------------

test('pending_chat_turns exists in schema, runtime bootstrap and migrations', () => {
  const root = path.join(__dirname, '..');
  const schema = fs.readFileSync(path.join(root, 'database', 'neon-schema.sql'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'server', 'index.cjs'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '20260822203000_pending_chat_turns.sql'), 'utf8');

  for (const [name, sql] of [['neon-schema', schema], ['runtime', index], ['migration', migration]]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS pending_chat_turns/, name);
    // park_key must be TEXT: the agent half is empty for a lock-parked turn and
    // a NULL cannot carry a primary key.
    assert.match(sql, /park_key text PRIMARY KEY/, name);
  }
});

test('the sweep is registered on the reaper tick and restore runs at startup', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.cjs'), 'utf8');
  assert.match(index, /guardedSweep\('replayOrphanedChatTurns', replayOrphanedChatTurns\)/);
  assert.match(index, /\.then\(\(\) => restorePendingChatTurns\(\)\)/);
});
