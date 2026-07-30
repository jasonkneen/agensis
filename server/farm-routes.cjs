'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Farm integration: device pairing, silo enrolment, and job dispatch to an
// external agent farm.
//
// Two authorization models meet here, deliberately. The device-auth handshake
// (/device/start, /device/token) is UNAUTHENTICATED — a device has no session
// yet, which is the whole point of device flow, so those are rate limited by IP
// instead. Everything a person does is requireAuth + manage, and everything the
// FARM does afterwards is requireUserOrFarm with a named scope
// (agents:read / agents:enroll / agents:dispatch), so a farm token can enrol and
// dispatch but can never read a workspace's data.

function mountFarmRoutes(app, deps = {}) {
 const {
  requireAuth, requireUserOrFarm, jsonError, forbidden,
  enforceWorkspaceRole, getDb, notifyDbSubscribers, rateLimitBlocked,
  clientIpFromReq, parseJsonObject, slugHandle, cancelFarmAgentJob,
  createAgentConnectToken, createPostgresFarmIntegrationStore,
  disableFarmIntegrationAgents, disconnectAgentDaemons,
  dispatchFarmAgentJob, farmDeviceRateLimiter, getFarmAgentJob,
  getFarmIntegrationCore, hashAgentToken, isConnectionSocketLive,
  normalizeAgentBackendBaseUrl, normalizeAgentPermissionMode,
  normalizeBaseUrl, publicAgentConnection, publicFarmEnrolledAgent,
  requestBaseUrl,
 } = deps;

 app.post('/backend/integrations/farm/device/start', async (req, res) => {
  try {
   if (rateLimitBlocked(res, farmDeviceRateLimiter, `farm-device:${clientIpFromReq(req)}`)) return;
   const result = await getFarmIntegrationCore().start({ name: req.body?.name });
   const appBaseUrl = normalizeBaseUrl(process.env.AGENSIS_APP_URL || '') || requestBaseUrl(req);
   const verificationUri = `${appBaseUrl}/integrations/farm?code=${encodeURIComponent(result.userCode)}`;
   return res.status(201).json({ ...result, verificationUri });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/integrations/farm/device/approve', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.body?.workspaceId || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const result = await getFarmIntegrationCore().approve({
    userCode: req.body?.userCode,
    workspaceId,
    approvedBy: req.userId,
    scopes: req.body?.scopes,
   });
   return res.json({ data: { status: result.status, workspaceId: result.workspaceId, scopes: result.scopes }, error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/integrations/farm/device/deny', requireAuth, async (req, res) => {
  try {
   const result = await getFarmIntegrationCore().deny({ userCode: req.body?.userCode, deniedBy: req.userId });
   return res.json({ data: { status: result.status }, error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/integrations/farm/device/token', async (req, res) => {
  try {
   if (rateLimitBlocked(res, farmDeviceRateLimiter, `farm-token:${clientIpFromReq(req)}`)) return;
   return res.json(await getFarmIntegrationCore().exchange(req.body?.deviceCode));
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/integrations/farm', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.query.workspaceId || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const integrations = await createPostgresFarmIntegrationStore().listIntegrations(workspaceId);
   return res.json({ data: integrations.map(({ tokenHash: _tokenHash, ...integration }) => integration), error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/integrations/farm/:id', requireAuth, async (req, res) => {
  try {
   const rows = await getDb().unsafe('select workspace_id from farm_integrations where id = $1 limit 1', [req.params.id]);
   if (!rows[0]) return jsonError(res, 404, new Error('Farm integration was not found'));
   await enforceWorkspaceRole(req.userId, rows[0].workspace_id, 'manage');
   await getFarmIntegrationCore().revoke(req.params.id);
   const disabled = await disableFarmIntegrationAgents(rows[0].workspace_id, req.params.id);
   return res.json({ data: { id: req.params.id, revoked: true, disabledAgents: disabled.length }, error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/integrations/farm/silos', requireUserOrFarm('agents:read'), async (req, res) => {
  try {
   if (!req.farmIntegration) throw forbidden('A Farm integration token is required');
   const workspaceId = req.farmIntegration.workspaceId;
   const rows = await getDb().unsafe(
    `select c.*, a.metadata as agent_metadata, a.model as agent_model, a.run_mode, a.enabled
         from agent_connections c join workspace_agents a on a.id = c.agent_id
         where c.workspace_id = $1 and c.last_seen_at > now() - interval '24 hours'
         order by c.last_seen_at desc`,
    [workspaceId],
   );
   const silos = rows.map((row) => {
    const connection = publicAgentConnection(row);
    const agentMetadata = parseJsonObject(row.agent_metadata);
    if (['online', 'busy'].includes(connection.status) && !isConnectionSocketLive(connection.id)) connection.status = 'offline';
    return {
     ...connection,
     agentModel: row.agent_model,
     runMode: row.run_mode,
     enabled: row.enabled !== false,
     farmManaged: agentMetadata.farmIntegrationId === req.farmIntegration.id,
     runtime: agentMetadata.farmRuntime || connection.metadata.runtime || 'external-agent',
    };
   });
   return res.json({ data: silos, error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/integrations/farm/agents', requireUserOrFarm('agents:enroll'), async (req, res) => {
  try {
   if (!req.farmIntegration) throw forbidden('A Farm integration token is required');
   const workspaceId = req.farmIntegration.workspaceId;
   const name = String(req.body?.name || 'Farm silo').trim().slice(0, 120) || 'Farm silo';
   const handle = slugHandle(req.body?.handle || name);
   const runtime = String(req.body?.runtime || 'external-agent').trim().slice(0, 60) || 'external-agent';
   const token = createAgentConnectToken();
   const metadata = {
    ...parseJsonObject(req.body?.metadata),
    farmIntegrationId: req.farmIntegration.id,
    farmRuntime: runtime,
    farmManaged: true,
   };
   const rows = await getDb().unsafe(
    `insert into workspace_agents
         (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, enabled, connect_token_hash, metadata, created_by)
         values ($1, $2, $3, $4, '', $5, 'daemon', $6, true, $7, $8::jsonb, $9) returning *`,
    [workspaceId, name, handle, String(req.body?.description || '').slice(0, 500), String(req.body?.model || 'auto').slice(0, 160), normalizeAgentPermissionMode(req.body?.permissionMode), hashAgentToken(token), metadata, req.farmIntegration.approvedBy || null],
   );
   const agent = rows[0];
   notifyDbSubscribers('workspace_agents', 'INSERT', rows.map(publicFarmEnrolledAgent));
   const url = normalizeAgentBackendBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL) || normalizeAgentBackendBaseUrl(requestBaseUrl(req));
   return res.status(201).json({
    data: {
     agent: publicFarmEnrolledAgent(agent),
     connection: { url, token, workspaceId, agentId: agent.id, handle: agent.handle, name: agent.name },
    },
    error: null,
   });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/integrations/farm/agents/:id', requireUserOrFarm('agents:enroll'), async (req, res) => {
  try {
   if (!req.farmIntegration) throw forbidden('A Farm integration token is required');
   const rows = await getDb().unsafe('select * from workspace_agents where id = $1 and workspace_id = $2 limit 1', [req.params.id, req.farmIntegration.workspaceId]);
   const agent = rows[0];
   if (!agent || parseJsonObject(agent.metadata).farmIntegrationId !== req.farmIntegration.id) throw forbidden('This Farm integration does not manage that agent');
   const updated = await getDb().unsafe("update workspace_agents set enabled = false, connect_token_hash = '', updated_at = now() where id = $1 returning *", [agent.id]);
   notifyDbSubscribers('workspace_agents', 'UPDATE', updated.map(publicFarmEnrolledAgent));
   await disconnectAgentDaemons(agent.id, req.farmIntegration.workspaceId);
   return res.json({ data: { id: agent.id, disabled: true }, error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/integrations/farm/jobs', requireUserOrFarm('agents:dispatch'), async (req, res) => {
  try {
   if (!req.farmIntegration) throw forbidden('A Farm integration token is required');
   const data = await dispatchFarmAgentJob({
    workspaceId: req.farmIntegration.workspaceId,
    agentId: req.body?.agentId,
    prompt: req.body?.prompt,
    model: req.body?.model,
    permissionMode: req.body?.permissionMode,
    cwd: req.body?.cwd,
   });
   return res.status(201).json({ data, error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/integrations/farm/jobs/:id', requireUserOrFarm('agents:dispatch'), async (req, res) => {
  try {
   if (!req.farmIntegration) throw forbidden('A Farm integration token is required');
   const data = await getFarmAgentJob({ workspaceId: req.farmIntegration.workspaceId, jobId: req.params.id });
   return res.json({ data, error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/integrations/farm/jobs/:id/cancel', requireUserOrFarm('agents:dispatch'), async (req, res) => {
  try {
   if (!req.farmIntegration) throw forbidden('A Farm integration token is required');
   const data = await cancelFarmAgentJob({ workspaceId: req.farmIntegration.workspaceId, jobId: req.params.id });
   return res.json({ data, error: null });
  } catch (error) {
   return jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountFarmRoutes };
