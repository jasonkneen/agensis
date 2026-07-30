'use strict';

// ============================================================================
// tests/turn-budget-toolsteps.test.cjs
// ----------------------------------------------------------------------------
// `max_agent_turns` counts TURNS, not rows.
//
// A tool chip is written with `sender_kind: 'agent'` exactly like a reply, so
// counting agent rows meant one answer that used ten tools spent ten turns of
// the budget. In a threaded conversation a single tool-heavy reply could
// therefore exhaust the whole allowance on its own, and `continueConversation`
// returned `budget_exhausted` before reaching any election branch — the agent
// simply stopped answering, with nothing on screen to say why.
//
// The direction was always SAFE (over-tight, never looser: the loop bound was
// strengthened, not weakened), which is precisely why it survived — it fails
// silently rather than badly. That also makes it the most likely thing to be
// misreported as an ambient-addressing bug, since ambient work is what finally
// made a stalled conversation visible.
//
// Every row here goes through `messageRow`, whose allowed keys are exactly the
// `loadChannelMessages` projection and which throws on anything else — so these
// cannot pass by inventing a column production never returns.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');
const {
 agentFixture, agentSays, channelHarness, human, messageRow, participants,
} = require('./helpers/messageFixture.cjs');

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

/** One agent reply followed by `n` tool chips — what a tool-heavy turn looks like. */
function replyWithTools(agent, text, n) {
 const rows = [agentSays(agent, text)];
 for (let i = 0; i < n; i += 1) {
  rows.push(messageRow({
   role: 'assistant',
   sender_kind: 'agent',
   sender_id: agent.id,
   sender_name: agent.name,
   message_kind: 'tool_step',
   tool_name: 'Bash',
   tool_detail: `grep -n thing-${i} src/`,
   content: '',
  }));
 }
 return rows;
}

test('a tool chip does not spend a turn of the budget', async () => {
 // max_agent_turns 4, and ONE reply carrying 10 tool chips. Counting rows makes
 // that 11 turns and the conversation is over; counting turns makes it 1.
 drive({
  session: { max_agent_turns: 4 },
  rows: [
   human('@scout can you look at the failing build?'),
   ...replyWithTools(SCOUT, 'Looking now.', 10),
  ],
  participants: participants(ROSTER),
 });

 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });

 assert.notEqual(
  result.reason,
  'budget_exhausted',
  'ten tool chips from a single reply must not exhaust a four-turn budget',
 );
});

test('CONTROL: real replies still spend the budget, so the loop bound holds', async () => {
 // Without this, `return 0` would satisfy the test above while removing the
 // only thing bounding an agent-to-agent loop. Four real replies against a
 // budget of four must stop.
 drive({
  session: { max_agent_turns: 4 },
  rows: [
   human('anyone know why the build is red?'),
   agentSays(SCOUT, 'one'),
   agentSays(CODER, 'two'),
   agentSays(SCOUT, 'three'),
   agentSays(CODER, 'four'),
  ],
  participants: participants(ROSTER),
 });

 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });

 assert.equal(
  result.reason,
  'budget_exhausted',
  'four real replies against a budget of four must still stop the burst',
 );
});

test('CONTROL: chips mixed among replies are discounted, replies are not', async () => {
 // The interesting middle case: 3 real replies + 6 chips against a budget of 4.
 // Row-counting says 9 (stop). Turn-counting says 3 (keep going).
 drive({
  session: { max_agent_turns: 4 },
  rows: [
   human('@scout @coder take a look'),
   ...replyWithTools(SCOUT, 'one', 3),
   ...replyWithTools(CODER, 'two', 3),
   agentSays(SCOUT, 'three'),
  ],
  participants: participants(ROSTER),
 });

 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });

 assert.notEqual(result.reason, 'budget_exhausted', 'three replies is under a budget of four');
});
