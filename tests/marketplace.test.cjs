'use strict';

// ============================================================================
// tests/marketplace.test.cjs
// ----------------------------------------------------------------------------
// The agent marketplace: the three-place schema rule for marketplace_listings
// and marketplace_hires, plus the assertions this feature exists to keep true:
//
//   1. NO privilege-bearing column exists on a listing, in any schema place —
//      the workspace_agent_templates rule applied across the TENANT boundary.
//   2. A 'hire' listing structurally carries no persona body: the validator
//      refuses one, the table CHECK refuses one, and the projection never
//      builds one. Three independent layers, each tested.
//   3. The hired roster row is server-authored from NO caller fields: empty
//      prompt, empty skills/tools, permission_mode 'default', run_mode
//      'external'. hiredAgentDraft PICKS cosmetics and never spreads.
//   4. RBAC: browsing is any signed-in user; publish and hire are 'manage'.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const {
 normalizeMarketplaceListing,
 publicMarketplaceListing,
 hiredAgentDraft,
} = require('../shared/marketplace.cjs');
const { ALLOWED_TABLES } = require('../shared/backend-core.cjs');
const { createApp, __test } = require('../server/index.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const MIGRATION = 'supabase/migrations/20260810120000_agent_marketplace.sql';

function sources() {
 return {
  runtime: read('server/index.cjs'),
  canonical: read('database/neon-schema.sql'),
  migration: read(MIGRATION),
 };
}

function tableBody(source, table) {
 const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
 assert.ok(start >= 0, `the ${table} table is missing entirely`);
 const body = source.slice(start);
 return body.slice(0, body.indexOf(');'));
}

function columnsOf(body) {
 return body
  .split('\n')
  .map((line) => line.replace(/--.*$/, '').trim())
  .filter((line) => line && !line.startsWith('CREATE TABLE') && !line.startsWith('UNIQUE'))
  .map((line) => line.split(/\s+/)[0].replace(/,$/, ''))
  .filter((name) => /^[a-z_]+$/.test(name));
}

// ---------------------------------------------------------------------------
// Schema: three places, no authority columns, hire carries no body
// ---------------------------------------------------------------------------

for (const table of ['marketplace_listings', 'marketplace_hires']) {
 test(`${table} is created in all three schema places`, () => {
  for (const [place, source] of Object.entries(sources())) {
   assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), `${place} is missing the table`);
  }
 });

 test(`the three declarations agree on the exact ${table} column set`, () => {
  // MUTATION: add a column to ensureRuntimeSchema only -> this fails naming
  // the places that lack it. Three-place drift is the repo's #1 footgun.
  const entries = Object.entries(sources()).map(([place, source]) => [place, columnsOf(tableBody(source, table)).sort()]);
  const [firstPlace, firstColumns] = entries[0];
  for (const [place, columns] of entries.slice(1)) {
   assert.deepEqual(columns, firstColumns, `${place} disagrees with ${firstPlace} on the ${table} column set`);
  }
  assert.ok(firstColumns.length >= 10, `expected a real column list, got ${firstColumns.length}`);
 });
}

test('NO privilege-bearing column exists on marketplace_listings, anywhere', () => {
 // THE structural control. MUTATION: add `permission_mode text` or
 // `metadata jsonb` to any one of the three -> this fails naming that place.
 const forbidden = [
  'permission_mode', 'metadata', 'sandbox_provider', 'sandbox_config',
  'connect_token', 'connect_token_hash', 'mcp_approved', 'memory_dir',
  'identity', 'enabled', 'host_folders', 'sandbox_skills',
 ];
 for (const [place, source] of Object.entries(sources())) {
  const columns = columnsOf(tableBody(source, 'marketplace_listings'));
  for (const column of forbidden) {
   assert.equal(
    columns.includes(column),
    false,
    `${place} declares a ${column} column on marketplace_listings — a listing crosses tenant boundaries and must never carry authority`,
   );
  }
 }
});

test('the hire-carries-no-body CHECK exists in all three places', () => {
 // MUTATION: drop marketplace_listings_hire_carries_no_body from one place ->
 // this fails there. Without it, "hirers never see the prompt" would rest on
 // the projection alone, which AGENTS.md documents as not-a-control.
 for (const [place, source] of Object.entries(sources())) {
  const body = tableBody(source, 'marketplace_listings');
  assert.match(body, /marketplace_listings_hire_carries_no_body/, `${place} lost the CHECK`);
  assert.match(body, /listing_type = 'template' OR \(/, place);
 }
});

test('the DDL comment explains WHY the authority columns are absent', () => {
 for (const [place, source] of Object.entries(sources())) {
  const window = source.slice(
   Math.max(0, source.indexOf('CREATE TABLE IF NOT EXISTS marketplace_listings (') - 3000),
   source.indexOf('CREATE TABLE IF NOT EXISTS marketplace_listings ('),
  );
  assert.match(window, /permission_mode/, `${place} DDL comment must name permission_mode`);
  assert.match(window, /metadata/, `${place} DDL comment must name metadata`);
  assert.match(window, /host_folders/, `${place} DDL comment must explain host_folders`);
 }
});

test('exactly one marketplace migration exists', () => {
 const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('_agent_marketplace.sql'));
 assert.deepEqual(migrations, ['20260810120000_agent_marketplace.sql']);
});

test('the tables are created after their referents in neon-schema.sql', () => {
 const lines = read('database/neon-schema.sql').split('\n');
 const lineOf = (table) => lines.findIndex((line) => new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`).test(line));
 assert.ok(lineOf('workspaces') > 0);
 assert.ok(lineOf('workspaces') < lineOf('marketplace_listings'));
 assert.ok(lineOf('workspace_agents') < lineOf('marketplace_listings'));
 assert.ok(lineOf('marketplace_listings') < lineOf('marketplace_hires'));
});

test('the runtime DDL sits inside ensureRuntimeSchema', () => {
 const runtime = read('server/index.cjs');
 const start = runtime.indexOf('async function ensureRuntimeSchema()');
 const ddl = runtime.indexOf('CREATE TABLE IF NOT EXISTS marketplace_listings (');
 const end = runtime.indexOf('\nasync function ', start + 10);
 assert.ok(start > 0 && ddl > start && ddl < end, 'the DDL must run on Fly boot');
});

test('neither marketplace table is generically reachable through /backend/db', () => {
 // The dedicated routes are the only doors, so the validator always runs and
 // a hire row can never be forged by a generic insert. MUTATION: add either
 // table to ALLOWED_TABLES -> this fails.
 assert.equal(ALLOWED_TABLES.has('marketplace_listings'), false);
 assert.equal(ALLOWED_TABLES.has('marketplace_hires'), false);
});

// ---------------------------------------------------------------------------
// Validator: layer one of "a hire carries no body"
// ---------------------------------------------------------------------------

const TEMPLATE_BODY = {
 name: 'Docs helper',
 systemPrompt: 'You write docs.',
 skills: ['writing'],
};

test('a template listing validates and fingerprints its body', () => {
 const result = normalizeMarketplaceListing({
  listingType: 'template',
  name: 'Docs helper',
  description: 'Writes docs',
  capabilities: ['Writes docs'],
  template: TEMPLATE_BODY,
 });
 assert.equal(result.ok, true, result.errors.join('; '));
 assert.equal(result.listing.slug, 'docs-helper');
 assert.equal(result.listing.template.systemPrompt, 'You write docs.');
 assert.match(result.listing.fingerprint, /^[0-9a-f]{64}$/);
});

test('a hire listing REFUSES a template body rather than dropping it', () => {
 // A silent drop would teach a publisher the body was shared when it was not.
 const result = normalizeMarketplaceListing({
  listingType: 'hire',
  name: 'Docs helper',
  capabilities: ['Writes docs'],
  template: TEMPLATE_BODY,
 });
 assert.equal(result.ok, false);
 assert.match(result.errors.join('; '), /never carries the agent definition/);
});

test('a hire listing without capabilities is refused', () => {
 // A hired agent shows the hirer nothing else — no capabilities would be a
 // black box in someone's roster.
 const result = normalizeMarketplaceListing({ listingType: 'hire', name: 'Mystery' });
 assert.equal(result.ok, false);
 assert.match(result.errors.join('; '), /at least one capability/);
});

test('a template body naming a privileged field is refused with the key named', () => {
 // Inherited from normalizeAgentTemplate: the marketplace must not be a
 // softer door than the template import lane.
 const result = normalizeMarketplaceListing({
  listingType: 'template',
  name: 'Sneaky',
  template: { ...TEMPLATE_BODY, permissionMode: 'yolo' },
 });
 assert.equal(result.ok, false);
 assert.match(result.errors.join('; '), /permissionMode/);
});

test('capabilities must be strings — a non-string is a refusal, not a drop', () => {
 const result = normalizeMarketplaceListing({
  listingType: 'template',
  name: 'Docs helper',
  capabilities: ['ok', { evil: true }],
  template: TEMPLATE_BODY,
 });
 assert.equal(result.ok, false);
 assert.match(result.errors.join('; '), /capabilities must be an array of strings/);
});

// ---------------------------------------------------------------------------
// Projection: layer three of "a hire carries no body"
// ---------------------------------------------------------------------------

/** A hire row AS IF prose had somehow landed in it despite the CHECK. */
const POISONED_HIRE_ROW = {
 id: 'listing-1',
 publisher_workspace_id: 'w-host',
 slug: 'helper',
 listing_type: 'hire',
 name: 'Helper',
 category: 'Community',
 description: 'Helps',
 capabilities: ['Reviews PRs'],
 system_prompt: 'SECRET PROMPT',
 soul: 'SECRET SOUL',
 instructions: 'SECRET INSTRUCTIONS',
 tools: ['secret-tool'],
 skills: ['secret-skill'],
 purpose: 'collaborator',
 resource_facets: [],
 model: 'auto',
 run_mode: 'daemon',
 runtime: 'claude',
 avatar: 'AI',
 accent_color: '#123456',
 source_agent_id: 'agent-host',
 status: 'published',
 install_count: 0,
 hire_count: 2,
 fingerprint: '',
};

test('the public projection of a hire row contains no persona body and no host agent id', () => {
 // MUTATION: make publicMarketplaceListing build the template object for every
 // row -> this fails. The projection must never even read the prose columns on
 // the hire branch.
 const projected = publicMarketplaceListing(POISONED_HIRE_ROW);
 assert.equal(projected.template, null);
 const serialized = JSON.stringify(projected);
 assert.ok(!serialized.includes('SECRET'), 'a hire projection leaked prose');
 assert.ok(!serialized.includes('secret-skill'), 'a hire projection leaked skills');
 assert.ok(!serialized.includes('agent-host'), 'a hire projection leaked the host agent id');
 assert.deepEqual(projected.capabilities, ['Reviews PRs']);
});

test('the hired roster draft carries cosmetics and intent, never prose or authority', () => {
 // MUTATION: spread the listing row inside hiredAgentDraft -> this fails.
 const draft = hiredAgentDraft(POISONED_HIRE_ROW);
 assert.equal(draft.runMode, 'external');
 for (const key of ['systemPrompt', 'soul', 'instructions', 'skills', 'tools', 'metadata', 'permission_mode', 'permissionMode']) {
  assert.equal(key in draft, false, `hiredAgentDraft must not carry ${key}`);
 }
 const serialized = JSON.stringify(draft);
 assert.ok(!serialized.includes('SECRET'), 'the hired draft leaked prose');
 assert.match(draft.description, /Reviews PRs/);
});

// ---------------------------------------------------------------------------
// Routes: RBAC and the server-authored hire insert
// ---------------------------------------------------------------------------

const USER = 'user-1';
const WORKSPACE = 'w1';
const HOST_WORKSPACE = 'w-host';

const HIRE_LISTING_ROW = { ...POISONED_HIRE_ROW, system_prompt: '', soul: '', instructions: '', tools: [], skills: [] };

const TEMPLATE_LISTING_ROW = {
 ...HIRE_LISTING_ROW,
 id: 'listing-2',
 slug: 'docs-helper',
 listing_type: 'template',
 source_agent_id: null,
 system_prompt: 'You write docs.',
};

const AGENT_ROW = {
 id: 'agent-1',
 workspace_id: WORKSPACE,
 name: 'Docs helper',
 handle: 'docs-helper',
 description: 'Writes docs',
 system_prompt: 'You write docs.',
 soul: '',
 instructions: '',
 tools: [],
 skills: ['writing'],
 purpose: 'collaborator',
 resource_facets: [],
 model: 'auto',
 run_mode: 'builtin',
 permission_mode: 'yolo',
 metadata: { host_folders: ['/'] },
 connect_token_hash: 'hash',
 avatar: 'AI',
 accent_color: '#123456',
};

function makeDb({ role = 'owner', listings = [] } = {}) {
 const queries = [];
 const db = {
  queries,
  async unsafe(sql, params = []) {
   const raw = String(sql).replace(/\s+/g, ' ').trim();
   const q = raw.toLowerCase();
   if (!/^create |^drop |^alter |^do \$\$/.test(q)) queries.push({ sql: raw, params });
   if (q.startsWith('insert into audit_log')) return [{ id: 'audit-1', seq: 1 }];
   if (q.startsWith('select value from app_settings')) {
    return params[0] === 'AUTH_SECRET' ? [{ value: 'marketplace-secret' }] : [];
   }
   if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
   if (q.startsWith('select 1 from workspaces where id')) {
    return role === 'owner' && String(params[1]) === USER ? [{ ok: 1 }] : [];
   }
   if (q.startsWith('select role from workspace_members')) {
    return role && role !== 'owner' && role !== 'none' ? [{ role }] : [];
   }
   if (q.includes('from marketplace_listings where id')) {
    return listings.filter((row) => row.id === params[0]);
   }
   if (q.includes("from marketplace_listings where status = 'published'")) {
    return listings;
   }
   if (q.includes('select count(*)::int as n from marketplace_listings')) return [{ n: 0 }];
   if (q.startsWith('select id from marketplace_hires')) return [];
   if (q.startsWith('select handle from workspace_agents')) return [{ handle: 'taken' }];
   if (q.startsWith('select * from workspace_agents where id')) {
    return params[0] === AGENT_ROW.id && params[1] === WORKSPACE ? [AGENT_ROW] : [];
   }
   if (q.startsWith('insert into workspace_agents')) {
    return [{ id: 'hired-agent-1', workspace_id: params[0], name: params[1], handle: params[2] }];
   }
   if (q.startsWith('insert into marketplace_hires')) {
    return [{
     id: 'hire-1', listing_id: params[0], hirer_workspace_id: params[1],
     hired_agent_id: params[2], host_workspace_id: params[3],
     listing_name: params[5], status: 'active',
    }];
   }
   if (q.startsWith('insert into marketplace_listings')) {
    return [{ ...TEMPLATE_LISTING_ROW, id: 'listing-new', publisher_workspace_id: params[0], slug: params[1], listing_type: params[2], name: params[3] }];
   }
   if (q.startsWith('update marketplace_listings')) return [];
   return [];
  },
 };
 return db;
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

test.afterEach(() => __test.resetTestState());

test('browsing the marketplace requires a signed-in user', async () => {
 const db = makeDb({ listings: [HIRE_LISTING_ROW] });
 __test.setTestDb(db);
 await withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/backend/marketplace/listings`);
  assert.equal(res.status, 401);
 });
});

test('any signed-in user browses published listings, projected', async () => {
 const db = makeDb({ listings: [HIRE_LISTING_ROW, TEMPLATE_LISTING_ROW] });
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/backend/marketplace/listings`, {
   headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 2);
  const hire = body.data.find((entry) => entry.listingType === 'hire');
  assert.equal(hire.template, null);
  const tpl = body.data.find((entry) => entry.listingType === 'template');
  assert.equal(tpl.template.systemPrompt, 'You write docs.');
 });
});

for (const role of ['viewer', 'editor']) {
 test(`a ${role} cannot publish to the marketplace`, async () => {
  // MUTATION: change 'manage' to 'write' in publishMarketplaceListing -> the
  // editor case fails. Publishing pushes prose across the tenant boundary.
  const db = makeDb({ role });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
   const res = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/marketplace/listings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT_ROW.id, listing: { listingType: 'template' } }),
   });
   assert.equal(res.status, 403);
  });
  assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into marketplace_listings')), false);
 });

 test(`a ${role} cannot hire`, async () => {
  const db = makeDb({ role, listings: [HIRE_LISTING_ROW] });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
   const res = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/marketplace/listings/${HIRE_LISTING_ROW.id}/hire`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
   });
   assert.equal(res.status, 403);
  });
  assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into workspace_agents')), false);
 });
}

test('publishing derives the listing from the agent row server-side and audits it', async () => {
 const db = makeDb();
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/marketplace/listings`, {
   method: 'POST',
   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
   body: JSON.stringify({ agentId: AGENT_ROW.id, listing: { listingType: 'template' } }),
  });
  assert.equal(res.status, 201);
 });
 const insert = db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into marketplace_listings'));
 assert.ok(insert, 'the listing insert must run');
 // The agent row carries permission_mode 'yolo', metadata.host_folders and a
 // connect token hash. NONE of that may appear in the bound params — the draft
 // PICKS fields; a spread would fail here.
 const bound = JSON.stringify(insert.params);
 assert.ok(!bound.includes('yolo'), 'permission_mode leaked into a listing');
 assert.ok(!bound.includes('host_folders'), 'metadata leaked into a listing');
 assert.ok(!bound.includes('hash'), 'the connect token hash leaked into a listing');
 assert.ok(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into audit_log')), 'publishing must be audited');
});

test('hiring inserts a Connector shell with no prose and records the hire', async () => {
 const db = makeDb({ listings: [HIRE_LISTING_ROW] });
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/marketplace/listings/${HIRE_LISTING_ROW.id}/hire`, {
   method: 'POST',
   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.agentId, 'hired-agent-1');
  assert.equal(body.data.hire.status, 'active');
 });

 const insert = db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into workspace_agents'));
 assert.ok(insert, 'the roster insert must run');
 const sql = insert.sql;
 // The prose columns and the permission mode are LITERAL server-owned
 // constants in the statement, not binds a caller could reach.
 assert.match(sql, /'','','','\[\]'::jsonb,'\[\]'::jsonb/, 'prompt/soul/instructions/tools/skills must be empty literals');
 assert.match(sql, /'external','default'/, "run_mode/permission_mode must be the literal 'external'/'default'");
 assert.ok(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into marketplace_hires')), 'the hire record must be written');
 // Audited in BOTH workspaces: the hirer's and the host's.
 const audits = db.queries.filter((entry) => entry.sql.toLowerCase().startsWith('insert into audit_log'));
 assert.ok(audits.length >= 2, 'hiring must audit hirer and host workspaces');
});

test('hiring a template listing is refused; copying a hire listing is refused', async () => {
 const db = makeDb({ listings: [HIRE_LISTING_ROW, TEMPLATE_LISTING_ROW] });
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  const hireTemplate = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/marketplace/listings/${TEMPLATE_LISTING_ROW.id}/hire`, {
   method: 'POST',
   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  assert.equal(hireTemplate.status, 400);
  const copyHire = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/marketplace/listings/${HIRE_LISTING_ROW.id}/copy`, {
   method: 'POST',
   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  assert.equal(copyHire.status, 400);
  const copyBody = await copyHire.json();
  assert.match(JSON.stringify(copyBody.error), /not shared/);
 });
});

test('hiring your own listing back into the publisher workspace is refused', async () => {
 const db = makeDb({ listings: [{ ...HIRE_LISTING_ROW, publisher_workspace_id: WORKSPACE }] });
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/marketplace/listings/${HIRE_LISTING_ROW.id}/hire`, {
   method: 'POST',
   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 400);
 });
});

test('copying a template listing routes through the import lane and audits it', async () => {
 const db = makeDb({ listings: [TEMPLATE_LISTING_ROW] });
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/marketplace/listings/${TEMPLATE_LISTING_ROW.id}/copy`, {
   method: 'POST',
   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 201);
 });
 // The copy must land in workspace_agent_templates through the SAME insert the
 // import route uses (source 'imported'), and be audited like any import.
 const templateInsert = db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into workspace_agent_templates'));
 assert.ok(templateInsert, 'the copy must write a workspace template');
 assert.ok(templateInsert.params.includes('imported'), "a marketplace copy is provenance 'imported'");
 assert.ok(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into audit_log')), 'a copy is a cross-workspace import and must be audited');
});
