'use strict';

// ============================================================================
// tests/ambient-continuity.test.cjs
// ----------------------------------------------------------------------------
// The free tier. "If I'm already talking to an agent, it should pick up my next
// message" — decided from the transcript, deterministically, with no model call.
//
// Every condition is asserted through its NEGATIVE, because openInterlocutor is
// a conjunction of seven refusals and a test that only ever shows it electing
// would pass with six of them deleted. Each case below names the mutation.
//
// The clock is INJECTED (`nowMs`) rather than read inside the function, so the
// TTL cases are exact instead of racing a real timer — the same discipline
// shared/replyCadence.cjs uses when it derives jitter from a message id.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const {
 CONTINUITY_LOOKBACK, CONTINUITY_TTL_MS, openInterlocutor,
} = require('../shared/ambientAddressing.cjs');
const {
 agentFixture, agentSays, agoMs, channelHarness, fakeUuid, human, participants,
 systemSeed, toolStep,
} = require('./helpers/messageFixture.cjs');

const SCOUT = agentFixture(fakeUuid('a'), 'Scout');
const CODER = agentFixture(fakeUuid('b'), 'Coder');
const ROSTER = [SCOUT, CODER];

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const ago = (ms) => agoMs(ms, NOW);

/** Elect over a hand-built transcript whose seed is the last row. */
function elect(rows, options = {}) {
 return openInterlocutor({ rows, startIdx: rows.length - 1, nowMs: NOW, ...options });
}

let live = null;
test.afterEach(() => {
 if (live) { live.restore(); live = null; }
 __test.resetTestState();
});

// --- the happy path, so every negative below means something -----------------

test('a follow-up to the agent that just spoke elects that agent, free', () => {
 const rows = [
  human('scout, whats the deploy status?', { at: ago(120_000) }),
  agentSays(SCOUT, 'green on Fly, Netlify pending', { at: ago(60_000) }),
  human('and the other one?'),
 ];
 assert.deepEqual(elect(rows), { agentId: SCOUT.id, reason: 'continuity' });
});

// --- C1: only a person continues a conversation ------------------------------

test('C1 a schedule seed (sender_kind=system) elects nobody', () => {
 // MUTATION: relax isHumanAuthored to "not an agent" — a machine-written row
 // then inherits whatever conversation happened to precede it.
 const rows = [
  human('morning', { at: ago(120_000) }),
  agentSays(SCOUT, 'morning', { at: ago(60_000) }),
  systemSeed('run the nightly sweep'),
 ];
 assert.equal(elect(rows), null);
});

// --- C2: an addressed message is not an un-addressed one ---------------------

test('C2 a seed that names anyone elects nobody here — the mention path owns it', () => {
 // Belt: the mention path runs first in the dispatcher. This makes the function
 // safe against that ordering being changed.
 // MUTATION: delete the parseMentionHandles check.
 const base = [
  human('scout?', { at: ago(120_000) }),
  agentSays(SCOUT, 'yes', { at: ago(60_000) }),
 ];
 assert.equal(elect([...base, human('@coder can you take this')]), null);
 assert.equal(elect([...base, human('@channel heads up')]), null);
 assert.equal(elect([...base, human('and the other one?')])?.agentId, SCOUT.id);
});

test('C2b through the dispatcher, an @mention routes to the NAMED agent', async () => {
 // The same claim end-to-end: naming Coder must reach Coder, not the agent you
 // were mid-conversation with. Continuity must never outrank being asked.
 live = channelHarness({
  agents: ROSTER,
  rows: [
   human('scout?', { at: ago(120_000) }),
   agentSays(SCOUT, 'yes', { at: ago(60_000) }),
   human('@coder can you take this'),
  ],
 });
 live.install();
 __test.setTestDb(live.db);
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(live.electedAgentIds, [CODER.id]);
 assert.equal(live.anthropicCalls.length, 0);
});

// --- C3: two agents in play is ambiguous -------------------------------------

test('C3 two distinct agents in the lookback elects nobody', () => {
 // Ambiguity is exactly when the paid router — which reads the actual text — is
 // worth its tenth of a cent. Guessing confidently here is worse than paying.
 // MUTATION: drop the distinct-agent check and take the last speaker always.
 const rows = [
  human('who can look at the build?', { at: ago(180_000) }),
  agentSays(CODER, 'I can', { at: ago(120_000) }),
  agentSays(SCOUT, 'I have context on it too', { at: ago(60_000) }),
  human('go ahead'),
 ];
 assert.equal(elect(rows), null);
});

// --- C4: the agent must be the one you just replied to -----------------------

test('C4 an agent two rows back, with another human in between, elects nobody', () => {
 // MUTATION: search backwards for the most recent agent instead of requiring
 // the IMMEDIATELY preceding conversational row.
 const rows = [
  human('scout?', { at: ago(180_000) }),
  agentSays(SCOUT, 'here', { at: ago(120_000) }),
  human('thanks', { who: 'u-bob', at: ago(60_000) }),
  human('and the other one?'),
 ];
 assert.equal(elect(rows), null);
});

// --- C5: the exchange must still be live -------------------------------------

test('C5 the TTL is exact on both sides of the boundary', () => {
 // MUTATION: drop the TTL check, or make the comparison `<` at the boundary.
 const build = (ageMs) => [
  human('scout?', { at: ago(ageMs + 60_000) }),
  agentSays(SCOUT, 'here', { at: ago(ageMs) }),
  human('and the other one?'),
 ];
 // The boundary is INCLUSIVE — "within ten minutes" includes the ten-minute
 // mark. Pinned in both directions so a later `>=` refactor is a failing test
 // rather than a silently shorter window.
 assert.equal(elect(build(CONTINUITY_TTL_MS - 1))?.agentId, SCOUT.id, 'inside the window');
 assert.equal(elect(build(CONTINUITY_TTL_MS))?.agentId, SCOUT.id, 'exactly at the window');
 assert.equal(elect(build(CONTINUITY_TTL_MS + 1)), null, 'one millisecond past it');
});

test('C5b the TTL is a named constant, so retuning it is a visible diff', () => {
 assert.equal(CONTINUITY_TTL_MS, 10 * 60 * 1000);
 assert.equal(CONTINUITY_LOOKBACK, 6);
});

test('C5c an unparseable or future timestamp elects nobody', () => {
 // Fail-closed on bad data rather than treating NaN as "recent".
 const rows = [
  human('scout?', { at: ago(120_000) }),
  agentSays(SCOUT, 'here', { at: ago(60_000) }),
  human('and the other one?'),
 ];
 rows[1].created_at = 'not a timestamp';
 assert.equal(elect(rows), null);
 rows[1].created_at = new Date(NOW + 60_000).toISOString();
 assert.equal(elect(rows), null, 'a clock-skewed future row is not "recent"');
});

// --- C6: it must be YOUR conversation ----------------------------------------

test('C6 Bob posting into Alice-and-Scout elects nobody', () => {
 // Walking into a room where two others are mid-exchange does not make their
 // agent yours. MUTATION: drop the sender comparison — Bob's "hm" then wakes
 // the agent Alice was talking to.
 const rows = [
  human('scout, status?', { who: 'u-alice', at: ago(120_000) }),
  agentSays(SCOUT, 'all green', { at: ago(60_000) }),
  human('hm', { who: 'u-bob' }),
 ];
 assert.equal(elect(rows), null);
 assert.equal(elect([...rows.slice(0, 2), human('hm', { who: 'u-alice' })])?.agentId, SCOUT.id);
});

test('C6b a transcript with no earlier human at all elects nobody', () => {
 // The window can start mid-conversation (40 rows). With nothing to compare
 // against, refuse — a suppressor, so this can only ever dispatch less.
 const rows = [agentSays(SCOUT, 'here', { at: ago(60_000) }), human('and the other one?')];
 assert.equal(elect(rows), null);
});

// --- C0: tool chips are not conversation -------------------------------------

test('C0 chips from ONE agent do not stop it being elected', () => {
 // Paired with the next test. On its own this proves nothing — it passes with
 // or without the message_kind filter, because the chips carry the same
 // sender_id as the answer. It exists so the next test's failure is legible.
 const rows = [
  human('scout, run the tests', { at: ago(300_000) }),
  agentSays(SCOUT, 'running them now', { at: ago(240_000) }),
  ...Array.from({ length: 6 }, (unused, i) => toolStep(SCOUT, `step ${i}`, { at: ago(200_000 - i * 1000) })),
  human('how did it go?'),
 ];
 assert.equal(elect(rows)?.agentId, SCOUT.id);
});

test('C0b chips must not push a SECOND agent out of the lookback window', () => {
 // THE test that catches a missing message_kind filter.
 //
 // Two agents answered, so this is ambiguous and must fall through to the paid
 // router. But Coder then emitted six tool chips. Counting those as
 // conversation fills the entire CONTINUITY_LOOKBACK window with rows from one
 // turn, hides Scout completely, and makes C3 see a single agent — electing
 // Coder confidently and wrongly.
 //
 // MUTATION: delete `.filter(isConversationalRow)` from openInterlocutor. This
 // test then returns Coder instead of null. It is the only test in the file
 // that fails on that mutation.
 const rows = [
  human('who can run the tests?', { at: ago(400_000) }),
  agentSays(SCOUT, 'I know that suite', { at: ago(360_000) }),
  agentSays(CODER, 'I will take it', { at: ago(300_000) }),
  ...Array.from({ length: 6 }, (unused, i) => toolStep(CODER, `step ${i}`, { at: ago(200_000 - i * 1000) })),
  human('how did it go?'),
 ];
 assert.equal(elect(rows), null, 'two agents spoke — ambiguous, so pay the router');
});

test('C0c a chip is never itself the elected "last speaker"', () => {
 // A trailing chip from Coder after Scout's answer would, unfiltered, make
 // Coder the immediately-preceding row and elect the wrong agent outright.
 const rows = [
  human('scout?', { at: ago(300_000) }),
  agentSays(SCOUT, 'on it', { at: ago(240_000) }),
  toolStep(CODER, 'unrelated background work', { at: ago(60_000) }),
  human('and the other one?'),
 ];
 assert.equal(elect(rows)?.agentId, SCOUT.id, 'the answer, not the chip');
});

// --- C7 and the query-level resets -------------------------------------------

test('C7 an ineligible agent is not elected, even mid-conversation', () => {
 // How the per-agent off switch and the enabled flag reach this decision.
 const rows = [
  human('scout?', { at: ago(120_000) }),
  agentSays(SCOUT, 'here', { at: ago(60_000) }),
  human('and the other one?'),
 ];
 assert.equal(elect(rows, { isEligible: (id) => id !== SCOUT.id }), null);
});

test('a soft-deleted agent message resets continuity, because the query never returns it', async () => {
 // Asserted through continueConversation rather than the pure function. The
 // fixture CANNOT carry deleted_at — loadChannelMessages filters it in the
 // WHERE clause, so a returned row never has a meaningful one. Modelling the
 // deletion by setting a field would test a row shape production never
 // produces; modelling it by omitting the row is what actually happens.
 live = channelHarness({
  agents: ROSTER,
  rows: [human('scout?', { at: ago(120_000) }), human('and the other one?')],
  autoInterjectPick: null,
 });
 live.install();
 __test.setTestDb(live.db);
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(live.electedAgentIds, [], 'no continuity hit with the agent row gone');
 assert.equal(live.anthropicCalls.length, 1, 'it falls through to the paid router instead');
});

// --- end to end --------------------------------------------------------------

test('through the dispatcher: continuity elects, and a stale one does not', async () => {
 live = channelHarness({
  agents: ROSTER,
  session: { participants: participants(ROSTER) },
  rows: [
   human('scout, whats the deploy status?', { at: agoMs(120_000) }),
   agentSays(SCOUT, 'green on Fly', { at: agoMs(60_000) }),
   human('and the other one?'),
  ],
 });
 live.install();
 __test.setTestDb(live.db);
 const hit = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(hit.reason, 'agent_busy');
 assert.deepEqual(live.electedAgentIds, [SCOUT.id]);
 assert.equal(live.anthropicCalls.length, 0);
 live.restore();
 live = null;
 __test.resetTestState();

 const stale = channelHarness({
  agents: ROSTER,
  session: { participants: participants(ROSTER) },
  rows: [
   human('scout, whats the deploy status?', { at: agoMs(CONTINUITY_TTL_MS + 120_000) }),
   agentSays(SCOUT, 'green on Fly', { at: agoMs(CONTINUITY_TTL_MS + 60_000) }),
   human('and the other one?'),
  ],
  autoInterjectPick: CODER,
 });
 stale.install();
 __test.setTestDb(stale.db);
 live = stale;
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(stale.anthropicCalls.length, 1, 'a cold exchange pays the router');
 assert.deepEqual(stale.electedAgentIds, [CODER.id]);
});
