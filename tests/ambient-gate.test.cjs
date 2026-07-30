'use strict';

// ============================================================================
// tests/ambient-gate.test.cjs
// ----------------------------------------------------------------------------
// What stands between an un-addressed post and a paid model call.
//
// Before this branch there was nothing: every message nobody addressed, in
// every 'auto' or 'social' channel with at least one candidate, cost one Haiku
// call. The gates below are all SUPPRESSORS — each can only refuse the call,
// never cause one — so the worst case is unchanged at exactly one call per
// message and the common cases are free.
//
// ORDERING IS PART OF THE CONTRACT and has its own test: the triviality check
// sits AFTER continuity, so a bare `👍` typed mid-conversation still reaches
// the agent you were talking to. Moving it earlier would make every
// mid-conversation acknowledgement vanish, which no other test here would catch.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const {
 AMBIENT_ELECTION_MAX_PER_WINDOW, AMBIENT_ELECTION_WINDOW_MS,
 createAmbientElectionBudget, isStructurallyTrivial,
} = require('../shared/ambientAddressing.cjs');
const { allowsUnpromptedReply } = require('../shared/channelMentions.cjs');
const {
 agentFixture, agentSays, agoMs, channelHarness, fakeUuid, human, participants,
} = require('./helpers/messageFixture.cjs');

const SCOUT = agentFixture(fakeUuid('a'), 'Scout');
const CODER = agentFixture(fakeUuid('b'), 'Coder');
const ROSTER = [SCOUT, CODER];

let live = null;
function drive(options) {
 live = channelHarness({ agents: ROSTER, session: { participants: participants(ROSTER) }, ...options });
 live.install();
 __test.setTestDb(live.db);
 return live;
}
test.afterEach(() => {
 if (live) { live.restore(); live = null; }
 __test.resetTestState();
});

const COLD = [human('anyone know why the netlify build went red?')];
const MID_CONVERSATION = (seed) => [
 human('scout, whats the deploy status?', { at: agoMs(120_000) }),
 agentSays(SCOUT, 'green on Fly, Netlify pending', { at: agoMs(60_000) }),
 seed,
];

// --- the per-channel off switch ---------------------------------------------

test("conversation_mode 'mention' reaches NO elector of any tier", async () => {
 // MUTATION: delete the unpromptedAllowed condition from the ambient gate.
 const h = drive({ session: { conversation_mode: 'mention' }, rows: COLD, autoInterjectPick: CODER });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(result.reason, 'no_agent');
 assert.deepEqual(h.electedAgentIds, []);
 assert.equal(h.anthropicCalls.length, 0);
});

test("'mention' silences the FREE tier too, not just the paid one", async () => {
 // Easy to get wrong: continuity costs nothing, so it is tempting to let it run
 // regardless. It must not — "nobody has to answer" is about being answered,
 // not about spend.
 const h = drive({ session: { conversation_mode: 'mention' }, rows: MID_CONVERSATION(human('and the other one?')) });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, []);
});

test("'social' still reaches an elector — the mode is not spelled `=== 'auto'`", async () => {
 // THE regression shared/channelMentions.cjs was written to prevent, asserted
 // through the DISPATCHER rather than the pure function.
 // MUTATION: rewrite allowsUnpromptedReply as `mode === 'auto'`. Every 'social'
 // channel then goes silent, and nothing errors — an agent simply never speaks.
 assert.equal(allowsUnpromptedReply({ conversationMode: 'social' }), true);
 for (const mode of ['auto', 'social']) {
  const h = drive({ session: { conversation_mode: mode }, rows: COLD, autoInterjectPick: CODER });
  const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
  assert.equal(h.anthropicCalls.length, 1, `${mode} must reach the elector`);
  assert.deepEqual(h.electedAgentIds, [CODER.id], `${mode} must dispatch`);
  assert.equal(result.reason, 'agent_busy');
  live.restore();
  live = null;
  __test.resetTestState();
 }
});

// --- structural triviality ---------------------------------------------------

test('triviality is STRUCTURAL — no letters, no digits — not a keyword list', () => {
 for (const trivial of ['👍', '!!!', '   ', '', '...', '🎉🎉', '¯\\_(ツ)_/¯'.replace(/[ツ]/g, '')]) {
  assert.equal(isStructurallyTrivial(trivial), true, JSON.stringify(trivial));
 }
 // MUTATION: swap this for a keyword set like ['ok', 'thanks', 'lol'] — these
 // then get swallowed, and a swallowed message is invisible: the agent just
 // doesn't answer and nobody learns why.
 for (const real of ['ship it', 'ok', 'thanks', '+1 on the 3rd one', 'no', 'は い', 'да']) {
  assert.equal(isStructurallyTrivial(real), false, JSON.stringify(real));
 }
});

test('a COLD trivial post makes no model call; a cold substantive one does', async () => {
 const quiet = drive({ rows: [human('👍')], autoInterjectPick: CODER });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(quiet.anthropicCalls.length, 0);
 assert.deepEqual(quiet.electedAgentIds, []);
 live.restore();
 live = null;
 __test.resetTestState();

 const loud = drive({ rows: [human('+1 on the 3rd one')], autoInterjectPick: CODER });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(loud.anthropicCalls.length, 1, 'a digit is content');
});

test('ORDERING: a trivial post MID-CONVERSATION still reaches the agent you were talking to', async () => {
 // MUTATION: move the triviality check above the continuity tier. This test
 // fails and every other test in this file still passes — which is the whole
 // reason it is written separately.
 const h = drive({ rows: MID_CONVERSATION(human('👍')) });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, [SCOUT.id], 'acknowledgements are part of a conversation');
 assert.equal(h.anthropicCalls.length, 0, 'and cost nothing');
 assert.equal(result.reason, 'agent_busy');
});

// --- the per-session spend damper --------------------------------------------

test('the election budget caps paid calls per session per window', async () => {
 // MUTATION: delete the budget check — the count below becomes MAX + 1.
 const h = drive({ rows: COLD, autoInterjectPick: null });
 for (let i = 0; i <= AMBIENT_ELECTION_MAX_PER_WINDOW; i++) {
  await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 }
 assert.equal(h.anthropicCalls.length, AMBIENT_ELECTION_MAX_PER_WINDOW);
});

test('the budget window rolls over, and the constants are named', () => {
 // The rollover is asserted on the factory with an injected clock rather than
 // through the dispatcher, because proving it end-to-end would mean waiting
 // five real minutes. The dispatcher test above proves the cap is WIRED; this
 // proves it is a sliding window and not a permanent lockout.
 assert.equal(AMBIENT_ELECTION_MAX_PER_WINDOW, 12);
 assert.equal(AMBIENT_ELECTION_WINDOW_MS, 5 * 60 * 1000);

 const budget = createAmbientElectionBudget({ max: 3, windowMs: 1000 });
 assert.deepEqual([0, 1, 2, 3].map((i) => budget.take('s1', 1000 + i)), [true, true, true, false]);
 assert.equal(budget.take('s2', 1003), true, 'the budget is per session, not global');
 assert.equal(budget.take('s1', 2000), true, 'a new window resets it');
});

test('the budget sweeps expired windows rather than growing forever', () => {
 const budget = createAmbientElectionBudget({ max: 1, windowMs: 10 });
 for (let i = 0; i < 600; i++) budget.take(`session-${i}`, 1000 + i * 100);
 assert.ok(budget.size < 600, `expired windows must be swept (size ${budget.size})`);
});

// --- the kill switch ----------------------------------------------------------

test('AGENSIS_AMBIENT_ELECTION=off kills the PAID tier and leaves continuity working', async () => {
 // Per AGENTS.md the flag gates EXECUTION, not a button. Continuity survives it
 // because there is nothing to kill about a decision that costs nothing.
 const previous = process.env.AGENSIS_AMBIENT_ELECTION;
 process.env.AGENSIS_AMBIENT_ELECTION = 'off';
 try {
  const cold = drive({ rows: COLD, autoInterjectPick: CODER });
  await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
  assert.equal(cold.anthropicCalls.length, 0);
  assert.deepEqual(cold.electedAgentIds, []);
  live.restore();
  live = null;
  __test.resetTestState();

  const warm = drive({ rows: MID_CONVERSATION(human('and the other one?')) });
  await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
  assert.deepEqual(warm.electedAgentIds, [SCOUT.id], 'the free tier is unaffected');
 } finally {
  if (previous === undefined) delete process.env.AGENSIS_AMBIENT_ELECTION;
  else process.env.AGENSIS_AMBIENT_ELECTION = previous;
 }
});

test('the flag defaults ON, so ambient addressing does not need an env var to work', async () => {
 assert.equal(process.env.AGENSIS_AMBIENT_ELECTION, undefined);
 const h = drive({ rows: COLD, autoInterjectPick: CODER });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(h.anthropicCalls.length, 1);
});

// --- a DM is never gated ------------------------------------------------------

test('a DM is never gated, paced or budgeted by any of this', async () => {
 // Pinned here as well as in tests/reply-cadence.test.cjs, because every gate
 // added above is a chance to accidentally catch the one conversation that must
 // always answer. 'mention' mode, a trivial message and an exhausted budget all
 // at once, and the agent still replies.
 const h = channelHarness({
  agents: ROSTER,
  session: {
   folder: 'Direct messages',
   conversation_mode: 'mention',
   participants: [{ kind: 'agent', agent_id: SCOUT.id, handle: 'scout', direct: true }],
  },
  rows: [human('👍')],
 });
 h.install();
 __test.setTestDb(h.db);
 live = h;
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, [SCOUT.id]);
 assert.equal(h.anthropicCalls.length, 0, 'a DM needs no election — its agent is the only one');
 assert.equal(result.reason, 'agent_busy');
});
