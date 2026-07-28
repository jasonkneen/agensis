'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Sign-up, sign-in, sign-out, the account routes, and the email lookup RPC.
//
// Rate limiting here is per-EMAIL and per-IP at once, which is the point: a
// per-IP limit alone lets a botnet spray one account, and a per-email limit
// alone lets one host walk the whole user table. signinRateLimiter is keyed on
// the email the caller claims; signinIpFailureLimiter counts that caller's
// failures whatever email they name.
//
// Sign-out bumps the account's token_version and clears the cached copy, which
// is what makes an issued token stop verifying everywhere at once — including on
// the Netlify lane, which reads the same column.

function mountAuthRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, rateLimitBlocked,
  clientIpFromReq, createPasswordHash, emailLookupRateLimiter,
  evaluatePasswordServerSide, isReservedSignupEmail, issueToken,
  setCachedTokenVersion, signinIpFailureLimiter, signinRateLimiter,
  signupRateLimiter, verifyPassword,
 } = deps;

 app.post('/backend/auth/signup', async (req, res) => {
  try {
   if (rateLimitBlocked(res, signupRateLimiter, clientIpFromReq(req))) return;
   const email = String(req.body?.email || '').trim().toLowerCase();
   const password = String(req.body?.password || '');
   if (!email || !password) return jsonError(res, 400, new Error('Email and password are required'));
   const passwordPolicy = evaluatePasswordServerSide(password);
   if (!passwordPolicy.valid) return jsonError(res, 400, new Error(passwordPolicy.message || 'Password must be at least 10 characters and include 3 of: lowercase, uppercase, number, symbol.'));

   // The configured system owner's address cannot be claimed through public
   // signup: Tenants-surface authority derives from the stored email, and
   // signup never verifies mailbox ownership (shared/tenant-admin.cjs has the
   // full story). Same status and message as the duplicate-account refusal
   // below, on purpose — this response must not mark the address as special.
   if (isReservedSignupEmail(email)) return jsonError(res, 409, new Error('An account with that email already exists'));

   const existing = await getDb().unsafe('select id from app_users where email = $1 limit 1', [email]);
   if (existing.length > 0) return jsonError(res, 409, new Error('An account with that email already exists'));

   const rows = await getDb().unsafe(
    'insert into app_users (email, password_hash) values ($1, $2) returning id, email, display_name, accent_color, created_at, token_version',
    [email, await createPasswordHash(password)],
   );

   const row = rows[0];
   const user = { id: row.id, email: row.email, display_name: row.display_name, accent_color: row.accent_color, created_at: row.created_at };
   res.json({ data: { user, token: await issueToken(user.id, row.token_version) }, error: null });
  } catch (error) {
   jsonError(res, 500, error);
  }
 });

 app.post('/backend/auth/signin', async (req, res) => {
  try {
   const email = String(req.body?.email || '').trim().toLowerCase();
   const password = String(req.body?.password || '');
   if (!email || !password) return jsonError(res, 400, new Error('Email and password are required'));

   const rows = await getDb().unsafe('select id, email, password_hash, display_name, accent_color, created_at, token_version from app_users where email = $1 limit 1', [email]);
   const user = rows[0];
   const passwordOk = user && (await verifyPassword(password, user.password_hash));

   // L3 (2026-07 review): only FAILED attempts count toward the limiters, and
   // a correct password is never blocked — so a guessing script can't lock a
   // victim out by exhausting their email's budget with wrong passwords. The
   // per-email limiter still slows targeted brute force (5/min), and a
   // per-IP failure limiter bounds credential stuffing across many emails.
   if (!passwordOk) {
    const emailAllowed = signinRateLimiter.check(`signin:${email}`).allowed;
    const ipAllowed = signinIpFailureLimiter.check(`signin-ip:${clientIpFromReq(req)}`).allowed;
    if (!emailAllowed || !ipAllowed) {
     res.setHeader('Retry-After', '60');
     return jsonError(res, 429, new Error('Too many failed sign-in attempts. Please wait a minute and try again.'));
    }
    return jsonError(res, 401, new Error('Invalid email or password'));
   }

   res.json({
    data: {
     user: { id: user.id, email: user.email, display_name: user.display_name, accent_color: user.accent_color, created_at: user.created_at },
     token: await issueToken(user.id, user.token_version),
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, 500, error);
  }
 });

 // F9: any authed user could otherwise map an arbitrary email -> user id (an
 // enumeration oracle). This RPC is only meaningfully used while inviting, so
 // gate it behind a rate limit AND require 'manage' on the workspace the
 // caller is inviting into (the "invite existing user" flow already knows
 // its workspace id — see src/hooks/useSharing.ts's inviteByEmail).
 app.post('/backend/rpc/lookup_user_by_email', requireAuth, async (req, res) => {
  try {
   if (rateLimitBlocked(res, emailLookupRateLimiter, req.userId)) return;
   const workspaceId = String(req.body?.workspace_id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace_id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const lookupEmail = String(req.body?.lookup_email || '').trim().toLowerCase();
   const rows = await getDb().unsafe('select id, email from app_users where email = $1 limit 1', [lookupEmail]);
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // ── Account profile (display name, accent color, password) ──────────────

 app.get('/backend/users/me', requireAuth, async (req, res) => {
  try {
   const rows = await getDb().unsafe(
    'select id, email, display_name, accent_color, created_at from app_users where id = $1 limit 1',
    [req.userId],
   );
   if (!rows[0]) return jsonError(res, 404, new Error('User not found'));
   res.json({ data: rows[0], error: null });
  } catch (error) {
   jsonError(res, 500, error);
  }
 });

 app.patch('/backend/users/me', requireAuth, async (req, res) => {
  try {
   const updates = {};
   if (req.body?.display_name !== undefined) {
    updates.display_name = String(req.body.display_name || '').trim().slice(0, 80);
   }
   if (req.body?.accent_color !== undefined) {
    const color = String(req.body.accent_color || '').trim();
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
     return jsonError(res, 400, new Error('accent_color must be a #rrggbb hex value'));
    }
    updates.accent_color = color;
   }
   const fields = Object.keys(updates);
   if (fields.length === 0) return jsonError(res, 400, new Error('No fields to update'));

   const setClause = fields.map((field, i) => `${field} = $${i + 2}`).join(', ');
   const rows = await getDb().unsafe(
    `update app_users set ${setClause} where id = $1 returning id, email, display_name, accent_color, created_at`,
    [req.userId, ...fields.map(field => updates[field])],
   );
   if (!rows[0]) return jsonError(res, 404, new Error('User not found'));
   res.json({ data: rows[0], error: null });
  } catch (error) {
   jsonError(res, 500, error);
  }
 });

 app.post('/backend/users/me/change-password', requireAuth, async (req, res) => {
  try {
   const currentPassword = String(req.body?.currentPassword || '');
   const newPassword = String(req.body?.newPassword || '');
   if (!currentPassword || !newPassword) return jsonError(res, 400, new Error('Current and new password are required'));
   const newPasswordPolicy = evaluatePasswordServerSide(newPassword);
   if (!newPasswordPolicy.valid) return jsonError(res, 400, new Error(newPasswordPolicy.message || 'Password must be at least 10 characters and include 3 of: lowercase, uppercase, number, symbol.'));

   const rows = await getDb().unsafe('select id, password_hash from app_users where id = $1 limit 1', [req.userId]);
   const user = rows[0];
   if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    return jsonError(res, 401, new Error('Current password is incorrect'));
   }

   // Bumping token_version invalidates EVERY outstanding token for this user,
   // including the one used to make this very request — a leaked/stolen token
   // is dead the moment the real owner changes their password. Issue a fresh
   // token below so the caller's own session survives without a forced
   // re-login; a stolen token has no way to learn the new version.
   const updated = await getDb().unsafe(
    'update app_users set password_hash = $2, token_version = token_version + 1 where id = $1 returning token_version',
    [req.userId, await createPasswordHash(newPassword)],
   );
   const newVersion = updated[0]?.token_version;
   setCachedTokenVersion(req.userId, newVersion);
   const token = await issueToken(req.userId, newVersion);
   res.json({ data: { ok: true, token }, error: null });
  } catch (error) {
   jsonError(res, 500, error);
  }
 });

 // Real server-side sign-out: bumps token_version so the calling token (and
 // every other outstanding token for this user) is rejected by verifyToken on
 // its next use. Previously "sign out" was purely client-side (localStorage
 // clear), which never revoked anything — a captured token stayed valid forever.
 app.post('/backend/auth/signout', requireAuth, async (req, res) => {
  try {
   const updated = await getDb().unsafe(
    'update app_users set token_version = token_version + 1 where id = $1 returning token_version',
    [req.userId],
   );
   if (updated[0]) setCachedTokenVersion(req.userId, updated[0].token_version);
   res.json({ data: { ok: true }, error: null });
  } catch (error) {
   jsonError(res, 500, error);
  }
 });

 // ── Workspace members (with emails) + invite links ───────────────────────
}

module.exports = { mountAuthRoutes };
