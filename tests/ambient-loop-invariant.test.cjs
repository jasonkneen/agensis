'use strict';

// ============================================================================
// tests/ambient-loop-invariant.test.cjs
// ----------------------------------------------------------------------------
// THE LOOP BOUND. Agents can post messages. Ambient addressing lets a message
// nobody addressed wake an agent. Put naively, those two facts compose into
// unbounded fan-out: agent posts, wakes agent, posts, wakes agent.
//
// They do not compose, and the reason is structural rather than a limiter
// someone could raise:
//
//   A paid turn budget is opened only by a role='user' row; nothing an agent
//   writes is role='user'; election yields AT MOST ONE agent per pass; and
//   every pass re-checks the budget.
//
//   continueConversation seeds `startIdx` at the LAST role='user' row and
//   counts agent rows after it against max_agent_turns (server/index.cjs). An
//   agent reply is inserted as role='assistant', sender_kind='agent'
//   (server/agent-jobs.cjs) and an automation post as role='assistant',
//   sender_kind='automation' (server/automations.cjs) — so neither can move
//   startIdx, and every agent reply strictly SPENDS the budget the last human
//   opened. Depth is bounded by max_agent_turns; breadth by single-winner
//   election. To get more turns a HUMAN must speak.
//
// The ambient change is a strict TIGHTENING of that, by three rules:
//   R1  no new dispatch site — everything lands inside the existing branch
//   R2  substitution, not addition — Tier 1 elects from the same pool Tier 3
//       had, so it can never elect where Tier 3 could not
//   R3  every new gate is a suppressor — none can turn a "no" into a "yes"
//
// Every test below names the mutation that must break it. Those mutations were
// run: see the report accompanying this branch.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { __test } = require('../server/index.cjs');
const {
 agentFixture, agentSays, agoMs, assertProjectionMatchesSource, automationPost,
 channelHarness, human, messageRow, participants, systemSeed,
} = require('./helpers/messageFixture.cjs');
const { openInterlocutor } = require('../shared/ambientAddressing.cjs');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

const SCOUT = agentFixture('a-scout', 'Scout');
const CODER = agentFixture('a-coder', 'Coder');
const ROSTER = [SCOUT, CODER];

let live = null;
function drive(options) {
 live = channelHarness({ agents: ROSTER, ...options });
 live.install();
 __test.setTestDb(live.db);
 return live;
}
test.afterEach(() => {
 if (live) { live.restore(); live = null; }
 __test.resetTestState();
});

// --- the fixture itself must not be able to lie ------------------------------

test('the fixture rejects a column `messages` does not have', () => {
 // The vacuous-test trap, pinned. A shipped broadcast in this repo guarded on
 // messages.workspace_id — a column that does not exist — and its test passed
 // because the fixtures invented it. Every row below goes through messageRow.
 // MUTATION: add 'workspace_id' to ALLOWED in the helper; this test fails, and
 // so does the reason every other test here is trustworthy.
 assert.throws(() => messageRow({ workspace_id: 'w1' }), /not a column loadChannelMessages returns/);
 assert.throws(() => messageRow({ deleted_at: null }), /not a column loadChannelMessages returns/);
});

test('the fixture column list still matches the real loadChannelMessages projection', () => {
 // MUTATION: change the column list in either loadChannelMessages select
 // without updating the helper.
 assertProjectionMatchesSource();
});

// --- L1: nothing an agent writes can open a budget ---------------------------

test('L1 an agent reply is role=assistant, so it can never become a burst seed', () => {
 // Source-contract half. The behavioural half is below; both are needed,
 // because the dispatcher's rule ("seed at the last role='user'") is only a
 // loop bound if the writers actually obey it.
 // MUTATION: change either insert to role='user' — the budget then resets on
 // every agent reply and the burst never ends.
 const jobs = read('server/agent-jobs.cjs');
 const replyInserts = [...jobs.matchAll(/insert into messages \([^)]*\)\s*values \(([^)]*)\)/gi)]
  .map((match) => match[1])
  .filter((values) => values.includes("'agent'"));
 assert.ok(replyInserts.length >= 2, `expected the agent-reply inserts, found ${replyInserts.length}`);
 for (const values of replyInserts) {
  assert.ok(values.includes("'assistant'"), `an agent row must be role='assistant': ${values}`);
  assert.ok(!values.includes("'user'"), `an agent row must never be role='user': ${values}`);
 }
 const automations = read('server/automations.cjs');
 assert.match(automations, /insert into messages[\s\S]{0,200}values \(\$1, 'assistant'/);
 // ...and automations make no dispatch CALL at all, which is the separate
 // by-construction claim AGENTS.md makes about that subsystem. Matched on the
 // open paren so the two comments in that file explaining the rule do not
 // themselves satisfy it.
 assert.equal(automations.includes('continueConversation('), false);
});

test('L1b an agent-authored newest row advances the burst but never re-seeds it', async () => {
 const h = drive({
  rows: [human('kick off'), agentSays(SCOUT, 'on it')],
 });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 // The human's row is still the seed, one turn is spent, and because the newest
 // row is the agent's, no ambient election runs at all.
 assert.equal(result.reason, 'no_agent');
 assert.deepEqual(h.electedAgentIds, []);
 assert.equal(h.anthropicCalls.length, 0);
});

// --- L2: the budget is real and it is exact ----------------------------------

test('L2 max_agent_turns bounds the burst exactly, and it is checked before every election', async () => {
 // MUTATION: delete the `agentTurns >= maxTurns` check — this returns
 // 'no_agent' (or dispatches) instead of 'budget_exhausted'.
 const h = drive({
  session: { max_agent_turns: 3 },
  rows: [
   human('@scout @coder go'),
   agentSays(SCOUT, 'one'),
   agentSays(CODER, 'two'),
   agentSays(SCOUT, 'three'),
  ],
 });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(result.reason, 'budget_exhausted');
 assert.equal(result.started, false);
 assert.deepEqual(h.electedAgentIds, [], 'no agent may be elected once the budget is spent');
 assert.equal(h.anthropicCalls.length, 0, 'and no paid call is made either');
});

test('L2b one turn short of the budget still dispatches', async () => {
 // The negative of L2. Without this, deleting the whole ambient branch would
 // also make L2 pass.
 const h = drive({
  session: { max_agent_turns: 3 },
  rows: [human('@scout @coder go'), agentSays(SCOUT, 'one')],
 });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(result.reason, 'agent_busy', 'reached the busy guard, i.e. an agent WAS elected');
 assert.deepEqual(h.electedAgentIds, [CODER.id], 'the addressed agent that has not answered yet');
});

// --- L3 / L4: only a human opens an election ---------------------------------

test('L3 an agent-authored newest row reaches NO elector, free or paid', async () => {
 // MUTATION: drop `isHumanAuthored(latest)` from the ambient gate — an agent's
 // own post then elects the next agent, with no human in the loop at all.
 const h = drive({
  rows: [human('start'), agentSays(SCOUT, 'thoughts?')],
 });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, []);
 assert.equal(h.anthropicCalls.length, 0);
});

test('L4 an AUTOMATION post reaches no elector — the hole Change A closes', async () => {
 // THE test that pins Change A. An automation row is role='assistant',
 // sender_kind='automation', so it satisfies the OLD gate ("the newest row is
 // not agent-authored") while satisfying neither half of the new one.
 //
 // Unreachable today — automations never call continueConversation (asserted in
 // L1) — but AGENTS.md explicitly anticipates a dispatch_agent action landing,
 // and on that day the old gate would let a machine open a paid turn budget.
 //
 // MUTATION: revert the gate to `latestAuthorAgentId === ''`. This test fails;
 // every other test in this file still passes. That is the whole point of it.
 //
 // THE TRANSCRIPT IS LOAD-BEARING and this test was WRONG on the first attempt.
 // It originally put an agent reply between the human and the automation post —
 // which made `agentTurns` 1, so the pre-existing budget condition blocked the
 // branch and the test passed under the mutation too. It proved nothing. The
 // automation post has to be the FIRST thing after the human seed, so
 // agentTurns is 0 and Change A is the only thing standing in the way.
 //
 // Note what the old gate would do here: elect an agent to answer `burst[0]` —
 // the human's LAST message — because an automation posted afterwards.
 const h = drive({
  rows: [human('morning all'), automationPost('Nightly build finished')],
 });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, [], 'an automation may not wake an agent');
 assert.equal(h.anthropicCalls.length, 0, 'nor spend a model call deciding');
 assert.equal(result.started, false);
});

test('L4b a SCHEDULE seed reaches no ambient elector either', async () => {
 // role='user' but sender_kind='system'. Schedules always prefix @handle so
 // they route through the mention path; an un-prefixed one must fall silent
 // rather than start an ambient election. Suppressor, so this can only reduce.
 const h = drive({
  rows: [human('hi'), agentSays(SCOUT, 'hi'), systemSeed('run the nightly sweep')],
 });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, []);
 assert.equal(h.anthropicCalls.length, 0);
});

// --- L5 / L6: single winner, drawn from the same pool ------------------------

test('L5 + L6 continuity elects at most ONE agent, and only one already in the pool', () => {
 // Fuzzed, because the conditions are conjunctive and a hand-written case per
 // condition proves less than 200 shuffled transcripts do.
 // MUTATION (L5): make openInterlocutor return an array — the shape assertion
 // fails immediately.
 // MUTATION (L6): have it return an agent id not drawn from `rows` — the
 // membership assertion fails, which is the R2 "substitution, never addition"
 // property: Tier 1 may only elect where Tier 3 could have.
 const cast = [SCOUT, CODER, agentFixture('a-writer', 'Writer')];
 const humans = ['u-alice', 'u-bob'];
 let rng = 1;
 const rand = (n) => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng % n; };

 for (let iteration = 0; iteration < 200; iteration++) {
  const rows = [];
  const length = 2 + rand(9);
  for (let i = 0; i < length; i++) {
   const roll = rand(4);
   if (roll === 0) rows.push(human(`msg ${i}`, { who: humans[rand(humans.length)], at: agoMs((length - i) * 1000) }));
   else if (roll === 1) rows.push(human(`@${cast[rand(cast.length)].handle} do it`, { who: humans[rand(humans.length)], at: agoMs((length - i) * 1000) }));
   else rows.push(agentSays(cast[rand(cast.length)], `reply ${i}`, { at: agoMs((length - i) * 1000) }));
  }
  rows.push(human('follow up', { who: humans[rand(humans.length)] }));

  const pool = new Set(cast.map((agent) => String(agent.id)));
  const elected = openInterlocutor({
   rows,
   startIdx: rows.length - 1,
   nowMs: Date.now(),
   isEligible: (id) => pool.has(id),
  });
  if (elected === null) continue;
  assert.equal(typeof elected, 'object', 'one result or null — never a list');
  assert.equal(Array.isArray(elected), false, 'election is single-winner BY CONSTRUCTION');
  assert.equal(typeof elected.agentId, 'string');
  assert.ok(pool.has(elected.agentId), 'elected an agent outside the candidate pool');
  // And it must be an agent that actually SPOKE in this transcript — the pool
  // continueConversation builds is participants UNION recent authors, so an
  // agent that never spoke and is not a participant must never be elected.
  assert.ok(
   rows.some((row) => row.sender_kind === 'agent' && String(row.sender_id) === elected.agentId),
   'elected an agent that never appears in the transcript',
  );
 }
});

test('L5b the pool filter is honoured — an ineligible agent is never elected', () => {
 // The isEligible predicate is how the per-agent off switch and the enabled
 // flag reach this function. MUTATION: ignore isEligible.
 const rows = [
  human('start', { at: agoMs(3000) }),
  agentSays(SCOUT, 'here', { at: agoMs(2000) }),
  human('and the other one?'),
 ];
 assert.equal(openInterlocutor({ rows, startIdx: 2, nowMs: Date.now() })?.agentId, SCOUT.id);
 assert.equal(openInterlocutor({ rows, startIdx: 2, nowMs: Date.now(), isEligible: () => false }), null);
});

// --- L7: no new dispatch site ------------------------------------------------

test('L7 the ambient module cannot dispatch, and no new dispatch site was added', () => {
 // Crude on purpose. This is the test that catches the refactor which quietly
 // adds a waker — the one change that would break the loop bound while every
 // behavioural test above still passed.
 // MUTATION: add a continueConversation(...) call anywhere in server/index.cjs,
 // or a db/runAgentTurn require to the ambient module.
 const ambient = read('shared/ambientAddressing.cjs');
 for (const forbidden of ['getDb(', 'runAgentTurn(', 'agent_jobs', 'continueConversation(', 'fetch(', 'process.env']) {
  assert.equal(ambient.includes(forbidden), false, `shared/ambientAddressing.cjs must not reference ${forbidden}`);
 }
 // It requires exactly one thing, and that thing is pure too.
 const requires = [...ambient.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
 assert.deepEqual(requires, ['./channelMentions.cjs']);

 const server = read('server/index.cjs');
 const callSites = (server.match(/\bcontinueConversation\(\{/g) || []).length;
 assert.equal(
  callSites, 2,
  'the number of continueConversation call sites in server/index.cjs changed. '
  + 'A new one is a new waker: it needs its own budget argument and its own '
  + 'review, not a passing test.',
 );
 // And the ambient election lives INSIDE the one pre-existing branch rather
 // than beside it: the gate line still carries all four conditions.
 assert.match(server, /if \(!nextAgent && agentTurns === 0 && isHumanAuthored\(latest\) && unpromptedAllowed\)/);
});

// --- L8: the two tiers are mutually exclusive --------------------------------

test('L8 a continuity hit makes ZERO model calls, and elects the agent you were talking to', async () => {
 // The saving AND the correctness claim in one. MUTATION: remove the
 // `if (!nextAgent)` guard around the paid tier — the same message then costs a
 // call it did not need, and can nominate a different agent than Tier 1 chose.
 const h = drive({
  rows: [
   human('scout, whats the deploy status?', { at: agoMs(60_000) }),
   agentSays(SCOUT, 'green on Fly, Netlify pending', { at: agoMs(30_000) }),
   human('and the other one?'),
  ],
 });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(result.reason, 'agent_busy', 'an agent was elected (stopped at the busy guard)');
 assert.deepEqual(h.electedAgentIds, [SCOUT.id], 'the agent that just spoke');
 assert.equal(h.anthropicCalls.length, 0, 'and it cost nothing');
});

test('L8b a COLD message still reaches the paid tier, unchanged', async () => {
 // The ceiling never rises: one call, exactly as before. Without this the
 // suppressors could silently disable ambient addressing entirely and every
 // other test here would still pass.
 const h = drive({
  rows: [human('anyone know why the netlify build is red?')],
  autoInterjectPick: CODER,
 });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(h.anthropicCalls.length, 1, 'exactly one model call — never N per agent');
 assert.deepEqual(h.electedAgentIds, [CODER.id]);
 assert.equal(result.reason, 'agent_busy');
});

test('L8c the paid tier still fails CLOSED', async () => {
 // Unparseable output and a thrown request both mean "nobody answers".
 const h = drive({ rows: [human('anyone know why the build is red?')], autoInterjectPick: null });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(h.anthropicCalls.length, 1);
 assert.deepEqual(h.electedAgentIds, [], 'a null pick dispatches nobody');

 h.restore();
 live = null;
 __test.resetTestState();

 const thrown = channelHarness({ agents: ROSTER, rows: [human('anyone know why the build is red?')] });
 thrown.install();
 globalThis.fetch = async () => { throw new Error('network down'); };
 __test.setTestDb(thrown.db);
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 thrown.restore();
 assert.deepEqual(thrown.electedAgentIds, [], 'a failed relevance call dispatches nobody');
 assert.equal(result.started, false);
});

// --- the roster is not presence ---------------------------------------------

test('the candidate pool is participants + recent authors, never the whole workspace', async () => {
 // An agent that is in the workspace but not in the channel and has never
 // posted there must not be a candidate. Pinned here rather than in the gate
 // file because it is a fan-out property: a pool that grew to "every agent"
 // would make one @channel-less post reach everybody.
 const outsider = agentFixture('a-outsider', 'Outsider');
 const h = channelHarness({
  agents: [...ROSTER, outsider],
  session: { participants: participants([SCOUT, CODER]) },
  rows: [human('any thoughts?')],
  autoInterjectPick: () => outsider,
 });
 h.install();
 __test.setTestDb(h.db);
 live = h;
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 const roster = h.anthropicCalls[0].body.messages[0].content;
 assert.match(roster, /@scout/);
 assert.match(roster, /@coder/);
 assert.equal(roster.includes('@outsider'), false, 'a non-participant that never posted is not a candidate');
 assert.deepEqual(h.electedAgentIds, [], 'and cannot be elected even if the model names it');
});
