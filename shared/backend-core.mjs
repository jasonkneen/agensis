// ============================================================================
// shared/backend-core.mjs
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

import crypto from 'node:crypto';

// ----------------------------------------------------------------------------
// Allow-sets and role/capability tables — lifted VERBATIM from server/index.cjs.
// Do not invent: these are the security contract.
// ----------------------------------------------------------------------------

export const ALLOWED_TABLES = new Set([
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
  'activity_events',
]);

// Tables whose rows are scoped to a workspace and therefore subject to
// membership/role checks. Maps table -> how to find its workspace id.
export const WORKSPACE_SCOPED_TABLES = new Set([
  'documents', 'chat_sessions', 'memory_facts', 'uploaded_files',
  'canvas_groups', 'canvas_objects', 'tasks', 'document_comments',
  'task_comments', 'document_versions', 'workspace_agents', 'agent_webhooks',
  'agent_connections', 'agent_jobs', 'activity_events', 'workspace_members',
]);

export const WORKSPACE_ROLE_CAPABILITIES = {
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

export const DB_TABLE_ACCESS = {
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
  agent_jobs: { select: 'read', insert: 'run_agents', update: 'run_agents', delete: 'manage' },
  activity_events: DEFAULT_TABLE_ACCESS,
  document_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
  task_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
  workspace_members: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
  agent_webhooks: { select: 'manage', insert: 'manage', update: 'manage', delete: 'manage' },
};

// ----------------------------------------------------------------------------
// Error helpers — Errors carry a `.status` so framework adapters can map them to
// the existing `{ data: null, error }` JSON shape with the right HTTP code.
// ----------------------------------------------------------------------------

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
export function unauthorized(message = 'Authentication required') { return httpError(401, message); }
export function forbidden(message) { return httpError(403, message); }
export function badRequest(message) { return httpError(400, message); }

// ----------------------------------------------------------------------------
// AUTH: verify a signed session token. Mirrors server/index.cjs verifyToken /
// requireAuth, but the signing secret is passed in (no DB/env coupling here).
//
//   token format: `${userId}.${tokenVersion}.${base64url(HMAC_SHA256(secret, `${userId}.${tokenVersion}`))}`
//
// `token_version` (plan 005) is a per-user counter on app_users: a token embeds
// the version that was current when it was issued, and is rejected once that
// no longer matches the user's CURRENT version (bumped on sign-out / password
// change) — this is what makes revocation possible at all; previously a token
// was a pure function of userId + the (un-rotatable-per-user) global secret.
//
// `getTokenVersion(userId) => Promise<string|null>` is REQUIRED once the token
// signature checks out — verifyAuthToken deliberately does not fall back to
// "skip the check" if it's missing, since a caller forgetting to wire it would
// silently defeat revocation. See createTokenVersionCache below for the
// short-TTL cache every real caller should wrap `db` in (this runs on every
// authenticated request — an uncached per-request DB read is not acceptable).
// ----------------------------------------------------------------------------

export async function verifyAuthToken(authHeader, secret, getTokenVersion) {
  const header = String(authHeader || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const [userId, tokenVersionStr] = payload.split('.');
  if (!userId || !tokenVersionStr) return null;
  if (!secret) return null;
  const expected = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
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
export function createTokenVersionCache({ ttlMs = 10_000 } = {}) {
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

export function findFilterValue(filters, column) {
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
export async function resolveOperationWorkspace(table, { values, filters }, db) {
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
export async function userCanAccessWorkspace(userId, workspaceId, db) {
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

export async function getWorkspaceRole(userId, workspaceId, db) {
  if (!userId || !workspaceId) return null;
  const ownerRows = await db('select 1 from workspaces where id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
  if (ownerRows.length > 0) return 'owner';
  const memberRows = await db('select role from workspace_members where workspace_id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
  return memberRows[0]?.role || null;
}

export function roleHasWorkspaceCapability(role, capability) {
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
export async function assertWorkspaceRole({ userId, workspaceId, capability, minRole, mode, db }) {
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

export async function enforceDbOperationAccess({ userId, table, op, filters, payload, db }) {
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

  for (const row of operationRows(values)) {
    if (!row || typeof row !== 'object') continue;
    const resolved = await resolveOperationWorkspace(table, { values: row }, db);
    if (resolved.unscoped) throw badRequest('A workspace reference is required for this operation');
    await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });
  }

  if (operationRows(values).length === 0) {
    const resolved = await resolveOperationWorkspace(table, { filters: flt }, db);
    if (resolved.unscoped) throw badRequest('A workspace filter is required for this operation');
    await assertWorkspaceRole({ userId, workspaceId: resolved.workspaceId, capability: mode, db });
  }
}

// Constrain a SELECT on `workspaces` to rows the user owns or is a member of.
// Pure string/param builder — appended onto buildWhereClause output by callers.
export function appendWorkspaceAccessClause(where, userId) {
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

export async function logMessageActivityIdempotent(rows, { db }) {
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

export function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  function check(key) {
    const now = Date.now();
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
