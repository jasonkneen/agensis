'use strict';

const crypto = require('crypto');

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Workspace membership and the invite lifecycle: list, add, change role, remove,
// mint, revoke, and redeem.
//
// A workspace_invite is a legacy, email-oriented human invitation secret. It is
// stored hashed and its plaintext is rendered exactly once, but it is NOT an MCP
// bearer. The newer join-link surface exists separately because it is the
// short-lived, single-use entry point for either a human or an agent. Neither
// invitation table authenticates outside its dedicated redemption route.

async function acceptLegacyWorkspaceInvite({ db, lookupParams, userId }) {
 if (!db || typeof db.begin !== 'function') throw new Error('Invite acceptance requires transaction support');
 const [hashedToken, plaintextToken] = lookupParams;
 return db.begin(async tx => {
  // Claim first, in the database. The status and expiry predicates are on the
  // UPDATE target itself so PostgreSQL re-checks them after any competing row
  // lock is released. A preceding SELECT cannot provide that guarantee.
  const claimedRows = await tx.unsafe(
   `update workspace_invites
          set status = 'accepted', accepted_by = $3, accepted_at = now(), updated_at = now()
        where id = (
          select id
            from workspace_invites
           where token in ($1, $2)
           order by case when token = $1 then 0 else 1 end
           limit 1
        )
          and status = 'pending'
          and (expires_at is null or expires_at >= now())
        returning *`,
   [hashedToken, plaintextToken, userId],
  );

  let invite = claimedRows[0] || null;
  const newlyAccepted = Boolean(invite);
  if (!invite) {
   // READ COMMITTED gives this statement a fresh snapshot after a competing
   // UPDATE completes, so the loser observes who actually consumed the link.
   const existingRows = await tx.unsafe(
    `select *, (expires_at is not null and expires_at < now()) as invite_expired
       from workspace_invites
      where token in ($1, $2)
      order by case when token = $1 then 0 else 1 end
      limit 1`,
    [hashedToken, plaintextToken],
   );
   invite = existingRows[0] || null;
   if (!invite) return { outcome: 'not_found' };
   if (invite.status === 'revoked') return { outcome: 'revoked' };
   if (invite.invite_expired) return { outcome: 'expired' };
   const acceptedBy = String(invite.accepted_by || '');
   if (invite.status !== 'accepted' || !acceptedBy || acceptedBy !== String(userId)) {
    return { outcome: 'used' };
   }
   // Idempotency confirms an acceptance that still exists; it must not become
   // a permanent re-entry credential. If this user was removed after accepting,
   // replaying the old URL cannot recreate their membership.
   const accessRows = await tx.unsafe(
    `select 1 as has_access
       where exists (
        select 1 from workspaces where id = $1 and user_id = $2
       )
          or exists (
           select 1 from workspace_members where workspace_id = $1 and user_id = $2
          )
       limit 1`,
    [invite.workspace_id, userId],
   );
   if (accessRows.length === 0) return { outcome: 'used' };
  }

  const workspaceId = String(invite.workspace_id || '');
  // Existing members keep their current role, matching the old read-then-insert
  // behavior, but the unique constraint now handles concurrent/idempotent calls.
  // Owners deliberately do not receive a duplicate workspace_members row.
  const memberRows = newlyAccepted
   ? await tx.unsafe(
    `insert into workspace_members (workspace_id, user_id, role, invited_by)
        select $1, $2, $3, $4
         where not exists (
          select 1 from workspaces where id = $1 and user_id = $2
         )
        on conflict (workspace_id, user_id) do nothing
        returning *`,
    [workspaceId, userId, invite.role, invite.created_by],
   )
   : [];
  const workspaceRows = await tx.unsafe(
   'select id, name from workspaces where id = $1 limit 1',
   [workspaceId],
  );
  if (!workspaceRows[0]) throw new Error('Invite workspace no longer exists');

  return {
   outcome: 'accepted',
   workspaceId,
   workspace: workspaceRows[0],
   inviteRows: newlyAccepted ? claimedRows : [],
   memberRows,
  };
 });
}

function mountMembersInvitesRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, notifyDbSubscribers,
  hashAgentToken, inviteTokenLookupParams, clientIpFromReq,
  // The audit writer (server/index.cjs recordAudit). Never rejects.
  recordAudit = async () => null,
  // Email DOMAIN only, never the local-part — see the invite call site.
  auditEmailDomain = () => '',
 } = deps;

 app.get('/backend/workspaces/:id/members', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   // LEFT JOIN app_users so a participant is never dropped just because their
   // app_users row is missing (e.g. identity seeded by an auth path that did
   // not write app_users). The owner must ALWAYS appear; email falls back to
   // '' and the client fills the current user's own email from its session.
   const rows = await getDb().unsafe(
    `select * from (
           select w.user_id as user_id, coalesce(u.email, '') as email, 'owner' as role,
                  null::uuid as id, null::uuid as invited_by, w.created_at as created_at
             from workspaces w left join app_users u on u.id = w.user_id
            where w.id = $1
           union all
           select m.user_id, coalesce(u.email, '') as email, m.role, m.id, m.invited_by, m.created_at
             from workspace_members m left join app_users u on u.id = m.user_id
            where m.workspace_id = $1
         ) t order by (role = 'owner') desc, created_at asc`,
    [workspaceId],
   );
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.patch('/backend/workspaces/:id/members/:memberId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const memberId = String(req.params.memberId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   if (!memberId) return jsonError(res, 400, new Error('member id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   if (memberId === 'null' || memberId === 'undefined') return jsonError(res, 404, new Error('Workspace member not found'));
   const allowedRoles = ['admin', 'editor', 'commenter', 'viewer'];
   const role = String(req.body?.role || '').trim();
   if (!allowedRoles.includes(role)) return jsonError(res, 400, new Error('Invalid workspace member role'));
   // The pre-update role comes back from the same statement, not a preceding
   // SELECT: "from editor to admin" is the whole content of the audit row, and a
   // separate read could observe a value this UPDATE did not overwrite.
   const rows = await getDb().unsafe(
    `update workspace_members m set role = $3
          from (select id, role from workspace_members where id = $1 and workspace_id = $2) prev
          where m.id = prev.id
          returning m.*, prev.role as audit_previous_role`,
    [memberId, workspaceId, role],
   );
   if (!rows[0]) return jsonError(res, 404, new Error('Workspace member not found'));
   const previousRole = String(rows[0].audit_previous_role || '');
   // Strip the joined-in audit column before the row reaches realtime or the
   // response; it exists only for the audit line below.
   const publicRows = rows.map(({ audit_previous_role: _prev, ...member }) => member);
   notifyDbSubscribers('workspace_members', 'UPDATE', publicRows);
   // target_id is the MEMBER ROW id, which resolves to the current user record at
   // read time. The member's email is deliberately not recorded: this log has a
   // 400-day horizon and a different erasure path from the user record.
   await recordAudit({
    workspaceId,
    actor: { userId: String(req.userId || '') },
    action: 'member.role_changed',
    target: { type: 'workspace_member', id: memberId },
    before: previousRole,
    after: role,
    detail: { member_user_id: String(publicRows[0].user_id || '') },
    requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
   });
   res.json({ data: publicRows[0], error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/members/:memberId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const memberId = String(req.params.memberId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   if (!memberId) return jsonError(res, 400, new Error('member id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   if (memberId === 'null' || memberId === 'undefined') return res.json({ data: null, error: null });
   const rows = await getDb().unsafe(
    `delete from workspace_members
          where id = $1 and workspace_id = $2
          returning *`,
    [memberId, workspaceId],
   );
   notifyDbSubscribers('workspace_members', 'DELETE', rows);
   // Only when a row actually went. A DELETE that matched nothing is not a
   // removal, and logging it would put phantom removals in front of an owner.
   if (rows[0]) {
    await recordAudit({
     workspaceId,
     actor: { userId: String(req.userId || '') },
     action: 'member.removed',
     target: { type: 'workspace_member', id: memberId },
     before: String(rows[0].role || ''),
     detail: { member_user_id: String(rows[0].user_id || '') },
     requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
    });
   }
   res.json({ data: rows[0] ?? null, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/invites', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   // Returns DISMISSED rows too, on purpose: only 'manage' can read this list,
   // and the client's "Show dismissed" toggle then costs no round trip. The
   // include/exclude rule lives in src/lib/inviteDismissal.ts. `i.*` also means
   // dismissed_at needs no mention here to survive.
   const rows = await getDb().unsafe(
    `select i.*, cu.email as created_by_email, au.email as accepted_by_email
           from workspace_invites i
           left join app_users cu on cu.id = i.created_by
           left join app_users au on au.id = i.accepted_by
          where i.workspace_id = $1
          order by i.created_at desc`,
    [workspaceId],
   );
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/invites', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const allowedRoles = ['admin', 'editor', 'commenter', 'viewer'];
   const role = allowedRoles.includes(req.body?.role) ? req.body.role : 'editor';
   const email = String(req.body?.email || '').trim().toLowerCase();
   // L4: store only the token HASH at rest (like agent/workspace tokens); the
   // plaintext is returned once below for the creator to copy and is never
   // recoverable afterward. Legacy invites created before this still hold a
   // plaintext token and keep working via the dual-path lookup in verify.
   const token = crypto.randomBytes(24).toString('base64url');
   const rows = await getDb().unsafe(
    `insert into workspace_invites (workspace_id, token, email, role, status, created_by, expires_at)
         values ($1, $2, $3, $4, 'pending', $5, now() + interval '14 days')
         returning *`,
    [workspaceId, hashAgentToken(token), email, role, req.userId],
   );
   notifyDbSubscribers('workspace_invites', 'INSERT', rows);
   // NEITHER the token NOR its hash NOR the local-part of the address. An invite
   // token is still a bearer secret for its dedicated human acceptance route, so
   // an audit row carrying it would be strictly more dangerous than the gap this
   // log closes. The DOMAIN is kept because "someone invited an external
   // address" is what an owner actually needs to see; who exactly is already on
   // the invite row this points at.
   await recordAudit({
    workspaceId,
    actor: { userId: String(req.userId || '') },
    action: 'invite.created',
    target: { type: 'workspace_invite', id: String(rows[0].id || '') },
    after: role,
    detail: { email_domain: auditEmailDomain(email), external: Boolean(email) },
    requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
   });
   // Return the plaintext token ONCE (not persisted) so the UI can show the
   // invite link at creation; the stored row only carries the hash.
   res.json({ data: { ...rows[0], token }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/invites/:inviteId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const inviteId = String(req.params.inviteId || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const rows = await getDb().unsafe(
    `update workspace_invites set status = 'revoked', updated_at = now()
          where id = $1 and workspace_id = $2 returning *`,
    [inviteId, workspaceId],
   );
   notifyDbSubscribers('workspace_invites', 'UPDATE', rows);
   if (rows[0]) {
    await recordAudit({
     workspaceId,
     actor: { userId: String(req.userId || '') },
     action: 'invite.revoked',
     target: { type: 'workspace_invite', id: inviteId },
     before: String(rows[0].role || ''),
     requestIp: clientIpFromReq ? clientIpFromReq(req) : '',
    });
   }
   res.json({ data: rows[0] ?? null, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // A link is SPENT when it can no longer let anyone new in: revoked, already
 // accepted, or a still-pending one past its expires_at (there is no 'expired'
 // status column, so expiry has to be derived here as well as in the UI —
 // src/lib/inviteDismissal.ts holds the matching client-side rule).
 //
 // This predicate is the security boundary for dismissal, which is why it lives
 // in the SQL rather than only in the button's disabled state: dismissing an
 // ACTIVE link would leave it granting access while vanishing from the only
 // surface that lists it. Revoke first, then dismiss.
 const SPENT_INVITE_SQL = `(
        status in ('accepted', 'revoked')
        or (status = 'pending' and expires_at is not null and expires_at <= now())
      )`;

 // Soft-dismiss / restore one spent invite. Nothing is deleted — an accepted
 // invite is the audit trail of how a member got into the workspace, so the row
 // (and its accepted_by/accepted_at) always survives being tidied away.
 app.patch('/backend/workspaces/:id/invites/:inviteId', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const inviteId = String(req.params.inviteId || '').trim();
   if (!workspaceId || !inviteId) return jsonError(res, 400, new Error('workspace id and invite id are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const dismissed = req.body?.dismissed;
   if (typeof dismissed !== 'boolean') return jsonError(res, 400, new Error('dismissed must be true or false'));
   const rows = dismissed
    ? await getDb().unsafe(
     `update workspace_invites set dismissed_at = now(), updated_at = now()
            where id = $1 and workspace_id = $2 and dismissed_at is null and ${SPENT_INVITE_SQL}
            returning *`,
     [inviteId, workspaceId],
    )
    : await getDb().unsafe(
     `update workspace_invites set dismissed_at = null, updated_at = now()
            where id = $1 and workspace_id = $2 and dismissed_at is not null
            returning *`,
     [inviteId, workspaceId],
    );
   if (rows.length === 0) {
    // No row changed: either it isn't ours, or a guard refused. Re-read to tell
    // the two apart — a wrong id must not look like a policy failure.
    const existing = await getDb().unsafe(
     'select * from workspace_invites where id = $1 and workspace_id = $2 limit 1',
     [inviteId, workspaceId],
    );
    if (existing.length === 0) return jsonError(res, 404, new Error('Invite not found'));
    // Already in the requested state → idempotent success.
    if (Boolean(existing[0].dismissed_at) === dismissed) return res.json({ data: existing[0], error: null });
    return jsonError(res, 409, new Error('Only a revoked, accepted or expired invite can be dismissed. Revoke it first.'));
   }
   notifyDbSubscribers('workspace_invites', 'UPDATE', rows);
   res.json({ data: rows[0], error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Bulk clear: dismiss every spent link in one go. Same predicate, so an active
 // link is skipped rather than hidden, however many rows the caller sweeps.
 app.post('/backend/workspaces/:id/invites/dismiss-spent', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const rows = await getDb().unsafe(
    `update workspace_invites set dismissed_at = now(), updated_at = now()
          where workspace_id = $1 and dismissed_at is null and ${SPENT_INVITE_SQL}
          returning *`,
    [workspaceId],
   );
   notifyDbSubscribers('workspace_invites', 'UPDATE', rows);
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/invites/:token', requireAuth, async (req, res) => {
  try {
   const token = String(req.params.token || '').trim();
   const rows = await getDb().unsafe(
    `select i.id, i.role, i.status, i.expires_at, i.workspace_id,
                w.name as workspace_name, cu.email as inviter_email
           from workspace_invites i
           join workspaces w on w.id = i.workspace_id
           left join app_users cu on cu.id = i.created_by
          where i.token in ($1, $2) limit 1`,
    inviteTokenLookupParams(token),
   );
   const invite = rows[0];
   if (!invite) return jsonError(res, 404, new Error('Invite not found'));
   const expired = invite.expires_at && new Date(invite.expires_at) < new Date();
   res.json({ data: { ...invite, expired: !!expired, valid: invite.status === 'pending' && !expired }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/invites/:token/accept', requireAuth, async (req, res) => {
  try {
   const token = String(req.params.token || '').trim();
   const result = await acceptLegacyWorkspaceInvite({
    db: getDb(),
    lookupParams: inviteTokenLookupParams(token),
    userId: req.userId,
   });
   if (result.outcome === 'not_found') return jsonError(res, 404, new Error('Invite not found'));
   if (result.outcome === 'revoked') return jsonError(res, 410, new Error('This invite has been revoked'));
   if (result.outcome === 'expired') return jsonError(res, 410, new Error('This invite has expired'));
   if (result.outcome === 'used') return jsonError(res, 410, new Error('This invite has already been used'));

   // Emit only after COMMIT. A rolled-back claim or membership insert must not
   // create a realtime event for state that never became durable.
   if (result.memberRows.length > 0) notifyDbSubscribers('workspace_members', 'INSERT', result.memberRows);
   if (result.inviteRows.length > 0) notifyDbSubscribers('workspace_invites', 'UPDATE', result.inviteRows);
   res.json({
    data: { workspaceId: result.workspaceId, workspace: result.workspace },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountMembersInvitesRoutes, acceptLegacyWorkspaceInvite };
