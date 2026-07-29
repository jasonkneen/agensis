'use strict';

// ============================================================================
// tests/audit-log-schema.test.cjs
// ----------------------------------------------------------------------------
// The three-place schema rule (AGENTS.md), applied to audit_log: the table must
// be declared in server/index.cjs ensureRuntimeSchema (runs on Fly boot),
// database/neon-schema.sql (a fresh Neon push) and supabase/migrations. Drift
// between them is this repo's documented #1 footgun.
//
// Plus the two column choices that are load-bearing rather than incidental, and
// the immutability trigger, asserted in all three.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const MIGRATION = 'supabase/migrations/20260730000000_audit_log.sql';

function sources() {
  return {
    runtime: read('server/index.cjs'),
    canonical: read('database/neon-schema.sql'),
    migration: read(MIGRATION),
  };
}

test('audit_log is created in all three schema places', () => {
  for (const [place, source] of Object.entries(sources())) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS audit_log \(/, `${place} is missing the table`);
    assert.match(source, /CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_created/, `${place} index`);
    assert.match(source, /CREATE INDEX IF NOT EXISTS idx_audit_log_action/, `${place} index`);
    assert.match(source, /CREATE INDEX IF NOT EXISTS idx_audit_log_actor/, `${place} index`);
    assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_seq/, `${place} seq index`);
  }
});

test('workspace_id is ON DELETE SET NULL, never CASCADE', () => {
  // Deliberate and worth defending: every other workspace-scoped table cascades.
  // An audit log must not. "Someone deleted the workspace" is the single most
  // audit-worthy action there is, and CASCADE would erase the evidence of it as
  // a side effect of committing it. That is also why the column is nullable.
  // MUTATION: change it to ON DELETE CASCADE -> this fails.
  for (const [place, source] of Object.entries(sources())) {
    const table = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS audit_log ('));
    const body = table.slice(0, table.indexOf(');'));
    assert.match(body, /workspace_id uuid REFERENCES workspaces\(id\) ON DELETE SET NULL/, place);
    assert.equal(/workspace_id[^\n]*CASCADE/.test(body), false, `${place} cascades — it must not`);
    assert.equal(/workspace_id uuid NOT NULL/.test(body), false, `${place} makes workspace_id NOT NULL`);
  }
});

test('before_value and after_value are text, not jsonb', () => {
  // They hold short scalars ('editor' -> 'admin'). Typed as text they cannot
  // quietly become the place someone dumps a whole row, and with it a secret.
  for (const [place, source] of Object.entries(sources())) {
    const table = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS audit_log ('));
    const body = table.slice(0, table.indexOf(');'));
    assert.match(body, /before_value text NOT NULL DEFAULT ''/, place);
    assert.match(body, /after_value text NOT NULL DEFAULT ''/, place);
    assert.match(body, /entry_hash text NOT NULL DEFAULT ''/, place);
    assert.match(body, /seq bigserial NOT NULL/, place);
  }
});

test('the immutability trigger is declared in all three places and is idempotent', () => {
  // Same shape as the one trigger precedent in this schema
  // (trg_workspaces_reject_parent_cycle): CREATE OR REPLACE FUNCTION /
  // DROP TRIGGER IF EXISTS / CREATE TRIGGER, so it survives repeated Fly boots.
  for (const [place, source] of Object.entries(sources())) {
    assert.match(source, /CREATE OR REPLACE FUNCTION audit_log_refuse_mutation\(\)/, place);
    assert.match(source, /DROP TRIGGER IF EXISTS trg_audit_log_refuse_mutation ON audit_log;/, place);
    assert.match(source, /BEFORE UPDATE OR DELETE ON audit_log/, place);
    assert.match(source, /audit_log rows are immutable/, place);
    // The 400-day carve-out: a blanket DELETE refusal would make retention
    // pruning impossible without dropping the trigger, and a trigger dropped for
    // maintenance is a trigger that stays off.
    assert.match(source, /interval '400 days'/, place);
    assert.match(source, /USING ERRCODE = 'check_violation'/, place);
  }
});

test('audit_log is created after workspaces in neon-schema.sql', () => {
  // neon-schema.sql is applied top-to-bottom by psql with ON_ERROR_STOP=1, so a
  // forward REFERENCES breaks fresh-DB provisioning outright. It has happened.
  const lines = read('database/neon-schema.sql').split('\n');
  const lineOf = (table) => lines.findIndex(line => new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`).test(line));
  const audit = lineOf('audit_log');
  const workspaces = lineOf('workspaces');
  assert.ok(audit > 0, 'audit_log missing from neon-schema.sql');
  assert.ok(workspaces > 0 && workspaces < audit, 'audit_log must be created after workspaces');
});

test('exactly one audit_log migration exists', () => {
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter(name => name.endsWith('_audit_log.sql'));
  assert.deepEqual(migrations, ['20260730000000_audit_log.sql']);
});

test('the runtime DDL sits inside ensureRuntimeSchema', () => {
  // It must run on Fly boot. Sitting outside that function it would never run.
  const runtime = read('server/index.cjs');
  const start = runtime.indexOf('async function ensureRuntimeSchema()');
  assert.ok(start > 0);
  const ddl = runtime.indexOf('CREATE TABLE IF NOT EXISTS audit_log (');
  assert.ok(ddl > start, 'the audit_log DDL is before ensureRuntimeSchema');
  // Bounded by the next top-level function declaration after ensureRuntimeSchema.
  const end = runtime.indexOf('\nasync function ', start + 10);
  assert.ok(ddl < end, 'the audit_log DDL fell outside ensureRuntimeSchema');
});
