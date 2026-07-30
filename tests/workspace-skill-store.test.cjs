'use strict';

// ============================================================================
// tests/workspace-skill-store.test.cjs
// ----------------------------------------------------------------------------
// THE SECURITY TEST for the app-side skill store, plus the wiring that makes a
// stored skill readable through the same door an agent already uses.
//
// The rule being pinned: a workspace skill carries PROSE, never AUTHORITY. If
// one could carry `baseUrl`, it would name a host THE SERVER FETCHES with a
// stored credential attached — this repo already has one live SSRF finding from
// exactly that. If it could carry `credential`, it would choose which vault key
// signs a call. If it could carry `code` or `path`, it would reach a machine.
// All of those already have a home behind `manage`
// (workspace_agents.metadata.sandbox_skills); a prose artifact at 'write' that
// could hold them would be a route around that gate.
//
// NON-VACUITY. The fake db CAPTURES the params handed to each statement, and the
// assertions run against that captured array — not against a mock that filters
// privileged keys itself, and not against a restatement of the SQL. Several
// assertions search the WHOLE serialized param array for a forbidden string,
// which is the check a per-field assertion misses when a value arrives nested.
// Each guard is also MUTATION-CHECKED: the test proves the assertion fails when
// the guard is removed, by feeding a payload the guard is the only thing
// stopping.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
 CARRIED_FIELDS,
 NEVER_CARRIED_FIELDS,
 MAX_BODY_BYTES,
 WORKSPACE_SKILL_NAME_RE,
 normalizeWorkspaceSkill,
 rejectedFields,
 renderWorkspaceSkillMarkdown,
 resolveTemplateSkills,
 slugifySkillName,
} = require('../shared/workspaceSkills.cjs');
const { createWorkspaceSkills } = require('../server/workspace-skills-routes.cjs');
const { resolveSkillContent, listWorkspaceSkills, loadSkillContent, SKILL_CONTENT_MAX_BYTES } = require('../server/skill-content.cjs');
const { harvestAcceptTarget } = require('../server/thread-harvest.cjs');
const core = require('../shared/backend-core.cjs');

const WORKSPACE = 'ws-1';
const USER = 'user-1';

/**
 * A fake db that RECORDS every statement and its params.
 *
 * `rowsFor` decides what a statement returns, keyed on a substring of the SQL.
 * Deliberately dumb: it enforces nothing, so a guard that stopped working would
 * show up as a forbidden value in `calls`, not as a mock politely refusing.
 */
function fakeDb(rowsFor = () => []) {
 const calls = [];
 return {
  calls,
  unsafe: async (sql, params = []) => {
   calls.push({ sql: String(sql), params });
   return rowsFor(String(sql), params) || [];
  },
 };
}

function skillRow(overrides = {}) {
 return {
  id: 'skill-1',
  workspace_id: WORKSPACE,
  name: 'security-review',
  title: 'Security review',
  summary: 'How we review a change for security.',
  body: '## Steps\n\n1. Read the diff.',
  revision: 1,
  source: 'authored',
  origin: {},
  created_by: USER,
  ...overrides,
 };
}

// ---------------------------------------------------------------------------
// The validator: prose only
// ---------------------------------------------------------------------------

test('a valid skill is rebuilt from carried fields only', () => {
 const result = normalizeWorkspaceSkill({
  title: 'Security Review',
  summary: 'One line.',
  body: 'Do the thing.',
 });
 assert.equal(result.ok, true);
 assert.deepEqual(Object.keys(result.skill).sort(), [...CARRIED_FIELDS].sort());
 assert.equal(result.skill.name, 'security-review');
});

test('every never-carried field is REFUSED, naming itself', () => {
 // One assertion per field rather than a loop over a summary, so a regression
 // reports WHICH field started getting through.
 for (const field of NEVER_CARRIED_FIELDS) {
  const result = normalizeWorkspaceSkill({
   title: 'Anything',
   body: 'Anything.',
   [field]: 'x',
  });
  assert.equal(result.ok, false, `${field} was accepted`);
  assert.ok(
   result.errors.some((message) => message.includes(field)),
   `refusal for ${field} did not name the field: ${result.errors.join('; ')}`,
  );
  assert.equal(result.skill, null);
 }
});

test('the privilege-bearing sandbox fields are all on the never-carried list', () => {
 // The list is the contract; this pins the specific names that would turn a
 // prose artifact into a credentialed outbound call.
 for (const field of ['baseUrl', 'base_url', 'credential', 'endpoints', 'mcp', 'code', 'path', 'permission_mode', 'metadata']) {
  assert.ok(NEVER_CARRIED_FIELDS.includes(field), `${field} is not refused`);
 }
});

test('MUTATION CHECK: the refusal is what stops a baseUrl, not the rebuild alone', () => {
 // With the refusal bypassed (`allowUnknown`), the REBUILD must still drop the
 // field — belt and braces, and the check that would catch someone "fixing" the
 // rebuild to spread its input.
 const bypassed = normalizeWorkspaceSkill(
  { title: 'X', body: 'Y', baseUrl: 'https://attacker.example', credential: { key: 'api_key' } },
  { allowUnknown: true },
 );
 assert.equal(bypassed.ok, true);
 assert.equal('baseUrl' in bypassed.skill, false);
 assert.equal('credential' in bypassed.skill, false);
 assert.equal(JSON.stringify(bypassed.skill).includes('attacker.example'), false);
});

test('rejectedFields sees a never-carried key under either spelling', () => {
 assert.deepEqual(rejectedFields({ base_url: 'x' }), ['base_url']);
 assert.deepEqual(rejectedFields({ baseUrl: 'x' }), ['baseUrl']);
 assert.deepEqual(rejectedFields({ title: 'fine' }), []);
});

test('a skill with no body is refused — a name without a procedure is the bug', () => {
 const result = normalizeWorkspaceSkill({ title: 'Named', body: '   ' });
 assert.equal(result.ok, false);
 assert.ok(result.errors.some((m) => m.includes('body')));
});

test('a title that slugifies to nothing is refused rather than stored blank', () => {
 const result = normalizeWorkspaceSkill({ title: '///', body: 'x' });
 assert.equal(result.ok, false);
});

test('slugifySkillName always produces a name the rule accepts, or empty', () => {
 const inputs = ['Security Review', '  Hello--World  ', 'ALL CAPS', 'a'.repeat(200), 'trailing---', '???', 'x'];
 for (const input of inputs) {
  const name = slugifySkillName(input);
  if (!name) continue;
  assert.ok(WORKSPACE_SKILL_NAME_RE.test(name), `${input} -> ${name} fails the name rule`);
  assert.ok(name.length <= 64);
 }
});

test('the body cap matches the loader that reads it back', () => {
 // Not cosmetic: a larger ceiling here would store bytes the reader always cuts.
 assert.equal(MAX_BODY_BYTES, SKILL_CONTENT_MAX_BYTES);
});

test('an oversized body is cut at the byte cap, not the character count', () => {
 const body = 'é'.repeat(MAX_BODY_BYTES); // 2 bytes each
 const result = normalizeWorkspaceSkill({ title: 'Big', body });
 assert.equal(result.ok, true);
 assert.ok(Buffer.byteLength(result.skill.body, 'utf8') <= MAX_BODY_BYTES);
 assert.equal(result.truncated, true);
 // And no replacement character from a sequence split at the boundary.
 assert.equal(result.skill.body.endsWith('�'), false);
});

// ---------------------------------------------------------------------------
// Rendering: one body, both doors
// ---------------------------------------------------------------------------

test('a rendered skill is a real SKILL.md, and frontmatter cannot be escaped', () => {
 const markdown = renderWorkspaceSkillMarkdown({
  name: 'security-review',
  title: 'Title with "quotes"',
  // The attack: a newline in a value ends the block early and the rest of the
  // string becomes YAML keys a client would parse as frontmatter.
  summary: 'line one\n---\nname: hijacked',
  body: '# Body',
 });
 const lines = markdown.split('\n');
 assert.equal(lines[0], '---');
 assert.equal(lines[1], 'name: security-review');
 const closing = lines.indexOf('---', 1);
 assert.ok(closing > 0);
 // The property is per-LINE: the injected text may appear inside a quoted
 // scalar (harmless), but it must not become a line of its own, and it must not
 // close the block early. Asserting on the joined string instead would fail on
 // the safe case and pass on nothing extra.
 const frontmatter = lines.slice(1, closing);
 assert.deepEqual(
  frontmatter.map((line) => line.slice(0, line.indexOf(':'))),
  ['name', 'title', 'description', 'source'],
 );
 assert.equal(frontmatter.includes('---'), false, 'a value closed the frontmatter block early');
 assert.equal(frontmatter.some((line) => line.startsWith('name: hijacked')), false, 'a value became a frontmatter key');
 // And the closing delimiter is the one this function wrote, not one from a value.
 assert.equal(closing, 5);
 assert.ok(markdown.includes('# Body'));
});

test('MUTATION CHECK: an unescaped summary really would break out', () => {
 // Proves the assertion above is load-bearing: the same payload, rendered
 // WITHOUT the escaping, produces the injected key as a line of its own.
 const naive = `---\nname: x\ndescription: ${'line one\n---\nname: hijacked'}\n---\n`;
 const lines = naive.split('\n');
 assert.equal(lines.indexOf('---', 1), 3, 'the naive render did not break out, so the real test proves nothing');
 assert.ok(lines.some((line) => line.startsWith('name: hijacked')));
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test('a workspace skill is readable when nothing else supplies the name', () => {
 const resolved = resolveSkillContent({
  skill: 'security-review',
  workspaceSkills: [{ name: 'security-review', title: 'T', summary: 'S', body: 'BODY-HERE' }],
 });
 assert.equal(resolved.available, true);
 assert.equal(resolved.source, 'workspace');
 assert.ok(resolved.markdown.includes('BODY-HERE'));
 assert.equal(resolved.path, '');
});

test('a daemon document WINS over a workspace skill of the same name', () => {
 const resolved = resolveSkillContent({
  skill: 'code-review',
  documents: [{ skill: 'code-review', content: 'FROM-THE-MACHINE', path: '/x/SKILL.md' }],
  workspaceSkills: [{ name: 'code-review', title: 'T', summary: '', body: 'FROM-THE-STORE' }],
 });
 assert.equal(resolved.source, 'daemon');
 assert.ok(resolved.markdown.includes('FROM-THE-MACHINE'));
 assert.equal(resolved.markdown.includes('FROM-THE-STORE'), false);
});

test('a sandbox definition WINS over a workspace skill — it governs the real call', () => {
 const resolved = resolveSkillContent({
  skill: 'sandbox-provider-box',
  sandboxSkills: [{
   id: 'sandbox-provider-box', kind: 'provider', provider: 'box',
   name: 'Box', summary: 'S', instructions: 'PROVIDER-INSTRUCTIONS',
   capabilities: [], endpoints: [], notes: [],
  }],
  workspaceSkills: [{ name: 'sandbox-provider-box', title: 'T', summary: '', body: 'FROM-THE-STORE' }],
 });
 assert.equal(resolved.source, 'sandbox');
 assert.equal(resolved.markdown.includes('FROM-THE-STORE'), false);
});

test('a missing name is still an honest miss, not an empty workspace body', () => {
 const resolved = resolveSkillContent({ skill: 'nope', workspaceSkills: [] });
 assert.equal(resolved.available, false);
 assert.equal(resolved.reason, 'not-found');
});

// ---------------------------------------------------------------------------
// Listing and loading against a db
// ---------------------------------------------------------------------------

test('listWorkspaceSkills surfaces a stored skill no agent carries', async () => {
 const db = fakeDb((sql) => {
  if (sql.includes('from workspace_skills')) return [{ name: 'security-review', title: 'T', summary: 'SUM' }];
  return [];
 });
 const skills = await listWorkspaceSkills(db, WORKSPACE);
 const entry = skills.find((s) => s.name === 'security-review');
 assert.ok(entry, 'a stored skill nobody carries was hidden');
 assert.equal(entry.inStore, true);
 assert.equal(entry.hasContent, true);
 assert.deepEqual(entry.agents, []);
 assert.equal(entry.summary, 'SUM');
});

test('a stored body makes an agent that CLAIMS the name report hasContent', async () => {
 const db = fakeDb((sql) => {
  if (sql.includes('from workspace_agents')) {
   return [{ id: 'a1', name: 'Ana', handle: 'ana', run_mode: 'daemon', skills: ['security-review'], metadata: {}, enabled: true }];
  }
  if (sql.includes('from workspace_skills')) return [{ name: 'security-review', title: 'T', summary: '' }];
  return [];
 });
 const skills = await listWorkspaceSkills(db, WORKSPACE);
 const entry = skills.find((s) => s.name === 'security-review');
 assert.equal(entry.agents.length, 1);
 assert.equal(entry.agents[0].hasContent, true, 'an agent claiming a stored name still reported no body');
 assert.equal(entry.inStore, true);
});

test('MUTATION CHECK: without a stored row the same claim reports no content', async () => {
 // The inverse of the test above with ONE input changed. If it passed too, the
 // previous assertion would be proving nothing about the store.
 const db = fakeDb((sql) => {
  if (sql.includes('from workspace_agents')) {
   return [{ id: 'a1', name: 'Ana', handle: 'ana', run_mode: 'daemon', skills: ['security-review'], metadata: {}, enabled: true }];
  }
  return [];
 });
 const skills = await listWorkspaceSkills(db, WORKSPACE);
 const entry = skills.find((s) => s.name === 'security-review');
 assert.equal(entry.agents[0].hasContent, false);
 assert.equal(entry.inStore, false);
});

test('loadSkillContent reads the store and reports shadowing honestly', async () => {
 const withStoreOnly = fakeDb((sql) => {
  if (sql.includes('from workspace_skills')) return [skillRow()];
  return [];
 });
 const plain = await loadSkillContent({ db: withStoreOnly, workspaceId: WORKSPACE, skill: 'security-review' });
 assert.equal(plain.available, true);
 assert.equal(plain.source, 'workspace');
 assert.equal(plain.shadowsWorkspaceSkill, false);

 const withBoth = fakeDb((sql) => {
  if (sql.includes('from workspace_skills')) return [skillRow()];
  if (sql.includes('from agent_skill_documents d')) {
   return [{ skill: 'security-review', path: '/p', summary: '', content: 'MACHINE', byte_size: 7, truncated: false, agent_name: 'Ana' }];
  }
  return [];
 });
 const shadowed = await loadSkillContent({ db: withBoth, workspaceId: WORKSPACE, skill: 'security-review' });
 assert.equal(shadowed.source, 'daemon');
 assert.equal(shadowed.shadowsWorkspaceSkill, true, 'a shadowed store skill was hidden from the reader');
});

test('the store query is workspace-scoped', async () => {
 const db = fakeDb(() => []);
 await loadSkillContent({ db, workspaceId: WORKSPACE, skill: 'x' });
 const storeCall = db.calls.find((c) => c.sql.includes('from workspace_skills'));
 assert.ok(storeCall, 'no workspace_skills query was issued');
 assert.ok(storeCall.sql.includes('workspace_id = $1'));
 assert.equal(storeCall.params[0], WORKSPACE);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function routesWith(rowsFor, roleCalls = []) {
 const db = fakeDb(rowsFor);
 const api = createWorkspaceSkills({
  getDb: () => db,
  notifyDbSubscribers: () => {},
  enforceWorkspaceRole: async (userId, workspaceId, capability) => {
   roleCalls.push({ userId, workspaceId, capability });
  },
 });
 return { db, api, roleCalls };
}

test('authoring requires write, and the insert carries no privileged value', async () => {
 const roleCalls = [];
 const { db, api } = routesWith((sql) => {
  if (sql.startsWith('select id from workspace_skills')) return [];
  if (sql.includes('count(*)')) return [{ total: 0 }];
  if (sql.includes('insert into workspace_skills')) return [skillRow()];
  return [];
 }, roleCalls);

 await api.createSkill({
  userId: USER,
  workspaceId: WORKSPACE,
  skill: { title: 'Security Review', summary: 'One line.', body: 'Do the thing.' },
 });

 assert.deepEqual(roleCalls, [{ userId: USER, workspaceId: WORKSPACE, capability: 'write' }]);

 const insert = db.calls.find((c) => c.sql.includes('insert into workspace_skills'));
 assert.ok(insert);
 // Every param, serialized, searched as one string — the check a per-field
 // assertion misses when a value arrives nested inside something else.
 const serialized = JSON.stringify(insert.params);
 for (const forbidden of ['baseUrl', 'base_url', 'credential', 'permission_mode', 'host_folders', 'sandbox_skills']) {
  assert.equal(serialized.includes(forbidden), false, `${forbidden} reached the insert`);
 }
 // `source` is set by the route and is not the caller's to choose.
 assert.ok(insert.params.includes('authored'));
});

test('a create carrying a privileged field is REFUSED before any db write', async () => {
 const { db, api } = routesWith(() => []);
 await assert.rejects(
  () => api.createSkill({
   userId: USER,
   workspaceId: WORKSPACE,
   skill: { title: 'X', body: 'Y', baseUrl: 'https://attacker.example', source: 'authored' },
  }),
  (error) => error.status === 400 && /baseUrl|source/.test(error.message),
 );
 assert.equal(db.calls.some((c) => c.sql.includes('insert into workspace_skills')), false, 'a refused create still wrote');
});

test('a duplicate name is a 409 rather than a silent overwrite', async () => {
 const { api } = routesWith((sql) => {
  if (sql.startsWith('select id from workspace_skills')) return [{ id: 'existing' }];
  return [];
 });
 await assert.rejects(
  () => api.createSkill({ userId: USER, workspaceId: WORKSPACE, skill: { title: 'Security Review', body: 'b' } }),
  (error) => error.status === 409,
 );
});

test('an update cannot rename — the stored name is forced back on', async () => {
 const { db, api } = routesWith((sql) => {
  if (sql.startsWith('select * from workspace_skills')) return [skillRow()];
  if (sql.includes('update workspace_skills')) return [skillRow({ title: 'New title' })];
  return [];
 });
 await api.updateSkill({
  userId: USER,
  workspaceId: WORKSPACE,
  skillId: 'skill-1',
  skill: { name: 'totally-different', title: 'New title', summary: '', body: 'b' },
 });
 const update = db.calls.find((c) => c.sql.includes('update workspace_skills'));
 assert.ok(update);
 // The UPDATE sets title/summary/body and nothing else — no name column in it.
 assert.equal(/set[^]*\bname\s*=/.test(update.sql), false, 'the update statement can rename a skill');
 assert.equal(update.params.includes('totally-different'), false);
});

test('every route is scoped to the workspace in the path, not one in the body', async () => {
 const { db, api } = routesWith((sql) => {
  if (sql.startsWith('select * from workspace_skills')) return [skillRow()];
  if (sql.includes('delete from workspace_skills')) return [skillRow()];
  return [];
 });
 await api.deleteSkill({ userId: USER, workspaceId: WORKSPACE, skillId: 'skill-1' });
 const del = db.calls.find((c) => c.sql.includes('delete from workspace_skills'));
 assert.ok(del.sql.includes('workspace_id = $2'));
 assert.equal(del.params[1], WORKSPACE);
});

// ---------------------------------------------------------------------------
// Access-control wiring
// ---------------------------------------------------------------------------

test('workspace_skills is allowlisted, workspace-scoped, and write-gated to manage', () => {
 assert.ok(core.ALLOWED_TABLES.has('workspace_skills'));
 // Without this the generic select has NO row scoping and one signed-in user
 // reads every other tenant's skill bodies.
 assert.ok(core.WORKSPACE_SCOPED_TABLES.has('workspace_skills'));
 const access = core.DB_TABLE_ACCESS.workspace_skills;
 assert.equal(access.select, 'read');
 // Generic writes are harder than the dedicated route on purpose: the route is
 // the only place the validator runs.
 assert.equal(access.insert, 'manage');
 assert.equal(access.update, 'manage');
 assert.equal(access.delete, 'manage');
});

test('the generic select is projected through a column allow-list', () => {
 // A table in ALLOWED_TABLES with NO entry returns every column a future
 // migration adds. safeSelectColumns is asked directly rather than the map, so
 // the assertion covers the path a request actually takes.
 const columns = core.safeSelectColumns('workspace_skills', '*');
 assert.ok(columns.includes('body'));
 assert.ok(columns.includes('name'));
 assert.throws(() => core.safeSelectColumns('workspace_skills', 'name, secret_column'), /not selectable/);
});

test('source and origin are stripped from a generic write', () => {
 const values = { name: 'x', title: 'T', body: 'B', source: 'authored', origin: { forged: true } };
 const stripped = core.stripPrivilegedDbValues('workspace_skills', { ...values });
 assert.equal('source' in stripped, false, 'a generic write could forge provenance');
 assert.equal('origin' in stripped, false);
 assert.equal(stripped.name, 'x');
});

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

test('an accepted skill suggestion now lands in the skill store, not in documents', () => {
 const target = harvestAcceptTarget({ kind: 'skill' });
 assert.equal(target.table, 'workspace_skills');
 // The other two kinds are unchanged — this was a targeted change, not a sweep.
 assert.equal(harvestAcceptTarget({ kind: 'doc' }).table, 'documents');
 assert.equal(harvestAcceptTarget({ kind: 'memory' }).table, 'memory_facts');
});

// ---------------------------------------------------------------------------
// Templates: the dangling reference
// ---------------------------------------------------------------------------

test('resolveTemplateSkills separates the names a workspace can back from those it cannot', () => {
 const { resolved, unresolved } = resolveTemplateSkills(
  ['security-review', 'Security-Review', 'nowhere-to-be-found', ''],
  ['security-review'],
 );
 // Case-insensitive, and deduped: a template authored elsewhere may not follow
 // this workspace's spelling.
 assert.deepEqual(resolved, ['security-review']);
 assert.deepEqual(unresolved, ['nowhere-to-be-found']);
});

test('MUTATION CHECK: with nothing available every template skill is unresolved', () => {
 const { resolved, unresolved } = resolveTemplateSkills(['security-review'], []);
 assert.deepEqual(resolved, []);
 assert.deepEqual(unresolved, ['security-review']);
});

// ---------------------------------------------------------------------------
// Schema parity — the rule this repo has broken twice
// ---------------------------------------------------------------------------

test('the DDL exists in all three places a table has to be declared', () => {
 const fs = require('node:fs');
 const path = require('node:path');
 const root = path.join(__dirname, '..');
 const runtime = fs.readFileSync(path.join(root, 'server/index.cjs'), 'utf8');
 const neon = fs.readFileSync(path.join(root, 'database/neon-schema.sql'), 'utf8');
 const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .map((file) => fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'))
  .join('\n');

 for (const [label, source] of [['ensureRuntimeSchema', runtime], ['neon-schema.sql', neon], ['supabase/migrations', migrations]]) {
  assert.ok(
   /CREATE TABLE IF NOT EXISTS workspace_skills/.test(source),
   `workspace_skills is missing from ${label} — a database built from it will never have the table`,
  );
  // The absent columns ARE the control, so their absence is asserted rather
  // than assumed. Scoped to this table's DDL block so an unrelated `base_url`
  // elsewhere in the file cannot mask a real one here.
  const block = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS workspace_skills'));
  const ddl = block.slice(0, block.indexOf(');') + 2);
  for (const forbidden of ['base_url', 'credential', 'endpoints', 'permission_mode', 'agent_id', 'memory_dir']) {
   assert.equal(
    new RegExp(`^\\s*${forbidden}\\s`, 'm').test(ddl),
    false,
    `${label} declares workspace_skills.${forbidden} — that column would make a prose artifact privilege-bearing`,
   );
  }
 }
});
