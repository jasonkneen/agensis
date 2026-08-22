'use strict';

// ============================================================================
// tests/ambient-off-switch.test.cjs
// ----------------------------------------------------------------------------
// workspace_agents.ambient_replies — the PER-AGENT off switch. (The per-channel
// one already existed: conversation_mode = 'mention'.)
//
// Two properties matter more than the switch working at all:
//
//   1. IT FAILS OPEN. An absent or null column reads as ON. Read strictly, every
//      agent written before the migration would go permanently silent — and
//      that failure is invisible: nothing errors, an agent simply never speaks.
//      Same discipline as normalizeConversationMode.
//   2. IT NEVER MAKES AN AGENT UNREACHABLE BY NAME. @handle, @channel, a DM and
//      a reply in the agent's own thread all dispatch regardless. An off switch
//      that silently swallowed a direct question would be the most damaging
//      possible reading of "ambient replies off".
//
// Plus the three-place schema rule (AGENTS.md): runtime DDL, neon-schema.sql,
// and a supabase migration. A column in one place and not the others is this
// repo's documented #1 footgun.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { __test } = require('../server/index.cjs');
const { ambientRepliesEnabled } = require('../shared/ambientAddressing.cjs');
const {
 agentFixture, agentSays, agoMs, channelHarness, fakeUuid, human, participants,
} = require('./helpers/messageFixture.cjs');

const repo = (rel) => path.resolve(__dirname, '..', rel);
const read = (rel) => fs.readFileSync(repo(rel), 'utf8');

const SCOUT = agentFixture(fakeUuid('a'), 'Scout');
const CODER = agentFixture(fakeUuid('b'), 'Coder');
const QUIET_SCOUT = agentFixture(fakeUuid('a'), 'Scout', { ambient_replies: false });

let live = null;
function drive({ agents, ...options }) {
 live = channelHarness({
  agents,
  session: { participants: participants(agents) },
  ...options,
 });
 live.install();
 __test.setTestDb(live.db);
 return live;
}
test.afterEach(() => {
 if (live) { live.restore(); live = null; }
 __test.resetTestState();
});

// --- the three-place schema rule ---------------------------------------------

test('ambient_replies exists in all THREE schema places', () => {
 // MUTATION: delete any one of them. Two backends share one database, and a
 // column added only to the runtime DDL exists on Fly-touched databases and
 // nowhere else.
 assert.match(
  read('server/index.cjs'),
  /ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS ambient_replies boolean NOT NULL DEFAULT true;/,
  'missing from ensureRuntimeSchema in server/index.cjs',
 );
 assert.match(
  read('database/neon-schema.sql'),
  /ambient_replies boolean NOT NULL DEFAULT true/,
  'missing from database/neon-schema.sql',
 );
 const migrations = fs.readdirSync(repo('supabase/migrations'))
  .filter((file) => read(path.join('supabase/migrations', file)).includes('ambient_replies'));
 assert.ok(migrations.length >= 1, 'no supabase migration adds ambient_replies');

 // Netlify is a request/response mirror over the same database, not a second
 // schema owner. tests/netlify-no-ddl.test.cjs keeps DDL out of that handler.
});

test('the default is true in every place that states one', () => {
 // MUTATION: change any default to false. Unprompted replies have shipped for
 // every 'auto' channel since conversation_mode landed; defaulting to false
 // would silently switch that off for everyone, with no error and no log line.
 for (const [file, pattern] of [
  ['server/index.cjs', /ambient_replies boolean NOT NULL DEFAULT true/],
  ['database/neon-schema.sql', /ambient_replies boolean NOT NULL DEFAULT true/],
 ]) {
  assert.match(read(file), pattern, `${file} must default ambient_replies to true`);
 }
});

test('both backends project ambient_replies, so the toggle does not flip on reload', () => {
 // The blank-column trap this repo has shipped twice on this exact route.
 // tests/agents-projection-parity.test.cjs diffs the two column lists
 // generically; this names the field, because a toggle that reads back as
 // undefined renders as OFF and looks like the save failed.
 // Matched as "the agents select carries ambient_replies", not as one exact
 // substring: `sharing` now sits between it and `created_by`, and the next
 // agent-level flag will sit somewhere too. What must not change is that all
 // three selects name the column — the parity test next door is what keeps the
 // rest of the list identical across the two backends.
 for (const file of ['server/workspaces-routes.cjs', 'server/index.cjs', 'netlify/functions/backend.mjs']) {
  assert.match(
   read(file),
   /enabled, ambient_replies[,\s][^;`]*?from workspace_agents/,
   `${file} select omits ambient_replies`,
  );
 }
 assert.match(read('server/index.cjs'), /ambient_replies: ambientRepliesEnabled\(agent\)/);
 assert.match(read('netlify/functions/backend.mjs'), /ambient_replies: row\.ambient_replies !== false/);
});

// --- fail open ----------------------------------------------------------------

test('an absent or null column reads as ENABLED', () => {
 // MUTATION: `Boolean(row.ambient_replies)`. Every agent row written before the
 // migration then goes silent — invisibly, which is why this is asserted rather
 // than left to the column default.
 assert.equal(ambientRepliesEnabled({ id: 'x' }), true, 'absent column');
 assert.equal(ambientRepliesEnabled({ id: 'x', ambient_replies: null }), true, 'null column');
 assert.equal(ambientRepliesEnabled({ id: 'x', ambient_replies: undefined }), true);
 assert.equal(ambientRepliesEnabled({ id: 'x', ambient_replies: true }), true);
 assert.equal(ambientRepliesEnabled({ id: 'x', ambient_replies: false }), false, 'only an explicit false opts out');
 assert.equal(ambientRepliesEnabled(null), false, 'no agent, no reply');
});

// --- the switch actually suppresses ------------------------------------------

test('an opted-out agent is not elected by the FREE tier, even mid-conversation', async () => {
 const h = drive({
  agents: [QUIET_SCOUT, CODER],
  rows: [
   human('scout, whats the deploy status?', { at: agoMs(120_000) }),
   agentSays(QUIET_SCOUT, 'green on Fly', { at: agoMs(60_000) }),
   human('and the other one?'),
  ],
  autoInterjectPick: null,
 });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, []);
});

test('an opted-out agent is not even OFFERED to the paid tier', async () => {
 // Applied to the candidate pool, so it costs less rather than more: a channel
 // where every candidate has opted out makes NO model call at all.
 const h = drive({
  agents: [QUIET_SCOUT, CODER],
  rows: [human('anyone know why the build is red?')],
  autoInterjectPick: CODER,
 });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 const roster = h.anthropicCalls[0].body.messages[0].content;
 assert.equal(roster.includes('@scout'), false, 'an opted-out agent is not a candidate');
 assert.match(roster, /@coder/);
});

test('every candidate opted out means ZERO model calls', async () => {
 const h = drive({
  agents: [QUIET_SCOUT, agentFixture(fakeUuid('b'), 'Coder', { ambient_replies: false })],
  rows: [human('anyone know why the build is red?')],
  autoInterjectPick: CODER,
 });
 const result = await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.equal(h.anthropicCalls.length, 0, 'nothing to elect between, so nothing to pay for');
 assert.deepEqual(h.electedAgentIds, []);
 assert.equal(result.reason, 'no_agent');
});

// --- and never makes the agent unreachable -----------------------------------

test('ambient_replies=false does NOT suppress an explicit @handle', async () => {
 // MUTATION: check ambientRepliesEnabled in pickMentionNextAgent, or anywhere
 // above the ambient branch. This is the failure a user would notice fastest
 // and trust least: an agent that ignores being asked by name.
 const h = drive({
  agents: [QUIET_SCOUT, CODER],
  rows: [human('@scout can you look at this?')],
 });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, [QUIET_SCOUT.id]);
});

test('ambient_replies=false does NOT suppress @channel', async () => {
 const h = drive({
  agents: [QUIET_SCOUT, CODER],
  rows: [human('@channel standup please')],
 });
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(h.electedAgentIds, [QUIET_SCOUT.id], 'first in roster order, opted out or not');
});

test('ambient_replies=false does NOT suppress a DM', async () => {
 live = channelHarness({
  agents: [QUIET_SCOUT, CODER],
  session: {
   folder: 'Direct messages',
   participants: [{ kind: 'agent', agent_id: QUIET_SCOUT.id, handle: 'scout', direct: true }],
  },
  rows: [human('quick question')],
 });
 live.install();
 __test.setTestDb(live.db);
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1' });
 assert.deepEqual(live.electedAgentIds, [QUIET_SCOUT.id]);
});

test('ambient_replies=false does NOT suppress a reply inside the agent thread', async () => {
 // The fourth way of addressing an agent directly. inferThreadAgentTarget reads
 // the thread's own rows, which is why the fixture ids are UUID-shaped — a
 // friendly id is rejected by validUuid and this test would silently pass for
 // the wrong reason.
 const root = human('kick off', { at: agoMs(180_000) });
 const answer = agentSays(QUIET_SCOUT, 'working on it', { at: agoMs(120_000) });
 const followUp = human('any update?');
 live = channelHarness({
  agents: [QUIET_SCOUT, CODER],
  session: { participants: participants([QUIET_SCOUT, CODER]) },
  rows: [root],
  threadRows: [root, answer, followUp],
 });
 live.install();
 __test.setTestDb(live.db);
 await __test.continueConversation({ workspaceId: 'w1', sessionId: 's1', threadParentId: root.id });
 assert.deepEqual(live.electedAgentIds, [QUIET_SCOUT.id]);
 assert.equal(live.anthropicCalls.length, 0);
});
