// ============================================================================
// tests/mention-participant-add.test.cjs
// ----------------------------------------------------------------------------
// Auto-channels (2026-07): when a human @mentions an agent that isn't yet a
// channel participant, ensureMentionedParticipants adds it to the session
// roster so it appears in the channel AND becomes an auto-interject candidate
// for later turns. Guarantees locked in here:
//   1. A brand-new mentioned agent is appended to chat_sessions.participants
//      (with the agent_id/kind shape the reader + UI expect), exactly once.
//   2. Already-present agents and unknown handles are no-ops.
//   3. 1:1 DMs (a participant flagged direct:true) are never mutated.
//   4. Best-effort: a DB failure is swallowed (dispatch still proceeds).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const AGENTS = [
  { id: 'a-scout', name: 'Scout', handle: 'scout', enabled: true },
  { id: 'a-coder', name: 'Coder', handle: 'coder', enabled: true },
  { id: 'a-off', name: 'Disabled', handle: 'off', enabled: false },
];

function fakeDb({ session, onUpdate }) {
  return {
    async unsafe(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id, name, handle, enabled from workspace_agents')) return AGENTS;
      if (n.startsWith('update chat_sessions set participants')) {
        const merged = JSON.parse(params[0]);
        if (onUpdate) onUpdate(merged);
        return [{ ...session, participants: merged }];
      }
      return [];
    },
  };
}

test('a mentioned non-participant agent is appended to the roster once, with the right shape', async () => {
  let merged = null;
  const session = { id: 's1', participants: [] };
  __test.setTestDb(fakeDb({ session, onUpdate: (m) => { merged = m; } }));

  const added = await __test.ensureMentionedParticipants('w1', session, 'hey @scout can you look at this');
  assert.equal(added, 1, 'exactly one agent added');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].agent_id, 'a-scout');
  assert.equal(merged[0].kind, 'agent');
  assert.equal(merged[0].handle, 'scout');
  assert.equal(merged[0].direct, false, 'added participants are never marked direct');
});

test('two new mentions add both; a repeat mention is de-duped', async () => {
  let merged = null;
  const session = { id: 's1', participants: [] };
  __test.setTestDb(fakeDb({ session, onUpdate: (m) => { merged = m; } }));

  const added = await __test.ensureMentionedParticipants('w1', session, '@scout @coder @scout thoughts?');
  assert.equal(added, 2, 'scout + coder, scout not double-counted');
  assert.deepEqual(merged.map((p) => p.agent_id).sort(), ['a-coder', 'a-scout']);
});

test('an already-present agent is a no-op (no update issued)', async () => {
  let updated = false;
  const session = { id: 's1', participants: [{ kind: 'agent', agent_id: 'a-scout', name: 'Scout', handle: 'scout' }] };
  __test.setTestDb(fakeDb({ session, onUpdate: () => { updated = true; } }));

  const added = await __test.ensureMentionedParticipants('w1', session, '@scout still there?');
  assert.equal(added, 0);
  assert.equal(updated, false, 'no roster write when nothing changes');
});

test('an unknown handle adds nobody', async () => {
  const session = { id: 's1', participants: [] };
  __test.setTestDb(fakeDb({ session }));
  const added = await __test.ensureMentionedParticipants('w1', session, '@nobody hello');
  assert.equal(added, 0);
});

test('1:1 DMs (direct participant) are never mutated', async () => {
  let updated = false;
  const session = {
    id: 'dm1',
    participants: [{ kind: 'agent', agent_id: 'a-coder', name: 'Coder', handle: 'coder', direct: true }],
  };
  __test.setTestDb(fakeDb({ session, onUpdate: () => { updated = true; } }));

  const added = await __test.ensureMentionedParticipants('w1', session, '@scout come help');
  assert.equal(added, 0, 'a private DM never pulls a mentioned teammate into the roster');
  assert.equal(updated, false);
});

test('a DB failure is swallowed (best-effort; dispatch proceeds)', async () => {
  const session = { id: 's1', participants: [] };
  __test.setTestDb({
    async unsafe() { throw new Error('db down'); },
  });
  const added = await __test.ensureMentionedParticipants('w1', session, '@scout hi');
  assert.equal(added, 0, 'never throws to the dispatch caller');
});
