import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '@netlify/database';
import { getUser } from '@netlify/identity';
import {
  verifyAuthToken,
  enforceDbOperationAccess,
  assertWorkspaceRole,
  appendWorkspaceAccessClause,
  logMessageActivityIdempotent,
  createRateLimiter,
  createTokenVersionCache,
} from '../../shared/backend-core.mjs';

// Plan 005 — token revocation. See shared/backend-core.mjs's verifyAuthToken/
// createTokenVersionCache doc comments for the full rationale.
//
// requireUserId (-> verifyAuthToken -> getTokenVersion) runs BEFORE any
// route-specific handler, on every protected route — including ones that never
// call ensureAppUserProfileColumns() themselves (db/*, settings/secrets,
// ai-chat, ...). So this is the one place that must ensure token_version
// exists itself, or a cold container's very first authenticated request on a
// DB that hasn't run migrations yet would 500 on a missing column.
const tokenVersionCache = createTokenVersionCache();
async function getTokenVersion(userId) {
  await ensureAppUserProfileColumns();
  return tokenVersionCache.get(userId, query);
}

// H4 — Rate limiting. Module-scoped, in-memory fixed-window limiters.
// NOTE: in-memory state lives in a single warm serverless instance; a
// multi-instance / scaled deploy needs a SHARED store (Redis, etc.) to be
// globally accurate. This is a first abuse-protection layer, not a hard quota.
const aiChatRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const dispatchRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

function clientIpFromRequest(req) {
  const forwarded = String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || req.headers.get('x-nf-client-connection-ip') || 'unknown';
}

// Returns a 429 Response (with Retry-After) when the key is over budget, else null.
function rateLimitBlock(limiter, key) {
  const result = limiter.check(key);
  if (result.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return new Response(
    JSON.stringify({ data: null, error: { message: 'Rate limit exceeded. Please retry shortly.', code: 'rate_limited' } }),
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) } },
  );
}

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

const JSON_COLUMNS_BY_TABLE = {
  chat_sessions: new Set(['participants']),
  canvas_objects: new Set(['points']),
  workspace_agents: new Set(['tools', 'skills']),
  agent_connections: new Set(['metadata']),
  agent_jobs: new Set(['metadata']),
  activity_events: new Set(['metadata']),
};

const MANAGED_SECRET_KEYS = ['ANTHROPIC_API_KEY'];
const OPENPETS_CATALOG_URL = 'https://openpets.dev/pets/catalog.v3/page-000.json';
const CODEX_PETS_ROOT = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'pets');
let database;

function dbPool() {
  if (!database) {
    const connectionString = process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    database = connectionString ? getDatabase({ connectionString }) : getDatabase();
  }
  return database.pool;
}

function mapDbError(error) {
  return {
    message: error?.message || 'Database error',
    code: error?.code || null,
    detail: error?.detail || null,
  };
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

function jsonError(status, error) {
  return json({ data: null, error: mapDbError(error) }, status);
}

async function readBody(req) {
  return req.json().catch(() => ({}));
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
  const computed = Buffer.from(hash, 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  // timingSafeEqual throws on a length mismatch; treat as a failed verification.
  if (computed.length !== stored.length) return false;
  return crypto.timingSafeEqual(computed, stored);
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

function createAgentConnectToken() {
  return `aga_${crypto.randomBytes(32).toString('base64url')}`;
}

function normalizeAgentPermissionMode(value) {
  return value === 'accept_edits' || value === 'yolo' ? value : 'default';
}

function resolveAnthropicModel(model) {
  if (model === 'claude-sonnet-4-6') return 'claude-sonnet-4-5';
  if (model === 'claude-opus-4-6') return 'claude-opus-4-5';
  if (model === 'claude-haiku-4-5') return 'claude-haiku-4-5';
  if (model && model !== 'auto') return model;
  return 'claude-opus-4-5';
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

function daemonBaseUrl() {
  return normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL || process.env.AGENSIS_WS_BASE_URL || '');
}

function requestBaseUrl(req) {
  const publicUrl = normalizeBaseUrl(process.env.AGENSIS_PUBLIC_URL || process.env.PUBLIC_URL || '');
  if (publicUrl) return publicUrl;
  const url = new URL(req.url);
  const forwardedProto = String(req.headers.get('x-forwarded-proto') || '').split(',')[0].trim();
  const forwardedHost = String(req.headers.get('x-forwarded-host') || '').split(',')[0].trim();
  const proto = forwardedProto || url.protocol.replace(':', '') || 'https';
  const host = forwardedHost || req.headers.get('host') || url.host;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0):8888$/.test(host)) {
    return 'http://127.0.0.1:3142';
  }
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

function agentPermissionFlags(permissionMode) {
  return normalizeAgentPermissionMode(permissionMode) === 'yolo' ? ['--no-sandbox', '--yolo'] : [];
}

function agentConnectionCommand({ baseUrl, token, workspaceId, agentId, handle, name, model, permissionMode }) {
  const resolvedModel = resolveAnthropicModel(model);
  const resolvedPermissionMode = normalizeAgentPermissionMode(permissionMode);
  const commandPermissionArgs = ['--permission-mode', shellQuote(resolvedPermissionMode)];
  const displayName = String(name || handle || 'Agensis Agent').trim() || 'Agensis Agent';
  if (resolvedPermissionMode === 'yolo') commandPermissionArgs.push('--no-sandbox');
  const portableCommand = [
    'agensis',
    'connect',
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

function jsonErrorWithData(status, error, data = null) {
  return json({ data, error: mapDbError(error) }, status);
}

function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || 'netlify-preview-auth-secret';
}

function issueToken(userId, tokenVersion) {
  const payload = `${userId}.${tokenVersion}`;
  const sig = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Resolve the authed user id from a request's Authorization header. Throws 401
// when no valid Bearer token is present. The thrown error's `.status` is mapped
// to the existing `{ data: null, error }` JSON shape by the top-level handler.
async function requireUserId(req) {
  const userId = await verifyAuthToken(req.headers.get('authorization'), getAuthSecret(), getTokenVersion);
  if (!userId) {
    const err = new Error('Authentication required');
    err.status = 401;
    throw err;
  }
  return userId;
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
    if (operator !== 'eq') throw new Error(`Unsupported filter operator: ${operator}`);
    params.push(filter.value ?? null);
    clauses.push(`${quoteIdent(filter.column)} = $${params.length}`);
  }

  return {
    clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function buildOrderClause(orderBy) {
  if (!orderBy || !orderBy.column) return '';
  const direction = orderBy.ascending === false ? 'DESC' : 'ASC';
  return ` ORDER BY ${quoteIdent(orderBy.column)} ${direction}`;
}

function buildSystemPrompt(memory, documents, workspaceContext) {
  const sections = [
    'You are agensis AI, a collaborative workspace assistant. You help teams think, write, and get work done inside a shared workspace that contains documents, chats, memory, tasks, files, and a shared canvas.',
    '',
    'Guidelines:',
    '- Be concise, warm, and thoughtful. Prefer markdown for structure.',
    '- When you reference workspace content, quote the title so teammates can find it.',
    '- When the user asks you to extract or create tasks, emit them on their own lines using this exact format so the app can parse them: `TASK: <title>` (one task per line).',
    '- If you do not know something from the provided context, say so rather than inventing.',
    '- You are one of potentially many people in this workspace; speak in a way that is useful to the whole team, not just a single user.',
  ];

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

async function query(text, params = []) {
  const result = await dbPool().query(text, params);
  return result.rows;
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function ensureSecretsTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT '',
      updated_at timestamptz DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS workspace_secrets (
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      key text NOT NULL,
      value text NOT NULL DEFAULT '',
      updated_by uuid,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (workspace_id, key)
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_workspace_secrets_workspace_id ON workspace_secrets(workspace_id)');
}

async function getSettingValue(key) {
  await ensureSecretsTables();
  const rows = await query('select value from app_settings where key = $1 limit 1', [key]);
  return rows[0]?.value || '';
}

async function setSettingValue(key, value) {
  await ensureSecretsTables();
  await query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

async function getWorkspaceSecretValue(workspaceId, key) {
  if (!workspaceId) return '';
  await ensureSecretsTables();
  const rows = await query(
    'select value from workspace_secrets where workspace_id = $1 and key = $2 limit 1',
    [workspaceId, key],
  );
  return rows[0]?.value || '';
}

async function setWorkspaceSecretValue(workspaceId, key, value, userId = null) {
  await ensureSecretsTables();
  await query(
    `insert into workspace_secrets (workspace_id, key, value, updated_by, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (workspace_id, key)
     do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [workspaceId, key, value, userId],
  );
}

async function resolveSecret(key, workspaceId = null) {
  const workspaceValue = await getWorkspaceSecretValue(workspaceId, key).catch(() => '');
  if (workspaceValue) return workspaceValue;
  const appValue = await getSettingValue(key).catch(() => '');
  return appValue || process.env[key] || '';
}

async function listManagedSecrets(workspaceId = null) {
  await ensureSecretsTables();
  return Promise.all(MANAGED_SECRET_KEYS.map(async (key) => {
    const workspaceValue = await getWorkspaceSecretValue(workspaceId, key).catch(() => '');
    const fallbackValue = workspaceValue ? '' : await resolveSecret(key, null);
    const value = workspaceValue || fallbackValue;
    return {
      key,
      configured: Boolean(value),
      preview: maskSecret(value),
      scope: workspaceValue ? 'workspace' : fallbackValue ? 'app' : 'unset',
    };
  }));
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicAgentConnection(row) {
  if (!row) return row;
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
    connected_at: row.connected_at,
    last_seen_at: row.last_seen_at,
    updated_at: row.updated_at,
  };
}

async function ensureAgentConnectionsTable() {
  await query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await query(`
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
      connected_at timestamptz DEFAULT now(),
      last_seen_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_agent_connections_workspace_id ON agent_connections(workspace_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_agent_connections_agent_id ON agent_connections(agent_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_agent_connections_status ON agent_connections(workspace_id, status)');
}

async function handleSystemCapabilities(req) {
  const url = new URL(req.url);
  const workspacePath = url.searchParams.get('workspacePath') || '';
  const configuredDaemonBaseUrl = daemonBaseUrl();
  return json({
    data: {
      checkedAt: new Date().toISOString(),
      workspacePath,
      clis: [],
      packages: [],
      skills: [],
      codexAppServer: {
        available: Boolean(configuredDaemonBaseUrl),
        command: '',
        transports: configuredDaemonBaseUrl ? ['websocket'] : [],
        daemonBaseUrl: configuredDaemonBaseUrl,
      },
    },
    error: null,
  });
}

async function handleAgentConnections(req, userId) {
  const url = new URL(req.url);
  const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
  if (!workspaceId) return jsonError(400, new Error('workspaceId is required'));
  await assertWorkspaceRole({ userId, workspaceId, capability: 'read', db: query });
  await ensureAgentConnectionsTable();
  const rows = await query(
    `select *
     from agent_connections
     where workspace_id = $1
       and last_seen_at > now() - interval '24 hours'
     order by status = 'online' desc, status = 'busy' desc, last_seen_at desc`,
    [workspaceId],
  );
  return json({ data: rows.map(publicAgentConnection), error: null });
}

let appUserProfileColumnsEnsured = false;
async function ensureAppUserProfileColumns() {
  if (appUserProfileColumnsEnsured) return;
  await query(`
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name text DEFAULT '';
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS accent_color text DEFAULT '';
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;
  `);
  appUserProfileColumnsEnsured = true;
}

async function ensureAgentRuntimeTables() {
  await query(`
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
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_workspace_agents_handle ON workspace_agents(workspace_id, handle)');
  await query('CREATE INDEX IF NOT EXISTS idx_workspace_agents_connect_token_hash ON workspace_agents(connect_token_hash)');
  await query(`
    CREATE TABLE IF NOT EXISTS agent_webhooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
      name text NOT NULL DEFAULT 'Webhook',
      token text NOT NULL UNIQUE,
      enabled boolean NOT NULL DEFAULT true,
      last_triggered_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      version integer NOT NULL DEFAULT 1
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_agent_webhooks_workspace_id ON agent_webhooks(workspace_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent_id ON agent_webhooks(agent_id)');
}

async function handleAgentDispatch(req, userId) {
  const body = await readBody(req);
  const { workspaceId, sessionId, content } = body || {};
  if (!workspaceId || !sessionId || !content) {
    return jsonError(400, new Error('workspaceId, sessionId, and content are required'));
  }
  await assertWorkspaceRole({ userId, workspaceId, capability: 'run_agents', db: query });
  const baseUrl = daemonBaseUrl();
  if (baseUrl && req.headers.get('x-agensis-dispatch-proxy') !== '1') {
    return proxyAgentDispatchToDaemon(req, baseUrl, body);
  }
  // Serverless deployments cannot hold the local daemon orchestration loop open.
  // Without a websocket-capable daemon backend there is nowhere to deliver the
  // job, so keep the explicit fallback contract.
  return json({
    data: {
      dispatched: false,
      reason: baseUrl ? 'daemon_dispatch_proxy_loop' : 'serverless_dispatch_unavailable',
      requiredEnv: baseUrl ? null : 'AGENSIS_DAEMON_BASE_URL',
    },
    error: null,
  });
}

async function proxyAgentDispatchToDaemon(req, baseUrl, body) {
  let upstream;
  try {
    upstream = await fetch(`${baseUrl}/backend/agents/dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: req.headers.get('authorization') || '',
        'X-Agensis-Dispatch-Proxy': '1',
      },
      body: JSON.stringify(body || {}),
    });
  } catch (error) {
    return jsonErrorWithData(
      502,
      new Error(`Daemon dispatch backend is unreachable: ${error?.message || error}`),
      { dispatched: false, daemonBaseUrl: baseUrl },
    );
  }

  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') || 'application/json';
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': contentType },
  });
}

async function handleCreateAgentWebhook(req, userId) {
  await ensureAgentRuntimeTables();
  const body = await readBody(req);
  const workspaceId = String(body?.workspace_id || '').trim();
  const agentId = body?.agent_id ? String(body.agent_id).trim() : null;
  const name = String(body?.name || '').trim();
  if (!workspaceId || !name) return jsonError(400, new Error('workspace_id and name are required'));
  await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
  if (agentId) {
    const agentRows = await query('select id from workspace_agents where id = $1 and workspace_id = $2 limit 1', [agentId, workspaceId]);
    if (!agentRows[0]) return jsonError(404, new Error('Agent not found in this workspace'));
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const rows = await query(
    `insert into agent_webhooks (workspace_id, agent_id, name, token)
     values ($1, $2, $3, $4)
     returning *`,
    [workspaceId, agentId || null, name, token],
  );
  return json({ data: rows[0], error: null });
}

async function handleAgentConnectionCommand(req, agentId, userId) {
  await ensureAgentRuntimeTables();
  const body = await readBody(req);
  const rows = await query('select * from workspace_agents where id = $1 limit 1', [agentId]);
  const agent = rows[0];
  if (!agent) return jsonError(404, new Error('Agent not found'));
  if (agent.enabled === false) return jsonError(403, new Error('Agent is deactivated'));
  await assertWorkspaceRole({ userId, workspaceId: agent.workspace_id, capability: 'manage', db: query });
  const handle = slugHandle(body?.handle || agent.handle || agent.name);
  const model = resolveAnthropicModel(body?.model || agent.model);
  const permissionMode = normalizeAgentPermissionMode(body?.permissionMode || body?.permission_mode || agent.permission_mode);
  const baseUrl = daemonBaseUrl();
  if (!baseUrl) {
    return jsonErrorWithData(
      503,
      new Error('Daemon websocket backend is not configured. Set AGENSIS_DAEMON_BASE_URL to a long-running Node backend that serves /backend/ws; Netlify Functions cannot host websocket upgrades.'),
      {
        websocketAvailable: false,
        requiredEnv: 'AGENSIS_DAEMON_BASE_URL',
      },
    );
  }
  const token = createAgentConnectToken();
  const updateRows = await query(
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
    [agentId, handle, hashAgentToken(token), model, permissionMode],
  );
  const commands = agentConnectionCommand({
    baseUrl,
    token,
    workspaceId: agent.workspace_id,
    agentId,
    handle,
    name: updateRows[0]?.name || agent.name,
    model: updateRows[0]?.model || agent.model,
    permissionMode,
  });
  return json({
    data: {
      agent: updateRows[0],
      handle,
      token,
      command: commands.portableCommand,
      localCommand: commands.localCommand,
      portableCommand: commands.portableCommand,
      baseUrl,
      model,
      permissionMode,
      permission_mode: permissionMode,
      permissionFlags: agentPermissionFlags(permissionMode),
    },
    error: null,
  });
}

async function handleAuth(pathname, req) {
  await ensureAppUserProfileColumns();
  const body = await readBody(req);
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!email || !password) return jsonError(400, new Error('Email and password are required'));

  if (pathname === '/backend/auth/signup') {
    if (password.length < 6) return jsonError(400, new Error('Password must be at least 6 characters'));
    const existing = await query('select id from app_users where email = $1 limit 1', [email]);
    if (existing.length > 0) return jsonError(409, new Error('An account with that email already exists'));

    const rows = await query(
      'insert into app_users (email, password_hash) values ($1, $2) returning id, email, display_name, accent_color, created_at, token_version',
      [email, createPasswordHash(password)],
    );
    const row = rows[0];
    const user = { id: row.id, email: row.email, display_name: row.display_name, accent_color: row.accent_color, created_at: row.created_at };
    return json({ data: { user, token: issueToken(user.id, row.token_version) }, error: null });
  }

  const rows = await query('select id, email, password_hash, display_name, accent_color, created_at, token_version from app_users where email = $1 limit 1', [email]);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return jsonError(401, new Error('Invalid email or password'));
  }
  const sessionUser = { id: user.id, email: user.email, display_name: user.display_name, accent_color: user.accent_color, created_at: user.created_at };
  return json({ data: { user: sessionUser, token: issueToken(sessionUser.id, user.token_version) }, error: null });
}

async function handleOAuthAuth() {
  await ensureAppUserProfileColumns();
  const identityUser = await getUser();
  const email = String(identityUser?.email || '').trim().toLowerCase();
  if (!email) return jsonError(401, new Error('Social login was not completed'));

  const existing = await query('select id, email, display_name, accent_color, created_at, token_version from app_users where email = $1 limit 1', [email]);
  const row = existing[0] || (await query(
    'insert into app_users (email, password_hash) values ($1, $2) returning id, email, display_name, accent_color, created_at, token_version',
    [email, `oauth:netlify:${identityUser.id}`],
  ))[0];
  const user = { id: row.id, email: row.email, display_name: row.display_name, accent_color: row.accent_color, created_at: row.created_at };

  return json({ data: { user, token: issueToken(user.id, row.token_version) }, error: null });
}

async function handleGetMyProfile(userId) {
  await ensureAppUserProfileColumns();
  const rows = await query('select id, email, display_name, accent_color, created_at from app_users where id = $1 limit 1', [userId]);
  if (!rows[0]) return jsonError(404, new Error('User not found'));
  return json({ data: rows[0], error: null });
}

async function handleUpdateMyProfile(req, userId) {
  await ensureAppUserProfileColumns();
  const body = await readBody(req);
  const updates = {};
  if (body?.display_name !== undefined) {
    updates.display_name = String(body.display_name || '').trim().slice(0, 80);
  }
  if (body?.accent_color !== undefined) {
    const color = String(body.accent_color || '').trim();
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
      return jsonError(400, new Error('accent_color must be a #rrggbb hex value'));
    }
    updates.accent_color = color;
  }
  const fields = Object.keys(updates);
  if (fields.length === 0) return jsonError(400, new Error('No fields to update'));

  const setClause = fields.map((field, i) => `${field} = $${i + 2}`).join(', ');
  const rows = await query(
    `update app_users set ${setClause} where id = $1 returning id, email, display_name, accent_color, created_at`,
    [userId, ...fields.map(field => updates[field])],
  );
  if (!rows[0]) return jsonError(404, new Error('User not found'));
  return json({ data: rows[0], error: null });
}

async function handleChangeMyPassword(req, userId) {
  const body = await readBody(req);
  const currentPassword = String(body?.currentPassword || '');
  const newPassword = String(body?.newPassword || '');
  if (!currentPassword || !newPassword) return jsonError(400, new Error('Current and new password are required'));
  if (newPassword.length < 6) return jsonError(400, new Error('New password must be at least 6 characters'));

  const rows = await query('select id, password_hash from app_users where id = $1 limit 1', [userId]);
  const user = rows[0];
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    return jsonError(401, new Error('Current password is incorrect'));
  }

  // Bumping token_version invalidates EVERY outstanding token for this user,
  // including the one used to make this very request — issue a fresh one below
  // so the caller's own session survives without a forced re-login.
  const updated = await query(
    'update app_users set password_hash = $2, token_version = token_version + 1 where id = $1 returning token_version',
    [userId, createPasswordHash(newPassword)],
  );
  const newVersion = updated[0]?.token_version;
  tokenVersionCache.set(userId, newVersion);
  return json({ data: { ok: true, token: issueToken(userId, newVersion) }, error: null });
}

// Real server-side sign-out: bumps token_version so the calling token (and
// every other outstanding token for this user) is rejected on its next use.
async function handleSignOut(userId) {
  const updated = await query(
    'update app_users set token_version = token_version + 1 where id = $1 returning token_version',
    [userId],
  );
  if (updated[0]) tokenVersionCache.set(userId, updated[0].token_version);
  return json({ data: { ok: true }, error: null });
}

// Logs an `activity_events` row for each inserted chat message so it surfaces in
// the Activity feed. Delegates to the shared idempotent logger so both backends
// use ONE implementation (idempotent: skips messages already logged).
// C3 — ensure the partial unique index that makes message-activity logging
// idempotent. Mirrors the migration + server runtime DDL. Runs at most once per
// warm instance and never throws into the caller (the ON CONFLICT insert
// degrades gracefully if this hasn't landed yet).
let activityIndexEnsured = false;
async function ensureActivityEventsIndex() {
  if (activityIndexEnsured) return;
  try {
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_events_message_sent
       ON activity_events (entity_id)
       WHERE event_type = 'message_sent' AND entity_type = 'message'`,
    );
    activityIndexEnsured = true;
  } catch (error) {
    console.error('ensureActivityEventsIndex failed', error);
  }
}

async function logMessageActivity(rows) {
  await ensureActivityEventsIndex();
  await logMessageActivityIdempotent(rows, { db: query });
}

// Default agents seeded into every brand-new workspace. Kept in sync with the
// local backend (server/index.cjs).
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
  const existing = await query(
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

  await query(
    `insert into workspace_agents (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning *`,
    params,
  );
}

async function handleDb(pathname, req, userId) {
  const body = await readBody(req);

  if (pathname === '/backend/db/select') {
    const { table, columns = '*', filters = [], orderBy = null, limit = null, single = false } = body || {};
    const tableSql = ensureTable(table);
    await enforceDbOperationAccess({ userId, table, op: 'select', filters, db: query });
    // `workspaces` SELECT is scoped to rows the user owns or is a member of.
    const where = table === 'workspaces'
      ? appendWorkspaceAccessClause(buildWhereClause(filters, []), userId)
      : buildWhereClause(filters, []);
    const { clause, params } = where;
    const limitSql = Number.isInteger(limit) ? ` LIMIT ${Number(limit)}` : '';
    const rows = await query(`select ${normalizeColumns(columns)} from ${tableSql}${clause}${buildOrderClause(orderBy)}${limitSql}`, params);
    return json({ data: single ? (rows[0] ?? null) : rows, error: null });
  }

  if (pathname === '/backend/db/insert') {
    const { table, values, returning = '*', single = false } = body || {};
    const tableSql = ensureTable(table);
    await enforceDbOperationAccess({ userId, table, op: 'insert', payload: { values }, db: query });
    // Force a workspace's owner to the authed user (never trust a client user_id).
    const rows = (Array.isArray(values) ? values : [values]).map((row) => (
      table === 'workspaces' && row && typeof row === 'object'
        ? { ...row, user_id: userId }
        : row
    ));
    if (!rows[0] || typeof rows[0] !== 'object') return jsonError(400, new Error('Insert values are required'));

    const columns = Object.keys(rows[0]);
    const params = [];
    const valueSql = rows.map((row) => `(${columns.map((column) => {
      return bindDbParam(params, table, column, row[column]);
    }).join(', ')})`).join(', ');

    const result = await query(
      `insert into ${tableSql} (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning ${normalizeColumns(returning)}`,
      params,
    );
    if (table === 'messages') {
      await logMessageActivity(result);
    }
    if (table === 'workspaces') {
      for (const row of result) {
        try {
          await seedDefaultAgents(row.id, row.user_id ?? userId);
        } catch (seedError) {
          console.error('seedDefaultAgents failed', seedError);
        }
      }
    }
    return json({ data: single ? (result[0] ?? null) : result, error: null });
  }

  if (pathname === '/backend/db/update') {
    const { table, values, filters = [], returning = '*', single = false } = body || {};
    const tableSql = ensureTable(table);
    if (!values || typeof values !== 'object') return jsonError(400, new Error('Update values are required'));
    await enforceDbOperationAccess({ userId, table, op: 'update', filters, db: query });

    const params = [];
    const setParts = Object.keys(values).map((column) => {
      return `${quoteIdent(column)} = ${bindDbParam(params, table, column, values[column])}`;
    });
    if (VERSIONED_TABLES.has(table) && values.version == null) {
      setParts.push('"version" = COALESCE("version", 0) + 1');
    }
    const setClause = setParts.join(', ');
    const where = buildWhereClause(filters, params);
    const result = await query(
      `update ${tableSql} set ${setClause}${where.clause} returning ${normalizeColumns(returning)}`,
      where.params,
    );
    return json({ data: single ? (result[0] ?? null) : result, error: null });
  }

  if (pathname === '/backend/db/delete') {
    const { table, filters = [], single = false } = body || {};
    const tableSql = ensureTable(table);
    // Refuse an unfiltered delete — it would wipe the entire table.
    if (!Array.isArray(filters) || filters.length === 0) {
      return jsonError(400, new Error('Delete requires at least one filter'));
    }
    const where = buildWhereClause(filters, []);
    if (!where.clause) {
      return jsonError(400, new Error('Delete requires a non-empty where clause'));
    }
    await enforceDbOperationAccess({ userId, table, op: 'delete', filters, db: query });
    const result = await query(`delete from ${tableSql}${where.clause} returning *`, where.params);
    return json({ data: single ? (result[0] ?? null) : null, error: null });
  }

  return jsonError(404, new Error('Backend route not found'));
}

async function handleAiChat(req, userId) {
  const { messages, model, memory, documents, workspaceContext, workspaceId } = await readBody(req);
  // A valid token is required (enforced by the router). When the request targets
  // a workspace, the user must additionally be allowed to run agents there.
  if (workspaceId) {
    await assertWorkspaceRole({ userId, workspaceId, capability: 'run_agents', db: query });
  }
  const apiKey = await resolveSecret('ANTHROPIC_API_KEY', workspaceId || null);
  if (!apiKey) return jsonError(503, new Error('ANTHROPIC_API_KEY is not configured'));
  const resolvedModel = !model || model === 'auto'
    ? 'claude-opus-4-5'
    : model === 'claude-opus-4-6'
      ? 'claude-opus-4-5'
      : model === 'claude-sonnet-4-6'
        ? 'claude-sonnet-4-5'
        : model === 'claude-haiku-4-5'
          ? 'claude-haiku-4-5'
          : 'claude-opus-4-5';

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
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
      system: buildSystemPrompt(memory, documents, workspaceContext),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return jsonError(upstream.status, new Error(await upstream.text()));
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: { text: parsed.delta.text } })}\n\n`));
            }
          } catch {
            // Ignore malformed upstream chunks.
          }
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

async function route(req) {
  const pathname = new URL(req.url).pathname;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (pathname === '/backend/health') {
    await query('select 1');
    return json({ ok: true });
  }
  if (req.method === 'GET' && pathname === '/backend/openpets/catalog') {
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
      if (remoteError && merged.pets.length === 0) return jsonError(502, remoteError);
      return json({ data: merged, error: null });
    } catch (error) {
      return jsonError(502, error);
    }
  }
  const codexPetAssetMatch = pathname.match(/^\/backend\/codex-pets\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && codexPetAssetMatch) {
    try {
      const petDir = path.resolve(CODEX_PETS_ROOT, decodeURIComponent(codexPetAssetMatch[1]));
      const assetName = path.basename(decodeURIComponent(codexPetAssetMatch[2]));
      const assetPath = path.resolve(petDir, assetName);
      if (!assetName || !/\.(webp|png|gif|jpe?g)$/i.test(assetName)) return jsonError(404, new Error('Pet asset not found'));
      if (!isPathInside(CODEX_PETS_ROOT, petDir) || !isPathInside(petDir, assetPath)) return jsonError(404, new Error('Pet asset not found'));
      if (!fs.existsSync(path.join(petDir, 'pet.json')) || !fs.existsSync(assetPath)) return jsonError(404, new Error('Pet asset not found'));
      const body = await fs.promises.readFile(assetPath);
      return new Response(body, {
        headers: {
          'Content-Type': contentTypeForImageAsset(assetPath),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (error) {
      return jsonError(500, error);
    }
  }
  if (req.method === 'GET' && pathname === '/backend/system/capabilities') {
    return handleSystemCapabilities(req);
  }
  if (req.method === 'GET' && pathname === '/backend/agents/connections') {
    return handleAgentConnections(req, await requireUserId(req));
  }
  if (req.method === 'POST' && pathname === '/backend/agents/dispatch') {
    const userId = await requireUserId(req);
    const blocked = rateLimitBlock(dispatchRateLimiter, userId || clientIpFromRequest(req));
    if (blocked) return blocked;
    return handleAgentDispatch(req, userId);
  }
  if (req.method === 'POST' && pathname === '/backend/agent-webhooks') {
    return handleCreateAgentWebhook(req, await requireUserId(req));
  }
  const connectionCommandMatch = pathname.match(/^\/backend\/agents\/([^/]+)\/connection-command$/);
  if (req.method === 'POST' && connectionCommandMatch) {
    return handleAgentConnectionCommand(req, decodeURIComponent(connectionCommandMatch[1]), await requireUserId(req));
  }
  if (req.method === 'POST' && (pathname === '/backend/auth/signup' || pathname === '/backend/auth/signin')) {
    return handleAuth(pathname, req);
  }
  if (req.method === 'POST' && pathname === '/backend/auth/oauth') {
    return handleOAuthAuth();
  }
  if (req.method === 'POST' && pathname === '/backend/auth/signout') {
    return handleSignOut(await requireUserId(req));
  }
  if (req.method === 'POST' && pathname === '/backend/rpc/lookup_user_by_email') {
    await requireUserId(req);
    const body = await readBody(req);
    const lookupEmail = String(body?.lookup_email || '').trim().toLowerCase();
    const rows = await query('select id, email from app_users where email = $1 limit 1', [lookupEmail]);
    return json({ data: rows, error: null });
  }
  if (req.method === 'GET' && pathname === '/backend/users/me') {
    return handleGetMyProfile(await requireUserId(req));
  }
  if (req.method === 'PATCH' && pathname === '/backend/users/me') {
    return handleUpdateMyProfile(req, await requireUserId(req));
  }
  if (req.method === 'POST' && pathname === '/backend/users/me/change-password') {
    return handleChangeMyPassword(req, await requireUserId(req));
  }
  if (req.method === 'POST' && pathname.startsWith('/backend/db/')) {
    return handleDb(pathname, req, await requireUserId(req));
  }
  if (req.method === 'GET' && pathname === '/backend/settings/secrets') {
    const userId = await requireUserId(req);
    const url = new URL(req.url);
    const workspaceId = String(url.searchParams.get('workspaceId') || '').trim() || null;
    // Managed secrets (ANTHROPIC_API_KEY etc.) require workspace manage rights.
    if (workspaceId) await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
    const keys = await listManagedSecrets(workspaceId);
    return json({ data: { keys }, error: null });
  }
  if (req.method === 'POST' && pathname === '/backend/settings/secrets') {
    const userId = await requireUserId(req);
    const body = await readBody(req);
    const workspaceId = String(body?.workspaceId || '').trim() || null;
    if (workspaceId) await assertWorkspaceRole({ userId, workspaceId, capability: 'manage', db: query });
    const updates = {};
    for (const key of MANAGED_SECRET_KEYS) {
      if (typeof body?.[key] === 'string') updates[key] = body[key].trim();
    }
    if (Object.keys(updates).length === 0) {
      return jsonError(400, new Error('No managed keys provided'));
    }
    for (const [key, value] of Object.entries(updates)) {
      if (workspaceId) await setWorkspaceSecretValue(workspaceId, key, value, userId);
      else await setSettingValue(key, value);
    }
    const keys = await listManagedSecrets(workspaceId);
    return json({ data: { keys }, error: null });
  }
  if (req.method === 'POST' && pathname === '/backend/ai-chat') {
    const userId = await requireUserId(req);
    const blocked = rateLimitBlock(aiChatRateLimiter, userId || clientIpFromRequest(req));
    if (blocked) return blocked;
    return handleAiChat(req, userId);
  }

  return jsonError(404, new Error('Backend route not found'));
}

export default async function handler(req) {
  try {
    return await route(req);
  } catch (error) {
    return jsonError(error.status || 500, error);
  }
}

export const config = {
  path: '/backend/*',
};
