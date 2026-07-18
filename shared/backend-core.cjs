// ============================================================================
// shared/backend-core.cjs
// ----------------------------------------------------------------------------
// Dependency-light security core shared by BOTH backends:
//   - server/index.cjs        (hardened Express reference; deduped onto this later)
//   - netlify/functions/backend.mjs (serverless; previously UNAUTHENTICATED)
//
// These functions carry NO web-framework coupling. Callers pass in the raw
// inputs (auth header string, table/op/filters, a `db` query function) and the
// core returns a decision or throws an Error with a `.status` (401|403|400).
//
// The `db` argument everywhere is a thin async query function with the shape:
//     db(sqlText, paramsArray) => Promise<rows[]>
// node-postgres (`pool.query(...).rows`) and postgres.js (`sql.unsafe(...)`)
// both reduce to this shape, so the same core drives either backend.
// ============================================================================

const crypto = require('node:crypto');

// ----------------------------------------------------------------------------
// Allow-sets and role/capability tables — lifted VERBATIM from server/index.cjs.
// Do not invent: these are the security contract.
// ----------------------------------------------------------------------------

const ALLOWED_TABLES = new Set([
 'app_users',
 'workspaces',
 'documents',
 'chat_sessions',
 'messages',
 'memory_facts',
 'uploaded_files',
 'workspace_members',
 'canvas_groups',
 'canvas_objects',
 'tasks',
 'document_comments',
 'task_comments',
 'document_versions',
 'workspace_agents',
 'agent_webhooks',
 'agent_connections',
 'agent_jobs',
 'agent_registrations',
 'activity_events',
 'agent_memory_files',
 'memory_file_comments',
 'thread_items',
]);

// F4: superset lifted VERBATIM from server/index.cjs (the reference). Both runtimes
// destructure these from here so a table/column can never be exposed on one backend
// but not the other again (netlify was 18 tables, missing agent_connections.capabilities
// -> capability writes not cast ::jsonb). VERSIONED_TABLES + JSON_COLUMNS_BY_TABLE are
// new core exports, added to module.exports (P11b).
const VERSIONED_TABLES = new Set([
 'workspaces',
 'documents',
 'chat_sessions',
 'memory_facts',
 'uploaded_files',
 'canvas_groups',
 'canvas_objects',
 'tasks',
 'document_comments',
 'task_comments',
 'workspace_agents',
 'agent_webhooks',
 'agent_memory_files',
 'memory_file_comments',
]);

const JSON_COLUMNS_BY_TABLE = {
 chat_sessions: new Set(['participants']),
 canvas_objects: new Set(['points']),
 workspace_agents: new Set(['tools', 'skills', 'metadata', 'sandbox_config']),
 agent_connections: new Set(['metadata', 'capabilities']),
 agent_jobs: new Set(['metadata']),
 activity_events: new Set(['metadata']),
 messages: new Set(['reactions']),
};

// Tables whose rows are scoped to a workspace and therefore subject to
// membership/role checks. Maps table -> how to find its workspace id.
// MUST stay in lockstep with server/index.cjs (parity test enforces this).
const WORKSPACE_SCOPED_TABLES = new Set([
 'documents', 'chat_sessions', 'memory_facts', 'uploaded_files',
 'canvas_groups', 'canvas_objects', 'tasks', 'document_comments',
 'task_comments', 'document_versions', 'workspace_agents', 'agent_webhooks',
 'agent_connections', 'cursorbuddy_connection_keys', 'agent_jobs', 'agent_registrations',
 'activity_events', 'workspace_members',
 'agent_memory_files', 'memory_file_comments', 'thread_items',
 'agent_schedules', 'agent_schedule_runs',
]);

const WORKSPACE_ROLE_CAPABILITIES = {
 owner: new Set(['read', 'write', 'comment', 'run_agents', 'manage']),
 admin: new Set(['read', 'write', 'comment', 'run_agents', 'manage']),
 editor: new Set(['read', 'write', 'comment', 'run_agents']),
 commenter: new Set(['read', 'comment']),
 viewer: new Set(['read']),
};

const DEFAULT_TABLE_ACCESS = {
 select: 'read',
 insert: 'write',
 update: 'write',
 delete: 'write',
};

const DB_TABLE_ACCESS = {
 documents: DEFAULT_TABLE_ACCESS,
 chat_sessions: DEFAULT_TABLE_ACCESS,
 messages: DEFAULT_TABLE_ACCESS,
 memory_facts: DEFAULT_TABLE_ACCESS,
 uploaded_files: DEFAULT_TABLE_ACCESS,
 canvas_groups: DEFAULT_TABLE_ACCESS,
 canvas_objects: DEFAULT_TABLE_ACCESS,
 tasks: DEFAULT_TABLE_ACCESS,
 document_versions: DEFAULT_TABLE_ACCESS,
 workspace_agents: DEFAULT_TABLE_ACCESS,
 agent_connections: { select: 'read', insert: 'run_agents', update: 'run_agents', delete: 'manage' },
 cursorbuddy_connection_keys: { select: 'manage', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_jobs: { select: 'read', insert: 'run_agents', update: 'run_agents', delete: 'manage' },
 activity_events: DEFAULT_TABLE_ACCESS,
 document_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
 task_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
 workspace_members: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_webhooks: { select: 'manage', insert: 'manage', update: 'manage', delete: 'manage' },
 // Kept in sync with server/index.cjs DB_TABLE_ACCESS so a table added to this
 // runtime's ALLOWED_TABLES can't silently fall through to the default
 // read/write mapping (L1, 2026-07 review).
 agent_registrations: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // Writes go through dedicated /backend/.../schedules endpoints (workspace/session
 // validation + interval clamps). Generic /db writes are gated to 'manage' so the
 // run_agents path can't bypass that validation; runs are written by the runner only.
 agent_schedules: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_schedule_runs: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 agent_memory_files: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 memory_file_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
 thread_items: DEFAULT_TABLE_ACCESS,
};

// Columns that must never be set via generic /backend/db/* write by non-dedicated
// routes (editors could otherwise approve MCP agents, rewrite storage paths, etc.).
const PRIVILEGED_DB_COLUMNS_BY_TABLE = {
 workspace_agents: new Set([
  'mcp_approved',
  'connect_token_hash',
  'connect_token',
  'permission_mode',
 ]),
 uploaded_files: new Set([
  'storage_path',
  'content_sha256',
  'type',
 ]),
};

function stripPrivilegedDbValues(table, values) {
 if (!values || typeof values !== 'object' || Array.isArray(values)) return values;
 const privileged = PRIVILEGED_DB_COLUMNS_BY_TABLE[table];
 if (!privileged) return values;
 const next = { ...values };
 for (const key of privileged) {
  if (Object.prototype.hasOwnProperty.call(next, key)) delete next[key];
 }
 return next;
}

/**
 * Storage path for a workspace-owned upload must live under that workspace's
 * prefix after normalization. Rejects absolute paths and any `..` traversal
 * (e.g. `ws-1/../ws-2/secret.txt` must NOT pass for workspace ws-1).
 */
function storagePathBelongsToWorkspace(workspaceId, storagePath) {
 const ws = String(workspaceId || '').trim();
 if (!ws || ws.includes('/') || ws.includes('\\') || ws === '.' || ws === '..') return false;

 // Normalize separators; do not strip leading slashes yet so we can reject absolutes.
 let sp = String(storagePath || '').replace(/\\/g, '/');
 if (!sp || sp.startsWith('/') || /^[a-zA-Z]:/.test(sp)) return false;

 // Explicitly reject any parent-directory segment before trusting normalize.
 // path.posix.normalize("ws-1/../ws-2/x") => "ws-2/x" which would otherwise
 // look "fine" for a different workspace check if we only prefix-matched
 // the pre-normalized string (or worse, pass a broken prefix check).
 const rawSegments = sp.split('/');
 if (rawSegments.some((seg) => seg === '..')) return false;

 // Collapse "." and empty segments; no ".." remains after the check above.
 const normalized = rawSegments
  .filter((seg) => seg && seg !== '.')
  .join('/');
 if (!normalized) return false;
 // Belt-and-suspenders after join.
 if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return false;

 return normalized === ws || normalized.startsWith(`${ws}/`);
}

// ----------------------------------------------------------------------------
// Error helpers — Errors carry a `.status` so framework adapters can map them to
// the existing `{ data: null, error }` JSON shape with the right HTTP code.
// ----------------------------------------------------------------------------

function httpError(status, message) {
 const err = new Error(message);
 err.status = status;
 return err;
}
function unauthorized(message = 'Authentication required') { return httpError(401, message); }
function forbidden(message) { return httpError(403, message); }
function badRequest(message) { return httpError(400, message); }

// ----------------------------------------------------------------------------
// AUTH: issue + verify a signed session token. The signing secret is passed in
// (no DB/env coupling here).
//
//   token format:
//     `${userId}.${tokenVersion}.${issuedAt}.${base64url(HMAC_SHA256(secret, payload))}`
//
//   where `issuedAt` is unix seconds at mint time. Tokens older than
//   TOKEN_TTL_SEC (default 14d, override via AGENSIS_TOKEN_TTL_SEC) are rejected
//   even if the signature and token_version still match.
//
// `token_version` (plan 005) is a per-user counter on app_users: a token embeds
// the version that was current when it was issued, and is rejected once that
// no longer matches the user's CURRENT version (bumped on sign-out / password
// change) — this is what makes revocation possible at all.
//
// `getTokenVersion(userId) => Promise<string|null>` is REQUIRED once the token
// signature checks out — verifyAuthToken deliberately does not fall back to
// "skip the check" if it's missing, since a caller forgetting to wire it would
// silently defeat revocation. See createTokenVersionCache below for the
// short-TTL cache every real caller should wrap `db` in (this runs on every
// authenticated request — an uncached per-request DB read is not acceptable).
// ----------------------------------------------------------------------------

const DEFAULT_TOKEN_TTL_SEC = 14 * 24 * 60 * 60; // 14 days

function getTokenTtlSec() {
 const raw = Number(process.env.AGENSIS_TOKEN_TTL_SEC);
 if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
 return DEFAULT_TOKEN_TTL_SEC;
}

/**
 * Mint a session token. `options.issuedAt` (unix seconds) is test-only so
 * expiry can be exercised without sleeping.
 */
function issueAuthToken(userId, tokenVersion, secret, options = {}) {
 if (!secret) throw new Error('issueAuthToken requires a signing secret');
 const issuedAt = Number.isFinite(options.issuedAt)
  ? Math.floor(options.issuedAt)
  : Math.floor(Date.now() / 1000);
 const payload = `${userId}.${tokenVersion}.${issuedAt}`;
 const sig = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
 return `${payload}.${sig}`;
}

async function verifyAuthToken(authHeader, secret, getTokenVersion, options = {}) {
 const header = String(authHeader || '');
 const token = header.startsWith('Bearer ') ? header.slice(7) : header;
 if (!token || typeof token !== 'string') return null;
 const dot = token.lastIndexOf('.');
 if (dot <= 0) return null;
 const payload = token.slice(0, dot);
 const sig = token.slice(dot + 1);
 // Require userId.tokenVersion.issuedAt (legacy 2-part payloads no longer verify).
 const parts = payload.split('.');
 if (parts.length !== 3) return null;
 const [userId, tokenVersionStr, issuedAtStr] = parts;
 if (!userId || !tokenVersionStr || !issuedAtStr) return null;
 const issuedAt = Number(issuedAtStr);
 if (!Number.isFinite(issuedAt) || issuedAt < 0) return null;
 if (!secret) return null;
 const expected = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
 const a = Buffer.from(sig);
 const b = Buffer.from(expected);
 if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
 const nowSec = Number.isFinite(options.nowSec) ? Math.floor(options.nowSec) : Math.floor(Date.now() / 1000);
 const ttl = Number.isFinite(options.ttlSec) ? options.ttlSec : getTokenTtlSec();
 if (nowSec - issuedAt > ttl) return null;
 if (typeof getTokenVersion !== 'function') {
  throw new Error('verifyAuthToken requires a getTokenVersion(userId) function to check revocation');
 }
 const currentVersion = await getTokenVersion(userId);
 if (currentVersion === null || currentVersion === undefined || String(currentVersion) !== tokenVersionStr) return null;
 return userId;
}

// Short-TTL in-process cache for token_version lookups, so verifyAuthToken's
// revocation check doesn't turn every authenticated request into a DB round
// trip. Mirrors server/index.cjs's tokenVersionCache/getCachedTokenVersion —
// kept as a separate implementation (this file is ESM, that one CJS; see the
// H4 rate-limiter comment elsewhere in this file for why they aren't shared
// directly) but the two must stay in sync.
//
// State is per-instance/per-warm-container (same caveat as createRateLimiter
// below): a multi-instance deploy only bounds staleness to `ttlMs` on OTHER
// instances; the instance that performs a sign-out/password-change bump should
// update its own cache entry immediately (see netlify/functions/backend.mjs).
function createTokenVersionCache({ ttlMs = 10_000 } = {}) {
 const cache = new Map(); // userId -> { version, expiresAt }
 return {
  async get(userId, db) {
   const now = Date.now();
   const cached = cache.get(userId);
   if (cached && cached.expiresAt > now) return cached.version;
   const rows = await db('select token_version from app_users where id = $1 limit 1', [userId]);
   const version = rows[0] ? String(rows[0].token_version) : null;
   cache.set(userId, { version, expiresAt: now + ttlMs });
   return version;
  },
  // Called right after THIS instance bumps a user's token_version, so
  // revocation is instant here instead of waiting out the stale entry's TTL.
  set(userId, version) {
   cache.set(userId, { version: String(version), expiresAt: Date.now() + ttlMs });
  },
  clear() {
   cache.clear();
  },
 };
}

// ----------------------------------------------------------------------------
// Identifier quoting (defence-in-depth; callers also allow-list table names).
// ----------------------------------------------------------------------------

function quoteIdent(value) {
 if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
  throw new Error(`Invalid identifier: ${value}`);
 }
 return `"${value}"`;
}

// ----------------------------------------------------------------------------
// Workspace resolution + membership / role checks.
// ----------------------------------------------------------------------------

function findFilterValue(filters, column) {
 if (!Array.isArray(filters)) return undefined;
 const f = filters.find((x) => x && x.column === column && x.operator === 'eq');
 return f ? f.value : undefined;
}

function operationRows(values) {
 if (!values) return [];
 return Array.isArray(values) ? values : [values];
}

// Resolve the workspace id a db operation targets, looking through parent rows
// when the table/filter doesn't carry workspace_id directly. Returns
// { workspaceId } when determinable, or { unscoped: true } when access can't be
// constrained to a single workspace (caller decides how strict to be).
async function resolveOperationWorkspace(table, { values, filters }, db) {
 // Insert: workspace id (or a parent that has one) comes from the row values.
 if (values) {
  if (values.workspace_id) return { workspaceId: values.workspace_id };
  if (table === 'messages' && values.session_id) {
   const rows = await db('select workspace_id from chat_sessions where id = $1 limit 1', [values.session_id]);
   if (rows[0]) return { workspaceId: rows[0].workspace_id };
  }
  return { unscoped: true };
 }
 // Select/update/delete: derive from filters.
 const directWs = findFilterValue(filters, 'workspace_id');
 if (directWs) return { workspaceId: directWs };

 const parentLookups = [
  { col: 'document_id', sql: 'select workspace_id from documents where id = $1 limit 1' },
  { col: 'task_id', sql: 'select workspace_id from tasks where id = $1 limit 1' },
  { col: 'session_id', sql: 'select workspace_id from chat_sessions where id = $1 limit 1' },
  { col: 'group_id', sql: 'select workspace_id from canvas_groups where id = $1 limit 1' },
 ];
 for (const lookup of parentLookups) {
  const v = findFilterValue(filters, lookup.col);
  if (v) {
   const rows = await db(lookup.sql, [v]);
   if (rows[0]) return { workspaceId: rows[0].workspace_id };
  }
 }
 // Row id filter on a workspace-scoped table -> look up that row's workspace.
 const idVal = findFilterValue(filters, 'id');
 if (idVal && WORKSPACE_SCOPED_TABLES.has(table)) {
  const rows = await db(`select workspace_id from ${quoteIdent(table)} where id = $1 limit 1`, [idVal]);
  if (rows[0]) return { workspaceId: rows[0].workspace_id };
 }
 return { unscoped: true };
}

// True if the user owns the workspace or is a member of it.
async function userCanAccessWorkspace(userId, workspaceId, db) {
 if (!userId || !workspaceId) return false;
 const rows = await db(
  `select 1 from workspaces where id = $1 and user_id = $2
     union all
     select 1 from workspace_members where workspace_id = $1 and user_id = $2
     limit 1`,
  [workspaceId, userId],
 );
 return rows.length > 0;
}

async function getWorkspaceRole(userId, workspaceId, db) {
 if (!userId || !workspaceId) return null;
 const ownerRows = await db('select 1 from workspaces where id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
 if (ownerRows.length > 0) return 'owner';
 const memberRows = await db('select role from workspace_members where workspace_id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
 return memberRows[0]?.role || null;
}

function roleHasWorkspaceCapability(role, capability) {
 return Boolean(WORKSPACE_ROLE_CAPABILITIES[role]?.has(capability));
}

function capabilityForDbOperation(table, action) {
 const access = DB_TABLE_ACCESS[table];
 return access?.[action] || (action === 'select' ? 'read' : 'write');
}

// Enforce that `userId` has the required capability in `workspaceId`. Throws 403
// on denial. `capability` is the canonical name (read|write|comment|run_agents|
// manage); `minRole`/`mode` are accepted as aliases for ergonomics, interpreted
// as the same capability strings (matches server's capability-based model — it
// does NOT rank roles, it checks capability membership).
async function assertWorkspaceRole({ userId, workspaceId, capability, minRole, mode, db }) {
 const need = capability || mode || minRole;
 const role = await getWorkspaceRole(userId, workspaceId, db);
 if (!role) throw forbidden('You do not have access to this workspace');
 if (!roleHasWorkspaceCapability(role, need)) {
  if (need === 'manage') throw forbidden('You do not have permission to manage this workspace');
  if (need === 'write') throw forbidden('You do not have permission to change this workspace');
  if (need === 'comment') throw forbidden('You do not have permission to comment in this workspace');
  if (need === 'run_agents') throw forbidden('You do not have permission to run agents in this workspace');
  throw forbidden('You do not have permission to access this workspace');
 }
}

async function resolveWorkspaceRowById(id, db) {
 if (!id) return null;
 const rows = await db('select id from workspaces where id = $1 limit 1', [id]);
 return rows[0]?.id || null;
}

// Parent-reference columns that define a child row's tenancy. An UPDATE may set
// these (e.g. moving a canvas object between groups) but only to a parent that
// lives in the SAME workspace as the source row.
const UPDATE_PARENT_REF_LOOKUPS = {
 session_id: 'select workspace_id from chat_sessions where id = $1 limit 1',
 document_id: 'select workspace_id from documents where id = $1 limit 1',
 task_id: 'select workspace_id from tasks where id = $1 limit 1',
 group_id: 'select workspace_id from canvas_groups where id = $1 limit 1',
};

// H1 (2026-07 review): reject an UPDATE whose `values` would move/inject the row
// into a workspace other than the one it currently belongs to. Authorizing the
// source workspace alone is not enough — the SET clause could carry
// workspace_id or a cross-tenant parent reference. `sourceWorkspaceId` is the
// row's current workspace (already resolved + authorized by the caller).
async function assertUpdateKeepsTenancy({ sourceWorkspaceId, values, db }) {
 if (!values || typeof values !== 'object' || Array.isArray(values)) return;
 const src = String(sourceWorkspaceId);
 if (values.workspace_id != null && String(values.workspace_id) !== src) {
  throw forbidden('Cannot move a row to another workspace');
 }
 for (const [col, sql] of Object.entries(UPDATE_PARENT_REF_LOOKUPS)) {
  const v = values[col];
  if (v == null) continue; // absent, or explicitly cleared to null, is fine
  const rows = await db(sql, [v]);
  const targetWs = rows[0]?.workspace_id;
  if (!targetWs || String(targetWs) !== src) {
   throw forbidden('Cannot reassign a row to another workspace');
  }
 }
}

// ----------------------------------------------------------------------------
// THE central gate: authorize a generic /backend/db/* operation.
//
//   enforceDbOperationAccess({ userId, table, op, filters, payload, db })
//     op       : 'select' | 'insert' | 'update' | 'delete'
//     filters  : the filters array (for select/update/delete)
//     payload  : { values?, filters? } — values for insert/update
//     db       : async query function (sql, params) => rows
//
// Throws 401/403/400. CRITICAL C1 guarantee: update/delete with EMPTY filters is
// rejected outright (the catastrophic full-table-wipe vector) BEFORE any other
// per-table logic, so it applies to every table including app_users/workspaces.
// ----------------------------------------------------------------------------

async function enforceDbOperationAccess({ userId, table, op, filters, payload, db }) {
 if (!userId) throw unauthorized();
 if (typeof db !== 'function') throw new Error('enforceDbOperationAccess requires a db function');

 const pl = payload || {};
 const flt = filters != null ? filters : (Array.isArray(pl.filters) ? pl.filters : []);
 const values = pl.values;

 // --- C1: refuse an unfiltered update/delete — it would wipe the whole table.
 if (op === 'update' || op === 'delete') {
  if (!Array.isArray(flt) || flt.length === 0) {
   throw badRequest(`${op === 'delete' ? 'Delete' : 'Update'} requires at least one filter`);
  }
 }

 if (table === 'app_users') {
  const idFilter = findFilterValue(flt, 'id');
  if (op === 'select' && idFilter && String(idFilter) === String(userId)) return;
  throw forbidden('Direct user table access is not allowed');
 }

 if (table === 'workspaces') {
  if (op === 'select') return;
  if (op === 'insert') {
   for (const row of operationRows(values)) {
    if (row && row.user_id && String(row.user_id) !== String(userId)) {
     throw forbidden('Cannot create a workspace for another user');
    }
   }
   return;
  }
  const workspaceId = findFilterValue(flt, 'id')
   || await resolveWorkspaceRowById(findFilterValue(flt, 'workspace_id'), db);
  if (!workspaceId) throw badRequest('A workspace id filter is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db });
  return;
 }

 if (!WORKSPACE_SCOPED_TABLES.has(table) && table !== 'messages') return;

 const mode = capabilityForDbOperation(table, op);

 // UPDATE: authorize the SOURCE row's workspace (resolved from filters), then
 // verify `values` can't move the row into a different workspace (H1).
 if (op === 'update') {
  const resolved = await resolveOperationWorkspace(table, { filters: flt }, db);
  if (resolved.unscoped) throw badRequest('A workspace filter is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });
  await assertUpdateKeepsTenancy({ sourceWorkspaceId: resolved.workspaceId, values, db });
  return;
 }

 for (const row of operationRows(values)) {
  if (!row || typeof row !== 'object') continue;
  const resolved = await resolveOperationWorkspace(table, { values: row }, db);
  if (resolved.unscoped) throw badRequest('A workspace reference is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });
  // H1-insert (F7 review): a child INSERT may carry a cross-tenant parent ref
  // (document_id/task_id/session_id/group_id) even when workspace_id is legit —
  // reuse the UPDATE tenancy guard so the parent must live in this workspace.
  await assertUpdateKeepsTenancy({ sourceWorkspaceId: resolved.workspaceId, values: row, db });
 }

 if (operationRows(values).length === 0) {
  const resolved = await resolveOperationWorkspace(table, { filters: flt }, db);
  if (resolved.unscoped) throw badRequest('A workspace filter is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });
 }
}

// Constrain a SELECT on `workspaces` to rows the user owns or is a member of.
// Pure string/param builder — appended onto buildWhereClause output by callers.
function appendWorkspaceAccessClause(where, userId) {
 const params = where.params || [];
 params.push(userId);
 const ownerParam = `$${params.length}`;
 params.push(userId);
 const memberParam = `$${params.length}`;
 const accessClause = `("workspaces"."user_id" = ${ownerParam} OR EXISTS (SELECT 1 FROM "workspace_members" wm WHERE wm.workspace_id = "workspaces"."id" AND wm.user_id = ${memberParam}))`;
 return {
  clause: where.clause ? `${where.clause} AND ${accessClause}` : ` WHERE ${accessClause}`,
  params,
 };
}

// ----------------------------------------------------------------------------
// Activity logging — ONE shared logger for both backends.
//
// Logs an `activity_events` row per inserted chat message so it surfaces in the
// Activity feed. Idempotent at the DB level: the insert uses ON CONFLICT DO
// NOTHING against the partial unique index
//   uq_activity_events_message_sent (entity_id) WHERE event_type='message_sent'
//                                                  AND entity_type='message'
// so retried message finalizations (the same message id logged twice) can never
// duplicate the feed row — this is race-safe, unlike a SELECT-then-insert.
//
// The conflict target is intentionally LEFT OFF (plain `ON CONFLICT DO NOTHING`)
// so the statement degrades to a normal insert when the index is absent (e.g. a
// DB that hasn't run the C3 migration yet) instead of erroring 42P10. Since the
// row's `id` is a fresh uuid default, the only realistic conflict is the partial
// index, so this never suppresses a legitimately distinct row.
//
// Defensive: a logging failure NEVER breaks the caller's insert.
// ----------------------------------------------------------------------------

const ACTIVITY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function logMessageActivityIdempotent(rows, { db }) {
 if (typeof db !== 'function') return;
 for (const message of rows || []) {
  if (!message || typeof message !== 'object') continue;
  try {
   const sessionId = message.session_id;
   if (!sessionId) continue;

   const messageId = message.id != null ? String(message.id) : null;

   const sessionRows = await db('select workspace_id from chat_sessions where id = $1 limit 1', [sessionId]);
   const workspaceId = sessionRows[0]?.workspace_id || null;
   if (!workspaceId) continue;

   const role = message.role || '';
   const senderName = message.sender_name || (role === 'user' ? 'You' : 'Agent');
   const content = typeof message.content === 'string' ? message.content : '';
   const title = `${senderName}: ${content.slice(0, 80)}`.slice(0, 120);
   const senderId = typeof message.sender_id === 'string' ? message.sender_id : '';
   const userId = role === 'user' && ACTIVITY_UUID_RE.test(senderId) ? senderId : null;
   const metadata = {
    session_id: sessionId,
    role,
    sender_kind: message.sender_kind || '',
    sender_name: message.sender_name || '',
    content,
   };
   await db(
    `insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
         values ($1, $2, 'message_sent', 'message', $3, $4, $5::jsonb, now())
         on conflict do nothing`,
    [workspaceId, userId, messageId, title, JSON.stringify(metadata)],
   );
  } catch (error) {
   console.error('logMessageActivityIdempotent failed', error);
  }
 }
}

// ----------------------------------------------------------------------------
// Rate limiter scaffold (in-memory fixed window). Wiring into routes is deferred
// (H4). `check(key)` returns { allowed, remaining, retryAfterMs }.
//
// In-memory state is per-process; on serverless it only limits within a warm
// instance. Good enough as a scaffold; a shared store is a later concern.
// ----------------------------------------------------------------------------

function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
 const hits = new Map(); // key -> { count, resetAt }
 let lastSweep = 0;
 // Evict expired entries so distinct keys cannot grow the Map without bound.
 function sweep(now) {
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [key, entry] of hits) {
   if (now >= entry.resetAt) hits.delete(key);
  }
 }
 function check(key) {
  const now = Date.now();
  sweep(now);
  let entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
   entry = { count: 0, resetAt: now + windowMs };
   hits.set(key, entry);
  }
  entry.count += 1;
  const allowed = entry.count <= max;
  return {
   allowed,
   blocked: !allowed,
   remaining: Math.max(0, max - entry.count),
   retryAfterMs: allowed ? 0 : Math.max(0, entry.resetAt - now),
  };
 }
 function reset(key) {
  if (key === undefined) hits.clear();
  else hits.delete(key);
 }
 return { check, reset };
}

// ----------------------------------------------------------------------------
// Cross-instance rate limiter backed by Postgres (H4 follow-up). The in-memory
// createRateLimiter above only bounds a single warm process — useless across
// Fly machines or Netlify lambdas. This variant does an atomic fixed-window
// upsert so every instance shares one counter.
//
// Requires a `rate_limits` table:
//   create table rate_limits (
//     bucket text not null, window_start timestamptz not null,
//     count int not null default 0, primary key (bucket, window_start));
//
// `check(key)` is ASYNC. It FAILS OPEN on any DB error (returns allowed) — a
// limiter that hard-fails would take down the very routes it protects; the
// in-memory limiter in front of it still provides a first bound.
// ----------------------------------------------------------------------------

function createDbRateLimiter({ windowMs = 60_000, max = 60, db, namespace = 'rl' } = {}) {
 async function check(key) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const bucket = `${namespace}:${key}`;
  try {
   // Atomic increment of the current window's counter. The composite PK on
   // (bucket, window_start) means concurrent requests across instances all
   // land on the same row and the RETURNING count is the post-increment total.
   const rows = await db(
    `insert into rate_limits (bucket, window_start, count)
           values ($1, $2, 1)
           on conflict (bucket, window_start)
           do update set count = rate_limits.count + 1
           returning count`,
    [bucket, windowStart],
   );
   // Opportunistic cleanup (~0.5% of calls) so serverless callers with no timer
   // still bound table growth. The long-lived Express server also runs sweep()
   // on an interval; both are best-effort and never block the check.
   if (Math.random() < 0.005) { void sweep(); }
   const count = Number(rows?.[0]?.count || 1);
   const allowed = count <= max;
   const resetAt = windowStart.getTime() + windowMs;
   return {
    allowed,
    blocked: !allowed,
    remaining: Math.max(0, max - count),
    retryAfterMs: allowed ? 0 : Math.max(0, resetAt - now),
   };
  } catch {
   // Fail open: never let a limiter DB hiccup 500 a protected route.
   return { allowed: true, blocked: false, remaining: max, retryAfterMs: 0 };
  }
 }
 // Best-effort cleanup of windows older than now — callers may run this on a timer.
 async function sweep() {
  try {
   await db('delete from rate_limits where window_start < $1', [new Date(Date.now() - windowMs * 2)]);
  } catch { /* ignore */ }
 }
 return { check, sweep };
}

// ----------------------------------------------------------------------------
// Server-side password policy (plan 004 — auth hardening).
// Mirrors src/lib/passwordPolicy.ts's `evaluatePassword` rule (min length +
// character-class count) as a plain-JS, framework-free re-implementation so it
// can run here (ESM, Netlify) and be ported inline into server/index.cjs's CJS
// style (that file keeps its own copies of shared helpers on purpose — see the
// comment above `createRateLimiter` there). Keep both in sync if this changes.
// ----------------------------------------------------------------------------

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MIN_CLASSES = 3; // at least 3 of: lowercase, uppercase, digit, symbol

function evaluatePasswordServerSide(password) {
 const value = String(password || '');
 const classesMet =
  (/[a-z]/.test(value) ? 1 : 0) +
  (/[A-Z]/.test(value) ? 1 : 0) +
  (/[0-9]/.test(value) ? 1 : 0) +
  (/[^A-Za-z0-9]/.test(value) ? 1 : 0);
 const longEnough = value.length >= PASSWORD_MIN_LENGTH;
 const valid = longEnough && classesMet >= PASSWORD_MIN_CLASSES;
 const message = valid
  ? ''
  : !longEnough
   ? `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
   : `Password must include at least ${PASSWORD_MIN_CLASSES} of: lowercase, uppercase, number, symbol.`;
 return { valid, classesMet, longEnough, message };
}

module.exports = {
 verifyAuthToken,
 issueAuthToken,
 getTokenTtlSec,
 DEFAULT_TOKEN_TTL_SEC,
 enforceDbOperationAccess,
 assertWorkspaceRole,
 ALLOWED_TABLES,
 VERSIONED_TABLES,
 JSON_COLUMNS_BY_TABLE,
 WORKSPACE_SCOPED_TABLES,
 WORKSPACE_ROLE_CAPABILITIES,
 DB_TABLE_ACCESS,
 PRIVILEGED_DB_COLUMNS_BY_TABLE,
 stripPrivilegedDbValues,
 storagePathBelongsToWorkspace,
 createTokenVersionCache,
 appendWorkspaceAccessClause,
 logMessageActivityIdempotent,
 createRateLimiter,
 createDbRateLimiter,
 evaluatePasswordServerSide,
 findFilterValue,
 resolveOperationWorkspace,
 userCanAccessWorkspace,
 getWorkspaceRole,
 roleHasWorkspaceCapability,
 assertUpdateKeepsTenancy,
 httpError,
 unauthorized,
 forbidden,
 badRequest,
 PASSWORD_MIN_LENGTH,
 PASSWORD_MIN_CLASSES,
};
