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
 'canvas_layers',
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
 'activity_event_comments',
 // Huddles are READ through the generic /db path (and, more importantly,
 // subscribed to over realtime db_changes so the channel card is live). Every
 // write goes through the dedicated /backend/workspaces/:id/.../huddle routes in
 // server/huddles.cjs — see DB_TABLE_ACCESS below, which gates generic writes to
 // 'manage' so the token-minting and webhook-authority paths cannot be bypassed.
 'huddles',
 'huddle_events',
 // In-app feedback reports. READ through the generic /db path on purpose: that
 // routes read authorization through enforceDbOperationAccess -> 'read' on the
 // report's workspace, which is the System workspace — so "only members of the
 // System workspace can read feedback" is enforced by the SAME membership gate
 // as every other table, with no bespoke authorization path to get wrong.
 // Every WRITE is gated to 'manage' below: reports are created only by the
 // dedicated, rate-limited POST /backend/feedback route (any signed-in user),
 // never by a browser reaching /backend/db/insert.
 'feedback_reports',
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
 'canvas_layers',
 'canvas_objects',
 'tasks',
 'document_comments',
 'task_comments',
 'workspace_agents',
 'agent_webhooks',
 'agent_memory_files',
 'memory_file_comments',
 'activity_event_comments',
]);

const JSON_COLUMNS_BY_TABLE = {
 chat_sessions: new Set(['participants']),
 canvas_objects: new Set(['points']),
 workspace_agents: new Set(['tools', 'skills', 'metadata', 'sandbox_config']),
 agent_connections: new Set(['metadata', 'capabilities']),
 agent_jobs: new Set(['metadata']),
 activity_events: new Set(['metadata']),
 messages: new Set(['reactions']),
 feedback_reports: new Set(['page', 'selections', 'diagnostics']),
};

// Columns that are Postgres native arrays (NOT jsonb). The generic /backend/db
// insert/update path binds params via node-postgres `.unsafe(sql, params)`,
// which does NOT array-serialize a raw JS array for an untyped ($n) param — it
// coerces with `'' + value`, producing `a,b` instead of the required array
// literal `{a,b}`. So these columns are bound as an explicit PG array literal
// string with a `::<elemType>[]` cast (see toPgArrayLiteral / bindDbParam).
const ARRAY_COLUMNS_BY_TABLE = {
 tasks: { depends_on: 'uuid' },
};

function arrayColumnElemType(table, column) {
 return ARRAY_COLUMNS_BY_TABLE[table]?.[column] || null;
}

// Build a Postgres array literal (e.g. `{a,b,c}`) from a JS array. Elements are
// double-quoted and escaped so a stray quote/backslash can't break out of the
// literal. Returns '{}' for null/empty/non-array input.
function toPgArrayLiteral(value) {
 const items = Array.isArray(value) ? value : [];
 if (items.length === 0) return '{}';
 const parts = items
  .filter((item) => item != null)
  .map((item) => `"${String(item).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
 return `{${parts.join(',')}}`;
}

// Tables whose rows are scoped to a workspace and therefore subject to
// membership/role checks. Maps table -> how to find its workspace id.
// MUST stay in lockstep with server/index.cjs (parity test enforces this).
const WORKSPACE_SCOPED_TABLES = new Set([
 'documents', 'chat_sessions', 'memory_facts', 'uploaded_files',
 'canvas_groups', 'canvas_layers', 'canvas_objects', 'tasks', 'document_comments',
 'task_comments', 'document_versions', 'workspace_agents', 'agent_webhooks',
 'agent_connections', 'cursorbuddy_connection_keys', 'agent_jobs', 'agent_registrations',
 'activity_events', 'workspace_members',
 'agent_memory_files', 'memory_file_comments', 'thread_items',
 'agent_schedules', 'agent_schedule_runs', 'activity_event_comments',
 'huddles', 'huddle_events', 'feedback_reports',
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
 // A layer is no more privileged than the objects drawn on it: same read/write
 // capabilities as canvas_objects, so anyone who can draw can name a canvas.
 canvas_layers: DEFAULT_TABLE_ACCESS,
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
 activity_event_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
 // Read-only to the client on purpose. Huddle rows are created/ended by the
 // dedicated routes (which mint the LiveKit join token) and huddle_events is
 // APPEND-ONLY, written only by those routes and by the signed LiveKit webhook.
 // If a browser could insert a huddle_events row it could claim someone was in a
 // call, which is exactly the server-side-authority property this feature has.
 // 'manage' (not 'write') so an editor cannot reach these through /backend/db.
 huddles: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 huddle_events: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
 // SELECT is the whole point: a member of the System workspace reads the
 // reports filed against the product. 'read' means the generic gate resolves
 // the row's workspace and demands membership of it, so one user can never see
 // another user's report — the reporter is not a member and gets 403.
 // INSERT is 'manage', NOT 'write': submitting must stay on the dedicated
 // rate-limited route, which is the only place that resolves the System
 // workspace server-side and runs the server's own redaction pass. A generic
 // insert would let a client choose the workspace and skip both.
 feedback_reports: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
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
 // M6 (2026-07 review): the generic gate authorizes a workspaces UPDATE on the
 // 'manage' capability, and 'admin' is an invitable role that HAS 'manage' — so
 // without a column guard any admin could POST /backend/db/update
 // {table:'workspaces', values:{user_id:'<their id>'}} and take ownership, or
 // rewrite the MCP client credential. Ownership transfer and MCP credentials
 // have their own dedicated routes; they are never a generic column write.
 workspaces: new Set([
  'user_id',
  'mcp_token_hash',
  'mcp_auto_approve',
 ]),
};

// Columns a generic /backend/db write MAY still set, but only for a caller who
// has 'manage' on the workspace. Unlike PRIVILEGED_DB_COLUMNS_BY_TABLE (which is
// stripped outright), these back real product features whose ONLY writer is the
// generic db route, so blocking them would break the feature:
//
//   workspace_agents.metadata carries `host_folders`, which dispatch forwards to
//   the daemon and buildAgentCommand turns into `--add-dir <path>` for the coding
//   CLI. A member with only 'write' could otherwise widen an agent's filesystem
//   access to `/` or `~/.ssh` (H3, 2026-07 review). sandbox_provider /
//   sandbox_config likewise choose where and how agent code executes.
const MANAGE_ONLY_DB_COLUMNS_BY_TABLE = {
 workspace_agents: new Set([
  'metadata',
  'sandbox_provider',
  'sandbox_config',
 ]),
};

// True when `values` actually SETS one of the manage-only columns. A key that is
// absent, null, an empty string or an empty object does not count: the Agents
// window sends `sandbox_provider: null` / `sandbox_config: {}` on every agent
// create, and clearing a value is never an escalation. A JSON *string* payload
// (the jsonb columns accept one) is treated as a real value.
function setsManageOnlyDbColumn(table, values) {
 const elevated = MANAGE_ONLY_DB_COLUMNS_BY_TABLE[table];
 if (!elevated) return false;
 if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
 for (const key of elevated) {
  if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
  const value = values[key];
  if (value == null) continue;
  if (typeof value === 'string' && value.trim() === '') continue;
  if (typeof value === 'object' && Object.keys(value).length === 0) continue;
  return true;
 }
 return false;
}

// Columns a generic /backend/db/select may return, per table. Tables with no
// entry are unrestricted (unchanged behaviour). app_users is listed because the
// gate below deliberately allows a self-scoped SELECT, and the select handlers
// honour `columns: "*"` — which returned the caller's scrypt password_hash and
// the token_version that gates session revocation straight to the browser
// (M7, 2026-07 review).
const SELECTABLE_COLUMNS_BY_TABLE = {
 app_users: ['id', 'email', 'display_name', 'accent_color', 'created_at'],
};

/**
 * Project a select's requested columns down to what the table allows. Returns a
 * comma-separated column list (the same shape both backends' normalizeColumns
 * already accepts) so callers wrap it: normalizeColumns(safeSelectColumns(...)).
 * Throws 403 when a column outside the allow-list is asked for by name, so the
 * denial is visible rather than a silently missing field.
 */
function safeSelectColumns(table, columns) {
 const allowed = SELECTABLE_COLUMNS_BY_TABLE[table];
 if (!allowed) return columns;
 if (!columns || columns === '*') return allowed.join(', ');
 const requested = String(columns).split(',').map((column) => column.trim()).filter(Boolean);
 if (requested.length === 0) return allowed.join(', ');
 for (const column of requested) {
  if (!allowed.includes(column)) throw forbidden(`Column ${table}.${column} is not selectable`);
 }
 return requested.join(', ');
}

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
  // H3: setting a manage-only column (agent metadata/host_folders, sandbox
  // config) needs 'manage' on top of the table's normal write capability.
  if (setsManageOnlyDbColumn(table, values)) {
   await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: 'manage', db });
  }
  await assertUpdateKeepsTenancy({ sourceWorkspaceId: resolved.workspaceId, values, db });
  return;
 }

 for (const row of operationRows(values)) {
  if (!row || typeof row !== 'object') continue;
  const resolved = await resolveOperationWorkspace(table, { values: row }, db);
  if (resolved.unscoped) throw badRequest('A workspace reference is required for this operation');
  await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });
  // H3: same elevation on INSERT — creating an agent that already carries
  // host_folders (or a sandbox target) is the same escalation as setting them.
  if (setsManageOnlyDbColumn(table, row)) {
   await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: 'manage', db });
  }
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

// ----------------------------------------------------------------------------
// Workspace secret vault (M5, 2026-07 review).
//
// Both backends write the SAME workspace_secrets rows in the SAME Neon DB, but
// only server/index.cjs encrypted them: it stores AES-256-GCM ciphertext in
// `secret_cipher` with `value = ''`, and PREFERS secret_cipher on read. The
// Netlify mirror wrote the raw key into `value` and never touched
// secret_cipher, so a key rotated through Netlify left plaintext-new next to
// stale-cipher and Fly kept serving the OLD key. One implementation, here, so
// the two can't drift again.
//
// The key material must match on both sides: a dedicated SECRETS_ENCRYPTION_KEY
// if set (so secrets survive an AUTH_SECRET rotation), else the HMAC auth
// secret — which AGENTS.md already requires to be identical on Fly and Netlify.
// `getAuthSecret` is injected (sync or async) because each runtime resolves it
// differently (env-only on Netlify, env-or-DB on Fly).
// ----------------------------------------------------------------------------

async function vaultSecretKey(getAuthSecret) {
 const dedicated = String(process.env.SECRETS_ENCRYPTION_KEY || '').trim();
 const material = dedicated || `auth-fallback:${await getAuthSecret()}`;
 return crypto.createHash('sha256').update(`agensis-workspace-vault:${material}`).digest();
}

async function encryptVaultSecret(value, { getAuthSecret }) {
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv('aes-256-gcm', await vaultSecretKey(getAuthSecret), iv);
 const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
 return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

async function decryptVaultSecret(value, { getAuthSecret }) {
 const [iv, tag, encrypted] = String(value || '').split('.').map((part) => Buffer.from(part, 'base64url'));
 if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted vault secret');
 const decipher = crypto.createDecipheriv('aes-256-gcm', await vaultSecretKey(getAuthSecret), iv);
 decipher.setAuthTag(tag);
 return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function getWorkspaceSecretValue(workspaceId, key, { db, getAuthSecret }) {
 if (!workspaceId) return '';
 const rows = await db(
  'select value, secret_cipher from workspace_secrets where workspace_id = $1 and key = $2 limit 1',
  [workspaceId, key],
 );
 if (!rows[0]) return '';
 // Prefer the encrypted column; fall back to the legacy plaintext value for rows
 // written before encryption-at-rest landed (they get re-encrypted on next write).
 if (rows[0].secret_cipher) {
  try { return await decryptVaultSecret(rows[0].secret_cipher, { getAuthSecret }); } catch { return ''; }
 }
 return rows[0].value || '';
}

async function setWorkspaceSecretValue(workspaceId, key, value, { db, getAuthSecret, userId = null, description = null }) {
 const cipher = value ? await encryptVaultSecret(value, { getAuthSecret }) : '';
 await db(
  `insert into workspace_secrets (workspace_id, key, value, secret_cipher, description, updated_by, updated_at)
     values ($1, $2, '', $3, coalesce($4, ''), $5, now())
     on conflict (workspace_id, key)
     do update set value = '', secret_cipher = excluded.secret_cipher,
       description = coalesce($4, workspace_secrets.description),
       updated_by = excluded.updated_by, updated_at = now()`,
  [workspaceId, key, cipher, description ?? null, userId || null],
 );
}

// ----------------------------------------------------------------------------
// IN-APP FEEDBACK (System workspace).
//
// Shape of the feature, so the security properties are readable in one place:
//
//   SUBMIT  any authenticated user, rate limited, via POST /backend/feedback.
//           The client never chooses the destination workspace — the server
//           resolves the single System workspace itself. A report becomes an
//           ordinary `tasks` row (source_type='feedback') plus a
//           `feedback_reports` row holding the bulky diagnostics, so the
//           existing task list, assignment and agent dispatch work on it for
//           free and no parallel todo system exists.
//
//   READ    members of the System workspace only, through the generic /db
//           gate (DB_TABLE_ACCESS.feedback_reports.select = 'read', and
//           feedback_reports is workspace-scoped) — the same membership check
//           every other table uses. The reporter is NOT a member, so they
//           cannot read their own report back, and definitely not anyone
//           else's.
//
// The System workspace is an ORDINARY workspace with `is_system = true`. It has
// an owner, members, roles and invites like any other, so "add someone to it"
// is the normal Users flow rather than something new.
// ----------------------------------------------------------------------------

const SYSTEM_WORKSPACE_NAME = 'System';
const SYSTEM_WORKSPACE_ICON = '🛟';
const SYSTEM_WORKSPACE_DESCRIPTION = 'Product feedback filed from inside the app.';

const FEEDBACK_DESCRIPTION_MAX_CHARS = 4000;
const FEEDBACK_MAX_SELECTIONS = 5;
const FEEDBACK_MAX_CONSOLE_ENTRIES = 300;
const FEEDBACK_CONSOLE_ENTRY_MAX_CHARS = 800;
const FEEDBACK_MAX_ERROR_ENTRIES = 30;
/** Hard ceiling on the stored diagnostics blob, enforced by dropping the OLDEST console lines. */
const FEEDBACK_DIAGNOSTICS_MAX_BYTES = 256_000;

// CJS twin of src/lib/feedbackRedaction.ts's REDACTION_PATTERNS.
//
// The client redacts before sending; this redacts again on arrival. Both are
// needed for different reasons: the client one keeps secrets out of the network
// request at all, this one is the version that still holds when the request did
// NOT come from our client. A feedback endpoint that trusts the browser to have
// scrubbed its own console is not a security control.
//
// tests/feedback-redaction-parity.test.cjs asserts the two lists carry the same
// pattern NAMES, so adding a shape on one side and forgetting the other fails
// the suite instead of silently halving the protection.
const REDACTED_PLACEHOLDER = '[redacted]';

const FEEDBACK_REDACTION_PATTERNS = [
 { name: 'agensis-session-token', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+\.\d+\.[A-Za-z0-9_-]{16,}/gi, replacement: REDACTED_PLACEHOLDER },
 { name: 'agensis-agent-token', pattern: /\baga_[A-Za-z0-9_-]{8,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'bearer-header', pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED_PLACEHOLDER}` },
 { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'openai-style-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'github-token', pattern: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{20,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replacement: REDACTED_PLACEHOLDER },
 { name: 'connection-string-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: `$1${REDACTED_PLACEHOLDER}@` },
 { name: 'secret-assignment', pattern: /(["']?\b(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session[-_]?token|connect[-_]?token|client[-_]?secret|private[-_]?key|secret|password|passwd|pwd|authorization|cookie|set-cookie)\b["']?\s*[:=]\s*)(["']?)([^\s"',;)}\]&]{3,})\2/gi, replacement: `$1$2${REDACTED_PLACEHOLDER}$2` },
];

// Matched against the key with separators stripped, so `accessToken`,
// `access_token` and `access-token` all hit the same rule. Deliberately omits
// bare `auth` (matches `author`) and bare `session` (matches `sessionId`, not a
// credential and genuinely useful in a bug report) — both are covered by their
// compound forms. Mirrors SENSITIVE_KEY_WORDS in src/lib/feedbackRedaction.ts.
const FEEDBACK_SENSITIVE_KEY_WORDS = /token|secret|password|passwd|pwd|authorization|cookie|credential|apikey|privatekey/;

function isFeedbackSensitiveKey(key) {
 return FEEDBACK_SENSITIVE_KEY_WORDS.test(String(key).replace(/[-_.\s]/g, '').toLowerCase());
}

function redactSecretsText(value) {
 let text = typeof value === 'string' ? value : String(value == null ? '' : value);
 for (const { pattern, replacement } of FEEDBACK_REDACTION_PATTERNS) {
  pattern.lastIndex = 0;
  text = text.replace(pattern, replacement);
 }
 return text;
}

function redactSecretsDeep(value, depth = 6) {
 if (depth <= 0) return REDACTED_PLACEHOLDER;
 if (typeof value === 'string') return redactSecretsText(value);
 if (value === null || typeof value !== 'object') return value;
 if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, depth - 1));
 const out = {};
 for (const [key, entry] of Object.entries(value)) {
  out[key] = isFeedbackSensitiveKey(key) ? REDACTED_PLACEHOLDER : redactSecretsDeep(entry, depth - 1);
 }
 return out;
}

function clampString(value, max) {
 return redactSecretsText(String(value == null ? '' : value)).slice(0, max);
}

/**
 * Validate + clamp + redact a submitted report. Throws 400 when there is no
 * usable description. Everything else degrades to a safe default rather than
 * rejecting — a bug report is worth having even if its diagnostics were
 * malformed.
 */
function normalizeFeedbackSubmission(body) {
 const raw = body && typeof body === 'object' ? body : {};
 const description = clampString(raw.description, FEEDBACK_DESCRIPTION_MAX_CHARS).trim();
 if (description.length < 3) throw badRequest('Please describe the problem before submitting');

 const page = raw.page && typeof raw.page === 'object' ? raw.page : {};
 const normalizedPage = {
  path: clampString(page.path, 400),
  hash: clampString(page.hash, 200),
  label: clampString(page.label, 200),
 };

 const selections = (Array.isArray(raw.selections) ? raw.selections : [])
  .slice(0, FEEDBACK_MAX_SELECTIONS)
  .filter((entry) => entry && typeof entry === 'object')
  .map((entry) => {
   const rect = entry.rect && typeof entry.rect === 'object' ? entry.rect : {};
   const num = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0);
   return {
    selector: clampString(entry.selector, 500),
    tag: clampString(entry.tag, 40),
    role: clampString(entry.role, 40),
    text: clampString(entry.text, 200),
    rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
   };
  });

 const diagnostics = normalizeFeedbackDiagnostics(raw.diagnostics);

 return { description, page: normalizedPage, selections, diagnostics };
}

function normalizeFeedbackDiagnostics(input) {
 if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
 const viewport = input.viewport && typeof input.viewport === 'object' ? input.viewport : {};
 const dimension = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 100_000) : 0;
 };

 const consoleEntries = (Array.isArray(input.console) ? input.console : [])
  .slice(-FEEDBACK_MAX_CONSOLE_ENTRIES)
  .filter((entry) => entry && typeof entry === 'object')
  .map((entry) => ({
   level: clampString(entry.level, 10) || 'log',
   message: clampString(entry.message, FEEDBACK_CONSOLE_ENTRY_MAX_CHARS),
   at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
  }));

 const errors = (Array.isArray(input.errors) ? input.errors : [])
  .slice(-FEEDBACK_MAX_ERROR_ENTRIES)
  .filter((entry) => entry && typeof entry === 'object')
  .map((entry) => ({
   kind: clampString(entry.kind, 30) || 'error',
   message: clampString(entry.message, FEEDBACK_CONSOLE_ENTRY_MAX_CHARS),
   source: clampString(entry.source, 300),
   at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
  }));

 const diagnostics = {
  buildId: clampString(input.buildId, 120),
  userAgent: clampString(input.userAgent, 400),
  url: clampString(input.url, 600),
  language: clampString(input.language, 40),
  capturedAt: clampString(input.capturedAt, 40),
  viewport: { width: dimension(viewport.width), height: dimension(viewport.height) },
  console: consoleEntries,
  errors,
  truncated: Boolean(input.truncated),
 };

 // Size ceiling. Drop from the OLDEST console line inward — the lines nearest
 // the moment the user hit "report" are the ones that explain the bug.
 while (
  diagnostics.console.length > 0
  && JSON.stringify(diagnostics).length > FEEDBACK_DIAGNOSTICS_MAX_BYTES
 ) {
  diagnostics.console.shift();
  diagnostics.truncated = true;
 }

 return diagnostics;
}

/** First line of the description, as the task title. Falls back to a generic label. */
function feedbackTaskTitle(description) {
 const firstLine = String(description || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
 if (!firstLine) return 'Feedback report';
 return firstLine.length <= 90 ? firstLine : `${firstLine.slice(0, 89)}…`;
}

/**
 * Resolve (creating on first use) the single System workspace.
 *
 * Auto-creating means the feature has no manual setup step, and the partial
 * unique index `uq_workspaces_system` makes it race-safe: two concurrent first
 * submissions cannot produce two System workspaces, the loser just re-reads.
 *
 * Owner selection: AGENSIS_SYSTEM_OWNER_EMAIL when set, else the oldest account
 * (on a single-owner deployment that is the person who installed it). Ownership
 * is a normal `workspaces.user_id`, so it can be transferred with the existing
 * flow if that guess is wrong.
 */
async function ensureSystemWorkspace(db) {
 const existing = await db('select id from workspaces where is_system = true order by created_at asc limit 1', []);
 if (existing[0]) return existing[0].id;

 const configuredEmail = String(process.env.AGENSIS_SYSTEM_OWNER_EMAIL || '').trim().toLowerCase();
 let ownerId = null;
 if (configuredEmail) {
  const rows = await db('select id from app_users where lower(email) = $1 limit 1', [configuredEmail]);
  ownerId = rows[0]?.id || null;
 }
 if (!ownerId) {
  const rows = await db('select id from app_users order by created_at asc limit 1', []);
  ownerId = rows[0]?.id || null;
 }

 await db(
  `insert into workspaces (name, description, icon, user_id, is_system)
     values ($1, $2, $3, $4, true)
     on conflict do nothing`,
  [SYSTEM_WORKSPACE_NAME, SYSTEM_WORKSPACE_DESCRIPTION, SYSTEM_WORKSPACE_ICON, ownerId],
 );

 const created = await db('select id from workspaces where is_system = true order by created_at asc limit 1', []);
 if (!created[0]) throw httpError(500, 'Could not resolve the System workspace');
 return created[0].id;
}

/**
 * Persist one report: a `tasks` row (the reviewable, assignable artifact) and a
 * `feedback_reports` row (the payload). Returns { taskId, reportId }.
 *
 * `jsonParam` is the ONLY thing the two backends must supply differently, and
 * it is the trap this repo has been bitten by before. Verified against the live
 * Neon database, 2026-07-26:
 *
 *   postgres.js (Fly)          bind object -> jsonb object     JSON.stringify -> jsonb STRING (wrong)
 *   @netlify/database (Neon)   bind object -> jsonb object     JSON.stringify -> jsonb object
 *                              bind ARRAY  -> ERROR            JSON.stringify -> jsonb array (right)
 *
 * So Fly passes identity and Netlify passes JSON.stringify; that combination is
 * the only one correct for BOTH objects and arrays on BOTH drivers. Get it
 * backwards and Fly silently stores `"{\"console\":[...]}"` as a jsonb string
 * scalar — every `diagnostics->>'buildId'` then returns NULL and nothing errors.
 */
async function insertFeedbackReport({ db, jsonParam, userId, sourceWorkspaceId, submission }) {
 if (typeof db !== 'function') throw new Error('insertFeedbackReport requires a db function');
 if (typeof jsonParam !== 'function') throw new Error('insertFeedbackReport requires a jsonParam binder');

 const systemWorkspaceId = await ensureSystemWorkspace(db);
 const title = feedbackTaskTitle(submission.description);

 const pageRef = [submission.page.path, submission.page.hash].filter(Boolean).join('');
 const descriptionLines = [
  submission.description,
  '',
  `Page: ${pageRef || '(unknown)'}${submission.page.label ? ` — ${submission.page.label}` : ''}`,
 ];
 if (submission.selections.length > 0) {
  descriptionLines.push('', 'Elements:');
  for (const selection of submission.selections) {
   descriptionLines.push(`- \`${selection.selector}\`${selection.text ? ` — "${selection.text}"` : ''}`);
  }
 }

 const taskRows = await db(
  `insert into tasks (workspace_id, created_by, title, description, status, priority, source_type, source_id)
     values ($1, $2, $3, $4, 'todo', 'normal', 'feedback', null)
     returning id`,
  [systemWorkspaceId, userId || null, title, descriptionLines.join('\n')],
 );
 const taskId = taskRows[0]?.id;
 if (!taskId) throw httpError(500, 'Could not record the feedback task');

 const reportRows = await db(
  `insert into feedback_reports
       (workspace_id, task_id, reporter_id, source_workspace_id, description, page, selections, diagnostics, build_id, user_agent)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
     returning id`,
  [
   systemWorkspaceId,
   taskId,
   userId || null,
   sourceWorkspaceId || null,
   submission.description,
   jsonParam(submission.page),
   jsonParam(submission.selections),
   submission.diagnostics ? jsonParam(submission.diagnostics) : null,
   submission.diagnostics?.buildId || '',
   submission.diagnostics?.userAgent || '',
  ],
 );
 const reportId = reportRows[0]?.id;

 // source_id points back at the report so the task row alone is enough to find
 // the diagnostics. Written as a follow-up UPDATE because the report id is only
 // known after its insert, and the task must exist first for the FK.
 if (reportId) {
  await db('update tasks set source_id = $1, updated_at = now() where id = $2', [String(reportId), taskId]);
 }

 return { taskId, reportId: reportId || null, systemWorkspaceId };
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
 ARRAY_COLUMNS_BY_TABLE,
 arrayColumnElemType,
 toPgArrayLiteral,
 WORKSPACE_SCOPED_TABLES,
 WORKSPACE_ROLE_CAPABILITIES,
 DB_TABLE_ACCESS,
 PRIVILEGED_DB_COLUMNS_BY_TABLE,
 MANAGE_ONLY_DB_COLUMNS_BY_TABLE,
 setsManageOnlyDbColumn,
 SELECTABLE_COLUMNS_BY_TABLE,
 safeSelectColumns,
 stripPrivilegedDbValues,
 encryptVaultSecret,
 decryptVaultSecret,
 getWorkspaceSecretValue,
 setWorkspaceSecretValue,
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
 // In-app feedback / System workspace
 SYSTEM_WORKSPACE_NAME,
 SYSTEM_WORKSPACE_ICON,
 SYSTEM_WORKSPACE_DESCRIPTION,
 FEEDBACK_REDACTION_PATTERNS,
 FEEDBACK_DESCRIPTION_MAX_CHARS,
 FEEDBACK_MAX_SELECTIONS,
 FEEDBACK_MAX_CONSOLE_ENTRIES,
 FEEDBACK_DIAGNOSTICS_MAX_BYTES,
 redactSecretsText,
 redactSecretsDeep,
 normalizeFeedbackSubmission,
 normalizeFeedbackDiagnostics,
 feedbackTaskTitle,
 ensureSystemWorkspace,
 insertFeedbackReport,
};
