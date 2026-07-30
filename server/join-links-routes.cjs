'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Minting and revoking the ONE invite URL — https://agensis.io/join/<token> —
// that both a human and an agent can be handed.
//
// A join link is NOT a credential. It appears in no verify* function: it cannot
// authenticate a request, only be redeemed once, within 15 minutes, for a real
// one. That is the entire reason it exists — the surface it replaced handed out
// a long-lived bearer token inside a copyable convenience string, which leaked
// into a transcript, and the same mistake was then found in a second place.
//
// Redemption itself is server-rendered by server/join-page.cjs; these are only
// the management routes a workspace admin uses.

function mountJoinLinksRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, createJoinLinkToken,
  hashAgentToken, joinLinkTtlMs, joinPublicBaseUrl, joinUrlFor,
  logJoinLinkActivity,
 } = deps;

 app.get('/backend/workspaces/:id/join-links', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   // Columns listed explicitly. `select *` would ship token_hash to the browser,
   // and while a hash is not a usable credential it is a lookup key that has no
   // business leaving the server.
   const rows = await getDb().unsafe(
    `select l.id, l.workspace_id, l.label, l.role, l.audience, l.status,
                l.redeemed_as, l.redeemed_by, l.redeemed_agent_id, l.redeemed_at,
                l.expires_at, l.created_by, l.created_at,
                cu.email as created_by_email
           from workspace_join_links l
           left join app_users cu on cu.id = l.created_by
          where l.workspace_id = $1
          order by l.created_at desc
          limit 100`,
    [workspaceId],
   );
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/join-links', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const allowedRoles = ['admin', 'editor', 'commenter', 'viewer'];
   const role = allowedRoles.includes(req.body?.role) ? req.body.role : 'editor';
   const audience = ['both', 'human', 'agent'].includes(req.body?.audience) ? req.body.audience : 'both';
   const label = String(req.body?.label || '').trim().slice(0, 120);
   const ttlMs = joinLinkTtlMs();
   const token = createJoinLinkToken();
   const rows = await getDb().unsafe(
    `insert into workspace_join_links
        (workspace_id, token_hash, label, role, audience, status, expires_at, created_by)
        values ($1, $2, $3, $4, $5, 'pending', $6, $7)
        returning id, workspace_id, label, role, audience, status, expires_at, created_by, created_at`,
    [workspaceId, hashAgentToken(token), label, role, audience, new Date(Date.now() + ttlMs), req.userId],
   );
   // NOT broadcast over realtime. The row is harmless (hash only), but this
   // table is not in the backendClient allowlists and nothing subscribes to it;
   // a fanout would only create a way for it to end up somewhere it isn't needed.
   await logJoinLinkActivity({
    workspaceId,
    userId: req.userId,
    eventType: 'join_link_created',
    title: 'A join link was created',
    metadata: { join_link_id: String(rows[0].id), audience, role, ttl_ms: ttlMs },
   });
   // The URL — and therefore the token — is returned exactly ONCE, here, to the
   // manage-role caller who asked for it. Nothing can recover it afterwards: the
   // row holds only a SHA-256 hash. The list route above cannot rebuild it, the
   // page route cannot echo it, and we cannot reissue it.
   res.json({
    data: {
     ...rows[0],
     url: joinUrlFor(joinPublicBaseUrl(req), token),
     expiresInMs: ttlMs,
     singleUse: true,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/join-links/:linkId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const linkId = String(req.params.linkId || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const rows = await getDb().unsafe(
    `update workspace_join_links set status = 'revoked', updated_at = now()
          where id = $1 and workspace_id = $2 and status = 'pending'
          returning id, workspace_id, status, expires_at`,
    [linkId, workspaceId],
   );
   res.json({ data: rows[0] ?? null, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- Connect an MCP client (one workspace token) + agent-registration approvals ---
}

module.exports = { mountJoinLinksRoutes };
