// ============================================================================
// shared/tenant-admin.cjs
// ----------------------------------------------------------------------------
// The system-owner gate, and the read-only queries behind /backend/tenants.
//
// This module backs the ONE surface in the product that reads across tenant
// boundaries: a list of every registered account and, per account, the
// workspaces it owns and belongs to. Everything else in this codebase is scoped
// by workspace membership; this is not. That makes the gate below the whole
// feature, and the reason the queries live here rather than in either backend:
//
//   * ONE check. `assertSystemOwner` is the only thing that may authorize a
//     tenant route, and both backends call it. Two copies of an admin check
//     drift, and the copy that drifts is the one nobody is looking at.
//
//   * The caller's email is NEVER read from the request. It is resolved from
//     the authenticated `userId` against app_users. An email in a body, a query
//     string or a header is an attacker-supplied string, and comparing one of
//     those to the owner address would make the gate a formality.
//
//   * FAIL CLOSED. No configured owner, no such user, a DB error, a blank
//     address — every one of those is a refusal. `ensureSystemWorkspace` in
//     backend-core falls back to "the oldest account" when
//     AGENSIS_SYSTEM_OWNER_EMAIL is unset; that is a fine default for deciding
//     who owns an auto-created workspace and a catastrophic one for deciding
//     who may read every account on the deployment. There is deliberately no
//     fallback here.
//
//   * The projection is an allow-list, not a `select *`. app_users holds
//     `password_hash` and `token_version`; the column list comes from
//     backend-core's SELECTABLE_COLUMNS_BY_TABLE via `safeSelectColumns`, the
//     same allow-list the generic /backend/db/select route is held to, so a
//     sensitive column added to that table is excluded here by default rather
//     than by somebody remembering.
//
// Hiding the Tenants button from other users is cosmetic. This file is the
// control.
// ============================================================================

const { safeSelectColumns, httpError, unauthorized, forbidden } = require('./backend-core.cjs');

/** The env var naming the one account allowed to read this surface. */
const SYSTEM_OWNER_EMAIL_ENV = 'AGENSIS_SYSTEM_OWNER_EMAIL';

/**
 * How many accounts one list request may return. The surface is an operator's
 * list, not a paginated report; the cap exists so a deployment that grows to
 * tens of thousands of accounts degrades into "showing the first 500" instead
 * of a multi-megabyte response. `listTenantAccounts` also returns the true
 * total, so the UI can say which it is.
 */
const TENANT_LIST_LIMIT = 500;

/**
 * Normalize an email for comparison: trim, lowercase ASCII A-Z and nothing
 * else.
 *
 * Deliberately `typeof === 'string'` rather than `String(value)`. A JSON body
 * can carry `['owner@example.com']` or `{ toString() {...} }`, and String()
 * would happily turn the first into the owner's address. Nothing but a real
 * string is an email here.
 *
 * Also deliberately NOT clever: no plus-address stripping, no dot-folding, no
 * unicode confusable folding. Every one of those makes MORE addresses equal to
 * the owner's, and this comparison must only ever make one. That is also why
 * the case fold is ASCII-only rather than `toLowerCase()`: full Unicode
 * lowercasing folds U+212A (the Kelvin sign) to `k` and friends, quietly
 * making visually-distinct addresses equal to an ASCII owner address. A
 * configured owner address containing non-ASCII letters therefore matches
 * nothing — signup stores addresses ASCII-lowercased, so such a
 * configuration fails closed instead of approximately.
 */
function normalizeOwnerEmail(value) {
 if (typeof value !== 'string') return '';
 return value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * PURE: is `callerEmail` the configured system owner?
 *
 * Both sides are normalized and compared for exact equality, so
 * "  Jason@Bouncingfish.com " is the owner and every near miss is not:
 * `jason@bouncingfish.com.evil.test`, `jason+admin@bouncingfish.com`,
 * `jason@bouncingfish.co` and `ason@bouncingfish.com` all fail.
 *
 * An empty/absent configured address returns false for EVERY caller — an
 * unconfigured deployment has no owner, not an owner of everyone.
 */
function isSystemOwnerEmail(callerEmail, configuredOwnerEmail) {
 const configured = normalizeOwnerEmail(configuredOwnerEmail);
 if (!configured) return false;
 const caller = normalizeOwnerEmail(callerEmail);
 if (!caller) return false;
 return caller === configured;
}

/** The configured owner address, normalized. '' when unset — see fail-closed above. */
function configuredSystemOwnerEmail(env = process.env) {
 return normalizeOwnerEmail(env?.[SYSTEM_OWNER_EMAIL_ENV]);
}

/**
 * PURE: must ordinary signup refuse to CREATE an account with `email`?
 *
 * Authority on this surface derives from the email stored on the caller's
 * app_users row, and no signup door verifies mailbox ownership. On a
 * deployment where the configured owner has not registered yet, the first
 * stranger to sign up with that address would therefore BECOME the system
 * owner of every tenant. So the address is reserved: both password-signup
 * doors and the OAuth account-creation door refuse it.
 *
 * Creation only. An owner account that already exists signs in exactly as
 * before — nothing here runs against an existing row. And it is the same
 * normalization and comparison as `isSystemOwnerEmail`, in the same file, so
 * the reservation and the gate can never disagree about which address is
 * special. With the env var unset this reserves NOTHING: an unconfigured
 * deployment behaves exactly as it did before this check existed.
 */
function isReservedSignupEmail(email, env = process.env) {
 return isSystemOwnerEmail(email, env?.[SYSTEM_OWNER_EMAIL_ENV]);
}

/**
 * Resolve whether the AUTHENTICATED user is the system owner.
 *
 * `userId` must come from the verified session token (req.userId /
 * requireUserId), never from the request body. The email is then read from the
 * database, so the only way to satisfy this check is to hold a valid session
 * for the account whose stored email matches the configured one.
 */
async function isSystemOwnerUser({ userId, db, env = process.env }) {
 const configured = configuredSystemOwnerEmail(env);
 if (!configured) return false;
 const id = typeof userId === 'string' ? userId.trim() : '';
 if (!id) return false;
 if (typeof db !== 'function') throw httpError(500, 'Owner check requires a db function');
 const rows = await db('select email from app_users where id = $1 limit 1', [id]);
 return isSystemOwnerEmail(rows?.[0]?.email, configured);
}

/**
 * The gate. Throws 401 without a session and 403 for everybody who is not the
 * owner — including when nothing is configured. Every tenant route on both
 * backends calls exactly this.
 *
 * The 403 message says nothing about who the owner is or whether one exists;
 * an admin surface should not be an oracle for the operator's address.
 */
async function assertSystemOwner({ userId, db, env = process.env }) {
 const id = typeof userId === 'string' ? userId.trim() : '';
 if (!id) throw unauthorized();
 if (!(await isSystemOwnerUser({ userId: id, db, env }))) {
  throw forbidden('Not available');
 }
 return id;
}

/**
 * The app_users columns a tenant response may carry, prefixed with a table
 * alias. Sourced from backend-core's SELECTABLE_COLUMNS_BY_TABLE (via
 * safeSelectColumns) so this surface and /backend/db/select cannot disagree
 * about what is safe to hand a browser: id, email, display_name, accent_color,
 * created_at — never password_hash, never token_version.
 */
function tenantUserColumns(alias) {
 return safeSelectColumns('app_users', '*')
  .split(',')
  .map((column) => `${alias}.${column.trim()}`)
  .join(', ');
}

/** Postgres counts arrive as bigint strings on both drivers. */
function countValue(value) {
 const parsed = Number(value);
 return Number.isFinite(parsed) ? parsed : 0;
}

function shapeTenantAccount(row) {
 return {
  id: row.id,
  email: row.email || '',
  display_name: row.display_name || '',
  accent_color: row.accent_color || '',
  created_at: row.created_at || null,
  owned_workspace_count: countValue(row.owned_workspace_count),
  membership_count: countValue(row.membership_count),
 };
}

function shapeTenantWorkspace(row) {
 return {
  id: row.id,
  name: row.name || '',
  icon: row.icon || '',
  is_system: row.is_system === true,
  parent_id: row.parent_id || null,
  created_at: row.created_at || null,
  updated_at: row.updated_at || null,
  member_count: countValue(row.member_count),
  agent_count: countValue(row.agent_count),
 };
}

/**
 * Every registered account, oldest first, with the two numbers that say how
 * much of the deployment it accounts for. Returns the true total alongside, so
 * a capped list can be labelled as one instead of quietly under-reporting.
 *
 * No filesystem columns (workspaces.local_path / git_root / git_remote), no
 * secrets, no tokens — a tenant list is "who is here and how big are they",
 * and anything past that is somebody's private data being read by an operator
 * who did not need it.
 */
async function listTenantAccounts(db, { limit = TENANT_LIST_LIMIT } = {}) {
 const capped = Math.max(1, Math.min(TENANT_LIST_LIMIT, Number(limit) || TENANT_LIST_LIMIT));
 const rows = await db(
  `select ${tenantUserColumns('u')},
          (select count(*) from workspaces w where w.user_id = u.id) as owned_workspace_count,
          (select count(*) from workspace_members m where m.user_id = u.id) as membership_count
     from app_users u
    order by u.created_at asc nulls last, u.id asc
    limit $1`,
  [capped],
 );
 const totals = await db('select count(*) as total from app_users', []);
 const total = countValue(totals?.[0]?.total);
 const accounts = (rows || []).map(shapeTenantAccount);
 return { accounts, total, truncated: total > accounts.length };
}

/**
 * One account, plus the workspaces it OWNS and the ones it merely belongs to.
 * Returns null when there is no such account, so the route can answer 404
 * rather than an empty object that reads like a permissions bug.
 */
async function getTenantAccount(db, accountId) {
 const id = typeof accountId === 'string' ? accountId.trim() : '';
 if (!id) throw httpError(400, 'An account id is required');

 const rows = await db(
  `select ${tenantUserColumns('u')},
          (select count(*) from workspaces w where w.user_id = u.id) as owned_workspace_count,
          (select count(*) from workspace_members m where m.user_id = u.id) as membership_count
     from app_users u
    where u.id = $1
    limit 1`,
  [id],
 );
 if (!rows?.[0]) return null;

 const owned = await db(
  `select w.id, w.name, w.icon, w.is_system, w.parent_id, w.created_at, w.updated_at,
          (select count(*) from workspace_members m where m.workspace_id = w.id) as member_count,
          (select count(*) from workspace_agents a where a.workspace_id = w.id) as agent_count
     from workspaces w
    where w.user_id = $1
    order by w.created_at asc nulls last, w.id asc`,
  [id],
 );

 // Workspaces this account was invited into. Excludes the ones it owns, which
 // are already above — an owner is usually also a member row, and listing a
 // workspace twice makes an account look twice as large as it is.
 const memberOf = await db(
  `select w.id, w.name, w.icon, w.is_system, w.parent_id, w.created_at, w.updated_at,
          m.role as role,
          owner.email as owner_email,
          (select count(*) from workspace_members m2 where m2.workspace_id = w.id) as member_count,
          (select count(*) from workspace_agents a where a.workspace_id = w.id) as agent_count
     from workspace_members m
     join workspaces w on w.id = m.workspace_id
     left join app_users owner on owner.id = w.user_id
    where m.user_id = $1
      and (w.user_id is null or w.user_id <> $1)
    order by w.created_at asc nulls last, w.id asc`,
  [id],
 );

 return {
  account: shapeTenantAccount(rows[0]),
  owned_workspaces: (owned || []).map(shapeTenantWorkspace),
  member_workspaces: (memberOf || []).map((row) => ({
   ...shapeTenantWorkspace(row),
   role: row.role || '',
   owner_email: row.owner_email || '',
  })),
 };
}

module.exports = {
 SYSTEM_OWNER_EMAIL_ENV,
 TENANT_LIST_LIMIT,
 normalizeOwnerEmail,
 isSystemOwnerEmail,
 configuredSystemOwnerEmail,
 isReservedSignupEmail,
 isSystemOwnerUser,
 assertSystemOwner,
 tenantUserColumns,
 shapeTenantAccount,
 shapeTenantWorkspace,
 listTenantAccounts,
 getTenantAccount,
};
