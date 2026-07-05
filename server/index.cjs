const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const cors = require('cors');
const postgres = require('postgres');
const { WebSocketServer } = require('ws');
const { createMcpHandler } = require('./mcp.cjs');
const { renderSkillMd, skillManifest, configBlock, claudeMcpAddCommand, mcpEndpoint } = require('./skills.cjs');
const { ALLOWED_TABLES, VERSIONED_TABLES, JSON_COLUMNS_BY_TABLE } = require('../shared/backend-core.cjs');

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = Number(process.env.API_PORT || 3142);
const DEFAULT_AI_MODEL = process.env.AGENSIS_DEFAULT_AI_MODEL || 'claude-opus-4-8';
const OPENPETS_CATALOG_URL = 'https://openpets.dev/pets/catalog.v3/page-000.json';
const CODEX_PETS_ROOT = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'pets');

let envLoaded = false;
let db;
let websocketClients = new Set();
const connectedAgents = new Map();

// Heartbeat cadence for agent sockets. An ungraceful drop (laptop sleep, network
// loss) leaves ws.readyState === 1 until a ping goes unanswered, so detection
// latency is ~1-2x this interval. 15s → a dead socket is terminated within ~30s,
// which fires 'close' → markAgentConnectionOffline → failConnectionJobs, turning
// what used to be a 240s silent "Thinking…" hang into a fast, explicit failure.
const LIVENESS_PING_INTERVAL_MS = 15_000;

function applyEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
  return true;
}

function loadEnvFile() {
  if (envLoaded) return;
  envLoaded = true;

  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];

  for (const envPath of candidates) {
    if (applyEnvFile(envPath)) return;
  }

  return;
}

// Secret keys that the settings dialog is allowed to read/write. Anything not
// in this list is rejected so the endpoint can't write arbitrary settings.
const MANAGED_SECRET_KEYS = ['ANTHROPIC_API_KEY'];

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

// Global settings are persisted in app_settings. Workspace-managed secrets live
// in workspace_secrets so member roles can gate reads/writes per workspace.
async function getSettingValue(key) {
  const rows = await getDb().unsafe('select value from app_settings where key = $1 limit 1', [key]);
  return rows[0]?.value || '';
}

async function setSettingValue(key, value) {
  await getDb().unsafe(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

async function getWorkspaceSecretValue(workspaceId, key) {
  if (!workspaceId) return '';
  const rows = await getDb().unsafe(
    'select value from workspace_secrets where workspace_id = $1 and key = $2 limit 1',
    [workspaceId, key],
  );
  return rows[0]?.value || '';
}

async function setWorkspaceSecretValue(workspaceId, key, value, userId) {
  await getDb().unsafe(
    `insert into workspace_secrets (workspace_id, key, value, updated_by, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (workspace_id, key)
     do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [workspaceId, key, value, userId || null],
  );
}

// Resolve a managed secret: DB value first, then env var as a fallback (so an
// ANTHROPIC_API_KEY set via the host environment still works out of the box).
async function resolveSecret(key, workspaceId = null) {
  loadEnvFile();
  const workspaceValue = await getWorkspaceSecretValue(workspaceId, key).catch(() => '');
  if (workspaceValue) return workspaceValue;
  const dbValue = await getSettingValue(key).catch(() => '');
  return dbValue || process.env[key] || '';
}

async function listManagedSecrets(workspaceId = null) {
  return Promise.all(MANAGED_SECRET_KEYS.map(async (key) => {
    const workspaceValue = await getWorkspaceSecretValue(workspaceId, key).catch(() => '');
    const fallbackValue = workspaceValue ? '' : await resolveSecret(key, null);
    const value = workspaceValue || fallbackValue;
    return {
      key,
      configured: !!value,
      preview: maskSecret(value),
      scope: workspaceValue ? 'workspace' : fallbackValue ? 'app' : 'unset',
    };
  }));
}

// ============================================================
// AUTH: signed session tokens + workspace access control
// ============================================================

let cachedAuthSecret = null;
// eslint-disable-next-line no-unused-vars -- write-only debug instrumentation for getAuthSecret()
let cachedAuthSecretSource = '';

// HMAC signing secret. In the split deploy (static frontend on Netlify + this
// long-running backend on Fly), Netlify signs user tokens with process.env.AUTH_SECRET
// and proxies dispatch here carrying the same Bearer token. To verify those tokens we
// MUST use the same secret, so an explicit env var wins. Only when no env secret is
// configured (local / single-process dev) do we fall back to one persisted in the DB,
// generating it on first use. Without this, the Netlify-issued token fails verifyToken
// here (401) and every DM / @mention dispatch is silently dropped — the daemon stays
// "connected" (its aga_ token is a separate DB-hash auth) but never receives a job.
async function getAuthSecret() {
  if (cachedAuthSecret) return cachedAuthSecret;
  const envSecret = process.env.AGENSIS_AUTH_SECRET || process.env.AUTH_SECRET || '';
  if (envSecret) {
    cachedAuthSecret = envSecret;
    cachedAuthSecretSource = 'env';
    return cachedAuthSecret;
  }
  let secret = await getSettingValue('AUTH_SECRET').catch(() => '');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await setSettingValue('AUTH_SECRET', secret);
  }
  cachedAuthSecret = secret;
  cachedAuthSecretSource = 'db';
  return cachedAuthSecret;
}

// Token revocation: `token_version` is a per-user counter stored on app_users.
// A token embeds the version that was current when it was issued; verifyToken
// rejects any token whose embedded version no longer matches the user's CURRENT
// version. Bumping the version (on sign-out or password change) invalidates
// every outstanding token for that user in one shot.
//
// verifyToken is a hot path (called on every authenticated HTTP request and
// every WebSocket auth frame) and used to be pure in-process HMAC verification
// with zero I/O. A per-request DB lookup for token_version would turn every
// authenticated request into a DB round trip, so lookups are served from a
// short-TTL in-process cache instead — this bounds revocation to "takes effect
// within TOKEN_VERSION_CACHE_TTL_MS", not instant, in exchange for bounded DB
// load. No eviction beyond TTL expiry (an unbounded Map at very large scale);
// fine for this app's expected size, revisit if that ever changes.
const tokenVersionCache = new Map(); // userId -> { version, expiresAt }
const TOKEN_VERSION_CACHE_TTL_MS = 10_000; // 10s: bounds staleness of revocation, bounds DB load

async function getCachedTokenVersion(userId) {
  const now = Date.now();
  const cached = tokenVersionCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.version;
  const rows = await getDb().unsafe('select token_version from app_users where id = $1 limit 1', [userId]);
  const version = rows[0] ? String(rows[0].token_version) : null;
  tokenVersionCache.set(userId, { version, expiresAt: now + TOKEN_VERSION_CACHE_TTL_MS });
  return version;
}

// Called immediately after THIS process bumps a user's token_version (sign-out,
// password change) so revocation is instant on the instance that just did the
// write, instead of waiting out the stale cache entry's remaining TTL. Other
// instances in a multi-instance deploy still only pick up the change within
// TOKEN_VERSION_CACHE_TTL_MS — see the maintenance notes on the plan for that
// accepted trade-off.
function setCachedTokenVersion(userId, version) {
  tokenVersionCache.set(userId, { version: String(version), expiresAt: Date.now() + TOKEN_VERSION_CACHE_TTL_MS });
}

async function issueToken(userId, tokenVersion) {
  const secret = await getAuthSecret();
  const payload = `${userId}.${tokenVersion}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const [userId, tokenVersionStr] = payload.split('.');
  if (!userId || !tokenVersionStr) return null;
  const secret = await getAuthSecret();
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  // Check the signed version still matches the user's CURRENT version in the DB
  // (via the short-TTL cache above) — a stale/rolled-back/revoked token fails here.
  const currentVersion = await getCachedTokenVersion(userId);
  if (currentVersion === null || currentVersion !== tokenVersionStr) return null;
  return userId;
}

// Verify a Netlify outgoing-webhook signature. When a JWS secret is configured on
// the Netlify deploy notification, Netlify sends an `X-Webhook-Signature` header: a
// compact JWS (`base64url(header).base64url(payload).base64url(signature)`) signed
// HS256 with that secret, whose payload carries `sha256` = hex SHA-256 of the exact
// request body. We (a) verify the HS256 signature proves it came from Netlify and
// (b) confirm the body hash matches so the payload wasn't swapped in transit.
// Returns true only if both hold. Pure in-process crypto — no I/O, so the hook acks fast.
function verifyNetlifyDeploySignature(signatureHeader, rawBody, secret) {
  if (!secret || typeof signatureHeader !== 'string') return false;
  const parts = signatureHeader.split('.');
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  const a = Buffer.from(encodedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  // Signature is authentic; now bind it to this exact body.
  let claimedHash;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    claimedHash = typeof payload?.sha256 === 'string' ? payload.sha256.toLowerCase() : '';
  } catch {
    return false;
  }
  if (!claimedHash) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const x = Buffer.from(claimedHash);
  const y = Buffer.from(bodyHash);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Express middleware: require a valid Bearer token, set req.userId.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const userId = await verifyToken(token);
    if (!userId) return jsonError(res, 401, new Error('Authentication required'));
    req.userId = userId;
    next();
  // eslint-disable-next-line no-unused-vars -- error intentionally not surfaced to the client response
  } catch (error) {
    jsonError(res, 401, new Error('Authentication failed'));
  }
}

// True if the user owns the workspace or is a member of it.
async function userCanAccessWorkspace(userId, workspaceId) {
  if (!userId || !workspaceId) return false;
  const rows = await getDb().unsafe(
    `select 1 from workspaces where id = $1 and user_id = $2
     union all
     select 1 from workspace_members where workspace_id = $1 and user_id = $2
     limit 1`,
    [workspaceId, userId],
  );
  return rows.length > 0;
}

// Tables whose rows are scoped to a workspace and therefore subject to
// membership checks. Maps table -> how to find its workspace id.
const WORKSPACE_SCOPED_TABLES = new Set([
  'documents', 'chat_sessions', 'memory_facts', 'uploaded_files',
  'canvas_groups', 'canvas_objects', 'tasks', 'document_comments',
  'task_comments', 'document_versions', 'workspace_agents', 'agent_webhooks',
  'agent_connections', 'cursorbuddy_connection_keys', 'agent_jobs', 'agent_registrations', 'activity_events', 'workspace_members',
  'agent_memory_files', 'memory_file_comments', 'thread_items',
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
  // The file mirror is daemon-owned (written via the agent_memory_sync WS action),
  // so the REST/browser path is read-only; writes require manage to keep it server-side.
  agent_memory_files: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
  memory_file_comments: { select: 'read', insert: 'comment', update: 'comment', delete: 'comment' },
  workspace_members: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
  agent_webhooks: { select: 'manage', insert: 'manage', update: 'manage', delete: 'manage' },
  // External-agent registration approvals: reads are fine for any member, but
  // approving/creating/removing a registration is a manage-only action (the
  // dedicated routes enforce this) — without an explicit entry the generic CRUD
  // path would default insert/update/delete to 'write' and let editors approve
  // agents (M1, 2026-07 review).
  agent_registrations: { select: 'read', insert: 'manage', update: 'manage', delete: 'manage' },
  // Per-thread widget items (todo / plan / blocker). Any member with write can
  // add/toggle; agents write via the same REST path with their run_agents cap.
  thread_items: DEFAULT_TABLE_ACCESS,
};

function findFilterValue(filters, column) {
  if (!Array.isArray(filters)) return undefined;
  const f = filters.find((x) => x && x.column === column && x.operator === 'eq');
  return f ? f.value : undefined;
}

// Resolve the workspace id a db operation targets, looking through parent rows
// when the table/filter doesn't carry workspace_id directly. Returns
// { workspaceId } when determinable, or { unscoped: true } when access can't be
// constrained to a single workspace (caller decides how strict to be).
async function resolveOperationWorkspace(table, { values, filters }) {
  // Insert: workspace id (or a parent that has one) comes from the row values.
  if (values) {
    if (values.workspace_id) return { workspaceId: values.workspace_id };
    if (table === 'messages' && values.session_id) {
      const rows = await getDb().unsafe('select workspace_id from chat_sessions where id = $1 limit 1', [values.session_id]);
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
      const rows = await getDb().unsafe(lookup.sql, [v]);
      if (rows[0]) return { workspaceId: rows[0].workspace_id };
    }
  }
  // Row id filter on a workspace-scoped table → look up that row's workspace.
  const idVal = findFilterValue(filters, 'id');
  if (idVal && WORKSPACE_SCOPED_TABLES.has(table)) {
    const rows = await getDb().unsafe(`select workspace_id from ${quoteIdent(table)} where id = $1 limit 1`, [idVal]);
    if (rows[0]) return { workspaceId: rows[0].workspace_id };
  }
  return { unscoped: true };
}

// Enforce workspace membership for a db operation. Throws { status, message }
// on denial. Unscoped operations on scoped tables are rejected so a caller
// can't read/modify across all workspaces by omitting the filter.
// eslint-disable-next-line no-unused-vars -- superseded by enforceDbOperationAccess; kept pending confirmation it is fully dead
async function enforceWorkspaceAccess(userId, table, payload) {
  if (!WORKSPACE_SCOPED_TABLES.has(table) && table !== 'messages') return;
  const resolved = await resolveOperationWorkspace(table, payload);
  if (resolved.unscoped) {
    const err = new Error('A workspace filter is required for this operation');
    err.status = 400;
    throw err;
  }
  const ok = await userCanAccessWorkspace(userId, resolved.workspaceId);
  if (!ok) {
    const err = new Error('You do not have access to this workspace');
    err.status = 403;
    throw err;
  }
}

async function getWorkspaceRole(userId, workspaceId) {
  if (!userId || !workspaceId) return null;
  const ownerRows = await getDb().unsafe('select 1 from workspaces where id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
  if (ownerRows.length > 0) return 'owner';
  const memberRows = await getDb().unsafe('select role from workspace_members where workspace_id = $1 and user_id = $2 limit 1', [workspaceId, userId]);
  return memberRows[0]?.role || null;
}

function roleHasWorkspaceCapability(role, capability) {
  return Boolean(WORKSPACE_ROLE_CAPABILITIES[role]?.has(capability));
}

function canMutateWorkspace(role) {
  return roleHasWorkspaceCapability(role, 'write');
}

function canManageWorkspace(role) {
  return roleHasWorkspaceCapability(role, 'manage');
}

function capabilityForDbOperation(table, action) {
  const access = DB_TABLE_ACCESS[table];
  return access?.[action] || (action === 'select' ? 'read' : 'write');
}

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function enforceWorkspaceRole(userId, workspaceId, mode) {
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!role) throw forbidden('You do not have access to this workspace');
  if (!roleHasWorkspaceCapability(role, mode)) {
    if (mode === 'manage') {
      throw forbidden('You do not have permission to manage this workspace');
    }
    if (mode === 'write') {
      throw forbidden('You do not have permission to change this workspace');
    }
    if (mode === 'comment') {
      throw forbidden('You do not have permission to comment in this workspace');
    }
    if (mode === 'run_agents') {
      throw forbidden('You do not have permission to run agents in this workspace');
    }
    throw forbidden('You do not have permission to access this workspace');
  }
}

async function resolveWorkspaceRowById(id) {
  if (!id) return null;
  const rows = await getDb().unsafe('select id from workspaces where id = $1 limit 1', [id]);
  return rows[0]?.id || null;
}

// Parent-reference columns that define a child row's tenancy. An UPDATE may set
// these (e.g. moving a canvas object between groups) but only to a parent in the
// SAME workspace as the source row. Mirror of shared/backend-core.mjs.
const UPDATE_PARENT_REF_LOOKUPS = {
  session_id: 'select workspace_id from chat_sessions where id = $1 limit 1',
  document_id: 'select workspace_id from documents where id = $1 limit 1',
  task_id: 'select workspace_id from tasks where id = $1 limit 1',
  group_id: 'select workspace_id from canvas_groups where id = $1 limit 1',
};

// H1 (2026-07 review): reject an UPDATE whose `values` would move/inject the row
// into a workspace other than the one it currently belongs to.
async function assertUpdateKeepsTenancy(sourceWorkspaceId, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return;
  const src = String(sourceWorkspaceId);
  if (values.workspace_id != null && String(values.workspace_id) !== src) {
    throw forbidden('Cannot move a row to another workspace');
  }
  for (const [col, sql] of Object.entries(UPDATE_PARENT_REF_LOOKUPS)) {
    const v = values[col];
    if (v == null) continue; // absent, or explicitly cleared to null, is fine
    const rows = await getDb().unsafe(sql, [v]);
    const targetWs = rows[0]?.workspace_id;
    if (!targetWs || String(targetWs) !== src) {
      throw forbidden('Cannot reassign a row to another workspace');
    }
  }
}

function operationRows(values) {
  if (!values) return [];
  return Array.isArray(values) ? values : [values];
}

async function enforceDbOperationAccess(userId, table, action, payload) {
  if (table === 'app_users') {
    const idFilter = findFilterValue(payload.filters, 'id');
    if (action === 'select' && idFilter && String(idFilter) === String(userId)) return;
    throw forbidden('Direct user table access is not allowed');
  }

  if (table === 'workspaces') {
    if (action === 'select') return;
    if (action === 'insert') {
      for (const row of operationRows(payload.values)) {
        if (row && row.user_id && String(row.user_id) !== String(userId)) {
          throw forbidden('Cannot create a workspace for another user');
        }
      }
      return;
    }
    const workspaceId = findFilterValue(payload.filters, 'id') || await resolveWorkspaceRowById(findFilterValue(payload.filters, 'workspace_id'));
    if (!workspaceId) throw badRequest('A workspace id filter is required for this operation');
    await enforceWorkspaceRole(userId, workspaceId, 'manage');
    return;
  }

  if (!WORKSPACE_SCOPED_TABLES.has(table) && table !== 'messages') return;

  const mode = capabilityForDbOperation(table, action);

  // UPDATE: authorize the SOURCE row's workspace (resolved from filters), then
  // verify `values` can't move the row into a different workspace (H1).
  if (action === 'update') {
    const resolved = await resolveOperationWorkspace(table, { filters: payload.filters });
    if (resolved.unscoped) throw badRequest('A workspace filter is required for this operation');
    await enforceWorkspaceRole(userId, resolved.workspaceId, mode);
    await assertUpdateKeepsTenancy(resolved.workspaceId, payload.values);
    return;
  }

  for (const row of operationRows(payload.values)) {
    if (!row || typeof row !== 'object') continue;
    const resolved = await resolveOperationWorkspace(table, { values: row });
    if (resolved.unscoped) throw badRequest('A workspace reference is required for this operation');
    await enforceWorkspaceRole(userId, resolved.workspaceId, mode);
    await assertUpdateKeepsTenancy(resolved.workspaceId, row);
  }

  if (operationRows(payload.values).length === 0) {
    const resolved = await resolveOperationWorkspace(table, { filters: payload.filters });
    if (resolved.unscoped) throw badRequest('A workspace filter is required for this operation');
    await enforceWorkspaceRole(userId, resolved.workspaceId, mode);
  }
}

function getDatabaseUrl() {
  loadEnvFile();
  return process.env.DATABASE_URL;
}

function getAnthropicApiKey(workspaceId = null) {
  // DB-stored key first (set via Settings → Secret keys), env var as fallback.
  return resolveSecret('ANTHROPIC_API_KEY', workspaceId);
}

async function ensureRuntimeSchema() {
  const db = getDb();
  await db.unsafe(`
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name text DEFAULT '';
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS accent_color text DEFAULT '';
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;

    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS local_path text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS project_kind text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_root text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_remote text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS background_opacity numeric DEFAULT 0.42;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS background_image text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS folder text DEFAULT 'General';
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS participants jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS conversation_mode text NOT NULL DEFAULT 'auto';
    ALTER TABLE chat_sessions ALTER COLUMN conversation_mode SET DEFAULT 'auto';
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS max_agent_turns integer NOT NULL DEFAULT 10;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS auto_rounds integer NOT NULL DEFAULT 3;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS parent_message_id uuid REFERENCES messages(id) ON DELETE CASCADE;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_parent_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_at timestamptz;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_folder ON chat_sessions(workspace_id, folder);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(workspace_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent_message ON chat_sessions(parent_message_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_split_parent ON chat_sessions(split_parent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_deleted ON chat_sessions(workspace_id, deleted_at);

    ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder text DEFAULT 'General';
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(workspace_id, folder);

    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS soul text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS instructions text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS tools jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS skills jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS handle text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS openpet_avatar_id text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS accent_color text DEFAULT '#00a95c';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS connect_token_hash text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS run_mode text NOT NULL DEFAULT 'builtin';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS permission_mode text NOT NULL DEFAULT 'default';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE workspace_agents ALTER COLUMN avatar SET DEFAULT 'AI';
    CREATE INDEX IF NOT EXISTS idx_workspace_agents_handle ON workspace_agents(workspace_id, handle);
    CREATE INDEX IF NOT EXISTS idx_workspace_agents_connect_token_hash ON workspace_agents(connect_token_hash);

    CREATE TABLE IF NOT EXISTS agent_webhooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      name text NOT NULL DEFAULT 'Webhook',
      token text NOT NULL UNIQUE,
      enabled boolean NOT NULL DEFAULT true,
      last_triggered_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_webhooks_workspace_id ON agent_webhooks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent_id ON agent_webhooks(agent_id);
    ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

    CREATE TABLE IF NOT EXISTS agent_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT 'Agent',
      handle text NOT NULL DEFAULT '',
      host text DEFAULT '',
      cwd text DEFAULT '',
      status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'busy')),
      metadata jsonb DEFAULT '{}'::jsonb,
      capabilities jsonb DEFAULT '{}'::jsonb,
      connected_at timestamptz DEFAULT now(),
      last_seen_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS capabilities jsonb DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_agent_connections_workspace_id ON agent_connections(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_connections_agent_id ON agent_connections(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_connections_status ON agent_connections(workspace_id, status);

    CREATE TABLE IF NOT EXISTS cursorbuddy_connection_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      key_hash text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'CursorBuddy runtime',
      surface text NOT NULL DEFAULT 'machine',
      scope text NOT NULL DEFAULT 'machine',
      domain text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'claimed', 'expired', 'revoked')),
      metadata jsonb DEFAULT '{}'::jsonb,
      expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
      claimed_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_cursorbuddy_connection_keys_workspace ON cursorbuddy_connection_keys(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_cursorbuddy_connection_keys_hash ON cursorbuddy_connection_keys(key_hash);

    CREATE TABLE IF NOT EXISTS agent_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
      session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
      message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      created_by uuid,
      prompt text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
      response text DEFAULT '',
      error text DEFAULT '',
      metadata jsonb DEFAULT '{}'::jsonb,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_workspace_id ON agent_jobs(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent_id ON agent_jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_session_id ON agent_jobs(session_id);

    -- Per-thread widget items surfaced in the chat's right-hand widget rail.
    -- kind: 'todo' | 'plan' | 'blocker'. Todos/plan use status open|done;
    -- blockers use open|answered|dismissed and can carry a human response.
    -- message_id optionally anchors an item to a message for jump-to-scroll.
    CREATE TABLE IF NOT EXISTS thread_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      kind text NOT NULL DEFAULT 'todo' CHECK (kind IN ('todo', 'plan', 'blocker')),
      content text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'open',
      order_index double precision NOT NULL DEFAULT 0,
      message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      response text DEFAULT '',
      created_by uuid,
      created_by_agent text DEFAULT '',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_thread_items_session ON thread_items(session_id, kind, order_index);
    CREATE INDEX IF NOT EXISTS idx_thread_items_workspace ON thread_items(workspace_id);

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_kind text DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id text DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name text DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions jsonb DEFAULT '{}';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
    CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(session_id, deleted_at);

    ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS content_sha256 text DEFAULT '';
    ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE canvas_groups ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE canvas_objects ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE document_comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS memory_dir text DEFAULT '';

    CREATE TABLE IF NOT EXISTS agent_memory_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
      path text NOT NULL,
      kind text NOT NULL DEFAULT 'memory',
      summary text DEFAULT '',
      content_cache text DEFAULT '',
      byte_size bigint DEFAULT 0,
      editable boolean NOT NULL DEFAULT false,
      last_synced timestamptz DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (agent_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memory_files_workspace_id ON agent_memory_files(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_files_agent_id ON agent_memory_files(agent_id);

    CREATE TABLE IF NOT EXISTS memory_file_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
      path text NOT NULL,
      user_id uuid,
      parent_id uuid REFERENCES memory_file_comments(id) ON DELETE CASCADE,
      content text NOT NULL,
      anchor_text text DEFAULT '',
      resolved boolean DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_memory_file_comments_workspace_id ON memory_file_comments(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_memory_file_comments_agent_path ON memory_file_comments(agent_id, path);
    CREATE INDEX IF NOT EXISTS idx_memory_file_comments_parent_id ON memory_file_comments(parent_id);
  `);
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_secrets (
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      key text NOT NULL,
      value text NOT NULL DEFAULT '',
      updated_by uuid,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (workspace_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_secrets_workspace_id ON workspace_secrets(workspace_id);
  `);
  await db.unsafe(`
    ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
    ALTER TABLE workspace_members
      ADD CONSTRAINT workspace_members_role_check
      CHECK (role IN ('owner', 'admin', 'editor', 'commenter', 'viewer'));
  `);
  await db.unsafe(`
    DO $$
    DECLARE constraint_name text;
    BEGIN
      SELECT con.conname INTO constraint_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'canvas_objects'
        AND con.conname = 'canvas_objects_type_check'
      LIMIT 1;

      IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE canvas_objects DROP CONSTRAINT %I', constraint_name);
      END IF;

      ALTER TABLE canvas_objects
        ADD CONSTRAINT canvas_objects_type_check
        CHECK (type IN ('rect', 'ellipse', 'diamond', 'arrow', 'line', 'pen', 'text', 'image', 'video', 'file', 'applet', 'sticky_note'));
    END $$;
  `);
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_invites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      email text DEFAULT '',
      role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
      created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      accepted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
      accepted_at timestamptz,
      expires_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_id ON workspace_invites(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites(token);

    -- MCP "connect a client" model. ONE workspace token (or your agensis login, or an
    -- invite link) authenticates an MCP client; it then calls register_agent to become an
    -- agent (new or existing). You approve via a popup unless auto-approve / invite link.
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_token_hash text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_auto_approve boolean NOT NULL DEFAULT false;
    -- An agent becomes claimable over MCP once its registration is approved.
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS mcp_approved boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS agent_registrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      requested_handle text DEFAULT '',
      requested_name text DEFAULT '',
      client_label text DEFAULT '',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      decided_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_agent_registrations_workspace ON agent_registrations(workspace_id, status);
  `);
  // C3 — make message-activity logging idempotent. A retried daemon finalization
  // re-logs the same message id; the partial unique index lets the logging insert
  // use ON CONFLICT DO NOTHING (see logMessageActivity). Wrapped on its own so a
  // failure (e.g. pre-existing duplicates) never blocks the rest of the schema
  // bootstrap. Mirrored by supabase/migrations and backend.mjs.
  try {
    await db.unsafe(`
      DELETE FROM activity_events a
      USING activity_events b
      WHERE a.event_type = 'message_sent'
        AND a.entity_type = 'message'
        AND b.event_type = 'message_sent'
        AND b.entity_type = 'message'
        AND a.entity_id IS NOT NULL
        AND a.entity_id = b.entity_id
        AND a.ctid > b.ctid;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_events_message_sent
        ON activity_events (entity_id)
        WHERE event_type = 'message_sent' AND entity_type = 'message';
    `);
  } catch (error) {
    console.warn('[backend] activity_events idempotency index migration failed:', error.message || error);
  }

  // M15 — enforce at most one ACTIVE (queued/running) job per (session, agent)
  // so two concurrent triggers can't produce duplicate agent turns even across
  // Fly instances (the in-process guard hasActiveBurstJob is per-process only).
  // Dedupe any pre-existing duplicates first (keep the newest) so the unique
  // index can be created; wrapped on its own so a failure never blocks boot,
  // and the app stays correct via hasActiveBurstJob if the index isn't present.
  try {
    await db.unsafe(`
      DELETE FROM agent_jobs a
      USING agent_jobs b
      WHERE a.status IN ('queued','running')
        AND b.status IN ('queued','running')
        AND a.session_id = b.session_id
        AND a.agent_id = b.agent_id
        AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.ctid > b.ctid));
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_jobs_active_per_session_agent
        ON agent_jobs (session_id, agent_id)
        WHERE status IN ('queued','running');
    `);
  } catch (error) {
    console.warn('[backend] agent_jobs active-job unique index migration failed:', error.message || error);
  }
}

function getDb() {
  if (db) return db;
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  db = postgres(databaseUrl, {
    max: 10,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
  });
  return db;
}

function quoteIdent(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid identifier: ${value}`);
  }
  return `"${value}"`;
}

function ensureTable(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Table not allowed: ${table}`);
  }
  return quoteIdent(table);
}

function normalizeColumns(columns) {
  if (!columns || columns === '*') return '*';
  const list = String(columns).split(',').map((column) => column.trim()).filter(Boolean);
  if (list.length === 0) return '*';
  return list.map(quoteIdent).join(', ');
}

function isJsonColumn(table, column) {
  return Boolean(JSON_COLUMNS_BY_TABLE[table]?.has(column));
}

function invalidJsonValue(table, column) {
  const err = new Error(`${table}.${column} must be valid JSON`);
  err.status = 400;
  return err;
}

function normalizeJsonParam(table, column, value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      throw invalidJsonValue(table, column);
    }
  }
  return JSON.stringify(value);
}

function bindDbParam(params, table, column, value) {
  const jsonColumn = isJsonColumn(table, column);
  params.push(jsonColumn ? normalizeJsonParam(table, column, value) : (value ?? null));
  return `$${params.length}${jsonColumn ? '::jsonb' : ''}`;
}

function buildWhereClause(filters = [], params = []) {
  if (!Array.isArray(filters) || filters.length === 0) {
    return { clause: '', params };
  }

  const clauses = [];
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object') continue;
    const operator = filter.operator || 'eq';
    if (operator === 'eq') {
      params.push(filter.value ?? null);
      clauses.push(`${quoteIdent(filter.column)} = $${params.length}`);
      continue;
    }
    if (operator === 'not') {
      if (filter.subOperator !== 'is' || filter.value !== null) {
        throw new Error(`Unsupported not filter: ${filter.subOperator} ${filter.value}`);
      }
      clauses.push(`${quoteIdent(filter.column)} IS NOT NULL`);
      continue;
    }
    throw new Error(`Unsupported filter operator: ${operator}`);
  }

  return {
    clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

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

function buildOrderClause(orderBy) {
  if (!orderBy || !orderBy.column) return '';
  const direction = orderBy.ascending === false ? 'DESC' : 'ASC';
  return ` ORDER BY ${quoteIdent(orderBy.column)} ${direction}`;
}

function mapDbError(error) {
  // Never return Postgres `detail` to clients — it can contain stored column
  // values and schema internals (e.g. the row that violated a unique/foreign-key
  // constraint). Log it server-side and expose only the message + SQLSTATE code.
  // (L2, 2026-07 review.)
  if (error?.detail) {
    console.error('[db-error]', { code: error.code, detail: error.detail, message: error.message });
  }
  return {
    message: error?.message || 'Database error',
    code: error?.code || null,
  };
}

function jsonError(res, status, error) {
  res.status(status).json({ data: null, error: mapDbError(error) });
}

// ============================================================
// H4 — Rate limiting (in-memory fixed window).
// Canonical implementation lives in shared/backend-core.mjs; this CJS server is
// self-contained (it keeps its own copies of the security helpers, e.g.
// enforceDbOperationAccess) so the limiter is duplicated here rather than
// importing the ESM core. Keep the two in sync.
// NOTE: in-memory state is per-process — a multi-instance deploy needs a SHARED
// store (Redis, etc.) for a globally accurate limit.
// ============================================================
function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  let lastSweep = 0;
  // H2 (2026-07 review): evict expired entries so a flood of distinct keys
  // (e.g. spoofed IPs before the keying fix, or simply many users over time)
  // can't grow the Map without bound. Amortized: sweep at most once per window.
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
    return { allowed, retryAfterMs: allowed ? 0 : Math.max(0, entry.resetAt - now) };
  }
  return { check };
}

const aiChatRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const dispatchRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const webhookRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const mcpRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const skillRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
// Plan 004 — auth hardening: signin is keyed per-email (matches the client's
// documented "5 attempts" lockout intent); signup is keyed per-IP and looser,
// to slow down bulk account creation without punishing normal signup retries.
const signinRateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });
// Per-IP FAILED-attempt limiter (L2 review): bounds credential-stuffing across
// many different emails from one host, which the per-email limiter can't catch.
const signinIpFailureLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const signupRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
// F9: curb email-enumeration via lookup_user_by_email — per-caller budget, on
// top of the 'manage' capability gate below.
const emailLookupRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// Returns true (and writes a 429 with Retry-After) when the key is over budget.
function rateLimitBlocked(res, limiter, key) {
  const result = limiter.check(String(key || 'unknown'));
  if (result.allowed) return false;
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({ data: null, error: { message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' } });
  return true;
}

function clientIpFromReq(req) {
  // H2 (2026-07 review): the leftmost X-Forwarded-For segment is supplied by the
  // client and trivially spoofable, so it must never key a rate limiter. Fly
  // sets Fly-Client-IP to the real client address at its edge and overwrites any
  // incoming value, so prefer it; fall back to the socket peer for local/non-Fly
  // runs (where there is no untrusted proxy in front).
  const flyClientIp = String(req.headers?.['fly-client-ip'] || '').trim();
  if (flyClientIp) return flyClientIp;
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

// ============================================================
// Plan 004 — auth hardening: server-side password policy.
// Mirrors src/lib/passwordPolicy.ts's `evaluatePassword` rule (min length +
// character-class count) and shared/backend-core.mjs's
// `evaluatePasswordServerSide` (the Netlify path's copy). Kept as an inline
// CJS copy here for the same reason this file duplicates its rate limiter
// and enforceDbOperationAccess rather than importing the ESM core — keep all
// three in sync if this policy changes.
// ============================================================
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

function workspaceIdFromSettingsRequest(req) {
  return String(req.query?.workspaceId || req.body?.workspace_id || req.body?.workspaceId || '').trim();
}

function settingsWorkspaceIdFromRequest(req) {
  const workspaceId = workspaceIdFromSettingsRequest(req);
  return workspaceId === 'base' ? '' : workspaceId;
}

const scryptAsync = promisify(crypto.scrypt);

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPassword(password, passwordHash) {
  if (!passwordHash || !passwordHash.includes(':')) return false;
  const [salt, storedHash] = passwordHash.split(':');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  const computed = Buffer.from(hash, 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  // timingSafeEqual throws on a length mismatch (legacy/foreign hash formats);
  // treat any mismatch as a failed verification instead of crashing the request.
  if (computed.length !== stored.length) return false;
  return crypto.timingSafeEqual(computed, stored);
}

function resolveAnthropicModel(model) {
  const value = String(model || '').trim();
  if (!value || value === 'auto') return DEFAULT_AI_MODEL;
  return value;
}

function normalizeAgentPermissionMode(value) {
  const mode = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (['yolo', 'no_sandbox', 'danger', 'danger_full_access', 'dangerously_skip_permissions'].includes(mode)) return 'yolo';
  if (['accept_edits', 'acceptedits', 'auto_approve', 'auto_approve_edits'].includes(mode)) return 'accept_edits';
  return 'default';
}

function agentPermissionFlags(permissionMode) {
  return normalizeAgentPermissionMode(permissionMode) === 'yolo' ? ['--no-sandbox', '--yolo'] : [];
}

function formatElapsedMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function slugHandle(value) {
  return String(value || 'agent')
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

function hashAgentToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

// Invite-token lookup params (L4). $1 is always the hash of the presented token
// (matches new hashed invites). $2 is the raw presented value ONLY when it is
// NOT itself a 64-hex hash — so a real legacy plaintext token (32-char base64url)
// still matches its stored plaintext, but a stored hash leaked from the DB and
// submitted verbatim gets hashed again and matches nothing. Without this guard,
// `token in (plaintext, hash)` let a leaked stored hash authenticate as itself.
function inviteTokenLookupParams(token) {
  const hashed = hashAgentToken(token);
  const legacy = /^[a-f0-9]{64}$/i.test(String(token || '')) ? hashed : token;
  return [hashed, legacy];
}

function createAgentConnectToken() {
  return `aga_${crypto.randomBytes(32).toString('base64url')}`;
}

function createCursorBuddyConnectionKey(surface = 'machine') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(18);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  const normalizedSurface = String(surface || 'machine')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'machine';
  return `cbk_${normalizedSurface}_${suffix}`;
}

function normalizeCursorBuddySurface(value) {
  const surface = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (['website_avatar', 'browser_extension', 'extension', 'local_cli', 'cli', 'desktop_app', 'desktop', 'machine', 'embedded_site', 'embedded'].includes(surface)) {
    if (surface === 'extension') return 'browser_extension';
    if (surface === 'cli') return 'local_cli';
    if (surface === 'desktop') return 'desktop_app';
    if (surface === 'embedded') return 'embedded_site';
    return surface;
  }
  return 'machine';
}

function normalizeCursorBuddyScope(value) {
  const scope = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (['machine', 'global', 'domain', 'embedded', 'workspace'].includes(scope)) return scope;
  return 'machine';
}

function normalizeCursorBuddyDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '')
    .slice(0, 255);
}

function publicWorkspace(row) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    local_path: row.local_path || '',
    project_kind: row.project_kind || '',
    git_root: row.git_root || '',
    git_remote: row.git_remote || '',
    role: row.role || 'viewer',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicCursorBuddyConnectionKey(row) {
  if (!row) return row;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    created_by: row.created_by,
    name: row.name,
    surface: row.surface,
    scope: row.scope,
    domain: row.domain,
    status: row.status,
    metadata: parseJsonObject(row.metadata),
    expires_at: row.expires_at,
    claimed_at: row.claimed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function ensureCursorBuddyAgentForKey(connectionKey, claim = {}) {
  if (connectionKey?.agent_id) {
    const rows = await getDb().unsafe(
      'select * from workspace_agents where id = $1 and workspace_id = $2 limit 1',
      [connectionKey.agent_id, connectionKey.workspace_id],
    );
    if (rows[0]) return rows[0];
  }

  const surface = normalizeCursorBuddySurface(connectionKey?.surface || claim.surface);
  const scope = normalizeCursorBuddyScope(connectionKey?.scope || claim.scope);
  const label = String(connectionKey?.name || claim.name || 'CursorBuddy runtime').trim().slice(0, 80) || 'CursorBuddy runtime';
  const handleBase = scope === 'domain' && connectionKey?.domain
    ? `cursorbuddy-${connectionKey.domain.replace(/[^a-z0-9]+/g, '-')}`
    : `cursorbuddy-${surface.replace(/_/g, '-')}`;
  const handle = slugHandle(handleBase);
  const existingRows = await getDb().unsafe(
    'select * from workspace_agents where workspace_id = $1 and handle = $2 limit 1',
    [connectionKey.workspace_id, handle],
  );
  if (existingRows[0]) return existingRows[0];

  const metadata = {
    runtime: 'cursorbuddy',
    surface,
    scope,
    domain: connectionKey?.domain || '',
    host: String(claim.host || '').trim().slice(0, 160),
    cwd: String(claim.cwd || '').trim().slice(0, 500),
  };
  const rows = await getDb().unsafe(
    `insert into workspace_agents
       (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, created_by, tools, skills)
     values
       ($1, $2, $3, $4, $5, 'auto', 'daemon', $6, 'AI', '#ffe04a', true, $7, $8::jsonb, $9::jsonb)
     returning *`,
    [
      connectionKey.workspace_id,
      label,
      handle,
      `CursorBuddy ${surface.replace(/_/g, ' ')} runtime connected through Agensis.`,
      'You are CursorBuddy, a local-machine agent connected through Agensis. Route browser, desktop, and embedded-site context through the hub, use local source paths when authorized, and keep all actions logged.',
      normalizeAgentPermissionMode(claim.permissionMode || claim.permission_mode || 'default'),
      connectionKey.created_by || null,
      JSON.stringify([{ type: 'runtime', name: 'cursorbuddy', metadata }]),
      JSON.stringify(['cursorbuddy', 'local-source-edit', 'surface-routing', 'agent-mesh']),
    ],
  );
  notifyDbSubscribers('workspace_agents', 'INSERT', rows);
  return rows[0];
}

function cursorBuddyProviderAgentMetadata(body = {}, userId = '') {
  const requestMetadata = parseJsonObject(body?.metadata);
  const page = parseJsonObject(body?.page || requestMetadata.page);
  const client = parseJsonObject(body?.client || requestMetadata.client);
  const manifest = parseJsonObject(body?.manifest || requestMetadata.manifest);
  const runtime = parseJsonObject(requestMetadata.runtime);
  const surface = normalizeCursorBuddySurface(body?.surface || runtime.surface || requestMetadata.surface);
  const scope = normalizeCursorBuddyScope(body?.scope || requestMetadata.scope);
  const domain = normalizeCursorBuddyDomain(body?.domain || page.hostname || requestMetadata.domain);
  const websiteSource = String(body?.websiteSource || requestMetadata.websiteSource || page.url || '').trim().slice(0, 2048);
  return {
    surface,
    scope,
    domain,
    metadata: {
      ...requestMetadata,
      requestedBy: userId,
      setup: 'cursorbuddy-provider',
      provider: 'cursorbuddy',
      mode: 'built_in_provider',
      runtimeKind: String(body?.runtimeKind || requestMetadata.runtimeKind || 'cursorbuddy-provider').trim().slice(0, 80),
      websiteSource,
      page,
      client,
      manifest,
    },
  };
}

function mergeCursorBuddyProviderMetadata(existingAgent, nextMetadata) {
  const existingTool = parseJsonArray(existingAgent?.tools).find(tool => (
    tool && tool.type === 'provider' && tool.name === 'cursorbuddy'
  ));
  const previousMetadata = parseJsonObject(existingTool?.metadata);
  const merged = { ...previousMetadata, ...nextMetadata };
  if (!nextMetadata.websiteSource && previousMetadata.websiteSource) merged.websiteSource = previousMetadata.websiteSource;
  for (const key of ['page', 'client', 'manifest']) {
    const nextObject = parseJsonObject(nextMetadata[key]);
    const previousObject = parseJsonObject(previousMetadata[key]);
    if (Object.keys(nextObject).length === 0 && Object.keys(previousObject).length > 0) {
      merged[key] = previousObject;
    }
  }
  return merged;
}

async function ensureCursorBuddyProviderAgent({ workspaceId, userId, body = {} }) {
  const { surface, scope, domain, metadata } = cursorBuddyProviderAgentMetadata(body, userId);
  const resolvedScope = scope === 'domain' && domain ? 'domain' : scope === 'global' ? 'global' : 'workspace';
  metadata.providerScope = resolvedScope;
  const label = resolvedScope === 'domain'
    ? `CursorBuddy Provider ${domain}`
    : resolvedScope === 'global'
      ? 'CursorBuddy Provider Global'
      : 'CursorBuddy Provider Workspace';
  const handle = slugHandle(resolvedScope === 'domain'
    ? `cursorbuddy-provider-${domain.replace(/[^a-z0-9]+/g, '-')}`
    : resolvedScope === 'global'
      ? 'cursorbuddy-provider-global'
      : 'cursorbuddy-provider-workspace');
  const existingRows = await getDb().unsafe(
    'select * from workspace_agents where workspace_id = $1 and handle = $2 limit 1',
    [workspaceId, handle],
  );
  if (existingRows[0]) {
    const mergedMetadata = mergeCursorBuddyProviderMetadata(existingRows[0], metadata);
    const rows = await getDb().unsafe(
      `update workspace_agents
       set name = coalesce(nullif(name, ''), $2),
           description = $3,
           system_prompt = $4,
           model = 'auto',
           run_mode = 'builtin',
           permission_mode = 'default',
           enabled = true,
           tools = $5::jsonb,
           skills = $6::jsonb,
           updated_at = now(),
           version = coalesce(version, 0) + 1
       where id = $1
       returning *`,
      [
        existingRows[0].id,
        label,
        'Built-in CursorBuddy Provider agent for hosted Agensis inference.',
        'You are CursorBuddy Provider, a built-in Agensis agent for the CursorBuddy avatar. Use supplied browser, page, and site metadata to answer through the avatar. Prefer concise, directly useful guidance. Do not claim local machine access unless a local bridge is connected.',
        JSON.stringify([{ type: 'provider', name: 'cursorbuddy', metadata: mergedMetadata }]),
        JSON.stringify(['cursorbuddy', 'surface-routing', 'agent-mesh']),
      ],
    );
    notifyDbSubscribers('workspace_agents', 'UPDATE', rows);
    return rows[0];
  }

  const rows = await getDb().unsafe(
    `insert into workspace_agents
       (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, created_by, tools, skills)
     values
       ($1, $2, $3, $4, $5, 'auto', 'builtin', 'default', 'CB', '#6fd6e8', true, $6, $7::jsonb, $8::jsonb)
     returning *`,
    [
      workspaceId,
      label,
      handle,
      'Built-in CursorBuddy Provider agent for hosted Agensis inference.',
      'You are CursorBuddy Provider, a built-in Agensis agent for the CursorBuddy avatar. Use supplied browser, page, and site metadata to answer through the avatar. Prefer concise, directly useful guidance. Do not claim local machine access unless a local bridge is connected.',
      userId || null,
      JSON.stringify([{ type: 'provider', name: 'cursorbuddy', metadata }]),
      JSON.stringify(['cursorbuddy', 'surface-routing', 'agent-mesh']),
    ],
  );
  notifyDbSubscribers('workspace_agents', 'INSERT', rows);
  return rows[0];
}

async function resolveSetupWorkspace(userId, requestedWorkspaceId = '') {
  const requested = String(requestedWorkspaceId || '').trim();
  if (requested) {
    await enforceWorkspaceRole(userId, requested, 'manage');
    return requested;
  }

  const rows = await getDb().unsafe(
    `select w.id
     from workspaces w
     left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = $1
     where w.user_id = $1 or (wm.user_id = $1 and wm.role in ('owner', 'admin'))
     order by w.user_id = $1 desc, w.created_at asc
     limit 1`,
    [userId],
  );
  if (rows[0]?.id) return rows[0].id;

  const created = await getDb().unsafe(
    `insert into workspaces (name, description, icon, user_id)
     values ('Work', 'Primary Agensis workspace', 'home', $1)
     returning id`,
    [userId],
  );
  const workspaceId = created[0].id;
  await seedDefaultAgents(workspaceId, userId);
  return workspaceId;
}

async function ensurePrimaryDaemonAgent({ workspaceId, userId, handle, name, host, cwd, permissionMode }) {
  const resolvedHandle = slugHandle(handle || host || 'agensis');
  const resolvedName = String(name || host || 'Agensis daemon').trim().slice(0, 80) || 'Agensis daemon';
  const existing = await getDb().unsafe(
    'select * from workspace_agents where workspace_id = $1 and handle = $2 limit 1',
    [workspaceId, resolvedHandle],
  );
  if (existing[0]) return existing[0];

  const metadata = {
    runtime: 'agensis-cli',
    host: String(host || '').trim().slice(0, 160),
    cwd: String(cwd || '').trim().slice(0, 500),
    primary: true,
  };
  const rows = await getDb().unsafe(
    `insert into workspace_agents
       (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, created_by, tools, skills)
     values
       ($1, $2, $3, $4, $5, 'auto', 'daemon', $6, 'AI', '#ffe04a', true, $7, $8::jsonb, $9::jsonb)
     returning *`,
    [
      workspaceId,
      resolvedName,
      resolvedHandle,
      'Primary local Agensis CLI daemon for this machine.',
      'You are the primary local Agensis daemon for this machine. Coordinate local CLIs, CursorBuddy surfaces, browser extensions, desktop clients, and subagents through Agensis. Keep actions logged and route source edits through the authorized local checkout.',
      normalizeAgentPermissionMode(permissionMode || 'default'),
      userId,
      JSON.stringify([{ type: 'runtime', name: 'agensis-cli', metadata }]),
      JSON.stringify(['primary-daemon', 'cursorbuddy', 'agent-mesh', 'local-source-edit']),
    ],
  );
  notifyDbSubscribers('workspace_agents', 'INSERT', rows);
  return rows[0];
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeAgentBackendBaseUrl(value) {
  const baseUrl = normalizeBaseUrl(value);
  if (!baseUrl) return '';
  try {
    const url = new URL(baseUrl);
    if (
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0')
      && (url.port === '8888' || url.port === '5173')
    ) {
      url.protocol = 'http:';
      url.hostname = '127.0.0.1';
      url.port = String(DEFAULT_PORT);
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return baseUrl;
  }
}

function requestBaseUrl(req) {
  const publicUrl = normalizeBaseUrl(process.env.AGENSIS_PUBLIC_URL || process.env.PUBLIC_URL || '');
  if (publicUrl) return publicUrl;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = forwardedHost || req.get('host') || `127.0.0.1:${DEFAULT_PORT}`;
  return `${proto}://${host}`;
}

function shellQuote(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_/:.,=@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function codexPetAssetUrl(petDirName, assetName) {
  return `/backend/codex-pets/${encodeURIComponent(petDirName)}/${encodeURIComponent(assetName)}`;
}

function contentTypeForImageAsset(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function listCodexPets() {
  if (!fs.existsSync(CODEX_PETS_ROOT)) return [];
  return fs.readdirSync(CODEX_PETS_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      try {
        const petDir = path.resolve(CODEX_PETS_ROOT, entry.name);
        if (!isPathInside(CODEX_PETS_ROOT, petDir)) return [];
        const manifestPath = path.join(petDir, 'pet.json');
        if (!fs.existsSync(manifestPath)) return [];
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const spriteName = path.basename(String(manifest.spritesheetPath || 'spritesheet.webp'));
        if (!/\.(webp|png|gif|jpe?g)$/i.test(spriteName)) return [];
        const spritePath = path.resolve(petDir, spriteName);
        if (!isPathInside(petDir, spritePath) || !fs.existsSync(spritePath)) return [];
        const id = String(manifest.id || entry.name).trim() || entry.name;
        const assetUrl = codexPetAssetUrl(entry.name, spriteName);
        return [{
          id: `codex:${id}`,
          displayName: String(manifest.displayName || id),
          description: typeof manifest.description === 'string' ? manifest.description : 'Local Codex pet.',
          thumbnail: assetUrl,
          spritesheet: assetUrl,
          category: typeof manifest.category === 'string' ? manifest.category : 'codex',
          featured: false,
          original: false,
          source: 'codex',
        }];
      } catch {
        return [];
      }
    });
}

function mergeLocalCodexPets(openPetsPayload) {
  const remotePets = Array.isArray(openPetsPayload?.pets) ? openPetsPayload.pets : [];
  const codexPets = listCodexPets();
  return {
    ...(openPetsPayload && typeof openPetsPayload === 'object' ? openPetsPayload : {}),
    pets: [...codexPets, ...remotePets],
    pageSize: codexPets.length + remotePets.length,
  };
}

function agentConnectionCommand({ baseUrl, token, workspaceId, agentId, handle, name, model, permissionMode, profile = null }) {
  const resolvedModel = resolveAnthropicModel(model);
  const resolvedPermissionMode = normalizeAgentPermissionMode(permissionMode);
  const commandPermissionArgs = ['--permission-mode', shellQuote(resolvedPermissionMode)];
  const displayName = String(name || handle || 'Agensis Agent').trim() || 'Agensis Agent';
  const profileName = profile === false ? '' : slugHandle(profile || handle || displayName || 'agent');
  if (resolvedPermissionMode === 'yolo') {
    commandPermissionArgs.push('--no-sandbox');
  }
  const portableCommand = [
    'agensis',
    'connect',
    ...(profileName ? ['--profile', shellQuote(profileName)] : []),
    '--url',
    shellQuote(baseUrl),
    '--token',
    shellQuote(token),
    '--workspace',
    shellQuote(workspaceId),
    '--agent',
    shellQuote(agentId),
    '--handle',
    shellQuote(handle),
    '--name',
    shellQuote(displayName),
    '--model',
    shellQuote(resolvedModel),
    ...commandPermissionArgs,
  ].join(' ');
  return { localCommand: portableCommand, portableCommand };
}

// Mint a daemon connect token for an agent and return the full connect payload
// (command + one-time token + resolved settings). Shared by the HTTP
// connection-command route and the MCP `get_connect_command` tool so the two can
// never drift. Side effects: ROTATES the agent's connect token (any running daemon
// must be restarted with the new one) and flips run_mode to 'daemon' so a connected
// daemon takes over from the builtin server runner. Authorization is the caller's
// responsibility (HTTP route enforces manage role; MCP scopes by workspace token).
async function buildAgentConnectionCommand({ agentId, workspaceId = null, handle = null, model = null, permissionMode = null, baseUrl = null, profile = null } = {}) {
  const id = String(agentId || '').trim();
  if (!id) throw new Error('agentId is required');
  const rows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [id]);
  const agent = rows[0];
  if (!agent) throw new Error('Agent not found');
  if (workspaceId && agent.workspace_id !== workspaceId) throw new Error('Agent is not in this workspace');
  if (!isAgentEnabled(agent)) throw new Error('Agent is deactivated');
  const token = createAgentConnectToken();
  const resolvedHandle = slugHandle(handle || agent.handle || agent.name);
  const resolvedModel = resolveAnthropicModel(model || agent.model);
  // F7: do NOT silently escalate. An unspecified mode stays 'default' (least
  // privilege), matching the Netlify connect path (normalizeAgentPermissionMode).
  // A caller wanting full host access must pass permission_mode: 'yolo' explicitly.
  const resolvedPermissionMode = normalizeAgentPermissionMode(permissionMode || agent.permission_mode);
  const updateRows = await getDb().unsafe(
    `update workspace_agents
     set handle = $2,
         connect_token_hash = $3,
         run_mode = 'daemon',
         model = $4,
         permission_mode = $5,
         updated_at = now(),
         version = coalesce(version, 0) + 1
     where id = $1
     returning *`,
    [id, resolvedHandle, hashAgentToken(token), resolvedModel, resolvedPermissionMode],
  );
  notifyDbSubscribers('workspace_agents', 'UPDATE', updateRows);
  const resolvedBaseUrl = normalizeAgentBackendBaseUrl(baseUrl)
    || normalizeAgentBackendBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
    || '';
  const commands = agentConnectionCommand({
    baseUrl: resolvedBaseUrl,
    token,
    workspaceId: agent.workspace_id,
    agentId: id,
    handle: resolvedHandle,
    name: updateRows[0]?.name || agent.name,
    model: resolvedModel,
    permissionMode: resolvedPermissionMode,
    profile: profile === null ? resolvedHandle : profile,
  });
  return {
    agent: updateRows[0],
    handle: resolvedHandle,
    token,
    command: commands.portableCommand,
    localCommand: commands.localCommand,
    portableCommand: commands.portableCommand,
    baseUrl: resolvedBaseUrl,
    model: resolvedModel,
    permissionMode: resolvedPermissionMode,
    permission_mode: resolvedPermissionMode,
    permissionFlags: agentPermissionFlags(resolvedPermissionMode),
  };
}

async function verifyAgentConnectToken(token, req = null) {
  if (!token || typeof token !== 'string') return null;
  const rows = await getDb().unsafe(
    `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, model, handle, run_mode, memory_dir, permission_mode, version, enabled
     from workspace_agents
     where connect_token_hash = $1
     limit 1`,
    [hashAgentToken(token)],
  );
  let agent = rows[0];
  if (!agent && allowLoopbackAgentDevFallback(req, token)) {
    const { workspaceId, agentId } = agentIdsFromWsRequest(req);
    if (workspaceId && agentId) {
      const fallbackRows = await getDb().unsafe(
        `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, model, handle, run_mode, memory_dir, permission_mode, version, enabled
         from workspace_agents
         where id = $1 and workspace_id = $2
         limit 1`,
        [agentId, workspaceId],
      );
      agent = fallbackRows[0];
      if (agent) console.warn('[agensis] Using loopback-only dev agent auth fallback for', agent.id);
    }
  }
  if (!agent || !isAgentEnabled(agent)) return null;
  return {
    kind: 'agent',
    agentId: agent.id,
    workspaceId: agent.workspace_id,
    name: agent.name,
    handle: agent.handle || slugHandle(agent.name),
    agent: agentRuntimePayload(agent),
  };
}

// The SAME invite link a human accepts can be used by an MCP client as its Bearer.
// It grants workspace access; the client then works AS an agent (claim_job { as }).
async function verifyInviteToken(token) {
  if (!token || typeof token !== 'string') return null;
  const rows = await getDb().unsafe(
    // Dual-path (L4): new invites store the token hash; legacy invites store the
    // plaintext. Match either so both keep working during the transition.
    // F8 (P7): only a still-pending invite may authenticate as an MCP bearer — once
    // accepted (single-use consume in the /invites/:token/accept route) the link dies
    // as a live 14-day credential; the human keeps access via their own session token.
    `select id, workspace_id, email, role from workspace_invites
      where token in ($1, $2) and status = 'pending'
        and (expires_at is null or expires_at > now())
      limit 1`,
    inviteTokenLookupParams(token),
  );
  const invite = rows[0];
  if (!invite) return null;
  // An invite link is pre-authorization → a client joining through it is auto-approved.
  return { kind: 'invite', workspaceId: invite.workspace_id, inviteId: invite.id, name: invite.email || 'MCP client', autoApprove: true, role: invite.role };
}

// The one workspace MCP token (issued in settings). Authenticates any client into the
// workspace; the client then registers as an agent (popup approval unless auto-approve).
async function verifyWorkspaceMcpToken(token) {
  if (!token || typeof token !== 'string') return null;
  const rows = await getDb().unsafe(
    `select id, mcp_auto_approve from workspaces where mcp_token_hash = $1 and mcp_token_hash <> '' limit 1`,
    [hashAgentToken(token)],
  );
  const ws = rows[0];
  if (!ws) return null;
  return { kind: 'workspace', workspaceId: ws.id, name: 'MCP client', autoApprove: Boolean(ws.mcp_auto_approve) };
}

// "Agensis login": the client authenticates with the user's own auth token. Resolves to
// the workspace they own (the common case is one). Registrations still pop up for them.
async function verifyUserAuthMcpToken(token) {
  const userId = await verifyToken(token);
  if (!userId) return null;
  const rows = await getDb().unsafe(
    'select id, mcp_auto_approve from workspaces where user_id = $1 order by created_at asc limit 1',
    [userId],
  );
  const ws = rows[0];
  if (!ws) return null;
  return { kind: 'user', userId, workspaceId: ws.id, name: 'MCP client', autoApprove: Boolean(ws.mcp_auto_approve) };
}

// The MCP endpoint accepts, in priority order: a per-agent connect token (acts AS that
// agent), the one workspace MCP token, an invite link (auto-approve), or the user's
// agensis login. The latter three authenticate into the workspace; the client then
// calls register_agent to become an agent.
async function verifyMcpToken(token, req = null) {
  return (await verifyAgentConnectToken(token, req))
    || (await verifyWorkspaceMcpToken(token))
    || (await verifyInviteToken(token))
    || (await verifyUserAuthMcpToken(token));
}

function createWorkspaceMcpToken() {
  return `agw_${crypto.randomBytes(32).toString('base64url')}`;
}

// In-memory MCP presence: which agents have a live MCP poller right now. A client
// "working as @q" stamps this every time it polls claim_job; dispatch enqueues a pull
// job when an agent is present, and any number of polling clients drain that queue —
// so "3× Q all working as Q" just works. Process-local, like the daemon connection map.
const mcpAgentPresence = new Map(); // agentId -> last-seen ms
const MCP_PRESENCE_TTL_MS = 40_000;
function touchMcpPresence(agentId) {
  if (agentId) mcpAgentPresence.set(String(agentId), Date.now());
}
function hasMcpPresence(agentId) {
  const seen = mcpAgentPresence.get(String(agentId));
  return Boolean(seen && (Date.now() - seen) < MCP_PRESENCE_TTL_MS);
}

async function resolveWorkspaceAgentByHandle(workspaceId, handle) {
  if (!handle) return null;
  const wanted = slugHandle(handle);
  const rows = await getDb().unsafe(
    'select * from workspace_agents where workspace_id = $1 and enabled = true',
    [workspaceId],
  );
  return rows.find((a) => slugHandle(a.handle || a.name) === wanted) || null;
}

function agentTokenFromWsRequest(req) {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    return url.searchParams.get('agentToken') || '';
  } catch {
    return '';
  }
}

function agentIdsFromWsRequest(req) {
  try {
    const url = new URL(req?.url || '', 'http://localhost');
    return {
      workspaceId: url.searchParams.get('workspaceId') || '',
      agentId: url.searchParams.get('agentId') || '',
    };
  } catch {
    return { workspaceId: '', agentId: '' };
  }
}

function allowLoopbackAgentDevFallback(req, token) {
  if (process.env.NODE_ENV === 'production') return false;
  if (!String(token || '').startsWith('aga_')) return false;
  const remote = req?.socket?.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function publicAgentConnection(row) {
  if (!row) return row;
  const capabilities = parseJsonObject(row.capabilities);
  // Direct-reach (LAN ip/port) is daemon-only — NEVER publish it to browsers. It rides
  // agent_connections.capabilities.reach (agent-mesh F2) and reaches peer daemons only
  // via the hub peer_list channel (F7). Every browser-facing row (INSERT/UPDATE/DELETE
  // notify + REST) funnels through here, so strip it once, here.
  if (capabilities && typeof capabilities === 'object') delete capabilities.reach;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    name: row.name,
    handle: row.handle,
    host: row.host,
    cwd: row.cwd,
    status: row.status,
    metadata: parseJsonObject(row.metadata),
    capabilities,
    connected_at: row.connected_at,
    last_seen_at: row.last_seen_at,
    updated_at: row.updated_at,
  };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    // jsonb `string || string` concatenation corrupts an object into an array of
    // JSON-string fragments (seen on agent_jobs.metadata after a delta update).
    // Merge the fragments back so callers still read the original keys.
    return value.reduce((acc, part) => Object.assign(acc, parseJsonObject(part)), {});
  }
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parseJsonObject(parsed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isAgentEnabled(agent) {
  return agent?.enabled !== false;
}

async function disconnectAgentDaemons(agentId, workspaceId) {
  for (const [connectionId, entry] of [...connectedAgents.entries()]) {
    if (String(entry.agentId) !== String(agentId)) continue;
    if (String(entry.workspaceId) !== String(workspaceId)) continue;
    sendWs(entry.ws, { type: 'agent_disabled', reason: 'deactivated' });
    try { entry.ws.close(1008, 'Agent deactivated'); } catch { /* already closing */ }
    connectedAgents.delete(connectionId);
    await markAgentConnectionOffline(entry.ws);
  }
}

function findConnectedAgent(workspaceId, agentId, handle) {
  const wantedHandle = slugHandle(handle);
  for (const entry of connectedAgents.values()) {
    if (entry.workspaceId !== workspaceId) continue;
    if (entry.ws?.readyState !== 1) continue;
    if (agentId && entry.agentId === agentId) return entry;
    if (wantedHandle && slugHandle(entry.handle) === wantedHandle) return entry;
  }
  return null;
}

// Badge-only liveness check. A connection is "really" reachable only if its socket
// is OPEN *and* answered the last heartbeat ping (isAlive). This is deliberately
// MORE pessimistic than findConnectedAgent (which gates dispatch on readyState
// alone): a healthy socket sits isAlive===false for the few ms between ping-sent
// and pong, so gating dispatch on it would manufacture false "no daemon" replies.
// For the badge that momentary flicker is harmless and self-corrects on next read,
// while catching a half-open socket a full interval before 'close' fires.
// Single-process only — consistent with reconcileAgentConnectionsAtStartup, which
// already assumes one backend owns the connectedAgents map.
function isConnectionSocketLive(connectionId) {
  const entry = connectedAgents.get(connectionId);
  return Boolean(entry && entry.ws?.readyState === 1 && entry.ws.isAlive !== false);
}

// Whether a connection's socket is still OPEN (readyState only, deliberately NOT the
// pessimistic isAlive pong flag). Used by the burst-job guard to decide if a daemon
// job's worker still exists. Mirroring findConnectedAgent's readyState-only gate keeps
// the guard and dispatch in agreement: if the guard says "phantom, don't block", the
// same connection wouldn't count as dispatchable either — so no duplicate turn can
// slip through the brief ping/pong window. Single-process, like the connection map.
function isConnectionSocketOpen(connectionId) {
  const entry = connectedAgents.get(connectionId);
  return Boolean(entry && entry.ws?.readyState === 1);
}

function agentRuntimePayload(agent) {
  if (!agent) return null;
  const permissionMode = normalizeAgentPermissionMode(agent.permission_mode || agent.permissionMode);
  return {
    id: agent.id,
    workspace_id: agent.workspace_id,
    name: agent.name,
    avatar: agent.avatar || 'AI',
    openpet_avatar_id: agent.openpet_avatar_id || '',
    handle: agent.handle || slugHandle(agent.name),
    description: agent.description || '',
    system_prompt: agent.system_prompt || '',
    soul: agent.soul || '',
    instructions: agent.instructions || '',
    tools: parseJsonArray(agent.tools),
    skills: parseJsonArray(agent.skills),
    model: resolveAnthropicModel(agent.model),
    run_mode: agent.run_mode === 'daemon' ? 'daemon' : 'builtin',
    permissionMode,
    permission_mode: permissionMode,
    permissionFlags: agentPermissionFlags(permissionMode),
    version: Number(agent.version || 0),
    enabled: isAgentEnabled(agent),
  };
}

function refreshConnectedAgentConfigs(eventType, rows) {
  if (!['INSERT', 'UPDATE'].includes(eventType)) return;
  for (const row of rows || []) {
    if (!isAgentEnabled(row)) {
      void disconnectAgentDaemons(row.id, row.workspace_id);
      continue;
    }
    const agent = agentRuntimePayload(row);
    if (!agent?.id || !agent.workspace_id) continue;
    for (const entry of connectedAgents.values()) {
      if (String(entry.agentId) !== String(agent.id)) continue;
      if (String(entry.workspaceId) !== String(agent.workspace_id)) continue;
      entry.handle = agent.handle;
      entry.name = agent.name;
      entry.agent = agent;
      if (entry.ws?.agentAuth) {
        entry.ws.agentAuth = {
          ...entry.ws.agentAuth,
          name: agent.name,
          handle: agent.handle,
          agent,
        };
      }
      sendWs(entry.ws, { type: 'agent_config', agent });
    }
  }
}

function parseAgentMentions(content) {
  const out = [];
  const seen = new Set();
  const re = /(^|\s)@([a-zA-Z0-9_.-]{1,64})\b/g;
  let match;
  while ((match = re.exec(String(content || '')))) {
    const handle = slugHandle(match[2]);
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

function firstAgentMention(content) {
  return parseAgentMentions(content)[0] || '';
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

async function inferThreadAgentTarget(sessionId, threadParentId) {
  if (!sessionId || !threadParentId) return null;
  const rows = await getDb().unsafe(
    `select id, sender_kind, sender_id, sender_name, content, created_at
     from messages
     where session_id = $1
       and (id = $2 or thread_parent_id = $2)
     order by created_at desc`,
    [sessionId, threadParentId],
  );
  for (const row of rows) {
    if (row.sender_kind === 'agent' && validUuid(row.sender_id)) {
      return { agentId: String(row.sender_id), handle: slugHandle(row.sender_name || '') };
    }
  }
  for (const row of rows) {
    const handle = firstAgentMention(row.content);
    if (handle) return { agentId: '', handle };
  }
  return null;
}

function agentContextFromRow(agent, coParticipants = []) {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    handle: agent.handle || slugHandle(agent.name),
    description: agent.description || '',
    systemPrompt: agent.system_prompt || '',
    soul: agent.soul || '',
    instructions: agent.instructions || '',
    tools: parseJsonArray(agent.tools),
    skills: parseJsonArray(agent.skills),
    model: resolveAnthropicModel(agent.model),
    permissionMode: normalizeAgentPermissionMode(agent.permission_mode),
    coParticipants: Array.isArray(coParticipants) ? coParticipants : [],
  };
}

// --- Multi-agent channel orchestration ---------------------------------------

const CHANNEL_CONTEXT_LIMIT = 40;
const conversationLocks = new Set();

// eslint-disable-next-line no-unused-vars -- dead helper, not yet wired up; tracked for removal separately
function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isAgentPlaceholder(row) {
  return row.sender_kind === 'agent' && /^Thinking \d/.test(textFromValue(row.content).trim());
}

// eslint-disable-next-line no-unused-vars -- dead helper, not yet wired up; tracked for removal separately
function dedupeAgentsById(agents) {
  const seen = new Set();
  const out = [];
  for (const agent of agents) {
    const id = String(agent?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(agent);
  }
  return out;
}

function directAgentParticipantFromSession(session) {
  const agentParticipants = parseJsonArray(session?.participants)
    .filter((participant) => participant && participant.kind === 'agent' && (participant.agent_id || participant.handle));
  if (agentParticipants.length === 0) return null;
  return agentParticipants.find((participant) => participant.direct) || (agentParticipants.length === 1 ? agentParticipants[0] : null);
}

// Comment tables that can @mention an agent, and how to describe the thing the
// comment is anchored to (so the agent's DM ping links back to the source).
const COMMENT_MENTION_TABLES = {
  task_comments: {
    anchorColumn: 'task_id',
    describe: async (row) => {
      const t = await getDb().unsafe('select title from tasks where id = $1 limit 1', [row.task_id]).catch(() => []);
      const title = t[0]?.title ? `"${t[0].title}"` : `#${String(row.task_id).slice(0, 8)}`;
      return { label: `task ${title}`, link: `agensis://task/${row.task_id}` };
    },
  },
  document_comments: {
    anchorColumn: 'document_id',
    describe: async (row) => {
      const d = await getDb().unsafe('select title from documents where id = $1 limit 1', [row.document_id]).catch(() => []);
      const title = d[0]?.title ? `"${d[0].title}"` : `#${String(row.document_id).slice(0, 8)}`;
      return { label: `document ${title}`, link: `agensis://document/${row.document_id}` };
    },
  },
  memory_file_comments: {
    anchorColumn: 'agent_id',
    describe: async (row) => ({
      label: `memory file "${row.path}"`,
      link: `agensis://memory/${row.agent_id}/${encodeURIComponent(String(row.path || ''))}`,
    }),
  },
};

// Resolve (or lazily create) the human↔agent Direct message session for an agent.
// Mirrors the client's find-or-create in App.tsx (handleAgentDirectMessage): a DM is
// a chat_session in the 'Direct messages' folder whose sole/direct participant is the
// agent. Workspaces are effectively single-human, so the DM keys on the agent alone.
async function findOrCreateDirectSession(workspaceId, agent) {
  const wantedId = String(agent.id || '');
  const wantedHandle = slugHandle(agent.handle || agent.name || '');
  const candidates = await getDb().unsafe(
    "select * from chat_sessions where workspace_id = $1 and folder = 'Direct messages' and archived_at is null",
    [workspaceId],
  );
  const match = candidates.find((session) => {
    const participant = directAgentParticipantFromSession(session);
    if (!participant) return false;
    const pid = String(participant.agent_id || '');
    const phandle = slugHandle(participant.handle || participant.name || '');
    return (wantedId && pid === wantedId) || (wantedHandle && phandle === wantedHandle);
  });
  if (match) return match;

  const handle = wantedHandle;
  const title = agent.name || (handle ? `@${handle}` : 'Agent');
  const participant = {
    id: agent.id ? `agent:${agent.id}` : `agent:${handle}`,
    kind: 'agent',
    name: title,
    handle: handle || null,
    agent_id: agent.id || null,
    user_id: null,
    status: null,
    direct: true,
    added_at: new Date().toISOString(),
  };
  const created = await getDb().unsafe(
    `insert into chat_sessions (workspace_id, title, model, folder, conversation_mode, participants)
     values ($1, $2, $3, 'Direct messages', 'auto', $4::jsonb)
     returning *`,
    [workspaceId, title, resolveAnthropicModel(agent.model), JSON.stringify([participant])],
  );
  if (created[0]) notifyDbSubscribers('chat_sessions', 'INSERT', created);
  return created[0] || null;
}

// When a human posts a comment that @mentions agents (on a task, document, or memory
// file), wake each mentioned agent in its DM with a message that quotes the comment
// and links back to the source — so "you were tagged" turns into a real, visible
// response in the DM instead of a silent flag the agent has to poll for.
async function dispatchCommentMentions({ table, row, authorUserId }) {
  const config = COMMENT_MENTION_TABLES[table];
  if (!config || !row) return;
  const workspaceId = row.workspace_id;
  if (!workspaceId) return;
  const handles = parseAgentMentions(row.content);
  if (handles.length === 0) return;

  // H3 (2026-07 review): running an agent from an @mention is an agent-dispatch
  // action, so it must require the run_agents capability — a commenter/viewer
  // (who can leave comments but not run agents) tagging an agent is a no-op,
  // and the dispatch is throttled per author on the same budget as the
  // dedicated /backend/agents/dispatch route. Both are enforced here because
  // the comment insert route only checks the 'comment' capability.
  const authorRole = authorUserId ? await getWorkspaceRole(authorUserId, workspaceId) : null;
  if (!roleHasWorkspaceCapability(authorRole, 'run_agents')) return;
  if (!dispatchRateLimiter.check(String(authorUserId)).allowed) return;

  let authorName = 'A teammate';
  if (authorUserId) {
    const u = await getDb()
      .unsafe('select display_name, email from app_users where id = $1 limit 1', [authorUserId])
      .catch(() => []);
    authorName = u[0]?.display_name || u[0]?.email || authorName;
  }

  let source = { label: 'a comment', link: '' };
  try {
    source = await config.describe(row);
  } catch (error) {
    console.error('describe comment source failed', error);
  }

  for (const handle of handles) {
    try {
      const agent = await resolveWorkspaceAgentByHandle(workspaceId, handle);
      if (!agent) continue;
      // Skip self-mentions (an agent tagging itself in its own note).
      const session = await findOrCreateDirectSession(workspaceId, agent);
      if (!session) continue;

      const linkLine = source.link ? `\n\nSource: ${source.link}` : '';
      const content =
        `@${slugHandle(agent.handle || agent.name)} — ${authorName} tagged you in a comment on ${source.label}:\n\n` +
        `> ${String(row.content || '').replace(/\n/g, '\n> ')}\n\n` +
        `Pick this up and reply here in your DM.${linkLine}`;

      const messageRows = await getDb().unsafe(
        `insert into messages (session_id, role, content, sender_kind, sender_id, sender_name)
         values ($1, 'user', $2, 'user', $3, $4)
         returning *`,
        [session.id, content, String(authorUserId || ''), authorName],
      );
      notifyDbSubscribers('messages', 'INSERT', messageRows);

      void continueConversation({ workspaceId, sessionId: session.id }).catch((error) =>
        console.error('continueConversation (comment mention) failed', error),
      );
    } catch (error) {
      console.error(`comment mention dispatch failed for @${handle}`, error);
    }
  }
}

async function loadChannelMessages(sessionId, threadParentId = null, limit = CHANNEL_CONTEXT_LIMIT) {
  const rows = threadParentId
    ? await getDb().unsafe(
        `select id, role, content, sender_kind, sender_id, sender_name, created_at
         from messages
         where session_id = $1 and (id = $2 or thread_parent_id = $2) and deleted_at is null
         order by created_at desc
         limit $3`,
        [sessionId, threadParentId, limit],
      )
    : await getDb().unsafe(
        `select id, role, content, sender_kind, sender_id, sender_name, created_at
         from messages
         where session_id = $1 and thread_parent_id is null and deleted_at is null
         order by created_at desc
         limit $2`,
        [sessionId, limit],
      );
  return rows.filter((row) => !isAgentPlaceholder(row)).reverse();
}

// Rebuild conversation context from the running agent's point of view: its own
// messages are 'assistant', everyone else (humans and other agents) is 'user'
// with a "[@handle]:" / "[name]:" prefix so the agent can tell who said what.
async function buildAgentTurnContext(sessionId, runningAgent, threadParentId = null) {
  const rows = await loadChannelMessages(sessionId, threadParentId);
  const runningId = String(runningAgent?.id || '');
  const mapped = [];
  for (const row of rows) {
    const text = textFromValue(row.content).trim();
    if (!text) continue;
    const isOwn = row.sender_kind === 'agent' && String(row.sender_id || '') === runningId;
    if (isOwn) {
      mapped.push({ role: 'assistant', content: text });
      continue;
    }
    const label = row.sender_kind === 'agent'
      ? `@${slugHandle(row.sender_name || 'agent')}`
      : (row.sender_name ? String(row.sender_name) : 'User');
    mapped.push({ role: 'user', content: `[${label}]: ${text}` });
  }
  const merged = [];
  for (const message of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content = `${last.content}\n\n${message.content}`;
    else merged.push({ role: message.role, content: message.content });
  }
  while (merged.length > 0 && merged[0].role !== 'user') merged.shift();
  return merged;
}

// Cross-session "shared brain": a short digest of what THIS agent has recently
// done in OTHER sessions (channels + DMs) in this workspace, so it has continuity
// — e.g. you can ask it in a DM what it's working on in a channel, or give pointers.
async function buildAgentActivityDigest(workspaceId, agentId, currentSessionId) {
  if (!workspaceId || !agentId) return '';
  try {
    const rows = await getDb().unsafe(
      `select distinct on (m.session_id) m.session_id, s.title, s.folder, m.content, m.created_at
       from messages m
       join chat_sessions s on s.id = m.session_id
       where s.workspace_id = $1
         and m.sender_kind = 'agent' and m.sender_id = $2
         and m.session_id <> $3
         and m.content !~ '^Thinking '
         and m.deleted_at is null and s.deleted_at is null
       order by m.session_id, m.created_at desc`,
      [workspaceId, String(agentId), currentSessionId || ''],
    );
    const recent = rows
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 6);
    if (recent.length === 0) return '';
    return recent
      .map((r) => {
        const where = r.folder === 'Direct messages' ? `DM "${r.title || 'Untitled'}"` : `channel "${r.title || 'Untitled'}"`;
        const text = textFromValue(r.content).replace(/\s+/g, ' ').trim().slice(0, 220);
        return `- In ${where}: "${text}"`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

function buildDaemonPrompt(contextMessages, agent, coParticipants, recentActivity = '') {
  const selfHandle = slugHandle(agent.handle || agent.name);
  const lines = [];
  if (coParticipants.length > 0) {
    lines.push(
      `You are @${selfHandle} in a multi-agent channel. Other agents present: ${coParticipants.map((p) => `@${p.handle}`).join(', ')}.`,
      'To bring another agent in, address them by @handle. If the request is fully handled, reply without mentioning anyone.',
      '',
    );
  }
  if (recentActivity) {
    lines.push(
      "You are one continuous agent across this workspace's DMs and channels. Your recent activity elsewhere (use for continuity, and when asked what you are working on):",
      recentActivity,
      '',
    );
  }
  lines.push('Conversation so far:');
  for (const message of contextMessages) {
    lines.push(message.role === 'assistant' ? `[@${selfHandle} (you)]: ${message.content}` : message.content);
  }
  lines.push('', 'Write your next reply as @' + selfHandle + '.');
  return lines.join('\n');
}

function pickMentionNextAgent(burst, byHandle, latestAuthorAgentId) {
  for (let i = 0; i < burst.length; i++) {
    const row = burst[i];
    const authorAgentId = row.sender_kind === 'agent' ? String(row.sender_id || '') : '';
    for (const handle of parseAgentMentions(row.content)) {
      const agent = byHandle.get(handle);
      if (!agent || !isAgentEnabled(agent)) continue;
      const agentId = String(agent.id);
      if (authorAgentId && agentId === authorAgentId) continue; // ignore self-mentions
      if (agentId === latestAuthorAgentId) continue; // never reply to itself back-to-back
      let satisfied = false;
      for (let j = i + 1; j < burst.length; j++) {
        if (burst[j].sender_kind === 'agent' && String(burst[j].sender_id || '') === agentId) {
          satisfied = true;
          break;
        }
      }
      if (!satisfied) return agent;
    }
  }
  return null;
}

// --- Context-aware auto-interject -------------------------------------------
// In an 'auto' channel a human message with NO @mention can still draw a single
// "watcher" agent in unprompted, when that agent is clearly relevant. A cheap
// Haiku call is the relevance gate; it fails CLOSED (any error => no interject).
const AUTO_INTERJECT_MODEL = 'claude-haiku-4-5';

// Single cheap LLM call: decide whether ONE candidate agent should interject.
// Returns the chosen agent row or null. Never throws (fail closed).
// `lastSpeakerHandle` (when set) is the agent the human replied immediately
// after — the primary candidate for "is this for you, or do you pass it on?".
async function pickAutoInterjectWatcher({ workspaceId, humanMessage, contextLines, candidates, lastSpeakerHandle = '' }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const roster = candidates
    .map((a) => `- @${slugHandle(a.handle || a.name)}: ${textFromValue(a.description || a.soul || a.name).slice(0, 160)}`)
    .join('\n');
  const lastSpeakerLine = lastSpeakerHandle
    ? `The human posted immediately after @${lastSpeakerHandle}. If the latest message reads as a reply, answer, or follow-up to @${lastSpeakerHandle} (or continues that exchange), prefer @${lastSpeakerHandle} — unless another agent is a clearly better fit to take it or the message is plainly meant for someone else. That agent can always pass it on.`
    : '';
  const prompt = [
    'You route a team chat. A human just posted in a channel where NO agent was @mentioned.',
    'Decide whether exactly ONE of these agents should proactively chime in because it is clearly,',
    'specifically relevant to the latest human message. Most messages need NO interjection — only pick an',
    'agent when it would add real, on-topic value. When unsure, pick null.',
    lastSpeakerLine,
    '',
    'Agents in this channel:',
    roster,
    '',
    'Recent context (oldest first):',
    contextLines || '(none)',
    '',
    `Latest human message:\n${humanMessage}`,
    '',
    'Respond with STRICT JSON only, no prose: {"agent": "<handle>" | null, "reason": "<short>"}',
  ].filter(Boolean).join('\n');

  let text;
  try {
    text = await runAnthropicCompletion({
      model: AUTO_INTERJECT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      memory: null,
      documents: null,
      workspaceContext: null,
      agentContext: null,
      workspaceId,
    });
  } catch (error) {
    console.error('auto-interject relevance call failed', error?.message || error);
    return null; // fail closed
  }

  try {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!parsed || parsed.agent == null) return null;
    const handle = slugHandle(String(parsed.agent));
    if (!handle) return null;
    return candidates.find((a) => slugHandle(a.handle || a.name) === handle) || null;
  } catch {
    return null; // unparseable => fail closed
  }
}

// When a human @mentions an agent that isn't yet a channel participant, add it
// to the session's participant roster so it shows in the channel and becomes an
// auto-interject candidate for later turns. 1:1 DMs are left isolated. Returns
// the count added (0 = nothing to do). Best-effort; never throws to the caller.
async function ensureMentionedParticipants(workspaceId, session, content) {
  try {
    const directTarget = directAgentParticipantFromSession(session);
    if (directTarget && directTarget.direct) return 0; // private DMs stay 1:1
    const handles = parseAgentMentions(content);
    if (handles.length === 0) return 0;
    const existing = parseJsonArray(session.participants);
    const existingAgentIds = new Set(
      existing.filter((p) => p && p.kind === 'agent' && p.agent_id).map((p) => String(p.agent_id)),
    );
    const agents = await getDb().unsafe(
      'select id, name, handle, enabled from workspace_agents where workspace_id = $1',
      [workspaceId],
    );
    const byHandle = new Map();
    for (const agent of agents) {
      if (!isAgentEnabled(agent)) continue;
      byHandle.set(slugHandle(agent.handle || agent.name), agent);
      const nameHandle = slugHandle(agent.name);
      if (!byHandle.has(nameHandle)) byHandle.set(nameHandle, agent);
    }
    const additions = [];
    const seen = new Set();
    for (const handle of handles) {
      const agent = byHandle.get(handle);
      if (!agent) continue;
      const id = String(agent.id);
      if (existingAgentIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      additions.push({
        id: `agent:${id}`,
        kind: 'agent',
        agent_id: id,
        user_id: null,
        name: agent.name,
        handle: slugHandle(agent.handle || agent.name),
        status: null,
        direct: false,
        added_at: new Date().toISOString(),
      });
    }
    if (additions.length === 0) return 0;
    const merged = [...existing, ...additions];
    const updated = await getDb().unsafe(
      'update chat_sessions set participants = $1, updated_at = now() where id = $2 returning *',
      [JSON.stringify(merged), session.id],
    );
    if (updated.length > 0) notifyDbSubscribers('chat_sessions', 'UPDATE', updated);
    return additions.length;
  } catch (error) {
    console.error('ensureMentionedParticipants failed', error?.message || error);
    return 0; // best-effort; dispatch still proceeds
  }
}

// Insert an agent_job, tolerating the partial unique index that enforces one
// active job per (session, agent) (M15). A unique violation means a concurrent
// trigger already created the turn's job (won the race), so we clean up the
// just-created "Thinking" placeholder message (if any) and return null; callers
// treat null like the pending path and stop the drain loop.
async function insertActiveAgentJob(sql, params, placeholderMessageId = null) {
  try {
    return await getDb().unsafe(sql, params);
  } catch (error) {
    if (error && error.code === '23505') {
      if (placeholderMessageId) {
        try {
          const del = await getDb().unsafe('delete from messages where id = $1 returning *', [placeholderMessageId]);
          if (del.length > 0) notifyDbSubscribers('messages', 'DELETE', del);
        } catch { /* best effort placeholder cleanup */ }
      }
      return null;
    }
    throw error;
  }
}

// A queued/running job is "live" only if the worker meant to answer it still exists.
// Trusting status alone let a phantom job (a daemon that vanished, or an MCP client
// that left) wedge a session forever — new turns were silently dropped while a
// healthy, reconnected agent sat unable to speak in its own DM.
function isAgentJobLive(job, agentId) {
  const mode = parseJsonObject(job.metadata).mode;
  if (mode === 'mcp') {
    // A CLAIMED (running) MCP turn keeps no heartbeat — presence (40s TTL) is only
    // touched on claim/submit, but a turn can legitimately run up to the 240s MCP
    // reaper window. So treat running MCP jobs as live (the reaper is the backstop);
    // only gate QUEUED ones on presence, since an unclaimed job needs a live client
    // to ever be answered. Gating running jobs on presence would kill a live turn
    // mid-flight and dispatch a duplicate.
    return job.status === 'running' ? true : hasMcpPresence(agentId);
  }
  if (mode === 'builtin') return true; // runs in-process; an interrupted one is cleared by startup reconcile
  // daemon (or legacy rows with no explicit mode): live only while its socket is open.
  return job.connection_id ? isConnectionSocketOpen(job.connection_id) : false;
}

async function hasActiveBurstJob(sessionId, agentId) {
  // Include 'queued', not just 'running': an MCP-backed agent's job sits in
  // 'queued' until its client polls and claims it, so two rapid triggers for the
  // same session/agent (two quick DMs, or dispatch + comment-mention) would both
  // pass a running-only guard and produce a duplicate turn (M14, 2026-07 review).
  const rows = await getDb().unsafe(
    `select id, status, connection_id, metadata, started_at from agent_jobs
      where session_id = $1 and agent_id = $2 and status in ('queued', 'running')`,
    [sessionId, String(agentId)],
  );
  let blocking = false;
  for (const job of rows) {
    if (isAgentJobLive(job, agentId)) { blocking = true; continue; }
    // Phantom: its worker is gone, so it can never produce a result and must not
    // wedge the session. Finalize it now — awaited so the row is 'error' before the
    // caller dispatches a fresh turn, otherwise the M15 one-active-job unique index
    // would bounce the retry and the human would have to send again.
    await finalizeStuckJob(job, 'the previous turn was abandoned');
  }
  return blocking;
}

// Runs exactly one agent turn (builtin or daemon), rebuilding context from the DB.
// Returns { ok, pending }. pending=true means a daemon job is in flight and the
// conversation will resume from handleAgentJobResult.
async function runAgentTurn(agent, { workspaceId, sessionId, threadParentId = null, createdBy = null, coParticipants = [] }) {
  if (!isAgentEnabled(agent)) return { ok: false, pending: false };
  const handle = slugHandle(agent.handle || agent.name);
  const runMode = agent.run_mode === 'daemon' ? 'daemon' : 'builtin';
  const contextMessages = await buildAgentTurnContext(sessionId, agent, threadParentId);
  const agentContext = agentContextFromRow(agent, coParticipants);
  const recentActivity = await buildAgentActivityDigest(workspaceId, agent.id, sessionId);
  if (recentActivity && agentContext) {
    agentContext.systemPrompt = `${agentContext.systemPrompt}\n\n<your_recent_activity>\nYou are one continuous agent across this workspace's DMs and channels. Recent activity elsewhere (reference it when asked what you're working on):\n${recentActivity}\n</your_recent_activity>`.trim();
  }

  // If one or more MCP clients are working AS this agent (joined via the invite link and
  // polling claim_job), serve this turn through the pull queue: enqueue a job; whichever
  // client claims it answers. Takes precedence over builtin/daemon. This is what makes
  // "@q answers via MCP" and "3× Q all working as Q" work, with zero per-agent config.
  if (hasMcpPresence(agent.id)) {
    const responseMessageId = crypto.randomUUID();
    const pendingRows = await getDb().unsafe(
      `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
       values ($1, $2, 'assistant', 'Thinking 0s', $3, 'agent', $4, $5)
       returning *`,
      [responseMessageId, sessionId, threadParentId || null, String(agent.id), agent.name],
    );
    notifyDbSubscribers('messages', 'INSERT', pendingRows);
    const prompt = buildDaemonPrompt(contextMessages, agent, coParticipants, recentActivity);
    const jobRows = await insertActiveAgentJob(
      `insert into agent_jobs (workspace_id, agent_id, session_id, created_by, prompt, status, metadata)
       values ($1, $2, $3, $4, $5, 'queued', $6::jsonb)
       returning *`,
      [
        workspaceId, agent.id, sessionId, createdBy, prompt,
        // Pass the OBJECT (not JSON.stringify'd): postgres.js encodes it as a real jsonb
        // object, so `metadata->>'mode'` in claimMcpJob/reaper matches. JSON.stringify here
        // would double-encode into a jsonb STRING scalar and the SQL key lookup returns null.
        { handle, threadParentId: threadParentId || null, responseMessageId, mode: 'mcp' },
      ],
      responseMessageId,
    );
    if (!jobRows) return { ok: false, pending: true }; // a concurrent turn won the race
    notifyDbSubscribers('agent_jobs', 'INSERT', jobRows);
    return { ok: true, pending: true }; // a polling client will claim it; conversation resumes on submit
  }

  if (runMode === 'builtin') {
    const jobRows = await insertActiveAgentJob(
      `insert into agent_jobs (workspace_id, agent_id, session_id, created_by, prompt, status, started_at, metadata)
       values ($1, $2, $3, $4, $5, 'running', now(), $6::jsonb)
       returning *`,
      [workspaceId, agent.id, sessionId, createdBy, '', JSON.stringify({ handle, threadParentId: threadParentId || null, mode: 'builtin' })],
    );
    if (!jobRows) return { ok: false, pending: true }; // a concurrent turn won the race
    notifyDbSubscribers('agent_jobs', 'INSERT', jobRows);
    try {
      const responseText = await runAnthropicCompletion({
        model: resolveAnthropicModel(agent.model),
        messages: contextMessages.length > 0 ? contextMessages : [{ role: 'user', content: '(no message)' }],
        memory: null,
        documents: null,
        workspaceContext: null,
        agentContext,
        workspaceId,
      });
      const updatedRows = await getDb().unsafe(
        `update agent_jobs set status = 'done', response = $2, finished_at = now(), updated_at = now() where id = $1 returning *`,
        [jobRows[0].id, responseText],
      );
      notifyDbSubscribers('agent_jobs', 'UPDATE', updatedRows);
      const messageRows = await getDb().unsafe(
        `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
         values ($1, 'assistant', $2, $3, 'agent', $4, $5)
         returning *`,
        [sessionId, responseText || `@${handle} finished without output.`, threadParentId || null, String(agent.id), agent.name],
      );
      notifyDbSubscribers('messages', 'INSERT', messageRows);
      return { ok: true, pending: false };
    } catch (error) {
      const errorText = error?.message || 'Built-in agent failed';
      const updatedRows = await getDb().unsafe(
        `update agent_jobs set status = 'error', error = $2, finished_at = now(), updated_at = now() where id = $1 returning *`,
        [jobRows[0].id, errorText],
      );
      notifyDbSubscribers('agent_jobs', 'UPDATE', updatedRows);
      const messageRows = await getDb().unsafe(
        `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
         values ($1, 'assistant', $2, $3, 'agent', $4, $5)
         returning *`,
        [sessionId, `@${handle} failed: ${errorText}`, threadParentId || null, String(agent.id), agent.name],
      );
      notifyDbSubscribers('messages', 'INSERT', messageRows);
      return { ok: false, pending: false };
    }
  }

  const connection = findConnectedAgent(workspaceId, agent.id, agent.handle || agent.name);
  if (!connection) {
    const assistantRows = await getDb().unsafe(
      `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
       values ($1, 'assistant', $2, $3, 'agent', $4, $5)
       returning *`,
      [
        sessionId,
        `@${handle} is configured, but no daemon is connected. Open AI Agents, copy its connection command, and run it where the agent should execute.`,
        threadParentId || null,
        String(agent.id),
        agent.name,
      ],
    );
    notifyDbSubscribers('messages', 'INSERT', assistantRows);
    return { ok: false, pending: false };
  }

  const responseMessageId = crypto.randomUUID();
  const pendingMessageRows = await getDb().unsafe(
    `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
     values ($1, $2, 'assistant', 'Thinking 0s', $3, 'agent', $4, $5)
     returning *`,
    [responseMessageId, sessionId, threadParentId || null, String(agent.id), agent.name],
  );
  notifyDbSubscribers('messages', 'INSERT', pendingMessageRows);

  const daemonPrompt = buildDaemonPrompt(contextMessages, agent, coParticipants, recentActivity);
  const jobRows = await insertActiveAgentJob(
    `insert into agent_jobs (workspace_id, agent_id, connection_id, session_id, created_by, prompt, status, started_at, metadata)
     values ($1, $2, $3, $4, $5, $6, 'running', now(), $7::jsonb)
     returning *`,
    [
      workspaceId,
      agent.id,
      connection.connectionId,
      sessionId,
      createdBy,
      daemonPrompt,
      JSON.stringify({ handle, threadParentId: threadParentId || null, responseMessageId, mode: 'daemon' }),
    ],
    responseMessageId,
  );
  if (!jobRows) return { ok: false, pending: true }; // a concurrent turn won the race
  notifyDbSubscribers('agent_jobs', 'INSERT', jobRows);
  await updateAgentHeartbeat(connection.ws, { busy: true }).catch(() => {});
  const agentPayload = agentRuntimePayload(agent);
  sendWs(connection.ws, {
    type: 'agent_job',
    job: {
      id: jobRows[0].id,
      workspaceId,
      sessionId,
      threadParentId: threadParentId || null,
      prompt: daemonPrompt,
      handle,
      model: agentPayload.model,
      permissionMode: agentPayload.permissionMode,
      permission_mode: agentPayload.permission_mode,
      permissionFlags: agentPayload.permissionFlags,
      agent: agentPayload,
      responseMessageId,
    },
  });
  return { ok: true, pending: true };
}

// Single entry point that advances a channel conversation by one or more turns.
// Seeded by the dispatch endpoint and resumed after every agent message lands.
// Drains a queue of agent turns under one shared budget (max_agent_turns), one
// agent at a time. Builtin turns loop here; daemon turns return and resume async.
async function continueConversation({ workspaceId, sessionId, threadParentId = null }) {
  if (!workspaceId || !sessionId) return;
  const lockKey = `${sessionId}::${threadParentId || ''}`;
  if (conversationLocks.has(lockKey)) return;
  conversationLocks.add(lockKey);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sessionRows = await getDb().unsafe(
        'select id, workspace_id, participants, conversation_mode, max_agent_turns from chat_sessions where id = $1 limit 1',
        [sessionId],
      );
      const session = sessionRows[0];
      if (!session || String(session.workspace_id) !== String(workspaceId)) return;
      const maxTurns = Number(session.max_agent_turns) > 0 ? Number(session.max_agent_turns) : 10;
      const conversationMode = String(session.conversation_mode || 'mention');
      const directTarget = directAgentParticipantFromSession(session);

      const rows = await loadChannelMessages(sessionId, threadParentId);
      if (rows.length === 0) return;
      let startIdx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].role === 'user') { startIdx = i; break; }
      }
      if (startIdx === -1) return; // no human seed; nothing to do
      const burst = rows.slice(startIdx);
      const agentTurns = burst.filter((row) => row.sender_kind === 'agent').length;
      if (agentTurns >= maxTurns) return; // budget exhausted

      const latest = rows[rows.length - 1];
      const latestAuthorAgentId = latest.sender_kind === 'agent' ? String(latest.sender_id || '') : '';

      const agents = await getDb().unsafe(
        'select * from workspace_agents where workspace_id = $1 order by created_at asc',
        [workspaceId],
      );
      if (agents.length === 0) return;
      const byHandle = new Map();
      for (const agent of agents) {
        if (!isAgentEnabled(agent)) continue;
        byHandle.set(slugHandle(agent.handle || agent.name), agent);
        const nameHandle = slugHandle(agent.name);
        if (!byHandle.has(nameHandle)) byHandle.set(nameHandle, agent);
      }
      const participantAgentIds = new Set();
      for (const participant of parseJsonArray(session.participants)) {
        if (participant && participant.kind === 'agent' && participant.agent_id) {
          participantAgentIds.add(String(participant.agent_id));
        }
      }

      // A true 1:1 DM (a participant flagged direct:true) is isolated: ONLY that
      // agent ever responds. Agents routinely @mention teammates to collaborate, but
      // a private DM must not pull those others in. Channels keep full routing below.
      const isDirectMessage = Boolean(directTarget && directTarget.direct);
      let nextAgent = null;
      if (isDirectMessage) {
        if (agentTurns === 0) {
          nextAgent = agents.find((agent) => isAgentEnabled(agent) && ((directTarget.agent_id && String(agent.id) === String(directTarget.agent_id))
            || (directTarget.handle && (slugHandle(agent.handle || agent.name) === slugHandle(directTarget.handle) || slugHandle(agent.name) === slugHandle(directTarget.handle)))));
        }
      } else {
        nextAgent = pickMentionNextAgent(burst, byHandle, latestAuthorAgentId);
        if (!nextAgent && agentTurns === 0 && directTarget) {
          nextAgent = agents.find((agent) => isAgentEnabled(agent) && ((directTarget.agent_id && String(agent.id) === String(directTarget.agent_id))
            || (directTarget.handle && (slugHandle(agent.handle || agent.name) === slugHandle(directTarget.handle) || slugHandle(agent.name) === slugHandle(directTarget.handle)))));
        }
        if (!nextAgent && agentTurns === 0 && threadParentId) {
          const target = await inferThreadAgentTarget(sessionId, threadParentId);
          if (target) {
            nextAgent = agents.find((agent) => isAgentEnabled(agent) && ((target.agentId && String(agent.id) === target.agentId)
              || (target.handle && (slugHandle(agent.handle || agent.name) === target.handle || slugHandle(agent.name) === target.handle))));
          }
        }
        // Context-aware auto-interject (opt-in: conversation_mode === 'auto'). A pure
        // fallback when no explicit target exists; fires once per human message
        // (agentTurns === 0, latest author is the human). The candidate pool is
        // every enabled agent that is a channel participant UNION every agent that
        // has recently posted in this channel — so a human replying right after an
        // agent draws that agent back in to decide "is this for me, or pass it on?".
        // A single cheap Haiku call picks ONE agent or null (fails CLOSED).
        if (!nextAgent && conversationMode === 'auto' && agentTurns === 0 && latestAuthorAgentId === '') {
          const candidateIds = new Set();
          for (const id of participantAgentIds) candidateIds.add(String(id));
          // Recent agent authors (newest first): the last one to speak is the
          // primary candidate — that's who the human is most likely replying to.
          let lastAgentAuthorId = '';
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i];
            if (r.sender_kind === 'agent' && r.sender_id) {
              if (!lastAgentAuthorId) lastAgentAuthorId = String(r.sender_id);
              candidateIds.add(String(r.sender_id));
            }
          }
          const candidates = [...candidateIds]
            .map((id) => agents.find((agent) => String(agent.id) === id))
            .filter((agent) => agent && isAgentEnabled(agent));
          if (candidates.length > 0) {
            const humanMessage = textFromValue(burst[0]?.content).slice(0, 2000);
            const contextLines = rows
              .slice(Math.max(0, startIdx - 5), startIdx)
              .map((r) => `${r.sender_kind === 'agent' ? '@' + slugHandle(r.sender_name || 'agent') : 'human'}: ${textFromValue(r.content).slice(0, 300)}`)
              .join('\n');
            const lastAgent = candidates.find((agent) => String(agent.id) === lastAgentAuthorId);
            const lastSpeakerHandle = lastAgent ? slugHandle(lastAgent.handle || lastAgent.name) : '';
            const watcher = await pickAutoInterjectWatcher({ workspaceId, humanMessage, contextLines, candidates, lastSpeakerHandle });
            if (watcher) nextAgent = watcher;
          }
        }
      }
      if (!nextAgent) return;
      if (await hasActiveBurstJob(sessionId, nextAgent.id)) return;

      const involved = new Map();
      for (const id of participantAgentIds) {
        const agent = agents.find((row) => String(row.id) === id);
        if (agent) involved.set(id, agent);
      }
      for (const row of burst) {
        if (row.sender_kind === 'agent' && row.sender_id) {
          const agent = agents.find((entry) => String(entry.id) === String(row.sender_id));
          if (agent) involved.set(String(agent.id), agent);
        }
        for (const handle of parseAgentMentions(row.content)) {
          const agent = byHandle.get(handle);
          if (agent) involved.set(String(agent.id), agent);
        }
      }
      const coParticipants = [...involved.values()]
        .filter((agent) => String(agent.id) !== String(nextAgent.id))
        .map((agent) => ({ handle: slugHandle(agent.handle || agent.name), name: agent.name }));

      const result = await runAgentTurn(nextAgent, { workspaceId, sessionId, threadParentId, coParticipants });
      if (!result || result.pending) return; // daemon resumes asynchronously; stop the loop
      // builtin turn finished synchronously — loop to evaluate the next turn
    }
  } finally {
    conversationLocks.delete(lockKey);
  }
}

function agentLiveMessageContent(message) {
  const text = textFromValue(message?.content ?? message?.response ?? message?.text).trim();
  if (text) return text;
  return `Thinking ${formatElapsedMs(message?.elapsedMs)}`;
}

// Finalize a stuck/abandoned daemon job: mark it failed and rewrite its still-
// pending "Thinking …" placeholder with a clear message, so a chat never hangs on
// a spinner when the daemon disconnects, crashes, or simply never answers.
async function finalizeStuckJob(job, reason) {
  try {
    // Use 'error' (not 'failed'): the agent_jobs.status CHECK constraint only permits
    // queued/running/done/error/cancelled. Writing 'failed' throws a constraint
    // violation that the surrounding try/catch swallows, so the job would stay
    // 'running' forever — the exact bug that let a phantom job wedge a DM indefinitely
    // (reaper, connection-drop cleanup, and startup reconcile all funnel through here).
    const updated = await getDb().unsafe(
      `update agent_jobs set status = 'error', error = $2, finished_at = now(), updated_at = now() where id = $1 and status = 'running' returning id`,
      [job.id, `Agent stopped responding (${reason})`],
    );
    if (updated.length === 0) return; // a real result already finalized it
    const meta = parseJsonObject(job.metadata);
    const responseMessageId = meta.responseMessageId || null;
    if (!responseMessageId) return;
    const handle = meta.handle || 'agent';
    const content = `@${handle} stopped responding (${reason}). Send again to retry — if it keeps happening, reconnect the daemon from AI Agents.`;
    const rows = await getDb().unsafe(
      `update messages set content = $2
       where id = $1 and session_id = $3 and content ~ '^Thinking '
       returning *`,
      [responseMessageId, content, job.session_id],
    );
    if (rows.length > 0) notifyDbSubscribers('messages', 'UPDATE', rows);
  } catch {
    // best effort
  }
}

// Fail every running job tied to a connection that just dropped.
async function failConnectionJobs(connectionId, reason) {
  if (!connectionId) return;
  try {
    const rows = await getDb().unsafe(
      `select * from agent_jobs where connection_id = $1 and status = 'running'`,
      [connectionId],
    );
    for (const job of rows) await finalizeStuckJob(job, reason);
  } catch {
    // best effort
  }
}

// Backstop: time out any running job pending too long (covers half-open sockets
// that never fire 'close', or a daemon that connected but never returned a result).
async function reapStuckAgentJobs() {
  try {
    const rows = await getDb().unsafe(
      `select * from agent_jobs where status = 'running' and started_at < now() - interval '240 seconds'`,
    );
    for (const job of rows) await finalizeStuckJob(job, 'timed out');
  } catch {
    // best effort
  }
}

async function markAgentConnectionOffline(ws) {
  const connectionId = ws.agentConnectionId;
  if (!connectionId) return;
  connectedAgents.delete(connectionId);
  void failConnectionJobs(connectionId, 'the daemon disconnected');
  try {
    const rows = await getDb().unsafe(
      `update agent_connections
       set status = 'offline', updated_at = now(), last_seen_at = now()
       where id = $1
       returning *`,
      [connectionId],
    );
    notifyDbSubscribers('agent_connections', 'UPDATE', rows.map(publicAgentConnection));
    if (rows.length > 0) void logConnectionActivity(rows[0], 'agent_disconnected');
  } catch {
    // best effort during socket close
  }
}

// On a fresh process there are no live sockets, so any agent_connections row still
// marked online/busy is stale — left behind when a previous process restarted,
// crashed, or was redeployed. Reset them so the UI doesn't report agents as
// connected when they aren't. Best-effort: a brand-new DB may not have the table
// yet (in which case there are no connections to reconcile anyway).
async function reconcileAgentConnectionsAtStartup() {
  try {
    const rows = await getDb().unsafe(
      `update agent_connections set status = 'offline', updated_at = now()
       where status <> 'offline'
       returning *`,
    );
    if (rows.length > 0) {
      console.log(`[backend] reset ${rows.length} stale agent connection(s) to offline on startup`);
      notifyDbSubscribers('agent_connections', 'UPDATE', rows.map(publicAgentConnection));
    }
    const stuckJobs = await getDb().unsafe(`select * from agent_jobs where status = 'running'`);
    for (const job of stuckJobs) await finalizeStuckJob(job, 'the backend restarted');
    if (stuckJobs.length > 0) console.log(`[backend] finalized ${stuckJobs.length} orphaned running job(s) on startup`);
  } catch (error) {
    console.warn('[backend] startup agent-connection reconcile skipped:', error.message || error);
  }
}

// Auto-cleanup: remove offline connection rows dead for a while, so the daemon
// "Other connections" list self-prunes instead of piling up stale entries.
async function pruneOfflineConnections() {
  try {
    const rows = await getDb().unsafe(
      `delete from agent_connections where status = 'offline' and last_seen_at < now() - interval '120 seconds' returning *`,
    );
    if (rows.length > 0) notifyDbSubscribers('agent_connections', 'DELETE', rows.map(publicAgentConnection));
  } catch {
    // best effort
  }
}

async function registerAgentConnection(ws, message) {
  const auth = ws.agentAuth;
  if (!auth) throw forbidden('Agent token is required');
  const workspaceId = String(message.workspaceId || auth.workspaceId || '');
  const agentId = String(message.agentId || auth.agentId || '');
  if (workspaceId !== auth.workspaceId || agentId !== auth.agentId) {
    throw forbidden('Agent token does not match this workspace');
  }
  const enabledRows = await getDb().unsafe('select enabled from workspace_agents where id = $1 and workspace_id = $2 limit 1', [agentId, workspaceId]);
  if (!isAgentEnabled(enabledRows[0])) throw forbidden('Agent is deactivated');
  const handle = slugHandle(message.handle || auth.handle || auth.name);
  const name = String(message.name || auth.name || handle).trim() || handle;
  const host = String(message.host || '').slice(0, 180);
  const cwd = String(message.cwd || '').slice(0, 500);
  const metadata = parseJsonObject(message.metadata);
  const connectionId = crypto.randomUUID();

  // Drop this agent's dead (offline) rows up front so a reconnect replaces them
  // rather than stacking another stale entry in the UI.
  try {
    const stale = await getDb().unsafe(
      `delete from agent_connections where workspace_id = $1 and agent_id = $2 and status = 'offline' returning *`,
      [workspaceId, agentId],
    );
    if (stale.length > 0) notifyDbSubscribers('agent_connections', 'DELETE', stale.map(publicAgentConnection));
  } catch {
    // best effort
  }
  const rows = await getDb().unsafe(
    `insert into agent_connections (id, workspace_id, agent_id, name, handle, host, cwd, status, metadata, connected_at, last_seen_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'online', $8::jsonb, now(), now(), now())
     returning *`,
    [connectionId, workspaceId, agentId, name, handle, host, cwd, JSON.stringify(metadata)],
  );
  const connection = publicAgentConnection(rows[0]);
  ws.agentConnectionId = connectionId;
  ws.agentId = agentId;
  ws.workspaceId = workspaceId;
  connectedAgents.set(connectionId, { ws, connectionId, workspaceId, agentId, handle, name, agent: auth.agent });
  notifyDbSubscribers('agent_connections', 'INSERT', [connection]);
  void logConnectionActivity(connection, 'agent_connected');
  sendWs(ws, { type: 'agent_registered', connection, agent: auth.agent });
}

// The "format we need" gate: stored capabilities must have the three array fields and a
// string|null memoryRoot. A row that fails this (never synced, or malformed) is treated
// as drifted so the heartbeat nudges a fresh snapshot to self-heal it.
// `reach` (agent-mesh F2) is INTENTIONALLY excluded from this required-fields check —
// older daemons, and reach-disabled ones, omit it. Requiring it would make
// capabilitiesDriftNudges nudge agent_capabilities_refresh every beat forever.
function capabilitiesShapeValid(caps) {
  return Boolean(caps)
    && Array.isArray(caps.skills)
    && Array.isArray(caps.clis)
    && Array.isArray(caps.mcpServers)
    && (caps.memoryRoot === null || typeof caps.memoryRoot === 'string');
}

// Pure drift decision, extracted so it can be unit-tested without a DB. Given the last
// stored capabilities and the hashes the daemon just sent on its heartbeat, decide which
// full-snapshot re-pushes to nudge. Rules:
//  - Only act on a hash the daemon actually sent (older daemons omit them → no nudge).
//  - Capabilities drift when the stored row is malformed OR its stored hash differs.
//  - Memory drift when the stored memoryHash differs.
// The stored reference only advances when a real snapshot lands, so a genuine mismatch
// resolves in ~1 round-trip rather than looping every beat.
function capabilitiesDriftNudges(stored, { capabilitiesHash, memoryHash } = {}) {
  const nudges = [];
  if (capabilitiesHash && (!capabilitiesShapeValid(stored) || capabilitiesHash !== stored.hash)) {
    nudges.push('agent_capabilities_refresh');
  }
  if (memoryHash && memoryHash !== (stored && stored.memoryHash)) {
    nudges.push('agent_memory_refresh');
  }
  return nudges;
}

async function updateAgentHeartbeat(ws, metadata = {}, hashes = {}) {
  const connectionId = ws.agentConnectionId;
  if (!connectionId) throw forbidden('Agent is not registered');
  const rows = await getDb().unsafe(
    `update agent_connections
     set status = $2, metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb, last_seen_at = now(), updated_at = now()
     where id = $1
     returning *`,
    [connectionId, metadata.busy ? 'busy' : 'online', JSON.stringify(metadata || {})],
  );
  notifyDbSubscribers('agent_connections', 'UPDATE', rows.map(publicAgentConnection));

  // Capability/memory drift check. The heartbeat carries the daemon's current hashes;
  // compare them against what we last stored on a snapshot (the update above leaves the
  // `capabilities` column untouched, so this reads the last synced reference). On a
  // mismatch — or malformed stored capabilities — nudge the daemon to re-push the full
  // snapshot. Guarded on hash presence so older daemons that don't send hashes never get
  // nudged. The stored reference only advances when the real snapshot lands, so a
  // mismatch resolves in ~1 round-trip rather than looping.
  if (rows.length > 0) {
    const stored = parseJsonObject(rows[0].capabilities);
    for (const nudge of capabilitiesDriftNudges(stored, hashes || {})) {
      sendWs(ws, { type: nudge });
    }
  }
}

// Ingest a full snapshot of an agent's file-memory palace pushed by its daemon.
// Read-only mirror: UPSERT every file by the stable UNIQUE(agent_id, path) identity
// (so comments anchored to (agent_id, path) stay attached), then prune rows for files
// the daemon no longer reports. The daemon is the only writer — the browser path is
// read-only (see DB_TABLE_ACCESS).
async function handleAgentMemorySync(ws, message) {
  const auth = ws.agentAuth;
  if (!auth) throw forbidden('Agent token is required');
  const workspaceId = ws.workspaceId || auth.workspaceId;
  const agentId = ws.agentId || auth.agentId;
  if (!workspaceId || !agentId) throw forbidden('Agent is not registered');

  const incoming = Array.isArray(message.files) ? message.files : [];
  const db = getDb();
  const upserted = [];
  const keptPaths = [];
  for (const file of incoming) {
    const filePath = String(file?.path || '').slice(0, 1024);
    if (!filePath) continue;
    const kind = String(file?.kind || 'memory').slice(0, 40);
    const content = String(file?.content || '');
    const byteSize = Number.isFinite(file?.byteSize) ? Math.trunc(file.byteSize) : Buffer.byteLength(content);
    const summary = String(file?.summary || '').slice(0, 2000);
    keptPaths.push(filePath);
    const rows = await db.unsafe(
      `insert into agent_memory_files (workspace_id, agent_id, path, kind, summary, content_cache, byte_size, editable, last_synced, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, false, now(), now())
       on conflict (agent_id, path) do update set
         kind = excluded.kind,
         summary = excluded.summary,
         content_cache = excluded.content_cache,
         byte_size = excluded.byte_size,
         last_synced = now(),
         updated_at = now(),
         version = agent_memory_files.version + 1
       returning *`,
      [workspaceId, agentId, filePath, kind, summary, content, byteSize],
    );
    if (rows[0]) upserted.push(rows[0]);
  }

  // Prune rows for files the daemon no longer reports (comments survive — they key on
  // (agent_id, path), not a FK to these rows).
  const pruned = keptPaths.length > 0
    ? await db.unsafe(
        `delete from agent_memory_files where agent_id = $1 and path <> all($2::text[]) returning *`,
        [agentId, keptPaths],
      )
    : await db.unsafe(`delete from agent_memory_files where agent_id = $1 returning *`, [agentId]);

  if (upserted.length > 0) notifyDbSubscribers('agent_memory_files', 'INSERT', upserted);
  if (pruned.length > 0) notifyDbSubscribers('agent_memory_files', 'DELETE', pruned);
}

// Sanitizes a daemon-reported reach advert before it's stored. Caps addrs to 4 and
// truncates host so a misbehaving daemon can't grow the capabilities row unbounded.
function reachFromMessage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    transport: 'ws',
    listening: raw.listening === true,
    addrs: Array.isArray(raw.addrs)
      ? raw.addrs.slice(0, 4).map((a) => ({
          host: String(a?.host || '').slice(0, 63),
          port: Number(a?.port) || 0,
          scope: a?.scope === 'lan' ? 'lan' : 'other',
        }))
      : [],
    auth: 'hub-pairwise',
  };
}

// Whether a stored capabilities.reach block is usable as a direct-handoff target.
function reachIsDirect(caps) {
  const reach = caps && caps.reach;
  return Boolean(reach && reach.listening === true && Array.isArray(reach.addrs) && reach.addrs.length > 0);
}

// --- agent-mesh pairwise peer auth (F5). Peers can't verify each other's aga_ tokens
// directly (only the hub holds connect_token_hash). The hub is the trust root: it mints
// a short-lived, single-use ticket for a requested handoff and pushes the matching grant
// to the callee, so two daemons can open a direct channel with NO new crypto beyond the
// hub's existing token machinery (mirrors createAgentConnectToken's aga_ prefix pattern).
//
// Wire (new WS actions, alongside agent_capabilities_sync):
//   Daemon A -> hub:   { action:'peer_ticket_request', targetAgentId }
//   Hub -> Daemon A:   { type:'peer_ticket', ticket, exp, peer:{ agentId, addrs } }
//   Hub -> Daemon B:   { type:'peer_ticket_grant', ticket, exp, fromAgentId }
//   Daemon A -> B (FIRST frame on B's LAN listener): { type:'peer_auth', ticket, fromAgentId }
//   Daemon B validates the presented ticket against the grant it holds — hub-verified
//   indirectly, so B needs no server secret of its own.
const pendingPeerTickets = new Map(); // ticket -> { from, to, exp }
const PEER_TICKET_TTL_MS = 60_000;
function mintPeerTicket() {
  return `agp_${crypto.randomBytes(24).toString('base64url')}`;
}
function pruneExpiredPeerTickets() {
  const now = Date.now();
  for (const [ticket, entry] of pendingPeerTickets) {
    if (now > entry.exp) pendingPeerTickets.delete(ticket);
  }
}

async function handlePeerTicketRequest(ws, message) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const targetAgentId = String(message.targetAgentId || '');
  if (!targetAgentId) throw badRequest('targetAgentId is required');
  const targetEntry = findConnectedAgent(ws.workspaceId, targetAgentId, '');
  if (!targetEntry) throw badRequest('Target agent is not connected');
  const rows = await getDb().unsafe(
    'select capabilities from agent_connections where id = $1',
    [targetEntry.connectionId],
  );
  const targetCaps = parseJsonObject(rows[0]?.capabilities);
  if (!reachIsDirect(targetCaps)) throw badRequest('Target agent is not direct-reachable');

  pruneExpiredPeerTickets();
  const ticket = mintPeerTicket();
  const exp = Date.now() + PEER_TICKET_TTL_MS;
  pendingPeerTickets.set(ticket, { from: ws.agentId, to: targetAgentId, exp });
  sendWs(targetEntry.ws, { type: 'peer_ticket_grant', ticket, exp, fromAgentId: ws.agentId });
  sendWs(ws, { type: 'peer_ticket', ticket, exp, peer: { agentId: targetAgentId, addrs: targetCaps.reach.addrs } });
}

// --- F7 hub-mediated discovery. Primary path; mDNS/LAN-broadcast deferred since the hub
// already stores each daemon's host and holds the live workspace-scoped connectedAgents
// map. New WS action:
//   Daemon -> hub:   { action:'peer_list_request' }
//   Hub -> daemon:   { type:'peer_list', peers:[{ agentId, handle, name, reach }] }
// `reach` here is the FULL block (LAN host/port) — this is a daemon-only channel and
// deliberately bypasses publicAgentConnection (which strips reach on the browser path).
async function handlePeerListRequest(ws) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const candidates = [...connectedAgents.values()].filter(
    (entry) => entry.workspaceId === ws.workspaceId && entry.agentId !== ws.agentId && entry.ws?.readyState === 1,
  );
  if (!candidates.length) {
    sendWs(ws, { type: 'peer_list', peers: [] });
    return;
  }
  const rows = await getDb().unsafe(
    'select id, agent_id, name, handle, capabilities from agent_connections where id = any($1::uuid[])',
    [candidates.map((entry) => entry.connectionId)],
  );
  const byConnectionId = new Map(rows.map((row) => [row.id, row]));
  const peers = [];
  for (const entry of candidates) {
    const row = byConnectionId.get(entry.connectionId);
    const caps = parseJsonObject(row?.capabilities);
    if (!reachIsDirect(caps)) continue;
    peers.push({ agentId: entry.agentId, handle: row?.handle || entry.handle, name: row?.name || entry.name, reach: caps.reach });
  }
  sendWs(ws, { type: 'peer_list', peers });
}

async function handleAgentCapabilitiesSync(ws, message) {
  const auth = ws.agentAuth;
  if (!auth) throw forbidden('Agent token is required');
  const workspaceId = ws.workspaceId || auth.workspaceId;
  const connectionId = ws.agentConnectionId;
  if (!workspaceId || !connectionId) throw forbidden('Agent is not registered');

  const capabilities = {
    skills: Array.isArray(message.skills) ? message.skills : [],
    // Slash commands the daemon enumerated on the user's machine: [{name, parent}].
    // Optional (older daemons don't send it) — the slash-commands endpoint tolerates absence.
    commands: Array.isArray(message.commands) ? message.commands : [],
    clis: Array.isArray(message.clis) ? message.clis : [],
    mcpServers: Array.isArray(message.mcpServers) ? message.mcpServers : [],
    memoryRoot: typeof message.memoryRoot === 'string' ? message.memoryRoot : null,
    // Direct-reachability advert (agent-mesh F2). Rides the SAME drift channel as the
    // rest of capabilities; the daemon folds JSON.stringify(reach) into its
    // capabilitiesHash so a reach change re-pushes via the existing
    // agent_capabilities_refresh nudge — no new sync channel. Optional: older daemons
    // omit it, stays undefined, capabilitiesShapeValid ignores it. Redacted from
    // browsers by publicAgentConnection; the FULL block (LAN host/port) reaches peer
    // daemons only via the hub peer_list_request/peer_list channel (F7).
    reach: reachFromMessage(message.reach),
    // Daemon-owned drift hashes. Stored as the reference the heartbeat drift-check
    // compares against; the server never recomputes these (avoids a cross-runtime
    // canonicalization contract). Advances only when a real snapshot lands here.
    hash: typeof message.hash === 'string' ? message.hash : null,
    memoryHash: typeof message.memoryHash === 'string' ? message.memoryHash : null,
  };

  const rows = await getDb().unsafe(
    `update agent_connections set capabilities = $2::jsonb, updated_at = now()
     where id = $1 returning *`,
    [connectionId, JSON.stringify(capabilities)],
  );
  if (rows.length > 0) notifyDbSubscribers('agent_connections', 'UPDATE', rows.map(publicAgentConnection));
}

// Finalize ONE agent job (daemon push OR MCP pull) with its result, then resume the
// conversation. Shared so both paths render replies identically: mark the job done/error,
// rewrite the "Thinking …" placeholder (or insert a fresh message), log to Activity, and
// continue the channel turn loop. `job` must carry agent_name/agent_handle (join on load).
async function finalizeAgentJobResult(job, { responseText = '', errorText = '', fallbackName = null, fallbackHandle = null } = {}) {
  const status = errorText ? 'error' : 'done';
  const updatedRows = await getDb().unsafe(
    `update agent_jobs set status = $2, response = $3, error = $4, finished_at = now(), updated_at = now()
     where id = $1 returning *`,
    [job.id, status, responseText, errorText],
  );
  notifyDbSubscribers('agent_jobs', 'UPDATE', updatedRows);

  const handle = job.agent_handle || fallbackHandle || slugHandle(job.agent_name);
  const senderName = job.agent_name || fallbackName || handle;
  const content = errorText
    ? `@${handle} failed: ${errorText}`
    : (responseText || `@${handle} finished without output.`);
  const jobMetadata = parseJsonObject(job.metadata);
  const threadParentId = jobMetadata.threadParentId || null;
  const responseMessageId = jobMetadata.responseMessageId || null;
  if (responseMessageId) {
    const messageRows = await getDb().unsafe(
      `update messages set content = $2, sender_kind = 'agent', sender_id = $3, sender_name = $4
       where id = $1 and session_id = $5 returning *`,
      [responseMessageId, content, String(job.agent_id || ''), senderName, job.session_id],
    );
    if (messageRows.length > 0) {
      notifyDbSubscribers('messages', 'UPDATE', messageRows);
      void logMessageActivity(messageRows);
    }
  } else {
    const messageRows = await getDb().unsafe(
      `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
       values ($1, 'assistant', $2, $3, 'agent', $4, $5) returning *`,
      [job.session_id, content, threadParentId, String(job.agent_id || ''), senderName],
    );
    notifyDbSubscribers('messages', 'INSERT', messageRows);
  }
  void continueConversation({ workspaceId: job.workspace_id, sessionId: job.session_id, threadParentId })
    .catch((error) => console.error('continueConversation (job finalize) failed', error));
}

async function handleAgentJobResult(ws, message) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const jobId = String(message.jobId || '');
  if (!jobId) throw badRequest('jobId is required');
  const rows = await getDb().unsafe(
    `select j.*, a.name as agent_name, a.handle as agent_handle
     from agent_jobs j left join workspace_agents a on a.id = j.agent_id
     where j.id = $1 and j.agent_id = $2 and j.workspace_id = $3 limit 1`,
    [jobId, auth.agentId, auth.workspaceId],
  );
  const job = rows[0];
  if (!job) throw forbidden('Agent job not found');
  await finalizeAgentJobResult(job, {
    responseText: textFromValue(message.response).trim(),
    errorText: textFromValue(message.error).trim(),
    fallbackName: auth.name,
    fallbackHandle: auth.handle,
  });
  await updateAgentHeartbeat(ws, { busy: false }).catch(() => {});
}

// --- MCP pull worker API (backs the claim_job / submit_job_result tools) ----------
// A client working AS an agent polls claimMcpJob; the poll refreshes presence (so
// dispatch keeps enqueuing) and atomically claims the oldest queued MCP job for that
// agent. FOR UPDATE SKIP LOCKED means N clients polling as the same agent never double-
// claim — that's how "3× Q" share one queue.
async function claimMcpJob({ workspaceId, agentId }) {
  if (!agentId) return null;
  touchMcpPresence(agentId);
  const claimed = await getDb().unsafe(
    `update agent_jobs set status = 'running', started_at = now(), updated_at = now()
     where id = (
       select id from agent_jobs
        where workspace_id = $1 and agent_id = $2 and status = 'queued' and (metadata->>'mode') = 'mcp'
        order by created_at asc limit 1 for update skip locked
     ) returning *`,
    [workspaceId, agentId],
  );
  const job = claimed[0];
  if (!job) return null;
  notifyDbSubscribers('agent_jobs', 'UPDATE', claimed);
  const agentRows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [agentId]);
  const meta = parseJsonObject(job.metadata);
  return {
    jobId: job.id,
    prompt: job.prompt || '',
    sessionId: job.session_id,
    threadParentId: meta.threadParentId || null,
    agent: agentRows[0] ? agentRuntimePayload(agentRows[0]) : null,
  };
}

async function submitMcpJobResult({ workspaceId, agentId, jobId, responseText = '', errorText = '' }) {
  if (!jobId) throw badRequest('jobId is required');
  if (!agentId) throw badRequest('Agent job not found');
  const rows = await getDb().unsafe(
    `select j.*, a.name as agent_name, a.handle as agent_handle
     from agent_jobs j left join workspace_agents a on a.id = j.agent_id
     where j.id = $1 and j.workspace_id = $2 and j.agent_id = $3 limit 1`,
    [jobId, workspaceId, agentId],
  );
  const job = rows[0];
  if (!job) throw badRequest('Agent job not found');
  if (parseJsonObject(job.metadata).mode !== 'mcp') throw badRequest('Job is not an MCP job');
  // Accept a late result even after the reaper force-failed the job to 'error'
  // (the client wasn't actually dead, just slow) — recovering the real response
  // is better than discarding it. Only a job that already completed successfully
  // ('done') or was never claimed ('queued') is genuinely not awaiting a result.
  // (M3, 2026-07 review.)
  if (job.status !== 'running' && job.status !== 'error') {
    throw badRequest(`Job is ${job.status}, not awaiting a result`);
  }
  touchMcpPresence(agentId); // a submitting client is alive
  await finalizeAgentJobResult(job, { responseText, errorText });
  return { jobId: job.id, status: errorText ? 'error' : 'done' };
}

// Backstop: an MCP job whose client vanished mid-flight (or nobody ever claimed it)
// gets finalized with an error so the chat doesn't hang on "Thinking …".
async function reapStuckMcpJobs() {
  try {
    const rows = await getDb().unsafe(
      // Time out on run duration (started_at), not creation, so a legitimately
      // long coding/research turn isn't force-failed just because it queued for
      // a while first; queued-but-never-claimed jobs fall back to created_at.
      // (M3, 2026-07 review — mirrors the daemon's started_at-based reaper.)
      `select j.*, a.name as agent_name, a.handle as agent_handle
       from agent_jobs j left join workspace_agents a on a.id = j.agent_id
       where (j.metadata->>'mode') = 'mcp' and j.status in ('queued', 'running')
         and coalesce(j.started_at, j.created_at) < now() - interval '240 seconds'`,
    );
    for (const job of rows) {
      await finalizeAgentJobResult(job, { errorText: 'the MCP client stopped responding' }).catch(() => {});
    }
  } catch {
    // best effort
  }
}

// --- agent registration ("a client wants to register as an agent") ----------------
// An authenticated MCP client (workspace token / agensis login / invite link) calls
// register_agent to become an agent — a brand new one, or an existing one by handle.
// Pending registrations raise an approval popup; invite/auto-approve skip straight to
// approved. Approval is what flips an agent's mcp_approved flag so it can be worked as.

async function finalizeRegistrationApproval(reg) {
  let agentId = reg.agent_id;
  let handle = reg.requested_handle;
  let name = reg.requested_name;
  if (agentId) {
    const upd = await getDb().unsafe(
      'update workspace_agents set mcp_approved = true, enabled = true, updated_at = now() where id = $1 returning *',
      [agentId],
    );
    if (upd[0]) { notifyDbSubscribers('workspace_agents', 'UPDATE', upd); handle = slugHandle(upd[0].handle || upd[0].name); name = upd[0].name; }
  } else {
    const created = await getDb().unsafe(
      `insert into workspace_agents (workspace_id, name, handle, description, system_prompt, model, run_mode, permission_mode, avatar, accent_color, enabled, mcp_approved)
       values ($1, $2, $3, '', '', 'auto', 'builtin', 'default', 'AI', '#00a95c', true, true)
       returning *`,
      [reg.workspace_id, name || handle || 'Agent', slugHandle(handle || name || 'agent')],
    );
    agentId = created[0].id;
    handle = slugHandle(created[0].handle || created[0].name);
    notifyDbSubscribers('workspace_agents', 'INSERT', created);
  }
  const updReg = await getDb().unsafe(
    `update agent_registrations set status = 'approved', agent_id = $2, decided_at = now(), updated_at = now() where id = $1 returning *`,
    [reg.id, agentId],
  );
  notifyDbSubscribers('agent_registrations', 'UPDATE', updReg);
  return { agentId, handle, name };
}

async function registerAgentRequest({ workspaceId, asHandle = null, name = null, handle = null, clientLabel = '', autoApprove = false }) {
  let agent = null;
  if (asHandle) {
    agent = await resolveWorkspaceAgentByHandle(workspaceId, asHandle);
    if (!agent) throw badRequest(`No agent "@${slugHandle(asHandle)}" in this workspace`);
    if (agent.mcp_approved) {
      return { status: 'approved', agentId: agent.id, handle: slugHandle(agent.handle || agent.name) };
    }
  }
  const reqHandle = agent ? slugHandle(agent.handle || agent.name) : slugHandle(handle || name || 'agent');
  const reqName = agent ? agent.name : (name || reqHandle);
  const rows = await getDb().unsafe(
    `insert into agent_registrations (workspace_id, agent_id, requested_handle, requested_name, client_label, status)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [workspaceId, agent ? agent.id : null, reqHandle, reqName, String(clientLabel || '').slice(0, 120), autoApprove ? 'approved' : 'pending'],
  );
  const reg = rows[0];
  notifyDbSubscribers('agent_registrations', 'INSERT', rows);
  if (autoApprove) {
    const out = await finalizeRegistrationApproval(reg);
    return { registrationId: reg.id, status: 'approved', agentId: out.agentId, handle: out.handle };
  }
  return { registrationId: reg.id, status: 'pending', handle: reqHandle };
}

// Poll target for the client between register_agent and approval.
async function getRegistrationStatus({ workspaceId, registrationId }) {
  const rows = await getDb().unsafe(
    'select id, status, agent_id, requested_handle from agent_registrations where id = $1 and workspace_id = $2 limit 1',
    [registrationId, workspaceId],
  );
  const reg = rows[0];
  if (!reg) throw badRequest('Registration not found');
  return { registrationId: reg.id, status: reg.status, agentId: reg.agent_id, handle: reg.requested_handle };
}

async function decideAgentRegistration({ registrationId, approve }) {
  const rows = await getDb().unsafe('select * from agent_registrations where id = $1 limit 1', [registrationId]);
  const reg = rows[0];
  if (!reg) return null;
  if (reg.status !== 'pending') return reg;
  if (approve) return finalizeRegistrationApproval(reg);
  const denied = await getDb().unsafe(
    `update agent_registrations set status = 'denied', decided_at = now(), updated_at = now() where id = $1 returning *`,
    [registrationId],
  );
  notifyDbSubscribers('agent_registrations', 'UPDATE', denied);
  return denied[0];
}

async function handleAgentJobDelta(ws, message) {
  const auth = ws.agentAuth;
  if (!auth || !ws.agentConnectionId) throw forbidden('Agent is not registered');
  const jobId = String(message.jobId || '');
  if (!jobId) throw badRequest('jobId is required');
  const rows = await getDb().unsafe(
    `select j.*, a.name as agent_name, a.handle as agent_handle
     from agent_jobs j
     left join workspace_agents a on a.id = j.agent_id
     where j.id = $1 and j.agent_id = $2 and j.workspace_id = $3
     limit 1`,
    [jobId, auth.agentId, auth.workspaceId],
  );
  const job = rows[0];
  if (!job) throw forbidden('Agent job not found');
  const metadata = parseJsonObject(job.metadata);
  const responseMessageId = metadata.responseMessageId || null;
  if (!responseMessageId) return;
  const content = agentLiveMessageContent(message);
  const updatedRows = await getDb().unsafe(
    `update messages
     set content = $2,
         sender_kind = 'agent',
         sender_id = $3,
         sender_name = $4
     where id = $1 and session_id = $5
     returning *`,
    [responseMessageId, content, String(job.agent_id || ''), job.agent_name || auth.name || auth.handle || 'Agent', job.session_id],
  );
  if (updatedRows.length > 0) {
    notifyDbSubscribers('messages', 'UPDATE', updatedRows);
  }
  await getDb().unsafe(
    `update agent_jobs
     set response = $2,
         updated_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb
     where id = $1`,
    [
      jobId,
      textFromValue(message.content ?? message.response ?? '').trim(),
      JSON.stringify({ lastDeltaAt: new Date().toISOString(), elapsedMs: Number(message.elapsedMs || 0) }),
    ],
  );
  await updateAgentHeartbeat(ws, { busy: true }).catch(() => {});
}

async function runAnthropicCompletion({ model, messages, memory, documents, workspaceContext, agentContext, workspaceId = null }) {
  const apiKey = await getAnthropicApiKey(workspaceId);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: resolveAnthropicModel(model),
      max_tokens: 4096,
      messages: Array.isArray(messages) ? messages.map((m) => ({ role: m.role, content: m.content })) : [],
      system: buildSystemPrompt(memory, documents, workspaceContext, agentContext),
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json();
  return (payload.content || [])
    .map((part) => part?.type === 'text' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function safeFileName(name) {
  return String(name || 'upload')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'upload';
}

function getUploadRoot() {
  return process.env.AGENSIS_UPLOAD_ROOT || path.join(process.cwd(), '.agensis_uploads');
}

function storagePathFor(workspaceId, id, name) {
  return path.join(String(workspaceId), `${id}-${safeFileName(name)}`);
}

function resolveStoragePath(storagePath) {
  const root = path.resolve(getUploadRoot());
  const fullPath = path.resolve(root, storagePath || '');
  if (!fullPath.startsWith(root + path.sep)) {
    throw new Error('Invalid storage path');
  }
  return fullPath;
}

// ============================================================
// File upload content-type hardening (plan 002).
//
// Server-side mirror of src/components/files/FileUpload.tsx's
// ALLOWED_EXTENSIONS map — keep the two lists in sync. The client's `type`
// (browser-reported MIME) is untrusted and easily spoofed, so the server
// NEVER stores or serves it verbatim: the stored/served Content-Type is
// always derived from this allowlist, keyed on the upload's file extension.
//
// `.html` and `.svg` can carry executable script when rendered inline by a
// browser, so — per plan 002's "reject-and-neutralize" decision — uploads of
// those two extensions are still accepted (matching the client's advertised
// feature set) but their Content-Type is neutralized to `text/plain` here,
// at storage time, rather than trusting anything downstream to catch it.
const UPLOAD_EXTENSION_CONTENT_TYPES = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'text/plain', // neutralized — see FORCE_ATTACHMENT_EXTENSIONS below
  bmp: 'image/bmp',
  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Text / data
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  rtf: 'application/rtf',
  // Code (browsers often report "" or text/plain for these)
  json: 'application/json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  html: 'text/plain', // neutralized — see FORCE_ATTACHMENT_EXTENSIONS below
  css: 'text/css',
  xml: 'application/xml',
  yml: 'text/yaml',
  yaml: 'text/yaml',
};

// Extensions whose native rendering can execute script inline — always
// served as a download (Content-Disposition: attachment), independent of
// whatever Content-Type ends up stored (belt-and-suspenders: this check runs
// at serve time using the ORIGINAL FILENAME, since Step 1 above already
// neutralizes the stored type for these two to `text/plain`, which would
// otherwise make a stored-type-only check below a no-op for the normal
// upload path).
const FORCE_ATTACHMENT_EXTENSIONS = new Set(['html', 'svg']);

// Defense-in-depth: `uploaded_files` is also reachable through the generic
// `/backend/db/*` CRUD routes (it's in ALLOWED_TABLES), so a write-role user
// could PATCH a row's `type` column directly to one of these dangerous MIME
// strings without ever going through the upload handler above. Force
// attachment for these regardless of the file's extension/name.
const FORCE_ATTACHMENT_CONTENT_TYPES = new Set([
  'text/html',
  'image/svg+xml',
  'application/xhtml+xml',
  'text/xml',
]);

function getUploadExtension(name) {
  const trimmed = String(name || '');
  const dot = trimmed.lastIndexOf('.');
  return dot >= 0 ? trimmed.slice(dot + 1).toLowerCase() : '';
}

// Deny-by-default lookup: plain bracket/dot access on a POJO also resolves
// inherited members (e.g. `x.constructor` or `x.__proto__` would otherwise
// "match" and return a non-undefined value), which would let an attacker
// smuggle an extension past the allowlist. `Object.hasOwn` restricts the
// lookup to the allowlist's own declared keys.
function lookupUploadContentType(extension) {
  return Object.hasOwn(UPLOAD_EXTENSION_CONTENT_TYPES, extension)
    ? UPLOAD_EXTENSION_CONTENT_TYPES[extension]
    : undefined;
}

const PROJECT_FILE_IGNORE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'out',
  'coverage',
  '.agensis_uploads',
  'release',
  '.cache',
  '.turbo',
]);

// F3 (2026-07 review): git_root/local_path are user-writable workspace columns
// (set via the generic /backend/db/workspaces update, gated only on 'manage'),
// and feed straight into fs reads + `git -C <root>` on THIS host. Without an
// allowlist, a workspace admin could point either column at any directory the
// process can read/commit. AGENSIS_PROJECT_ROOTS is a colon-separated list of
// absolute prefixes this host is willing to touch; AGENSIS_ALLOW_PROJECT_FS is
// the opt-in switch (default OFF — e.g. the shared fly.dev backend leaves both
// unset so project/git routes always return their empty payload instead of
// touching disk). A per-user local daemon opts in by setting both.
function projectFsAllowed() {
  return String(process.env.AGENSIS_ALLOW_PROJECT_FS || '').trim() === 'true';
}

function allowedProjectRootPrefixes() {
  return String(process.env.AGENSIS_PROJECT_ROOTS || '')
    .split(':')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => path.resolve(entry));
}

// Realpath-contained within one of the allowlisted prefixes (mirrors the
// resolveWithinRoot symlink-escape check below, but against a set of roots
// instead of one path's relative traversal).
function isWithinAllowedProjectRoot(resolvedPath) {
  if (!projectFsAllowed()) return false;
  const prefixes = allowedProjectRootPrefixes();
  if (prefixes.length === 0) return false;
  let real;
  try { real = fs.realpathSync(resolvedPath); } catch { real = resolvedPath; }
  return prefixes.some((prefix) => {
    let realPrefix;
    try { realPrefix = fs.realpathSync(prefix); } catch { realPrefix = prefix; }
    const withSep = realPrefix.endsWith(path.sep) ? realPrefix : `${realPrefix}${path.sep}`;
    return real === realPrefix || real.startsWith(withSep);
  });
}

function workspaceProjectRoot(workspace) {
  const candidate = String(workspace?.git_root || workspace?.local_path || '').trim();
  if (!candidate) return '';
  const resolved = path.resolve(candidate);
  if (!isWithinAllowedProjectRoot(resolved)) return '';
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return '';
    return resolved;
  } catch {
    return '';
  }
}

function validFileSourceRoot(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  const resolved = path.resolve(candidate);
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return '';
    return resolved;
  } catch {
    return '';
  }
}

async function workspaceProjectFileSources(workspaceId, workspace, filters = {}) {
  const agentFilterKeys = new Set(
    (Array.isArray(filters.agents) ? filters.agents : [])
      .map(value => slugHandle(value || ''))
      .filter(Boolean),
  );
  const hasAgentFilter = agentFilterKeys.size > 0;
  const sources = [];
  const seen = new Set();
  const addSource = (source) => {
    const root = validFileSourceRoot(source.root);
    if (!root || seen.has(root)) return;
    seen.add(root);
    sources.push({ ...source, root });
  };

  addSource({
    id: 'workspace',
    kind: 'workspace',
    label: 'Workspace folder',
    root: workspaceProjectRoot(workspace),
  });

  const connections = await getDb().unsafe(
    `select id, agent_id, name, handle, host, cwd, status
     from agent_connections
     where workspace_id = $1
       and coalesce(cwd, '') <> ''
       and last_seen_at > now() - interval '24 hours'
     order by status = 'online' desc, status = 'busy' desc, last_seen_at desc`,
    [workspaceId],
  );

  connections.forEach(connection => {
    const handle = slugHandle(connection.handle || connection.name || 'agent');
    const connectionKeys = [
      connection.id,
      connection.agent_id,
      connection.handle,
      connection.name,
      handle,
      `agent:${connection.agent_id || ''}`,
      `agent:${handle}`,
    ].map(value => slugHandle(value || '')).filter(Boolean);
    if (hasAgentFilter && !connectionKeys.some(key => agentFilterKeys.has(key))) return;
    addSource({
      id: `agent:${connection.id}`,
      kind: 'agent',
      label: `${connection.name || handle} cwd`,
      root: connection.cwd,
      agent_id: connection.agent_id || null,
      connection_id: connection.id,
      handle,
      host: connection.host || '',
      status: connection.status || '',
    });
  });

  return sources;
}

function listProjectFiles(root, maxFiles = 300) {
  const files = [];
  const queue = [''];
  while (queue.length > 0 && files.length < maxFiles) {
    const relativeDir = queue.shift();
    const absoluteDir = path.join(root, relativeDir || '');
    let entries = [];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries
      .filter(entry => !entry.name.startsWith('.') || entry.name === '.env.example')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .forEach(entry => {
        if (files.length >= maxFiles) return;
        const rel = path.join(relativeDir || '', entry.name);
        if (entry.isDirectory()) {
          if (!PROJECT_FILE_IGNORE_DIRS.has(entry.name)) queue.push(rel);
          return;
        }
        if (!entry.isFile()) return;
        const fullPath = path.join(root, rel);
        try {
          const stat = fs.statSync(fullPath);
          files.push({
            path: rel.split(path.sep).join('/'),
            name: entry.name,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            kind: 'file',
          });
        } catch {
          // ignore files that disappear while listing
        }
      });
  }
  return files;
}

function textFromValue(value) {
  if (typeof value === 'string') {
    return value === '[object Object]' ? '' : value;
  }
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const keys = ['text', 'content', 'message', 'response', 'output', 'stdout', 'stderr', 'error'];
    for (const key of keys) {
      const text = textFromValue(value[key]);
      if (text) return text;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

function resolveCommandPath(command) {
  const pathEnv = process.env.PATH || '';
  const home = os.homedir();
  const nvmBinDirs = [];
  try {
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
    fs.readdirSync(nvmVersions, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .forEach(entry => nvmBinDirs.push(path.join(nvmVersions, entry.name, 'bin')));
  } catch {
    // optional
  }
  const candidates = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    ...nvmBinDirs,
  ];
  const seen = new Set();
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function probeCommand(command, args = ['--version']) {
  const resolvedPath = resolveCommandPath(command);
  if (!resolvedPath) return { command, available: false, path: null, version: null };
  let version = null;
  try {
    const { stdout, stderr } = await execFileAsync(resolvedPath, args, { timeout: 5000, maxBuffer: 1024 * 128 });
    version = String(stdout || stderr || '').trim().split('\n')[0] || null;
  } catch (error) {
    version = String(error.stdout || error.stderr || '').trim().split('\n')[0] || null;
  }
  return { command, available: true, path: resolvedPath, version };
}

function packageStatus(name) {
  try {
    const packagePath = require.resolve(`${name}/package.json`, { paths: [process.cwd()] });
    const json = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return { name, available: true, version: json.version || null, path: packagePath };
  } catch {
    return { name, available: false, version: null, path: null };
  }
}

function countDirectoryEntries(dir, predicate = () => true) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
  } catch {
    return 0;
  }
}

function detectSkillLibraries(workspacePath = '') {
  const home = os.homedir();
  const repoPath = workspacePath && path.isAbsolute(workspacePath) ? workspacePath : process.cwd();
  const candidates = [
    { id: 'codex-user-skills', label: 'Codex user skills', type: 'skills', path: path.join(home, '.codex', 'skills') },
    { id: 'agents-user-skills', label: 'Local agent skills', type: 'skills', path: path.join(home, '.agents', 'skills') },
    { id: 'workspace-codex-skills', label: 'Workspace Codex skills', type: 'skills', path: path.join(repoPath, '.codex', 'skills') },
    { id: 'claude-agents', label: 'Claude agents', type: 'agents', path: path.join(home, '.claude', 'agents') },
    { id: 'workspace-claude-agents', label: 'Workspace Claude agents', type: 'agents', path: path.join(repoPath, '.claude', 'agents') },
    { id: 'claude-commands', label: 'Claude commands', type: 'commands', path: path.join(home, '.claude', 'commands') },
    { id: 'codex-config', label: 'Codex config', type: 'config', path: path.join(home, '.codex', 'config.toml') },
    { id: 'gemini-config', label: 'Gemini settings', type: 'config', path: path.join(home, '.gemini', 'settings.json') },
    { id: 'qwen-config', label: 'Qwen settings', type: 'config', path: path.join(home, '.qwen', 'settings.json') },
    { id: 'opencode-config', label: 'OpenCode config', type: 'config', path: path.join(home, '.config', 'opencode', 'opencode.json') },
  ];

  return candidates.map(candidate => {
    const exists = fs.existsSync(candidate.path);
    const isDirectory = exists && fs.statSync(candidate.path).isDirectory();
    return {
      ...candidate,
      available: exists,
      count: isDirectory ? countDirectoryEntries(candidate.path, entry => !entry.name.startsWith('.')) : exists ? 1 : 0,
    };
  });
}

// Merge the slash commands/skills that connected daemons pushed (each in its
// agent_connections.capabilities) into a single deduped SlashItem[] the composer's
// `/` menu can render. Built-ins are client-side, so they're intentionally absent
// here. Shape mirrors src/lib/slashCommands.ts's SlashItem. Pure for unit testing.
function mergeSlashCommands(capabilitiesList) {
  const byId = new Map();
  const put = (item) => {
    if (!item.name || byId.has(item.id)) return;
    byId.set(item.id, item);
  };
  for (const caps of capabilitiesList || []) {
    if (!caps || typeof caps !== 'object') continue;
    const commands = Array.isArray(caps.commands) ? caps.commands : [];
    for (const entry of commands) {
      const name = entry && typeof entry.name === 'string' ? entry.name : '';
      if (!name) continue;
      const parent = entry.parent && typeof entry.parent === 'string' ? entry.parent : null;
      if (parent) {
        put({ id: `skill-command:${parent}:${name}`, name, kind: 'skill-command', parent, run: 'insert', detail: parent });
      } else {
        put({ id: `command:${name}`, name, kind: 'command', run: 'insert', detail: 'Command' });
      }
    }
    const skills = Array.isArray(caps.skills) ? caps.skills : [];
    for (const skill of skills) {
      if (typeof skill !== 'string' || !skill) continue;
      put({ id: `skill:${skill}`, name: skill, kind: 'skill', run: 'insert', detail: 'Skill' });
    }
  }
  return Array.from(byId.values());
}

async function detectCapabilities(workspacePath = '') {
  const cliDefinitions = [
    { id: 'claude', label: 'Claude Code', command: 'claude' },
    { id: 'codex', label: 'Codex', command: 'codex' },
    { id: 'opencode', label: 'OpenCode', command: 'opencode' },
    { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
    { id: 'qwen', label: 'Qwen Code', command: 'qwen' },
    { id: 'goose', label: 'Goose', command: 'goose' },
    { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent' },
    { id: 'amp', label: 'Amp', command: 'amp' },
    { id: 'crush', label: 'Charm Crush', command: 'crush' },
    { id: 'grok', label: 'Grok', command: 'grok' },
    { id: 'aider', label: 'Aider', command: 'aider' },
    { id: 'kimi', label: 'Kimi', command: 'kimi' },
  ];

  // Global timeout for all CLI probes combined (they run in parallel via Promise.all).
  const CLIPROBE_TIMEOUT_MS = 10000;
  const cliProbePromise = Promise.all(cliDefinitions.map(async definition => ({
    ...definition,
    ...(await probeCommand(definition.command)),
  })));

  const clis = await Promise.race([
    cliProbePromise,
    new Promise(resolve => setTimeout(() => {
      resolve(cliDefinitions.map(def => ({ ...def, command: def.command, available: false, path: null, version: null })));
    }, CLIPROBE_TIMEOUT_MS)),
  ]);

  const packages = [
    '@anthropic-ai/claude-agent-sdk',
    '@agentclientprotocol/claude-agent-acp',
    '@agentclientprotocol/sdk',
    '@openai/codex',
    '@anthropic-ai/sdk',
  ].map(packageStatus);

  return {
    checkedAt: new Date().toISOString(),
    workspacePath: workspacePath || process.cwd(),
    clis,
    packages,
    skills: detectSkillLibraries(workspacePath),
    codexAppServer: {
      available: clis.some(cli => cli.id === 'codex' && cli.available),
      command: 'codex app-server',
      transports: ['stdio', 'websocket', 'unix'],
    },
  };
}

async function inspectProjectPath(inputPath) {
  const resolved = path.resolve(String(inputPath || ''));
  const exists = fs.existsSync(resolved);
  const result = {
    path: resolved,
    exists,
    isDirectory: exists ? fs.statSync(resolved).isDirectory() : false,
    gitRoot: '',
    gitBranch: '',
    gitRemote: '',
    projectKind: exists ? 'folder' : '',
  };
  if (!exists) return result;

  try {
    const { stdout } = await execFileAsync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
    result.gitRoot = stdout.trim();
    result.projectKind = 'git';
  } catch {
    return result;
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', resolved, 'branch', '--show-current'], { timeout: 5000 });
    result.gitBranch = stdout.trim();
  } catch {
    // optional
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', resolved, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    result.gitRemote = stdout.trim();
  } catch {
    // optional
  }
  return result;
}

function buildSystemPrompt(memory, documents, workspaceContext, agentContext) {
  const sections = [];
  if (agentContext && (agentContext.systemPrompt || agentContext.name)) {
    if (agentContext.name) {
      sections.push(`You are "${agentContext.name}", an AI agent collaborating in a shared agensis workspace.`);
    }
    if (agentContext.soul) {
      sections.push(`Agent soul: ${agentContext.soul}`);
    }
    if (agentContext.systemPrompt) {
      sections.push(agentContext.systemPrompt);
    }
    if (agentContext.instructions) {
      sections.push(`Instructions:\n${agentContext.instructions}`);
    }
    if (Array.isArray(agentContext.tools) && agentContext.tools.length > 0) {
      sections.push(`Available tool preferences: ${agentContext.tools.join(', ')}`);
    }
    if (Array.isArray(agentContext.skills) && agentContext.skills.length > 0) {
      sections.push(`Selected skill libraries: ${agentContext.skills.join(', ')}`);
    }
    if (Array.isArray(agentContext.coParticipants) && agentContext.coParticipants.length > 0) {
      const roster = agentContext.coParticipants.map((peer) => `@${peer.handle}${peer.name ? ` (${peer.name})` : ''}`).join(', ');
      sections.push(
        '',
        `This is a multi-agent channel. Other agents you can collaborate with: ${roster}.`,
        '- In the conversation history, each message is prefixed with the speaker, e.g. "[@handle]: ...". Messages without a prefix are your own.',
        '- To bring another agent into the conversation, address them by @handle in your reply. Only mention an agent when you genuinely need their help — do not @ them out of politeness, or the conversation will loop.',
        '- If the request is already fully handled, answer without mentioning anyone so the conversation can end.',
      );
    }
    sections.push('');
  } else {
    sections.push(
      'You are agensis AI, a collaborative workspace assistant. You help teams think, write, and get work done inside a shared workspace that contains documents, chats, memory, tasks, files, and a shared canvas.',
      '',
    );
  }
  sections.push(
    'Guidelines:',
    '- Be concise, warm, and thoughtful. Prefer markdown for structure.',
    '- When you reference workspace content, quote the title so teammates can find it.',
    '- When the user asks you to extract or create tasks, emit them on their own lines using this exact format so the app can parse them: `TASK: <title>` (one task per line).',
    '- If you do not know something from the provided context, say so rather than inventing.',
    '- You are one of potentially many people in this workspace; speak in a way that is useful to the whole team, not just a single user.',
  );

  if (workspaceContext) {
    const wsBlocks = [];
    if (workspaceContext.workspace) wsBlocks.push(`Workspace name: ${workspaceContext.workspace}`);
    if (workspaceContext.memory) wsBlocks.push(`# Team memory\n${workspaceContext.memory}`);
    if (workspaceContext.documents) wsBlocks.push(`# Key documents\n${workspaceContext.documents}`);
    if (workspaceContext.tasks) wsBlocks.push(`# Open tasks\n${workspaceContext.tasks}`);
    if (workspaceContext.canvas) wsBlocks.push(`# Canvas notes\n${workspaceContext.canvas}`);
    if (workspaceContext.agents) wsBlocks.push(`# Workspace agents\n${workspaceContext.agents}`);
    if (workspaceContext.skills) wsBlocks.push(`# Skill libraries\n${workspaceContext.skills}`);
    if (workspaceContext.commands) wsBlocks.push(`# Commands and CLIs\n${workspaceContext.commands}`);
    if (workspaceContext.tools) wsBlocks.push(`# Tools and SDKs\n${workspaceContext.tools}`);
    if (workspaceContext.webhooks) wsBlocks.push(`# Agent webhooks\n${workspaceContext.webhooks}`);
    if (wsBlocks.length > 0) {
      sections.push('', '<workspace_context>', 'The following is a snapshot of the shared workspace you are assisting in. Use it to answer grounded questions, but do not dump it verbatim unless asked.', '', wsBlocks.join('\n\n'), '</workspace_context>');
    }
  }

  if (memory) sections.push('', '<user_memory>', 'Persistent facts the user has saved. Use this to personalize responses.', memory, '</user_memory>');
  if (documents) sections.push('', '<linked_documents>', 'The user has explicitly linked these documents for this message. Treat them as high-priority context.', documents, '</linked_documents>');
  return sections.join('\n');
}

function sendWs(ws, message) {
  if (ws.readyState !== 1) return;
  // Drop instead of unbounded-buffering when a slow client backs up, and never let
  // a broken-pipe send throw into the realtime loop (it would skip later clients).
  if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > 4 * 1024 * 1024) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // socket went away mid-send; its 'close' handler will clean up subscriptions
  }
}

function parseFilter(filter) {
  if (!filter || typeof filter !== 'string') return null;
  const match = filter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=eq\.(.+)$/);
  if (!match) return null;
  return { column: match[1], value: match[2] };
}

function matchesFilter(filter, row) {
  const parsed = parseFilter(filter);
  if (!parsed) return true;
  return String(row?.[parsed.column] ?? '') === parsed.value;
}

const ACTIVITY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// LRU cache for session-to-workspace lookups. Capped to prevent unbounded
// memory growth on long-running servers.
const WORKSPACE_SESSION_CACHE_MAX = 2000;
const workspaceIdBySessionCache = new Map();

function workspaceSessionCacheGet(sessionId) {
  const value = workspaceIdBySessionCache.get(sessionId);
  if (value === undefined) return undefined;
  // Move to end (most recently used) by re-inserting.
  workspaceIdBySessionCache.delete(sessionId);
  workspaceIdBySessionCache.set(sessionId, value);
  return value;
}

function workspaceSessionCacheSet(sessionId, workspaceId) {
  if (workspaceIdBySessionCache.has(sessionId)) workspaceIdBySessionCache.delete(sessionId);
  workspaceIdBySessionCache.set(sessionId, workspaceId);
  // Evict oldest entries when the cache exceeds capacity.
  if (workspaceIdBySessionCache.size > WORKSPACE_SESSION_CACHE_MAX) {
    const excess = workspaceIdBySessionCache.size - WORKSPACE_SESSION_CACHE_MAX;
    let evicted = 0;
    for (const key of workspaceIdBySessionCache.keys()) {
      if (evicted >= excess) break;
      workspaceIdBySessionCache.delete(key);
      evicted++;
    }
  }
}

async function resolveWorkspaceIdForSession(sessionId) {
  if (!sessionId) return null;
  const cached = workspaceSessionCacheGet(sessionId);
  if (cached !== undefined) return cached;
  try {
    const rows = await getDb().unsafe(
      'select workspace_id from chat_sessions where id = $1 limit 1',
      [sessionId],
    );
    const workspaceId = rows[0]?.workspace_id || null;
    if (workspaceId) workspaceSessionCacheSet(sessionId, workspaceId);
    return workspaceId;
  } catch (error) {
    console.error('resolveWorkspaceIdForSession failed', error);
    return null;
  }
}

// Logs an `activity_events` row for each inserted/finalized chat message so it
// surfaces in the Activity feed. Fire-and-forget; never blocks message delivery.
async function logMessageActivity(rows) {
  for (const message of rows) {
    if (!message || typeof message !== 'object') continue;
    // Skip the "Thinking 0s" placeholder agent rows — the real reply is logged
    // when the message is finalized via UPDATE.
    if (isAgentPlaceholder(message)) continue;
    try {
      const sessionId = message.session_id;
      const workspaceId = await resolveWorkspaceIdForSession(sessionId);
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
      // C3: idempotent insert. ON CONFLICT DO NOTHING against the partial unique
      // index uq_activity_events_message_sent means a retried finalization for the
      // same message id is a no-op (returns 0 rows), so the feed row — and its
      // realtime notification below — fire exactly once. Target left off so it
      // degrades to a plain insert if the index hasn't been created yet.
      const inserted = await getDb().unsafe(
        `insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
         values ($1, $2, 'message_sent', 'message', $3, $4, $5::jsonb, now())
         on conflict do nothing
         returning *`,
        [workspaceId, userId, message.id != null ? String(message.id) : null, title, JSON.stringify(metadata)],
      );
      if (inserted.length > 0) {
        // table is 'activity_events' here, so this cannot re-trigger message logging.
        notifyDbSubscribers('activity_events', 'INSERT', inserted);
      }
    } catch (error) {
      console.error('logMessageActivity failed', error);
    }
  }
}

// Logs an `activity_events` row when an agent daemon connects or disconnects, so
// the notifications bell can show a timestamped connection history (one row per
// event) instead of a single collapsing per-agent entry. Fire-and-forget — never
// blocks the connect/disconnect path. Only real connects and real socket-close
// disconnects are logged; the process-start mass-offline sweep is intentionally
// excluded so a daemon restart doesn't spam a disconnect storm into the bell.
async function logConnectionActivity(connection, eventType) {
  try {
    if (!connection || typeof connection !== 'object') return;
    const workspaceId = connection.workspace_id;
    if (!workspaceId) return;
    const handle = connection.handle || '';
    const name = connection.name || handle || 'Agent';
    const verb = eventType === 'agent_connected' ? 'connected' : 'disconnected';
    const title = `@${handle || name} ${verb}`.slice(0, 120);
    const metadata = {
      handle,
      name,
      agent_id: connection.agent_id || '',
      status: connection.status || (eventType === 'agent_connected' ? 'online' : 'offline'),
    };
    const inserted = await getDb().unsafe(
      `insert into activity_events (workspace_id, user_id, event_type, entity_type, entity_id, title, metadata, created_at)
       values ($1, null, $2, 'agent', $3, $4, $5::jsonb, now())
       returning *`,
      [workspaceId, eventType, connection.agent_id != null ? String(connection.agent_id) : null, title, JSON.stringify(metadata)],
    );
    if (inserted.length > 0) {
      notifyDbSubscribers('activity_events', 'INSERT', inserted);
    }
  } catch (error) {
    console.error('logConnectionActivity failed', error);
  }
}

// H4 (2026-07 review): realtime subscriptions are authorized only at subscribe
// time, so a member removed (or role-changed) mid-session keeps receiving a
// workspace's live messages/canvas/tasks on their open socket until it drops.
// When workspace_members changes, re-authorize every affected user's live
// subscriptions against their CURRENT role and drop the ones that no longer
// pass — reusing the same authoritative check as the subscribe path.
async function revokeRealtimeAccessForMember(userId) {
  for (const ws of websocketClients) {
    if (String(ws.userId || '') !== String(userId)) continue;
    const subscriptions = ws.subscriptions || [];
    if (subscriptions.length === 0) continue;
    const kept = [];
    for (const subscription of subscriptions) {
      try {
        await authorizeRealtimeBinding(ws.userId, subscription.channel, subscription);
        kept.push(subscription);
      } catch {
        try {
          sendWs(ws, { type: 'system', event: 'unsubscribed', channel: subscription.channel, reason: 'access_revoked' });
        } catch { /* socket already closing */ }
      }
    }
    if (kept.length !== subscriptions.length) ws.subscriptions = kept;
  }
}

function notifyDbSubscribers(table, eventType, rows) {
  const rowList = Array.isArray(rows) ? rows : [];
  if (rowList.length === 0) return;

  // Single chokepoint: every message INSERT spawns a companion activity event.
  // Guard on table === 'messages' so the activity insert above cannot recurse.
  if (table === 'messages' && eventType === 'INSERT') {
    void logMessageActivity(rowList);
  }

  if (table === 'workspace_agents') {
    refreshConnectedAgentConfigs(eventType, rowList);
  }

  // Prune the affected user's now-unauthorized subscriptions before fanning the
  // change out to everyone else (removed members must stop receiving data).
  if (table === 'workspace_members' && (eventType === 'DELETE' || eventType === 'UPDATE')) {
    for (const row of rowList) {
      if (row && row.user_id) void revokeRealtimeAccessForMember(row.user_id);
    }
  }

  for (const ws of websocketClients) {
    const subscriptions = ws.subscriptions || [];
    for (const subscription of subscriptions) {
      if (subscription.type !== 'db_changes') continue;
      if (subscription.table && subscription.table !== table) continue;
      if (subscription.schema && subscription.schema !== 'public') continue;
      if (subscription.event && subscription.event !== '*' && subscription.event !== eventType) continue;

      for (const row of rowList) {
        if (!matchesFilter(subscription.filter, row)) continue;
        sendWs(ws, {
          type: 'db_changes',
          schema: 'public',
          table,
          payload: eventType === 'DELETE'
            ? { eventType, new: {}, old: row }
            : { eventType, new: row, old: {} },
        });
      }
    }
  }
}

// Default agents seeded into every brand-new workspace. Kept in sync with the
// netlify backend (netlify/functions/backend.mjs).
const DEFAULT_AGENT_SEEDS = [
  {
    name: 'Scout',
    handle: 'scout',
    run_mode: 'builtin',
    avatar: 'SC',
    accent_color: '#38bdf8',
    description: 'Codebase navigator.',
    system_prompt:
      "You are Scout, the codebase navigator for this workspace. When asked where something lives or how a piece of code works, you locate the relevant files, trace the logic, and explain it with concrete file references. Collaborate with your teammates by @mentioning them when their expertise fits — @research for web lookups, @coder to make edits, @q for tooling, @mills for skills. Stay quiet when you have nothing useful to add.",
  },
  {
    name: 'Research',
    handle: 'research',
    run_mode: 'builtin',
    avatar: 'RE',
    accent_color: '#a78bfa',
    description: 'Web and information researcher.',
    system_prompt:
      "You are Research, the workspace's web and information specialist. You look things up, summarize what you find clearly, and always cite your sources so claims can be verified. Hand off to teammates by @mentioning them when relevant — @scout for this project's own code, @coder for implementation, @q for tools, @mills for skills. Stay quiet when you have nothing useful to add.",
  },
  {
    name: 'Coder',
    handle: 'coder',
    run_mode: 'daemon',
    avatar: 'CO',
    accent_color: '#00a95c',
    description: 'Coding agent (local daemon).',
    system_prompt:
      "You are Coder, the workspace's coding agent. You write and edit real code, running as a local daemon with actual execution, and you keep changes focused and verifiable. Work with your teammates by @mentioning them when relevant — @scout to find where code lives, @research to look things up, @q for the right tools, @mills for the right skills. Stay quiet when you have nothing useful to add.",
  },
  {
    name: 'Q',
    handle: 'q',
    run_mode: 'daemon',
    avatar: 'Q',
    accent_color: '#f59e0b',
    description: 'Tooling agent.',
    system_prompt:
      "You are Q, the workspace's tooling agent. You watch the conversation and recommend the right tools and CLIs for the task at hand, explaining briefly why each fits. Loop in teammates by @mentioning them when relevant — @coder to apply changes, @scout to locate code, @research for background, @mills for matching skills. Speak up only when a tool genuinely helps; stay quiet when you have nothing useful to add.",
  },
  {
    name: 'Mills',
    handle: 'mills',
    run_mode: 'daemon',
    avatar: 'MI',
    accent_color: '#f472b6',
    description: 'Skills agent.',
    system_prompt:
      "You are Mills, the workspace's skills agent. You watch the conversation and recommend the right skills and workflows for the task at hand, explaining how each applies. Bring in teammates by @mentioning them when relevant — @q for tools and CLIs, @coder to implement, @scout to navigate code, @research to investigate. Speak up only when a skill genuinely helps; stay quiet when you have nothing useful to add.",
  },
];

// Insert the default agents for a freshly created workspace. Idempotent: skips
// entirely when the workspace already has any agents, so existing workspaces and
// repeated calls never produce duplicates.
async function seedDefaultAgents(workspaceId, ownerUserId) {
  if (!workspaceId) return;
  const db = getDb();
  const existing = await db.unsafe(
    'select count(*)::int as count from workspace_agents where workspace_id = $1',
    [workspaceId],
  );
  if ((existing[0]?.count ?? 0) > 0) return;

  const columns = [
    'id', 'workspace_id', 'created_by', 'name', 'avatar', 'openpet_avatar_id',
    'accent_color', 'description', 'system_prompt', 'soul', 'instructions', 'tools', 'skills',
    'handle', 'model', 'run_mode', 'permission_mode',
  ];
  const params = [];
  const valueSql = DEFAULT_AGENT_SEEDS.map((seed) => {
    const row = {
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      created_by: ownerUserId ?? null,
      name: seed.name,
      avatar: seed.avatar,
      openpet_avatar_id: '',
      accent_color: seed.accent_color,
      description: seed.description ?? '',
      system_prompt: seed.system_prompt,
      soul: '',
      instructions: '',
      tools: [],
      skills: [],
      handle: seed.handle,
      model: 'auto',
      run_mode: seed.run_mode,
      permission_mode: 'default',
    };
    return `(${columns.map((column) => bindDbParam(params, 'workspace_agents', column, row[column])).join(', ')})`;
  }).join(', ');

  const inserted = await db.unsafe(
    `insert into workspace_agents (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning *`,
    params,
  );
  notifyDbSubscribers('workspace_agents', 'INSERT', inserted);
}

function relayBroadcast(channel, event, payload) {
  for (const ws of websocketClients) {
    const subscriptions = ws.subscriptions || [];
    const matches = subscriptions.some((subscription) => (
      subscription.type === 'broadcast' && subscription.channel === channel && subscription.event === event
    ));
    if (matches) {
      sendWs(ws, { type: 'broadcast', channel, event, payload });
    }
  }
}

// Fan a message out to EVERY authenticated socket, ignoring channel subscriptions.
// Used for workspace-agnostic system events (e.g. a new frontend deploy going live)
// that every connected client should hear regardless of what they're subscribed to.
function broadcastGlobal(message) {
  let delivered = 0;
  for (const ws of websocketClients) {
    sendWs(ws, message);
    delivered += 1;
  }
  return delivered;
}

function tokenFromWsRequest(req) {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    return url.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function workspaceIdFromRealtimeChannel(channel) {
  if (typeof channel !== 'string') return null;
  const [prefix, workspaceId, ...rest] = channel.split(':');
  if (rest.length > 0 || !workspaceId) return null;
  if (!['canvas', 'cursors', 'item-presence', 'agent-presence'].includes(prefix)) return null;
  return workspaceId;
}

async function authorizeRealtimeBinding(userId, channel, binding) {
  if (!binding || typeof binding !== 'object') throw forbidden('Invalid realtime subscription');

  if (binding.type === 'broadcast') {
    const workspaceId = workspaceIdFromRealtimeChannel(channel);
    if (!workspaceId) throw forbidden('Broadcast channel is not allowed');
    await enforceWorkspaceRole(userId, workspaceId, 'read');
    return;
  }

  if (binding.type === 'db_changes') {
    ensureTable(binding.table);
    const parsed = parseFilter(binding.filter);
    if (binding.table === 'workspaces') {
      if (!parsed) throw forbidden('Workspace realtime subscriptions require a row filter');
      if (parsed.column === 'id') {
        await enforceWorkspaceRole(userId, parsed.value, 'read');
        return;
      }
      if (parsed.column === 'user_id' && String(parsed.value) === String(userId)) return;
      throw forbidden('Workspace realtime filter is not allowed');
    }
    const filters = parsed ? [{ column: parsed.column, operator: 'eq', value: parsed.value }] : [];
    await enforceDbOperationAccess(userId, binding.table, 'select', { filters });
    return;
  }

  throw forbidden('Realtime subscription type is not allowed');
}

async function authorizeRealtimeBroadcast(userId, channel) {
  const workspaceId = workspaceIdFromRealtimeChannel(channel);
  if (!workspaceId) throw forbidden('Broadcast channel is not allowed');
  await enforceWorkspaceRole(userId, workspaceId, 'read');
}

function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/backend/ws' });

  wss.on('connection', (ws, req) => {
    ws.subscriptions = [];
    // Liveness: the heartbeat interval below pings each socket and terminates any
    // that miss a pong, so an ungraceful drop still fires 'close' (→ offline).
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // H3/H5 — two auth paths, both supported for a smooth deploy + the daemon CLI:
    //  (1) Query-param credentials, verified on connect: `agentToken=` (daemon CLI,
    //      agent/agensis-cli) and `token=` (legacy browser compat window).
    //  (2) First-message auth frame `{ type: 'auth', token }` (the browser client
    //      now sends this so the token never appears in the WS URL / proxy logs).
    // authReady resolves true on success, false on failure/timeout; the message
    // handler gates every action on it.
    let authSettled = false;
    let resolveAuth;
    const authReady = new Promise((resolve) => { resolveAuth = resolve; });
    function settleAuth(value) {
      if (authSettled) return;
      authSettled = true;
      resolveAuth(value);
    }
    function finalizeAuthenticated(userId, agentAuth) {
      ws.userId = userId;
      ws.agentAuth = agentAuth;
      websocketClients.add(ws);
      settleAuth(true);
    }

    // Path (1): try query-param credentials up front. If absent/invalid we do NOT
    // close — we wait for an auth frame (path 2) or the timeout below.
    (async () => {
      const userId = await verifyToken(tokenFromWsRequest(req));
      const agentAuth = userId ? null : await verifyAgentConnectToken(agentTokenFromWsRequest(req), req);
      if (userId || agentAuth) finalizeAuthenticated(userId, agentAuth);
    })().catch(() => { /* fall through to the auth-frame path / timeout */ });

    // Reject if neither path authenticates within the grace window.
    const authTimer = setTimeout(() => {
      if (!authSettled) {
        settleAuth(false);
        try { ws.close(1008, 'Authentication required'); } catch { /* already closing */ }
      }
    }, 10_000);
    if (authTimer.unref) authTimer.unref();

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw || '{}'));
      } catch {
        return;
      }

      // Path (2): the first valid `auth` frame authenticates the socket. Only
      // honored while auth is still unsettled (it must be the FIRST message).
      if (!authSettled && message && message.type === 'auth') {
        try {
          const userId = await verifyToken(message.token);
          const agentAuth = userId ? null : await verifyAgentConnectToken(message.token, req);
          if (!userId && !agentAuth) {
            settleAuth(false);
            ws.close(1008, 'Authentication failed');
            return;
          }
          finalizeAuthenticated(userId, agentAuth);
          sendWs(ws, { type: 'system', event: 'authenticated' });
        } catch {
          settleAuth(false);
          try { ws.close(1008, 'Authentication failed'); } catch { /* already closing */ }
        }
        return;
      }

      try {
        const authenticated = await authReady;
        if (!authenticated) return;
        if (message.action === 'subscribe') {
          const binding = { channel: message.channel, ...(message.binding || {}) };
          await authorizeRealtimeBinding(ws.userId, message.channel, binding);
          const exists = (ws.subscriptions || []).some((subscription) => JSON.stringify(subscription) === JSON.stringify(binding));
          if (!exists) {
            ws.subscriptions.push(binding);
          }
          sendWs(ws, { type: 'system', event: 'subscribed', channel: message.channel });
          return;
        }
        if (message.action === 'unsubscribe') {
          ws.subscriptions = (ws.subscriptions || []).filter((subscription) => subscription.channel !== message.channel);
          return;
        }
        if (message.action === 'broadcast') {
          await authorizeRealtimeBroadcast(ws.userId, message.channel);
          relayBroadcast(message.channel, message.event, message.payload);
          return;
        }
        if (message.action === 'agent_register') {
          await registerAgentConnection(ws, message);
          return;
        }
        if (message.action === 'agent_heartbeat') {
          await updateAgentHeartbeat(ws, message.metadata || {}, {
            capabilitiesHash: message.capabilitiesHash,
            memoryHash: message.memoryHash,
          });
          return;
        }
        if (message.action === 'agent_job_result') {
          await handleAgentJobResult(ws, message);
          return;
        }
        if (message.action === 'agent_job_delta') {
          await handleAgentJobDelta(ws, message);
          return;
        }
        if (message.action === 'agent_memory_sync') {
          await handleAgentMemorySync(ws, message);
          return;
        }
        if (message.action === 'agent_capabilities_sync') {
          await handleAgentCapabilitiesSync(ws, message);
          return;
        }
        if (message.action === 'peer_ticket_request') {
          await handlePeerTicketRequest(ws, message);
          return;
        }
        if (message.action === 'peer_list_request') {
          await handlePeerListRequest(ws);
          return;
        }
      } catch (error) {
        sendWs(ws, { type: 'error', message: error?.message || 'Realtime request rejected' });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      settleAuth(false);
      websocketClients.delete(ws);
      void markAgentConnectionOffline(ws);
    });
  });

  // Ping connected sockets on every LIVENESS_PING_INTERVAL_MS; terminate any that
  // didn't answer the previous ping. terminate() fires 'close', which marks the
  // agent connection offline — this catches daemons that vanish without a clean
  // disconnect (sleep, network loss, kill -9) and would otherwise show as "online"
  // forever. The interval also drives isConnectionSocketLive's isAlive flag.
  const livenessInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try { client.ping(); } catch { /* socket already closing */ }
    }
  }, LIVENESS_PING_INTERVAL_MS);
  livenessInterval.unref?.();
  wss.on('close', () => clearInterval(livenessInterval));

  return wss;
}

function createApp() {
  const app = express();
  app.use(cors());
  // Capture the raw request bytes alongside the parsed JSON. Netlify signs its
  // outgoing deploy webhooks with a JWS whose payload carries the SHA-256 of the
  // exact request body, so verifying that signature (see verifyNetlifyDeploySignature)
  // requires the untouched bytes — express.json otherwise discards them. Storing a
  // reference to the already-allocated buffer costs nothing.
  app.use(express.json({
    limit: '50mb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));
  // Runtime schema fallback (ensureRuntimeSchema) runs by default so dev bootstrap
  // keeps working with zero config. Set AGENSIS_RUNTIME_SCHEMA=false in production
  // and run `npm run migrate` instead, once the supabase/migrations/*.sql files are
  // the source of truth. Unset/any-other-value preserves today's behavior.
  const ALLOW_RUNTIME_SCHEMA = process.env.AGENSIS_RUNTIME_SCHEMA !== 'false';
  const runtimeSchemaReady = ALLOW_RUNTIME_SCHEMA
    ? ensureRuntimeSchema().catch((error) => {
        console.warn('[backend] runtime schema migration failed:', error.message || error);
        throw error;
      })
    : Promise.resolve();

  // Auth is enforced at the route boundary and again per workspace-scoped
  // operation. Keep this server-side; client filters are only UX hints.

  app.get('/backend/health', async (_req, res) => {
    try {
      await getDb().unsafe('select 1');
      res.json({ ok: true });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.use('/backend', async (_req, res, next) => {
    try {
      await runtimeSchemaReady;
      next();
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.get('/backend/openpets/catalog', requireAuth, async (_req, res) => {
    try {
      let payload = { version: 3, page: 0, pageSize: 0, pets: [] };
      let remoteError = null;
      try {
        const response = await fetch(OPENPETS_CATALOG_URL, {
          headers: { 'User-Agent': 'agensis/1.0 (+https://openpets.dev)' },
        });
        if (!response.ok) {
          remoteError = new Error(`OpenPets catalog returned ${response.status}`);
        } else {
          payload = await response.json();
        }
      } catch (error) {
        remoteError = error;
      }

      const merged = mergeLocalCodexPets(payload);
      if (remoteError && merged.pets.length === 0) return jsonError(res, 502, remoteError);
      res.setHeader('Cache-Control', 'public, max-age=120');
      res.json({ data: merged, error: null });
    } catch (error) {
      jsonError(res, 502, error);
    }
  });

  app.get('/backend/codex-pets/:petDir/:asset', async (req, res) => {
    try {
      const petDir = path.resolve(CODEX_PETS_ROOT, String(req.params.petDir || ''));
      const assetName = path.basename(String(req.params.asset || ''));
      const assetPath = path.resolve(petDir, assetName);
      if (!assetName || !/\.(webp|png|gif|jpe?g)$/i.test(assetName)) return jsonError(res, 404, new Error('Pet asset not found'));
      if (!isPathInside(CODEX_PETS_ROOT, petDir) || !isPathInside(petDir, assetPath)) return jsonError(res, 404, new Error('Pet asset not found'));
      if (!fs.existsSync(path.join(petDir, 'pet.json')) || !fs.existsSync(assetPath)) return jsonError(res, 404, new Error('Pet asset not found'));
      res.setHeader('Content-Type', contentTypeForImageAsset(assetPath));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(assetPath).pipe(res);
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.get('/backend/system/capabilities', requireAuth, async (req, res) => {
    try {
      const workspacePath = typeof req.query.workspacePath === 'string' ? req.query.workspacePath : '';
      res.json({ data: await detectCapabilities(workspacePath), error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // Slash commands/skills the connected daemons actually expose on their machines.
  // The composer's `/` menu can't see the user's filesystem (only fly's), so it
  // sources the real commands from what each daemon pushed on its capability sync.
  app.get('/backend/system/slash-commands', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.query.workspaceId || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'read');
      const rows = await getDb().unsafe(
        `select capabilities
         from agent_connections
         where workspace_id = $1
           and last_seen_at > now() - interval '24 hours'`,
        [workspaceId],
      );
      const items = mergeSlashCommands(rows.map(row => parseJsonObject(row.capabilities)));
      res.json({ data: items, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/system/inspect-path', requireAuth, async (req, res) => {
    try {
      const inspected = await inspectProjectPath(req.body?.path || '');
      res.json({ data: inspected, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/files/upload', requireAuth, async (req, res) => {
    try {
      const { workspace_id: workspaceId, name, contentBase64 } = req.body || {};
      if (!workspaceId || !name || typeof contentBase64 !== 'string') {
        return jsonError(res, 400, new Error('workspace_id, name, and contentBase64 are required'));
      }
      await enforceWorkspaceRole(req.userId, workspaceId, 'write');
      // The client's `type` (req.body.type) is deliberately ignored — it is
      // browser-reported and trivially spoofed. The stored Content-Type is
      // always derived server-side from the file extension via the allowlist
      // above (see plan 002 for the full rationale).
      const extension = getUploadExtension(name);
      const normalizedType = lookupUploadContentType(extension);
      if (!extension || normalizedType === undefined) {
        return jsonError(res, 400, new Error(`Unsupported file type: .${extension || 'unknown'}`));
      }
      const id = crypto.randomUUID();
      const buffer = Buffer.from(contentBase64, 'base64');
      const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB; matches the client FileUpload cap
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return jsonError(res, 413, new Error('File exceeds the 25MB upload limit'));
      }
      const storagePath = storagePathFor(workspaceId, id, name);
      const fullPath = resolveStoragePath(storagePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, buffer);
      const sha = crypto.createHash('sha256').update(buffer).digest('hex');
      const rows = await getDb().unsafe(
        `insert into uploaded_files (id, workspace_id, name, size, type, storage_path, content_sha256)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [id, workspaceId, String(name), buffer.length, normalizedType, storagePath, sha],
      );
      notifyDbSubscribers('uploaded_files', 'INSERT', rows);
      res.json({ data: rows[0], error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.get('/backend/files/:id/content', requireAuth, async (req, res) => {
    try {
      const rows = await getDb().unsafe('select workspace_id, name, type, storage_path from uploaded_files where id = $1 limit 1', [req.params.id]);
      const file = rows[0];
      if (!file?.storage_path) return jsonError(res, 404, new Error('File content is not stored'));
      await enforceWorkspaceRole(req.userId, file.workspace_id, 'read');
      const fullPath = resolveStoragePath(file.storage_path);
      if (!fs.existsSync(fullPath)) return jsonError(res, 404, new Error('File content is missing on disk'));
      // Never let the browser sniff/execute uploaded content as something
      // other than the Content-Type we explicitly set below.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Force a download (never `inline`) for anything that can carry script
      // when rendered by a browser. Checked two ways:
      //  - by the ORIGINAL FILENAME's extension, because the upload handler
      //    already neutralizes .html/.svg's stored type to `text/plain`,
      //    which would make a stored-type-only check below a no-op for the
      //    normal upload path;
      //  - by the STORED type value, as a belt-and-suspenders guard against
      //    any other write path (e.g. a generic `/backend/db/uploaded_files`
      //    update — `uploaded_files` is in ALLOWED_TABLES) that could set
      //    `type` to a dangerous value without going through the upload
      //    handler above.
      const mustForceAttachment = FORCE_ATTACHMENT_EXTENSIONS.has(getUploadExtension(file.name))
        || FORCE_ATTACHMENT_CONTENT_TYPES.has(file.type);
      const disposition = mustForceAttachment ? 'attachment' : 'inline';
      // IMPORTANT: the app's own viewer (ChatWindowContent's openUploadedFile)
      // fetches this endpoint and calls response.blob(), then
      // URL.createObjectURL()/window.open() on the blob. The Fetch/Blob APIs
      // take the blob's type from the Content-Type header and completely
      // IGNORE Content-Disposition — so forcing `attachment` alone does not
      // stop that in-app viewer from rendering a stored `text/html`/
      // `image/svg+xml` type as script in the app's own origin. When forcing
      // attachment, the served Content-Type must ALSO be overridden to a
      // safe, non-renderable value, regardless of what's stored.
      const servedType = mustForceAttachment ? 'application/octet-stream' : (file.type || 'application/octet-stream');
      res.setHeader('Content-Type', servedType);
      res.setHeader('Content-Disposition', `${disposition}; filename="${safeFileName(file.name)}"`);
      fs.createReadStream(fullPath).pipe(res);
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.get('/backend/workspaces/:id/project-files', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'read');
      const rows = await getDb().unsafe(
        'select id, local_path, git_root from workspaces where id = $1 limit 1',
        [workspaceId],
      );
      const workspace = rows[0];
      if (!workspace) return jsonError(res, 404, new Error('Workspace not found'));
      const requestedAgents = Array.isArray(req.query.agent)
        ? req.query.agent
        : req.query.agent
          ? [req.query.agent]
          : [];
      const sources = await workspaceProjectFileSources(workspaceId, workspace, { agents: requestedAgents });
      if (sources.length === 0) return res.json({ data: { root: '', files: [], sources: [] }, error: null });
      const fileSources = sources.map(source => {
        const files = listProjectFiles(source.root, source.kind === 'agent' ? 160 : 300).map(file => ({
          ...file,
          sourceId: source.id,
          sourceKind: source.kind,
          sourceLabel: source.label,
          sourceRoot: source.root,
          agentId: source.agent_id || null,
          connectionId: source.connection_id || null,
          handle: source.handle || '',
          status: source.status || '',
        }));
        return { ...source, files };
      });
      res.json({
        data: {
          root: fileSources.find(source => source.kind === 'workspace')?.root || '',
          files: fileSources.flatMap(source => source.files),
          sources: fileSources,
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // Resolve a workspace's git root and validate that `relativePath` (a path the
  // client supplied) stays inside it — without this, a diff/status endpoint that
  // takes an arbitrary path query param would let any authenticated workspace
  // member read files anywhere on the host's filesystem via `../../` traversal.
  async function fetchWorkspaceRow(workspaceId) {
    const rows = await getDb().unsafe(
      'select id, local_path, git_root from workspaces where id = $1 limit 1',
      [workspaceId],
    );
    return rows[0] || null;
  }

  function gitRootOf(workspace) {
    if (!workspace) return null;
    const root = String(workspace.git_root || workspace.local_path || '').trim();
    if (!root) return null;
    const resolved = path.resolve(root);
    // F3: never touch a root outside the host's opt-in allowlist (see
    // isWithinAllowedProjectRoot above workspaceProjectRoot).
    if (!isWithinAllowedProjectRoot(resolved)) return null;
    return resolved;
  }

  function resolveWithinRoot(root, relativePath) {
    const resolved = path.resolve(root, String(relativePath || ''));
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
    // Lexical containment isn't enough — a symlink inside root can point outside it.
    // Only realpath-check if the target exists; callers that need "path must exist"
    // semantics (e.g. resolveStagePaths, which stages an existing file) already get
    // that for free, and callers reading a possibly-new path should catch the ENOENT
    // case themselves the way the diff route's untracked-file branch already does.
    let realTarget;
    try {
      realTarget = fs.realpathSync(resolved);
    } catch {
      return resolved; // Path doesn't exist yet — lexical check already passed; let the
                        // caller's own existence check (if any) handle the not-found case.
    }
    const realRoot = fs.realpathSync(root);
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
    if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) return null;
    return resolved;
  }

  // Lightweight parser for `git status --porcelain=v1 -z`: two status chars per
  // entry (index, worktree) followed by the path, NUL-separated (handles paths
  // with spaces/newlines safely, unlike the newline-delimited non -z format).
  function parsePorcelainStatus(raw) {
    return raw
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const indexState = entry[0];
        const worktreeState = entry[1];
        const filePath = entry.slice(3);
        let status = 'modified';
        if (indexState === '?' && worktreeState === '?') status = 'untracked';
        else if (indexState === 'A') status = 'added';
        else if (indexState === 'D' || worktreeState === 'D') status = 'deleted';
        else if (indexState === 'R') status = 'renamed';
        return { path: filePath, status, staged: indexState !== ' ' && indexState !== '?' };
      });
  }

  app.get('/backend/workspaces/:id/git/status', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'read');
      const workspaceRow = await fetchWorkspaceRow(workspaceId);
      const root = gitRootOf(workspaceRow);
      if (!root || !fs.existsSync(root)) return res.json({ data: { root: '', files: [], branch: '' }, error: null });
      let branch = '';
      try {
        const { stdout } = await execFileAsync('git', ['-C', root, 'branch', '--show-current'], { timeout: 5000 });
        branch = stdout.trim();
      } catch {
        return res.json({ data: { root, files: [], branch: '' }, error: null });
      }
      const { stdout } = await execFileAsync(
        'git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      const files = parsePorcelainStatus(stdout);

      // Attribute each changed file to the agent connection whose cwd contains it
      // (best-effort — same source data the Files panel already uses), so the UI
      // can show "changed by Atlas" rather than just a bare path.
      let sources = [];
      try {
        sources = await workspaceProjectFileSources(workspaceId, workspaceRow, {});
      } catch {
        // attribution is best-effort; status itself still returns
      }
      const attributed = files.map((file) => {
        const abs = path.resolve(root, file.path);
        const owner = sources.find((source) => source.kind === 'agent' && abs.startsWith(`${path.resolve(source.root)}${path.sep}`));
        return { ...file, agentId: owner?.agent_id || null, agentLabel: owner?.label || null };
      });

      res.json({ data: { root, branch, files: attributed }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.get('/backend/workspaces/:id/git/diff', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      const relativePath = String(req.query.path || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
      if (!relativePath) return jsonError(res, 400, new Error('path is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'read');
      const root = gitRootOf(await fetchWorkspaceRow(workspaceId));
      if (!root) return jsonError(res, 404, new Error('Workspace has no project path configured'));
      const target = resolveWithinRoot(root, relativePath);
      if (!target) return jsonError(res, 400, new Error('path must stay within the workspace project root'));

      // Untracked files have no HEAD to diff against — `git diff` is silent for
      // them, so surface the working-tree content directly (capped) instead.
      let isUntracked = false;
      try {
        const { stdout } = await execFileAsync(
          'git', ['-C', root, 'status', '--porcelain=v1', '-z', '--', relativePath],
          { timeout: 5000 },
        );
        isUntracked = stdout.startsWith('??');
      } catch {
        // fall through to diff attempt below
      }

      if (isUntracked) {
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          return jsonError(res, 404, new Error('File not found'));
        }
        // This branch reads raw file content (unlike the git-diff branch below,
        // which stays inside git's own repository boundary via `git diff`), so a
        // symlink inside the workspace root pointing outside it would otherwise
        // let an attacker read arbitrary files on the host. `resolveWithinRoot`
        // above already realpath-validates `target` against `root`, so it's safe
        // to read directly here.
        const content = fs.readFileSync(target, 'utf8').slice(0, 200_000);
        return res.json({ data: { path: relativePath, untracked: true, diff: '', content }, error: null });
      }

      const { stdout } = await execFileAsync(
        'git', ['-C', root, 'diff', 'HEAD', '--', relativePath],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      res.json({ data: { path: relativePath, untracked: false, diff: stdout, content: '' }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // Resolves a workspace's git root for a write (stage/unstage/commit) request:
  // checks 'write' capability (stricter than the read-only status/diff routes
  // above) and 404s if the workspace has no project path configured.
  async function requireWritableGitRoot(req, workspaceId) {
    await enforceWorkspaceRole(req.userId, workspaceId, 'write');
    const root = gitRootOf(await fetchWorkspaceRow(workspaceId));
    if (!root || !fs.existsSync(root)) {
      const error = new Error('Workspace has no project path configured');
      error.status = 404;
      throw error;
    }
    return root;
  }

  // Normalizes a stage/unstage request body into a validated list of paths
  // resolved within the workspace root — reuses the same traversal guard the
  // read-only diff endpoint relies on.
  function resolveStagePaths(root, body) {
    const raw = Array.isArray(body?.paths) ? body.paths : (body?.path !== undefined ? [body.path] : []);
    const relativePaths = raw.map((value) => String(value || '').trim()).filter(Boolean);
    if (relativePaths.length === 0) throw badRequest('path or paths is required');
    for (const relativePath of relativePaths) {
      if (!resolveWithinRoot(root, relativePath)) throw badRequest('path must stay within the workspace project root');
    }
    return relativePaths;
  }

  app.post('/backend/workspaces/:id/git/stage', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
      const root = await requireWritableGitRoot(req, workspaceId);
      const relativePaths = resolveStagePaths(root, req.body);
      await execFileAsync('git', ['-C', root, 'add', '--', ...relativePaths], { timeout: 8000 });
      res.json({ data: { staged: relativePaths }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/workspaces/:id/git/unstage', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
      const root = await requireWritableGitRoot(req, workspaceId);
      const relativePaths = resolveStagePaths(root, req.body);
      await execFileAsync('git', ['-C', root, 'reset', 'HEAD', '--', ...relativePaths], { timeout: 8000 });
      res.json({ data: { unstaged: relativePaths }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/workspaces/:id/git/commit', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      const message = String(req.body?.message || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
      if (!message) return jsonError(res, 400, new Error('A commit message is required'));
      const root = await requireWritableGitRoot(req, workspaceId);

      const { stdout: stagedOut } = await execFileAsync('git', ['-C', root, 'diff', '--cached', '--name-only'], { timeout: 5000 });
      if (!stagedOut.trim()) return jsonError(res, 400, new Error('No staged changes to commit'));

      const userRows = await getDb().unsafe('select email, display_name from app_users where id = $1 limit 1', [req.userId]);
      const committer = userRows[0] || {};
      const authorName = String(committer.display_name || '').trim() || String(committer.email || '').split('@')[0] || 'Agensis user';
      const authorEmail = String(committer.email || 'agensis@local').trim();

      const { stdout } = await execFileAsync(
        'git',
        ['-C', root, '-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '-m', message],
        { timeout: 10000 },
      );
      const { stdout: shaOut } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 5000 });
      res.json({ data: { sha: shaOut.trim(), summary: stdout.trim() }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // Netlify deploy-notification receiver. Point a Netlify "Deploy succeeded"
  // outgoing webhook at this URL; when a new frontend publishes to the CDN, Netlify
  // POSTs the deploy object here and we fan a `deploy_published` system event to every
  // connected client so the app can offer a "new version — reload" nudge. Public by
  // design (Netlify has no bearer token); authenticity comes from the JWS signature.
  //
  // Fast-ack: everything here is synchronous in-memory (HMAC + one socket loop, no DB,
  // no outbound calls), so we always respond quickly. Netlify silently disables hooks
  // whose receiver is slow or errors on ITS legitimate requests — a correctly-signed
  // request always reaches the 200 below; only forgeries get a 401, which cannot
  // disable the real hook.
  app.post('/backend/netlify-deploy-hook', (req, res) => {
    try {
      const secret = process.env.NETLIFY_WEBHOOK_JWS_SECRET || '';
      const signature = req.get('X-Webhook-Signature') || req.get('x-webhook-signature') || '';
      if (secret) {
        if (!verifyNetlifyDeploySignature(signature, req.rawBody, secret)) {
          return res.status(401).json({ data: null, error: 'Invalid signature' });
        }
      } else {
        // No secret configured → we cannot prove the sender. Accept (so the feature
        // works before the secret is wired) but log it so it isn't a silent gap.
        console.warn('[netlify-hook] NETLIFY_WEBHOOK_JWS_SECRET not set — accepting unsigned deploy webhook');
      }

      const deploy = req.body || {};
      // Netlify's "Deploy succeeded" event is the published-and-live signal; its body
      // reports state 'ready'. If some other event is wired here, only broadcast on a
      // ready/published state so we never nag on a build-started or failed hook.
      const state = typeof deploy.state === 'string' ? deploy.state.toLowerCase() : '';
      const isPublished = state === '' || state === 'ready' || state === 'current';
      if (!isPublished) {
        return res.status(200).json({ data: { ignored: true, state }, error: null });
      }

      const payload = {
        commit: deploy.commit_ref || deploy.commit_url || null,
        branch: deploy.branch || null,
        site: deploy.name || null,
        url: deploy.deploy_ssl_url || deploy.ssl_url || deploy.url || null,
        at: deploy.published_at || deploy.updated_at || null,
      };
      const delivered = broadcastGlobal({ type: 'system', event: 'deploy_published', payload });
      console.log(`[netlify-hook] deploy_published broadcast to ${delivered} client(s)`, payload.commit || '');
      return res.status(200).json({ data: { broadcast: delivered }, error: null });
    } catch (error) {
      // Never 500 on Netlify's own request — that risks the hook being auto-disabled.
      console.error('[netlify-hook] handler error', error);
      return res.status(200).json({ data: { error: 'handled' }, error: null });
    }
  });

  app.post('/backend/agent-webhooks', requireAuth, async (req, res) => {
    try {
      const { workspace_id: workspaceId, agent_id: agentId, name } = req.body || {};
      if (!workspaceId || !name) return jsonError(res, 400, new Error('workspace_id and name are required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      if (agentId) {
        const agentRows = await getDb().unsafe(
          'select id from workspace_agents where id = $1 and workspace_id = $2 limit 1',
          [agentId, workspaceId],
        );
        if (!agentRows[0]) return jsonError(res, 404, new Error('Agent not found in this workspace'));
      }
      // F10: store only the hash — the trigger route below does a dual-path lookup
      // (inviteTokenLookupParams) so legacy plaintext rows keep working during the
      // transition. The plaintext is returned ONCE here, on creation.
      const token = crypto.randomBytes(32).toString('base64url');
      const rows = await getDb().unsafe(
        `insert into agent_webhooks (workspace_id, agent_id, name, token)
         values ($1, $2, $3, $4)
         returning *`,
        [workspaceId, agentId || null, String(name).trim(), hashAgentToken(token)],
      );
      notifyDbSubscribers('agent_webhooks', 'INSERT', rows);
      res.json({ data: { ...rows[0], token }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.get('/backend/workspaces', requireAuth, async (req, res) => {
    try {
      const rows = await getDb().unsafe(
        `select w.id, w.name, w.description, w.local_path, w.project_kind, w.git_root, w.git_remote,
                w.created_at, w.updated_at,
                case when w.user_id = $1 then 'owner' else coalesce(wm.role, 'viewer') end as role
         from workspaces w
         left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = $1
         where w.user_id = $1 or wm.user_id = $1
         order by w.updated_at desc nulls last, w.created_at desc nulls last, w.name asc`,
        [req.userId],
      );
      res.json({ data: rows.map(publicWorkspace), error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.get('/backend/workspaces/:id/agents', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'read');
      const rows = await getDb().unsafe(
        `select id, workspace_id, name, avatar, openpet_avatar_id, accent_color, description, system_prompt, soul, instructions, tools, skills, model, handle, run_mode, memory_dir, permission_mode, version, enabled
         from workspace_agents
         where workspace_id = $1
         order by created_at asc, name asc`,
        [workspaceId],
      );
      res.json({ data: rows.map(agentRuntimePayload), error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/agensis/setup/connect', requireAuth, async (req, res) => {
    try {
      const workspaceId = await resolveSetupWorkspace(req.userId, req.body?.workspaceId || req.body?.workspace_id);
      const host = String(req.body?.host || '').trim().slice(0, 160);
      const cwd = String(req.body?.cwd || '').trim().slice(0, 500);
      const agent = await ensurePrimaryDaemonAgent({
        workspaceId,
        userId: req.userId,
        handle: req.body?.handle,
        name: req.body?.name || host || 'Agensis daemon',
        host,
        cwd,
        permissionMode: req.body?.permissionMode || req.body?.permission_mode,
      });
      const baseUrl = normalizeAgentBackendBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
        || normalizeAgentBackendBaseUrl(req.body?.baseUrl)
        || normalizeAgentBackendBaseUrl(requestBaseUrl(req));
      const payload = await buildAgentConnectionCommand({
        agentId: agent.id,
        workspaceId,
        handle: req.body?.handle || agent.handle || agent.name,
        model: req.body?.model || agent.model,
        permissionMode: req.body?.permissionMode || req.body?.permission_mode || agent.permission_mode,
        baseUrl,
        profile: false,
      });
      const daemonArgs = {
        command: 'connect',
        url: payload.baseUrl || baseUrl || requestBaseUrl(req),
        token: payload.token,
        workspace: workspaceId,
        agent: agent.id,
        handle: payload.handle || agent.handle,
        name: payload.agent?.name || agent.name,
        cwd: cwd || '',
        model: payload.model,
        permissionMode: payload.permissionMode,
      };
      res.json({
        data: {
          workspaceId,
          agentId: agent.id,
          workspace_id: workspaceId,
          agent_id: agent.id,
          agent: payload.agent,
          token: payload.token,
          command: payload.command,
          daemonArgs,
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.get('/backend/cursorbuddy/connection-keys', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.query.workspaceId || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const rows = await getDb().unsafe(
        `select *
         from cursorbuddy_connection_keys
         where workspace_id = $1
         order by created_at desc
         limit 100`,
        [workspaceId],
      );
      res.json({ data: rows.map(publicCursorBuddyConnectionKey), error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/cursorbuddy/connection-keys', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.body?.workspaceId || req.body?.workspace_id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');

      const agentId = String(req.body?.agentId || req.body?.agent_id || '').trim() || null;
      if (agentId) {
        const agentRows = await getDb().unsafe(
          'select id from workspace_agents where id = $1 and workspace_id = $2 limit 1',
          [agentId, workspaceId],
        );
        if (!agentRows[0]) return jsonError(res, 404, new Error('Agent not found in this workspace'));
      }

      const surface = normalizeCursorBuddySurface(req.body?.surface);
      const scope = normalizeCursorBuddyScope(req.body?.scope);
      const domain = normalizeCursorBuddyDomain(req.body?.domain);
      const name = String(req.body?.name || 'CursorBuddy runtime').trim().slice(0, 80) || 'CursorBuddy runtime';
      const requestMetadata = parseJsonObject(req.body?.metadata);
      const metadata = {
        ...requestMetadata,
        requestedBy: req.userId,
        setup: 'cursorbuddy',
        runtimeKind: String(req.body?.runtimeKind || '').trim().slice(0, 80),
      };
      const key = createCursorBuddyConnectionKey(surface);
      const rows = await getDb().unsafe(
        `insert into cursorbuddy_connection_keys
           (workspace_id, agent_id, created_by, key_hash, name, surface, scope, domain, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         returning *`,
        [workspaceId, agentId, req.userId, hashAgentToken(key), name, surface, scope, domain, JSON.stringify(metadata)],
      );
      notifyDbSubscribers('cursorbuddy_connection_keys', 'INSERT', rows.map(publicCursorBuddyConnectionKey));
      res.json({
        data: {
          ...publicCursorBuddyConnectionKey(rows[0]),
          key,
          command: `agensis buddy connect --key ${shellQuote(key)}`,
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/cursorbuddy/provider-agent', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.body?.workspaceId || req.body?.workspace_id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const agent = await ensureCursorBuddyProviderAgent({
        workspaceId,
        userId: req.userId,
        body: req.body || {},
      });
      const providerTool = parseJsonArray(agent.tools).find(tool => tool?.type === 'provider' && tool?.name === 'cursorbuddy');
      const providerMetadata = parseJsonObject(providerTool?.metadata);
      res.json({
        data: {
          workspaceId,
          workspace_id: workspaceId,
          agentId: agent.id,
          agent_id: agent.id,
          provider: 'cursorbuddy',
          mode: 'built_in_provider',
          providerScope: providerMetadata.providerScope || '',
          domain: providerMetadata.domain || '',
          agent: agentRuntimePayload(agent),
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/cursorbuddy/connection-keys/claim', async (req, res) => {
    try {
      const key = String(req.body?.key || '').trim();
      if (!/^cbk_[a-z0-9_]+_[A-Z2-9]{18}$/.test(key)) return jsonError(res, 400, new Error('A valid CursorBuddy connection key is required'));
      const rows = await getDb().unsafe(
        'select * from cursorbuddy_connection_keys where key_hash = $1 limit 1',
        [hashAgentToken(key)],
      );
      const record = rows[0];
      if (!record) return jsonError(res, 404, new Error('CursorBuddy connection key not found'));
      if (record.status === 'claimed') return jsonError(res, 409, new Error('CursorBuddy connection key has already been claimed'));
      if (record.status === 'revoked') return jsonError(res, 410, new Error('CursorBuddy connection key was revoked'));
      if (record.status === 'expired' || (record.expires_at && new Date(record.expires_at) < new Date())) {
        await getDb().unsafe(
          `update cursorbuddy_connection_keys
           set status = 'expired', updated_at = now()
           where id = $1 and status = 'created'`,
          [record.id],
        );
        return jsonError(res, 410, new Error('CursorBuddy connection key has expired'));
      }

      const claim = {
        host: req.body?.host,
        cwd: req.body?.cwd,
        name: req.body?.name,
        surface: req.body?.surface,
        scope: req.body?.scope,
        permissionMode: req.body?.permissionMode || req.body?.permission_mode,
      };
      const agent = await ensureCursorBuddyAgentForKey(record, claim);
      const baseUrl = normalizeAgentBackendBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
        || normalizeAgentBackendBaseUrl(req.body?.baseUrl)
        || normalizeAgentBackendBaseUrl(requestBaseUrl(req));
      const payload = await buildAgentConnectionCommand({
        agentId: agent.id,
        workspaceId: record.workspace_id,
        handle: agent.handle || agent.name,
        model: req.body?.model || agent.model,
        permissionMode: claim.permissionMode || agent.permission_mode,
        baseUrl,
      });
      const metadata = {
        ...parseJsonObject(record.metadata),
        claimedBy: {
          host: String(req.body?.host || '').trim().slice(0, 160),
          cwd: String(req.body?.cwd || '').trim().slice(0, 500),
          runtimeKind: String(req.body?.runtimeKind || 'machine').trim().slice(0, 80),
          version: String(req.body?.version || '').trim().slice(0, 80),
        },
        cursorBuddy: {
          websiteSource: String(req.body?.websiteSource || '').trim().slice(0, 2048),
          page: parseJsonObject(req.body?.page),
          client: parseJsonObject(req.body?.client),
          manifest: parseJsonObject(req.body?.manifest),
          metadata: parseJsonObject(req.body?.metadata),
        },
      };
      const updateRows = await getDb().unsafe(
        `update cursorbuddy_connection_keys
         set status = 'claimed',
             agent_id = $2,
             claimed_at = now(),
             metadata = $3::jsonb,
             updated_at = now()
         where id = $1
         returning *`,
        [record.id, agent.id, JSON.stringify(metadata)],
      );
      notifyDbSubscribers('cursorbuddy_connection_keys', 'UPDATE', updateRows.map(publicCursorBuddyConnectionKey));
      res.json({
        data: {
          ...payload,
          workspaceId: record.workspace_id,
          agentId: agent.id,
          connectionKey: publicCursorBuddyConnectionKey(updateRows[0]),
          command: payload.command,
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

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

  app.delete('/backend/agents/connections/:id', requireAuth, async (req, res) => {
    try {
      const connectionId = String(req.params.id || '').trim();
      if (!connectionId) return jsonError(res, 400, new Error('connection id is required'));
      const rows = await getDb().unsafe('select * from agent_connections where id = $1 limit 1', [connectionId]);
      const connection = rows[0];
      if (!connection) return res.json({ data: { id: connectionId }, error: null });
      await enforceWorkspaceRole(req.userId, connection.workspace_id, 'manage');
      const deleted = await getDb().unsafe('delete from agent_connections where id = $1 returning *', [connectionId]);
      if (deleted.length > 0) notifyDbSubscribers('agent_connections', 'DELETE', deleted.map(publicAgentConnection));
      res.json({ data: { id: connectionId }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/agents/:id/connection-command', requireAuth, async (req, res) => {
    try {
      const agentId = String(req.params.id || '').trim();
      const rows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [agentId]);
      const agent = rows[0];
      if (!agent) return jsonError(res, 404, new Error('Agent not found'));
      if (!isAgentEnabled(agent)) return jsonError(res, 403, new Error('Agent is deactivated'));
      await enforceWorkspaceRole(req.userId, agent.workspace_id, 'manage');
      // Daemons connect over WebSocket, which the Netlify deploy can't host. When
      // AGENSIS_DAEMON_BASE_URL is set (e.g. the Fly backend), emit it as the
      // connect --url so the daemon targets the WS-capable host, not the app origin.
      const baseUrl = normalizeAgentBackendBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
        || normalizeAgentBackendBaseUrl(req.body?.baseUrl)
        || normalizeAgentBackendBaseUrl(requestBaseUrl(req));
      // Shared with the MCP `get_connect_command` tool so the two never drift.
      const payload = await buildAgentConnectionCommand({
        agentId,
        workspaceId: agent.workspace_id,
        handle: req.body?.handle,
        model: req.body?.model,
        permissionMode: req.body?.permissionMode || req.body?.permission_mode,
        baseUrl,
      });
      res.json({ data: payload, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/agents/:id/memory-refresh', requireAuth, async (req, res) => {
    try {
      const agentId = String(req.params.id || '').trim();
      const rows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [agentId]);
      const agent = rows[0];
      if (!agent) return jsonError(res, 404, new Error('Agent not found'));
      // "You can refresh what you can read" — matches agent_memory_files select:'read'.
      await enforceWorkspaceRole(req.userId, agent.workspace_id, 'read');
      // Fire-and-forget nudge: the daemon answers with an agent_memory_sync push that
      // lands as a realtime change on agent_memory_files. The POST never blocks on it.
      const connection = findConnectedAgent(agent.workspace_id, agent.id, agent.handle || agent.name);
      if (connection) sendWs(connection.ws, { type: 'agent_memory_refresh' });
      res.json({ data: { nudged: Boolean(connection) }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/agents/:id/capabilities-refresh', requireAuth, async (req, res) => {
    try {
      const agentId = String(req.params.id || '').trim();
      const rows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [agentId]);
      const agent = rows[0];
      if (!agent) return jsonError(res, 404, new Error('Agent not found'));
      await enforceWorkspaceRole(req.userId, agent.workspace_id, 'read');
      const connection = findConnectedAgent(agent.workspace_id, agent.id, agent.handle || agent.name);
      if (connection) sendWs(connection.ws, { type: 'agent_capabilities_refresh' });
      res.json({ data: { nudged: Boolean(connection) }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/agents/dispatch', requireAuth, async (req, res) => {
    try {
      if (rateLimitBlocked(res, dispatchRateLimiter, req.userId || clientIpFromReq(req))) return;
      const { workspaceId, sessionId, content, threadParentId } = req.body || {};
      if (!workspaceId || !sessionId || !content) {
        return jsonError(res, 400, new Error('workspaceId, sessionId, and content are required'));
      }
      await enforceWorkspaceRole(req.userId, workspaceId, 'run_agents');
      const sessionRows = await getDb().unsafe(
        'select id, workspace_id, participants, conversation_mode from chat_sessions where id = $1 limit 1',
        [sessionId],
      );
      if (!sessionRows[0] || String(sessionRows[0].workspace_id) !== String(workspaceId)) {
        return jsonError(res, 404, new Error('Channel not found'));
      }
      // The user message is already persisted by the client before dispatch, so
      // the orchestrator reconstructs all context (mentions, history, budget)
      // straight from the database. We only decide here whether to kick it off.
      const mentions = parseAgentMentions(content);
      const directTarget = directAgentParticipantFromSession(sessionRows[0]);
      // A human @mentioning an agent that isn't a channel participant yet adds it
      // to the roster (awaited so continueConversation re-reads the updated set).
      // No-op for 1:1 DMs and for mentions of already-present agents.
      if (mentions.length > 0) {
        await ensureMentionedParticipants(workspaceId, sessionRows[0], content);
      }
      const threadTarget = mentions.length === 0 && threadParentId
        ? await inferThreadAgentTarget(sessionId, threadParentId)
        : null;
      // In 'auto' channels a plain human message (no mention/direct/thread target)
      // still enters the orchestrator, which runs the context-aware auto-interject
      // gate. 'mention' channels keep the original behaviour unchanged.
      const autoMode = String(sessionRows[0].conversation_mode || 'mention') === 'auto';
      const willDispatch = mentions.length > 0 || Boolean(threadTarget) || Boolean(directTarget) || autoMode;
      if (!willDispatch) {
        return res.json({ data: { dispatched: false, reason: 'no_agent_mention_or_direct_target' }, error: null });
      }
      // Fire and forget: the conversation advances in the background as each agent
      // message lands and is streamed to clients over realtime. Holding the POST
      // open for the whole multi-turn chain would block the user's UI.
      void continueConversation({ workspaceId, sessionId, threadParentId: threadParentId || null })
        .catch((error) => console.error('continueConversation (dispatch) failed', error));
      const dispatchMode = directTarget ? 'direct' : (mentions.length > 0 || threadTarget ? 'mention' : 'auto');
      return res.json({ data: { dispatched: true, mode: dispatchMode, mentions }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // Native MCP server endpoint. Any MCP-capable CLI (Qwen, Claude Code, Codex)
  // points its config at this URL with `Authorization: Bearer <agent connect
  // token>` and gets the full workspace toolset — no agensis-agent daemon needed.
  // Mirrors the hilos /api/mcp model. See server/mcp.cjs.
  const mcpHandler = createMcpHandler({
    getDb,
    verifyMcpToken,
    continueConversation,
    notifyDbSubscribers,
    slugHandle,
    claimMcpJob,
    submitMcpJobResult,
    resolveWorkspaceAgentByHandle,
    registerAgentRequest,
    getRegistrationStatus,
    getAgentConnectionCommand: buildAgentConnectionCommand,
    enforceWorkspaceRole,
    roleHasWorkspaceCapability,
    rateLimiter: mcpRateLimiter,
    rateLimitBlocked,
    runtimeSchemaReady,
    serverVersion: '1.0.0',
  });
  app.post(['/backend/mcp', '/api/mcp', '/mcp'], mcpHandler);
  app.get(['/backend/mcp', '/api/mcp', '/mcp'], (_req, res) => {
    res.status(405).json({
      error: { message: 'MCP endpoint: use HTTP POST with JSON-RPC 2.0 and an Authorization: Bearer <agent token> header.' },
    });
  });

  // Skill / marketplace endpoints (agentskills.io format). Public + token-free:
  // they serve generic instructions for joining a workspace over the MCP server
  // above. The per-agent Bearer token is delivered separately via the Configure
  // MCP dialog (connection-command). The MCP host is the WS-capable backend
  // (AGENSIS_DAEMON_BASE_URL when set, e.g. Fly), mirroring connection-command.
  function skillBaseUrl(req) {
    return normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL) || requestBaseUrl(req);
  }
  app.get(['/backend/skill', '/api/skill', '/skill', '/.well-known/agent-skill'], (req, res) => {
    if (rateLimitBlocked(res, skillRateLimiter, `skill:${clientIpFromReq(req)}`)) return;
    const manifest = skillManifest({
      baseUrl: skillBaseUrl(req),
      name: typeof req.query?.name === 'string' ? req.query.name : undefined,
      handle: typeof req.query?.handle === 'string' ? req.query.handle : undefined,
    });
    res.json({ data: manifest, error: null });
  });
  app.get(['/backend/skill/SKILL.md', '/api/skill/SKILL.md', '/skill/SKILL.md'], (req, res) => {
    if (rateLimitBlocked(res, skillRateLimiter, `skill:${clientIpFromReq(req)}`)) return;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(renderSkillMd({ baseUrl: skillBaseUrl(req) }));
  });

  app.post('/backend/webhooks/:token', async (req, res) => {
    try {
      // Unauthenticated endpoint: no userId/workspaceId is known before the token
      // lookup, so rate-limit by caller IP (needs a trusted x-forwarded-for behind
      // a proxy; falls back to the socket address).
      if (rateLimitBlocked(res, webhookRateLimiter, clientIpFromReq(req))) return;
      const token = String(req.params.token || '');
      const rows = await getDb().unsafe(
        `select w.*,
                a.id as agent_row_id,
                a.name as agent_name,
                a.handle as agent_handle,
                a.description as agent_description,
                a.system_prompt,
                a.model,
                a.soul,
                a.instructions,
                a.tools,
                a.skills,
                a.permission_mode
         from agent_webhooks w
         left join workspace_agents a on a.id = w.agent_id
         where w.token in ($1, $2) and w.enabled = true
         limit 1`,
        inviteTokenLookupParams(token),
      );
      const webhook = rows[0];
      if (!webhook) return jsonError(res, 404, new Error('Webhook not found'));

      const prompt = String(req.body?.prompt || req.body?.text || req.body?.message || JSON.stringify(req.body || {})).trim();
      if (!prompt) return jsonError(res, 400, new Error('Webhook payload did not include prompt, text, or message'));

      const sessionRows = await getDb().unsafe(
        `insert into chat_sessions (workspace_id, title, model, folder)
         values ($1, $2, $3, $4)
         returning *`,
        [webhook.workspace_id, `Webhook: ${webhook.name}`, webhook.model || 'auto', 'Webhooks'],
      );
      const session = sessionRows[0];
      const messageRows = await getDb().unsafe(
        `insert into messages (session_id, role, content) values ($1, 'user', $2) returning *`,
        [session.id, prompt],
      );

      await getDb().unsafe('update agent_webhooks set last_triggered_at = now(), updated_at = now() where id = $1', [webhook.id]);
      notifyDbSubscribers('chat_sessions', 'INSERT', sessionRows);
      notifyDbSubscribers('messages', 'INSERT', messageRows);

      let assistantMessage = null;
      try {
        const content = await runAnthropicCompletion({
          model: webhook.model || 'auto',
          messages: [{ role: 'user', content: prompt }],
          memory: null,
          documents: null,
          workspaceContext: { triggeredBy: 'webhook', webhook: webhook.name },
          workspaceId: webhook.workspace_id,
          agentContext: webhook.agent_id ? {
            id: webhook.agent_row_id,
            name: webhook.agent_name,
            handle: webhook.agent_handle || slugHandle(webhook.agent_name || ''),
            description: webhook.agent_description || '',
            systemPrompt: webhook.system_prompt,
            soul: webhook.soul,
            instructions: webhook.instructions,
            tools: parseJsonArray(webhook.tools),
            skills: parseJsonArray(webhook.skills),
            model: resolveAnthropicModel(webhook.model),
            permissionMode: normalizeAgentPermissionMode(webhook.permission_mode),
          } : null,
        });
        const assistantRows = await getDb().unsafe(
          `insert into messages (session_id, role, content) values ($1, 'assistant', $2) returning *`,
          [session.id, content],
        );
        assistantMessage = assistantRows[0];
        notifyDbSubscribers('messages', 'INSERT', assistantRows);
      } catch (error) {
        const assistantRows = await getDb().unsafe(
          `insert into messages (session_id, role, content) values ($1, 'assistant', $2) returning *`,
          [session.id, `Webhook received, but agent execution failed: ${error.message || error}`],
        );
        assistantMessage = assistantRows[0];
        notifyDbSubscribers('messages', 'INSERT', assistantRows);
      }

      res.json({ data: { session, userMessage: messageRows[0], assistantMessage }, error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/auth/signup', async (req, res) => {
    try {
      if (rateLimitBlocked(res, signupRateLimiter, clientIpFromReq(req))) return;
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      if (!email || !password) return jsonError(res, 400, new Error('Email and password are required'));
      const passwordPolicy = evaluatePasswordServerSide(password);
      if (!passwordPolicy.valid) return jsonError(res, 400, new Error(passwordPolicy.message || 'Password must be at least 10 characters and include 3 of: lowercase, uppercase, number, symbol.'));

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
      const rows = await getDb().unsafe(
        `update workspace_members set role = $3
          where id = $1 and workspace_id = $2
          returning *`,
        [memberId, workspaceId, role],
      );
      if (!rows[0]) return jsonError(res, 404, new Error('Workspace member not found'));
      notifyDbSubscribers('workspace_members', 'UPDATE', rows);
      res.json({ data: rows[0], error: null });
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
      res.json({ data: rows[0] ?? null, error: null });
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
      const inviteRows = await getDb().unsafe('select * from workspace_invites where token in ($1, $2) limit 1', inviteTokenLookupParams(token));
      const invite = inviteRows[0];
      if (!invite) return jsonError(res, 404, new Error('Invite not found'));
      if (invite.status === 'revoked') return jsonError(res, 410, new Error('This invite has been revoked'));
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) return jsonError(res, 410, new Error('This invite has expired'));
      if (invite.status === 'accepted' && invite.accepted_by && String(invite.accepted_by) !== String(req.userId)) {
        return jsonError(res, 410, new Error('This invite has already been used'));
      }
      const workspaceId = invite.workspace_id;
      const owns = await getDb().unsafe('select 1 from workspaces where id = $1 and user_id = $2 limit 1', [workspaceId, req.userId]);
      if (owns.length === 0) {
        const existing = await getDb().unsafe('select id from workspace_members where workspace_id = $1 and user_id = $2 limit 1', [workspaceId, req.userId]);
        if (existing.length === 0) {
          const memberRows = await getDb().unsafe(
            `insert into workspace_members (workspace_id, user_id, role, invited_by)
             values ($1, $2, $3, $4) returning *`,
            [workspaceId, req.userId, invite.role, invite.created_by],
          );
          notifyDbSubscribers('workspace_members', 'INSERT', memberRows);
        }
      }
      if (invite.status === 'pending') {
        const updated = await getDb().unsafe(
          `update workspace_invites set status = 'accepted', accepted_by = $2, accepted_at = now(), updated_at = now()
            where id = $1 returning *`,
          [invite.id, req.userId],
        );
        notifyDbSubscribers('workspace_invites', 'UPDATE', updated);
      }
      const wsRows = await getDb().unsafe('select id, name from workspaces where id = $1 limit 1', [workspaceId]);
      res.json({ data: { workspaceId, workspace: wsRows[0] ?? null }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // --- Connect an MCP client (one workspace token) + agent-registration approvals ---

  // Generate/rotate the one workspace MCP token and return the ready-to-paste config.
  app.post('/backend/workspaces/:id/mcp-token', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const token = createWorkspaceMcpToken();
      const rows = await getDb().unsafe(
        'update workspaces set mcp_token_hash = $2, updated_at = now() where id = $1 returning id, mcp_auto_approve',
        [workspaceId, hashAgentToken(token)],
      );
      if (!rows[0]) return jsonError(res, 404, new Error('Workspace not found'));
      const baseUrl = normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL) || normalizeBaseUrl(req.body?.baseUrl) || requestBaseUrl(req);
      res.json({
        data: {
          token,
          autoApprove: Boolean(rows[0].mcp_auto_approve),
          endpoint: mcpEndpoint(baseUrl),
          config: configBlock(baseUrl, token),
          claudeMcpAdd: claudeMcpAddCommand(baseUrl, token),
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // When on, a registering client is approved without a popup.
  app.patch('/backend/workspaces/:id/mcp-auto-approve', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const autoApprove = req.body?.autoApprove === true || req.body?.auto_approve === true;
      const rows = await getDb().unsafe(
        'update workspaces set mcp_auto_approve = $2, updated_at = now() where id = $1 returning id, mcp_auto_approve',
        [workspaceId, autoApprove],
      );
      if (!rows[0]) return jsonError(res, 404, new Error('Workspace not found'));
      res.json({ data: { autoApprove: Boolean(rows[0].mcp_auto_approve) }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // Pending registrations drive the approval popup (realtime delivers new ones; this is
  // the initial load / fallback).
  app.get('/backend/workspaces/:id/agent-registrations', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      await enforceWorkspaceRole(req.userId, workspaceId, 'read');
      const status = ['pending', 'approved', 'denied'].includes(req.query?.status) ? req.query.status : 'pending';
      const rows = await getDb().unsafe(
        'select id, agent_id, requested_handle, requested_name, client_label, status, created_at from agent_registrations where workspace_id = $1 and status = $2 order by created_at desc limit 50',
        [workspaceId, status],
      );
      res.json({ data: { registrations: rows }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  // Approve / deny a pending registration (the popup's buttons).
  app.post('/backend/agent-registrations/:id/:action', requireAuth, async (req, res) => {
    try {
      const registrationId = String(req.params.id || '').trim();
      const action = String(req.params.action || '').trim();
      if (!['approve', 'deny'].includes(action)) return jsonError(res, 400, new Error('Unknown action'));
      const found = await getDb().unsafe('select id, workspace_id from agent_registrations where id = $1 limit 1', [registrationId]);
      if (!found[0]) return jsonError(res, 404, new Error('Registration not found'));
      await enforceWorkspaceRole(req.userId, found[0].workspace_id, 'manage');
      const result = await decideAgentRegistration({ registrationId, approve: action === 'approve' });
      res.json({ data: { result }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/db/select', requireAuth, async (req, res) => {
    try {
      const { table, columns = '*', filters = [], orderBy = null, limit = null, single = false } = req.body || {};
      const tableSql = ensureTable(table);
      await enforceDbOperationAccess(req.userId, table, 'select', { filters });
      const where = table === 'workspaces'
        ? appendWorkspaceAccessClause(buildWhereClause(filters, []), req.userId)
        : buildWhereClause(filters, []);
      const { clause, params } = where;
      const rows = await getDb().unsafe(`select ${normalizeColumns(columns)} from ${tableSql}${clause}${buildOrderClause(orderBy)}${Number.isInteger(limit) ? ` LIMIT ${Number(limit)}` : ''}`, params);
      res.json({ data: single ? (rows[0] ?? null) : rows, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/db/insert', requireAuth, async (req, res) => {
    try {
      const { table, values, returning = '*', single = false } = req.body || {};
      const tableSql = ensureTable(table);
      await enforceDbOperationAccess(req.userId, table, 'insert', { values });
      const rows = (Array.isArray(values) ? values : [values]).map(row => (
        table === 'workspaces' && row && typeof row === 'object'
          ? { ...row, user_id: req.userId }
          : row
      ));
      if (!rows[0] || typeof rows[0] !== 'object') return jsonError(res, 400, new Error('Insert values are required'));

      const columns = Object.keys(rows[0]);
      const params = [];
      const valueSql = rows.map((row) => `(${columns.map((column) => {
        return bindDbParam(params, table, column, row[column]);
      }).join(', ')})`).join(', ');

      const result = await getDb().unsafe(
        `insert into ${tableSql} (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning ${normalizeColumns(returning)}`,
        params,
      );

      notifyDbSubscribers(table, 'INSERT', result);

      // A human comment that @mentions an agent wakes that agent in its DM. Fire-and-
      // forget so the insert responds immediately; each mention is guarded internally.
      if (COMMENT_MENTION_TABLES[table]) {
        for (const row of result) {
          void dispatchCommentMentions({ table, row, authorUserId: req.userId }).catch((error) =>
            console.error('dispatchCommentMentions failed', error),
          );
        }
      }

      if (table === 'workspaces') {
        for (const row of result) {
          try {
            await seedDefaultAgents(row.id, row.user_id || req.userId);
          } catch (seedError) {
            console.error('seedDefaultAgents failed:', seedError);
          }
        }
      }

      res.json({ data: single ? (result[0] ?? null) : result, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/db/update', requireAuth, async (req, res) => {
    try {
      const { table, values, filters = [], returning = '*', single = false } = req.body || {};
      const tableSql = ensureTable(table);
      if (!values || typeof values !== 'object') return jsonError(res, 400, new Error('Update values are required'));
      await enforceDbOperationAccess(req.userId, table, 'update', { filters, values });

      const params = [];
      const setParts = Object.keys(values).map((column) => {
        return `${quoteIdent(column)} = ${bindDbParam(params, table, column, values[column])}`;
      });
      if (VERSIONED_TABLES.has(table) && values.version == null) {
        setParts.push('"version" = COALESCE("version", 0) + 1');
      }
      const setClause = setParts.join(', ');
      const where = buildWhereClause(filters, params);
      const result = await getDb().unsafe(
        `update ${tableSql} set ${setClause}${where.clause} returning ${normalizeColumns(returning)}`,
        where.params,
      );

      notifyDbSubscribers(table, 'UPDATE', result);
      res.json({ data: single ? (result[0] ?? null) : result, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/db/delete', requireAuth, async (req, res) => {
    try {
      const { table, filters = [], single = false } = req.body || {};
      const tableSql = ensureTable(table);
      // Refuse an unfiltered delete — it would wipe the entire table.
      if (!Array.isArray(filters) || filters.length === 0) {
        return jsonError(res, 400, new Error('Delete requires at least one filter'));
      }
      const where = buildWhereClause(filters, []);
      if (!where.clause) {
        return jsonError(res, 400, new Error('Delete requires a non-empty where clause'));
      }
      await enforceDbOperationAccess(req.userId, table, 'delete', { filters });
      const result = await getDb().unsafe(`delete from ${tableSql}${where.clause} returning *`, where.params);
      notifyDbSubscribers(table, 'DELETE', result);
      res.json({ data: single ? (result[0] ?? null) : null, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.get('/backend/settings/secrets', requireAuth, async (req, res) => {
    try {
      const workspaceId = settingsWorkspaceIdFromRequest(req);
      if (workspaceId) await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const keys = await listManagedSecrets(workspaceId);
      res.json({ data: { keys }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/settings/secrets', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const workspaceId = settingsWorkspaceIdFromRequest(req);
      if (workspaceId) await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const updates = {};
      for (const key of MANAGED_SECRET_KEYS) {
        // Only apply keys that were explicitly provided. An empty string
        // intentionally clears the stored key.
        if (typeof body[key] === 'string') updates[key] = body[key].trim();
      }
      if (Object.keys(updates).length === 0) {
        return jsonError(res, 400, new Error('No managed keys provided'));
      }
      for (const [key, value] of Object.entries(updates)) {
        if (workspaceId) await setWorkspaceSecretValue(workspaceId, key, value, req.userId);
        else await setSettingValue(key, value);
      }
      const keys = await listManagedSecrets(workspaceId);
      res.json({ data: { keys }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/ai-chat', requireAuth, async (req, res) => {
    try {
      if (rateLimitBlocked(res, aiChatRateLimiter, req.userId || clientIpFromReq(req))) return;
      const { messages, model, memory, documents, workspaceContext, agentContext, workspaceId } = req.body || {};
      if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'run_agents');
      const apiKey = await getAnthropicApiKey(workspaceId);
      if (!apiKey) return jsonError(res, 503, new Error('ANTHROPIC_API_KEY is not configured'));
      const resolvedModel = resolveAnthropicModel(model);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'messages-2023-12-15',
        },
        body: JSON.stringify({
          model: resolvedModel,
          max_tokens: 4096,
          stream: true,
          messages: Array.isArray(messages) ? messages.map((m) => ({ role: m.role, content: m.content })) : [],
          system: buildSystemPrompt(memory, documents, workspaceContext, agentContext),
        }),
      });

      if (!response.ok || !response.body) {
        return jsonError(res, response.status, new Error(await response.text()));
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // stream:true keeps multibyte chars intact across chunk boundaries.
        buffer += decoder.decode(value, { stream: true });
        // Process only complete lines; keep any trailing partial line buffered
        // so a `data:` event split across reads isn't dropped.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
              res.write(`data: ${JSON.stringify({ delta: { text: parsed.delta.text } })}\n\n`);
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
      res.end();
    } catch (error) {
      // Once the SSE headers/body have started flushing, the status line is
      // already sent — calling jsonError() here would throw ERR_HTTP_HEADERS_SENT
      // and leave the client with a truncated stream and no terminator. Emit the
      // failure as an SSE frame followed by [DONE] so the client ends cleanly.
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ error: error?.message || 'AI stream failed' })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch { /* socket already gone */ }
        res.end();
      } else {
        jsonError(res, error.status || 500, error);
      }
    }
  });

  return app;
}

function startBackendServer(port = DEFAULT_PORT) {
  const app = createApp();
  const server = http.createServer(app);
  const wss = attachRealtime(server);
  // Bind to 127.0.0.1 locally (Electron/dev safety) but to 0.0.0.0 in a container
  // so Fly's proxy can reach it. Fly sets HOST=0.0.0.0 via fly.toml [env].
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`[backend] listening on http://${host}:${port}`);
  });
  void reconcileAgentConnectionsAtStartup();
  const jobReaper = setInterval(() => { void reapStuckAgentJobs(); void reapStuckMcpJobs(); void pruneOfflineConnections(); pruneExpiredPeerTickets(); }, 30_000);
  if (jobReaper.unref) jobReaper.unref();
  server.on('close', () => {
    wss.close();
    websocketClients = new Set();
  });
  return server;
}

if (require.main === module) {
  startBackendServer();
}

function setTestDb(nextDb) {
  db = nextDb;
  cachedAuthSecret = null;
  cachedAuthSecretSource = '';
  tokenVersionCache.clear();
}

function resetTestState() {
  db = undefined;
  cachedAuthSecret = null;
  cachedAuthSecretSource = '';
  websocketClients = new Set();
  envLoaded = false;
  tokenVersionCache.clear();
}

// Test seam: register a fake WS client so the realtime-revocation path can be
// exercised without a live socket server.
function registerTestWebsocketClient(ws) {
  websocketClients.add(ws);
  return ws;
}

module.exports = {
  startBackendServer,
  createApp,
  __test: {
    allowLoopbackAgentDevFallback,
    appendWorkspaceAccessClause,
    authorizeRealtimeBinding,
    authorizeRealtimeBroadcast,
    revokeRealtimeAccessForMember,
    registerTestWebsocketClient,
    insertActiveAgentJob,
    buildWhereClause,
    capabilityForDbOperation,
    canManageWorkspace,
    canMutateWorkspace,
    enforceDbOperationAccess,
    enforceWorkspaceRole,
    evaluatePasswordServerSide,
    getWorkspaceRole,
    issueToken,
    resetTestState,
    roleHasWorkspaceCapability,
    setTestDb,
    verifyToken,
    // Token revocation cache — exposed so tests can assert the cache is real
    // (not a no-op) without hardcoding its TTL.
    TOKEN_VERSION_CACHE_TTL_MS,
    getCachedTokenVersion,
    workspaceIdFromRealtimeChannel,
    // MCP connect-a-client model — exercised against a fake DB.
    verifyInviteToken,
    verifyWorkspaceMcpToken,
    verifyUserAuthMcpToken,
    verifyMcpToken,
    createWorkspaceMcpToken,
    createCursorBuddyConnectionKey,
    normalizeCursorBuddySurface,
    normalizeCursorBuddyScope,
    publicCursorBuddyConnectionKey,
    publicWorkspace,
    ensureCursorBuddyAgentForKey,
    runAgentTurn,
    hasActiveBurstJob,
    capabilitiesShapeValid,
    capabilitiesDriftNudges,
    reachFromMessage,
    reachIsDirect,
    publicAgentConnection,
    mintPeerTicket,
    mergeSlashCommands,
    finalizeStuckJob,
    claimMcpJob,
    submitMcpJobResult,
    reapStuckMcpJobs,
    finalizeAgentJobResult,
    resolveWorkspaceAgentByHandle,
    registerAgentRequest,
    finalizeRegistrationApproval,
    decideAgentRegistration,
    getRegistrationStatus,
    touchMcpPresence,
    hasMcpPresence,
    ensureMentionedParticipants,
    parseAgentMentions,
    verifyNetlifyDeploySignature,
  },
};
