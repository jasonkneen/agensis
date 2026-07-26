'use strict';

// Agent identity vs a RACING human edit.
//
// applyAgentIdentity is read → merge-in-JS → write. Between the read and the
// write, a human can save an edit through /backend/db/update — and because the
// identity jsonb is written wholesale from the merge, an unconditional UPDATE
// from the stale read would destroy both the human's value AND the brand-new
// human_set flag protecting it. That is the write that defeats the guarantee
// ("an agent's declaration can never overwrite a human's choice") no matter how
// correct the merge logic is.
//
// The fix under test: every identity UPDATE is guarded on the `version` the
// merge was computed from (workspace_agents is a VERSIONED_TABLE — every writer
// bumps it). A lost race writes NOTHING; the declaration re-reads and re-merges
// against what the human actually wrote, so a field locked mid-race is honoured
// on the retry. These tests drive the real applyAgentIdentity against a scripted
// DB that loses the race on purpose.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const VOICE_A = 'f9fc912e-e650-4766-a20c-5a93a43aa6e3';

const baseRow = (overrides = {}) => ({
  id: 'agent-1',
  name: 'Coder',
  avatar: 'CO',
  accent_color: '#00a95c',
  description: '',
  soul: '',
  identity: {},
  enabled: true,
  version: 1,
  ...overrides,
});

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
const isIdentityUpdate = (sql) => norm(sql).startsWith('update workspace_agents set');
const isIdentityRead = (sql) => norm(sql).startsWith('select id, name, avatar');

test('a declaration racing a human edit retries and honours the fresh lock', async () => {
  // The human edit that lands between the agent's read and its write: avatar
  // becomes 'JK', human_set.avatar = true, version 1 -> 2.
  const freshRow = baseRow({ avatar: 'JK', identity: { human_set: { avatar: true } }, version: 2 });

  const updates = [];
  let reads = 0;
  __test.setTestDb({
    async unsafe(sql, params = []) {
      if (isIdentityUpdate(sql)) {
        updates.push({ sql: String(sql), params });
        // First attempt: computed against version 1, but the row is at 2 now.
        // The guard must make this write a no-op, not a clobber.
        if (updates.length === 1) return [];
        return [{ ...freshRow, description: 'Ships backend changes', version: 3 }];
      }
      if (isIdentityRead(sql)) {
        reads += 1;
        return [freshRow];
      }
      throw new Error(`Unexpected SQL: ${norm(sql)}`);
    },
  });

  const result = await __test.applyAgentIdentity({
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    row: baseRow(), // the STALE read: version 1, avatar unlocked
    declared: { avatar: 'CD', description: 'Ships backend changes', voice: { cartesia_voice_id: VOICE_A } },
  });

  assert.equal(updates.length, 2, 'lost race -> retry, exactly once here');
  assert.equal(reads, 1, 'the retry re-reads the row the human actually wrote');

  // Attempt 1 was computed against the stale row and guarded on its version.
  assert.match(updates[0].sql, /COALESCE\("version", 0\) = \$\d+/);
  assert.equal(updates[0].params.at(-1), 1);

  // Attempt 2 was recomputed against the FRESH row: the avatar the human just
  // chose is locked and must not appear; the unlocked description still lands.
  assert.equal(updates[1].sql.includes('"avatar"'), false, 'the mid-race human avatar survives');
  assert.match(updates[1].sql, /"description" = \$\d+/);
  assert.equal(updates[1].params.at(-1), 2, 'the retry is guarded on the fresh version');

  // And the identity written on the retry carries the human_set flag the human
  // edit created mid-race — the stale merge would have erased it.
  // Bound as an OBJECT, never a JSON string: on the porsager driver a
  // stringified bind under ::jsonb arrives as a jsonb STRING SCALAR — the bug
  // that corrupted identity.human_set into an array and made voice writes
  // throw. normalizeJsonParam now returns parsed objects, so the param IS the
  // object here; asserting a string would be asserting the corruption back.
  const identityParam = updates[1].params.find(
    (p) => p && typeof p === 'object' && !Array.isArray(p) && 'human_set' in p,
  );
  assert.ok(identityParam, 'the retry writes the identity jsonb');
  assert.deepEqual(identityParam, {
    human_set: { avatar: true },
    voice: { cartesia_voice_id: VOICE_A },
  });

  assert.equal(result.version, 3, 'the caller gets the row the guarded write returned');
});

test('an uncontended declaration writes once, still guarded', async () => {
  const updates = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      if (isIdentityUpdate(sql)) {
        updates.push({ sql: String(sql), params });
        return [baseRow({ description: 'Ships backend changes', version: 2 })];
      }
      throw new Error(`Unexpected SQL: ${norm(sql)}`);
    },
  });

  const result = await __test.applyAgentIdentity({
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    row: baseRow(),
    declared: { description: 'Ships backend changes' },
  });

  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /COALESCE\("version", 0\) = \$\d+/, 'even the happy path is version-guarded');
  assert.equal(updates[0].params.at(-1), 1);
  assert.equal(result.version, 2);
});

test('perpetual contention gives way — it NEVER falls back to an unguarded write', async () => {
  let version = 1;
  const updates = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      if (isIdentityUpdate(sql)) {
        updates.push({ sql: String(sql), params });
        return []; // someone else always wins
      }
      if (isIdentityRead(sql)) {
        version += 1;
        return [baseRow({ version })];
      }
      throw new Error(`Unexpected SQL: ${norm(sql)}`);
    },
  });

  const result = await __test.applyAgentIdentity({
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    row: baseRow(),
    declared: { description: 'Ships backend changes' },
  });

  assert.equal(result, null, 'the declaration gives way; the next reconnect declares again');
  assert.ok(updates.length >= 2 && updates.length <= 5, `bounded retries, got ${updates.length}`);
  for (const { sql } of updates) {
    assert.match(sql, /COALESCE\("version", 0\) = \$\d+/, 'every attempt is guarded — clobbering is not a fallback');
  }
});
