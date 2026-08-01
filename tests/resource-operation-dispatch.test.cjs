// ============================================================================
// tests/resource-operation-dispatch.test.cjs
// ----------------------------------------------------------------------------
// Enqueueing a resource operation WAKES its steward (2026-08).
//
// claim_resource_operation is pull-only, so before this an accepted operation
// sat 'pending' with nothing telling the steward it existed — it waited for a
// human to @mention the daemon into life (measured: 85s of dead air on a 91s
// operation) while the 60s lease clock was already running.
//
// This is a trigger that spends tokens, so most of what is under test is when it
// must NOT fire, and that a dispatch failure can never damage a request whose row
// is already committed:
//   service layer
//     1. an accepted operation dispatches exactly once, naming the steward;
//     2. an idempotent REPLAY does not re-wake the steward;
//     3. a dispatcher that throws (sync or async) still returns the operation.
//   dispatch layer
//     4. the happy path posts one seed message and runs the steward in its DM;
//     5. a disabled steward is never run;
//     6. a steward mid-turn is not run and gets no seed message;
//     7. the same operation twice inside the claim window runs once;
//     8. a requester without run_agents cannot spend tokens running an agent.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceResourceService } = require('../server/workspace-resources.cjs');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

// --- service layer ----------------------------------------------------------

const WORKSPACE = 'workspace-1';
const USER = 'user-1';
const STEWARD = 'agent-steward';

function compactSql(sql) {
 return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function serviceDb(handler) {
 const queries = [];
 const transaction = {
  async unsafe(sql, params = []) {
   const entry = { sql: String(sql), normalized: compactSql(sql), params };
   queries.push(entry);
   return handler(entry);
  },
 };
 return {
  queries,
  async unsafe(sql, params = []) {
   const entry = { sql: String(sql), normalized: compactSql(sql), params };
   queries.push(entry);
   return handler(entry);
  },
  async begin(callback) { return callback(transaction); },
 };
}

function stewardRow() {
 return {
  id: STEWARD,
  workspace_id: WORKSPACE,
  controller_id: null,
  name: 'Code Handler',
  handle: 'code-handler',
  purpose: 'resource',
  resource_facets: ['code'],
  enabled: true,
 };
}

function resourceRow() {
 return {
  id: 'resource-1',
  workspace_id: WORKSPACE,
  steward_agent_id: STEWARD,
  controller_id: null,
  name: 'Repository handler',
  facet: 'code',
  version: 3,
  visibility: 'workspace',
  status: 'active',
 };
}

function operationRow(overrides = {}) {
 return {
  id: 'operation-1',
  workspace_id: WORKSPACE,
  resource_id: 'resource-1',
  steward_agent_id: STEWARD,
  requested_by_user_id: USER,
  requester_key: `user:${USER}`,
  operation: 'apply',
  input_artifact: { patch: 'safe diff' },
  output_artifact: {},
  status: 'pending',
  resource_version: 3,
  idempotency_key: 'apply:commit-1',
  attempt: 0,
  lease_version: '0',
  ...overrides,
 };
}

// `replay` decides which branch requestOperation takes: an existing row for the
// (requester, idempotency key) pair is the replay path, no row is a fresh accept.
function buildService({ replay = null, dispatch } = {}) {
 const db = serviceDb(async ({ normalized }) => {
  if (normalized.includes('from resource_operations') && normalized.includes('idempotency_key = $3')) {
   return replay ? [replay] : [];
  }
  if (normalized.includes('from workspace_resources') && normalized.includes('for share')) return [resourceRow()];
  if (normalized.includes('from workspace_agents')) return [stewardRow()];
  if (normalized.startsWith('insert into resource_operations')) return [operationRow()];
  return [];
 });
 const service = createWorkspaceResourceService({
  getDb: () => db,
  enforceWorkspaceRole: async () => {},
  recordAudit: async () => ({ id: 'audit-1' }),
  dispatchResourceOperation: dispatch,
 });
 return { service, db };
}

function request(service) {
 return service.requestOperation({
  workspaceId: WORKSPACE,
  resourceId: 'resource-1',
  requester: { kind: 'user', userId: USER, workspaceId: WORKSPACE },
  request: { operation: 'apply', inputArtifact: { patch: 'safe diff' }, idempotencyKey: 'apply:commit-1' },
 });
}

test('an accepted resource operation wakes its steward exactly once', async () => {
 const calls = [];
 const { service } = buildService({ dispatch: async (payload) => { calls.push(payload); } });

 const operation = await request(service);

 assert.equal(operation.id, 'operation-1');
 assert.equal(calls.length, 1, 'the steward is woken once');
 assert.equal(calls[0].stewardAgentId, STEWARD, 'the resource steward is the one woken');
 assert.equal(calls[0].operationId, 'operation-1', 'the payload names the operation to claim');
 assert.equal(calls[0].operation, 'apply');
 assert.equal(calls[0].resourceName, 'Repository handler', 'the steward can name the resource');
 assert.equal(calls[0].requesterUserId, USER, 'a human requester is carried through for DM routing');
});

test('an idempotent replay does not re-wake the steward', async () => {
 const calls = [];
 const { service } = buildService({
  replay: operationRow(),
  dispatch: async (payload) => { calls.push(payload); },
 });

 const operation = await request(service);

 assert.equal(operation.id, 'operation-1', 'the caller still gets its operation back');
 assert.equal(calls.length, 0, 'a retried request is not a second piece of work');
});

test('a non-human requester is described rather than routed to a DM owner', async () => {
 const calls = [];
 const db = serviceDb(async ({ normalized, params }) => {
  if (normalized.includes('from resource_operations') && normalized.includes('idempotency_key = $3')) return [];
  if (normalized.includes('from workspace_resources') && normalized.includes('for share')) return [resourceRow()];
  // The requester and the steward are both agents and both resolve through this
  // statement — the requesting collaborator must not be returned as the steward,
  // or the request fails steward validation before it can ever dispatch.
  if (normalized.includes('from workspace_agents')) {
   return params[0] === 'agent-requester'
    ? [{ ...stewardRow(), id: 'agent-requester', purpose: 'collaborator', resource_facets: [] }]
    : [stewardRow()];
  }
  if (normalized.startsWith('insert into resource_operations')) {
   return [operationRow({ requested_by_user_id: null, requester_key: 'agent:agent-requester' })];
  }
  return [];
 });
 const service = createWorkspaceResourceService({
  getDb: () => db,
  enforceWorkspaceRole: async () => {},
  recordAudit: async () => ({ id: 'audit-1' }),
  dispatchResourceOperation: async (payload) => { calls.push(payload); },
 });

 await service.requestOperation({
  workspaceId: WORKSPACE,
  resourceId: 'resource-1',
  requester: { kind: 'agent', agentId: 'agent-requester', workspaceId: WORKSPACE },
  request: { operation: 'read', inputArtifact: {}, idempotencyKey: 'read:1' },
 });

 assert.equal(calls.length, 1);
 assert.equal(calls[0].requesterKind, 'agent', 'the dispatcher can describe who asked');
 assert.equal(calls[0].requesterUserId, null, 'there is no human DM to route an agent request into');
});

test('a dispatcher that fails never fails the request whose row is committed', async () => {
 for (const dispatch of [
  () => { throw new Error('sync boom'); },       // synchronous throw
  async () => { throw new Error('async boom'); }, // rejected promise
 ]) {
  const { service } = buildService({ dispatch });
  const operation = await request(service);
  assert.equal(operation.id, 'operation-1', 'the accepted operation is still returned');
 }
 // Let the rejected promise settle so it cannot surface as an unhandled rejection.
 await new Promise(resolve => setImmediate(resolve));
});

// --- dispatch layer ---------------------------------------------------------

const STEWARD_AGENT = {
 id: 'agent-1',
 workspace_id: 'w1',
 name: 'Code Handler',
 handle: 'code-handler',
 enabled: true,
 model: 'claude-sonnet-4-6',
};

// Minimal fake DB covering only the statements dispatchResourceOperation issues.
function dispatchDb({
 agent = STEWARD_AGENT,
 session = { id: 'dm-1', workspace_id: 'w1' },
 activeJobs = [],
 ownerUserId = null,
} = {}) {
 const writes = { messageInserts: [], sessionInserts: [] };
 let seq = 0;
 return {
  writes,
  db: {
   async unsafe(sql, params) {
    const n = String(sql).replace(/\s+/g, ' ').trim();
    if (n.startsWith('select * from workspace_agents where id')) {
     return agent && String(agent.id) === String(params[0]) ? [agent] : [];
    }
    if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
     return ownerUserId && String(params[1]) === String(ownerUserId) ? [{ ok: 1 }] : [];
    }
    if (n.startsWith('select role from workspace_members')) return [];
    if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs')) {
     return activeJobs;
    }
    if (n.startsWith('select * from chat_sessions')) return [session];
    if (n.startsWith('select display_name, email from app_users')) {
     return [{ display_name: 'Jason', email: 'jason@example.com' }];
    }
    if (n.startsWith('select id from messages where session_id')) return [];
    if (n.startsWith('insert into messages')) {
     seq += 1;
     writes.messageInserts.push({ id: `m-${seq}`, sql: n, params });
     return [{ id: `m-${seq}` }];
    }
    if (n.startsWith('insert into chat_sessions')) {
     writes.sessionInserts.push({ sql: n, params });
     return [session];
    }
    return [];
   },
  },
 };
}

function recorder() {
 const runs = [];
 return { runs, run: async (args) => { runs.push(args); } };
}

function dispatchArgs(overrides = {}) {
 return {
  workspaceId: 'w1',
  operationId: 'op-1',
  resourceId: 'resource-1',
  stewardAgentId: STEWARD_AGENT.id,
  operation: 'apply',
  resourceName: 'Repository handler',
  requesterKind: 'agent',
  requesterUserId: null,
  ...overrides,
 };
}

test('enqueueing an operation runs the steward in its DM with one seed message', async () => {
 const { db, writes } = dispatchDb();
 __test.setTestDb(db);
 const { runs, run } = recorder();

 const out = await __test.dispatchResourceOperation(dispatchArgs({ run }));

 assert.equal(out.dispatched, true, 'the steward was dispatched');
 assert.equal(runs.length, 1, 'the steward runs exactly once');
 assert.equal(runs[0].sessionId, 'dm-1', 'it runs in the steward DM');
 assert.equal(writes.messageInserts.length, 1, 'one seed message, not a flood');
});

test('the seed message tells the steward exactly what to claim', async () => {
 const { db, writes } = dispatchDb();
 __test.setTestDb(db);
 const { run } = recorder();

 await __test.dispatchResourceOperation(dispatchArgs({ run }));

 const content = writes.messageInserts[0].params.find(p => typeof p === 'string' && p.includes('@code-handler'));
 assert.ok(content, 'the seed message addresses the steward');
 assert.ok(content.includes('op-1'), 'it carries the operation id to claim');
 assert.ok(content.includes('apply'), 'it names the operation');
 assert.ok(content.includes('Repository handler'), 'it names the resource');
 assert.ok(content.includes('claim_resource_operation'), 'it says how to pick the work up');
 assert.ok(content.includes('agensis://resource/resource-1'), 'it links back to the resource');
});

test('a disabled steward is never run', async () => {
 const { db, writes } = dispatchDb({ agent: { ...STEWARD_AGENT, enabled: false } });
 __test.setTestDb(db);
 const { runs, run } = recorder();

 const out = await __test.dispatchResourceOperation(dispatchArgs({ run }));

 assert.equal(out.dispatched, false);
 assert.equal(out.reason, 'agent_disabled');
 assert.equal(runs.length, 0, 'no turn is started');
 assert.equal(writes.messageInserts.length, 0, 'and no message is left behind');
});

test('a steward already mid-turn is left alone and the operation stays claimable', async () => {
 const { db, writes } = dispatchDb({
  activeJobs: [{ id: 'job-1', status: 'running', connection_id: null, metadata: { mode: 'builtin' }, started_at: null }],
 });
 __test.setTestDb(db);
 const { runs, run } = recorder();

 const out = await __test.dispatchResourceOperation(dispatchArgs({ run }));

 assert.equal(out.dispatched, false);
 assert.equal(out.reason, 'busy');
 assert.equal(runs.length, 0, 'a second turn is never started on a busy steward');
 assert.equal(writes.messageInserts.length, 0, 'a busy steward collects no unanswered seed messages');
});

test('the same operation dispatched twice in the claim window runs once', async () => {
 const { db, writes } = dispatchDb();
 __test.setTestDb(db);
 const { runs, run } = recorder();

 const first = await __test.dispatchResourceOperation(dispatchArgs({ run }));
 const second = await __test.dispatchResourceOperation(dispatchArgs({ run }));

 assert.equal(first.dispatched, true);
 assert.equal(second.dispatched, false);
 assert.equal(second.reason, 'duplicate');
 assert.equal(runs.length, 1, 'the steward is not double-run');
 assert.equal(writes.messageInserts.length, 1, 'and gets no duplicate seed message');
});

test('a requester without run_agents cannot spend tokens running the steward', async () => {
 // ownerUserId is unset, so the requester owns nothing and workspace_members
 // returns no role — a commenter/viewer who may request an operation.
 const { db, writes } = dispatchDb();
 __test.setTestDb(db);
 const { runs, run } = recorder();

 const out = await __test.dispatchResourceOperation(dispatchArgs({
  requesterKind: 'user', requesterUserId: 'user-without-rights', run,
 }));

 assert.equal(out.dispatched, false);
 assert.equal(out.reason, 'not_permitted');
 assert.equal(runs.length, 0);
 assert.equal(writes.messageInserts.length, 0);
});

test('a missing steward id is a no-op rather than a throw', async () => {
 const { db } = dispatchDb();
 __test.setTestDb(db);
 const { runs, run } = recorder();

 const out = await __test.dispatchResourceOperation(dispatchArgs({ stewardAgentId: '', run }));

 assert.equal(out.dispatched, false);
 assert.equal(out.reason, 'missing_input');
 assert.equal(runs.length, 0);
});
