'use strict';

const {
 publicController,
} = require('../shared/workspaceControl.cjs');
const {
 requireWorkspaceOwner,
 revokeController,
} = require('./controller-credentials.cjs');

// Owner review and revocation for named workspace-controller credentials.
// There is intentionally no direct credential-mint route: a new controller is
// enrolled through the same short-lived /join/<token> family as every other
// connection, but with grant_kind=workspace_control and a five-minute TTL.
function mountControllerRoutes(app, deps = {}) {
 const {
  requireAuth,
  jsonError,
  getDb,
  recordAudit,
  clientIpFromReq,
 } = deps;

 app.get('/backend/workspaces/:id/controllers', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await requireWorkspaceOwner({ db: getDb(), userId: req.userId, workspaceId });
   const rows = await getDb().unsafe(
    `select id, workspace_id, name, scopes, status, parent_controller_id,
            expires_at, last_used_at, created_by, created_at, updated_at, revoked_at
       from workspace_controllers
      where workspace_id = $1
      order by created_at desc
      limit 100`,
    [workspaceId],
   );
   res.json({ data: rows.map(publicController), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/controllers/:controllerId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const controllerId = String(req.params.controllerId || '').trim();
   await requireWorkspaceOwner({ db: getDb(), userId: req.userId, workspaceId });
   if (!controllerId) return jsonError(res, 400, new Error('controller id is required'));
   const controller = await revokeController({ db: getDb(), workspaceId, controllerId });
   if (!controller) return jsonError(res, 404, new Error('Active controller not found'));
   await recordAudit({
    workspaceId,
    actor: { userId: req.userId ? String(req.userId) : '' },
    action: 'controller.revoked',
    target: { type: 'workspace_controller', id: controller.id, label: controller.name },
    before: 'active',
    after: 'revoked',
    detail: {
     scopes: controller.scopes,
     descendantsRevoked: true,
     descendantsRemainAttributed: true,
    },
    requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
   });
   res.json({ data: controller, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
  return undefined;
 });
}

module.exports = { mountControllerRoutes };
