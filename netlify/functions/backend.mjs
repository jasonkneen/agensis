import crypto from 'node:crypto';
import { getDatabase } from '@netlify/database';

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

const MANAGED_SECRET_KEYS = ['ANTHROPIC_API_KEY'];
let database;

function dbPool() {
  if (!database) database = getDatabase();
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
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
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

async function handleAuth(pathname, req) {
  const body = await readBody(req);
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!email || !password) return jsonError(400, new Error('Email and password are required'));

  if (pathname === '/backend/auth/signup') {
    if (password.length < 6) return jsonError(400, new Error('Password must be at least 6 characters'));
    const existing = await query('select id from app_users where email = $1 limit 1', [email]);
    if (existing.length > 0) return jsonError(409, new Error('An account with that email already exists'));

    const rows = await query(
      'insert into app_users (email, password_hash) values ($1, $2) returning id, email, created_at',
      [email, createPasswordHash(password)],
    );
    return json({ data: { user: rows[0] }, error: null });
  }

  const rows = await query('select id, email, password_hash, created_at from app_users where email = $1 limit 1', [email]);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return jsonError(401, new Error('Invalid email or password'));
  }
  return json({ data: { user: { id: user.id, email: user.email, created_at: user.created_at } }, error: null });
}

async function handleDb(pathname, req) {
  const body = await readBody(req);

  if (pathname === '/backend/db/select') {
    const { table, columns = '*', filters = [], orderBy = null, limit = null, single = false } = body || {};
    const tableSql = ensureTable(table);
    const { clause, params } = buildWhereClause(filters, []);
    const limitSql = Number.isInteger(limit) ? ` LIMIT ${Number(limit)}` : '';
    const rows = await query(`select ${normalizeColumns(columns)} from ${tableSql}${clause}${buildOrderClause(orderBy)}${limitSql}`, params);
    return json({ data: single ? (rows[0] ?? null) : rows, error: null });
  }

  if (pathname === '/backend/db/insert') {
    const { table, values, returning = '*', single = false } = body || {};
    const tableSql = ensureTable(table);
    const rows = Array.isArray(values) ? values : [values];
    if (!rows[0] || typeof rows[0] !== 'object') return jsonError(400, new Error('Insert values are required'));

    const columns = Object.keys(rows[0]);
    const params = [];
    const valueSql = rows.map((row) => `(${columns.map((column) => {
      params.push(row[column] ?? null);
      return `$${params.length}`;
    }).join(', ')})`).join(', ');

    const result = await query(
      `insert into ${tableSql} (${columns.map(quoteIdent).join(', ')}) values ${valueSql} returning ${normalizeColumns(returning)}`,
      params,
    );
    return json({ data: single ? (result[0] ?? null) : result, error: null });
  }

  if (pathname === '/backend/db/update') {
    const { table, values, filters = [], returning = '*', single = false } = body || {};
    const tableSql = ensureTable(table);
    if (!values || typeof values !== 'object') return jsonError(400, new Error('Update values are required'));

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
    const result = await query(
      `update ${tableSql} set ${setClause}${where.clause} returning ${normalizeColumns(returning)}`,
      where.params,
    );
    return json({ data: single ? (result[0] ?? null) : result, error: null });
  }

  if (pathname === '/backend/db/delete') {
    const { table, filters = [], single = false } = body || {};
    const tableSql = ensureTable(table);
    const where = buildWhereClause(filters, []);
    const result = await query(`delete from ${tableSql}${where.clause} returning *`, where.params);
    return json({ data: single ? (result[0] ?? null) : null, error: null });
  }

  return jsonError(404, new Error('Backend route not found'));
}

async function handleAiChat(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return jsonError(503, new Error('ANTHROPIC_API_KEY is not configured'));

  const { messages, model, memory, documents, workspaceContext } = await readBody(req);
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
  if (req.method === 'POST' && (pathname === '/backend/auth/signup' || pathname === '/backend/auth/signin')) {
    return handleAuth(pathname, req);
  }
  if (req.method === 'POST' && pathname === '/backend/rpc/lookup_user_by_email') {
    const body = await readBody(req);
    const lookupEmail = String(body?.lookup_email || '').trim().toLowerCase();
    const rows = await query('select id, email from app_users where email = $1 limit 1', [lookupEmail]);
    return json({ data: rows, error: null });
  }
  if (req.method === 'POST' && pathname.startsWith('/backend/db/')) {
    return handleDb(pathname, req);
  }
  if (req.method === 'GET' && pathname === '/backend/settings/secrets') {
    const keys = MANAGED_SECRET_KEYS.map((key) => ({ key, configured: !!process.env[key], preview: process.env[key] ? 'configured' : '' }));
    return json({ data: { keys }, error: null });
  }
  if (req.method === 'POST' && pathname === '/backend/settings/secrets') {
    return jsonError(501, new Error('Secrets must be configured in Netlify environment variables'));
  }
  if (req.method === 'POST' && pathname === '/backend/ai-chat') {
    return handleAiChat(req);
  }

  return jsonError(404, new Error('Backend route not found'));
}

export default async function handler(req) {
  try {
    return await route(req);
  } catch (error) {
    return jsonError(500, error);
  }
}

export const config = {
  path: '/backend/*',
};
