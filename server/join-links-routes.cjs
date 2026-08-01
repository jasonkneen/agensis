'use strict';

const {
 controllerCredentialTtlMs,
 controllerJoinTtlMs,
 normalizeControllerName,
 normalizeControllerScopes,
} = require('../shared/workspaceControl.cjs');
const { requireWorkspaceOwner } = require('./controller-credentials.cjs');

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
  logJoinLinkActivity, recordAudit, clientIpFromReq,
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
    `select l.id, l.workspace_id, l.label, l.role, l.grant_kind, l.audience, l.status,
                l.redeemed_as, l.redeemed_by, l.redeemed_agent_id,
                l.redeemed_controller_id, l.redeemed_at,
                l.controller_name, l.controller_scopes, l.controller_expires_at,
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
   const grantKind = String(req.body?.grantKind || req.body?.grant_kind || 'individual').trim();
   if (!['individual', 'workspace_control'].includes(grantKind)) {
    return jsonError(res, 400, new Error('grantKind must be individual or workspace_control'));
   }
   if (grantKind === 'workspace_control') {
    // A manage-role admin may invite ordinary people and agents. A controller
    // credential can create persistent child agents/resources, so only the
    // actual workspace owner may issue its one-time enrollment grant.
    await requireWorkspaceOwner({ db: getDb(), userId: req.userId, workspaceId });
   } else {
    await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   }
   const allowedRoles = ['admin', 'editor', 'commenter', 'viewer'];
   const role = grantKind === 'workspace_control'
    ? 'viewer'
    : (allowedRoles.includes(req.body?.role) ? req.body.role : 'editor');
   const audience = grantKind === 'workspace_control'
    ? 'controller'
    : (['both', 'human', 'agent'].includes(req.body?.audience) ? req.body.audience : 'both');
   const label = String(req.body?.label || '').trim().slice(0, 120);
   const controllerName = grantKind === 'workspace_control'
    ? normalizeControllerName(req.body?.controllerName || req.body?.controller_name)
    : '';
   if (grantKind === 'workspace_control' && !controllerName) {
    return jsonError(res, 400, new Error('controllerName is required for workspace control'));
   }
   const parsedScopes = grantKind === 'workspace_control'
    ? normalizeControllerScopes(req.body?.scopes, { defaultScopes: [] })
    : { ok: true, scopes: [], errors: [] };
   if (!parsedScopes.ok) return jsonError(res, 400, new Error(parsedScopes.errors.join('; ')));

   const ttlMs = grantKind === 'workspace_control' ? controllerJoinTtlMs() : joinLinkTtlMs();
   const controllerTtlMs = grantKind === 'workspace_control' ? controllerCredentialTtlMs() : 0;
   const controllerExpiresAt = grantKind === 'workspace_control'
    ? new Date(Date.now() + controllerTtlMs)
    : null;
   const token = createJoinLinkToken();
   const rows = await getDb().unsafe(
    `insert into workspace_join_links
        (workspace_id, token_hash, label, role, grant_kind, audience, status,
         controller_name, controller_scopes, controller_expires_at, expires_at, created_by)
        values ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::jsonb, $9, $10, $11)
        returning id, workspace_id, label, role, grant_kind, audience, status,
                  controller_name, controller_scopes, controller_expires_at,
                  expires_at, created_by, created_at`,
    [
     workspaceId,
     hashAgentToken(token),
     label,
     role,
     grantKind,
     audience,
     controllerName,
     parsedScopes.scopes,
     controllerExpiresAt,
     new Date(Date.now() + ttlMs),
     req.userId,
    ],
   );
   // NOT broadcast over realtime. The row is harmless (hash only), but this
   // table is not in the backendClient allowlists and nothing subscribes to it;
   // a fanout would only create a way for it to end up somewhere it isn't needed.
   await logJoinLinkActivity({
    workspaceId,
    userId: req.userId,
    eventType: 'join_link_created',
    title: 'A join link was created',
    metadata: {
     join_link_id: String(rows[0].id),
     audience,
     role,
     grant_kind: grantKind,
     ttl_ms: ttlMs,
    },
   });
   if (grantKind === 'workspace_control') {
    await recordAudit({
     workspaceId,
     actor: { userId: req.userId ? String(req.userId) : '' },
     action: 'controller.enrollment_created',
     target: { type: 'workspace_join_link', id: String(rows[0].id), label: controllerName },
     after: 'pending',
     detail: {
      controllerName,
      scopes: parsedScopes.scopes,
      enrollmentTtlMs: ttlMs,
      credentialTtlMs: controllerTtlMs,
     },
     requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
    });
   }
   // The URL — and therefore the token — is returned exactly ONCE, here, to the
   // manage-role caller who asked for it. Nothing can recover it afterwards: the
   // row holds only a SHA-256 hash. The list route above cannot rebuild it, the
   // page route cannot echo it, and we cannot reissue it.
   res.json({
    data: {
     ...rows[0],
     url: joinUrlFor(joinPublicBaseUrl(req), token),
     expiresInMs: ttlMs,
     ...(grantKind === 'workspace_control' ? { credentialExpiresInMs: controllerTtlMs } : {}),
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
   const found = await getDb().unsafe(
    'select id, grant_kind from workspace_join_links where id = $1 and workspace_id = $2 limit 1',
    [linkId, workspaceId],
   );
   if (found[0]?.grant_kind === 'workspace_control') {
    await requireWorkspaceOwner({ db: getDb(), userId: req.userId, workspaceId });
   }
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
