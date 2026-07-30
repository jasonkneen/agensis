'use strict';

// The audit log's read surface. ONE route, and it is the only way out of
// audit_log — the table is absent from ALLOWED_TABLES, so ensureTable() refuses
// it on every generic /backend/db/* path and authorizeRealtimeBinding refuses it
// on every WebSocket subscribe. There is no write route here at all: entries are
// written server-side by recordAuditEntry (shared/backend-core.cjs) at the
// privileged action itself, and nothing accepts an entry from a client.
//
// MANAGE ONLY. Audit rows say who changed whose role and which vault key was
// written; that is not `read` material. Same gate the actions being logged
// already cost.
//
// requireAuth means a USER SESSION, which also means an agent daemon holding an
// `aga_...` connect token cannot read this. That is deliberate: an agent that
// could read the log could enumerate which vault keys exist by name.
//
// No realtime. Audit rows are read on demand by an owner, never streamed.
//
// Dependencies are INJECTED, matching server/vault-routes.cjs, so the auth, RBAC
// and rate-limit contract stays single-sourced in index.cjs and this file cannot
// drift from it.

/** Hard ceiling on rows per page, whatever the caller asks for. */
const AUDIT_PAGE_MAX = 200;
const AUDIT_PAGE_DEFAULT = 50;

/**
 * Columns the route returns. An explicit projection rather than `*` so a column
 * added to the table later (a redaction slip, a hash-chain prev_hash) does not
 * silently start reaching browsers.
 */
const AUDIT_SELECT_COLUMNS = [
 'id', 'seq', 'workspace_id', 'actor_user_id', 'actor_agent_id', 'actor_label',
 'action', 'target_type', 'target_id', 'target_label', 'before_value',
 'after_value', 'detail', 'entry_hash', 'created_at',
];

/**
 * request_ip is stored but NOT returned. It is there for an operator answering
 * "where was this done from" out of the database; putting it in a panel that any
 * admin can open turns the log into a colleague-location tracker.
 */
function auditLimit(value) {
 const parsed = Number.parseInt(String(value ?? ''), 10);
 if (!Number.isFinite(parsed) || parsed <= 0) return AUDIT_PAGE_DEFAULT;
 return Math.min(parsed, AUDIT_PAGE_MAX);
}

function mountAuditRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb,
  rateLimitBlocked, clientIpFromReq, auditReadRateLimiter,
 } = deps;

 app.get('/backend/workspaces/:id/audit', requireAuth, async (req, res) => {
  try {
   if (auditReadRateLimiter && rateLimitBlocked
     && rateLimitBlocked(res, auditReadRateLimiter, clientIpFromReq(req))) return undefined;
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');

   const limit = auditLimit(req.query?.limit);
   const params = [workspaceId];
   let where = 'where workspace_id = $1';

   const action = String(req.query?.action || '').trim();
   if (action) {
    params.push(action.slice(0, 60));
    where += ` and action = $${params.length}`;
   }

   // Keyset pagination on (created_at, id), never OFFSET: this table only grows,
   // and an OFFSET page walk re-reads everything before it every time. `before`
   // is the created_at of the last row the caller already has; id breaks ties so
   // two entries written in the same microsecond cannot hide each other.
   const before = String(req.query?.before || '').trim();
   if (before) {
    const cursor = new Date(before);
    if (Number.isNaN(cursor.getTime())) return jsonError(res, 400, new Error('before must be an ISO timestamp'));
    params.push(cursor.toISOString());
    const beforeIndex = params.length;
    const beforeId = String(req.query?.beforeId || '').trim();
    if (beforeId) {
     params.push(beforeId);
     where += ` and (created_at, id) < ($${beforeIndex}::timestamptz, $${params.length}::uuid)`;
    } else {
     where += ` and created_at < $${beforeIndex}::timestamptz`;
    }
   }

   params.push(limit);
   const rows = await getDb().unsafe(
    `select ${AUDIT_SELECT_COLUMNS.join(', ')} from audit_log
       ${where}
       order by created_at desc, id desc
       limit $${params.length}`,
    params,
   );
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
  return undefined;
 });
}

module.exports = { mountAuditRoutes, auditLimit, AUDIT_PAGE_MAX, AUDIT_PAGE_DEFAULT, AUDIT_SELECT_COLUMNS };
