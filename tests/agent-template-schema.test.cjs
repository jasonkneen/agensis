'use strict';

// ============================================================================
// tests/agent-template-schema.test.cjs
// ----------------------------------------------------------------------------
// The three-place schema rule applied to workspace_agent_templates, plus the
// assertion that matters most for this table: the PRIVILEGE-BEARING COLUMNS ARE
// ABSENT, in every one of the three places.
//
// That absence is the security control. A filter can be bypassed by a field
// nobody anticipated; a column that does not exist cannot be written to at all.
// So this file checks not only that the three declarations agree, but that none
// of them has quietly grown a permission_mode or a metadata column.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const MIGRATION = 'supabase/migrations/20260730160000_workspace_agent_templates.sql';

function sources() {
 return {
  runtime: read('server/index.cjs'),
  canonical: read('database/neon-schema.sql'),
  migration: read(MIGRATION),
 };
}

/** The CREATE TABLE body for the template table in one source. */
function tableBody(source) {
 const start = source.indexOf('CREATE TABLE IF NOT EXISTS workspace_agent_templates (');
 assert.ok(start >= 0, 'the table is missing entirely');
 const body = source.slice(start);
 return body.slice(0, body.indexOf(');'));
}

/** Column names declared in a CREATE TABLE body, ignoring comments. */
function columnsOf(body) {
 return body
  .split('\n')
  .map((line) => line.replace(/--.*$/, '').trim())
  .filter((line) => line && !line.startsWith('CREATE TABLE') && !line.startsWith('UNIQUE'))
  .map((line) => line.split(/\s+/)[0].replace(/,$/, ''))
  .filter((name) => /^[a-z_]+$/.test(name));
}

test('workspace_agent_templates is created in all three schema places', () => {
 for (const [place, source] of Object.entries(sources())) {
  assert.match(source, /CREATE TABLE IF NOT EXISTS workspace_agent_templates \(/, `${place} is missing the table`);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_workspace_agent_templates_workspace_id/, `${place} index`);
 }
});

test('the three declarations agree on the exact column set', () => {
 // MUTATION: add a column to ensureRuntimeSchema only -> this fails naming the
 // two files that lack it. Three-place drift is this repo's documented #1 footgun.
 const entries = Object.entries(sources()).map(([place, source]) => [place, columnsOf(tableBody(source)).sort()]);
 const [firstPlace, firstColumns] = entries[0];
 for (const [place, columns] of entries.slice(1)) {
  assert.deepEqual(columns, firstColumns, `${place} disagrees with ${firstPlace} on the column set`);
 }
 // Sanity: the comparison is not vacuously comparing two empty lists.
 assert.ok(firstColumns.length >= 20, `expected a real column list, got ${firstColumns.length}`);
 assert.ok(firstColumns.includes('system_prompt'));
});

test('NO privilege-bearing column exists, in any of the three places', () => {
 // THE structural control, restated as a test.
 // MUTATION: add `permission_mode text` or `metadata jsonb` to any one of the
 // three -> this fails naming that place.
 //
 // permission_mode is 'yolo', unrestricted shell on the daemon host. metadata
 // carries host_folders (an --add-dir argument on a real machine) and
 // sandbox_skills (a baseUrl the server fetches plus a vault credential name).
 const forbidden = [
  'permission_mode', 'metadata', 'sandbox_provider', 'sandbox_config',
  'connect_token', 'connect_token_hash', 'mcp_approved', 'memory_dir',
  'identity', 'enabled',
 ];
 for (const [place, source] of Object.entries(sources())) {
  const columns = columnsOf(tableBody(source));
  for (const column of forbidden) {
   assert.equal(
    columns.includes(column),
    false,
    `${place} declares a ${column} column on workspace_agent_templates — a template must never carry authority`,
   );
  }
 }
});

test('the DDL comment explains WHY those columns are absent', () => {
 // The next person to add a column reads the DDL, not this test. If the comment
 // is gone, the absence looks like an oversight and gets "fixed".
 // MUTATION: delete the explanation -> this fails.
 for (const [place, source] of Object.entries(sources())) {
  const window = source.slice(
   Math.max(0, source.indexOf('CREATE TABLE IF NOT EXISTS workspace_agent_templates (') - 3000),
   source.indexOf('CREATE TABLE IF NOT EXISTS workspace_agent_templates ('),
  );
  assert.match(window, /permission_mode/, `${place} DDL comment must name permission_mode`);
  assert.match(window, /metadata/, `${place} DDL comment must name metadata`);
  assert.match(window, /host_folders/, `${place} DDL comment must explain host_folders`);
 }
});

test('the slug uniqueness constraint exists in all three places', () => {
 // Two templates with one slug would make "authored wins over bundled"
 // non-deterministic in the gallery merge.
 for (const [place, source] of Object.entries(sources())) {
  assert.match(tableBody(source), /UNIQUE \(workspace_id, slug\)/, place);
 }
});

test('exactly one workspace_agent_templates migration exists', () => {
 const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('_workspace_agent_templates.sql'));
 assert.deepEqual(migrations, ['20260730160000_workspace_agent_templates.sql']);
});

test('the table is created after workspaces in neon-schema.sql', () => {
 // Applied top-to-bottom with ON_ERROR_STOP=1, so a forward REFERENCES breaks
 // fresh-DB provisioning outright.
 const lines = read('database/neon-schema.sql').split('\n');
 const lineOf = (table) => lines.findIndex((line) => new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`).test(line));
 assert.ok(lineOf('workspaces') > 0);
 assert.ok(lineOf('workspaces') < lineOf('workspace_agent_templates'));
});

test('the runtime DDL sits inside ensureRuntimeSchema', () => {
 const runtime = read('server/index.cjs');
 const start = runtime.indexOf('async function ensureRuntimeSchema()');
 const ddl = runtime.indexOf('CREATE TABLE IF NOT EXISTS workspace_agent_templates (');
 const end = runtime.indexOf('\nasync function ', start + 10);
 assert.ok(start > 0 && ddl > start && ddl < end, 'the DDL must run on Fly boot');
});
