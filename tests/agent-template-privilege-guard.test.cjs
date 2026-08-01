'use strict';

// ============================================================================
// tests/agent-template-privilege-guard.test.cjs
// ----------------------------------------------------------------------------
// THE SECURITY TEST for agent templates ("persona packs").
//
// The rule being pinned: a template carries PROSE and REQUESTS, never AUTHORITY.
// If a template could carry permission_mode, it would be a way to hand an agent
// unrestricted shell on someone's laptop. If it could carry metadata, it would
// carry host_folders (which becomes an --add-dir argument on a real machine) and
// sandbox_skills (a baseUrl the SERVER fetches plus a workspace-vault credential
// key). Both are guarded on workspace_agents itself; a template that could hold
// them would be a route around those guards.
//
// NON-VACUITY IS THE POINT HERE. The fake db CAPTURES the params handed to the
// insert, and every assertion runs against that captured array — not against a
// mock that filters privileged keys itself, and not against a restatement of the
// SQL. A mock that enforced the rule would be testing the mock. Several
// assertions therefore search the WHOLE serialized param array for a forbidden
// string, which is the check a per-field assertion would miss when a value
// arrives nested inside something else.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const {
 CARRIED_FIELDS,
 NEVER_CARRIED_FIELDS,
 normalizeAgentTemplate,
 agentToTemplateDraft,
 templateToAgentDraft,
 rejectedFields,
} = require('../shared/agentTemplates.cjs');
const { createAgentTemplates } = require('../server/agent-templates-routes.cjs');
const core = require('../shared/backend-core.cjs');

const WORKSPACE = 'ws-1';
const USER = 'user-1';

/** A real-shaped workspace_agents row for the nastiest possible source agent. */
function dangerousAgentRow(overrides = {}) {
 return {
  id: 'agent-1',
  workspace_id: WORKSPACE,
  name: 'Ops Runner',
  handle: 'ops-runner',
  description: 'Runs operational tasks.',
  system_prompt: 'You are an operations agent.',
  soul: 'Careful and terse.',
  instructions: 'Always confirm before destructive work.',
  tools: ['bash', 'read'],
  skills: ['deploy-runbook'],
  model: 'claude-opus-5',
  run_mode: 'daemon',
  avatar: 'AI',
  accent_color: '#00a95c',
  // Everything below must NEVER reach a template.
  permission_mode: 'yolo',
  metadata: {
   host_folders: ['/', '/Users/alice/.ssh'],
   sandbox_skills: [{ id: 'evil', baseUrl: 'http://169.254.169.254/latest/meta-data', credential: 'ANTHROPIC_API_KEY' }],
   runtime: 'claude',
  },
  sandbox_provider: 'e2b',
  sandbox_config: { template: 'base', apiKeyRef: 'sandbox:e2b:api_key' },
  connect_token_hash: 'HASHEDCONNECTTOKENMATERIAL',
  mcp_approved: true,
  memory_dir: '/Users/alice/secret-notes',
  identity: { human_set: { name: true } },
  enabled: true,
  version: 7,
  created_by: 'someone-else',
  ...overrides,
 };
}

function makeDb({ agentRow = dangerousAgentRow(), inserted = null } = {}) {
 const queries = [];
 const db = {
  queries,
  async unsafe(sql, params = []) {
   const raw = String(sql).replace(/\s+/g, ' ').trim();
   const q = raw.toLowerCase();
   queries.push({ sql: raw, params });
   if (q.startsWith('select * from workspace_agents where id')) return agentRow ? [agentRow] : [];
   if (q.startsWith('insert into workspace_agent_templates')) {
    return [inserted || {
     id: 'tpl-1', workspace_id: WORKSPACE, slug: params[1], name: params[2],
     tools: params[9], skills: params[10], purpose: params[11],
     resource_facets: params[12], source: params[18], origin: params[19],
    }];
   }
   if (q.startsWith('select * from workspace_agent_templates where id')) return [{ id: 'tpl-1', workspace_id: WORKSPACE, slug: 'ops-runner' }];
   return [];
  },
 };
 return db;
}

function build(db, overrides = {}) {
 return createAgentTemplates({
  getDb: () => db,
  notifyDbSubscribers: () => {},
  enforceWorkspaceRole: async () => true,
  normalizeAgentTemplate,
  agentToTemplateDraft,
  ...overrides,
 });
}

/** The template insert's params, as one searchable string. */
function insertedParams(db) {
 const entry = db.queries.find((q) => q.sql.toLowerCase().startsWith('insert into workspace_agent_templates'));
 return entry ? entry.params : null;
}

function serialized(db) {
 return JSON.stringify(insertedParams(db) ?? []);
}

// --- the field lists themselves ---------------------------------------------

test('no never-carried field is also a carried field', () => {
 // MUTATION: add 'permission_mode' or 'metadata' to CARRIED_FIELDS -> this fails.
 // The two lists are the written form of the rule; overlap means the rule is gone.
 for (const forbidden of NEVER_CARRIED_FIELDS) {
  assert.equal(
   CARRIED_FIELDS.includes(forbidden),
   false,
   `${forbidden} must never be carried by a template — it grants authority`,
  );
 }
});

test('the never-carried list covers every privileged column on workspace_agents', () => {
 // Ties this file to the real guards rather than to a list someone typed. If a
 // new privileged or manage-only column is added to workspace_agents and not
 // added here, this fails — which is exactly when someone needs telling.
 const privileged = [...(core.PRIVILEGED_DB_COLUMNS_BY_TABLE.workspace_agents || [])];
 const manageOnly = [...(core.MANAGE_ONLY_DB_COLUMNS_BY_TABLE.workspace_agents || [])];
 assert.ok(privileged.length > 0 && manageOnly.length > 0, 'the guards this test anchors to must exist');
 for (const column of [...privileged, ...manageOnly]) {
  assert.equal(
   NEVER_CARRIED_FIELDS.includes(column),
   true,
   `${column} is guarded on workspace_agents but a template could carry it`,
  );
 }
});

// --- authoring ---------------------------------------------------------------

test('an authored template naming a privileged field is REFUSED, not silently cleaned', () => {
 // MUTATION: drop the rejectedFields check and let normalize just not copy them
 // -> this fails. A silent drop is how someone comes to believe they saved a
 // permission mode and that the agent they hand over will run in it.
 for (const [key, value] of [
  ['permission_mode', 'yolo'],
  ['permissionMode', 'yolo'],
  ['metadata', { host_folders: ['/'] }],
  ['sandbox_config', { apiKeyRef: 'x' }],
  ['connect_token_hash', 'abc'],
  ['memory_dir', '/etc'],
  ['host_folders', ['/']],
 ]) {
  const result = normalizeAgentTemplate({ name: 'X', [key]: value });
  assert.equal(result.ok, false, `${key} must be refused`);
  assert.match(result.errors.join(' '), new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
 }
});

test('normalize REBUILDS rather than filtering, so an unanticipated key cannot ride along', () => {
 // MUTATION: change normalizeAgentTemplate to spread the input and delete known
 // bad keys -> `somethingNobodyThoughtOf` survives and this fails.
 const result = normalizeAgentTemplate({
  name: 'Reviewer',
  systemPrompt: 'Review code.',
  somethingNobodyThoughtOf: 'surprise',
  futurePrivilegedField: { grants: 'root' },
 });
 assert.equal(result.ok, true, result.errors.join('; '));
 assert.deepEqual(
  Object.keys(result.template).sort(),
  [...CARRIED_FIELDS].sort(),
  'the output shape is exactly the carried-field list',
 );
 assert.equal('somethingNobodyThoughtOf' in result.template, false);
 assert.equal('futurePrivilegedField' in result.template, false);
});

test('rejectedFields sees both spellings of every guarded column', () => {
 assert.deepEqual(rejectedFields({ permission_mode: 'yolo' }), ['permission_mode']);
 assert.deepEqual(rejectedFields({ permissionMode: 'yolo' }), ['permissionMode']);
 assert.deepEqual(rejectedFields({ name: 'fine' }), []);
});

// --- save-as-template: the path most likely to grow a hole -------------------

test('saving a YOLO agent with host_folders as a template carries neither', async () => {
 // THE test. MUTATION: change agentToTemplateDraft to spread the row instead of
 // picking fields -> permission_mode and metadata land in the draft and this
 // fails on several assertions at once.
 const db = makeDb();
 const engine = build(db);
 await engine.saveAgentAsTemplate({ userId: USER, workspaceId: WORKSPACE, agentId: 'agent-1' });

 const params = insertedParams(db);
 assert.ok(params, 'a template row must be written');
 const all = serialized(db);

 // Whole-array assertions: a forbidden value must not appear ANYWHERE, however
 // it might have been nested.
 assert.equal(all.includes('yolo'), false, 'permission_mode must not survive');
 assert.equal(all.includes('/Users/alice/.ssh'), false, 'host_folders must not survive');
 assert.equal(all.includes('169.254.169.254'), false, 'a sandbox skill baseUrl must not survive');
 assert.equal(all.includes('ANTHROPIC_API_KEY'), false, 'a vault credential name must not survive');
 assert.equal(all.includes('HASHEDCONNECTTOKENMATERIAL'), false, 'the connect token hash must not survive');
 assert.equal(all.includes('sandbox:e2b:api_key'), false, 'sandbox config must not survive');
 assert.equal(all.includes('/Users/alice/secret-notes'), false, 'memory_dir must not survive');
 assert.equal(all.includes('host_folders'), false);
 assert.equal(all.includes('sandbox_skills'), false);

 // And the prose it SHOULD carry did survive, so this is not passing by writing
 // nothing at all.
 assert.equal(all.includes('You are an operations agent.'), true);
 assert.equal(all.includes('Ops Runner'), true);
 assert.equal(all.includes('deploy-runbook'), true);
});

test('the derived template records its provenance', async () => {
 const db = makeDb();
 const engine = build(db);
 await engine.saveAgentAsTemplate({ userId: USER, workspaceId: WORKSPACE, agentId: 'agent-1' });
 const params = insertedParams(db);
 // source is set by the server, never by the caller.
 assert.equal(params[18], 'derived');
 assert.equal(params[19].derivedFromAgentId, 'agent-1');
 assert.equal(params[20], USER, 'created_by is the verified session');
});

test('jsonb columns are bound as OBJECTS, never as JSON strings', async () => {
 // MUTATION: JSON.stringify the tools/skills binds -> this fails. porsager turns
 // a stringified ::jsonb bind into a jsonb STRING SCALAR.
 const db = makeDb();
 const engine = build(db);
 await engine.saveAgentAsTemplate({ userId: USER, workspaceId: WORKSPACE, agentId: 'agent-1' });
 const params = insertedParams(db);
 assert.ok(Array.isArray(params[9]), 'tools bound as an array');
 assert.ok(Array.isArray(params[10]), 'skills bound as an array');
 assert.ok(Array.isArray(params[12]), 'resource facets bound as an array');
 assert.equal(typeof params[19], 'object', 'origin bound as an object');
});

test('a missing agent is a 404 and writes nothing', async () => {
 const db = makeDb({ agentRow: null });
 const engine = build(db);
 await assert.rejects(
  () => engine.saveAgentAsTemplate({ userId: USER, workspaceId: WORKSPACE, agentId: 'nope' }),
  (error) => error.status === 404,
 );
 assert.equal(insertedParams(db), null);
});

// --- RBAC --------------------------------------------------------------------

test('authoring and saving need write; reading needs read', async () => {
 // MUTATION: change any of these to 'manage' -> this fails, catching an
 // over-tightening that would silently remove the feature from editors. Change
 // to 'read' -> also fails.
 const asked = [];
 const db = makeDb();
 const engine = build(db, {
  enforceWorkspaceRole: async (userId, workspaceId, capability) => { asked.push(capability); return true; },
 });
 await engine.listAgentTemplates({ userId: USER, workspaceId: WORKSPACE });
 await engine.createAgentTemplate({ userId: USER, workspaceId: WORKSPACE, template: { name: 'A', systemPrompt: 'x' } });
 await engine.saveAgentAsTemplate({ userId: USER, workspaceId: WORKSPACE, agentId: 'agent-1' });
 await engine.deleteAgentTemplate({ userId: USER, workspaceId: WORKSPACE, templateId: 'tpl-1' }).catch(() => {});
 assert.deepEqual(asked, ['read', 'write', 'write', 'write']);
});

test('a refused role writes nothing at all', async () => {
 const db = makeDb();
 const engine = build(db, {
  enforceWorkspaceRole: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); },
 });
 await assert.rejects(() => engine.saveAgentAsTemplate({ userId: USER, workspaceId: WORKSPACE, agentId: 'agent-1' }), /forbidden/);
 assert.equal(db.queries.length, 0);
});

// --- the generic path --------------------------------------------------------

test('provenance columns are privileged on the generic db path', () => {
 // MUTATION: remove the workspace_agent_templates entry from
 // PRIVILEGED_DB_COLUMNS_BY_TABLE -> this fails. A generic write that could set
 // source='authored' on an imported body would erase the only record of where
 // an attacker-influenced system prompt came from.
 const privileged = core.PRIVILEGED_DB_COLUMNS_BY_TABLE.workspace_agent_templates;
 assert.ok(privileged, 'the table must have a privileged-column entry');
 assert.equal(privileged.has('source'), true);
 assert.equal(privileged.has('origin'), true);

 const stripped = core.stripPrivilegedDbValues('workspace_agent_templates', {
  name: 'Fine', source: 'authored', origin: { importedBy: 'nobody' },
 });
 assert.deepEqual(stripped, { name: 'Fine' });
});

test('the table is readable and writable at the same capability as workspace_agents', () => {
 // Authoring a template is no more privileged than typing the prompt it holds,
 // which 'write' can already do directly on an agent. The control is the SHAPE.
 assert.deepEqual(
  core.DB_TABLE_ACCESS.workspace_agent_templates,
  core.DB_TABLE_ACCESS.workspace_agents,
 );
 assert.equal(core.ALLOWED_TABLES.has('workspace_agent_templates'), true);
 assert.equal(core.WORKSPACE_SCOPED_TABLES.has('workspace_agent_templates'), true);
});

// --- instantiation -----------------------------------------------------------

test('the agent draft a template produces carries no metadata key at all', () => {
 // Not `metadata: {}` — no key. The form spreads what it gets, and even an empty
 // object is a metadata write on submit, which setsManageOnlyDbColumn refuses
 // for a 'write' member. That would make an authored template appear to require
 // manage for no reason.
 // MUTATION: add `metadata: {}` to templateToAgentDraft -> this fails.
 const draft = templateToAgentDraft({ name: 'Reviewer', systemPrompt: 'x', tools: [], skills: [] });
 assert.equal('metadata' in draft, false);
 assert.equal('permission_mode' in draft, false);
 assert.equal('permissionMode' in draft, false);
 assert.equal(core.setsManageOnlyDbColumn('workspace_agents', draft), false, 'instantiating must not need manage');
});

test('there is no server-side create-agent route in this module', () => {
 // Risk 2 in the plan: a convenience "create from template" that inserts
 // server-side would step around stripPrivilegedDbValues and
 // setsManageOnlyDbColumn at once. Instantiation must stay the existing form
 // plus the generic insert.
 // MUTATION: add an `insert into workspace_agents` anywhere here -> this fails.
 const source = require('node:fs').readFileSync(
  require('node:path').resolve(__dirname, '../server/agent-templates-routes.cjs'), 'utf8',
 );
 assert.equal(/insert\s+into\s+workspace_agents\b/i.test(source), false);
 assert.equal(/update\s+workspace_agents\b/i.test(source), false);
});

// --- the persona size budget -------------------------------------------------

test('an oversized persona is flagged against the daemon ceiling', () => {
 // The daemon composes the persona and truncates from the START at 10 KiB, so
 // an oversized persona does not fail loudly — description, soul, system prompt
 // and instructions are evicted first and the agent behaves as if they were
 // never written.
 const { personaBudget, DAEMON_LEAN_PROMPT_MAX_BYTES } = require('../shared/agentTemplates.cjs');
 assert.equal(DAEMON_LEAN_PROMPT_MAX_BYTES, 10 * 1024, 'mirrors LEAN_PROMPT_MAX_BYTES in the daemon repo');
 const small = personaBudget({ systemPrompt: 'short' });
 assert.equal(small.overBudget, false);
 const big = personaBudget({ systemPrompt: 'x'.repeat(9000) });
 assert.equal(big.overBudget, true);
 assert.ok(big.budget < DAEMON_LEAN_PROMPT_MAX_BYTES, 'the budget leaves room for the user message');
});

// --- export / import ---------------------------------------------------------
//
// The whole point of this section is that IMPORT NEEDS NO NEW GUARD. The
// security property was solved by the table's shape — there is no
// privilege-bearing column, so nothing arriving in a file can reach one. What
// these cases pin is that nobody quietly re-opens that: an export built by
// spreading the row, or an import that stopped running the validator.

test('an export carries EXACTLY the carried fields — no more, and no fewer', () => {
 // No more: a spread of the stored row would put id, workspace_id and
 // created_by into a file meant to travel between workspaces.
 // No fewer: a carried field missing from the export is prose silently lost on
 // every round trip, which nobody notices until the persona reads differently.
 //
 // MUTATION: `return { ...template }` for the body -> the extra keys appear.
 const { buildTemplateExport } = require('../shared/agentTemplates.cjs');
 const stored = {
  id: 'tpl-1',
  workspace_id: WORKSPACE,
  created_by: USER,
  revision: 4,
  source: 'derived',
  slug: 'ops-runner',
  name: 'Ops Runner',
  category: 'Saved',
  description: 'Runs operational tasks.',
  handleHint: 'ops-runner',
  systemPrompt: 'You are an operations agent.',
  soul: 'Careful and terse.',
  instructions: 'Ask before destructive things.',
  tools: ['Bash'],
  skills: ['deploy'],
  model: 'auto',
  runMode: 'daemon',
  runtime: 'claude',
  avatar: '',
  accentColor: '#fff',
  // The nastiest keys a caller could have attached to the object in memory.
  permission_mode: 'yolo',
  metadata: { host_folders: ['/'] },
 };
 const file = buildTemplateExport(stored, { exportedAt: '2026-07-30T00:00:00.000Z' });

 assert.deepEqual(Object.keys(file.template).sort(), [...CARRIED_FIELDS].sort());
 const text = JSON.stringify(file);
 for (const forbidden of ['yolo', 'host_folders', WORKSPACE, USER, 'tpl-1']) {
  assert.equal(text.includes(forbidden), false, `${forbidden} must not appear anywhere in an export`);
 }
});

test('a file naming a privileged field is REFUSED, and the key is named', () => {
 // Silently dropping it is the failure mode that matters: someone hand-edits
 // "permissionMode": "yolo" into a file, the import succeeds, and they believe
 // the agent they hand over will run in that mode.
 //
 // MUTATION: pass { allowUnknown: true } through readTemplateExport -> the
 // import succeeds and this fails.
 const { readTemplateExport } = require('../shared/agentTemplates.cjs');
 const result = readTemplateExport({
  format: 'agensis.agent-template',
  formatVersion: 1,
  template: { name: 'Ops', systemPrompt: 'hi', permissionMode: 'yolo' },
 });
 assert.equal(result.ok, false);
 assert.match(result.errors.join(' '), /permissionMode/);
});

test('a file from another tool, or from the future, is refused by name', () => {
 const { readTemplateExport, TEMPLATE_EXPORT_VERSION } = require('../shared/agentTemplates.cjs');

 const foreign = readTemplateExport({ format: 'someone-else.persona', formatVersion: 1, template: { name: 'X' } });
 assert.equal(foreign.ok, false);
 assert.match(foreign.errors.join(' '), /not an agensis agent template/);

 // A newer envelope is refused rather than read best-effort: a v2 field this
 // build does not know could be one whose ABSENCE changes what the persona
 // means, and quietly ignoring it would produce a different agent.
 const future = readTemplateExport({
  format: 'agensis.agent-template',
  formatVersion: TEMPLATE_EXPORT_VERSION + 1,
  template: { name: 'X' },
 });
 assert.equal(future.ok, false);
 assert.match(future.errors.join(' '), /newer version/);

 assert.equal(readTemplateExport('not json at all').ok, false);
 assert.equal(readTemplateExport(null).ok, false);
 assert.equal(readTemplateExport([]).ok, false);
});

test('a round trip through a file preserves the persona', () => {
 // The export is only useful if it comes back the same. MUTATION: drop a field
 // from the export body -> the round trip loses it and this fails.
 const { buildTemplateExport, readTemplateExport } = require('../shared/agentTemplates.cjs');
 const original = normalizeAgentTemplate({
  name: 'Ops Runner',
  category: 'Saved',
  description: 'Runs operational tasks.',
  systemPrompt: 'You are an operations agent.',
  soul: 'Careful and terse.',
  instructions: 'Ask before destructive things.',
  tools: ['Bash'],
  skills: ['deploy'],
  model: 'auto',
  runMode: 'daemon',
  runtime: 'claude',
  accentColor: '#ffffff',
 });
 assert.equal(original.ok, true, original.errors.join('; '));

 const file = buildTemplateExport(original.template);
 const back = readTemplateExport(JSON.parse(JSON.stringify(file)));
 assert.equal(back.ok, true, back.errors.join('; '));
 assert.deepEqual(back.template, original.template);
});

test('import is MANAGE, unlike authoring, and is audited', () => {
 // The role divergence is the decision: authoring prose grants nothing new
 // ('write'), but prose ARRIVING FROM OUTSIDE the workspace is a different
 // call. And it is the only template action audited, for the same reason.
 //
 // MUTATION: change the enforceWorkspaceRole call to 'write' -> the role assert
 // fails. Drop the recordAudit call -> the audit assert fails.
 const { readTemplateExport, templateFingerprint } = require('../shared/agentTemplates.cjs');
 const db = makeDb();
 const roles = [];
 const audits = [];
 const engine = build(db, {
  enforceWorkspaceRole: async (userId, workspaceId, role) => { roles.push(role); return true; },
  readTemplateExport,
  templateFingerprint,
  recordAudit: async (entry) => { audits.push(entry); return null; },
 });

 return engine.importAgentTemplate({
  userId: USER,
  workspaceId: WORKSPACE,
  payload: {
   format: 'agensis.agent-template',
   formatVersion: 1,
   template: { name: 'Ops Runner', systemPrompt: 'You are an operations agent.' },
  },
 }).then(() => {
  assert.deepEqual(roles, ['manage']);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'agent_template.imported');
  assert.equal(audits[0].workspaceId, WORKSPACE);

  // Provenance is set by the SERVER, never taken from the caller: a file
  // claiming source='authored' would erase the record of where it came from.
  const params = insertedParams(db);
  assert.equal(params[18], 'imported');
  assert.equal(typeof params[19], 'object', 'origin is bound as an object, not a JSON string');
  assert.equal(params[19].format, 'agensis.agent-template');
 });
});

test('authoring stays UNAUDITED, so the log does not fill with non-events', () => {
 // A template cannot carry privilege, so writing one is a non-event. Logging
 // every prompt edit would bury the rows that matter — which is the same
 // argument that says an IMPORT must be logged.
 const db = makeDb();
 const audits = [];
 const engine = build(db, { recordAudit: async (entry) => { audits.push(entry); return null; } });
 return engine.createAgentTemplate({
  userId: USER,
  workspaceId: WORKSPACE,
  template: { name: 'Ops Runner', systemPrompt: 'hi' },
 }).then(() => {
  assert.deepEqual(audits, []);
 });
});

test('the import audit action is registered, or the row would record as unknown', () => {
 // recordAudit maps an unrecognised action to 'unknown' rather than throwing,
 // so a missing registration is invisible at runtime and only shows up as a
 // useless row in the log weeks later.
 assert.equal(core.AUDIT_ACTIONS.has('agent_template.imported'), true);
});
