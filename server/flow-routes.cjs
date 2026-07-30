'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Flow connections: the outbound webhook integrations a workspace registers, so
// workspace events can reach an external automation.
//
// The destination URL is validated by normalizeFlowWebhookUrl before it is
// stored, and the signing secret is encrypted at rest and never returned — the
// list route reports only whether one is configured.

function mountFlowRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb,
  createPostgresFlowConnectionStore, getFlowConnectionCore, mcpEndpoint,
  normalizeBaseUrl, normalizeFlowWebhookUrl, requestBaseUrl,
 } = deps;

 app.post('/backend/workspaces/:id/flow-connections', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const channelId = req.body?.channelId ? String(req.body.channelId).trim() : null;
   if (channelId) {
    const rows = await getDb().unsafe(
     'select id from chat_sessions where id = $1 and workspace_id = $2 limit 1',
     [channelId, workspaceId],
    );
    if (!rows[0]) return jsonError(res, 404, new Error('Channel not found in this workspace'));
   }
   const created = await getFlowConnectionCore().create({
    workspaceId,
    channelId,
    name: req.body?.name || 'Flows',
    webhookUrl: normalizeFlowWebhookUrl(req.body?.webhookUrl),
    events: req.body?.events,
    createdBy: req.userId,
   });
   const baseUrl = normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
    || normalizeBaseUrl(req.body?.baseUrl)
    || requestBaseUrl(req);
   const connection = created.connection;
   return res.status(201).json({
    data: {
     id: connection.id,
     name: connection.name,
     workspaceId: connection.workspaceId,
     channelId: connection.channelId,
     scopes: connection.scopes,
     events: connection.events,
     webhookUrl: connection.webhookUrl,
     endpoint: mcpEndpoint(baseUrl),
     token: created.token,
     signingSecret: created.signingSecret,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/flow-connections', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const connections = await createPostgresFlowConnectionStore().listConnections(workspaceId);
   return res.json({
    data: connections.map(connection => ({
     id: connection.id,
     name: connection.name,
     workspaceId: connection.workspaceId,
     channelId: connection.channelId,
     scopes: connection.scopes,
     events: connection.events,
     webhookUrl: connection.webhookUrl,
     revokedAt: connection.revokedAt,
     lastSeenAt: connection.lastSeenAt,
     createdAt: connection.createdAt,
    })),
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/flow-connections/:connectionId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const rows = await getDb().unsafe(
    'select id from flow_connections where id = $1 and workspace_id = $2 limit 1',
    [req.params.connectionId, workspaceId],
   );
   if (!rows[0]) return jsonError(res, 404, new Error('Flows connection not found'));
   await getFlowConnectionCore().revoke(req.params.connectionId);
   return res.json({ data: { id: req.params.connectionId, revoked: true }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Generate/rotate the one workspace MCP token and return the ready-to-paste config.
}

module.exports = { mountFlowRoutes };
