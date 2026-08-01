'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
 createWorkspaceResourceService,
 RESOURCE_OPERATION_LEASE_MS,
} = require('../server/workspace-resources.cjs');

const WORKSPACE = 'workspace-1';
const OTHER_WORKSPACE = 'workspace-2';
const USER = 'user-1';
const STEWARD = 'agent-steward';
const REQUESTER_AGENT = 'agent-requester';
const CONTROLLER = 'controller-1';

function compactSql(sql) {
 return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function makeDb(handler = async () => []) {
 const queries = [];
 let beginCount = 0;
 const transaction = {
  async unsafe(sql, params = []) {
   const entry = { sql: String(sql), normalized: compactSql(sql), params };
   queries.push(entry);
   return handler(entry, { inTransaction: true });
  },
 };
 const db = {
  queries,
  get beginCount() { return beginCount; },
  async unsafe(sql, params = []) {
   const entry = { sql: String(sql), normalized: compactSql(sql), params };
   queries.push(entry);
   return handler(entry, { inTransaction: false });
  },
  async begin(callback) {
   beginCount += 1;
   return callback(transaction);
  },
 };
 return db;
}

function stewardRow(overrides = {}) {
 return {
  id: STEWARD,
  workspace_id: WORKSPACE,
  controller_id: CONTROLLER,
  name: 'Code Handler',
  handle: 'code-handler',
  purpose: 'resource',
  resource_facets: ['tooling', 'code'],
  enabled: true,
  ...overrides,
 };
}

function controllerRow(overrides = {}) {
 return {
  id: CONTROLLER,
  workspace_id: WORKSPACE,
  name: 'Build controller',
  scopes: ['agents:register', 'resources:create', 'resources:manage_own'],
  status: 'active',
  deleted_at: null,
  expires_at: '2099-01-01T00:00:00.000Z',
  ...overrides,
 };
}

function resourceRow(overrides = {}) {
 return {
  id: 'resource-1',
  workspace_id: WORKSPACE,
  steward_agent_id: STEWARD,
  controller_id: CONTROLLER,
  name: 'Repository handler',
  description: 'Applies reviewed changes.',
  facet: 'code',
  descriptor: { repository: 'agensis' },
  version: 3,
  visibility: 'workspace',
  status: 'active',
  created_by: USER,
  created_at: '2026-07-31T10:00:00.000Z',
  updated_at: '2026-07-31T10:00:00.000Z',
  ...overrides,
 };
}

function operationRow(overrides = {}) {
 return {
  id: 'operation-1',
  workspace_id: WORKSPACE,
  resource_id: 'resource-1',
  steward_agent_id: STEWARD,
  requested_by_user_id: null,
  requested_by_agent_id: REQUESTER_AGENT,
  requested_by_controller_id: null,
  requester_key: `agent:${REQUESTER_AGENT}`,
  claimed_by_agent_id: null,
  operation: 'apply',
  input_artifact: { patch: 'safe diff' },
  output_artifact: {},
  status: 'pending',
  resource_version: 3,
  idempotency_key: 'apply:commit-1',
  attempt: 0,
  lease_version: '0',
  lease_expires_at: null,
  lease_is_live: false,
  error: '',
  audit_reference: null,
  created_at: '2026-07-31T10:01:00.000Z',
  updated_at: '2026-07-31T10:01:00.000Z',
  claimed_at: null,
  completed_at: null,
  ...overrides,
 };
}

function userActor(overrides = {}) {
 return { kind: 'user', userId: USER, workspaceId: WORKSPACE, ...overrides };
}

function agentActor(overrides = {}) {
 return { kind: 'agent', agentId: REQUESTER_AGENT, workspaceId: WORKSPACE, ...overrides };
}

function stewardActor(overrides = {}) {
 return { kind: 'agent', agentId: STEWARD, workspaceId: WORKSPACE, ...overrides };
}

function controllerActor(overrides = {}) {
 return { kind: 'controller', controllerId: CONTROLLER, workspaceId: WORKSPACE, ...overrides };
}

function build(db, overrides = {}) {
 const audits = [];
 const roleChecks = [];
 const service = createWorkspaceResourceService({
  getDb: () => db,
  enforceWorkspaceRole: async (userId, workspaceId, capability) => {
   roleChecks.push({ userId, workspaceId, capability });
  },
  recordAudit: async (entry) => {
   audits.push(entry);
   return { id: `audit-${audits.length}` };
  },
  ...overrides,
 });
 return { service, audits, roleChecks };
}

function definition(overrides = {}) {
 return {
  name: 'Repository handler',
  description: 'Applies reviewed changes.',
  facet: 'code',
  visibility: 'workspace',
  descriptor: { repository: 'agensis' },
  ...overrides,
 };
}

test('create derives controller ownership from a valid resource steward and returns only the public projection', async () => {
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents') && normalized.includes('for share')) return [stewardRow()];
  if (normalized.startsWith('insert into workspace_resources')) {
   assert.equal(params[0], WORKSPACE);
   assert.equal(params[1], STEWARD);
   assert.equal(params[2], CONTROLLER, 'controller lineage is derived from the steward');
   return [resourceRow({ descriptor: params[7], token_hash: 'never-return' })];
  }
  return [];
 });
 const { service, audits, roleChecks } = build(db);

 const resource = await service.createResource({
  workspaceId: WORKSPACE,
  stewardAgentId: STEWARD,
  definition: definition(),
  actor: userActor(),
 });

 assert.equal(resource.id, 'resource-1');
 assert.equal(resource.controller_id, CONTROLLER);
 assert.equal('token_hash' in resource, false);
 assert.deepEqual(roleChecks, [{ userId: USER, workspaceId: WORKSPACE, capability: 'manage' }]);
 assert.equal(db.beginCount, 1);
 assert.equal(audits.length, 1);
 assert.equal(audits[0].action, 'resource.created');
 assert.deepEqual(audits[0].actor, { userId: USER });
 const insert = db.queries.find(query => query.normalized.startsWith('insert into workspace_resources'));
 assert.ok(insert);
 assert.doesNotMatch(insert.normalized, /returning \*/);
 assert.doesNotMatch(insert.normalized, /select \*/);
});

test('user writes can lock workspace-role evidence in the same transaction', async () => {
 const lockedChecks = [];
 const db = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.startsWith('insert into workspace_resources')) return [resourceRow()];
  return [];
 });
 const { service } = build(db, {
  enforceWorkspaceRole: async () => {
   assert.fail('the unlocked authorization path must not run when the locked helper is available');
  },
  assertWorkspaceRoleLocked: async (input) => {
   lockedChecks.push(input);
   assert.equal(typeof input.db, 'function');
  },
 });

 await service.createResource({
  workspaceId: WORKSPACE,
  stewardAgentId: STEWARD,
  definition: definition(),
  actor: userActor(),
 });
 assert.equal(lockedChecks.length, 1);
 assert.equal(lockedChecks[0].userId, USER);
 assert.equal(lockedChecks[0].workspaceId, WORKSPACE);
 assert.equal(lockedChecks[0].capability, 'manage');
 assert.equal(db.beginCount, 1);
});

test('create rejects a collaborator steward, a missing facet, and unknown definition fields', async () => {
 for (const [agent, input, pattern] of [
  [stewardRow({ purpose: 'collaborator', resource_facets: [] }), definition(), /resource-purpose agent/i],
  [stewardRow({ resource_facets: ['tooling'] }), definition(), /code facet/i],
 ]) {
  const db = makeDb(async ({ normalized }) => (
   normalized.includes('from workspace_agents') ? [agent] : []
  ));
  const { service } = build(db);
  await assert.rejects(
   service.createResource({ workspaceId: WORKSPACE, stewardAgentId: STEWARD, definition: input, actor: userActor() }),
   error => error.status === 400 && pattern.test(error.message),
  );
  assert.equal(db.queries.some(query => query.normalized.startsWith('insert into workspace_resources')), false);
 }

 const db = makeDb();
 const { service } = build(db);
 await assert.rejects(
  service.createResource({
   workspaceId: WORKSPACE,
   stewardAgentId: STEWARD,
   definition: { ...definition(), permissionMode: 'yolo' },
   actor: userActor(),
  }),
  error => error.status === 400 && /unsupported resource definition field/i.test(error.message),
 );
});

test('controller create requires a live scope and a steward attributed to that controller', async () => {
 const goodDb = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_controllers')) return [controllerRow()];
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.startsWith('insert into workspace_resources')) return [resourceRow()];
  return [];
 });
 const good = build(goodDb);
 await good.service.createResource({
  workspaceId: WORKSPACE,
  stewardAgentId: STEWARD,
  definition: definition(),
  actor: controllerActor(),
 });
 assert.equal(good.audits[0].actor.label, `controller:${CONTROLLER}`);

 const wrongOwnerDb = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_controllers')) return [controllerRow()];
  if (normalized.includes('from workspace_agents')) return [stewardRow({ controller_id: 'controller-2' })];
  return [];
 });
 await assert.rejects(
  build(wrongOwnerDb).service.createResource({
   workspaceId: WORKSPACE, stewardAgentId: STEWARD, definition: definition(), actor: controllerActor(),
  }),
  error => error.status === 403 && /does not own the steward/i.test(error.message),
 );

 const noScopeDb = makeDb(async ({ normalized }) => (
  normalized.includes('from workspace_controllers')
   ? [controllerRow({ scopes: ['agents:register'] })]
   : []
 ));
 await assert.rejects(
  build(noScopeDb).service.createResource({
   workspaceId: WORKSPACE, stewardAgentId: STEWARD, definition: definition(), actor: controllerActor(),
  }),
  error => error.status === 403 && /resources:create/i.test(error.message),
 );
});

test('list and get are tenant-scoped, explicitly projected, and controller lists are ownership-scoped', async () => {
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_controllers')) return [controllerRow()];
  if (normalized.includes('from workspace_resources')) {
   assert.equal(params[0], WORKSPACE);
   assert.match(normalized, /controller_id = \$\d+/);
   return [resourceRow({ api_key_cipher: 'never-return' })];
  }
  return [];
 });
 const { service } = build(db);
 const listed = await service.listResources({ workspaceId: WORKSPACE, actor: controllerActor() });
 assert.equal(listed.length, 1);
 assert.equal('api_key_cipher' in listed[0], false);
 const selected = db.queries.find(query => query.normalized.includes('from workspace_resources'));
 assert.doesNotMatch(selected.normalized, /select \*/);
 assert.match(selected.normalized, /deleted_at is null/);

 await assert.rejects(
  service.getResource({ workspaceId: WORKSPACE, resourceId: 'resource-1', actor: agentActor({ workspaceId: OTHER_WORKSPACE }) }),
  error => error.status === 403 && /workspace/i.test(error.message),
 );
});

test('soft-delete retains the row, cancels queued work, blocks live claims, and audits the transition', async () => {
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.startsWith('select id') && normalized.includes('from resource_operations')) return [];
  if (normalized.startsWith('update resource_operations')) {
   return [operationRow({ status: 'cancelled', error: params[3] || '' })];
  }
  if (normalized.startsWith('update workspace_resources')) return [resourceRow({ status: 'archived', deleted_at: '2026-08-01T10:00:00.000Z' })];
  return [];
 });
 const { service, audits } = build(db);
 const deleted = await service.deleteResource({ workspaceId: WORKSPACE, resourceId: 'resource-1', actor: userActor() });
 assert.equal(deleted.deleted_at, '2026-08-01T10:00:00.000Z');
 assert.equal(audits[0].action, 'resource.deleted');
 assert.equal(audits[0].after, 'deleted');
 assert.match(db.queries.find(query => query.normalized.startsWith('update workspace_resources')).normalized, /deleted_at = now\(\)/);

 const liveDb = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.startsWith('select id') && normalized.includes('from resource_operations')) return [{ id: 'live-op' }];
  return [];
 });
 await assert.rejects(
  build(liveDb).service.deleteResource({ workspaceId: WORKSPACE, resourceId: 'resource-1', actor: userActor() }),
  error => error.status === 409 && /live claimed operation/i.test(error.message),
 );
});

test('restore clears the tombstone only after the steward is still valid', async () => {
 const db = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow({ status: 'archived', deleted_at: '2026-08-01T10:00:00.000Z' })];
  if (normalized.includes('from workspace_agents') && normalized.includes('for share')) return [stewardRow()];
  if (normalized.startsWith('update workspace_resources')) return [resourceRow({ status: 'active', deleted_at: null })];
  return [];
 });
 const { service, audits } = build(db);
 const restored = await service.restoreResource({ workspaceId: WORKSPACE, resourceId: 'resource-1', actor: userActor() });
 assert.equal(restored.deleted_at, null);
 assert.equal(restored.status, 'active');
 assert.equal(audits[0].action, 'resource.restored');
});

test('listOperations gives workspace readers bounded status rows without selecting artifacts or server-only keys', async () => {
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from resource_operations operation')) {
   assert.equal(params[0], WORKSPACE);
   return [operationRow({
    status: 'completed',
    input_artifact: { patch: 'large input' },
    output_artifact: { commit: 'abc123' },
   })];
  }
  return [];
 });
 const { service, roleChecks } = build(db);
 const rows = await service.listOperations({
  workspaceId: WORKSPACE,
  actor: userActor(),
  resourceId: 'resource-1',
  status: 'completed',
  limit: 10_000,
 });

 assert.equal(rows.length, 1);
 assert.equal(rows[0].status, 'completed');
 assert.equal('input_artifact' in rows[0], false);
 assert.equal('output_artifact' in rows[0], false);
 assert.deepEqual(roleChecks, [{ userId: USER, workspaceId: WORKSPACE, capability: 'read' }]);
 const query = db.queries.find(entry => entry.normalized.includes('from resource_operations operation'));
 assert.match(query.normalized, /join workspace_resources resource/);
 assert.doesNotMatch(query.normalized, /requester_key|idempotency_key|lease_version|input_artifact|output_artifact/);
 assert.equal(query.params.at(-1), 100, 'operation lists are capped independently of resource lists');
});

test('deleted operation history is manager-only recovery data', async () => {
 const db = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_agents')) {
   return [stewardRow({ id: REQUESTER_AGENT, purpose: 'collaborator', resource_facets: [] })];
  }
  if (normalized.includes('from resource_operations operation')) return [operationRow({ status: 'cancelled' })];
  return [];
 });
 const { service, roleChecks } = build(db);
 const rows = await service.listOperations({
  workspaceId: WORKSPACE,
  actor: userActor(),
  includeDeleted: true,
 });
 assert.equal(rows.length, 1);
 assert.doesNotMatch(
  db.queries.find(query => query.normalized.includes('from resource_operations operation')).normalized,
  /resource\.deleted_at is null/,
 );
 assert.deepEqual(roleChecks, [
  { userId: USER, workspaceId: WORKSPACE, capability: 'read' },
  { userId: USER, workspaceId: WORKSPACE, capability: 'manage' },
 ]);

 await assert.rejects(
  service.listOperations({ workspaceId: WORKSPACE, actor: agentActor(), includeDeleted: true }),
  error => error.status === 403 && /manager/i.test(error.message),
 );
});

test('requesting agents can poll their own operation with artifacts, but cannot enumerate unrelated work', async () => {
 const requester = stewardRow({
  id: REQUESTER_AGENT,
  controller_id: null,
  purpose: 'collaborator',
  resource_facets: [],
 });
 const db = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_agents')) return [requester];
  if (normalized.includes('from resource_operations operation')) return [operationRow()];
  return [];
 });
 const { service } = build(db);
 const row = await service.getOperation({
  workspaceId: WORKSPACE,
  operationId: 'operation-1',
  actor: agentActor(),
 });
 assert.deepEqual(row.input_artifact, { patch: 'safe diff' });
 assert.deepEqual(row.output_artifact, {});
 assert.equal('idempotency_key' in row, false);
 const query = db.queries.find(entry => entry.normalized.includes('from resource_operations operation'));
 assert.match(query.normalized, /operation\.requested_by_agent_id = \$3/);
 assert.match(query.normalized, /operation\.steward_agent_id = \$3/);
 assert.doesNotMatch(query.normalized, /requester_key|idempotency_key|lease_version/);

 const summary = await service.getOperation({
  workspaceId: WORKSPACE,
  operationId: 'operation-1',
  actor: agentActor(),
  includeArtifacts: 'false',
 });
 assert.equal('input_artifact' in summary, false, 'HTTP-style false must not expose artifacts');
 await assert.rejects(
  service.getOperation({
   workspaceId: WORKSPACE,
   operationId: 'operation-1',
   actor: agentActor(),
   includeArtifacts: 'sometimes',
  }),
  error => error.status === 400 && /true or false/i.test(error.message),
 );

 const deniedDb = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_agents')) return [requester];
  return [];
 });
 await assert.rejects(
  build(deniedDb).service.getOperation({
   workspaceId: WORKSPACE,
   operationId: 'operation-someone-elses',
   actor: agentActor(),
  }),
  error => error.status === 404,
 );
});

test('controllers can poll requests they made or operations on resources they currently own', async () => {
 const db = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_controllers')) return [controllerRow()];
  if (normalized.includes('from resource_operations operation')) return [operationRow({
   requested_by_agent_id: null,
   requested_by_controller_id: CONTROLLER,
  })];
  return [];
 });
 const { service } = build(db);
 const rows = await service.listOperations({ workspaceId: WORKSPACE, actor: controllerActor() });
 assert.equal(rows.length, 1);
 const query = db.queries.find(entry => entry.normalized.includes('from resource_operations operation'));
 assert.match(query.normalized, /operation\.requested_by_controller_id = \$2/);
 assert.match(query.normalized, /resource\.controller_id = \$2/);

 await assert.rejects(
  service.listOperations({
   workspaceId: WORKSPACE,
   actor: controllerActor({ workspaceId: OTHER_WORKSPACE }),
  }),
  error => error.status === 403 && /workspace/i.test(error.message),
 );
});

test('update validates current controller ownership and the replacement steward inside one transaction', async () => {
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_controllers')) return [controllerRow()];
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.includes('from resource_operations') && normalized.includes("status in ('pending', 'claimed')")) return [];
  if (normalized.startsWith('update workspace_resources')) {
   return [resourceRow({ name: params[2], description: params[3] })];
  }
  return [];
 });
 const { service, audits } = build(db);
 const updated = await service.updateResource({
  workspaceId: WORKSPACE,
  resourceId: 'resource-1',
  changes: { name: 'Repository steward v2', description: 'Updated.' },
  actor: controllerActor(),
 });
 assert.equal(updated.name, 'Repository steward v2');
 assert.equal(audits[0].action, 'resource.updated');
 assert.equal(db.beginCount, 1);
 const update = db.queries.find(query => query.normalized.startsWith('update workspace_resources'));
 assert.doesNotMatch(update.normalized, /version\s*=\s*version\s*\+/,
  'metadata edits do not advance artifact version');
 assert.doesNotMatch(update.normalized, /returning \*/);
});

test('update refuses controller escape, cancels queued work at a policy boundary, and blocks a live lease', async () => {
 const wrongDb = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_controllers')) return [controllerRow()];
  if (normalized.includes('from workspace_resources')) return [resourceRow({ controller_id: 'controller-2' })];
  return [];
 });
 await assert.rejects(
  build(wrongDb).service.updateResource({
   workspaceId: WORKSPACE, resourceId: 'resource-1', changes: { name: 'Escape' }, actor: controllerActor(),
  }),
  error => error.status === 403 && /does not own/i.test(error.message),
 );

 const pendingDb = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_resources')) return [resourceRow()];
  if (normalized.includes('from workspace_agents')) return [stewardRow({ resource_facets: ['tooling', 'code', 'knowledge'] })];
  if (normalized.startsWith('select id, status') && normalized.includes('from resource_operations')) {
   return [{ id: 'operation-pending', status: 'pending', lease_is_live: false }];
  }
  if (normalized.startsWith('update resource_operations')) {
   return [operationRow({ id: 'operation-pending', status: 'cancelled', error: params[3] || '' })];
  }
  if (normalized.startsWith('update workspace_resources')) {
   return [resourceRow({ facet: params[4], descriptor: params[5], visibility: params[6] })];
  }
  return [];
 });
 const pending = build(pendingDb);
 const changed = await pending.service.updateResource({
  workspaceId: WORKSPACE,
  resourceId: 'resource-1',
  changes: { facet: 'knowledge', descriptor: { repository: 'agensis-v2' }, visibility: 'restricted' },
  actor: userActor(),
 });
 assert.equal(changed.facet, 'knowledge');
 assert.equal(pending.audits.some(entry => entry.action === 'resource.operation_settled'), true);

 const liveDb = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_resources')) return [resourceRow()];
  if (normalized.includes('from workspace_agents')) return [stewardRow({ resource_facets: ['tooling', 'code', 'knowledge'] })];
  if (normalized.startsWith('select id from resource_operations') && normalized.includes("status = 'claimed'")) {
   return [{ id: 'operation-live' }];
  }
  return [];
 });
 await assert.rejects(
  build(liveDb).service.updateResource({
   workspaceId: WORKSPACE, resourceId: 'resource-1', changes: { descriptor: { repository: 'new' } }, actor: userActor(),
  }),
  error => error.status === 409 && /live claimed operation/i.test(error.message),
 );
});

test('a disabled steward cannot wedge archival; queued and expired work is cancelled transactionally', async () => {
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.includes('from workspace_agents')) return [stewardRow({ enabled: false })];
  if (normalized.startsWith('select id, status') && normalized.includes('from resource_operations')) {
   return [
    { id: 'pending-1', status: 'pending', lease_is_live: false },
    { id: 'expired-1', status: 'claimed', lease_is_live: false },
   ];
  }
  if (normalized.startsWith('update resource_operations')) {
   return [
    operationRow({ id: 'pending-1', status: 'cancelled' }),
    operationRow({ id: 'expired-1', status: 'cancelled' }),
   ];
  }
  if (normalized.startsWith('update workspace_resources')) return [resourceRow({ status: params[7] })];
  return [];
 });
 const { service, audits } = build(db);
 const archived = await service.updateResource({
  workspaceId: WORKSPACE,
  resourceId: 'resource-1',
  changes: { status: 'archived' },
  actor: userActor(),
 });
 assert.equal(archived.status, 'archived');
 const cancellation = db.queries.find(query => query.normalized.startsWith('update resource_operations'));
 assert.match(cancellation.normalized, /lease_expires_at is null or lease_expires_at <= now\(\)/);
 assert.equal(audits.filter(entry => entry.action === 'resource.operation_settled').length, 2);
});

test('structural recovery cancels an arbitrary backlog instead of wedging above a row cap', async () => {
 const backlog = Array.from({ length: 101 }, (_, index) => operationRow({
  id: `pending-${index + 1}`,
  status: 'cancelled',
 }));
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.includes('from workspace_agents')) return [stewardRow({ enabled: false })];
  if (normalized.startsWith('select id from resource_operations')) return [];
  if (normalized.startsWith('update resource_operations')) return backlog;
  if (normalized.startsWith('update workspace_resources')) return [resourceRow({ status: params[7] })];
  return [];
 });
 const { service, audits } = build(db);
 const archived = await service.updateResource({
  workspaceId: WORKSPACE,
  resourceId: 'resource-1',
  changes: { status: 'archived' },
  actor: userActor(),
 });
 assert.equal(archived.status, 'archived');
 const cancellation = db.queries.find(query => query.normalized.startsWith('update resource_operations'));
 assert.doesNotMatch(cancellation.normalized, /limit \d+/);
 assert.equal(audits.filter(entry => entry.action === 'resource.operation_settled').length, 101);
});

test('archive and reassignment together still require a valid resource steward', async () => {
 const db = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.includes('from workspace_agents')) {
   return [stewardRow({
    id: 'replacement-collaborator',
    controller_id: null,
    purpose: 'collaborator',
    resource_facets: [],
   })];
  }
  return [];
 });
 const { service } = build(db);
 await assert.rejects(
  service.updateResource({
   workspaceId: WORKSPACE,
   resourceId: 'resource-1',
   changes: { status: 'archived', stewardAgentId: 'replacement-collaborator' },
   actor: userActor(),
  }),
  error => error.status === 400 && /resource-purpose agent/i.test(error.message),
 );
 assert.equal(db.queries.some(query => query.normalized.startsWith('update workspace_resources')), false);
});

test('requestOperation derives exactly one requester from the authenticated identity', async () => {
 const cases = [
  {
   actor: userActor(),
   expected: [USER, null, null, null, `user:${USER}`],
   validate(normalized) { return normalized.includes('from workspace_resources'); },
  },
  {
   actor: agentActor(),
   expected: [null, REQUESTER_AGENT, null, null, `agent:${REQUESTER_AGENT}`],
   validate(normalized) { return normalized.includes('from workspace_agents'); },
  },
  {
   actor: controllerActor(),
   expected: [null, null, CONTROLLER, null, `controller:${CONTROLLER}`],
   validate(normalized) { return normalized.includes('from workspace_controllers'); },
  },
 ];

 for (const current of cases) {
  const db = makeDb(async ({ normalized, params }) => {
   if (normalized.includes('from workspace_controllers')) return [controllerRow()];
   if (normalized.includes('from workspace_agents') && normalized.includes('for share')) {
    if (params[0] === REQUESTER_AGENT) return [stewardRow({ id: REQUESTER_AGENT, controller_id: null, purpose: 'collaborator', resource_facets: [] })];
    return [stewardRow()];
   }
   if (normalized.includes('from workspace_resources') && normalized.includes('for share')) return [resourceRow()];
   if (normalized.startsWith('insert into resource_operations')) {
   assert.deepEqual(params.slice(3, 8), current.expected);
     const requester = current.expected;
     return [operationRow({
      requested_by_user_id: requester[0],
      requested_by_agent_id: requester[1],
      requested_by_controller_id: requester[2],
      requested_by_workspace_id: requester[3],
      requester_key: requester[4],
    })];
   }
   if (normalized.startsWith('update resource_operations') && normalized.includes('audit_reference')) return [];
   return [];
  });
  const { service, audits } = build(db);
  const operation = await service.requestOperation({
   workspaceId: WORKSPACE,
   resourceId: 'resource-1',
   requester: current.actor,
   request: { operation: 'apply', inputArtifact: { patch: 'safe diff' }, idempotencyKey: 'apply:commit-1' },
  });
  assert.equal(operation.id, 'operation-1');
  assert.equal('idempotency_key' in operation, false);
  assert.equal('requester_key' in operation, false);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'resource.operation_requested');
  const insert = db.queries.find(query => query.normalized.startsWith('insert into resource_operations'));
  assert.doesNotMatch(insert.normalized, /returning \*/);
 }
});

test('requestOperation rejects ambiguous requester identity and cross-workspace agents before insertion', async () => {
 const db = makeDb(async ({ normalized }) => (
  normalized.includes('from workspace_agents') ? [] : []
 ));
 const { service } = build(db);
 await assert.rejects(
  service.requestOperation({
   workspaceId: WORKSPACE,
   resourceId: 'resource-1',
   requester: agentActor({ userId: USER }),
   request: { operation: 'read', idempotencyKey: 'read-1' },
  }),
  error => error.status === 400 && /exactly one authenticated requester/i.test(error.message),
 );
 await assert.rejects(
  service.requestOperation({
   workspaceId: WORKSPACE,
   resourceId: 'resource-1',
   requester: agentActor({ workspaceId: OTHER_WORKSPACE }),
   request: { operation: 'read', idempotencyKey: 'read-2' },
  }),
  error => error.status === 403 && /workspace/i.test(error.message),
 );
 assert.equal(db.queries.some(query => query.normalized.startsWith('insert into resource_operations')), false);
});

test('idempotent operation replay returns the original row, while a payload mismatch is a conflict', async () => {
 async function exercise(existing) {
  const db = makeDb(async ({ normalized, params }) => {
   if (normalized.includes('from workspace_agents') && normalized.includes('for share')) {
    if (params[0] === REQUESTER_AGENT) return [stewardRow({ id: REQUESTER_AGENT, controller_id: null, purpose: 'collaborator', resource_facets: [] })];
    return [stewardRow()];
   }
   if (normalized.includes('from workspace_resources')) return [resourceRow()];
   if (normalized.startsWith('insert into resource_operations')) return [];
   if (normalized.includes('from resource_operations') && normalized.includes('idempotency_key')) return [existing];
   return [];
  });
  const built = build(db);
  const promise = built.service.requestOperation({
   workspaceId: WORKSPACE,
   resourceId: 'resource-1',
   requester: agentActor(),
   request: { operation: 'apply', inputArtifact: { patch: 'safe diff' }, idempotencyKey: 'apply:commit-1' },
  });
  return { ...built, db, promise };
 }

 const replay = await exercise(operationRow());
 assert.equal((await replay.promise).id, 'operation-1');
 assert.equal(replay.audits.length, 0, 'a replay is not a second request transition');
 assert.equal(
  replay.db.queries.some(query => query.normalized.includes('from workspace_resources')),
  false,
  'a replay is recovered before mutable resource state is consulted',
 );

 const mismatch = await exercise(operationRow({ input_artifact: { patch: 'different diff' } }));
 await assert.rejects(
  mismatch.promise,
  error => error.status === 409 && /idempotency key/i.test(error.message),
 );
 assert.equal(mismatch.audits.length, 0);
});

test('claim uses SKIP LOCKED, reclaims only expired leases, and returns the new fence', async () => {
 const claimed = operationRow({
  status: 'claimed',
  claimed_by_agent_id: STEWARD,
  attempt: 2,
  lease_version: '2',
  lease_expires_at: '2099-01-01T00:00:00.000Z',
 });
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents')) {
   return params[0] === REQUESTER_AGENT
    ? [stewardRow({ id: REQUESTER_AGENT, controller_id: null, purpose: 'collaborator', resource_facets: [] })]
    : [stewardRow()];
  }
  if (normalized.includes('from workspace_resources')) return [resourceRow()];
  if (normalized.includes("set status = 'rejected'")) return [];
  if (normalized.startsWith('select candidate.id from resource_operations')) return [{ id: 'operation-1' }];
  if (normalized.includes("set status = 'claimed'")) return [claimed];
  return [];
 });
 const { service } = build(db);
 const result = await service.claimOperation({ workspaceId: WORKSPACE, actor: stewardActor() });
 assert.equal(result.lease_version, '2');
 assert.equal(result.attempt, 2);
 assert.equal(result.id, 'operation-1');
 const selection = db.queries.find(query => query.normalized.startsWith('select candidate.id from resource_operations'));
 const claim = db.queries.find(query => query.normalized.includes("set status = 'claimed'"));
 assert.match(selection.normalized, /for update of resource skip locked/);
 assert.match(selection.normalized, /status = 'pending'/);
 assert.match(selection.normalized, /status = 'claimed'.*lease_expires_at <= now\(\)/);
 assert.match(selection.normalized, /resource\.controller_id is not distinct from steward\.controller_id/);
 assert.match(selection.normalized, /candidate\.resource_version = resource\.version/);
 assert.match(selection.normalized, /not exists \( select 1 from resource_operations live_mutation/);
 assert.match(claim.normalized, /lease_version = resource_operations\.lease_version \+ 1/);
 assert.match(claim.normalized, /lease_expires_at = now\(\) \+ \(\$\d+ \|\| ' milliseconds'\)::interval/);
 assert.match(claim.normalized, /where id = \$1 and workspace_id = \$2 and steward_agent_id = \$3/);
 assert.match(claim.normalized, /status = 'pending'/);
 assert.match(claim.normalized, /status = 'claimed'.*lease_expires_at <= now\(\)/);
 assert.equal(claim.params[0], 'operation-1');
 assert.equal(claim.params.includes(String(RESOURCE_OPERATION_LEASE_MS)), true);
 assert.doesNotMatch(claim.normalized, /returning \*/);
 assert.ok(
  db.queries.indexOf(selection) < db.queries.indexOf(claim),
  'claim follows the shared resource -> operation lock order',
 );
 assert.equal(db.beginCount, 2, 'queue cleanup commits before the resource-locking claim transaction');
});

test('claim refuses a collaborator identity and does not inspect the queue', async () => {
 const db = makeDb(async ({ normalized }) => (
  normalized.includes('from workspace_agents') ? [stewardRow({ purpose: 'collaborator', resource_facets: [] })] : []
 ));
 const { service } = build(db);
 await assert.rejects(
  service.claimOperation({ workspaceId: WORKSPACE, actor: stewardActor() }),
  error => error.status === 400 && /resource-purpose agent/i.test(error.message),
 );
 assert.equal(db.queries.some(query => query.normalized.startsWith('update resource_operations')), false);
});

test('claim re-checks requester authority and cancels work after user/controller revocation', async () => {
 const cases = [
  operationRow({
   status: 'claimed',
   claimed_by_agent_id: STEWARD,
   requested_by_user_id: USER,
   requested_by_agent_id: null,
   lease_version: '1',
  }),
  operationRow({
   status: 'claimed',
   claimed_by_agent_id: STEWARD,
   requested_by_agent_id: null,
   requested_by_controller_id: CONTROLLER,
   lease_version: '1',
  }),
 ];
 for (const candidate of cases) {
  const db = makeDb(async ({ normalized, params }) => {
   if (normalized.includes('from workspace_agents')) return [stewardRow()];
   if (normalized.includes("set status = 'rejected'")) return [];
   if (normalized.startsWith('select candidate.id from resource_operations')) return [{ id: candidate.id }];
   if (normalized.includes("set status = 'claimed'")) return [candidate];
   if (normalized.includes('from workspace_resources')) return [resourceRow()];
   if (normalized.includes('from workspace_controllers')) return [];
   if (normalized.includes("set status = 'cancelled'")) {
    return [operationRow({ ...candidate, status: 'cancelled', error: params[3] })];
   }
   return [];
  });
  const { service, audits } = build(db, {
   assertWorkspaceRoleLocked: async () => {
    throw Object.assign(new Error('role revoked'), { status: 403 });
   },
  });
  assert.equal(await service.claimOperation({ workspaceId: WORKSPACE, actor: stewardActor() }), null);
  const cancellation = db.queries.find(query => query.normalized.includes("set status = 'cancelled'"));
  assert.ok(cancellation, 'revoked requester work must be terminalized before execution');
  assert.equal(audits.some(entry => entry.action === 'resource.operation_settled'), true);
 }
});

test('claim derives the steward from authenticated agent identity and rejects non-agent actors', async () => {
 const db = makeDb();
 const { service } = build(db);
 await assert.rejects(
  service.claimOperation({ workspaceId: WORKSPACE, actor: userActor() }),
  error => error.status === 403 && /authenticated steward agent/i.test(error.message),
 );
 assert.equal(db.queries.length, 0);
});

test('claim terminalizes stale same-base mutations and continues to later queue work', async () => {
 const stale = operationRow({ id: 'apply-stale', status: 'rejected', error: 'Resource version changed before execution' });
 const next = operationRow({
  id: 'read-next',
  operation: 'read',
 status: 'claimed',
  claimed_by_agent_id: STEWARD,
  lease_version: '1',
  attempt: 1,
 });
 let staleCandidateAvailable = true;
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents')) {
   return params[0] === REQUESTER_AGENT
    ? [stewardRow({ id: REQUESTER_AGENT, controller_id: null, purpose: 'collaborator', resource_facets: [] })]
    : [stewardRow()];
  }
  if (normalized.startsWith('select candidate.id as stale_operation_id')) {
   if (!staleCandidateAvailable) return [];
   staleCandidateAvailable = false;
   return [{ stale_operation_id: stale.id }];
  }
  if (normalized.includes("set status = 'rejected'")) return [stale];
  if (normalized.startsWith('select candidate.id from resource_operations')) return [{ id: next.id }];
  if (normalized.includes("set status = 'claimed'")) return [next];
  if (normalized.includes('from workspace_resources')) return [resourceRow({ version: 4 })];
  return [];
 });
 const { service, audits } = build(db);
 const claimed = await service.claimOperation({ workspaceId: WORKSPACE, actor: stewardActor() });
 assert.equal(claimed.id, 'read-next', 'a stale apply cannot starve later work');
 assert.equal(audits.some(entry => entry.target.id === 'apply-stale' && entry.after === 'rejected'), true);
 const staleSelection = db.queries.find(query => query.normalized.startsWith('select candidate.id as stale_operation_id'));
 const sweep = db.queries.find(query => query.normalized.includes("set status = 'rejected'"));
 assert.match(staleSelection.normalized, /candidate\.resource_version <> resource\.version/);
 assert.match(staleSelection.normalized, /for update of resource skip locked/);
 assert.match(sweep.normalized, /and operation in \('apply', 'publish'\).*and \( status = 'pending'/);
 assert.match(sweep.normalized, /and exists \( select 1 from workspace_resources resource/);
});

test('claim dead-letters an exhausted lease before advancing to later queue work', async () => {
 const exhausted = operationRow({
  id: 'apply-exhausted',
  status: 'failed',
  attempt: 3,
  error: 'Resource operation exceeded its claim attempt limit',
 });
 const next = operationRow({
  id: 'read-next',
  operation: 'read',
  status: 'claimed',
  claimed_by_agent_id: STEWARD,
  lease_version: '1',
  attempt: 1,
 });
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents')) {
   return params[0] === REQUESTER_AGENT
    ? [stewardRow({ id: REQUESTER_AGENT, controller_id: null, purpose: 'collaborator', resource_facets: [] })]
    : [stewardRow()];
  }
  if (normalized.includes("set status = 'rejected'")) return [];
  if (normalized.includes("set status = 'failed'")) return [exhausted];
  if (normalized.startsWith('select candidate.id from resource_operations')) return [{ id: next.id }];
  if (normalized.includes("set status = 'claimed'")) return [next];
  if (normalized.includes('from workspace_resources')) return [resourceRow()];
  return [];
 });
 const { service, audits } = build(db);
 const claimed = await service.claimOperation({ workspaceId: WORKSPACE, actor: stewardActor() });
 await Promise.resolve();
 assert.equal(claimed.id, 'read-next');
 assert.equal(audits.some(entry => entry.target.id === 'apply-exhausted' && entry.after === 'failed'), true);
 const deadLetter = db.queries.find(query => query.normalized.includes("set status = 'failed'"));
 const selection = db.queries.find(query => query.normalized.startsWith('select candidate.id from resource_operations'));
 const claim = db.queries.find(query => query.normalized.includes("set status = 'claimed'"));
 assert.match(deadLetter.normalized, /candidate\.attempt >= \$4/);
 assert.match(deadLetter.normalized, /for update of candidate skip locked/);
 assert.match(deadLetter.normalized, /and attempt >= \$4.*and \( status = 'pending'/);
 assert.match(selection.normalized, /candidate\.attempt < \$3/);
 assert.match(claim.normalized, /attempt < \$5/);
});

test('automatic guard audits never consume the lease window before claim returns', async () => {
 const stale = operationRow({ id: 'apply-stale', status: 'rejected' });
 const next = operationRow({
  id: 'read-next',
  operation: 'read',
  status: 'claimed',
  claimed_by_agent_id: STEWARD,
  lease_version: '1',
  attempt: 1,
 });
 let staleCandidateAvailable = true;
 let releaseAudit;
 let auditStarted = 0;
 const auditGate = new Promise(resolve => { releaseAudit = resolve; });
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents')) {
   return params[0] === REQUESTER_AGENT
    ? [stewardRow({ id: REQUESTER_AGENT, controller_id: null, purpose: 'collaborator', resource_facets: [] })]
    : [stewardRow()];
  }
  if (normalized.startsWith('select candidate.id as stale_operation_id')) {
   if (!staleCandidateAvailable) return [];
   staleCandidateAvailable = false;
   return [{ stale_operation_id: stale.id }];
  }
  if (normalized.includes("set status = 'rejected'")) return [stale];
  if (normalized.includes("set status = 'failed'")) return [];
  if (normalized.startsWith('select candidate.id from resource_operations')) return [{ id: next.id }];
  if (normalized.includes("set status = 'claimed'")) return [next];
  if (normalized.includes('from workspace_resources')) return [resourceRow({ version: 4 })];
  return [];
 });
 const { service } = build(db, {
  operationLeaseMs: 1_000,
  recordAudit: async () => {
   auditStarted += 1;
   await auditGate;
  },
 });
 const claimPromise = service.claimOperation({ workspaceId: WORKSPACE, actor: stewardActor() });
 let timeoutId;
 const outcome = await Promise.race([
  claimPromise,
  new Promise(resolve => {
   timeoutId = setTimeout(() => resolve('audit-blocked-claim'), 100);
  }),
 ]);
 clearTimeout(timeoutId);
 releaseAudit();
 await claimPromise;
 assert.notEqual(outcome, 'audit-blocked-claim');
 assert.equal(outcome.id, 'read-next');
 assert.equal(auditStarted, 1);
});

test('renew extends only a live claim and preserves the lease fence', async () => {
 const claimed = operationRow({
  status: 'claimed',
  claimed_by_agent_id: STEWARD,
  attempt: 1,
  lease_version: '12',
  lease_expires_at: '2099-01-01T00:00:00.000Z',
  lease_is_live: true,
 });
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.startsWith('select resource_id from resource_operations')) return [{ resource_id: 'resource-1' }];
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.includes('from resource_operations') && normalized.includes('for update')) return [claimed];
  if (normalized.startsWith('update resource_operations')) {
   assert.equal(params[0], 'operation-1');
   assert.equal(params[1], WORKSPACE);
   assert.equal(params[2], STEWARD);
   assert.equal(params[4], '12');
   return [operationRow({
    ...claimed,
    lease_expires_at: '2099-01-01T00:03:00.000Z',
   })];
  }
  return [];
 });
 const { service } = build(db, { operationLeaseMs: 180_000 });
 const renewed = await service.renewOperation({
  workspaceId: WORKSPACE,
  operationId: 'operation-1',
  actor: stewardActor(),
  leaseVersion: '12',
 });
 assert.equal(renewed.lease_version, '12');
 assert.equal(renewed.lease_expires_at, '2099-01-01T00:03:00.000Z');
 const update = db.queries.find(query => query.normalized.startsWith('update resource_operations'));
 assert.match(update.normalized, /lease_expires_at = now\(\) \+ \(\$4 \|\| ' milliseconds'\)::interval/);
 assert.match(update.normalized, /lease_version = \$5::bigint/);
 assert.match(update.normalized, /lease_expires_at > now\(\)/);
});

test('renew rejects a stale or expired fence before mutation', async () => {
 for (const [row, fence, message] of [
  [operationRow({ status: 'claimed', claimed_by_agent_id: STEWARD, lease_version: '12', lease_is_live: true }), '11', /lease fence/i],
  [operationRow({ status: 'claimed', claimed_by_agent_id: STEWARD, lease_version: '12', lease_is_live: false }), '12', /lease expired/i],
 ]) {
  const db = makeDb(async ({ normalized }) => {
   if (normalized.includes('from workspace_agents')) return [stewardRow()];
   if (normalized.startsWith('select resource_id from resource_operations')) return [{ resource_id: 'resource-1' }];
   if (normalized.includes('from workspace_resources')) return [resourceRow()];
   if (normalized.includes('from resource_operations')) return [row];
   return [];
  });
  const { service } = build(db);
  await assert.rejects(
   service.renewOperation({
    workspaceId: WORKSPACE,
    operationId: 'operation-1',
    actor: stewardActor(),
    leaseVersion: fence,
   }),
   error => error.status === 409 && message.test(error.message),
  );
  assert.equal(db.queries.some(query => query.normalized.startsWith('update resource_operations')), false);
 }
});

test('progress reporting requires the live lease, persists a checkpoint, and emits it without exposing lease state', async () => {
 const claimed = operationRow({
  status: 'claimed',
  claimed_by_agent_id: STEWARD,
  attempt: 1,
  lease_version: '12',
  lease_expires_at: '2099-01-01T00:00:00.000Z',
  lease_is_live: true,
  input_artifact: {
   request: 'Patch and test the handler.',
   steps: [{ id: 'patch', instruction: 'Patch the handler.', dependsOn: [] }],
  },
 });
 const progressEvents = [];
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.startsWith('select resource_id from resource_operations')) return [{ resource_id: 'resource-1' }];
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.includes('from resource_operations') && normalized.includes('for update')) return [claimed];
  if (normalized.startsWith('update resource_operations')) {
   return [operationRow({
    ...claimed,
    progress: params[3],
    progress_seq: 4,
    progress_updated_at: '2099-01-01T00:00:00.000Z',
    lease_expires_at: '2099-01-01T00:05:00.000Z',
   })];
  }
  return [];
 });
 const { service } = build(db, {
  notifyResourceOperationProgress: async event => progressEvents.push(event),
 });
 const result = await service.reportOperationProgress({
  workspaceId: WORKSPACE,
  operationId: 'operation-1',
  actor: stewardActor(),
  leaseVersion: '12',
  progress: {
   phase: 'executing',
   message: 'Patching the handler.',
   stepId: 'patch',
   stepStatus: 'running',
   percent: 35,
  },
 });
 assert.equal(result.progress.phase, 'executing');
 assert.equal(result.progress_seq, 4);
 assert.equal(result.lease_version, '12', 'the steward receives the unchanged lease fence for the next checkpoint');
 assert.equal(progressEvents.length, 1);
 assert.equal(progressEvents[0].operationId, 'operation-1');
 assert.equal(progressEvents[0].progress.message, 'Patching the handler.');
 const update = db.queries.find(query => query.normalized.startsWith('update resource_operations'));
 assert.match(update.normalized, /progress_seq = resource_operations\.progress_seq \+ 1/);
 assert.match(update.normalized, /lease_version = \$6::bigint/);
});

test('successful apply settlement advances the resource version once behind the lease fence', async () => {
 const claimed = operationRow({
  status: 'claimed', claimed_by_agent_id: STEWARD, attempt: 1, lease_version: '7',
  lease_expires_at: '2099-01-01T00:00:00.000Z', lease_is_live: true,
 });
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.startsWith('select resource_id from resource_operations')) return [{ resource_id: 'resource-1' }];
  if (normalized.includes('from resource_operations') && normalized.includes('for update')) return [claimed];
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) return [resourceRow()];
  if (normalized.startsWith('update workspace_resources')) {
   assert.equal(params[2], 3, 'the write is fenced by the requested resource version');
   return [resourceRow({ version: 4 })];
  }
  if (normalized.startsWith('update resource_operations')) {
   return [operationRow({
    ...claimed,
    status: params[3],
    output_artifact: params[4],
    error: params[5],
    resource_version: params[6],
    completed_at: '2026-07-31T10:02:00.000Z',
   })];
  }
  return [];
 });
 const progressEvents = [];
 const { service, audits } = build(db, {
  notifyResourceOperationProgress: async event => progressEvents.push(event),
 });
 const settled = await service.settleOperation({
 workspaceId: WORKSPACE,
 operationId: 'operation-1',
  actor: stewardActor(),
  leaseVersion: '7',
  result: { status: 'completed', outputArtifact: { commit: 'abc123' } },
 });
 assert.equal(settled.status, 'completed');
 assert.equal(settled.resource_version, 4);
 assert.equal(db.queries.filter(query => query.normalized.startsWith('update workspace_resources')).length, 1);
 const resourceUpdate = db.queries.find(query => query.normalized.startsWith('update workspace_resources'));
 assert.match(resourceUpdate.normalized, /version = version \+ 1/);
 assert.match(resourceUpdate.normalized, /and version = \$3/);
 assert.match(resourceUpdate.normalized, /and status = 'active'/);
 const operationUpdate = db.queries.find(query => query.normalized.startsWith('update resource_operations'));
 assert.match(operationUpdate.normalized, /and lease_version = \$3::bigint/);
 assert.match(operationUpdate.normalized, /and claimed_by_agent_id = \$2/);
 assert.match(operationUpdate.normalized, /and status = 'claimed'/);
 assert.equal(audits.length, 1);
 assert.equal(audits[0].action, 'resource.operation_settled');
 assert.equal(audits[0].actor.agentId, STEWARD);
 assert.equal(progressEvents.length, 1);
 assert.equal(progressEvents[0].status, 'completed');
 const resourceLockIndex = db.queries.findIndex(query => (
  query.normalized.includes('from workspace_resources') && query.normalized.includes('for update')
 ));
 const operationLockIndex = db.queries.findIndex(query => (
  query.normalized.includes('from resource_operations') && query.normalized.includes('for update')
 ));
 assert.ok(resourceLockIndex < operationLockIndex, 'settlement and structural updates share resource -> operation lock order');
});

test('a stale successful apply settles terminally and an identical retry replays that server decision', async () => {
 const claimed = operationRow({
  status: 'claimed',
  claimed_by_agent_id: STEWARD,
  operation: 'apply',
  resource_version: 3,
  lease_version: '9',
  lease_is_live: true,
 });
 let stored = claimed;
 const db = makeDb(async ({ normalized, params }) => {
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.startsWith('select resource_id from resource_operations')) return [{ resource_id: 'resource-1' }];
  if (normalized.includes('from workspace_resources') && normalized.includes('for update')) {
   return [resourceRow({ version: 4 })];
  }
  if (normalized.includes('from resource_operations') && normalized.includes('for update')) return [stored];
  if (normalized.startsWith('update workspace_resources')) return [];
  if (normalized.startsWith('update resource_operations')) {
   stored = operationRow({
    ...claimed,
    status: params[3],
    output_artifact: params[4],
    error: params[5],
    resource_version: params[6],
    lease_version: '9',
    completed_at: '2026-07-31T10:02:00.000Z',
   });
   return [stored];
  }
  return [];
 });
 const { service, audits } = build(db);
 const input = {
  workspaceId: WORKSPACE,
  operationId: 'operation-1',
  actor: stewardActor(),
  leaseVersion: '9',
  result: { status: 'completed', outputArtifact: { commit: 'late-result' } },
 };
 const first = await service.settleOperation(input);
 assert.equal(first.status, 'failed');
 assert.match(first.error, /resource version changed/i);
 const replay = await service.settleOperation(input);
 assert.equal(replay.status, 'failed');
 assert.equal(db.queries.filter(query => query.normalized.startsWith('update resource_operations')).length, 1);
 assert.equal(audits.filter(entry => entry.action === 'resource.operation_settled').length, 1);
});

test('settlement derives steward identity and validates the bigint fence before database work', async () => {
 const db = makeDb();
 const { service } = build(db);
 await assert.rejects(
  service.settleOperation({
   workspaceId: WORKSPACE,
   operationId: 'operation-1',
   actor: userActor(),
   leaseVersion: '1',
   result: { status: 'completed' },
  }),
  error => error.status === 403 && /authenticated steward agent/i.test(error.message),
 );
 await assert.rejects(
  service.settleOperation({
   workspaceId: WORKSPACE,
   operationId: 'operation-1',
   actor: stewardActor(),
   leaseVersion: '9223372036854775808',
   result: { status: 'completed' },
  }),
  error => error.status === 400 && /integer range/i.test(error.message),
 );
 assert.equal(db.queries.length, 0);
});

test('completed read/propose and rejected/failed operations never advance resource.version', async () => {
 for (const [operation, status, error] of [
  ['read', 'completed', ''],
  ['propose', 'completed', ''],
  ['apply', 'rejected', 'not approved'],
  ['publish', 'failed', 'remote unavailable'],
 ]) {
  const claimed = operationRow({
   operation, status: 'claimed', claimed_by_agent_id: STEWARD, lease_version: '1', lease_is_live: true,
  });
  const db = makeDb(async ({ normalized, params }) => {
   if (normalized.includes('from workspace_agents')) return [stewardRow()];
   if (normalized.startsWith('select resource_id from resource_operations')) return [{ resource_id: 'resource-1' }];
   if (normalized.includes('from resource_operations')) return [claimed];
   if (normalized.includes('from workspace_resources')) return [resourceRow()];
   if (normalized.startsWith('update resource_operations')) {
    return [operationRow({ ...claimed, status: params[3], output_artifact: params[4], error: params[5] })];
   }
   return [];
  });
  const { service } = build(db);
  await service.settleOperation({
   workspaceId: WORKSPACE,
   operationId: 'operation-1',
   actor: stewardActor(),
   leaseVersion: '1',
   result: { status, outputArtifact: { ok: status === 'completed' }, error },
  });
  assert.equal(
   db.queries.some(query => query.normalized.startsWith('update workspace_resources')),
   false,
   `${operation}/${status} must not advance the artifact version`,
  );
 }
});

test('settlement rejects wrong steward, stale fence, and expired lease before any mutation', async () => {
 const cases = [
  [operationRow({ status: 'claimed', steward_agent_id: 'agent-other', claimed_by_agent_id: 'agent-other', lease_version: '4', lease_is_live: true }), '4', 403, /steward/i],
  [operationRow({ status: 'claimed', claimed_by_agent_id: STEWARD, lease_version: '4', lease_is_live: true }), '3', 409, /lease fence/i],
  [operationRow({ status: 'claimed', claimed_by_agent_id: STEWARD, lease_version: '4', lease_is_live: false }), '4', 409, /lease expired/i],
 ];
 for (const [row, leaseVersion, status, message] of cases) {
  const db = makeDb(async ({ normalized }) => {
   if (normalized.includes('from workspace_agents')) return [stewardRow()];
   if (normalized.startsWith('select resource_id from resource_operations')) return [{ resource_id: 'resource-1' }];
   if (normalized.includes('from workspace_resources')) return [resourceRow()];
   if (normalized.includes('from resource_operations')) return [row];
   return [];
  });
  const { service, audits } = build(db);
  await assert.rejects(
   service.settleOperation({
    workspaceId: WORKSPACE,
    operationId: 'operation-1',
    actor: stewardActor(),
    leaseVersion,
    result: { status: 'completed', outputArtifact: { ok: true } },
   }),
   error => error.status === status && message.test(error.message),
  );
  assert.equal(db.queries.some(query => query.normalized.startsWith('update workspace_resources')), false);
  assert.equal(db.queries.some(query => query.normalized.startsWith('update resource_operations')), false);
  assert.equal(audits.length, 0);
 }
});

test('duplicate settlement with the same result replays without a second increment or audit', async () => {
 const completed = operationRow({
  status: 'completed',
  claimed_by_agent_id: STEWARD,
  operation: 'apply',
  output_artifact: { commit: 'abc123' },
  resource_version: 4,
  lease_version: '7',
  lease_is_live: false,
  completed_at: '2026-07-31T10:02:00.000Z',
 });
 const db = makeDb(async ({ normalized }) => {
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.startsWith('select resource_id from resource_operations')) return [{ resource_id: 'resource-1' }];
  if (normalized.includes('from workspace_resources')) return [resourceRow({ version: 4 })];
  if (normalized.includes('from resource_operations')) return [completed];
  return [];
 });
 const { service, audits } = build(db);
 const result = await service.settleOperation({
  workspaceId: WORKSPACE,
  operationId: 'operation-1',
  actor: stewardActor(),
  leaseVersion: '7',
  result: { status: 'completed', outputArtifact: { commit: 'abc123' } },
 });
 assert.equal(result.status, 'completed');
 assert.equal(result.resource_version, 4);
 assert.equal(db.queries.some(query => query.normalized.startsWith('update workspace_resources')), false);
 assert.equal(db.queries.some(query => query.normalized.startsWith('update resource_operations')), false);
 assert.equal(audits.length, 0);

 await assert.rejects(
  service.settleOperation({
   workspaceId: WORKSPACE,
   operationId: 'operation-1',
   actor: stewardActor(),
   leaseVersion: '7',
   result: { status: 'completed', outputArtifact: { commit: 'different' } },
  }),
  error => error.status === 409 && /different result/i.test(error.message),
 );
});

test('PostgreSQL serializes claim, structural update, and settlement on the resource row', {
 skip: process.env.WORKSPACE_RESOURCE_TEST_DATABASE_URL
  ? false
  : 'set WORKSPACE_RESOURCE_TEST_DATABASE_URL to run the lock integration test',
 timeout: 20_000,
}, async () => {
 const postgres = require('postgres');
 const url = process.env.WORKSPACE_RESOURCE_TEST_DATABASE_URL;
 const schema = `workspace_resource_service_${process.pid}_${Date.now()}`;
 const admin = postgres(url, { max: 1, onnotice: () => {} });
 const clients = [];
 const releases = [];

 function deferred() {
  let resolve;
  let settled = false;
  const promise = new Promise(done => { resolve = done; });
  const release = () => {
   if (settled) return;
   settled = true;
   resolve();
  };
  releases.push(release);
  return { promise, release };
 }

 async function within(promise, label, timeoutMs = 3_000) {
  let timeoutId;
  try {
   return await Promise.race([
    promise,
    new Promise((_, reject) => {
     timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
   ]);
  } finally {
   clearTimeout(timeoutId);
  }
 }

 async function client() {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  clients.push(sql);
  await sql.unsafe(`set search_path to "${schema}", public`);
  return sql;
 }

 function databaseAdapter(sql, { beforeQuery, afterQuery } = {}) {
  return {
   unsafe(query, params = []) {
    return sql.unsafe(query, params);
   },
   begin(callback) {
    return sql.begin(async tx => callback({
     async unsafe(query, params = []) {
      const normalized = compactSql(query);
      if (beforeQuery) await beforeQuery(normalized);
      const rows = await tx.unsafe(query, params);
      if (afterQuery) await afterQuery(normalized);
      return rows;
     },
    }));
   },
  };
 }

 function postgresService(sql, hooks = {}) {
  return createWorkspaceResourceService({
   getDb: () => databaseAdapter(sql, hooks),
   enforceWorkspaceRole: async () => {},
   recordAudit: async () => null,
  });
 }

 try {
  await admin.unsafe(`create schema "${schema}"`);
  await admin.unsafe(`set search_path to "${schema}", public`);
  await admin.unsafe(`
   create table workspace_agents (
    id text primary key,
    workspace_id text not null,
    controller_id text,
    name text not null,
    handle text not null,
    purpose text not null,
    resource_facets jsonb not null,
    enabled boolean not null
   )
  `);
  await admin.unsafe(`
   create table workspace_resources (
    id text primary key,
    workspace_id text not null,
    steward_agent_id text not null,
    controller_id text,
    name text not null,
    description text not null,
    facet text not null,
    descriptor jsonb not null,
    version integer not null,
    visibility text not null,
    status text not null,
    created_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
   )
  `);
  await admin.unsafe(`
   create table resource_operations (
    id text primary key,
    workspace_id text not null,
    resource_id text not null,
    steward_agent_id text not null,
    requested_by_user_id text,
    requested_by_agent_id text,
    requested_by_controller_id text,
    requester_key text not null,
    claimed_by_agent_id text,
    operation text not null,
    input_artifact jsonb not null default '{}'::jsonb,
    output_artifact jsonb not null default '{}'::jsonb,
    status text not null default 'pending',
    resource_version integer not null,
    idempotency_key text not null,
    attempt integer not null default 0,
    lease_version bigint not null default 0,
    lease_expires_at timestamptz,
    error text not null default '',
    progress jsonb not null default '{}'::jsonb,
    progress_seq bigint not null default 0,
    progress_updated_at timestamptz,
    audit_reference text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    claimed_at timestamptz,
    completed_at timestamptz
   )
  `);
  await admin.unsafe(
   `insert into workspace_agents
      (id, workspace_id, controller_id, name, handle, purpose, resource_facets, enabled)
    values
      ($1, $2, null, 'Steward', 'steward', 'resource', '["code"]'::jsonb, true),
      ($3, $2, null, 'Requester', 'requester', 'collaborator', '[]'::jsonb, true)`,
   [STEWARD, WORKSPACE, REQUESTER_AGENT],
  );
  await admin.unsafe(
   `insert into workspace_resources
      (id, workspace_id, steward_agent_id, controller_id, name, description,
       facet, descriptor, version, visibility, status, created_by)
    values ('resource-1', $1, $2, null, 'Repository', '', 'code',
            '{"repository":"v1"}'::jsonb, 1, 'workspace', 'active', $3)`,
   [WORKSPACE, STEWARD, USER],
  );
  await admin.unsafe(
   `insert into resource_operations
      (id, workspace_id, resource_id, steward_agent_id, requested_by_agent_id,
       requester_key, operation, input_artifact, resource_version, idempotency_key, created_at)
    values
      ('operation-1', $1, 'resource-1', $2, $3, $4, 'apply', '{}'::jsonb, 1, 'apply-1', now()),
      ('operation-2', $1, 'resource-1', $2, $3, $4, 'apply', '{}'::jsonb, 1, 'apply-2', now() + interval '1 millisecond')`,
   [WORKSPACE, STEWARD, REQUESTER_AGENT, `agent:${REQUESTER_AGENT}`],
  );

  const claimLockReached = deferred();
  const releaseClaim = deferred();
  let pausedClaim = false;
  const claimSql = await client();
  const competingClaimSql = await client();
  const claimService = postgresService(claimSql, {
   async afterQuery(normalized) {
    if (!pausedClaim && normalized.startsWith('select candidate.id from resource_operations')) {
     pausedClaim = true;
     claimLockReached.release();
     await releaseClaim.promise;
    }
   },
  });
  const competingClaimService = postgresService(competingClaimSql);
  const firstClaimPromise = claimService.claimOperation({ workspaceId: WORKSPACE, actor: stewardActor() });
  await within(claimLockReached.promise, 'first resource claim lock');
  const skippedClaim = await within(
   competingClaimService.claimOperation({ workspaceId: WORKSPACE, actor: stewardActor() }),
   'SKIP LOCKED competing claim',
  );
  assert.equal(skippedClaim, null, 'a second worker skips every operation on the locked resource');

  const updateReached = deferred();
  const updateSql = await client();
  let announcedUpdate = false;
  const updateService = postgresService(updateSql, {
   async beforeQuery(normalized) {
    if (
     !announcedUpdate
     && normalized.includes('from workspace_resources')
     && normalized.includes('for update')
    ) {
     announcedUpdate = true;
     updateReached.release();
    }
   },
  });
  const blockedUpdatePromise = updateService.updateResource({
   workspaceId: WORKSPACE,
   resourceId: 'resource-1',
   changes: { descriptor: { repository: 'blocked-change' } },
   actor: userActor(),
  }).then(
   value => ({ value, error: null }),
   error => ({ value: null, error }),
  );
  await within(updateReached.promise, 'structural update resource lock attempt');
  releaseClaim.release();
  const firstClaim = await within(firstClaimPromise, 'first claim completion');
  assert.equal(firstClaim.id, 'operation-1');
  const blockedUpdate = await within(blockedUpdatePromise, 'blocked structural update completion');
  assert.equal(blockedUpdate.error?.status, 409);
  assert.match(blockedUpdate.error?.message || '', /live claimed operation/i);

  const settleLockReached = deferred();
  const releaseSettlement = deferred();
  let pausedSettlement = false;
  const settleSql = await client();
  const settleService = postgresService(settleSql, {
   async afterQuery(normalized) {
    if (
     !pausedSettlement
     && normalized.includes('from workspace_resources')
     && normalized.includes('for update')
    ) {
     pausedSettlement = true;
     settleLockReached.release();
     await releaseSettlement.promise;
    }
   },
  });
  const settlePromise = settleService.settleOperation({
   workspaceId: WORKSPACE,
   operationId: firstClaim.id,
   actor: stewardActor(),
   leaseVersion: firstClaim.lease_version,
   result: { status: 'completed', outputArtifact: { commit: 'abc123' } },
  });
  await within(settleLockReached.promise, 'settlement resource lock');

  const secondUpdateReached = deferred();
  const secondUpdateSql = await client();
  let announcedSecondUpdate = false;
  const secondUpdateService = postgresService(secondUpdateSql, {
   async beforeQuery(normalized) {
    if (
     !announcedSecondUpdate
     && normalized.includes('from workspace_resources')
     && normalized.includes('for update')
    ) {
     announcedSecondUpdate = true;
     secondUpdateReached.release();
    }
   },
  });
  const secondUpdatePromise = secondUpdateService.updateResource({
   workspaceId: WORKSPACE,
   resourceId: 'resource-1',
   changes: { descriptor: { repository: 'v2' } },
   actor: userActor(),
  });
  await within(secondUpdateReached.promise, 'second structural update resource lock attempt');
  releaseSettlement.release();
  const [settled, changed] = await Promise.all([
   within(settlePromise, 'settlement completion'),
   within(secondUpdatePromise, 'second structural update completion'),
  ]);
  assert.equal(settled.status, 'completed');
  assert.deepEqual(changed.descriptor, { repository: 'v2' });

  const resources = await admin.unsafe(
   `select version, descriptor from workspace_resources where id = 'resource-1'`,
  );
  const operations = await admin.unsafe(
   `select id, status from resource_operations order by id`,
  );
  assert.equal(resources[0].version, 2, 'settlement advances the version before the structural update');
  assert.deepEqual(resources[0].descriptor, { repository: 'v2' });
  assert.deepEqual(operations.map(row => [row.id, row.status]), [
   ['operation-1', 'completed'],
   ['operation-2', 'cancelled'],
  ]);

  // Queue cleanup deliberately commits before the resource-locking claim
  // phase. Hold its resource and stale-row locks while a structural update
  // reaches that resource to prove the two transactions make progress without
  // a cycle.
  await admin.unsafe(
   `insert into resource_operations
      (id, workspace_id, resource_id, steward_agent_id, requested_by_agent_id,
       requester_key, operation, input_artifact, resource_version, idempotency_key)
    values ('operation-3', $1, 'resource-1', $2, $3, $4,
            'apply', '{}'::jsonb, 1, 'apply-3')`,
   [WORKSPACE, STEWARD, REQUESTER_AGENT, `agent:${REQUESTER_AGENT}`],
  );
  const cleanupLockReached = deferred();
  const releaseCleanup = deferred();
  let pausedCleanup = false;
  const cleanupSql = await client();
  const cleanupService = postgresService(cleanupSql, {
   async afterQuery(normalized) {
    if (!pausedCleanup && normalized.includes("set status = 'rejected'")) {
     pausedCleanup = true;
     cleanupLockReached.release();
     await releaseCleanup.promise;
    }
   },
  });
  const cleanupClaimPromise = cleanupService.claimOperation({
   workspaceId: WORKSPACE,
   actor: stewardActor(),
  });
  await within(cleanupLockReached.promise, 'stale cleanup operation lock');

  const cleanupUpdateReached = deferred();
  const cleanupUpdateSql = await client();
  let announcedCleanupUpdate = false;
  const cleanupUpdateService = postgresService(cleanupUpdateSql, {
   async beforeQuery(normalized) {
    if (
     !announcedCleanupUpdate
     && normalized.includes('from workspace_resources')
     && normalized.includes('for update')
    ) {
     announcedCleanupUpdate = true;
     cleanupUpdateReached.release();
    }
   },
  });
  const cleanupUpdatePromise = cleanupUpdateService.updateResource({
   workspaceId: WORKSPACE,
   resourceId: 'resource-1',
   changes: { descriptor: { repository: 'v3' } },
   actor: userActor(),
  });
  await within(cleanupUpdateReached.promise, 'cleanup-racing structural resource lock');
  releaseCleanup.release();
  const [cleanupClaim, cleanupUpdate] = await Promise.all([
   within(cleanupClaimPromise, 'cleanup claim completion'),
   within(cleanupUpdatePromise, 'cleanup-racing update completion'),
  ]);
  assert.equal(cleanupClaim, null);
  assert.deepEqual(cleanupUpdate.descriptor, { repository: 'v3' });
  const cleanupRows = await admin.unsafe(
   `select status from resource_operations where id = 'operation-3'`,
  );
  assert.equal(cleanupRows[0].status, 'rejected');
 } finally {
  for (const release of releases) release();
  await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
  try { await admin.unsafe(`drop schema if exists "${schema}" cascade`); } catch {}
  await admin.end({ timeout: 1 });
 }
});

test('resource operations remain a dedicated service surface with no realtime fanout dependency', () => {
 const serviceModule = require.cache[require.resolve('../server/workspace-resources.cjs')];
 const children = serviceModule.children.map(child => child.id);
 assert.equal(children.some(file => /realtime|backend-core/.test(file)), false);
 const exports = Object.keys(serviceModule.exports);
 assert.equal(exports.includes('notifyDbSubscribers'), false);
});
