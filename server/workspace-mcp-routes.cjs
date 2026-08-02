'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// The workspace's MCP front door: minting the workspace MCP token, the
// auto-approve setting, and the agent-registration approvals.
//
// ONE SECRET PER RESPONSE. The mint route returns the live token in exactly one
// field; the config block rendered beside it carries TOKEN_PLACEHOLDER. That
// rule exists because the opposite — a copyable convenience string with a
// long-lived bearer inside it — is what leaked into a transcript and prompted
// the whole join-link redesign.

function mountWorkspaceMcpRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, forbidden, enforceWorkspaceRole, getDb, claudeMcpAddCommand,
  configBlock, createWorkspaceMcpToken, decideAgentRegistration,
  hashAgentToken, mcpEndpoint, normalizeBaseUrl, requestBaseUrl, recordAudit,
 } = deps;

 async function requireWorkspaceOwner(userId, workspaceId) {
  const rows = await getDb().unsafe(
   'select id, user_id from workspaces where id = $1 limit 1',
   [workspaceId],
  );
  if (!rows[0]) {
   const error = new Error('Workspace not found');
   error.status = 404;
   throw error;
  }
  if (!userId || String(rows[0].user_id || '') !== String(userId)) {
   throw forbidden('Only the workspace owner can manage the workspace MCP credential');
  }
  return rows[0];
 }

 function mcpPublicBaseUrl(req) {
  return normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
   || normalizeBaseUrl(req.body?.baseUrl)
   || requestBaseUrl(req);
 }

 function mcpConnectionPayload(baseUrl, { configured, autoApprove, token = null }) {
  // ONE SECRET PER RESPONSE when minting: live token only in `token`.
  // Config / CLI snippets always use the placeholder so copy buttons cannot
  // smuggle a working credential into a transcript.
  return {
   configured: Boolean(configured),
   autoApprove: Boolean(autoApprove),
   endpoint: mcpEndpoint(baseUrl),
   config: configBlock(baseUrl),
   claudeMcpAdd: claudeMcpAddCommand(baseUrl),
   ...(token ? { token } : {}),
  };
 }

 // Status only — never returns the live bearer (only a hash is stored).
 // Settings → Connections loads this on open so the endpoint and recipes are
 // visible without minting/rotating first.
 app.get('/backend/workspaces/:id/mcp-connection', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await requireWorkspaceOwner(req.userId, workspaceId);
   const rows = await getDb().unsafe(
    `select id, mcp_auto_approve,
            (coalesce(mcp_token_hash, '') <> '') as configured
       from workspaces where id = $1 limit 1`,
    [workspaceId],
   );
   if (!rows[0]) return jsonError(res, 404, new Error('Workspace not found'));
   res.json({
    data: mcpConnectionPayload(mcpPublicBaseUrl(req), {
     configured: rows[0].configured === true || rows[0].configured === 't' || rows[0].configured === 1,
     autoApprove: rows[0].mcp_auto_approve,
    }),
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/mcp-token', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   // This is the workspace control-plane credential, not an ordinary
   // manage-capability setting. An admin may manage members and agents, but may
   // not mint a bearer with workspace-wide creation authority or rotate every
   // existing MCP client off the workspace.
   await requireWorkspaceOwner(req.userId, workspaceId);
   const token = createWorkspaceMcpToken();
   const rows = await getDb().unsafe(
    'update workspaces set mcp_token_hash = $2, updated_at = now() where id = $1 returning id, mcp_auto_approve',
    [workspaceId, hashAgentToken(token)],
   );
   if (!rows[0]) return jsonError(res, 404, new Error('Workspace not found'));
   // A mint is a credential event, and a ROTATION: the UPDATE above overwrites
   // mcp_token_hash, so every MCP client still holding the previous token starts
   // failing at that moment. Recorded: who, which workspace, and whether
   // auto-approve was on (a bearer of this token registers as an agent with no
   // popup when it is). NEVER the token, and never its hash either — same rule
   // as agent.connect_token_minted, whose shape this call mirrors.
   await recordAudit({
    workspaceId,
    actor: { userId: req.userId ? String(req.userId) : '' },
    action: 'workspace.mcp_token_minted',
    target: { type: 'workspace', id: workspaceId },
    detail: { autoApprove: Boolean(rows[0].mcp_auto_approve), rotated: true },
   });
   res.json({
    data: mcpConnectionPayload(mcpPublicBaseUrl(req), {
     configured: true,
     autoApprove: rows[0].mcp_auto_approve,
     token,
    }),
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // When on, a registering client is approved without a popup.
 app.patch('/backend/workspaces/:id/mcp-auto-approve', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   // Auto-approve turns possession of the workspace credential into immediate
   // agent-creation authority, so it has the same owner-only boundary as mint
   // and rotation above.
   await requireWorkspaceOwner(req.userId, workspaceId);
   const autoApprove = req.body?.autoApprove === true || req.body?.auto_approve === true;
   const rows = await getDb().unsafe(
    'update workspaces set mcp_auto_approve = $2, updated_at = now() where id = $1 returning id, mcp_auto_approve',
    [workspaceId, autoApprove],
   );
   if (!rows[0]) return jsonError(res, 404, new Error('Workspace not found'));
   res.json({ data: { autoApprove: Boolean(rows[0].mcp_auto_approve) }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Pending registrations drive the approval popup (realtime delivers new ones; this is
 // the initial load / fallback).
 app.get('/backend/workspaces/:id/agent-registrations', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const status = ['pending', 'approved', 'denied'].includes(req.query?.status) ? req.query.status : 'pending';
   const rows = await getDb().unsafe(
    'select id, agent_id, requested_handle, requested_name, client_label, status, created_at from agent_registrations where workspace_id = $1 and status = $2 order by created_at desc limit 50',
    [workspaceId, status],
   );
   res.json({ data: { registrations: rows }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Approve / deny a pending registration (the popup's buttons).
 app.post('/backend/agent-registrations/:id/:action', requireAuth, async (req, res) => {
  try {
   const registrationId = String(req.params.id || '').trim();
   const action = String(req.params.action || '').trim();
   if (!['approve', 'deny'].includes(action)) return jsonError(res, 400, new Error('Unknown action'));
   const found = await getDb().unsafe('select id, workspace_id from agent_registrations where id = $1 limit 1', [registrationId]);
   if (!found[0]) return jsonError(res, 404, new Error('Registration not found'));
   await enforceWorkspaceRole(req.userId, found[0].workspace_id, 'manage');
   const result = await decideAgentRegistration({ registrationId, approve: action === 'approve' });
   res.json({ data: { result }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountWorkspaceMcpRoutes };
