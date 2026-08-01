'use strict';

// Agent-stewarded workspace resources are intentionally reachable only through
// this service. The tables are not generic-DB or realtime surfaces: every read
// has an explicit projection and every write re-resolves the authenticated
// actor, tenant, steward, controller lineage, and (for settlement) lease fence.

const {
 RESOURCE_STATUSES,
 RESOURCE_OPERATION_STATUSES,
 normalizeResourceDefinition,
 normalizeResourceOperationRequest,
 normalizeResourceOperationResult,
 publicResource,
 publicResourceOperation,
 plainObject,
} = require('../shared/workspaceResources.cjs');
const {
 controllerHasScope: defaultControllerHasScope,
 normalizeControllerScopes,
} = require('../shared/workspaceControl.cjs');

const RESOURCE_OPERATION_LEASE_MS = 60_000;
const RESOURCE_LIST_DEFAULT_LIMIT = 100;
const RESOURCE_LIST_MAX_LIMIT = 200;
const RESOURCE_OPERATION_LIST_DEFAULT_LIMIT = 50;
const RESOURCE_OPERATION_LIST_MAX_LIMIT = 100;
const RESOURCE_OPERATION_CLAIM_SCAN_LIMIT = 20;
const RESOURCE_OPERATION_MAX_ATTEMPTS = 3;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const STALE_SETTLEMENT_ERROR = 'Resource version changed before settlement';
const EXHAUSTED_OPERATION_ERROR = 'Resource operation exceeded its claim attempt limit';

const RESOURCE_COLUMN_NAMES = Object.freeze([
 'id',
 'workspace_id',
 'steward_agent_id',
 'controller_id',
 'name',
 'description',
 'facet',
 'descriptor',
 'version',
 'visibility',
 'status',
 'created_by',
 'created_at',
 'updated_at',
]);

const OPERATION_COLUMN_NAMES = Object.freeze([
 'id',
 'workspace_id',
 'resource_id',
 'steward_agent_id',
 'requested_by_user_id',
 'requested_by_agent_id',
 'requested_by_controller_id',
 'requested_by_workspace_id',
 'requester_key',
 'claimed_by_agent_id',
 'operation',
 'input_artifact',
 'output_artifact',
 'status',
 'resource_version',
 'idempotency_key',
 'attempt',
 'lease_version',
 'lease_expires_at',
 'error',
 'audit_reference',
 'created_at',
 'updated_at',
 'claimed_at',
 'completed_at',
]);

// Dedicated operation reads do not even SELECT the server-only idempotency key,
// requester key, attempt counter, or lease state. Artifacts are an explicit
// opt-in on lists and the default on a single-operation read.
const OPERATION_PUBLIC_COLUMN_NAMES = Object.freeze([
 'id',
 'workspace_id',
 'resource_id',
 'steward_agent_id',
 'requested_by_user_id',
 'requested_by_agent_id',
 'requested_by_controller_id',
 'requested_by_workspace_id',
 'claimed_by_agent_id',
 'operation',
 'status',
 'resource_version',
 'error',
 'audit_reference',
 'created_at',
 'updated_at',
 'claimed_at',
 'completed_at',
]);
const OPERATION_ARTIFACT_COLUMN_NAMES = Object.freeze([
 ...OPERATION_PUBLIC_COLUMN_NAMES,
 'input_artifact',
 'output_artifact',
]);

const RESOURCE_DEFINITION_FIELDS = new Set([
 'name', 'description', 'facet', 'visibility', 'descriptor',
]);
const RESOURCE_UPDATE_FIELDS = new Set([
 ...RESOURCE_DEFINITION_FIELDS,
 'status',
 'stewardAgentId',
 'steward_agent_id',
]);
const RESOURCE_OPERATION_REQUEST_FIELDS = new Set([
 'operation', 'inputArtifact', 'input_artifact', 'idempotencyKey', 'idempotency_key',
]);
const RESOURCE_OPERATION_RESULT_FIELDS = new Set([
 'status', 'outputArtifact', 'output_artifact', 'error',
]);
const TERMINAL_OPERATION_STATUSES = new Set(['completed', 'rejected', 'failed', 'cancelled']);
const VERSION_ADVANCING_OPERATIONS = new Set(['apply', 'publish']);

function httpError(status, message, code = '') {
 const error = new Error(message);
 error.status = status;
 if (code) error.code = code;
 return error;
}

function badRequest(message, code = 'invalid_request') {
 return httpError(400, message, code);
}

function forbidden(message, code = 'forbidden') {
 return httpError(403, message, code);
}

function notFound(message, code = 'not_found') {
 return httpError(404, message, code);
}

function conflict(message, code = 'conflict') {
 return httpError(409, message, code);
}

function serverError(message, code = 'service_misconfigured') {
 return httpError(500, message, code);
}

function projection(columnNames, alias = '') {
 const prefix = alias ? `${alias}.` : '';
 return columnNames.map(column => `${prefix}${column}`).join(', ');
}

const RESOURCE_PROJECTION = projection(RESOURCE_COLUMN_NAMES);
const OPERATION_PROJECTION = projection(OPERATION_COLUMN_NAMES);
const OPERATION_PUBLIC_PROJECTION = projection(OPERATION_PUBLIC_COLUMN_NAMES);
const OPERATION_ARTIFACT_PROJECTION = projection(OPERATION_ARTIFACT_COLUMN_NAMES);

function requiredId(value, label) {
 const id = String(value || '').trim();
 if (!id) throw badRequest(`${label} is required`);
 return id;
}

function parseArray(value) {
 if (Array.isArray(value)) return value;
 if (typeof value !== 'string') return [];
 try {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
 } catch {
  return [];
 }
}

function assertOnlyFields(value, allowed, label) {
 if (!plainObject(value)) throw badRequest(`${label} must be an object`);
 const unknown = Object.keys(value).filter(key => !allowed.has(key));
 if (unknown.length > 0) {
  throw badRequest(`Unsupported ${label} field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
 }
}

function normalizeIdentity(identity, workspaceId, label = 'actor') {
 if (!plainObject(identity)) throw badRequest(`${label} identity is required`);
 const kind = String(identity.kind || '').trim();
 const ids = {
  user: String(identity.userId || '').trim(),
  agent: String(identity.agentId || '').trim(),
  controller: String(identity.controllerId || '').trim(),
  workspace: kind === 'workspace' ? String(identity.workspaceId || '').trim() : '',
 };
 const present = Object.values(ids).filter(Boolean);
 if (!['user', 'agent', 'controller', 'workspace'].includes(kind) || present.length !== 1 || !ids[kind]) {
  throw badRequest(`Exactly one authenticated ${label} identity is required`);
 }
 const identityWorkspaceId = String(identity.workspaceId || '').trim();
 if (identityWorkspaceId && identityWorkspaceId !== workspaceId) {
  throw forbidden(`The authenticated ${label} belongs to a different workspace`);
 }
 return {
  kind,
  id: ids[kind],
  workspaceId,
 };
}

function auditActor(identity) {
 if (identity.kind === 'user') return { userId: identity.id };
 if (identity.kind === 'agent') return { agentId: identity.id };
 if (identity.kind === 'workspace') return { label: `workspace:${identity.id}` };
 return { label: `controller:${identity.id}` };
}

function canonicalJson(value) {
 if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
 if (value && typeof value === 'object') {
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
 }
 return JSON.stringify(value);
}

function sameJson(left, right) {
 const normalize = value => {
  if (plainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
 };
 return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}

function normalizeLeaseVersion(value) {
 const leaseVersion = String(value ?? '').trim();
 if (!/^[1-9]\d*$/.test(leaseVersion)) {
  throw badRequest('leaseVersion must be a positive integer');
 }
 if (BigInt(leaseVersion) > PG_BIGINT_MAX) {
  throw badRequest('leaseVersion exceeds the supported integer range');
 }
 return leaseVersion;
}

function normalizeBooleanOption(value, defaultValue, label) {
 if (value === undefined || value === null || value === '') return defaultValue;
 if (value === true || value === 'true') return true;
 if (value === false || value === 'false') return false;
 throw badRequest(`${label} must be true or false`);
}

function publicClaimedOperation(row) {
 const operation = publicResourceOperation(row);
 if (!operation) return null;
 return {
  ...operation,
  attempt: Math.max(0, Number(row.attempt) || 0),
  // bigint is intentionally exposed as a decimal string. A fence must never be
  // rounded by JavaScript before the steward sends it back for settlement.
  lease_version: String(row.lease_version ?? '0'),
  lease_expires_at: row.lease_expires_at || null,
 };
}

function operationMatchesRequest(row, { resourceId, request }) {
 return String(row.resource_id || '') === resourceId
  && String(row.operation || '') === request.operation
  && sameJson(row.input_artifact, request.inputArtifact);
}

function operationMatchesResult(row, result) {
 return String(row.status || '') === result.status
  && String(row.error || '') === result.error
  && sameJson(row.output_artifact, result.outputArtifact);
}

function operationMatchesSettlementAttempt(row, result) {
 if (operationMatchesResult(row, result)) return true;
 return String(row.status || '') === 'failed'
  && String(row.error || '') === STALE_SETTLEMENT_ERROR
  && result.status === 'completed'
  && VERSION_ADVANCING_OPERATIONS.has(String(row.operation || ''))
  && sameJson(row.output_artifact, result.outputArtifact);
}

function changedResourceFields(before, after) {
 const fields = [];
 for (const field of [
  'name', 'description', 'facet', 'visibility', 'status', 'steward_agent_id', 'controller_id',
 ]) {
  if (String(before[field] ?? '') !== String(after[field] ?? '')) fields.push(field);
 }
 if (!sameJson(before.descriptor, after.descriptor)) fields.push('descriptor');
 return fields;
}

function createWorkspaceResourceService(deps = {}) {
 const {
  getDb,
  enforceWorkspaceRole,
  assertWorkspaceRoleLocked,
  recordAudit = async () => null,
  // Wakes the steward when an operation is enqueued. Defaults to a no-op so the
  // service stays pure for tests and for any caller that has no agent runtime;
  // a missing dispatcher degrades to the old pull-only behaviour rather than
  // failing a request that is already committed.
  dispatchResourceOperation = async () => null,
  controllerHasScope = defaultControllerHasScope,
  operationLeaseMs = RESOURCE_OPERATION_LEASE_MS,
  maxOperationAttempts = RESOURCE_OPERATION_MAX_ATTEMPTS,
 } = deps;

 if (typeof getDb !== 'function') {
  throw new TypeError('createWorkspaceResourceService requires getDb');
 }
 if (!Number.isSafeInteger(operationLeaseMs) || operationLeaseMs < 1_000 || operationLeaseMs > 15 * 60_000) {
  throw new TypeError('operationLeaseMs must be an integer between 1000 and 900000');
 }
 if (!Number.isSafeInteger(maxOperationAttempts) || maxOperationAttempts < 1 || maxOperationAttempts > 100) {
  throw new TypeError('maxOperationAttempts must be an integer between 1 and 100');
 }

 function database() {
  const db = getDb();
  if (!db || typeof db.unsafe !== 'function') throw serverError('Workspace resource database is unavailable');
  return db;
 }

 async function inTransaction(callback) {
  const db = database();
  if (typeof db.begin !== 'function') {
   throw serverError('Workspace resource writes require transaction support');
  }
  return db.begin(async transaction => {
   if (!transaction || typeof transaction.unsafe !== 'function') {
    throw serverError('Workspace resource transaction is unavailable');
   }
   return callback(transaction);
  });
 }

 async function safeRecordAudit(entry) {
  try {
   return await recordAudit(entry);
  } catch {
   // The shared audit writer is deliberately non-blocking. Preserve that
   // property if a test or alternate composition supplies a throwing hook.
   return null;
  }
 }

 async function requireUserCapability(identity, workspaceId, capability, { tx = null } = {}) {
  if (tx && typeof assertWorkspaceRoleLocked === 'function') {
   await assertWorkspaceRoleLocked({
    userId: identity.id,
    workspaceId,
    capability,
    db: (sql, params = []) => tx.unsafe(sql, params),
   });
   return;
  }
  if (typeof enforceWorkspaceRole !== 'function') {
   throw serverError('User resource access requires enforceWorkspaceRole');
  }
  await enforceWorkspaceRole(identity.id, workspaceId, capability);
 }

 async function requireController(db, identity, workspaceId, scope, { lock = false } = {}) {
  const rows = await db.unsafe(
   `select id, workspace_id, name, scopes, status, expires_at
      from workspace_controllers
     where id = $1
       and workspace_id = $2
       and status = 'active'
       and expires_at > now()
     limit 1${lock ? '\n     for share' : ''}`,
   [identity.id, workspaceId],
  );
  const row = rows[0];
  if (!row) throw forbidden('The workspace controller is unavailable or revoked');
  const normalized = normalizeControllerScopes(parseArray(row.scopes), { defaultScopes: [] });
  const resolved = {
   kind: 'controller',
   controllerId: String(row.id),
   workspaceId: String(row.workspace_id),
   scopes: normalized.ok ? normalized.scopes : [],
  };
  if (!controllerHasScope(resolved, scope)) {
   throw forbidden(`The workspace controller requires the ${scope} scope`);
  }
  return row;
 }

 async function requireAgent(db, agentId, workspaceId, {
  lock = false,
  unavailableStatus = 403,
  allowDisabled = false,
 } = {}) {
  const rows = await db.unsafe(
   `select id, workspace_id, controller_id, name, handle, purpose, resource_facets, enabled
      from workspace_agents
     where id = $1 and workspace_id = $2
     limit 1${lock ? '\n     for share' : ''}`,
   [agentId, workspaceId],
  );
  const row = rows[0];
  if (!row || (!allowDisabled && row.enabled === false)) {
   const errorFactory = unavailableStatus === 404 ? notFound : forbidden;
   throw errorFactory('The agent is unavailable in this workspace');
  }
  return row;
 }

 function assertResourceSteward(agent, facet = '') {
  if (String(agent.purpose || '') !== 'resource') {
   throw badRequest('A workspace resource must be stewarded by a resource-purpose agent');
  }
  if (facet && !parseArray(agent.resource_facets).includes(facet)) {
   throw badRequest(`The steward agent does not support the ${facet} facet`);
  }
 }

 async function authorizeViewer(db, actor, workspaceId) {
  const identity = normalizeIdentity(actor, workspaceId);
 if (identity.kind === 'user') {
   await requireUserCapability(identity, workspaceId, 'read');
   return { identity, controllerId: '', agent: null };
  }
  if (identity.kind === 'workspace') {
   return { identity, controllerId: '', agent: null };
  }
 if (identity.kind === 'controller') {
   await requireController(db, identity, workspaceId, 'resources:manage_own');
   return { identity, controllerId: identity.id, agent: null };
  }
  const agent = await requireAgent(db, identity.id, workspaceId);
  return { identity, controllerId: '', agent };
 }

 async function authorizeManager(db, actor, workspaceId, controllerScope) {
  const identity = normalizeIdentity(actor, workspaceId);
 if (identity.kind === 'user') {
   await requireUserCapability(identity, workspaceId, 'manage', { tx: db });
   return { identity, controller: null };
  }
  if (identity.kind === 'workspace') {
   return { identity, controller: null };
  }
  if (identity.kind !== 'controller') {
   throw forbidden('Only a workspace manager or scoped controller can manage resources');
  }
  const controller = await requireController(db, identity, workspaceId, controllerScope, { lock: true });
  return { identity, controller };
 }

 async function createResource({ workspaceId: rawWorkspaceId, stewardAgentId: rawStewardId, definition, actor }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const stewardAgentId = requiredId(rawStewardId, 'stewardAgentId');
  assertOnlyFields(definition, RESOURCE_DEFINITION_FIELDS, 'resource definition');
  const normalized = normalizeResourceDefinition(definition);
  if (!normalized.ok) throw badRequest(normalized.errors.join('; '));

  const created = await inTransaction(async tx => {
   const authorization = await authorizeManager(tx, actor, workspaceId, 'resources:create');
   const steward = await requireAgent(tx, stewardAgentId, workspaceId, { lock: true, unavailableStatus: 404 });
   assertResourceSteward(steward, normalized.resource.facet);
   const controllerId = steward.controller_id ? String(steward.controller_id) : null;
   if (authorization.identity.kind === 'controller' && controllerId !== authorization.identity.id) {
    throw forbidden('The workspace controller does not own the steward agent');
   }

   const rows = await tx.unsafe(
    `insert into workspace_resources
       (workspace_id, steward_agent_id, controller_id, name, description,
        facet, visibility, descriptor, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     returning ${RESOURCE_PROJECTION}`,
    [
     workspaceId,
     stewardAgentId,
     controllerId,
     normalized.resource.name,
     normalized.resource.description,
     normalized.resource.facet,
     normalized.resource.visibility,
     normalized.resource.descriptor,
     authorization.identity.kind === 'user' ? authorization.identity.id : null,
    ],
   );
   if (!rows[0]) throw serverError('Workspace resource could not be created', 'resource_create_failed');
   return { row: rows[0], identity: authorization.identity };
  });

  await safeRecordAudit({
   workspaceId,
   actor: auditActor(created.identity),
   action: 'resource.created',
   target: { type: 'workspace_resource', id: String(created.row.id), label: String(created.row.name || '') },
   after: 'active',
   detail: {
    stewardAgentId: String(created.row.steward_agent_id),
    controllerId: created.row.controller_id ? String(created.row.controller_id) : '',
    facet: String(created.row.facet),
    visibility: String(created.row.visibility),
   },
  });
  return publicResource(created.row);
 }

 async function listResources({ workspaceId: rawWorkspaceId, actor, status = 'active', limit = RESOURCE_LIST_DEFAULT_LIMIT }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const resolvedStatus = String(status || 'active').trim();
  if (resolvedStatus !== 'all' && !RESOURCE_STATUSES.includes(resolvedStatus)) {
   throw badRequest(`status must be all or one of ${RESOURCE_STATUSES.join(', ')}`);
  }
  const resolvedLimit = Math.min(
   RESOURCE_LIST_MAX_LIMIT,
   Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : RESOURCE_LIST_DEFAULT_LIMIT),
  );
  const db = database();
  const authorization = await authorizeViewer(db, actor, workspaceId);
  const where = ['workspace_id = $1'];
  const params = [workspaceId];
  if (resolvedStatus !== 'all') {
   params.push(resolvedStatus);
   where.push(`status = $${params.length}`);
  }
  if (authorization.identity.kind === 'controller') {
   params.push(authorization.identity.id);
   where.push(`controller_id = $${params.length}`);
  } else if (authorization.identity.kind === 'agent') {
   params.push(authorization.identity.id);
   where.push(`(visibility = 'workspace' or steward_agent_id = $${params.length})`);
  }
  params.push(resolvedLimit);
  const rows = await db.unsafe(
   `select ${RESOURCE_PROJECTION}
      from workspace_resources
     where ${where.join(' and ')}
     order by created_at desc, id asc
     limit $${params.length}`,
   params,
  );
  return rows.map(publicResource).filter(Boolean);
 }

 async function getResource({ workspaceId: rawWorkspaceId, resourceId: rawResourceId, actor }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const resourceId = requiredId(rawResourceId, 'resourceId');
  const db = database();
  const authorization = await authorizeViewer(db, actor, workspaceId);
  const where = ['id = $1', 'workspace_id = $2'];
  const params = [resourceId, workspaceId];
  if (authorization.identity.kind === 'controller') {
   params.push(authorization.identity.id);
   where.push(`controller_id = $${params.length}`);
  } else if (authorization.identity.kind === 'agent') {
   params.push(authorization.identity.id);
   where.push(`(visibility = 'workspace' or steward_agent_id = $${params.length})`);
  }
  const rows = await db.unsafe(
   `select ${RESOURCE_PROJECTION}
      from workspace_resources
     where ${where.join(' and ')}
     limit 1`,
   params,
  );
  if (!rows[0]) throw notFound('Workspace resource was not found');
  return publicResource(rows[0]);
 }

 function appendOperationAudience(where, params, identity) {
  if (identity.kind === 'controller') {
   params.push(identity.id);
   where.push(`(
    operation.requested_by_controller_id = $${params.length}
   or resource.controller_id = $${params.length}
   )`);
  } else if (identity.kind === 'agent') {
   params.push(identity.id);
   where.push(`(
    operation.requested_by_agent_id = $${params.length}
    or operation.steward_agent_id = $${params.length}
   )`);
  }
 }

 async function listOperations({
  workspaceId: rawWorkspaceId,
  actor,
  resourceId: rawResourceId = '',
  status = 'all',
  limit = RESOURCE_OPERATION_LIST_DEFAULT_LIMIT,
  includeArtifacts = false,
 }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const resourceId = String(rawResourceId || '').trim();
  const resolvedStatus = String(status || 'all').trim();
  if (resolvedStatus !== 'all' && !RESOURCE_OPERATION_STATUSES.includes(resolvedStatus)) {
   throw badRequest(`status must be all or one of ${RESOURCE_OPERATION_STATUSES.join(', ')}`);
  }
  const resolvedLimit = Math.min(
   RESOURCE_OPERATION_LIST_MAX_LIMIT,
   Math.max(
    1,
    Number.isFinite(Number(limit))
     ? Math.trunc(Number(limit))
     : RESOURCE_OPERATION_LIST_DEFAULT_LIMIT,
   ),
  );
  const db = database();
  const authorization = await authorizeViewer(db, actor, workspaceId);
  const withArtifacts = normalizeBooleanOption(includeArtifacts, false, 'includeArtifacts');
  const where = ['operation.workspace_id = $1'];
  const params = [workspaceId];
  if (resourceId) {
   params.push(resourceId);
   where.push(`operation.resource_id = $${params.length}`);
  }
  if (resolvedStatus !== 'all') {
   params.push(resolvedStatus);
   where.push(`operation.status = $${params.length}`);
  }
  appendOperationAudience(where, params, authorization.identity);
  params.push(resolvedLimit);
  const columns = withArtifacts
   ? projection(OPERATION_ARTIFACT_COLUMN_NAMES, 'operation')
   : projection(OPERATION_PUBLIC_COLUMN_NAMES, 'operation');
  const rows = await db.unsafe(
   `select ${columns}
      from resource_operations operation
      join workspace_resources resource
        on resource.id = operation.resource_id
       and resource.workspace_id = operation.workspace_id
     where ${where.join(' and ')}
     order by operation.created_at desc, operation.id asc
     limit $${params.length}`,
   params,
  );
  return rows
   .map(row => publicResourceOperation(row, { includeArtifacts: withArtifacts }))
   .filter(Boolean);
 }

 async function getOperation({
  workspaceId: rawWorkspaceId,
  operationId: rawOperationId,
  actor,
  includeArtifacts = true,
 }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const operationId = requiredId(rawOperationId, 'operationId');
  const db = database();
  const authorization = await authorizeViewer(db, actor, workspaceId);
  const where = ['operation.id = $1', 'operation.workspace_id = $2'];
  const params = [operationId, workspaceId];
  appendOperationAudience(where, params, authorization.identity);
  const withArtifacts = normalizeBooleanOption(includeArtifacts, true, 'includeArtifacts');
  const columns = withArtifacts
   ? projection(OPERATION_ARTIFACT_COLUMN_NAMES, 'operation')
   : projection(OPERATION_PUBLIC_COLUMN_NAMES, 'operation');
  const rows = await db.unsafe(
   `select ${columns}
      from resource_operations operation
      join workspace_resources resource
        on resource.id = operation.resource_id
       and resource.workspace_id = operation.workspace_id
     where ${where.join(' and ')}
     limit 1`,
   params,
  );
  if (!rows[0]) throw notFound('Resource operation was not found');
  return publicResourceOperation(rows[0], { includeArtifacts: withArtifacts });
 }

 async function updateResource({ workspaceId: rawWorkspaceId, resourceId: rawResourceId, changes, actor }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const resourceId = requiredId(rawResourceId, 'resourceId');
  assertOnlyFields(changes, RESOURCE_UPDATE_FIELDS, 'resource update');

  const updated = await inTransaction(async tx => {
   const authorization = await authorizeManager(tx, actor, workspaceId, 'resources:manage_own');
   const currentRows = await tx.unsafe(
    `select ${RESOURCE_PROJECTION}
       from workspace_resources
      where id = $1 and workspace_id = $2
      limit 1
      for update`,
    [resourceId, workspaceId],
   );
   const current = currentRows[0];
   if (!current) throw notFound('Workspace resource was not found');
   if (
    authorization.identity.kind === 'controller'
    && String(current.controller_id || '') !== authorization.identity.id
   ) {
    throw forbidden('The workspace controller does not own this resource');
   }

   const mergedDefinition = {
    name: changes.name === undefined ? current.name : changes.name,
    description: changes.description === undefined ? current.description : changes.description,
    facet: changes.facet === undefined ? current.facet : changes.facet,
    visibility: changes.visibility === undefined ? current.visibility : changes.visibility,
    descriptor: changes.descriptor === undefined ? current.descriptor : changes.descriptor,
   };
   const normalized = normalizeResourceDefinition(mergedDefinition);
   if (!normalized.ok) throw badRequest(normalized.errors.join('; '));
   const status = changes.status === undefined ? String(current.status) : String(changes.status || '').trim();
   if (!RESOURCE_STATUSES.includes(status)) {
    throw badRequest(`status must be one of ${RESOURCE_STATUSES.join(', ')}`);
   }
   const stewardAgentId = requiredId(
    changes.stewardAgentId ?? changes.steward_agent_id ?? current.steward_agent_id,
    'stewardAgentId',
   );
   const stewardChanged = stewardAgentId !== String(current.steward_agent_id);
   const archiving = status === 'archived' && String(current.status) !== 'archived';
   const steward = await requireAgent(tx, stewardAgentId, workspaceId, {
    lock: true,
    unavailableStatus: 404,
    // A disabled steward must not make its resource impossible to archive. A
    // reassignment still requires a live replacement.
    allowDisabled: archiving && !stewardChanged,
   });
   // Archiving may preserve an unavailable current steward so recovery cannot
   // wedge. A replacement is still a new steward and must satisfy the normal
   // purpose/facet invariant even when the resource is archived in one patch.
   if (!archiving || stewardChanged) assertResourceSteward(steward, normalized.resource.facet);
   const controllerId = archiving && !stewardChanged
    ? (current.controller_id ? String(current.controller_id) : null)
    : (steward.controller_id ? String(steward.controller_id) : null);
   if (authorization.identity.kind === 'controller' && controllerId !== authorization.identity.id) {
    throw forbidden('The workspace controller does not own the steward agent');
   }

   const changesOperationBoundary = stewardChanged
    || normalized.resource.facet !== String(current.facet)
    || !sameJson(normalized.resource.descriptor, current.descriptor)
    || normalized.resource.visibility !== String(current.visibility)
    || archiving;
   let cancelledOperations = [];
   if (changesOperationBoundary) {
    // The resource row is already locked. New requests take FOR SHARE on that
    // row, so none can appear before this transaction commits. Settlement uses
    // the same resource -> operation lock order below.
    const live = await tx.unsafe(
     `select id
        from resource_operations
       where resource_id = $1
         and workspace_id = $2
         and status = 'claimed'
         and lease_expires_at > now()
       order by created_at asc
       limit 1
       for update`,
     [resourceId, workspaceId],
    );
    if (live[0]) {
     throw conflict('A live claimed operation must settle or expire before changing this resource');
    }
    // Cancel the complete eligible set in this transaction. The resource lock
    // blocks new requests and claims, so an arbitrary row-count cap here would
    // turn a backlog into a permanently unfixable resource.
    cancelledOperations = await tx.unsafe(
     `update resource_operations
         set status = 'cancelled',
             error = 'Cancelled because the resource definition changed',
             lease_expires_at = null,
             completed_at = now(),
             updated_at = now()
       where resource_id = $1
         and workspace_id = $2
         and (
          status = 'pending'
          or (status = 'claimed' and (lease_expires_at is null or lease_expires_at <= now()))
         )
       returning id, resource_id, operation, status`,
     [resourceId, workspaceId],
    );
   }

   const rows = await tx.unsafe(
    `update workspace_resources
        set name = $3,
            description = $4,
            facet = $5,
            descriptor = $6::jsonb,
            visibility = $7,
            status = $8,
            steward_agent_id = $9,
            controller_id = $10,
            updated_at = now()
      where id = $1 and workspace_id = $2
      returning ${RESOURCE_PROJECTION}`,
    [
     resourceId,
     workspaceId,
     normalized.resource.name,
     normalized.resource.description,
     normalized.resource.facet,
     normalized.resource.descriptor,
     normalized.resource.visibility,
     status,
     stewardAgentId,
     controllerId,
    ],
   );
   if (!rows[0]) throw conflict('Workspace resource changed before it could be updated');
   return {
    before: current,
    row: rows[0],
    identity: authorization.identity,
    cancelledOperations,
   };
  });

  const changed = changedResourceFields(updated.before, updated.row);
  await safeRecordAudit({
   workspaceId,
   actor: auditActor(updated.identity),
   action: 'resource.updated',
   target: { type: 'workspace_resource', id: String(updated.row.id), label: String(updated.row.name || '') },
   before: String(updated.before.status || ''),
   after: String(updated.row.status || ''),
   detail: {
    changed,
    stewardAgentId: String(updated.row.steward_agent_id),
    controllerId: updated.row.controller_id ? String(updated.row.controller_id) : '',
    facet: String(updated.row.facet),
    cancelledOperationCount: updated.cancelledOperations.length,
   },
  });
  for (const operation of updated.cancelledOperations) {
   await safeRecordAudit({
    workspaceId,
    actor: auditActor(updated.identity),
    action: 'resource.operation_settled',
    target: {
     type: 'resource_operation',
     id: String(operation.id),
     label: String(operation.operation || ''),
    },
    before: String(operation.status === 'cancelled' ? 'pending_or_expired_claim' : operation.status || ''),
    after: 'cancelled',
    detail: {
     resourceId: String(operation.resource_id),
     reason: 'resource_definition_changed',
    },
   });
  }
  return publicResource(updated.row);
 }

 async function authorizeRequester(tx, requester, workspaceId) {
  const identity = normalizeIdentity(requester, workspaceId, 'requester');
  if (identity.kind === 'user') {
   await requireUserCapability(identity, workspaceId, 'run_agents', { tx });
   return { identity, agent: null };
  }
  if (identity.kind === 'controller') {
   await requireController(tx, identity, workspaceId, 'resources:manage_own', { lock: true });
   return { identity, agent: null };
  }
  const agent = await requireAgent(tx, identity.id, workspaceId, { lock: true });
  return { identity, agent };
 }

 async function requestOperation({
  workspaceId: rawWorkspaceId,
  resourceId: rawResourceId,
  requester,
  request,
 }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const resourceId = requiredId(rawResourceId, 'resourceId');
  assertOnlyFields(request, RESOURCE_OPERATION_REQUEST_FIELDS, 'resource operation request');
  const normalized = normalizeResourceOperationRequest(request);
  if (!normalized.ok) throw badRequest(normalized.errors.join('; '));

  const requested = await inTransaction(async tx => {
   const authorization = await authorizeRequester(tx, requester, workspaceId);
   const requesterKey = `${authorization.identity.kind}:${authorization.identity.id}`;
   // Idempotency describes the already-accepted request, not today's mutable
   // resource state. A response-lost retry must still recover its row after the
   // resource is archived, reassigned, restricted, or its steward goes offline.
   const replay = await tx.unsafe(
    `select ${OPERATION_PROJECTION}
       from resource_operations
      where workspace_id = $1
        and requester_key = $2
        and idempotency_key = $3
      limit 1`,
    [workspaceId, requesterKey, normalized.request.idempotencyKey],
   );
   if (replay[0]) {
    if (!operationMatchesRequest(replay[0], { resourceId, request: normalized.request })) {
     throw conflict(
      'The idempotency key is already used for a different resource operation',
      'idempotency_mismatch',
     );
    }
    return { row: replay[0], created: false, identity: authorization.identity, resource: null };
   }

   const resources = await tx.unsafe(
    `select ${RESOURCE_PROJECTION}
       from workspace_resources
      where id = $1 and workspace_id = $2
      limit 1
      for share`,
    [resourceId, workspaceId],
   );
   const resource = resources[0];
   if (!resource) throw notFound('Workspace resource was not found');
   if (String(resource.status) !== 'active') throw conflict('Archived resources cannot accept operations');
   if (
    authorization.identity.kind === 'controller'
    && String(resource.controller_id || '') !== authorization.identity.id
   ) {
    throw forbidden('The workspace controller does not own this resource');
   }
   if (
    authorization.identity.kind === 'agent'
    && String(resource.visibility) === 'restricted'
    && String(resource.steward_agent_id) !== authorization.identity.id
   ) {
    throw forbidden('This restricted resource is visible only to its steward');
   }
   const steward = await requireAgent(
    tx,
    String(resource.steward_agent_id),
    workspaceId,
    { lock: true, unavailableStatus: 404 },
   );
   assertResourceSteward(steward, String(resource.facet));
   if (String(steward.controller_id || '') !== String(resource.controller_id || '')) {
    throw conflict('The resource controller lineage no longer matches its steward');
   }

   const requesterIds = {
    user: authorization.identity.kind === 'user' ? authorization.identity.id : null,
    agent: authorization.identity.kind === 'agent' ? authorization.identity.id : null,
    controller: authorization.identity.kind === 'controller' ? authorization.identity.id : null,
    workspace: authorization.identity.kind === 'workspace' ? authorization.identity.id : null,
   };
   const rows = await tx.unsafe(
    `insert into resource_operations
       (workspace_id, resource_id, steward_agent_id,
        requested_by_user_id, requested_by_agent_id, requested_by_controller_id, requested_by_workspace_id,
        requester_key, operation, input_artifact, resource_version, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
     on conflict (workspace_id, requester_key, idempotency_key) do nothing
     returning ${OPERATION_PROJECTION}`,
    [
     workspaceId,
     resourceId,
     String(resource.steward_agent_id),
     requesterIds.user,
     requesterIds.agent,
     requesterIds.controller,
     requesterIds.workspace,
     requesterKey,
     normalized.request.operation,
     normalized.request.inputArtifact,
     Number(resource.version) || 1,
     normalized.request.idempotencyKey,
    ],
   );
   if (rows[0]) {
    return { row: rows[0], created: true, identity: authorization.identity, resource };
   }

   const existing = await tx.unsafe(
    `select ${OPERATION_PROJECTION}
       from resource_operations
      where workspace_id = $1
        and requester_key = $2
        and idempotency_key = $3
      limit 1`,
    [workspaceId, requesterKey, normalized.request.idempotencyKey],
   );
   if (!existing[0]) {
    throw conflict('The idempotency key was claimed concurrently; retry the request');
   }
   if (!operationMatchesRequest(existing[0], { resourceId, request: normalized.request })) {
    throw conflict(
     'The idempotency key is already used for a different resource operation',
     'idempotency_mismatch',
    );
   }
   return { row: existing[0], created: false, identity: authorization.identity, resource };
  });

  if (requested.created) {
   const audit = await safeRecordAudit({
    workspaceId,
    actor: auditActor(requested.identity),
    action: 'resource.operation_requested',
    target: {
     type: 'resource_operation',
     id: String(requested.row.id),
     label: String(requested.row.operation || ''),
    },
    after: 'pending',
    detail: {
     resourceId: String(requested.row.resource_id),
     stewardAgentId: String(requested.row.steward_agent_id),
     operation: String(requested.row.operation),
     resourceVersion: Number(requested.row.resource_version) || 1,
    },
   });
   if (audit?.id) {
    try {
     await database().unsafe(
      `update resource_operations
          set audit_reference = $2
        where id = $1 and workspace_id = $3 and audit_reference is null
        returning id`,
      [String(requested.row.id), String(audit.id), workspaceId],
     );
    } catch {
     // The durable audit row already points at the operation. This convenience
     // backlink must not turn an accepted request into an error.
    }
   }

   // Claiming is pull-only, so before this nothing told the steward an operation
   // existed — it sat pending until a human happened to wake the daemon, while
   // the lease clock (RESOURCE_OPERATION_LEASE_MS) was already running. Wake the
   // steward in its DM instead, the same way a comment @mention does.
   //
   // Fire-and-forget on purpose: the row is committed and still claimable by the
   // old pull path, so a dispatch that fails, is refused, or is throttled must
   // never turn an accepted request into an error response. Guarded by
   // `requested.created`, so an idempotent replay never re-wakes the steward.
   // try/catch AND .catch: an async dispatcher rejects, but a synchronously
   // throwing one would escape the promise wrapper entirely and fail a request
   // whose row is already committed.
   try {
    void Promise.resolve(
     dispatchResourceOperation({
      workspaceId,
      operationId: String(requested.row.id),
      resourceId: String(requested.row.resource_id),
      stewardAgentId: String(requested.row.steward_agent_id),
      operation: String(requested.row.operation),
      resourceName: String(requested.resource?.name || ''),
      requesterKind: String(requested.identity.kind || ''),
      requesterUserId: requested.identity.kind === 'user' ? String(requested.identity.id) : null,
     }),
    ).catch(error => console.error('dispatchResourceOperation failed', error));
   } catch (error) {
    console.error('dispatchResourceOperation failed', error);
   }
  }
  return publicResourceOperation(requested.row);
 }

 async function requesterStillAuthorized(tx, operation, workspaceId) {
  const requesterIds = [
   ['user', operation.requested_by_user_id],
   ['agent', operation.requested_by_agent_id],
   ['controller', operation.requested_by_controller_id],
   ['workspace', operation.requested_by_workspace_id],
  ].filter(([, id]) => Boolean(id));
  if (requesterIds.length !== 1) {
   return { ok: false, reason: 'invalid_requester_attribution' };
  }
  const [kind, rawId] = requesterIds[0];
  const id = String(rawId);
  try {
   const resources = await tx.unsafe(
    `select id, workspace_id, steward_agent_id, controller_id, visibility, status
       from workspace_resources
      where id = $1 and workspace_id = $2
      limit 1`,
    [String(operation.resource_id), workspaceId],
   );
   const resource = resources[0];
   if (!resource || String(resource.status) !== 'active') {
    return { ok: false, reason: 'resource_unavailable' };
   }
   if (kind === 'user') {
    await requireUserCapability({ kind: 'user', id }, workspaceId, 'run_agents', { tx });
   } else if (kind === 'agent') {
    await requireAgent(tx, id, workspaceId, { lock: true });
    if (
     String(resource.visibility) === 'restricted'
     && String(resource.steward_agent_id) !== id
    ) {
     return { ok: false, reason: 'resource_access_revoked' };
    }
  } else if (kind === 'controller') {
   await requireController(
     tx,
     { kind: 'controller', id },
     workspaceId,
     'resources:manage_own',
     { lock: true },
    );
    if (String(resource.controller_id || '') !== id) {
     return { ok: false, reason: 'controller_ownership_revoked' };
    }
  } else if (kind === 'workspace') {
   const workspaceRows = await tx.unsafe(
    'select id from workspaces where id = $1 limit 1',
    [id],
   );
   if (!workspaceRows[0]) return { ok: false, reason: 'workspace_authority_revoked' };
  }
   return { ok: true, reason: '' };
  } catch (error) {
   if (error?.status === 403 || error?.status === 404) {
    return { ok: false, reason: `${kind}_authority_revoked` };
   }
   throw error;
  }
 }

 async function auditAutomaticOperationSettlements(workspaceId, operations) {
  for (const operation of operations) {
   await safeRecordAudit({
    workspaceId,
    actor: { label: 'resource operation guard' },
    action: 'resource.operation_settled',
    target: {
     type: 'resource_operation',
     id: String(operation.id),
     label: String(operation.operation || ''),
    },
    before: String(operation.guard_before_status || 'pending_or_expired_claim'),
    after: String(operation.status || ''),
    detail: {
     resourceId: String(operation.resource_id),
     reason: String(operation.guard_reason || 'guard_rejected'),
    },
   });
  }
 }

 function deferAutomaticOperationSettlementAudits(workspaceId, operations) {
  if (operations.length === 0) return;
  // The claim lease is already ticking. Audit remains durable, but a slow audit
  // backend must not consume the steward's execution window before the claim is
  // returned. The audit helper is best-effort and swallows individual failures.
  void auditAutomaticOperationSettlements(workspaceId, operations).catch(() => {});
 }

 async function cleanupClaimQueue(workspaceId, stewardAgentId) {
  // Stale-version cleanup follows the shared resource -> operation order. The
  // exhausted-attempt pass needs no resource state and locks operations only.
  // Commit both before claiming so no cleanup operation lock survives into a
  // later resource-locking phase.
  return inTransaction(async tx => {
   const steward = await requireAgent(tx, stewardAgentId, workspaceId, { lock: true });
   assertResourceSteward(steward);
   const automaticSettlements = [];

   // Pending mutations can become stale while another operation advances the
   // resource. Terminalize a bounded batch so they never sit at the head of the
   // queue forever.
   for (let scanned = 0; scanned < RESOURCE_OPERATION_CLAIM_SCAN_LIMIT; scanned += 1) {
    const staleCandidates = await tx.unsafe(
     `select candidate.id as stale_operation_id
        from resource_operations candidate
        join workspace_resources resource
          on resource.id = candidate.resource_id
         and resource.workspace_id = candidate.workspace_id
       where candidate.workspace_id = $1
         and candidate.steward_agent_id = $2
         and candidate.operation in ('apply', 'publish')
         and candidate.resource_version <> resource.version
         and (
          candidate.status = 'pending'
          or (
           candidate.status = 'claimed'
           and (candidate.lease_expires_at is null or candidate.lease_expires_at <= now())
          )
         )
       order by candidate.created_at asc, candidate.id asc
       limit 1
       for update of resource skip locked`,
     [workspaceId, stewardAgentId],
    );
    if (!staleCandidates[0]) break;
    const stale = await tx.unsafe(
     `update resource_operations
         set status = 'rejected',
             error = 'Resource version changed before execution',
             lease_expires_at = null,
             completed_at = now(),
             updated_at = now()
       where id = $1
         and workspace_id = $2
         and steward_agent_id = $3
         and operation in ('apply', 'publish')
         and (
          status = 'pending'
          or (status = 'claimed' and (lease_expires_at is null or lease_expires_at <= now()))
         )
         and exists (
          select 1
            from workspace_resources resource
           where resource.id = resource_operations.resource_id
             and resource.workspace_id = resource_operations.workspace_id
             and resource_operations.resource_version <> resource.version
         )
       returning ${OPERATION_PROJECTION}`,
     [String(staleCandidates[0].stale_operation_id), workspaceId, stewardAgentId],
    );
    if (stale[0]) {
     automaticSettlements.push({
      ...stale[0],
      guard_reason: 'stale_resource_version',
     });
    }
   }

   // A crashing steward must not reclaim the oldest row forever. Once the
   // bounded attempt budget is spent, terminalize it and continue scanning so
   // later work can make progress.
   const exhausted = await tx.unsafe(
    `update resource_operations
        set status = 'failed',
            error = $3,
            lease_expires_at = null,
            completed_at = now(),
            updated_at = now()
      where id in (
       select candidate.id
         from resource_operations candidate
        where candidate.workspace_id = $1
          and candidate.steward_agent_id = $2
          and candidate.attempt >= $4
          and (
           candidate.status = 'pending'
           or (
            candidate.status = 'claimed'
            and (candidate.lease_expires_at is null or candidate.lease_expires_at <= now())
           )
          )
        order by candidate.created_at asc, candidate.id asc
        limit $5
        for update of candidate skip locked
      )
        and workspace_id = $1
        and steward_agent_id = $2
        and attempt >= $4
        and (
         status = 'pending'
         or (status = 'claimed' and (lease_expires_at is null or lease_expires_at <= now()))
        )
      returning ${OPERATION_PROJECTION}`,
    [
     workspaceId,
     stewardAgentId,
     EXHAUSTED_OPERATION_ERROR,
     maxOperationAttempts,
     RESOURCE_OPERATION_CLAIM_SCAN_LIMIT,
    ],
   );
   automaticSettlements.push(...exhausted.map(row => ({
    ...row,
    guard_reason: 'claim_attempts_exhausted',
   })));
   return automaticSettlements;
  });
 }

 async function claimOperation({ workspaceId: rawWorkspaceId, actor }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const identity = normalizeIdentity(actor, workspaceId, 'steward');
  if (identity.kind !== 'agent') {
   throw forbidden('Only an authenticated steward agent can claim resource operations');
  }
  const stewardAgentId = identity.id;
  const cleaned = await cleanupClaimQueue(workspaceId, stewardAgentId);
  deferAutomaticOperationSettlementAudits(workspaceId, cleaned);
  const claimed = await inTransaction(async tx => {
   const steward = await requireAgent(tx, stewardAgentId, workspaceId, { lock: true });
   assertResourceSteward(steward);
   const automaticSettlements = [];

   for (let scanned = 0; scanned < RESOURCE_OPERATION_CLAIM_SCAN_LIMIT; scanned += 1) {
    // Lock the resource before the operation. Structural updates and settlement
    // use the same order, while SKIP LOCKED lets another worker make progress on
    // a different resource instead of waiting behind this one.
    const candidates = await tx.unsafe(
     `select candidate.id
        from resource_operations candidate
        join workspace_resources resource
          on resource.id = candidate.resource_id
         and resource.workspace_id = candidate.workspace_id
        join workspace_agents steward
          on steward.id = candidate.steward_agent_id
         and steward.workspace_id = candidate.workspace_id
       where candidate.workspace_id = $1
         and candidate.steward_agent_id = $2
         and resource.status = 'active'
         and resource.steward_agent_id = $2
         and resource.controller_id is not distinct from steward.controller_id
         and steward.enabled = true
         and steward.purpose = 'resource'
         and steward.resource_facets @> jsonb_build_array(resource.facet)
         and candidate.attempt < $3
         and (
          candidate.operation not in ('apply', 'publish')
          or candidate.resource_version = resource.version
         )
         and (
          candidate.operation not in ('apply', 'publish')
          or not exists (
           select 1
             from resource_operations live_mutation
            where live_mutation.resource_id = candidate.resource_id
              and live_mutation.id <> candidate.id
              and live_mutation.operation in ('apply', 'publish')
              and live_mutation.status = 'claimed'
              and live_mutation.lease_expires_at > now()
          )
         )
         and (
          candidate.status = 'pending'
          or (
           candidate.status = 'claimed'
           and (candidate.lease_expires_at is null or candidate.lease_expires_at <= now())
          )
         )
       order by candidate.created_at asc, candidate.id asc
       limit 1
       for update of resource skip locked`,
     [workspaceId, stewardAgentId, maxOperationAttempts],
    );
    if (!candidates[0]) return { row: null, automaticSettlements };

    const rows = await tx.unsafe(
     `update resource_operations
         set status = 'claimed',
             claimed_by_agent_id = $3,
             claimed_at = now(),
             attempt = resource_operations.attempt + 1,
             lease_version = resource_operations.lease_version + 1,
             lease_expires_at = now() + ($4 || ' milliseconds')::interval,
             updated_at = now()
       where id = $1
         and workspace_id = $2
         and steward_agent_id = $3
         and (
          status = 'pending'
          or (status = 'claimed' and (lease_expires_at is null or lease_expires_at <= now()))
         )
         and attempt < $5
       returning ${OPERATION_PROJECTION}`,
     [
      String(candidates[0].id),
      workspaceId,
      stewardAgentId,
      String(operationLeaseMs),
      maxOperationAttempts,
     ],
    );
    const candidate = rows[0];
    if (!candidate) continue;

    const requester = await requesterStillAuthorized(tx, candidate, workspaceId);
    if (requester.ok) return { row: candidate, automaticSettlements };
    const cancelled = await tx.unsafe(
     `update resource_operations
         set status = 'cancelled',
             error = $4,
             lease_expires_at = null,
             completed_at = now(),
             updated_at = now()
       where id = $1
         and claimed_by_agent_id = $2
         and lease_version = $3::bigint
         and status = 'claimed'
         and workspace_id = $5
       returning ${OPERATION_PROJECTION}`,
     [
      String(candidate.id),
      stewardAgentId,
      String(candidate.lease_version),
      `Requester authorization is no longer valid: ${requester.reason}`,
      workspaceId,
     ],
    );
    if (!cancelled[0]) throw conflict('Resource operation claim changed during authorization');
    automaticSettlements.push({
     ...cancelled[0],
     guard_reason: requester.reason,
     guard_before_status: 'pending_or_expired_claim',
    });
   }
   return { row: null, automaticSettlements };
  });
  deferAutomaticOperationSettlementAudits(workspaceId, claimed.automaticSettlements);
  return claimed.row ? publicClaimedOperation(claimed.row) : null;
 }

 async function renewOperation({
  workspaceId: rawWorkspaceId,
  operationId: rawOperationId,
  actor,
  leaseVersion: rawLeaseVersion,
 }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const operationId = requiredId(rawOperationId, 'operationId');
  const identity = normalizeIdentity(actor, workspaceId, 'steward');
  if (identity.kind !== 'agent') {
   throw forbidden('Only an authenticated steward agent can renew resource operations');
  }
  const stewardAgentId = identity.id;
  const leaseVersion = normalizeLeaseVersion(rawLeaseVersion);
  const renewed = await inTransaction(async tx => {
   const steward = await requireAgent(tx, stewardAgentId, workspaceId, { lock: true });
   assertResourceSteward(steward);
   const preflight = await tx.unsafe(
    `select resource_id
       from resource_operations
      where id = $1 and workspace_id = $2
      limit 1`,
    [operationId, workspaceId],
   );
   if (!preflight[0]) throw notFound('Resource operation was not found');
   // Renewal uses the same resource -> operation lock order as claim, update,
   // and settlement. An expired lease cannot be extended; it must be reclaimed
   // with a new fence before an external side effect resumes.
   const resources = await tx.unsafe(
    `select ${RESOURCE_PROJECTION}
       from workspace_resources
      where id = $1 and workspace_id = $2
      limit 1
      for update`,
    [String(preflight[0].resource_id), workspaceId],
   );
   if (!resources[0]) throw notFound('Workspace resource was not found');
   const operations = await tx.unsafe(
    `select ${OPERATION_PROJECTION},
            (lease_expires_at is not null and lease_expires_at > now()) as lease_is_live
       from resource_operations
      where id = $1 and workspace_id = $2
      limit 1
      for update`,
    [operationId, workspaceId],
   );
   const operation = operations[0];
   if (!operation) throw notFound('Resource operation was not found');
   if (String(operation.steward_agent_id || '') !== stewardAgentId) {
    throw forbidden('Only the resource steward can renew this operation');
   }
   if (String(operation.claimed_by_agent_id || '') !== stewardAgentId) {
    throw forbidden('The operation is not claimed by this steward agent');
   }
   if (String(operation.lease_version ?? '') !== leaseVersion) {
    throw conflict('The resource operation lease fence is stale', 'stale_lease_fence');
   }
   if (String(operation.status || '') !== 'claimed') {
    throw conflict('The resource operation is not currently claimed');
   }
   if (operation.lease_is_live !== true) {
    throw conflict('The resource operation lease expired before renewal', 'expired_lease');
   }
   const rows = await tx.unsafe(
    `update resource_operations
        set lease_expires_at = now() + ($4 || ' milliseconds')::interval,
            updated_at = now()
      where id = $1
        and workspace_id = $2
        and claimed_by_agent_id = $3
        and lease_version = $5::bigint
        and status = 'claimed'
        and lease_expires_at > now()
      returning ${OPERATION_PROJECTION}`,
    [operationId, workspaceId, stewardAgentId, String(operationLeaseMs), leaseVersion],
   );
   if (!rows[0]) {
    throw conflict('The resource operation lease changed during renewal', 'stale_lease_fence');
   }
   return rows[0];
  });
  return publicClaimedOperation(renewed);
 }

 async function settleOperation({
  workspaceId: rawWorkspaceId,
  operationId: rawOperationId,
  actor,
  leaseVersion: rawLeaseVersion,
  result,
 }) {
  const workspaceId = requiredId(rawWorkspaceId, 'workspaceId');
  const operationId = requiredId(rawOperationId, 'operationId');
  const identity = normalizeIdentity(actor, workspaceId, 'steward');
  if (identity.kind !== 'agent') {
   throw forbidden('Only an authenticated steward agent can settle resource operations');
  }
  const stewardAgentId = identity.id;
  const leaseVersion = normalizeLeaseVersion(rawLeaseVersion);
  assertOnlyFields(result, RESOURCE_OPERATION_RESULT_FIELDS, 'resource operation result');
  const normalized = normalizeResourceOperationResult(result);
  if (!normalized.ok) throw badRequest(normalized.errors.join('; '));

  const settled = await inTransaction(async tx => {
   const steward = await requireAgent(tx, stewardAgentId, workspaceId, { lock: true });
   assertResourceSteward(steward);
   const preflight = await tx.unsafe(
    `select resource_id
       from resource_operations
      where id = $1 and workspace_id = $2
      limit 1`,
    [operationId, workspaceId],
   );
   if (!preflight[0]) throw notFound('Resource operation was not found');

   // Resource -> operation is the shared lock order with structural updates.
   // The preliminary read is safe because resource_id is immutable.
   const resources = await tx.unsafe(
    `select ${RESOURCE_PROJECTION}
       from workspace_resources
      where id = $1 and workspace_id = $2
      limit 1
      for update`,
    [String(preflight[0].resource_id), workspaceId],
   );
   const resource = resources[0];
   if (!resource) throw notFound('Workspace resource was not found');
   const operations = await tx.unsafe(
    `select ${OPERATION_PROJECTION},
            (lease_expires_at is not null and lease_expires_at > now()) as lease_is_live
       from resource_operations
      where id = $1 and workspace_id = $2
      limit 1
      for update`,
    [operationId, workspaceId],
   );
   const operation = operations[0];
   if (!operation) throw notFound('Resource operation was not found');
   if (String(operation.steward_agent_id || '') !== stewardAgentId) {
    throw forbidden('Only the resource steward can settle this operation');
   }
   if (String(operation.claimed_by_agent_id || '') !== stewardAgentId) {
    throw forbidden('The operation is not claimed by this steward agent');
   }
   if (String(operation.lease_version ?? '') !== leaseVersion) {
    throw conflict('The resource operation lease fence is stale', 'stale_lease_fence');
   }
   if (TERMINAL_OPERATION_STATUSES.has(String(operation.status || ''))) {
    if (!operationMatchesSettlementAttempt(operation, normalized.result)) {
     throw conflict('The resource operation was already settled with a different result');
    }
    return { row: operation, newlySettled: false };
   }
   if (String(operation.status || '') !== 'claimed') {
    throw conflict('The resource operation is not currently claimed');
   }
   if (operation.lease_is_live !== true) {
    throw conflict('The resource operation lease expired before settlement', 'expired_lease');
   }

   if (String(operation.resource_id) !== String(resource.id)) {
    throw conflict('The resource operation target changed unexpectedly');
   }
   if (String(resource.steward_agent_id || '') !== stewardAgentId) {
    throw conflict('The workspace resource steward changed while the operation was claimed');
   }
   assertResourceSteward(steward, String(resource.facet));
   if (String(steward.controller_id || '') !== String(resource.controller_id || '')) {
    throw conflict('The resource controller lineage no longer matches its steward');
   }

   let resourceVersion = Number(operation.resource_version) || 1;
   let settlementResult = normalized.result;
   const advancesVersion = normalized.result.status === 'completed'
    && VERSION_ADVANCING_OPERATIONS.has(String(operation.operation));
   if (advancesVersion) {
    const advanced = await tx.unsafe(
     `update workspace_resources
         set version = version + 1,
             updated_at = now()
       where id = $1
         and workspace_id = $2
         and version = $3
         and status = 'active'
       returning ${RESOURCE_PROJECTION}`,
     [String(resource.id), workspaceId, resourceVersion],
    );
    if (!advanced[0]) {
     // This is terminal, not retryable: leaving the row claimed would make it
     // the oldest reclaim forever and could starve the whole steward queue.
     settlementResult = {
      status: 'failed',
      outputArtifact: normalized.result.outputArtifact,
      error: STALE_SETTLEMENT_ERROR,
     };
    } else {
     resourceVersion = Number(advanced[0].version) || resourceVersion + 1;
    }
   }

   const rows = await tx.unsafe(
    `update resource_operations
        set status = $4,
            output_artifact = $5::jsonb,
            error = $6,
            resource_version = $7,
            lease_expires_at = null,
            completed_at = now(),
            updated_at = now()
      where id = $1
        and claimed_by_agent_id = $2
        and lease_version = $3::bigint
        and status = 'claimed'
        and steward_agent_id = $2
        and workspace_id = $8
        and lease_expires_at > now()
      returning ${OPERATION_PROJECTION}`,
    [
     operationId,
     stewardAgentId,
     leaseVersion,
     settlementResult.status,
     settlementResult.outputArtifact,
     settlementResult.error,
     resourceVersion,
     workspaceId,
    ],
   );
   if (!rows[0]) {
    // The transaction rolls a preceding resource version increment back too.
    throw conflict('The resource operation lease changed during settlement', 'stale_lease_fence');
   }
   return { row: rows[0], newlySettled: true };
  });

  if (settled.newlySettled) {
   await safeRecordAudit({
    workspaceId,
    actor: { agentId: stewardAgentId },
    action: 'resource.operation_settled',
    target: {
     type: 'resource_operation',
     id: String(settled.row.id),
     label: String(settled.row.operation || ''),
    },
    before: 'claimed',
    after: String(settled.row.status || ''),
    detail: {
     resourceId: String(settled.row.resource_id),
     operation: String(settled.row.operation),
     resourceVersion: Number(settled.row.resource_version) || 1,
     leaseVersion,
     attempt: Math.max(0, Number(settled.row.attempt) || 0),
    },
   });
  }
  return publicResourceOperation(settled.row);
 }

 return Object.freeze({
  createResource,
  listResources,
  getResource,
  listOperations,
  getOperation,
  updateResource,
  requestOperation,
  claimOperation,
  renewOperation,
  settleOperation,
 });
}

module.exports = {
 RESOURCE_OPERATION_LEASE_MS,
 RESOURCE_LIST_DEFAULT_LIMIT,
 RESOURCE_LIST_MAX_LIMIT,
 RESOURCE_OPERATION_LIST_DEFAULT_LIMIT,
 RESOURCE_OPERATION_LIST_MAX_LIMIT,
 RESOURCE_OPERATION_CLAIM_SCAN_LIMIT,
 RESOURCE_OPERATION_MAX_ATTEMPTS,
 RESOURCE_PROJECTION,
 OPERATION_PROJECTION,
 OPERATION_PUBLIC_PROJECTION,
 OPERATION_ARTIFACT_PROJECTION,
 httpError,
 publicClaimedOperation,
 createWorkspaceResourceService,
};
