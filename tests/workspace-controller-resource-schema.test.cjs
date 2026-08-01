'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/backend-core.cjs');

const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'server/index.cjs'), 'utf8');
const canonical = fs.readFileSync(path.join(root, 'database/neon-schema.sql'), 'utf8');
const migration = fs.readFileSync(
 path.join(root, 'supabase/migrations/20260731210000_workspace_controllers_resources.sql'),
 'utf8',
);
const softDeleteMigration = fs.readFileSync(
 path.join(root, 'supabase/migrations/20260801090000_workspace_resources_soft_delete.sql'),
 'utf8',
);
const progressMigration = fs.readFileSync(
 path.join(root, 'supabase/migrations/20260801120000_resource_operation_progress.sql'),
 'utf8',
);
const netlify = fs.readFileSync(path.join(root, 'netlify/functions/backend.mjs'), 'utf8');

test('controller/resource schema exists in runtime, canonical, and migration owners', () => {
 for (const [where, source] of [
  ['runtime', runtime],
  ['canonical', canonical],
  ['migration', migration],
 ]) {
  assert.match(source, /CREATE TABLE IF NOT EXISTS workspace_controllers/i, `${where}: controllers`);
  assert.match(source, /CREATE TABLE IF NOT EXISTS workspace_resources/i, `${where}: resources`);
  assert.match(source, /CREATE TABLE IF NOT EXISTS resource_operations/i, `${where}: operations`);
  assert.match(source, /workspace_agents ADD COLUMN IF NOT EXISTS controller_id uuid/i, `${where}: agent lineage`);
  assert.match(source, /agent_registrations ADD COLUMN IF NOT EXISTS controller_id uuid/i, `${where}: registration lineage`);
  assert.match(source, /workspace_join_links ADD COLUMN IF NOT EXISTS grant_kind text/i, `${where}: grant kind`);
  assert.match(source, /redeemed_controller_id/i, `${where}: redeemed controller lineage`);
  assert.match(source, /num_nonnulls\(requested_by_user_id, requested_by_agent_id, requested_by_controller_id, requested_by_workspace_id\) = 1/i);
  assert.match(source, /requested_by_workspace_id uuid/i);
  assert.match(source, /requested_by_(?:user|agent|controller)_id uuid[^\n]*ON DELETE RESTRICT/i);
  assert.match(source, /workspace_agents_controller_workspace_fkey/i);
  assert.match(source, /workspace_resources_controller_workspace_fkey/i);
  assert.match(source, /workspace_controllers_parent_workspace_fkey/i);
  assert.match(source, /UNIQUE \(workspace_id, requester_key, idempotency_key\)/i);
  assert.match(source, /progress jsonb/i, `${where}: operation progress`);
  assert.match(source, /progress_seq bigint/i, `${where}: operation progress sequence`);
 }
 assert.match(runtime, /deleted_at timestamptz/i, 'runtime: soft delete marker');
 assert.match(canonical, /deleted_at timestamptz/i, 'canonical: soft delete marker');
 assert.match(canonical, /idx_workspace_resources_deleted/i, 'canonical: soft delete index');
 assert.match(softDeleteMigration, /ALTER TABLE workspace_resources[\s\S]*ADD COLUMN IF NOT EXISTS deleted_at timestamptz/i);
 assert.match(softDeleteMigration, /idx_workspace_resources_deleted/i);
});

test('resource-operation progress migration is forward-only and constrained', () => {
 assert.match(progressMigration, /ADD COLUMN IF NOT EXISTS progress jsonb/i);
 assert.match(progressMigration, /ADD COLUMN IF NOT EXISTS progress_seq bigint/i);
 assert.match(progressMigration, /resource_operations_progress_object_check/i);
 assert.match(progressMigration, /resource_operations_progress_seq_check/i);
});

test('controller scope shape cannot express owner, private-read, vault, role, or escalation authority', () => {
 for (const source of [runtime, canonical, migration]) {
  const controller = source.slice(
   source.indexOf('CREATE TABLE IF NOT EXISTS workspace_controllers'),
   source.indexOf('CREATE TABLE IF NOT EXISTS workspace_resources'),
  );
  for (const allowed of [
   'agents:register',
   'agents:manage_own',
   'resources:create',
   'resources:manage_own',
 ]) {
   assert.match(controller, new RegExp(allowed.replace(':', '\\:')));
  }
  for (const forbidden of [
   'private_sessions:read',
   'messages:post_anywhere',
   'vault:read_raw',
   'roles:grant',
   'credentials:escalate',
  ]) {
   assert.equal(controller.includes(forbidden), false, `schema must not carry ${forbidden}`);
  }
 }
});

test('controllers, resources, and artifacts are unreachable through generic DB/realtime surfaces', () => {
 for (const table of ['workspace_controllers', 'workspace_resources', 'resource_operations']) {
  assert.equal(core.ALLOWED_TABLES.has(table), false, `${table} must not be generically selectable/subscribable`);
  assert.equal(core.WORKSPACE_SCOPED_TABLES.has(table), false, `${table} has dedicated authorization only`);
  assert.equal(Object.hasOwn(core.DB_TABLE_ACCESS, table), false, `${table} has no generic write capability`);
 }
 const frontend = fs.readFileSync(path.join(root, 'src/lib/backendClient.ts'), 'utf8');
 assert.equal(frontend.includes(".from('workspace_controllers')"), false);
 assert.equal(frontend.includes(".from('workspace_resources')"), false);
 assert.equal(frontend.includes(".from('resource_operations')"), false);
});

test('Netlify remains DDL-free and does not become a second schema owner', () => {
 assert.equal(/CREATE TABLE IF NOT EXISTS workspace_controllers/i.test(netlify), false);
 assert.equal(/CREATE TABLE IF NOT EXISTS workspace_resources/i.test(netlify), false);
 assert.equal(/CREATE TABLE IF NOT EXISTS resource_operations/i.test(netlify), false);
});

test('credential and resource lifecycle actions are in the closed audit vocabulary', () => {
 for (const action of [
  'controller.enrollment_created',
  'controller.enrolled',
  'controller.revoked',
  'resource.created',
  'resource.updated',
  'resource.deleted',
  'resource.restored',
  'resource.operation_requested',
  'resource.operation_settled',
 ]) {
  assert.equal(core.AUDIT_ACTIONS.has(action), true, action);
 }
});

test('the controller verifier runs before the legacy singleton workspace bearer', () => {
 const chain = runtime.slice(runtime.indexOf('async function verifyMcpToken'), runtime.indexOf('function createWorkspaceMcpToken'));
 assert.ok(chain.indexOf('verifyControllerToken') > -1);
 assert.ok(chain.indexOf('verifyWorkspaceMcpToken') > -1);
 assert.ok(chain.indexOf('verifyControllerToken') < chain.indexOf('verifyWorkspaceMcpToken'));
});
