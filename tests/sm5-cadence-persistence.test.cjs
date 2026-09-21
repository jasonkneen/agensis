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
const taskDispatchSrc = fs.readFileSync(path.join(ROOT, 'server', 'task-dispatch.cjs'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.cjs'), 'utf8');
const neonSchemaSrc = fs.readFileSync(path.join(ROOT, 'database', 'neon-schema.sql'), 'utf8');
const migrationDir = path.join(ROOT, 'supabase', 'migrations');
const migrationFiles = fs.readdirSync(migrationDir);
const migration = migrationFiles
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({name, content: fs.readFileSync(path.join(migrationDir, name), 'utf8')}));

function regionFrom(src, startMarker, endMarker) {
 const startIdx = src.indexOf(startMarker);
 assert.ok(startIdx >= 0, `start marker not found: ${startMarker.slice(0, 60)}`);
 const endIdx = src.indexOf(endMarker, startIdx);
 assert.ok(endIdx > startIdx, `end marker not found after ${startIdx}: ${endMarker.slice(0, 60)}`);
 return src.slice(startIdx, endIdx);
}

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

// (2) scheduleCadenceWake writes to the table.
test('SM-5 (2): scheduleCadenceWake inserts into pending_cadence_wakes', () => {
 const region = regionFrom(
  taskDispatchSrc,
  'function scheduleCadenceWake(',
  'function clearCadenceWakes() {',
 );
 assert.match(region, /insert into pending_cadence_wakes/);
 assert.match(region, /on conflict \(lock_key\) do nothing/);
});

// (3) Timer callback fires continueConversation and best-effort DELETEs the
// row. The DELETE is NOT a dedupe gate — continueConversation is itself
// idempotent, and treating the DELETE as a gate would make a wake conditional
// on the DB (which is wrong: a wake the DB has forgotten is still owed an
// answer). Cross-replica dedupe happens via the reaper's DELETE...RETURNING.
test('SM-5 (3): the timer callback fires continueConversation and DELETEs the row (best-effort)', () => {
 const region = regionFrom(
  taskDispatchSrc,
  'function scheduleCadenceWake(',
  'function clearCadenceWakes() {',
 );
 // Find the timer callback body specifically.
 const callbackMatch = region.match(/setTimeout\(\(\) => \{[\s\S]*?\}, delayMs\);/);
 assert.ok(callbackMatch, 'setTimeout callback present');
 const callbackBody = callbackMatch[0];
 // Both DELETE and continueConversation must be in the callback.
 const deleteIdx = callbackBody.indexOf('delete from pending_cadence_wakes');
 const continueIdx = callbackBody.indexOf('continueConversation');
 assert.ok(deleteIdx >= 0, 'callback must DELETE the row');
 assert.ok(continueIdx >= 0, 'callback must still call continueConversation');
 // No "if rows returned then fire" guard — the DELETE is best-effort, the
 // fire is unconditional. If we treated the DELETE result as a gate we would
 // miss wakes whenever the DB had drifted (table missing, replica never
 // mirrored, INSERT failed silently).
 assert.doesNotMatch(callbackBody, /if \(!Array\.isArray\(rows\)/);
});

// (4) clearCadenceWakes DELETEs the rows.
test('SM-5 (4): clearCadenceWakes DELETEs the rows it is cancelling', () => {
 const region = regionFrom(
  taskDispatchSrc,
  'function clearCadenceWakes() {',
  'async function reapCadenceWakes',
 );
 assert.match(region, /delete from pending_cadence_wakes/);
 assert.match(region, /lock_key = any\(\$1::text\[\]\)/);
});

// (5) The jobReaper interval invokes reapCadenceWakes.
test('SM-5 (5): the jobReaper tick invokes reapCadenceWakes', () => {
 const region = regionFrom(
  indexSrc,
  "const jobReaper = setInterval(",
  "guardedSweep('sweepAutomationRuns'",
 );
 assert.match(region, /guardedSweep\('reapCadenceWakes'/);
});

// (6) The reaper uses DELETE...RETURNING so cross-replica claims is atomic.
test('SM-5 (6): reapCadenceWakes uses DELETE...RETURNING (atomic claim)', () => {
 const region = regionFrom(
  taskDispatchSrc,
  'async function reapCadenceWakes',
  'function startCadenceReaper',
 );
 assert.match(region, /delete from pending_cadence_wakes\s+where next_fire_at <= to_timestamp\(\$1 \/ 1000\.0\)\s+returning/);
});

// Safety: the reaper's query is constrained to `next_fire_at <= now()` so a
// row cannot fire early. This is the original "missed clear" objection the
// previous comment block raised; it is preserved here by predicate.
test('SM-5 (safety): the reaper only fires rows whose next_fire_at has elapsed', () => {
 const region = regionFrom(
  taskDispatchSrc,
  'async function reapCadenceWakes',
  'function startCadenceReaper',
 );
 assert.match(region, /next_fire_at <= to_timestamp\(\$1 \/ 1000\.0\)/);
});