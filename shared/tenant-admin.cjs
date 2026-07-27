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
const { summarizeUsage, RATES_AS_OF } = require('./usage-rates.cjs');

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

// ===========================================================================
// PER-WORKSPACE ACTIVITY, IN ONE QUERY
// ---------------------------------------------------------------------------
// What a tenant is USING: channels, DMs, threads, messages (split by who wrote
// them), huddles and the time spent in them, agents, live daemons, documents,
// members, and when anything last happened.
//
// COST, AND WHY IT IS SHAPED THIS WAY. The naive version of this feature is a
// handful of scalar sub-selects hanging off the account list — which is one
// query per account per statistic, i.e. N x 10 round trips for a list that is
// every account on the deployment. This is instead ONE query whose result is
// one row PER WORKSPACE, aggregated in Postgres and rolled up per account in
// JavaScript (`rollUpAccountStats`, pure and unit-tested).
//
// The cost is therefore fixed in ROUND TRIPS (one) and linear in ROWS SCANNED:
// each CTE is a single grouped pass over its table, and Postgres will hash-
// aggregate them. The expensive one is `msg` — a full scan of `messages` joined
// to `chat_sessions` — which is milliseconds on a deployment of this size and
// would want a materialized rollup somewhere north of a few million messages.
// Nothing here degrades with the number of ACCOUNTS, which is the axis that was
// going to hurt.
//
// Every CTE groups by workspace_id and is LEFT JOINed, so a workspace with no
// messages/huddles/agents produces a row of zeroes rather than vanishing.
// ===========================================================================

/**
 * chat_sessions is one table holding three different things, told apart by the
 * same conventions the sidebar uses:
 *   * a THREAD has a parent_message_id
 *   * a DM lives in the 'Direct messages' folder
 *   * a HUDDLE TRANSCRIPT lives in the 'huddle' folder (created per call — it
 *     is not a channel anybody opened, and counting it as one would make every
 *     voice call look like a new project)
 *   * everything else is a channel
 * Soft-deleted rows (deleted_at) are excluded from all four.
 */
const WORKSPACE_STATS_SQL = `
  with ws as (
    select id as workspace_id, user_id from workspaces
  ),
  sess as (
    select workspace_id,
           count(*) filter (
             where parent_message_id is null
               and coalesce(folder, '') not in ('Direct messages', 'huddle')
           ) as channel_count,
           count(*) filter (where parent_message_id is null and folder = 'Direct messages') as dm_count,
           count(*) filter (where parent_message_id is not null) as thread_count,
           max(updated_at) as last_session_at
      from chat_sessions
     where deleted_at is null
     group by workspace_id
  ),
  -- Deliberately NOT filtered by chat_sessions.deleted_at, unlike sess above.
  -- A channel count is CURRENT STATE ("how many channels does this tenant
  -- have"), so a deleted one is gone; a message count is HISTORY ("how much
  -- has this tenant done", and on the agent side, paid for), and deleting the
  -- channel afterwards does not un-send the messages or refund the tokens.
  msg as (
    select s.workspace_id,
           count(*) as message_count,
           count(*) filter (where m.sender_kind = 'agent') as agent_message_count,
           count(*) filter (where coalesce(m.sender_kind, '') <> 'agent') as human_message_count,
           max(m.created_at) as last_message_at
      from messages m
      join chat_sessions s on s.id = m.session_id
     group by s.workspace_id
  ),
  hud as (
    select workspace_id,
           count(*) as huddle_count,
           count(*) filter (where ended_at is null) as live_huddle_count,
           coalesce(sum(
             greatest(0, extract(epoch from (coalesce(ended_at, now()) - started_at)))
           ), 0)::bigint as huddle_seconds
      from huddles
     group by workspace_id
  ),
  ag as (
    select workspace_id, count(*) as agent_count from workspace_agents group by workspace_id
  ),
  conn as (
    select workspace_id,
           count(*) filter (where status <> 'offline') as live_daemon_count,
           max(last_seen_at) as last_daemon_seen_at
      from agent_connections
     group by workspace_id
  ),
  doc as (
    select workspace_id, count(*) as document_count, max(updated_at) as last_document_at
      from documents group by workspace_id
  ),
  mem as (
    select workspace_id, count(*) as member_count from workspace_members group by workspace_id
  )
  select ws.workspace_id,
         ws.user_id,
         coalesce(sess.channel_count, 0)        as channel_count,
         coalesce(sess.dm_count, 0)             as dm_count,
         coalesce(sess.thread_count, 0)         as thread_count,
         coalesce(msg.message_count, 0)         as message_count,
         coalesce(msg.agent_message_count, 0)   as agent_message_count,
         coalesce(msg.human_message_count, 0)   as human_message_count,
         coalesce(hud.huddle_count, 0)          as huddle_count,
         coalesce(hud.live_huddle_count, 0)     as live_huddle_count,
         coalesce(hud.huddle_seconds, 0)        as huddle_seconds,
         coalesce(ag.agent_count, 0)            as agent_count,
         coalesce(conn.live_daemon_count, 0)    as live_daemon_count,
         coalesce(doc.document_count, 0)        as document_count,
         coalesce(mem.member_count, 0)          as member_count,
         greatest(
           coalesce(msg.last_message_at, to_timestamp(0)),
           coalesce(sess.last_session_at, to_timestamp(0)),
           coalesce(doc.last_document_at, to_timestamp(0)),
           coalesce(conn.last_daemon_seen_at, to_timestamp(0))
         ) as last_activity_at
    from ws
    left join sess on sess.workspace_id = ws.workspace_id
    left join msg  on msg.workspace_id  = ws.workspace_id
    left join hud  on hud.workspace_id  = ws.workspace_id
    left join ag   on ag.workspace_id   = ws.workspace_id
    left join conn on conn.workspace_id = ws.workspace_id
    left join doc  on doc.workspace_id  = ws.workspace_id
    left join mem  on mem.workspace_id  = ws.workspace_id`;

/**
 * Recorded usage, grouped per workspace AND per (provider, resource).
 *
 * Split from the counts above rather than folded into it because pricing needs
 * the MODEL: a workspace's token total is unpriceable once Opus and Haiku have
 * been summed together. Cardinality is workspaces x models, which is small.
 *
 * Rows whose workspace was deleted survive with a null workspace_id (the FK is
 * ON DELETE SET NULL — a cost ledger should not lose money when a workspace
 * goes away) and are excluded here, where the question is per-workspace.
 */
const WORKSPACE_USAGE_SQL = `
  select workspace_id,
         provider,
         resource,
         count(*)                       as calls,
         sum(input_units)::bigint       as input_units,
         sum(output_units)::bigint      as output_units,
         sum(cache_write_units)::bigint as cache_write_units,
         sum(cache_read_units)::bigint  as cache_read_units,
         min(created_at)                as first_at,
         max(created_at)                as last_at
    from usage_events
   where workspace_id is not null
   group by workspace_id, provider, resource`;

/** The zero row. Every field a stats consumer may read, so nothing is undefined. */
function emptyWorkspaceStats() {
 return {
  channel_count: 0,
  dm_count: 0,
  thread_count: 0,
  message_count: 0,
  agent_message_count: 0,
  human_message_count: 0,
  huddle_count: 0,
  live_huddle_count: 0,
  huddle_seconds: 0,
  agent_count: 0,
  live_daemon_count: 0,
  document_count: 0,
  member_count: 0,
  last_activity_at: null,
 };
}

/** Postgres hands back `1970-01-01T00:00:00Z` from the greatest()/to_timestamp(0) floor. Read it as "never". */
function activityTimestamp(value) {
 if (!value) return null;
 const iso = value instanceof Date ? value.toISOString() : String(value);
 const parsed = Date.parse(iso);
 if (!Number.isFinite(parsed) || parsed <= 0) return null;
 return new Date(parsed).toISOString();
}

function shapeWorkspaceStats(row) {
 const base = emptyWorkspaceStats();
 for (const key of Object.keys(base)) {
  if (key === 'last_activity_at') continue;
  base[key] = countValue(row?.[key]);
 }
 base.last_activity_at = activityTimestamp(row?.last_activity_at);
 return base;
}

/** The later of two ISO timestamps, either of which may be null. */
function laterTimestamp(left, right) {
 if (!left) return right || null;
 if (!right) return left;
 return Date.parse(left) >= Date.parse(right) ? left : right;
}

/**
 * PURE: per-workspace rows -> one rollup per OWNING account.
 *
 * Rolled up by `workspaces.user_id` — the account that owns the workspace, and
 * so the one whose activity it is. A workspace someone was merely invited into
 * is counted against its OWNER, not against every member; counting it against
 * everyone would make the deployment look several times busier than it is and
 * would double-bill the same tokens across accounts on the cost line.
 *
 * Ownerless workspaces (user_id null) are dropped: they belong to no account,
 * so they cannot appear under one.
 */
function rollUpAccountStats(workspaceRows, usageRows = []) {
 const usageByWorkspace = new Map();
 for (const row of Array.isArray(usageRows) ? usageRows : []) {
  const id = String(row?.workspace_id || '');
  if (!id) continue;
  if (!usageByWorkspace.has(id)) usageByWorkspace.set(id, []);
  usageByWorkspace.get(id).push(row);
 }

 const byAccount = new Map();
 for (const row of Array.isArray(workspaceRows) ? workspaceRows : []) {
  const accountId = String(row?.user_id || '');
  if (!accountId) continue;
  const stats = shapeWorkspaceStats(row);
  const bucket = byAccount.get(accountId) || { ...emptyWorkspaceStats(), workspace_count: 0, usage_rows: [] };
  for (const key of Object.keys(stats)) {
   if (key === 'last_activity_at') continue;
   bucket[key] += stats[key];
  }
  bucket.last_activity_at = laterTimestamp(bucket.last_activity_at, stats.last_activity_at);
  bucket.workspace_count += 1;
  const workspaceUsage = usageByWorkspace.get(String(row?.workspace_id || ''));
  if (workspaceUsage) bucket.usage_rows.push(...workspaceUsage);
  byAccount.set(accountId, bucket);
 }

 const out = new Map();
 for (const [accountId, bucket] of byAccount) {
  const { usage_rows: usageForAccount, ...counts } = bucket;
  out.set(accountId, { ...counts, usage: summarizeUsage(usageForAccount) });
 }
 return out;
}

/**
 * When metering began — the honest floor under every cost figure on this
 * surface.
 *
 * There is NO historical usage data. Metering did not exist before the deploy
 * that created `usage_events`, so a total shown without this date reads as
 * "what this tenant has ever cost", which would be false and unfixable. The
 * stamp is written once by the schema bootstrap; the earliest recorded event is
 * the fallback for a database whose bootstrap has not run (a Netlify-only lane
 * before `fly deploy`). Null means metering has not started at all, and the UI
 * says exactly that rather than rendering $0.00.
 */
async function getMeteringWindow(db) {
 try {
  const rows = await db(
   `select
      (select value from app_settings where key = 'usage.metering_started_at' limit 1) as configured_start,
      (select min(created_at) from usage_events) as first_event_at,
      (select max(created_at) from usage_events) as last_event_at`,
   [],
  );
  const row = rows?.[0] || {};
  const configured = activityTimestamp(row.configured_start);
  const firstEvent = activityTimestamp(row.first_event_at);
  return {
   started_at: configured || firstEvent || null,
   first_event_at: firstEvent,
   last_event_at: activityTimestamp(row.last_event_at),
   rates_as_of: RATES_AS_OF,
  };
 } catch {
  // The table does not exist yet (schema bootstrap has not run on this DB).
  // "Metering has not started" is the truthful answer, and it is not an error.
  return { started_at: null, first_event_at: null, last_event_at: null, rates_as_of: RATES_AS_OF };
 }
}

/** Usage may be queried before the table exists. An empty ledger, not a 500. */
async function safeUsageRows(db, sql, params) {
 try {
  return (await db(sql, params)) || [];
 } catch {
  return [];
 }
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

 // FIVE queries for the whole list, whatever its length: accounts, the true
 // total, one grouped pass for activity, one for usage, one for the metering
 // window. Nothing here is per-row.
 const workspaceStats = await db(WORKSPACE_STATS_SQL, []);
 const usageRows = await safeUsageRows(db, WORKSPACE_USAGE_SQL, []);
 const metering = await getMeteringWindow(db);
 const statsByAccount = rollUpAccountStats(workspaceStats, usageRows);

 const accounts = (rows || []).map((row) => {
  const account = shapeTenantAccount(row);
  // An account with no workspaces still gets a full zero-filled stats block —
  // a missing `stats` would make every consumer write the same defensive
  // fallback, and one of them would eventually get it wrong.
  account.stats = statsByAccount.get(String(account.id)) || {
   ...emptyWorkspaceStats(),
   workspace_count: 0,
   usage: summarizeUsage([]),
  };
  return account;
 });

 return { accounts, total, truncated: total > accounts.length, metering };
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

 // The same two aggregate queries the list uses, narrowed to this account's
 // OWNED workspaces. Same SQL, same shaping, so a number in the pane can never
 // disagree with the number on the row it was opened from.
 const workspaceStats = await db(`${WORKSPACE_STATS_SQL}\n   where ws.user_id = $1`, [id]);
 const usageRows = await safeUsageRows(
  db,
  `select u.workspace_id, u.provider, u.resource,
          count(*) as calls,
          sum(u.input_units)::bigint as input_units,
          sum(u.output_units)::bigint as output_units,
          sum(u.cache_write_units)::bigint as cache_write_units,
          sum(u.cache_read_units)::bigint as cache_read_units,
          min(u.created_at) as first_at,
          max(u.created_at) as last_at
     from usage_events u
     join workspaces w on w.id = u.workspace_id
    where w.user_id = $1
    group by u.workspace_id, u.provider, u.resource`,
  [id],
 );
 const metering = await getMeteringWindow(db);

 const statsByWorkspace = new Map();
 for (const row of workspaceStats || []) {
  statsByWorkspace.set(String(row.workspace_id), shapeWorkspaceStats(row));
 }
 const usageByWorkspace = new Map();
 for (const row of usageRows) {
  const key = String(row.workspace_id || '');
  if (!usageByWorkspace.has(key)) usageByWorkspace.set(key, []);
  usageByWorkspace.get(key).push(row);
 }

 const account = shapeTenantAccount(rows[0]);
 const accountStats = rollUpAccountStats(workspaceStats, usageRows).get(id) || {
  ...emptyWorkspaceStats(),
  workspace_count: 0,
  usage: summarizeUsage([]),
 };
 account.stats = accountStats;

 return {
  account,
  owned_workspaces: (owned || []).map((row) => ({
   ...shapeTenantWorkspace(row),
   stats: statsByWorkspace.get(String(row.id)) || emptyWorkspaceStats(),
   usage: summarizeUsage(usageByWorkspace.get(String(row.id)) || []),
  })),
  // Shared workspaces carry NO stats and no usage on purpose: their activity
  // and their bill belong to the account that owns them, and repeating the
  // numbers here would let one workspace's spend be counted twice.
  member_workspaces: (memberOf || []).map((row) => ({
   ...shapeTenantWorkspace(row),
   role: row.role || '',
   owner_email: row.owner_email || '',
  })),
  metering,
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
 WORKSPACE_STATS_SQL,
 WORKSPACE_USAGE_SQL,
 emptyWorkspaceStats,
 shapeWorkspaceStats,
 rollUpAccountStats,
 getMeteringWindow,
};
