'use strict';

// Human HTTP surface for agent-stewarded workspace resources.
//
// The resource tables deliberately remain outside the generic database and
// realtime allowlists. Every request is reduced to the authenticated user
// identity here, then the service re-resolves workspace capability, steward
// purpose, controller lineage and transaction/lease invariants. Agents and
// workspace controllers use the same service through MCP instead.

function userActor(req, workspaceId) {
 return {
  kind: 'user',
  userId: String(req.userId || ''),
  workspaceId: String(workspaceId || ''),
 };
}

function queryBoolean(value, fallback = false) {
 if (value === undefined) return fallback;
 if (value === true || value === 'true') return true;
 if (value === false || value === 'false') return false;
 const error = new Error('includeArtifacts must be true or false');
 error.status = 400;
 throw error;
}

function operationRequest(req) {
 const body = req.body?.request ?? req.body ?? {};
 const headerKey = String(req.headers?.['idempotency-key'] || '').trim();
 if (!headerKey || body.idempotencyKey !== undefined || body.idempotency_key !== undefined) {
  return body;
 }
 return { ...body, idempotencyKey: headerKey };
}

function resourceDefinition(req) {
 if (req.body?.definition !== undefined) return req.body.definition;
 const {
  stewardAgentId: _stewardAgentId,
  steward_agent_id: _stewardAgentIdSnake,
  ...definition
 } = req.body ?? {};
 return definition;
}

function mountWorkspaceResourceRoutes(app, deps = {}) {
 const {
  requireAuth,
  jsonError,
  workspaceResources,
  rateLimitBlocked,
  resourceOperationRateLimiter,
 } = deps;

 if (!workspaceResources) {
  throw new TypeError('mountWorkspaceResourceRoutes requires workspaceResources');
 }

 function limitMutation(req, res, workspaceId) {
  if (!rateLimitBlocked || !resourceOperationRateLimiter) return false;
  return rateLimitBlocked(
   res,
   resourceOperationRateLimiter,
   `${String(req.userId || '')}:${String(workspaceId || '')}`,
  );
 }

 app.get('/backend/workspaces/:id/resources', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const data = await workspaceResources.listResources({
    workspaceId,
    actor: userActor(req, workspaceId),
    status: req.query?.status,
    limit: req.query?.limit,
    includeDeleted: queryBoolean(req.query?.includeDeleted ?? req.query?.include_deleted, false),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/resources', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (limitMutation(req, res, workspaceId)) return;
   const data = await workspaceResources.createResource({
    workspaceId,
    stewardAgentId: req.body?.stewardAgentId ?? req.body?.steward_agent_id,
    definition: resourceDefinition(req),
    actor: userActor(req, workspaceId),
   });
   res.status(201).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Register the workspace-wide operation collection before the resource item
 // routes. This is a separate noun so an operation id can never be mistaken for
 // a resource id by Express route ordering.
 app.get('/backend/workspaces/:id/resource-operations', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const data = await workspaceResources.listOperations({
    workspaceId,
    actor: userActor(req, workspaceId),
    resourceId: req.query?.resourceId ?? req.query?.resource_id,
    status: req.query?.status,
    limit: req.query?.limit,
    includeArtifacts: queryBoolean(req.query?.includeArtifacts ?? req.query?.include_artifacts, false),
    includeDeleted: queryBoolean(req.query?.includeDeleted ?? req.query?.include_deleted, false),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/resource-operations/:operationId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const data = await workspaceResources.getOperation({
    workspaceId,
    operationId: req.params.operationId,
    actor: userActor(req, workspaceId),
    includeArtifacts: queryBoolean(req.query?.includeArtifacts ?? req.query?.include_artifacts, true),
    includeDeleted: queryBoolean(req.query?.includeDeleted ?? req.query?.include_deleted, false),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/resources/:resourceId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const data = await workspaceResources.getResource({
    workspaceId,
    resourceId: req.params.resourceId,
    actor: userActor(req, workspaceId),
    includeDeleted: queryBoolean(req.query?.includeDeleted ?? req.query?.include_deleted, false),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.patch('/backend/workspaces/:id/resources/:resourceId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (limitMutation(req, res, workspaceId)) return;
   const data = await workspaceResources.updateResource({
    workspaceId,
    resourceId: req.params.resourceId,
    changes: req.body?.changes ?? req.body,
    actor: userActor(req, workspaceId),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/resources/:resourceId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (limitMutation(req, res, workspaceId)) return;
   const data = await workspaceResources.deleteResource({
    workspaceId,
    resourceId: req.params.resourceId,
    actor: userActor(req, workspaceId),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/resources/:resourceId/restore', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (limitMutation(req, res, workspaceId)) return;
   const data = await workspaceResources.restoreResource({
    workspaceId,
    resourceId: req.params.resourceId,
    actor: userActor(req, workspaceId),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/resources/:resourceId/operations', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const data = await workspaceResources.listOperations({
    workspaceId,
    resourceId: req.params.resourceId,
    actor: userActor(req, workspaceId),
    status: req.query?.status,
    limit: req.query?.limit,
    includeArtifacts: queryBoolean(req.query?.includeArtifacts ?? req.query?.include_artifacts, false),
    includeDeleted: queryBoolean(req.query?.includeDeleted ?? req.query?.include_deleted, false),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/resources/:resourceId/operations', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (limitMutation(req, res, workspaceId)) return;
   const data = await workspaceResources.requestOperation({
    workspaceId,
    resourceId: req.params.resourceId,
    requester: userActor(req, workspaceId),
    request: operationRequest(req),
   });
   res.status(202).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = {
 userActor,
 queryBoolean,
 operationRequest,
 resourceDefinition,
 mountWorkspaceResourceRoutes,
};
