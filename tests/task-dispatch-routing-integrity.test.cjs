'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const core = require('../shared/backend-core.cjs');

function read(relativePath) {
 return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('queued task requester exists in runtime, canonical schema, and one migration', () => {
 const runtime = read('server/index.cjs');
 const canonical = read('database/neon-schema.sql');
 const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .map((name) => read(path.join('supabase/migrations', name)));

 assert.match(runtime, /ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatch_requested_by uuid/);
 assert.match(canonical, /ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatch_requested_by uuid/);
 assert.equal(
  migrations.filter((sql) => /ADD COLUMN IF NOT EXISTS dispatch_requested_by uuid/.test(sql)).length,
  1,
 );
});

test('task attribution and queue routing are server-authored and not generically readable', () => {
 const forged = core.stripPrivilegedDbValues('tasks', {
  title: 'Ship',
  created_by: 'attacker',
  dispatch_requested_by: 'victim',
 });
 assert.deepEqual(forged, { title: 'Ship' });

 const created = core.stampTaskWriteIdentity(
  'tasks',
  { title: 'Ship', assignee_id: 'agent-1' },
  'human-b',
  { insert: true },
 );
 assert.equal(created.created_by, 'human-b');
 assert.equal(created.dispatch_requested_by, 'human-b');

 const unassigned = core.stampTaskWriteIdentity(
  'tasks',
  { assignee_id: null },
  'human-b',
 );
 assert.equal(
  Object.prototype.hasOwnProperty.call(unassigned, 'dispatch_requested_by'),
  false,
  'an update needs the stored assignee before it can decide whether routing changed',
 );

 const conditional = core.taskDispatchRequesterSql('$1', '$2');
 assert.match(conditional, /"assignee_id" IS DISTINCT FROM \$1/);
 assert.match(conditional, /THEN \$2/);
 assert.match(conditional, /ELSE "dispatch_requested_by"/);

 assert.equal(
  core.safeSelectColumns('tasks', '*').includes('dispatch_requested_by'),
  false,
 );

 const { __test } = require('../server/index.cjs');
 const raw = {
  id: 'task-1',
  workspace_id: 'workspace-1',
  title: 'Ship',
  dispatch_requested_by: 'human-b',
 };
 const sanitized = __test.sanitizeRealtimeRow('tasks', raw);
 assert.equal(
  Object.prototype.hasOwnProperty.call(sanitized, 'dispatch_requested_by'),
  false,
  'private-DM routing provenance must not ride a workspace-wide task broadcast',
 );
 assert.equal(sanitized.title, 'Ship');
 assert.equal(raw.dispatch_requested_by, 'human-b', 'the sanitizer must not mutate its input');
});

test('both generic backend lanes stamp task identity before insert and update', () => {
 for (const relativePath of ['server/index.cjs', 'netlify/functions/backend.mjs']) {
  const source = read(relativePath);
  assert.match(
   source,
   /stampTaskWriteIdentity\(table, next, (?:req\.userId|userId), \{ insert: true \}\)/,
   `${relativePath} insert stamp`,
  );
  assert.match(
   source,
   /stampTaskWriteIdentity\([\s\S]{0,100}stripPrivilegedDbValues\(table, values\)[\s\S]{0,100}(?:req\.userId|userId)/,
   `${relativePath} update stamp`,
  );
  assert.match(
   source,
   /taskDispatchRequesterSql\(assigneeBind, requesterBind\)/,
   `${relativePath} must preserve the stored requester when assignee_id did not really change`,
  );
 }
});
