'use strict';

// ============================================================================
// tests/automations-surface.test.cjs
// ----------------------------------------------------------------------------
// The surfaces around the engine: the three-place schema rule, the client write
// boundary, and the routes as actually mounted in the real express app.
//
// The route block runs the REAL app against a fake db, so it covers the wiring
// (auth middleware, the feature flag, the role gate) rather than a
// re-implementation of it.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const core = require('../shared/backend-core.cjs');
const { ensureTable } = require('../server/lib/db-sql.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const MIGRATION = 'supabase/migrations/20260730120000_automations.sql';

// --- three-place schema ------------------------------------------------------

function sources() {
 return {
  runtime: read('server/index.cjs'),
  canonical: read('database/neon-schema.sql'),
  migration: read(MIGRATION),
 };
}

test('both automation tables are created in all three schema places', () => {
 for (const [place, source] of Object.entries(sources())) {
  assert.match(source, /CREATE TABLE IF NOT EXISTS automations \(/, `${place} missing automations`);
  assert.match(source, /CREATE TABLE IF NOT EXISTS automation_runs \(/, `${place} missing automation_runs`);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_automations_workspace/, place);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_automations_trigger/, place);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_automation_runs_pending/, place);
 }
});

test('the enqueue dedupe index exists in all three places', () => {
 // MUTATION: drop this index anywhere -> that place fails. The index IS the
 // idempotency: without it a retried write enqueues the automation twice.
 for (const [place, source] of Object.entries(sources())) {
  assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_event\s+ON automation_runs\(automation_id, event_id\)/, place);
 }
});

test('automations default to disabled in all three places', () => {
 // MUTATION: change the default to true anywhere -> that place fails.
 for (const [place, source] of Object.entries(sources())) {
  const table = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS automations ('));
  const body = table.slice(0, table.indexOf(');'));
  assert.match(body, /enabled boolean NOT NULL DEFAULT false/, place);
  assert.match(body, /workspace_id uuid NOT NULL REFERENCES workspaces\(id\) ON DELETE CASCADE/, place);
  assert.match(body, /trigger_event text NOT NULL/, place);
 }
});

test('exactly one automations migration exists', () => {
 const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('_automations.sql'));
 assert.deepEqual(migrations, ['20260730120000_automations.sql']);
});

test('automations is created after workspaces in neon-schema.sql', () => {
 // Applied top-to-bottom with ON_ERROR_STOP=1, so a forward REFERENCES breaks
 // fresh-DB provisioning outright.
 const lines = read('database/neon-schema.sql').split('\n');
 const lineOf = (table) => lines.findIndex((line) => new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`).test(line));
 assert.ok(lineOf('workspaces') > 0 && lineOf('workspaces') < lineOf('automations'));
 assert.ok(lineOf('automations') < lineOf('automation_runs'), 'automation_runs references automations');
});

test('the runtime DDL sits inside ensureRuntimeSchema', () => {
 const runtime = read('server/index.cjs');
 const start = runtime.indexOf('async function ensureRuntimeSchema()');
 const ddl = runtime.indexOf('CREATE TABLE IF NOT EXISTS automations (');
 const end = runtime.indexOf('\nasync function ', start + 10);
 assert.ok(start > 0 && ddl > start && ddl < end, 'the DDL must run on Fly boot');
});

// --- the client write boundary ----------------------------------------------

test('automations are read-only to clients through the generic db path', () => {
 // MUTATION: change either insert to 'write' -> this fails.
 //
 // This is the control that matters most on this table. An automations row is a
 // STANDING grant: when its trigger fires the server writes into the workspace
 // with no human in the loop. A client-forged row would hand that primitive to
 // anyone who can reach /backend/db/insert.
 const expected = { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' };
 assert.deepEqual(core.DB_TABLE_ACCESS.automations, expected);
 assert.deepEqual(core.DB_TABLE_ACCESS.automation_runs, expected);
 // Identical to agent_schedules, the other standing "act without a human"
 // record, and deliberately NOT to agent_webhooks: a webhook row selects at
 // 'manage' because it carries a URL token, which is a credential. An
 // automation definition carries no secret, so hiding it from members would buy
 // nothing and would make a workspace's own behaviour undiscoverable to it.
 assert.deepEqual(core.DB_TABLE_ACCESS.automations, core.DB_TABLE_ACCESS.agent_schedules);
 assert.equal(core.DB_TABLE_ACCESS.agent_webhooks.select, 'manage', 'the contrast this comment relies on');
});

test('both tables are workspace-scoped and reachable for READS', () => {
 for (const table of ['automations', 'automation_runs']) {
  assert.equal(core.ALLOWED_TABLES.has(table), true, `${table} must be readable over /backend/db`);
  assert.equal(core.WORKSPACE_SCOPED_TABLES.has(table), true, `${table} must be workspace-scoped`);
  assert.doesNotThrow(() => ensureTable(table));
 }
 // Without workspace scoping, a read would not be constrained to the caller's
 // workspace at all — that is the whole tenancy boundary for a readable table.
});

test('the jsonb columns are declared so they bind as jsonb, not as strings', () => {
 assert.equal(core.JSON_COLUMNS_BY_TABLE.automations.has('definition'), true);
 assert.equal(core.JSON_COLUMNS_BY_TABLE.automation_runs.has('payload'), true);
 assert.equal(core.JSON_COLUMNS_BY_TABLE.automation_runs.has('steps'), true);
});

test('the automation audit actions are registered', () => {
 // An action a call site emits but the registry does not know records as
 // 'unknown' in production — visible, but unfilterable.
 for (const action of ['automation.created', 'automation.updated', 'automation.deleted', 'automation.enabled', 'automation.disabled']) {
  assert.equal(core.AUDIT_ACTIONS.has(action), true, `${action} must be registered`);
 }
});

// --- routes, through the real app -------------------------------------------

const { createApp, __test } = require('../server/index.cjs');

const USER = 'user-1';
const WORKSPACE = 'ws-1';

test.afterEach(() => {
 __test.resetTestState();
 delete process.env.AGENSIS_AUTOMATIONS;
});

function makeDb({ role = 'owner' } = {}) {
 const queries = [];
 return {
  queries,
  async unsafe(sql, params = []) {
   const raw = String(sql).replace(/\s+/g, ' ').trim();
   const q = raw.toLowerCase();
   if (!/^create |^drop |^alter |^do \$\$/.test(q)) queries.push({ sql: raw, params });
   if (q.startsWith('select value from app_settings')) return params[0] === 'AUTH_SECRET' ? [{ value: 'automation-secret' }] : [];
   if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
   if (q.startsWith('select 1 from workspaces where id')) return role === 'owner' && String(params[1]) === USER ? [{ ok: 1 }] : [];
   if (q.startsWith('select role from workspace_members')) return role && role !== 'owner' && role !== 'none' ? [{ role }] : [];
   if (q.includes('with recursive chain as')) return [];
   if (q.startsWith('select id, workspace_id, visibility, folder, deleted_at from chat_sessions where id = $1')) {
    return params[0] === 'chan-2'
     ? [{ id: 'chan-2', workspace_id: WORKSPACE, visibility: 'workspace', folder: 'General', deleted_at: null }]
     : [];
   }
   if (q.startsWith('select * from automations where workspace_id')) return [];
   if (q.startsWith('insert into automations')) return [{ id: 'auto-1', workspace_id: WORKSPACE, definition: {}, trigger_event: 'message.created' }];
   return [];
  },
 };
}

async function withServer(fn) {
 const app = createApp();
 const server = http.createServer(app);
 await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
 const { port } = server.address();
 try {
  return await fn(`http://127.0.0.1:${port}`);
 } finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
 }
}

const VALID_DEFINITION = {
 version: 1,
 trigger: { event: 'message.created' },
 when: [{ field: 'data.content', op: 'contains', value: 'deploy failed' }],
 steps: [{ action: 'post_message', channelId: 'chan-2', text: 'Heads up' }],
};

function call(baseUrl, method, path, token, body) {
 return fetch(`${baseUrl}${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
 });
}

test('with the flag off every automation route 404s', async () => {
 // MUTATION: gate only the worker and not the routes -> this fails. A flag that
 // still lets an automation be CREATED while off is not a rollout control.
 process.env.AGENSIS_AUTOMATIONS = '0';
 const db = makeDb();
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  assert.equal((await call(baseUrl, 'GET', `/backend/workspaces/${WORKSPACE}/automations`, token)).status, 404);
  assert.equal((await call(baseUrl, 'POST', `/backend/workspaces/${WORKSPACE}/automations`, token, { definition: VALID_DEFINITION })).status, 404);
  assert.equal((await call(baseUrl, 'GET', `/backend/workspaces/${WORKSPACE}/automation-runs`, token)).status, 404);
 });
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().includes('insert into automations')), false);
});

test('with the flag on an owner can list and create', async () => {
 process.env.AGENSIS_AUTOMATIONS = '1';
 __test.setTestDb(makeDb());
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  assert.equal((await call(baseUrl, 'GET', `/backend/workspaces/${WORKSPACE}/automations`, token)).status, 200);
  const created = await call(baseUrl, 'POST', `/backend/workspaces/${WORKSPACE}/automations`, token, {
   name: 'Deploy alarm', definition: VALID_DEFINITION,
  });
  assert.equal(created.status, 201);
 });
});

for (const role of ['viewer', 'commenter', 'editor']) {
 test(`a ${role} cannot create an automation`, async () => {
  // MUTATION: change 'manage' to 'write' in createAutomation -> the editor case
  // starts succeeding and this fails.
  process.env.AGENSIS_AUTOMATIONS = '1';
  const db = makeDb({ role });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
   const res = await call(baseUrl, 'POST', `/backend/workspaces/${WORKSPACE}/automations`, token, { definition: VALID_DEFINITION });
   assert.equal(res.status, 403);
  });
  assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into automations')), false);
 });
}

test('a viewer CAN read the list, so automations are discoverable', async () => {
 // An automation members cannot see is indistinguishable from the product
 // behaving strangely.
 process.env.AGENSIS_AUTOMATIONS = '1';
 __test.setTestDb(makeDb({ role: 'viewer' }));
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  assert.equal((await call(baseUrl, 'GET', `/backend/workspaces/${WORKSPACE}/automations`, token)).status, 200);
 });
});

test('an unauthenticated caller gets 401', async () => {
 process.env.AGENSIS_AUTOMATIONS = '1';
 __test.setTestDb(makeDb());
 await withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/automations`);
  assert.equal(res.status, 401);
 });
});

test('an invalid definition is refused with a 400 and writes nothing', async () => {
 process.env.AGENSIS_AUTOMATIONS = '1';
 const db = makeDb();
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  for (const definition of [
   { ...VALID_DEFINITION, steps: [{ action: 'dispatch_agent', channelId: 'c', text: 't' }] },
   { ...VALID_DEFINITION, when: [{ field: 'data.secret', op: 'equals', value: 'x' }] },
   { ...VALID_DEFINITION, trigger: { event: 'workspace.deleted' } },
   {},
  ]) {
   const res = await call(baseUrl, 'POST', `/backend/workspaces/${WORKSPACE}/automations`, token, { definition });
   assert.equal(res.status, 400, `${JSON.stringify(definition).slice(0, 60)} must be refused`);
  }
 });
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into automations')), false);
});

test('the generic db path cannot INSERT an automation', async () => {
 // The table is readable over /backend/db (so the list goes live over realtime)
 // but every write is manage-gated there, and the dedicated route is the only
 // place a definition is validated.
 // MUTATION: set DB_TABLE_ACCESS.automations.insert to 'write' -> an editor's
 // forged row lands and this fails.
 process.env.AGENSIS_AUTOMATIONS = '1';
 const db = makeDb({ role: 'editor' });
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/backend/db/insert`, {
   method: 'POST',
   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
   body: JSON.stringify({
    table: 'automations',
    values: { workspace_id: WORKSPACE, trigger_event: 'message.created', enabled: true, definition: {} },
    single: true,
   }),
  });
  assert.equal(res.status, 403);
 });
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into automations')), false);
});
