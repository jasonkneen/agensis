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

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = Number(process.env.API_PORT || 3142);
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
  'activity_events',
]);

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
]);

let envLoaded = false;
let db;
let websocketClients = new Set();

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

// Settings are persisted in the app_settings table (DB), not .env — so they
// work on serverless deploys with a read-only filesystem.
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

// Resolve a managed secret: DB value first, then env var as a fallback (so an
// ANTHROPIC_API_KEY set via the host environment still works out of the box).
async function resolveSecret(key) {
  loadEnvFile();
  const dbValue = await getSettingValue(key).catch(() => '');
  return dbValue || process.env[key] || '';
}

async function listManagedSecrets() {
  return Promise.all(MANAGED_SECRET_KEYS.map(async (key) => {
    const value = await resolveSecret(key);
    return { key, configured: !!value, preview: maskSecret(value) };
  }));
}

// ============================================================
// AUTH: signed session tokens + workspace access control
// ============================================================

let cachedAuthSecret = null;

// HMAC signing secret, persisted in the DB so tokens survive restarts and work
// on serverless (no writable .env). Generated once on first use.
async function getAuthSecret() {
  if (cachedAuthSecret) return cachedAuthSecret;
  let secret = await getSettingValue('AUTH_SECRET').catch(() => '');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await setSettingValue('AUTH_SECRET', secret);
  }
  cachedAuthSecret = secret;
  return secret;
}

async function issueToken(userId) {
  const secret = await getAuthSecret();
  const sig = crypto.createHmac('sha256', secret).update(String(userId)).digest('base64url');
  return `${userId}.${sig}`;
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const secret = await getAuthSecret();
  const expected = crypto.createHmac('sha256', secret).update(userId).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userId;
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
  'activity_events', 'workspace_members',
]);

const WORKSPACE_MUTATION_TABLES = new Set([
  'documents', 'chat_sessions', 'messages', 'memory_facts', 'uploaded_files',
  'canvas_groups', 'canvas_objects', 'tasks', 'document_comments',
  'task_comments', 'document_versions', 'workspace_agents',
  'activity_events',
]);

const WORKSPACE_MANAGEMENT_TABLES = new Set([
  'workspace_members',
  'agent_webhooks',
]);

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

function canMutateWorkspace(role) {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

function canManageWorkspace(role) {
  return role === 'owner' || role === 'admin';
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
  if (mode === 'manage' && !canManageWorkspace(role)) {
    throw forbidden('You do not have permission to manage this workspace');
  }
  if (mode === 'write' && !canMutateWorkspace(role)) {
    throw forbidden('You do not have permission to change this workspace');
  }
}

async function resolveWorkspaceRowById(id) {
  if (!id) return null;
  const rows = await getDb().unsafe('select id from workspaces where id = $1 limit 1', [id]);
  return rows[0]?.id || null;
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

  const mode = action === 'select'
    ? 'read'
    : WORKSPACE_MANAGEMENT_TABLES.has(table)
      ? 'manage'
      : WORKSPACE_MUTATION_TABLES.has(table) || table === 'messages'
        ? 'write'
        : 'read';

  for (const row of operationRows(payload.values)) {
    if (!row || typeof row !== 'object') continue;
    const resolved = await resolveOperationWorkspace(table, { values: row });
    if (resolved.unscoped) throw badRequest('A workspace reference is required for this operation');
    await enforceWorkspaceRole(userId, resolved.workspaceId, mode);
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

function getAnthropicApiKey() {
  // DB-stored key first (set via Settings → Secret keys), env var as fallback.
  return resolveSecret('ANTHROPIC_API_KEY');
}

async function ensureRuntimeSchema() {
  const db = getDb();
  await db.unsafe(`
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS local_path text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS project_kind text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_root text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_remote text DEFAULT '';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS background_opacity numeric DEFAULT 0.42;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS folder text DEFAULT 'General';
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_folder ON chat_sessions(workspace_id, folder);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(workspace_id, archived_at);

    ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder text DEFAULT 'General';
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(workspace_id, folder);

    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS soul text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS instructions text DEFAULT '';
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS tools jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS skills jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

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

    ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS content_sha256 text DEFAULT '';
    ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE canvas_groups ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE canvas_objects ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE document_comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
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

function buildWhereClause(filters = [], params = []) {
  if (!Array.isArray(filters) || filters.length === 0) {
    return { clause: '', params };
  }

  const clauses = [];
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object') continue;
    const operator = filter.operator || 'eq';
    if (operator !== 'eq') throw new Error(`Unsupported filter operator: ${operator}`);
    params.push(filter.value ?? null);
    clauses.push(`${quoteIdent(filter.column)} = $${params.length}`);
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
  return {
    message: error?.message || 'Database error',
    code: error?.code || null,
    detail: error?.detail || null,
  };
}

function jsonError(res, status, error) {
  res.status(status).json({ data: null, error: mapDbError(error) });
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash || !passwordHash.includes(':')) return false;
  const [salt, storedHash] = passwordHash.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function resolveAnthropicModel(model) {
  if (!model || model === 'auto') return 'claude-fable-5';
  const allowed = new Set([
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ]);
  return allowed.has(model) ? model : 'claude-fable-5';
}

async function runAnthropicCompletion({ model, messages, memory, documents, workspaceContext, agentContext }) {
  const apiKey = await getAnthropicApiKey();
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
  return process.env.HATCH_UPLOAD_ROOT || path.join(process.cwd(), '.hatch_uploads');
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

  const clis = await Promise.all(cliDefinitions.map(async definition => ({
    ...definition,
    ...(await probeCommand(definition.command)),
  })));

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
      sections.push(`You are "${agentContext.name}", an AI agent collaborating in a shared Hatch workspace.`);
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
    sections.push('');
  } else {
    sections.push(
      'You are Hatch AI, a collaborative workspace assistant. You help teams think, write, and get work done inside a shared workspace that contains documents, chats, memory, tasks, files, and a shared canvas.',
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
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
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

function notifyDbSubscribers(table, eventType, rows) {
  const rowList = Array.isArray(rows) ? rows : [];
  if (rowList.length === 0) return;

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
  if (!['canvas', 'cursors', 'item-presence'].includes(prefix)) return null;
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

  wss.on('connection', async (ws, req) => {
    const userId = await verifyToken(tokenFromWsRequest(req));
    if (!userId) {
      ws.close(1008, 'Authentication required');
      return;
    }
    ws.userId = userId;
    ws.subscriptions = [];
    websocketClients.add(ws);

    ws.on('message', async (raw) => {
      try {
        const message = JSON.parse(String(raw || '{}'));
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
        }
      } catch (error) {
        sendWs(ws, { type: 'error', message: error?.message || 'Realtime request rejected' });
      }
    });

    ws.on('close', () => {
      websocketClients.delete(ws);
    });
  });

  return wss;
}

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  void ensureRuntimeSchema().catch((error) => {
    console.warn('[backend] runtime schema migration failed:', error.message || error);
  });

  // NOTE: Auth enforcement (requireAuth gate + workspace membership checks) was
  // reverted — it denied legitimate access for existing users/data and broke
  // the app. Tokens are still issued on signin/signup and sent by the client,
  // but endpoints do not yet enforce them. Re-introduce enforcement carefully
  // with a logged-in test pass before re-enabling. See enforceWorkspaceAccess.

  app.get('/backend/health', async (_req, res) => {
    try {
      await getDb().unsafe('select 1');
      res.json({ ok: true });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.get('/backend/system/capabilities', requireAuth, async (req, res) => {
    try {
      const workspacePath = typeof req.query.workspacePath === 'string' ? req.query.workspacePath : '';
      res.json({ data: await detectCapabilities(workspacePath), error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/system/inspect-path', requireAuth, async (req, res) => {
    try {
      const inspected = await inspectProjectPath(req.body?.path || '');
      res.json({ data: inspected, error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/files/upload', requireAuth, async (req, res) => {
    try {
      const { workspace_id: workspaceId, name, type, contentBase64 } = req.body || {};
      if (!workspaceId || !name || typeof contentBase64 !== 'string') {
        return jsonError(res, 400, new Error('workspace_id, name, and contentBase64 are required'));
      }
      await enforceWorkspaceRole(req.userId, workspaceId, 'write');
      const id = crypto.randomUUID();
      const buffer = Buffer.from(contentBase64, 'base64');
      const storagePath = storagePathFor(workspaceId, id, name);
      const fullPath = resolveStoragePath(storagePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, buffer);
      const sha = crypto.createHash('sha256').update(buffer).digest('hex');
      const rows = await getDb().unsafe(
        `insert into uploaded_files (id, workspace_id, name, size, type, storage_path, content_sha256)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [id, workspaceId, String(name), buffer.length, String(type || ''), storagePath, sha],
      );
      notifyDbSubscribers('uploaded_files', 'INSERT', rows);
      res.json({ data: rows[0], error: null });
    } catch (error) {
      jsonError(res, 500, error);
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
      res.setHeader('Content-Type', file.type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${safeFileName(file.name)}"`);
      fs.createReadStream(fullPath).pipe(res);
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/agent-webhooks', requireAuth, async (req, res) => {
    try {
      const { workspace_id: workspaceId, agent_id: agentId, name } = req.body || {};
      if (!workspaceId || !name) return jsonError(res, 400, new Error('workspace_id and name are required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const token = crypto.randomBytes(32).toString('base64url');
      const rows = await getDb().unsafe(
        `insert into agent_webhooks (workspace_id, agent_id, name, token)
         values ($1, $2, $3, $4)
         returning *`,
        [workspaceId, agentId || null, String(name).trim(), token],
      );
      notifyDbSubscribers('agent_webhooks', 'INSERT', rows);
      res.json({ data: rows[0], error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/webhooks/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      const rows = await getDb().unsafe(
        `select w.*, a.name as agent_name, a.system_prompt, a.model, a.soul, a.instructions, a.tools, a.skills
         from agent_webhooks w
         left join workspace_agents a on a.id = w.agent_id
         where w.token = $1 and w.enabled = true
         limit 1`,
        [token],
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
          agentContext: webhook.agent_id ? {
            name: webhook.agent_name,
            systemPrompt: webhook.system_prompt,
            soul: webhook.soul,
            instructions: webhook.instructions,
            tools: Array.isArray(webhook.tools) ? webhook.tools : [],
            skills: Array.isArray(webhook.skills) ? webhook.skills : [],
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
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      if (!email || !password) return jsonError(res, 400, new Error('Email and password are required'));
      if (password.length < 6) return jsonError(res, 400, new Error('Password must be at least 6 characters'));

      const existing = await getDb().unsafe('select id from app_users where email = $1 limit 1', [email]);
      if (existing.length > 0) return jsonError(res, 409, new Error('An account with that email already exists'));

      const rows = await getDb().unsafe(
        'insert into app_users (email, password_hash) values ($1, $2) returning id, email, created_at',
        [email, createPasswordHash(password)],
      );

      const user = rows[0];
      res.json({ data: { user, token: await issueToken(user.id) }, error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/auth/signin', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      if (!email || !password) return jsonError(res, 400, new Error('Email and password are required'));

      const rows = await getDb().unsafe('select id, email, password_hash, created_at from app_users where email = $1 limit 1', [email]);
      const user = rows[0];
      if (!user || !verifyPassword(password, user.password_hash)) return jsonError(res, 401, new Error('Invalid email or password'));

      res.json({
        data: {
          user: { id: user.id, email: user.email, created_at: user.created_at },
          token: await issueToken(user.id),
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/rpc/lookup_user_by_email', requireAuth, async (req, res) => {
    try {
      const lookupEmail = String(req.body?.lookup_email || '').trim().toLowerCase();
      const rows = await getDb().unsafe('select id, email from app_users where email = $1 limit 1', [lookupEmail]);
      res.json({ data: rows, error: null });
    } catch (error) {
      jsonError(res, 500, error);
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
        params.push(row[column] ?? null);
        return `$${params.length}`;
      }).join(', ')})`).join(', ');

      const result = await getDb().unsafe(
        `insert into ${tableSql} (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning ${normalizeColumns(returning)}`,
        params,
      );

      notifyDbSubscribers(table, 'INSERT', result);
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
      await enforceDbOperationAccess(req.userId, table, 'update', { filters });

      const params = [];
      const setParts = Object.keys(values).map((column) => {
        params.push(values[column] ?? null);
        return `${quoteIdent(column)} = $${params.length}`;
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
      const keys = await listManagedSecrets();
      res.json({ data: { keys }, error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/settings/secrets', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
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
        await setSettingValue(key, value);
      }
      const keys = await listManagedSecrets();
      res.json({ data: { keys }, error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/ai-chat', requireAuth, async (req, res) => {
    try {
      const apiKey = await getAnthropicApiKey();
      if (!apiKey) return jsonError(res, 503, new Error('ANTHROPIC_API_KEY is not configured'));

      const { messages, model, memory, documents, workspaceContext, agentContext } = req.body || {};
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
      jsonError(res, 500, error);
    }
  });

  return app;
}

function startBackendServer(port = DEFAULT_PORT) {
  const app = createApp();
  const server = http.createServer(app);
  const wss = attachRealtime(server);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[backend] listening on http://127.0.0.1:${port}`);
  });
  server.on('close', () => {
    wss.close();
    websocketClients = new Set();
  });
  return server;
}

if (require.main === module) {
  startBackendServer();
}

module.exports = { startBackendServer };
