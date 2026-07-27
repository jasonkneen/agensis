'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// GET /backend/agents/connections — which daemons are currently attached.
//
// `status` is derived from the LIVE socket (isConnectionSocketLive), not from
// the stored column alone: a row can say 'online' long after the process behind
// it died, and an agent that looks connected but cannot receive a dispatch is
// worse than one that is honestly offline.

function mountConnectionsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, isConnectionSocketLive, publicAgentConnection,
 } = deps;

 app.get('/backend/agents/connections', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.query.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await getDb().unsafe(
    `select *
         from agent_connections
         where workspace_id = $1
           and last_seen_at > now() - interval '24 hours'
         order by status = 'online' desc, status = 'busy' desc, last_seen_at desc`,
    [workspaceId],
   );
   // The DB status lags reality: an ungraceful drop stays 'online'/'busy' until
   // the heartbeat terminates the socket. Reconcile each row against the live
   // socket so the badge never claims an agent is reachable when dispatch would
   // find no live connection. Pessimistic: only socket-OPEN + pong-answered rows
   // keep their online/busy status; everything else reads offline.
   const reconciled = rows.map((row) => {
    const connection = publicAgentConnection(row);
    if ((connection.status === 'online' || connection.status === 'busy') && !isConnectionSocketLive(connection.id)) {
     return { ...connection, status: 'offline' };
    }
    return connection;
   });
   res.json({ data: reconciled, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // --- Inbox (triage surface) ----------------------------------------------
 // Aggregates the five existing "this needs a human" sources into one
 // newest-first list. See buildInboxSql for the visibility + boundedness
 // reasoning. Membership is enforced exactly as every sibling workspace route
 // does (enforceWorkspaceRole 'read'); getting this wrong leaks one tenant's
 // inbox into another's.
 // The sidebar's Threads section: message threads this person follows, newest
 // reply first, each carrying whether it has been read. See server/thread-inbox.cjs
 // for what counts as a thread and what counts as following one.
}

module.exports = { mountConnectionsRoutes };
