const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cors = require('cors');
const postgres = require('postgres');
const { WebSocketServer } = require('ws');

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
  'activity_events',
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
  'task_comments', 'document_versions', 'workspace_agents', 'activity_events',
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

function getDatabaseUrl() {
  loadEnvFile();
  return process.env.DATABASE_URL;
}

function getAnthropicApiKey() {
  // DB-stored key first (set via Settings → Secret keys), env var as fallback.
  return resolveSecret('ANTHROPIC_API_KEY');
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

function buildSystemPrompt(memory, documents, workspaceContext, agentContext) {
  const sections = [];
  if (agentContext && (agentContext.systemPrompt || agentContext.name)) {
    if (agentContext.name) {
      sections.push(`You are "${agentContext.name}", an AI agent collaborating in a shared Hatch workspace.`);
    }
    if (agentContext.systemPrompt) {
      sections.push(agentContext.systemPrompt);
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

function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/backend/ws' });

  wss.on('connection', (ws) => {
    ws.subscriptions = [];
    websocketClients.add(ws);

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw || '{}'));
        if (message.action === 'subscribe') {
          const binding = { channel: message.channel, ...(message.binding || {}) };
          const exists = (ws.subscriptions || []).some((subscription) => JSON.stringify(subscription) === JSON.stringify(binding));
          if (!exists) {
            ws.subscriptions.push(binding);
          }
          return;
        }
        if (message.action === 'unsubscribe') {
          ws.subscriptions = (ws.subscriptions || []).filter((subscription) => subscription.channel !== message.channel);
          return;
        }
        if (message.action === 'broadcast') {
          relayBroadcast(message.channel, message.event, message.payload);
        }
      } catch {
        // ignore malformed messages
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
  app.use(express.json({ limit: '2mb' }));

  // Authentication gate for all data, AI, settings and rpc endpoints. Public
  // routes (/backend/auth/*, /backend/health) are mounted without it.
  app.use('/backend/db', requireAuth);
  app.use('/backend/ai-chat', requireAuth);
  app.use('/backend/settings', requireAuth);
  app.use('/backend/rpc', requireAuth);

  app.get('/backend/health', async (_req, res) => {
    try {
      await getDb().unsafe('select 1');
      res.json({ ok: true });
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

  app.post('/backend/rpc/lookup_user_by_email', async (req, res) => {
    try {
      const lookupEmail = String(req.body?.lookup_email || '').trim().toLowerCase();
      const rows = await getDb().unsafe('select id, email from app_users where email = $1 limit 1', [lookupEmail]);
      res.json({ data: rows, error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/db/select', async (req, res) => {
    try {
      const { table, columns = '*', filters = [], orderBy = null, limit = null, single = false } = req.body || {};
      const tableSql = ensureTable(table);
      await enforceWorkspaceAccess(req.userId, table, { filters });
      const { clause, params } = buildWhereClause(filters, []);
      const rows = await getDb().unsafe(`select ${normalizeColumns(columns)} from ${tableSql}${clause}${buildOrderClause(orderBy)}${Number.isInteger(limit) ? ` LIMIT ${Number(limit)}` : ''}`, params);
      res.json({ data: single ? (rows[0] ?? null) : rows, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/db/insert', async (req, res) => {
    try {
      const { table, values, returning = '*', single = false } = req.body || {};
      const tableSql = ensureTable(table);
      const rows = Array.isArray(values) ? values : [values];
      if (!rows[0] || typeof rows[0] !== 'object') return jsonError(res, 400, new Error('Insert values are required'));
      for (const row of rows) {
        await enforceWorkspaceAccess(req.userId, table, { values: row });
      }

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

  app.post('/backend/db/update', async (req, res) => {
    try {
      const { table, values, filters = [], returning = '*', single = false } = req.body || {};
      const tableSql = ensureTable(table);
      if (!values || typeof values !== 'object') return jsonError(res, 400, new Error('Update values are required'));
      await enforceWorkspaceAccess(req.userId, table, { filters });

      const params = [];
      const setClause = Object.keys(values).map((column) => {
        params.push(values[column] ?? null);
        return `${quoteIdent(column)} = $${params.length}`;
      }).join(', ');
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

  app.post('/backend/db/delete', async (req, res) => {
    try {
      const { table, filters = [], single = false } = req.body || {};
      const tableSql = ensureTable(table);
      // Refuse an unfiltered delete — it would wipe the entire table.
      if (!Array.isArray(filters) || filters.length === 0) {
        return jsonError(res, 400, new Error('Delete requires at least one filter'));
      }
      await enforceWorkspaceAccess(req.userId, table, { filters });
      const where = buildWhereClause(filters, []);
      if (!where.clause) {
        return jsonError(res, 400, new Error('Delete requires a non-empty where clause'));
      }
      const result = await getDb().unsafe(`delete from ${tableSql}${where.clause} returning *`, where.params);
      notifyDbSubscribers(table, 'DELETE', result);
      res.json({ data: single ? (result[0] ?? null) : null, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.get('/backend/settings/secrets', async (req, res) => {
    try {
      const keys = await listManagedSecrets();
      res.json({ data: { keys }, error: null });
    } catch (error) {
      jsonError(res, 500, error);
    }
  });

  app.post('/backend/settings/secrets', async (req, res) => {
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

  app.post('/backend/ai-chat', async (req, res) => {
    try {
      const apiKey = await getAnthropicApiKey();
      if (!apiKey) return jsonError(res, 503, new Error('ANTHROPIC_API_KEY is not configured'));

      const { messages, model, memory, documents, workspaceContext, agentContext } = req.body || {};
      const resolvedModel = !model || model === 'auto'
        ? 'claude-opus-4-5'
        : model === 'claude-opus-4-6'
          ? 'claude-opus-4-5'
          : model === 'claude-sonnet-4-6'
            ? 'claude-sonnet-4-5'
            : model === 'claude-haiku-4-5'
              ? 'claude-haiku-4-5'
              : 'claude-opus-4-5';

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
