'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('agent_jobs exists in runtime, canonical schema, and a forward migration', () => {
  const runtime = read('server/index.cjs');
  const canonical = read('database/neon-schema.sql');
  const migration = read('supabase/migrations/20260731160000_agent_jobs_canonical.sql');

  for (const [label, source] of [
    ['runtime bootstrap', runtime],
    ['canonical schema', canonical],
    ['forward migration', migration],
  ]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS agent_jobs\s*\(/i, `${label} must create agent_jobs`);
    assert.match(source, /idx_agent_jobs_workspace_id/i, `${label} must index workspace scope`);
    assert.match(source, /idx_agent_jobs_session_id/i, `${label} must index session scope`);
    assert.match(source, /uq_agent_jobs_active_per_session_agent/i, `${label} must prevent duplicate active turns`);
  }
});

test('the migration heals active duplicates before creating the unique index', () => {
  const migration = read('supabase/migrations/20260731160000_agent_jobs_canonical.sql');
  const dedupe = migration.indexOf('DELETE FROM agent_jobs');
  const unique = migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_jobs_active_per_session_agent');
  assert.ok(dedupe >= 0 && unique > dedupe);
  assert.match(migration, /status IN \('queued', 'running'\)/);
});
