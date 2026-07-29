'use strict';

// ============================================================================
// tests/dm-scope-backfill.test.cjs
// ----------------------------------------------------------------------------
// The migration that decides who can still read their own DMs.
//
// The gate (dm-scope-assumption) and the grant path (dm-read-scope) are both
// worthless if this seeds the wrong people, and its failure mode is the quiet
// one: a session that reads as private with nobody in it is a conversation its
// own owner cannot open, and no correct gating downstream recovers from that.
//
// WHAT IS BEING PINNED is not "the SQL is unchanged" — it is the ASSUMPTION.
// Seeding the workspace owner was justified by three measurements taken against
// production (76 DMs, zero human participants, 75/76 created while the owner was
// the only human, zero non-owner-authored messages). Those are facts about one
// dataset, not laws. So the migration must:
//
//   1. seed the humans who demonstrably SPOKE, not only the inferred owner, and
//   2. REPORT loudly when the owner-only story cannot explain what it finds,
//
// and this file fails if either stops happening. A future dataset that violates
// the assumption then makes noise instead of silently orphaning someone's DM.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runDmScopeBackfill,
  SEED_OWNERS_SQL,
  SEED_SPEAKERS_SQL,
} = require('../server/dm-scope-backfill.cjs');

// Records every statement and answers the two that return rows. Deliberately
// does NOT model Postgres: the point is which statements run, in what order,
// and what the function does with what comes back.
function makeDb({ speakers = [], violations = [], failOn = null } = {}) {
  const ran = [];
  const db = async (sql) => {
    const n = String(sql).replace(/\s+/g, ' ').trim();
    ran.push(n);
    if (failOn && n.includes(failOn)) throw new Error(`boom: ${failOn}`);
    if (n.startsWith('INSERT INTO chat_session_members') && n.includes('FROM messages m')) return speakers;
    if (n.startsWith('SELECT s.id AS session_id')) return violations;
    return [];
  };
  db.ran = ran;
  return db;
}

const warnings = (calls) => calls.join('\n');

test('the happy path marks DMs private and seeds owners before anything else', async () => {
  const db = makeDb();
  const warned = [];
  const report = await runDmScopeBackfill(db, { warn: (...a) => warned.push(a.join(' ')) });

  assert.equal(report.markedDms, true);
  assert.equal(report.seededOwners, true);
  assert.equal(report.markedDerived, true);
  assert.equal(report.speakersSeeded, 0);
  assert.deepEqual(report.violations, []);
  assert.equal(warned.length, 0, 'a clean dataset must be silent — noise here would train people to ignore it');

  // ORDER IS THE ASSERTION. Marking a session private before anybody is seeded
  // into it is the window in which its owner cannot read it.
  const markIndex = db.ran.findIndex((s) => s.startsWith('UPDATE chat_sessions SET visibility'));
  const seedIndex = db.ran.findIndex((s) => s.startsWith('INSERT INTO chat_session_members') && s.includes('JOIN workspaces w'));
  assert.ok(markIndex >= 0 && seedIndex > markIndex, 'owners must be seeded immediately after the marking, in the same step');
});

test('owners are seeded ONLY into sessions that have no members at all', async () => {
  // Fill-the-void, not restore-the-world. Without the NOT EXISTS, every boot
  // would resurrect anybody a revoke had removed — turning the revoke route
  // into something that undoes itself on the next deploy.
  const sql = SEED_OWNERS_SQL.replace(/\s+/g, ' ');
  assert.match(
    sql,
    /NOT EXISTS \(SELECT 1 FROM chat_session_members m WHERE m\.session_id = s\.id\)/,
    'the owner seed must skip sessions that already have members',
  );
  assert.match(sql, /ON CONFLICT DO NOTHING/, 'and must never overwrite an existing row');
  assert.match(sql, /'participant'/, "seeded rows must be participants, or a revoke could strip a DM's owner");
});

test('a human who SPOKE in a private session is seeded, and it is announced', async () => {
  // The step that makes this correct by construction rather than by luck.
  const db = makeDb({ speakers: [{ session_id: 'dm-1', user_id: 'other-human' }] });
  const warned = [];
  const report = await runDmScopeBackfill(db, { warn: (...a) => warned.push(a.join(' ')) });

  assert.equal(report.speakersSeeded, 1);
  assert.match(warnings(warned), /seeded 1 human participant/i, 'seeding beyond the owner must be reported, not silent');
});

test('the speaker seed keys on message authorship, not on the owner', async () => {
  const sql = SEED_SPEAKERS_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /FROM messages m/, 'evidence comes from who actually posted');
  assert.match(sql, /m\.sender_kind = 'user'/, 'only humans — an agent is not a chat_session_members row');
  assert.doesNotMatch(sql, /workspaces/, 'this step must not fall back to inferring the owner');
  // A non-uuid sender_id would abort the whole migration on the ::uuid cast,
  // and production has 1432 message rows with an empty sender_kind.
  assert.match(sql, /\^\[0-9a-fA-F-\]\{36\}\$/, 'sender_id must be shape-checked before casting to uuid');
});

test('a dataset that breaks the owner-only assumption is reported LOUDLY, with ids', async () => {
  // THE POINT OF THIS FILE. The migration is allowed to be wrong about a future
  // dataset; it is not allowed to be quietly wrong about one.
  const db = makeDb({
    speakers: [{ session_id: 'dm-1', user_id: 'other-human' }],
    violations: [{ session_id: 'dm-1', workspace_id: 'w1', sender_id: 'other-human' }],
  });
  const warned = [];
  const report = await runDmScopeBackfill(db, { warn: (...a) => warned.push(a.join(' ')) });

  assert.equal(report.violations.length, 1);
  const text = warnings(warned);
  assert.match(text, /owner-only migration assumption does not hold/i);
  assert.match(text, /dm-1/, 'the warning must name the session, or nobody can act on it');
  assert.match(text, /other-human/, 'and the person');
});

test('a violated assumption still GRANTS access — it never locks the speaker out', async () => {
  // The safe outcome must have already happened by the time anyone reads the
  // warning. Reporting a problem while withholding the fix would be the same
  // orphaned-DM failure with better logging.
  const db = makeDb({
    speakers: [{ session_id: 'dm-1', user_id: 'other-human' }],
    violations: [{ session_id: 'dm-1', workspace_id: 'w1', sender_id: 'other-human' }],
  });
  await runDmScopeBackfill(db, { warn: () => {} });

  const seedIndex = db.ran.findIndex((s) => s.includes('FROM messages m'));
  const checkIndex = db.ran.findIndex((s) => s.startsWith('SELECT s.id AS session_id'));
  assert.ok(seedIndex >= 0, 'the speaker seed must actually run');
  assert.ok(checkIndex > seedIndex, 'access is granted BEFORE the problem is reported, not instead of it');
});

test('it never throws — a data surprise must not take the schema bootstrap down', async () => {
  // ensureRuntimeSchema runs on every boot. An exception here is an outage.
  for (const failOn of ['UPDATE chat_sessions SET visibility', 'FROM messages m', 'WITH RECURSIVE edges']) {
    const db = makeDb({ failOn });
    const warned = [];
    await assert.doesNotReject(() => runDmScopeBackfill(db, { warn: (...a) => warned.push(a.join(' ')) }));
    assert.ok(warned.length > 0, `a failure of "${failOn}" must be reported`);
  }
});

test('a failure of the FIRST step stops the rest', async () => {
  // The dangerous ordering. If marking succeeded but seeding did not, sessions
  // would be private with no members; the two are one step precisely so a
  // failure cannot land between them, and nothing downstream should proceed on
  // a half-applied migration.
  const db = makeDb({ failOn: 'UPDATE chat_sessions SET visibility' });
  const report = await runDmScopeBackfill(db, { warn: () => {} });
  assert.equal(report.markedDms, false);
  assert.equal(report.markedDerived, false, 'the derived pass must not run after the base pass failed');
  assert.ok(!db.ran.some((s) => s.includes('WITH RECURSIVE edges')));
});

test('derived sessions inherit privacy through all THREE lineage edges', async () => {
  // 12 sub-thread sessions hang off DM messages and 38 huddle sessions carry a
  // copied DM roster in production. Miss an edge and those keep leaking the
  // conversation they were split out of — a partial fix, which reads as privacy
  // while leaving paths open.
  const db = makeDb();
  await runDmScopeBackfill(db, { warn: () => {} });
  const derived = db.ran.find((s) => s.includes('WITH RECURSIVE edges'));
  assert.ok(derived, 'the derived pass must run');
  assert.match(derived, /c\.split_parent_id IS NOT NULL/, 'forks');
  assert.match(derived, /m\.id = c\.parent_message_id/, 'sub-threads');
  assert.match(derived, /h\.transcript_session_id/, 'huddle transcripts');
  // UNION, not UNION ALL, on the recursive term — the cycle guard.
  assert.match(derived, /UNION SELECT e\.child FROM edges e JOIN lineage l/, 'the walk must dedupe or a cyclic split chain hangs it');
});

test('owners are re-seeded after the derived pass', async () => {
  // A sub-thread only becomes private during the derived pass, so the seed that
  // ran before it never saw the row. Without the second pass those sessions are
  // private with no members.
  const db = makeDb();
  await runDmScopeBackfill(db, { warn: () => {} });
  const ownerSeeds = db.ran.filter((s) => s.startsWith('INSERT INTO chat_session_members') && s.includes('JOIN workspaces w'));
  assert.equal(ownerSeeds.length, 2, 'the owner seed must run both before and after the lineage marking');
});

test('the migration SQL file carries the same speaker seed as the runtime path', () => {
  // The three-place schema rule. A fresh Neon database applies the .sql file and
  // never runs ensureRuntimeSchema, so an evidence step that exists only in the
  // runtime path would leave that database seeded on the assumption alone.
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20260730130000_dm_read_scope.sql'), 'utf8',
  ).replace(/\s+/g, ' ');
  assert.match(sql, /INSERT INTO chat_session_members[\s\S]*FROM messages m/i);
  assert.match(sql, /m\.sender_kind = 'user'/);
  assert.match(sql, /WITH RECURSIVE edges/i, 'and the derived-session inheritance');
});
