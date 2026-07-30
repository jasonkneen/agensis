'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// The workspace surface: the list, its agents projection, and the inference
// gateway CRUD.
//
// A gateway's API key is stored AES-256-GCM-encrypted in api_key_cipher and is
// NEVER returned — publicGatewayConfig reports only `has_key`. The base URL is
// run through assertSafeOutboundUrl before it is stored, because the server will
// later fetch it from inside Fly's network.
//
// Resolving a gateway for an actual turn is NOT here: that is
// server/lib/gateways.cjs, shared with server/ai-chat-routes.cjs, because the
// decrypted key must have exactly one code path.

function mountWorkspacesRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, notifyDbSubscribers,
  parseJsonObject, agentRuntimePayload, assertSafeOutboundUrl,
  encryptVaultSecret, publicWorkspace,
 } = deps;

 app.get('/backend/workspaces', requireAuth, async (req, res) => {
  try {
   const rows = await getDb().unsafe(
    `select w.id, w.name, w.description, w.icon, w.is_system, w.parent_id,
                w.local_path, w.project_kind, w.git_root, w.git_remote,
                w.created_at, w.updated_at,
                case when w.user_id = $1 then 'owner' else coalesce(wm.role, 'viewer') end as role
         from workspaces w
         left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = $1
         where w.user_id = $1 or wm.user_id = $1
         order by w.updated_at desc nulls last, w.created_at desc nulls last, w.name asc`,
    [req.userId],
   );
   res.json({ data: rows.map(publicWorkspace), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/agents', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await getDb().unsafe(
    `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, identity, model, handle, run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, metadata, version, enabled, ambient_replies, created_by
         from workspace_agents
         where workspace_id = $1
         order by created_at asc, name asc`,
    [workspaceId],
   );
   res.json({ data: rows.map(agentRuntimePayload), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Gateway configs: workspace-level named routes to an external OpenAI-compatible
 // endpoint. The API key is stored encrypted (api_key_cipher) and is NEVER
 // returned to the client — publicGatewayConfig strips it and reports only whether
 // a key is configured. Selecting a gateway in chat routes that turn's inference
 // through /backend/ai-chat's gateway branch instead of the managed Anthropic key.

 // SSRF guard (H1). base_url comes straight from the request body and /backend/ai-chat
 function publicGatewayConfig(row) {
  return {
   id: row.id,
   workspace_id: row.workspace_id,
   name: row.name,
   base_url: row.base_url,
   model: row.model,
   protocol: row.protocol || 'openai-chat',
   headers: parseJsonObject(row.headers),
   has_key: Boolean(row.api_key_cipher),
   created_at: row.created_at,
   updated_at: row.updated_at,
  };
 }


 app.get('/backend/workspaces/:id/gateways', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await getDb().unsafe(
    'select * from gateway_configs where workspace_id = $1 order by created_at asc, name asc',
    [workspaceId],
   );
   res.json({ data: rows.map(publicGatewayConfig), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/gateways', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const name = String(req.body?.name || 'Gateway').trim().slice(0, 120) || 'Gateway';
   const rawBaseUrl = String(req.body?.base_url || req.body?.baseUrl || '').trim().slice(0, 500);
   const model = String(req.body?.model || '').trim().slice(0, 200);
   const apiKey = String(req.body?.api_key || req.body?.apiKey || '');
   const headers = parseJsonObject(req.body?.headers);
   if (!rawBaseUrl) return jsonError(res, 400, new Error('base_url is required'));
   const baseUrl = await assertSafeOutboundUrl(rawBaseUrl);
   const cipher = apiKey ? await encryptVaultSecret(apiKey) : '';
   const rows = await getDb().unsafe(
    `insert into gateway_configs (workspace_id, name, base_url, api_key_cipher, model, protocol, headers, created_by)
         values ($1, $2, $3, $4, $5, 'openai-chat', $6::jsonb, $7) returning *`,
    [workspaceId, name, baseUrl, cipher, model, headers, req.userId || null],
   );
   notifyDbSubscribers('gateway_configs', 'INSERT', rows.map(publicGatewayConfig));
   res.status(201).json({ data: publicGatewayConfig(rows[0]), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.patch('/backend/workspaces/:id/gateways/:gatewayId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const gatewayId = String(req.params.gatewayId || '').trim();
   if (!workspaceId || !gatewayId) return jsonError(res, 400, new Error('workspaceId and gatewayId are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const sets = ['updated_at = now()'];
   const params = [gatewayId, workspaceId];
   const push = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
   if (req.body?.name !== undefined) push('name', String(req.body.name).trim().slice(0, 120) || 'Gateway');
   if (req.body?.base_url !== undefined || req.body?.baseUrl !== undefined) {
    push('base_url', await assertSafeOutboundUrl(String(req.body.base_url ?? req.body.baseUrl).trim().slice(0, 500)));
   }
   if (req.body?.model !== undefined) push('model', String(req.body.model).trim().slice(0, 200));
   if (req.body?.headers !== undefined) { params.push(parseJsonObject(req.body.headers)); sets.push(`headers = $${params.length}::jsonb`); }
   // Only rotate the key when a non-empty api_key is provided; an omitted or empty
   // field leaves the stored cipher intact so a name/model edit never wipes it.
   if (req.body?.api_key || req.body?.apiKey) push('api_key_cipher', await encryptVaultSecret(String(req.body.api_key || req.body.apiKey)));
   const rows = await getDb().unsafe(
    `update gateway_configs set ${sets.join(', ')} where id = $1 and workspace_id = $2 returning *`,
    params,
   );
   if (!rows[0]) return jsonError(res, 404, new Error('Gateway not found in this workspace'));
   notifyDbSubscribers('gateway_configs', 'UPDATE', rows.map(publicGatewayConfig));
   res.json({ data: publicGatewayConfig(rows[0]), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/gateways/:gatewayId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const gatewayId = String(req.params.gatewayId || '').trim();
   if (!workspaceId || !gatewayId) return jsonError(res, 400, new Error('workspaceId and gatewayId are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const rows = await getDb().unsafe('delete from gateway_configs where id = $1 and workspace_id = $2 returning id, workspace_id', [gatewayId, workspaceId]);
   if (!rows[0]) return jsonError(res, 404, new Error('Gateway not found in this workspace'));
   notifyDbSubscribers('gateway_configs', 'DELETE', [{ id: gatewayId, workspace_id: workspaceId }]);
   res.json({ data: { id: gatewayId, deleted: true }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Voice huddles (LiveKit). Fly-only, like gateways: it needs the websocket fanout,
 // so the Netlify mirror deliberately has no huddle routes.
}

module.exports = { mountWorkspacesRoutes };
