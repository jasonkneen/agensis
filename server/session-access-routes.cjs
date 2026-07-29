'use strict';

// ============================================================================
// server/session-access-routes.cjs — the "…and allow it when required" half.
// ----------------------------------------------------------------------------
// A private session (a DM, or a sub-thread / huddle transcript derived from one)
// is readable only by its members. That is the default-deny half, and it lives
// in shared/backend-core.cjs so every read path shares one spelling of it.
//
// This file is the other half: a way to GRANT that access deliberately, to a
// named person, revocably, and on the record. Without it "private" would mean
// "unreachable", and the real cases — an admin covering for someone on leave, a
// handover, an incident — would be served by somebody sharing a password or by
// nobody at all.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE, in order of how easily each is lost:
//
// 1. AUTHORIZE ON THE WORKSPACE ROLE, NEVER ON THE GRANT. `manage` is the floor
//    — the same capability that already gates agent permission modes and
//    permanent tool grants. Crucially it is NOT "you may grant if you can read
//    this session": that would make every grant a seed for the next one, and a
//    single grant would compound into the whole workspace. A grant-holder who
//    lacks `manage` gets 403 here exactly like a stranger.
//
// 2. NEVER REVOKE A PARTICIPANT. `source` distinguishes the person whose
//    conversation it is ('participant') from someone let in ('grant'). Revoke
//    touches only the latter. Otherwise "tidy up the grant list" would silently
//    lock somebody out of their own DM, and the backfill's owner rows are
//    participants precisely so this cannot reach them.
//
// 3. EVERY GRANT AND REVOKE IS AUDITED. A silent grant is worse than no grant:
//    it has the shape of privacy with none of the substance. Denied READS are
//    deliberately not audited — see the note in AUDIT_ACTIONS.
// ============================================================================

function mountSessionAccessRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, badRequest, getDb,
  enforceWorkspaceRole, recordAudit, clientIpFromReq,
 } = deps;

 /** The session, plus the workspace to authorize against. 404 when absent. */
 async function loadSession(sessionId) {
  const rows = await getDb().unsafe(
   'select id, workspace_id, title, folder, visibility from chat_sessions where id = $1 and deleted_at is null limit 1',
   [sessionId],
  );
  return rows[0] || null;
 }

 function isPrivate(session) {
  return String(session?.visibility || '') === 'private'
   || String(session?.folder || '') === 'Direct messages';
 }

 // Who can currently read this session, and why. Manage-gated like the grant
 // itself: the member list of a private conversation is not public information,
 // and "who else can see my DM" is exactly the question the list answers.
 app.get('/backend/sessions/:id/access', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.id || '').trim();
   if (!sessionId) return jsonError(res, 400, badRequest('sessionId is required'));
   const session = await loadSession(sessionId);
   if (!session) return jsonError(res, 404, new Error('Session not found'));
   await enforceWorkspaceRole(req.userId, session.workspace_id, 'manage');

   const rows = await getDb().unsafe(
    `select m.user_id, m.source, m.granted_by, m.expires_at, m.created_at,
            coalesce(nullif(u.display_name, ''), u.email, '') as name
       from chat_session_members m
       left join app_users u on u.id = m.user_id
      where m.session_id = $1
      order by m.source asc, m.created_at asc`,
    [sessionId],
   );
   res.json({
    data: {
     sessionId,
     private: isPrivate(session),
     members: rows.map((row) => ({
      userId: String(row.user_id),
      name: row.name || '',
      source: row.source,
      grantedBy: row.granted_by ? String(row.granted_by) : null,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      // An expired row is still stored (it is history) but confers nothing —
      // the read gate evaluates expiry in SQL. Say so rather than showing a
      // list that disagrees with who can actually get in.
      active: !row.expires_at || new Date(row.expires_at).getTime() > Date.now(),
     })),
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Grant one named member read access to one private session.
 app.post('/backend/sessions/:id/access', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.id || '').trim();
   const userId = String(req.body?.userId || req.body?.user_id || '').trim();
   if (!sessionId) return jsonError(res, 400, badRequest('sessionId is required'));
   if (!userId) return jsonError(res, 400, badRequest('userId is required'));

   const session = await loadSession(sessionId);
   if (!session) return jsonError(res, 404, new Error('Session not found'));
   // RULE 1. On the workspace role, never on the caller's own access to this
   // session. See the header.
   await enforceWorkspaceRole(req.userId, session.workspace_id, 'manage');
   if (!isPrivate(session)) {
    return jsonError(res, 400, badRequest('This conversation is not private — everyone in the workspace can already read it'));
   }

   // The grantee must already be in the workspace. A grant is not a back door
   // into the tenant: it widens what a member may see, never who is a member.
   const memberRows = await getDb().unsafe(
    `select 1 from workspaces where id = $1 and user_id = $2
      union all
     select 1 from workspace_members where workspace_id = $1 and user_id = $2
     limit 1`,
    [session.workspace_id, userId],
   );
   if (memberRows.length === 0) {
    return jsonError(res, 400, badRequest('That person is not a member of this workspace'));
   }

   // Optional expiry, in whole days. Bounded so "temporary" stays meaningful —
   // an open-ended grant is available by omitting it, and should look like the
   // deliberate choice it is rather than something typed as 36500.
   let expiresAt = null;
   const days = req.body?.expiresInDays;
   if (days !== undefined && days !== null && days !== '') {
    const n = Math.trunc(Number(days));
    if (!Number.isFinite(n) || n < 1 || n > 365) {
     return jsonError(res, 400, badRequest('expiresInDays must be between 1 and 365'));
    }
    expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
   }

   // RULE 2, insert half. A row that is already a 'participant' must not be
   // rewritten to a 'grant' — that would make the owner of the DM revocable.
   // The DO UPDATE is therefore filtered to grant rows only, which is what lets
   // re-granting extend or shorten an expiry without inventing a second route.
   const rows = await getDb().unsafe(
    `insert into chat_session_members (session_id, user_id, source, granted_by, expires_at)
          values ($1, $2, 'grant', $3, $4)
     on conflict (session_id, user_id) do update
            set granted_by = excluded.granted_by,
                expires_at = excluded.expires_at
          where chat_session_members.source = 'grant'
      returning user_id, source, expires_at`,
    [sessionId, userId, req.userId, expiresAt],
   );
   // Zero rows means the conflict target was a participant and the WHERE
   // filtered the update out — nothing changed, and nothing needed to.
   const alreadyParticipant = rows.length === 0;

   if (!alreadyParticipant) {
    await recordAudit({
     workspaceId: String(session.workspace_id),
     actor: { userId: String(req.userId) },
     action: 'chat_session.access_granted',
     target: { type: 'chat_session', id: sessionId, label: String(session.title || '') },
     after: userId,
     detail: { grantee: userId, expiresAt: expiresAt || '', folder: String(session.folder || '') },
     requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
    });
   }

   res.json({
    data: { sessionId, userId, source: alreadyParticipant ? 'participant' : 'grant', expiresAt },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Revoke a GRANT. Participants are untouchable here by design (rule 2).
 app.delete('/backend/sessions/:id/access/:userId', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.id || '').trim();
   const userId = String(req.params.userId || '').trim();
   if (!sessionId || !userId) return jsonError(res, 400, badRequest('sessionId and userId are required'));

   const session = await loadSession(sessionId);
   if (!session) return jsonError(res, 404, new Error('Session not found'));
   await enforceWorkspaceRole(req.userId, session.workspace_id, 'manage');

   const rows = await getDb().unsafe(
    `delete from chat_session_members
      where session_id = $1 and user_id = $2 and source = 'grant'
      returning user_id`,
    [sessionId, userId],
   );
   if (rows.length === 0) {
    // Either there was nothing to revoke, or the row is a participant. Both are
    // "no grant here", and distinguishing them would tell the caller who the
    // conversation belongs to.
    return jsonError(res, 404, new Error('No grant to revoke for that person'));
   }

   await recordAudit({
    workspaceId: String(session.workspace_id),
    actor: { userId: String(req.userId) },
    action: 'chat_session.access_revoked',
    target: { type: 'chat_session', id: sessionId, label: String(session.title || '') },
    before: userId,
    detail: { grantee: userId, folder: String(session.folder || '') },
    requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
   });

   // A revoked grant must not survive in a socket that subscribed while it was
   // valid. Same precedent as revokeRealtimeAccessForMember on a role change:
   // authorization that only applies at subscribe time is authorization with an
   // expiry date of "whenever they next reconnect".
   if (typeof deps.revokeRealtimeAccessForMember === 'function') {
    try {
     await deps.revokeRealtimeAccessForMember(userId);
    } catch (error) {
     console.error('revoke realtime after session grant revoke failed', error?.message || error);
    }
   }

   res.json({ data: { sessionId, userId, revoked: true }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountSessionAccessRoutes };
