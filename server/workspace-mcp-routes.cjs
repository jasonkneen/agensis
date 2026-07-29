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
  requireAuth, jsonError, enforceWorkspaceRole, getDb, claudeMcpAddCommand,
  configBlock, createWorkspaceMcpToken, decideAgentRegistration,
  hashAgentToken, mcpEndpoint, normalizeBaseUrl, requestBaseUrl, recordAudit,
 } = deps;

 app.post('/backend/workspaces/:id/mcp-token', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
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
   const baseUrl = normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL) || normalizeBaseUrl(req.body?.baseUrl) || requestBaseUrl(req);
   res.json({
    data: {
     token,
     autoApprove: Boolean(rows[0].mcp_auto_approve),
     endpoint: mcpEndpoint(baseUrl),
     // PLACEHOLDER too, matching `claudeMcpAdd` below and matching every other
     // caller of configBlock (server/skills.cjs passes TOKEN_PLACEHOLDER at all
     // three of its call sites). This was built with the LIVE token: it carries
     // no copy button, so it is not the leak that was reported — it is the same
     // mistake in a second place, shipping a working credential inside a
     // convenience payload the UI is free to render anywhere it likes. `token`
     // is returned as its own field two lines up, masked on screen and copied
     // deliberately, so this response now has exactly ONE field a secret can be
     // taken from.
     config: configBlock(baseUrl),
     // PLACEHOLDER, not the live token. This one-liner is displayed in full and
     // has a copy button, so embedding the real bearer token put it on the
     // clipboard as plain text — and it has already been pasted into a
     // transcript that way. The endpoint and the token are separate fields
     // right beside it (the token masked, copied deliberately), so nothing is
     // lost by making the convenience string non-secret.
     claudeMcpAdd: claudeMcpAddCommand(baseUrl),
    },
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
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
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
