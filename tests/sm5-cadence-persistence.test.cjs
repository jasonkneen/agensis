'use strict';

// SM-5 contract test (docs/queue-plumbing-audit-2026-09-21.md):
//
//   "scheduleCadenceWake stores a setTimeout in a Map with no DB shadow. On
//    multi-replica deploys, a message on replica B can never trigger a wake
//    scheduled on replica A, and any replica restart loses every scheduled
//    wake with no recovery. The social-channel continues path sets a single
//    wake per channel+agent; on a multi-replica deploy, this is race-prone."
//
// The fix wires cadence wakes through a durable `pending_cadence_wakes`
// table that exists in all three schema-sync places (runtime bootstrap,
// canonical schema, migration), and adds a reaper that recovers rows the
// in-process timer can no longer fire (lost on restart, lost on a different
// replica).
//
// Properties pinned here:
//   1. The table exists in the migration, the canonical neon-schema.sql,
//      AND the runtime bootstrap CREATE TABLE block. Missing any one drifts
//      a fresh DB. (See AGENTS.md "Schema changes: update THREE places".)
//   2. scheduleCadenceWake now INSERTs into the table.
//   3. The timer callback DELETEs the row (with RETURNING) BEFORE firing
//      continueConversation, so a row that another replica already claimed
//      does not double-fire.
//   4. clearCadenceWakes DELETEs the rows in the same call that cancels
//      the in-process timers — a missed clear cannot leave a stale wake
//      that re-answers an old message on a timer.
//   5. The jobReaper interval in index.cjs invokes reapCadenceWakes on every
//      tick, so an orphan row has at most one tick (30s) of latency.
//   6. The reaper's DELETE...RETURNING pattern is the atomic primitive that
//      prevents cross-replica double-fires — only the row that wins the
//      DELETE gets to fire continueConversation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.cjs'), 'utf8');
const neonSchemaSrc = fs.readFileSync(path.join(ROOT, 'database', 'neon-schema.sql'), 'utf8');
const migrationDir = path.join(ROOT, 'supabase', 'migrations');
const migrationFiles = fs.readdirSync(migrationDir);
const migration = migrationFiles
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({name, content: fs.readFileSync(path.join(migrationDir, name), 'utf8')}));

// (1) Three-place schema sync.
test('SM-5 (1a): runtime bootstrap creates pending_cadence_wakes', () => {
 assert.match(indexSrc, /CREATE TABLE IF NOT EXISTS pending_cadence_wakes/);
 assert.match(indexSrc, /idx_pending_cadence_wakes_next_fire_at/);
});

test('SM-5 (1b): canonical neon-schema.sql creates pending_cadence_wakes', () => {
 assert.match(neonSchemaSrc, /CREATE TABLE IF NOT EXISTS pending_cadence_wakes/);
 assert.match(neonSchemaSrc, /idx_pending_cadence_wakes_next_fire_at/);
});

test('SM-5 (1c): a Supabase migration creates pending_cadence_wakes', () => {
 const hits = migration.filter((m) => /CREATE TABLE IF NOT EXISTS pending_cadence_wakes/.test(m.content));
 assert.ok(hits.length >= 1, 'at least one migration file must create pending_cadence_wakes');
});

test('the reaper remains wired to the server tick', () => {
 assert.match(indexSrc, /guardedSweep\('reapCadenceWakes', taskDispatch.reapCadenceWakes\)/);
});

test('unassigned cadence wakes are supported in every schema lane', () => {
 for (const source of [indexSrc, neonSchemaSrc]) {
  const table = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS pending_cadence_wakes'));
  assert.match(table.slice(0, table.indexOf(');')), /agent_id uuid REFERENCES/);
  assert.match(source, /ALTER TABLE pending_cadence_wakes ALTER COLUMN agent_id DROP NOT NULL/);
 }
 assert.ok(migration.some(m => /ALTER TABLE pending_cadence_wakes ALTER COLUMN agent_id DROP NOT NULL/.test(m.content)));
});
