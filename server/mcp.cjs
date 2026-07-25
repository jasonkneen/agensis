'use strict';

const {
 assertConnectionChannel,
 connectionCanUseTool,
} = require('./flow-integration.cjs');
// tasks.depends_on is a native uuid[]. postgres.js `.unsafe(sql, params)` does
// NOT array-serialize a raw JS array bound to an untyped $n — it coerces with
// '' + value, producing `a,b` instead of `{a,b}`. Single-sourced from
// backend-core (same helper the generic /backend/db path uses).
const { toPgArrayLiteral } = require('../shared/backend-core.cjs');

// Native MCP (Model Context Protocol) server for agensis.
//
// Mirrors the hilos `/api/mcp` model: a single POST endpoint speaking stateless
// Streamable-HTTP JSON-RPC 2.0. Any MCP-capable CLI (Qwen, Claude Code, Codex)
// drops `{ url, Authorization: Bearer <agent connect token> }` into its config
// and becomes a first-class workspace teammate — NO agensis-agent daemon needed.
// The daemon (agent-cli) remains a separate, independent inbound path.
//
// Auth: the Bearer token is an agent connect token, resolved by the same
// `verifyAgentConnectToken` the WebSocket daemon path uses. The resolved agent's
// workspace is the ONLY workspace any tool can touch — scoping is enforced on
// every query, so an agent physically cannot reach another workspace.
//
// This module is deliberately decoupled from the server monolith: all backend
// capabilities are passed in via `deps` so it stays unit-testable with mocks.

const PROTOCOL_VERSION_DEFAULT = '2024-11-05';
const SERVER_NAME = 'agensis';

const SERVER_INSTRUCTIONS = [
 'You are connected to an agensis workspace as a named agent (see whoami).',
 'Collaborate with the team: read channels, post messages, and @mention',
 'teammates by handle. Use post_message to speak; use dispatch_agent when you',
 'want a message to actively wake mentioned/auto/direct agents into responding.',
 'All tools are scoped to your workspace. Docs, tasks, and workspace memory are',
 'shared with the whole team.',
 'Each chat has a right-side widget rail the human can see: when you work a',
 'multi-step task in a thread, use create_thread_item (kind "todo", "plan", or',
 '"blocker") with that channel session_id to surface your plan and to-dos, mark',
 'them done with update_thread_item as you go, and raise a "blocker" when you',
 'need the human to answer something (read their reply from the item response',
 'via list_thread_items). Keep it to a few real items, not every micro-step.',
].join(' ');

// --- small helpers ----------------------------------------------------------

function jsonrpcResult(id, result) {
 return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonrpcError(id, code, message, data) {
 const error = { code, message };
 if (data !== undefined) error.data = data;
 return { jsonrpc: '2.0', id: id ?? null, error };
}

// A tool's return value is rendered as a single text content part holding JSON.
function toolContent(value) {
 const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
 return { content: [{ type: 'text', text }] };
}

function toolError(message) {
 return { content: [{ type: 'text', text: String(message) }], isError: true };
}

class ToolError extends Error { }

function requireString(args, key) {
 const value = args && args[key];
 if (typeof value !== 'string' || !value.trim()) {
  throw new ToolError(`Missing required string argument: ${key}`);
 }
 return value.trim();
}

function optInt(value, fallback, max) {
 const n = Number(value);
 if (!Number.isFinite(n) || n <= 0) return fallback;
 return max ? Math.min(Math.floor(n), max) : Math.floor(n);
}

// Max parent links we will walk when checking for a cycle. Guards against an
// unbounded loop if the table ALREADY contains a cycle (written by some other
// path); a legitimate task tree is never this deep.
const MAX_TASK_DEPTH = 64;

// Resolve + validate a `parent_id` for task nesting. Never pass the caller's
// value straight into the INSERT/UPDATE:
//   - the parent must live in the SAME workspace. This surface is
//     workspace-scoped, so accepting a foreign parent would both leak the
//     existence of another tenant's task and hang our row off it.
//   - a task may not be its own parent, and may not be re-parented under one
//     of its own descendants. tasks.parent_id is ON DELETE CASCADE, so a cycle
//     is not cosmetic — it makes a subtree that can delete itself in a loop.
// `childId` is null on create (a brand-new row has no id and no descendants,
// so only the workspace check applies).
async function resolveParentTaskId(db, workspaceId, rawParentId, childId) {
 const parentId = String(rawParentId).trim();
 if (childId && parentId === childId) throw new ToolError('A task cannot be its own parent');
 const parent = await db.unsafe(
  'select id, parent_id from tasks where id = $1 and workspace_id = $2 limit 1',
  [parentId, workspaceId]);
 if (!parent[0]) throw new ToolError('Parent task not found in this workspace');
 if (childId) {
  let cursor = parent[0].parent_id ? String(parent[0].parent_id) : null;
  let hops = 0;
  while (cursor) {
   if (cursor === childId) {
    throw new ToolError('That parent would create a cycle in the task tree');
   }
   // FAIL CLOSED at the cap, never open. Exiting the walk quietly and accepting
   // the parent means a chain longer than MAX_TASK_DEPTH bypasses the cycle
   // check entirely — a 71-link chain slipped straight through the previous
   // `for (… hops < MAX_TASK_DEPTH)` form. Refusing is right either way: a
   // legitimate tree is never this deep, so hitting the cap means the table
   // already contains a cycle or something pathological, and parent_id is
   // ON DELETE CASCADE, so guessing wrong deletes a subtree.
   if (hops >= MAX_TASK_DEPTH) {
    throw new ToolError('Task tree is too deep to verify safely; re-parent higher up');
   }
   hops += 1;
   const next = await db.unsafe(
    'select parent_id from tasks where id = $1 and workspace_id = $2 limit 1',
    [cursor, workspaceId]);
   cursor = next[0] && next[0].parent_id ? String(next[0].parent_id) : null;
  }
 }
 return parentId;
}

// Parse an ISO-ish date argument. Callers hand us whatever their planner
// produced, so an unparseable value must be REFUSED, not silently stored as
// null (which is indistinguishable from "leave it alone") or as the string
// 'Invalid Date' (which postgres rejects mid-statement).
// Returns null when the caller did not supply the argument at all.
function optDateArg(args, key) {
 const raw = args && args[key];
 if (raw === undefined || raw === null) return null;
 if (typeof raw !== 'string' || !raw.trim()) return null;
 const value = raw.trim();
 const ms = Date.parse(value);
 if (!Number.isFinite(ms)) {
  throw new ToolError(`${key} is not a parseable date: ${value}`);
 }
 return new Date(ms).toISOString();
}

// tasks.depends_on is a native uuid[]. Reads come back as a JS array from
// postgres.js, but be tolerant of a raw PG array literal string so the cycle
// walk never iterates the CHARACTERS of '{a,b}'.
function normalizeDependsOn(value) {
 if (Array.isArray(value)) {
  return value.map((id) => String(id || '').trim()).filter(Boolean);
 }
 if (typeof value === 'string') {
  return value.replace(/^\{|\}$/g, '').split(',')
   .map((id) => id.replace(/^"|"$/g, '').trim())
   .filter(Boolean);
 }
 return [];
}

/**
 * Resolve + validate a `depends_on` list. Never pass the caller's value into
 * the write:
 *   - every id must be a task in the SAME workspace (this surface is
 *     workspace-scoped; a foreign id would leak another tenant's task id AND
 *     draw an arrow to a row that can never load),
 *   - a task may not depend on itself,
 *   - the list may not close a cycle. A cycle hangs any topological layout —
 *     the Gantt walks these edges to lay bars out.
 * `taskId` is null on create: a brand-new row has no id, so nothing can already
 * depend on it and only the existence check applies.
 */
async function resolveDependsOn(db, workspaceId, rawList, taskId) {
 if (!Array.isArray(rawList)) {
  throw new ToolError('depends_on must be an array of task ids');
 }
 const ids = [];
 for (const entry of rawList) {
  if (typeof entry !== 'string' || !entry.trim()) {
   throw new ToolError('depends_on must contain task id strings');
  }
  const id = entry.trim();
  if (taskId && id === taskId) throw new ToolError('A task cannot depend on itself');
  if (!ids.includes(id)) ids.push(id);
 }
 if (ids.length === 0) return [];

 // One read of the workspace's dependency edges: it both proves every id
 // exists here and gives us the graph to walk for cycles.
 const rows = await db.unsafe(
  'select id, depends_on from tasks where workspace_id = $1', [workspaceId]);
 const edges = new Map();
 for (const row of rows) edges.set(String(row.id), normalizeDependsOn(row.depends_on));
 for (const id of ids) {
  if (!edges.has(id)) throw new ToolError(`Dependency task not found in this workspace: ${id}`);
 }
 if (!taskId) return ids;

 // Walk FORWARD from each proposed dependency. Reaching taskId means taskId
 // already (transitively) blocks it, so making taskId depend on it closes a
 // loop. `seen` bounds the walk even if the stored graph already holds a cycle.
 const seen = new Set();
 const stack = ids.slice();
 while (stack.length > 0) {
  const current = stack.pop();
  if (current === taskId) {
   throw new ToolError('That dependency would create a cycle in the task graph');
  }
  if (seen.has(current)) continue;
  seen.add(current);
  for (const next of edges.get(current) || []) stack.push(next);
 }
 return ids;
}

// =============================================================================
// Tool definitions. Each tool: { name, description, inputSchema, run }.
// `run(args, ctx)` where ctx = { db, identity, deps }. Throw ToolError for
// caller-facing failures (surfaced as isError); other throws become -32603.
// `identity` = { agentId, workspaceId, name, handle, agent }.
// =============================================================================

function buildTools() {
 const tools = [];
 // A tool's `kinds` lists which identities may call it. Identity kinds:
 //   'agent'     — a per-agent connect token; you ARE that agent.
 //   'workspace' — the one workspace MCP token.
 //   'user'      — your agensis login.
 //   'invite'    — an invite link (auto-approve).
 // The last three authenticate INTO a workspace; you then register_agent to become an
 // agent. Default kinds = everything that can act in a workspace. Handler enforces it.
 const CONNECTED = ['agent', 'workspace', 'user', 'invite', 'integration'];
 const add = (def) => tools.push({ kinds: CONNECTED, ...def });

 // -- Identity & discovery --------------------------------------------------

 add({
  name: 'whoami',
  description: 'Return the identity this token authenticates as. kind="agent" means you ARE that agent. Otherwise you are connected to a workspace and must call register_agent to become an agent (new or existing), then work as it with claim_job.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, { identity }) {
   if (identity.kind !== 'agent') {
    return {
     kind: identity.kind,
     workspaceId: identity.workspaceId,
     name: identity.name,
     autoApprove: Boolean(identity.autoApprove),
     note: 'Call register_agent({ name } or { as: "<handle>" }) to become an agent. You get approved via a popup (or automatically if you joined via an invite link). Then poll claim_job to work as that agent — multiple clients can work as the same one.',
    };
   }
   const a = identity.agent || {};
   return {
    kind: 'agent',
    agentId: identity.agentId,
    name: identity.name,
    handle: identity.handle,
    workspaceId: identity.workspaceId,
    model: a.model || null,
    description: a.description || '',
   };
  },
 });

 add({
  name: 'list_channels',
  description: 'List the workspace channels (chat sessions) the agent can see. Returns id, title, folder, conversation_mode and last-activity time.',
  inputSchema: {
   type: 'object',
   properties: {
    limit: { type: 'integer', description: 'Max channels to return (default 50, max 200).' },
    include_archived: { type: 'boolean', description: 'Include archived channels (default false).' },
   },
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const limit = optInt(args?.limit, 50, 200);
   const includeArchived = args?.include_archived === true;
   if (identity.kind === 'integration' && identity.channelId) {
    const rows = await db.unsafe(
     `select id, title, folder, model, conversation_mode, participants, archived_at, updated_at
             from chat_sessions
            where workspace_id = $1 and id = $2 ${includeArchived ? '' : 'and archived_at is null'}
            limit 1`,
     [identity.workspaceId, identity.channelId],
    );
    return { channels: rows };
   }
   const rows = await db.unsafe(
    `select id, title, folder, model, conversation_mode, participants, archived_at, updated_at
           from chat_sessions
          where workspace_id = $1 ${includeArchived ? '' : 'and archived_at is null'}
          order by updated_at desc
          limit $2`,
    [identity.workspaceId, limit],
   );
   return { channels: rows };
  },
 });

 add({
  name: 'read_channel',
  description: 'Read recent messages from a channel (chat session). Returns messages oldest-first with sender info. Optionally read a thread by passing thread_parent_id.',
  inputSchema: {
   type: 'object',
   properties: {
    channel_id: { type: 'string', description: 'The chat session id (from list_channels).' },
    limit: { type: 'integer', description: 'Max messages (default 50, max 200).' },
    thread_parent_id: { type: 'string', description: 'If set, read the thread under this message id.' },
   },
   required: ['channel_id'],
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const channelId = requireString(args, 'channel_id');
   const limit = optInt(args?.limit, 50, 200);
   const threadParentId = typeof args?.thread_parent_id === 'string' && args.thread_parent_id.trim()
    ? args.thread_parent_id.trim() : null;
   await assertChannelInWorkspace(db, channelId, identity.workspaceId);
   const rows = threadParentId
    ? await db.unsafe(
     `select id, role, content, sender_kind, sender_id, sender_name, thread_parent_id, created_at
               from messages
              where session_id = $1 and (id = $2 or thread_parent_id = $2)
              order by created_at desc limit $3`,
     [channelId, threadParentId, limit],
    )
    : await db.unsafe(
     `select id, role, content, sender_kind, sender_id, sender_name, thread_parent_id, created_at
               from messages
              where session_id = $1 and thread_parent_id is null
              order by created_at desc limit $2`,
     [channelId, limit],
    );
   return { channel_id: channelId, messages: rows.reverse() };
  },
 });

 add({
  name: 'search_messages',
  description: 'Full-text-ish search across all channel messages in the workspace (case-insensitive substring). Returns matching messages with their channel id.',
  inputSchema: {
   type: 'object',
   properties: {
    query: { type: 'string', description: 'Substring to search for.' },
    limit: { type: 'integer', description: 'Max results (default 30, max 100).' },
   },
   required: ['query'],
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const query = requireString(args, 'query');
   const limit = optInt(args?.limit, 30, 100);
   const channelClause = identity.kind === 'integration' && identity.channelId
    ? 'and s.id = $3'
    : '';
   const params = identity.kind === 'integration' && identity.channelId
    ? [identity.workspaceId, `%${query}%`, identity.channelId, limit]
    : [identity.workspaceId, `%${query}%`, limit];
   const limitParam = identity.kind === 'integration' && identity.channelId ? '$4' : '$3';
   const rows = await db.unsafe(
    `select m.id, m.session_id, s.title as channel_title, m.role, m.content,
                m.sender_kind, m.sender_name, m.created_at
           from messages m
           join chat_sessions s on s.id = m.session_id
          where s.workspace_id = $1 and m.content ilike $2
            and m.deleted_at is null and s.deleted_at is null ${channelClause}
          order by m.created_at desc limit ${limitParam}`,
    params,
   );
   return { results: rows };
  },
 });

 add({
  name: 'list_members',
  description: 'List the human members of the workspace (owner + members) with their roles and emails.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, { db, identity }) {
   const rows = await db.unsafe(
    `select * from (
           select w.user_id as user_id, u.email as email, 'owner' as role, w.created_at as created_at
             from workspaces w join app_users u on u.id = w.user_id
            where w.id = $1
           union all
           select m.user_id, u.email, m.role, m.created_at
             from workspace_members m join app_users u on u.id = m.user_id
            where m.workspace_id = $1
         ) t order by (role = 'owner') desc, created_at asc`,
    [identity.workspaceId],
   );
   return { members: rows };
  },
 });

 add({
  name: 'list_agents',
  description: 'List the AI agents configured in the workspace (your teammates), with handle, name, description and model.',
  inputSchema: {
   type: 'object',
   properties: { include_disabled: { type: 'boolean', description: 'Include disabled agents (default false).' } },
   additionalProperties: false,
  },
  async run(args, { db, identity, deps }) {
   const rows = await db.unsafe(
    `select id, name, handle, description, model, enabled
           from workspace_agents where workspace_id = $1 order by created_at asc`,
    [identity.workspaceId],
   );
   const list = (args?.include_disabled === true ? rows : rows.filter((r) => r.enabled !== false))
    .map((r) => ({
     id: r.id,
     name: r.name,
     handle: r.handle || deps.slugHandle(r.name),
     description: r.description || '',
     model: r.model || null,
     enabled: r.enabled !== false,
    }));
   return { agents: list };
  },
 });

 // -- Messaging -------------------------------------------------------------

 add({
  name: 'post_message',
  kinds: ['agent', 'integration', 'workspace', 'user', 'invite'],
  description: 'Post a message into a channel as an agent. Pure "speak" — it does NOT trigger other agents to respond. Use dispatch_agent if you want @mentioned/direct/auto agents to act on it. A workspace/user/invite client MUST pass `as: "<handle>"` to choose which approved agent it speaks as.',
  inputSchema: {
   type: 'object',
   properties: {
    channel_id: { type: 'string', description: 'The chat session id to post into.' },
    content: { type: 'string', description: 'The message text (may include @handle mentions).' },
    thread_parent_id: { type: 'string', description: 'If set, post as a reply in that thread.' },
    as: { type: 'string', description: 'Agent handle to speak as (e.g. "forge"). Required for a workspace/user/invite client; ignored for a per-agent token.' },
   },
   required: ['channel_id', 'content'],
   additionalProperties: false,
  },
  async run(args, ctx) {
   const channelId = requireString(args, 'channel_id');
   const content = requireString(args, 'content');
   const threadParentId = typeof args?.thread_parent_id === 'string' && args.thread_parent_id.trim()
    ? args.thread_parent_id.trim() : null;
   const acting = ctx.identity.kind === 'agent' || ctx.identity.kind === 'integration'
    ? null : await resolveActingAgent(ctx.identity, ctx.deps, args?.as);
   const message = await insertAgentMessage(ctx, channelId, content, threadParentId, acting);
   return { posted: true, message };
  },
 });

 add({
  name: 'dispatch_agent',
  kinds: ['agent', 'integration', 'workspace', 'user', 'invite'],
  description: 'Post a message into a channel as an agent AND advance the conversation, so @mentioned, direct, or auto-mode agents respond. Use this to delegate work or ask a teammate. Returns immediately; replies arrive asynchronously. A workspace/user/invite client MUST pass `as: "<handle>"`.',
  inputSchema: {
   type: 'object',
   properties: {
    channel_id: { type: 'string', description: 'The chat session id to post into.' },
    content: { type: 'string', description: 'The message text. @mention a teammate (e.g. "@scout find X") to direct it.' },
    thread_parent_id: { type: 'string', description: 'If set, dispatch within that thread.' },
    as: { type: 'string', description: 'Agent handle to speak as (e.g. "forge"). Required for a workspace/user/invite client; ignored for a per-agent token.' },
   },
   required: ['channel_id', 'content'],
   additionalProperties: false,
  },
  async run(args, ctx) {
   const channelId = requireString(args, 'channel_id');
   const content = requireString(args, 'content');
   const threadParentId = typeof args?.thread_parent_id === 'string' && args.thread_parent_id.trim()
    ? args.thread_parent_id.trim() : null;
   const acting = ctx.identity.kind === 'agent' || ctx.identity.kind === 'integration'
    ? null : await resolveActingAgent(ctx.identity, ctx.deps, args?.as);
   const message = await insertAgentMessage(ctx, channelId, content, threadParentId, acting);
   // Fire-and-forget: the conversation advances in the background as each agent
   // message lands and streams over realtime. Awaiting would hold the HTTP
   // response open for the entire multi-turn chain. Mirrors the dispatch route.
   void ctx.deps.continueConversation({
    workspaceId: ctx.identity.workspaceId,
    sessionId: channelId,
    threadParentId,
   }).catch((err) => console.error('[mcp] continueConversation failed', err));
   return { dispatched: true, message };
  },
 });

 add({
  name: 'create_channel',
  description: 'Create a new channel (chat session) in the workspace. Returns the new channel.',
  inputSchema: {
   type: 'object',
   properties: {
    title: { type: 'string', description: 'Channel title.' },
    folder: { type: 'string', description: 'Folder to file it under (default "General").' },
    conversation_mode: { type: 'string', enum: ['mention', 'auto'], description: 'mention (default) or auto (agents may auto-interject).' },
   },
   required: ['title'],
   additionalProperties: false,
  },
  async run(args, { db, identity, deps }) {
   if (identity.kind === 'invite' && !deps.roleHasWorkspaceCapability(identity.role, 'write')) {
    throw new ToolError('This invite is read-only and cannot create channels');
   }
   const title = requireString(args, 'title');
   const folder = typeof args?.folder === 'string' && args.folder.trim() ? args.folder.trim() : 'General';
   const mode = args?.conversation_mode === 'auto' ? 'auto' : 'mention';
   const rows = await db.unsafe(
    `insert into chat_sessions (workspace_id, title, folder, conversation_mode)
         values ($1, $2, $3, $4) returning *`,
    [identity.workspaceId, title, folder, mode],
   );
   deps.notifyDbSubscribers('chat_sessions', 'INSERT', rows);
   return { channel: rows[0] };
  },
 });

 // -- Documents -------------------------------------------------------------

 add({
  name: 'list_docs',
  description: 'List documents in the workspace. Returns id, title, folder and last-updated time.',
  inputSchema: {
   type: 'object',
   properties: {
    folder: { type: 'string', description: 'Filter to a folder.' },
    limit: { type: 'integer', description: 'Max docs (default 50, max 200).' },
   },
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const limit = optInt(args?.limit, 50, 200);
   const folder = typeof args?.folder === 'string' && args.folder.trim() ? args.folder.trim() : null;
   const rows = folder
    ? await db.unsafe(
     `select id, title, folder, is_favorite, updated_at from documents
              where workspace_id = $1 and folder = $2 order by updated_at desc limit $3`,
     [identity.workspaceId, folder, limit])
    : await db.unsafe(
     `select id, title, folder, is_favorite, updated_at from documents
              where workspace_id = $1 order by updated_at desc limit $2`,
     [identity.workspaceId, limit]);
   return { documents: rows };
  },
 });

 add({
  name: 'read_doc',
  description: 'Read the full content of a document by id.',
  inputSchema: {
   type: 'object',
   properties: { doc_id: { type: 'string', description: 'The document id.' } },
   required: ['doc_id'],
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const docId = requireString(args, 'doc_id');
   const rows = await db.unsafe(
    `select id, title, content, folder, is_favorite, version, updated_at
           from documents where id = $1 and workspace_id = $2 limit 1`,
    [docId, identity.workspaceId]);
   if (!rows[0]) throw new ToolError('Document not found in this workspace');
   return { document: rows[0] };
  },
 });

 add({
  name: 'write_doc',
  description: 'Create a new document, or update an existing one when doc_id is supplied. Returns the saved document.',
  inputSchema: {
   type: 'object',
   properties: {
    doc_id: { type: 'string', description: 'Omit to create; supply to update an existing doc.' },
    title: { type: 'string', description: 'Document title (required when creating).' },
    content: { type: 'string', description: 'Document body (markdown/plain text).' },
    folder: { type: 'string', description: 'Folder (default "General" on create).' },
   },
   additionalProperties: false,
  },
  async run(args, { db, identity, deps }) {
   if (identity.kind === 'invite' && !deps.roleHasWorkspaceCapability(identity.role, 'write')) {
    throw new ToolError('This invite is read-only and cannot create or modify documents');
   }
   const docId = typeof args?.doc_id === 'string' && args.doc_id.trim() ? args.doc_id.trim() : null;
   const content = typeof args?.content === 'string' ? args.content : null;
   if (docId) {
    const existing = await db.unsafe(
     'select id from documents where id = $1 and workspace_id = $2 limit 1',
     [docId, identity.workspaceId]);
    if (!existing[0]) throw new ToolError('Document not found in this workspace');
    const rows = await db.unsafe(
     `update documents set
             title = coalesce($3, title),
             content = coalesce($4, content),
             folder = coalesce($5, folder),
             version = version + 1,
             updated_at = now()
           where id = $1 and workspace_id = $2 returning *`,
     [docId, identity.workspaceId,
      typeof args?.title === 'string' ? args.title : null,
      content,
      typeof args?.folder === 'string' && args.folder.trim() ? args.folder.trim() : null]);
    deps.notifyDbSubscribers('documents', 'UPDATE', rows);
    return { document: rows[0] };
   }
   const title = requireString(args, 'title');
   const folder = typeof args?.folder === 'string' && args.folder.trim() ? args.folder.trim() : 'General';
   const rows = await db.unsafe(
    `insert into documents (workspace_id, title, content, folder)
         values ($1, $2, $3, $4) returning *`,
    [identity.workspaceId, title, content || '', folder]);
   deps.notifyDbSubscribers('documents', 'INSERT', rows);
   return { document: rows[0] };
  },
 });

 add({
  name: 'search_docs',
  description: 'Search documents by title or content (case-insensitive substring).',
  inputSchema: {
   type: 'object',
   properties: {
    query: { type: 'string', description: 'Substring to match in title or content.' },
    limit: { type: 'integer', description: 'Max results (default 20, max 100).' },
   },
   required: ['query'],
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const query = requireString(args, 'query');
   const limit = optInt(args?.limit, 20, 100);
   const rows = await db.unsafe(
    `select id, title, folder, updated_at from documents
          where workspace_id = $1 and (title ilike $2 or content ilike $2)
          order by updated_at desc limit $3`,
    [identity.workspaceId, `%${query}%`, limit]);
   return { results: rows };
  },
 });

 // -- Tasks -----------------------------------------------------------------

 add({
  name: 'list_tasks',
  description: 'List tasks in the workspace, optionally filtered by status. Each row carries parent_id (null for a top-level task), so the task tree can be rebuilt from the result.',
  inputSchema: {
   type: 'object',
   properties: {
    status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'Filter by status.' },
    limit: { type: 'integer', description: 'Max tasks (default 50, max 200).' },
   },
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const limit = optInt(args?.limit, 50, 200);
   const status = typeof args?.status === 'string' ? args.status : null;
   const rows = status
    ? await db.unsafe(
     `select * from tasks where workspace_id = $1 and status = $2
              order by created_at desc limit $3`, [identity.workspaceId, status, limit])
    : await db.unsafe(
     `select * from tasks where workspace_id = $1
              order by created_at desc limit $2`, [identity.workspaceId, limit]);
   return { tasks: rows };
  },
 });

 add({
  name: 'create_task',
  description: 'Create a task in the workspace. Attributed to this agent (source_type=ai). Pass parent_id to nest it under an existing task instead of faking hierarchy in the title. Pass start_date/due_date so it appears as a real bar on the timeline, and depends_on to declare what must finish first instead of encoding an order in the title ("1..6").',
  inputSchema: {
   type: 'object',
   properties: {
    title: { type: 'string', description: 'Task title.' },
    description: { type: 'string', description: 'Task details.' },
    status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'Default "todo".' },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Default "normal".' },
    assignee_id: { type: 'string', description: 'User id to assign to (optional).' },
    start_date: { type: 'string', description: 'ISO8601 date work starts (optional). Without it the timeline can only draw an undated marker.' },
    due_date: { type: 'string', description: 'ISO8601 due date (optional).' },
    depends_on: {
     type: 'array',
     items: { type: 'string' },
     description: 'Task ids that must finish before this one. Must be tasks in this workspace.',
    },
    parent_id: { type: 'string', description: 'Id of the task this is a sub-task of (optional). Must be a task in this workspace.' },
   },
   required: ['title'],
   additionalProperties: false,
  },
  async run(args, { db, identity, deps }) {
   if (identity.kind === 'invite' && !deps.roleHasWorkspaceCapability(identity.role, 'write')) {
    throw new ToolError('This invite is read-only and cannot create tasks');
   }
   const title = requireString(args, 'title');
   const status = ['todo', 'in_progress', 'done', 'cancelled'].includes(args?.status) ? args.status : 'todo';
   const priority = ['low', 'normal', 'high', 'urgent'].includes(args?.priority) ? args.priority : 'normal';
   // Validated before the insert: a bad parent must not create an orphan row.
   const parentId = typeof args?.parent_id === 'string' && args.parent_id.trim()
    ? await resolveParentTaskId(db, identity.workspaceId, args.parent_id, null)
    : null;
   const startDate = optDateArg(args, 'start_date');
   const dueDate = optDateArg(args, 'due_date');
   // Same rule as the parent: validated BEFORE the insert, so a bad dependency
   // never lands as an edge pointing at nothing. `null` taskId = nothing can
   // depend on a row that does not exist yet, so no cycle is possible here.
   const dependsOn = args?.depends_on === undefined
    ? []
    : await resolveDependsOn(db, identity.workspaceId, args.depends_on, null);
   const rows = await db.unsafe(
    `insert into tasks (workspace_id, created_by, assignee_id, title, description, status, priority, due_date, source_type, source_id, parent_id, start_date, depends_on)
         values ($1, null, $2, $3, $4, $5, $6, $7, 'ai', $8, $9, $10, $11::uuid[]) returning *`,
    [identity.workspaceId,
    typeof args?.assignee_id === 'string' && args.assignee_id.trim() ? args.assignee_id.trim() : null,
     title,
    typeof args?.description === 'string' ? args.description : '',
     status, priority,
     dueDate,
    identity.agentId ? String(identity.agentId) : null,
     parentId,
     startDate,
    toPgArrayLiteral(dependsOn)]);
   deps.notifyDbSubscribers('tasks', 'INSERT', rows);
   return { task: rows[0] };
  },
 });

 add({
  name: 'update_task',
  description: 'Update an existing task (status, title, description, priority, assignee, start/due dates, dependencies, parent task). Set start_date + due_date so the task draws as a real span on the timeline, and depends_on to declare the order of a chain of work rather than numbering titles.',
  inputSchema: {
   type: 'object',
   properties: {
    task_id: { type: 'string', description: 'The task id.' },
    status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
    title: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    assignee_id: { type: 'string' },
    start_date: { type: 'string', description: 'ISO8601 date work starts.' },
    due_date: { type: 'string', description: 'ISO8601 due date.' },
    depends_on: {
     type: 'array',
     items: { type: 'string' },
     description: 'REPLACES this task\'s dependency list with these task ids (all must be tasks in this workspace). Pass [] to clear it. A list that would create a cycle is rejected.',
    },
    parent_id: { type: 'string', description: 'Re-parent this task under another task in this workspace. Pass "" to un-nest it back to top level.' },
   },
   required: ['task_id'],
   additionalProperties: false,
  },
  async run(args, { db, identity, deps }) {
   if (identity.kind === 'invite' && !deps.roleHasWorkspaceCapability(identity.role, 'write')) {
    throw new ToolError('This invite is read-only and cannot modify tasks');
   }
   const taskId = requireString(args, 'task_id');
   const existing = await db.unsafe(
    'select id, parent_id, assignee_id from tasks where id = $1 and workspace_id = $2 limit 1', [taskId, identity.workspaceId]);
   if (!existing[0]) throw new ToolError('Task not found in this workspace');
   const status = ['todo', 'in_progress', 'done', 'cancelled'].includes(args?.status) ? args.status : null;
   const priority = ['low', 'normal', 'high', 'urgent'].includes(args?.priority) ? args.priority : null;
   // parent_id can't ride the coalesce() pattern: null there means "leave
   // alone", but an explicit "" has to mean "un-nest to top level". Resolve the
   // final value here instead, using the row we already loaded.
   // Did the CALLER mention parent_id at all? If not we must not write the
   // column: sourcing it from `existing` (read moments ago) turns every
   // unrelated update_task into a read-modify-write that silently reverts a
   // concurrent re-parent. `case when $10 then $9 else parent_id end` below
   // leaves it to the row's own value at update time instead.
   const touchesParent = typeof args?.parent_id === 'string';
   const nextParentId = touchesParent
    ? (args.parent_id.trim()
     ? await resolveParentTaskId(db, identity.workspaceId, args.parent_id, taskId)
     : null)
    : null;
   // Dates are parsed (and REFUSED if unparseable) before the write. They ride
   // the coalesce() pattern like due_date always has: null = leave alone.
   const startDate = optDateArg(args, 'start_date');
   const dueDate = optDateArg(args, 'due_date');
   // depends_on needs the same "did the caller mention it?" guard parent_id
   // uses: [] must mean "clear the list", not "leave it alone". Validated
   // (existence + self + cycle) BEFORE the update, so a rejected list never
   // half-writes.
   const touchesDependsOn = args?.depends_on !== undefined;
   const nextDependsOn = touchesDependsOn
    ? await resolveDependsOn(db, identity.workspaceId, args.depends_on, taskId)
    : [];
   const rows = await db.unsafe(
    `update tasks set
           title = coalesce($3, title),
           description = coalesce($4, description),
           status = coalesce($5, status),
           priority = coalesce($6, priority),
           assignee_id = coalesce($7, assignee_id),
           due_date = coalesce($8, due_date),
           parent_id = case when $10 then $9 else parent_id end,
           start_date = coalesce($11, start_date),
           depends_on = case when $13 then $12::uuid[] else depends_on end,
           completed_at = case when $5 = 'done' then now() else completed_at end,
           version = version + 1,
           updated_at = now()
         where id = $1 and workspace_id = $2 returning *`,
    [taskId, identity.workspaceId,
     typeof args?.title === 'string' ? args.title : null,
     typeof args?.description === 'string' ? args.description : null,
     status, priority,
     typeof args?.assignee_id === 'string' && args.assignee_id.trim() ? args.assignee_id.trim() : null,
     dueDate,
     nextParentId, touchesParent,
     startDate,
     toPgArrayLiteral(nextDependsOn), touchesDependsOn]);
   deps.notifyDbSubscribers('tasks', 'UPDATE', rows);
   // Assigning a task to an agent dispatches it, exactly as it does from the UI.
   // `existing` was read BEFORE the write, so an agent re-writing the assignee it
   // already had (or updating only status/title as it works) never re-runs it.
   const nextAssigneeId = typeof args?.assignee_id === 'string' ? args.assignee_id.trim() : '';
   if (nextAssigneeId && String(existing[0].assignee_id || '') !== nextAssigneeId && deps.dispatchTaskAssignment) {
    void Promise.resolve(deps.dispatchTaskAssignment({
     workspaceId: identity.workspaceId,
     taskId,
     agentId: nextAssigneeId,
     actorName: identity.kind === 'agent' ? (identity.name || 'An agent') : null,
    })).catch(() => { });
   }
   return { task: rows[0] };
  },
 });

 // -- Thread widget items ---------------------------------------------------
 // Per-thread todo / plan / blocker items shown in the chat's widget rail.
 // Scoped to a specific channel session so they appear alongside that chat.
 add({
  name: 'create_thread_item',
  description: 'Add an item to a chat thread\'s widget rail: kind "todo" (a task for this thread), "plan" (a plan step), or "blocker" (a question the human must answer). Scoped to a channel session_id. Attributed to this agent.',
  inputSchema: {
   type: 'object',
   properties: {
    session_id: { type: 'string', description: 'The channel/thread session id these items belong to.' },
    kind: { type: 'string', enum: ['todo', 'plan', 'blocker'], description: 'Widget the item appears in.' },
    content: { type: 'string', description: 'The item text (e.g. the to-do, plan step, or the question to ask the human).' },
    message_id: { type: 'string', description: 'Optional message id to anchor this item to (clicking jumps there).' },
   },
   required: ['session_id', 'kind', 'content'],
   additionalProperties: false,
  },
  async run(args, { db, identity, deps }) {
   const sessionId = requireString(args, 'session_id');
   if (identity.kind === 'invite' && !deps.roleHasWorkspaceCapability(identity.role, 'write')) {
    throw new ToolError('This invite is read-only and cannot create thread items');
   }
   const content = requireString(args, 'content');
   const kind = ['todo', 'plan', 'blocker'].includes(args?.kind) ? args.kind : 'todo';
   await assertChannelInWorkspace(db, sessionId, identity.workspaceId);
   const ordRows = await db.unsafe(
    'select coalesce(max(order_index), 0) as m from thread_items where session_id = $1 and kind = $2',
    [sessionId, kind]);
   const nextOrder = Number(ordRows[0]?.m || 0) + 1;
   const rows = await db.unsafe(
    `insert into thread_items (workspace_id, session_id, kind, content, status, order_index, message_id, created_by_agent)
         values ($1, $2, $3, $4, 'open', $5, $6, $7) returning *`,
    [identity.workspaceId, sessionId, kind, content, nextOrder,
    typeof args?.message_id === 'string' && args.message_id.trim() ? args.message_id.trim() : null,
    identity.agentId ? String(identity.agentId) : null]);
   deps.notifyDbSubscribers('thread_items', 'INSERT', rows);
   return { item: rows[0] };
  },
 });

 add({
  name: 'update_thread_item',
  description: 'Update a thread widget item: change its content, mark it done (todo/plan), or dismiss a blocker. To read a human\'s answer to a blocker, fetch the item\'s response field.',
  inputSchema: {
   type: 'object',
   properties: {
    item_id: { type: 'string', description: 'The thread item id.' },
    content: { type: 'string' },
    status: { type: 'string', enum: ['open', 'done', 'answered', 'dismissed'] },
   },
   required: ['item_id'],
   additionalProperties: false,
  },
  async run(args, { db, identity, deps }) {
   const itemId = requireString(args, 'item_id');
   const existing = await db.unsafe(
    'select id, session_id from thread_items where id = $1 and workspace_id = $2 limit 1', [itemId, identity.workspaceId]);
   if (!existing[0]) throw new ToolError('Thread item not found in this workspace');
   if (identity.kind === 'integration' && identity.channelId) {
    try {
     assertConnectionChannel(identity, existing[0].session_id);
    } catch (err) {
     throw new ToolError(err.message);
    }
   }
   const status = ['open', 'done', 'answered', 'dismissed'].includes(args?.status) ? args.status : null;
   const rows = await db.unsafe(
    `update thread_items set
           content = coalesce($3, content),
           status = coalesce($4, status),
           updated_at = now()
         where id = $1 and workspace_id = $2 returning *`,
    [itemId, identity.workspaceId,
     typeof args?.content === 'string' ? args.content : null,
     status]);
   deps.notifyDbSubscribers('thread_items', 'UPDATE', rows);
   return { item: rows[0] };
  },
 });

 add({
  name: 'list_thread_items',
  description: 'List the widget-rail items for a chat thread (todo / plan / blocker). Use to check whether the human has answered a blocker (see each item\'s status and response).',
  inputSchema: {
   type: 'object',
   properties: {
    session_id: { type: 'string', description: 'The channel/thread session id.' },
    kind: { type: 'string', enum: ['todo', 'plan', 'blocker'], description: 'Optional filter by widget.' },
   },
   required: ['session_id'],
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const sessionId = requireString(args, 'session_id');
   await assertChannelInWorkspace(db, sessionId, identity.workspaceId);
   const kind = ['todo', 'plan', 'blocker'].includes(args?.kind) ? args.kind : null;
   const rows = kind
    ? await db.unsafe(
     'select * from thread_items where session_id = $1 and kind = $2 order by order_index asc',
     [sessionId, kind])
    : await db.unsafe(
     'select * from thread_items where session_id = $1 order by kind, order_index asc',
     [sessionId]);
   return { items: rows };
  },
 });

 // -- Workspace memory ------------------------------------------------------

 add({
  name: 'get_workspace_memory',
  description: 'Read shared workspace memory facts (team knowledge).',
  inputSchema: {
   type: 'object',
   properties: {
    category: { type: 'string', description: 'Filter by category.' },
    limit: { type: 'integer', description: 'Max facts (default 100, max 500).' },
   },
   additionalProperties: false,
  },
  async run(args, { db, identity }) {
   const limit = optInt(args?.limit, 100, 500);
   const category = typeof args?.category === 'string' && args.category.trim() ? args.category.trim() : null;
   const rows = category
    ? await db.unsafe(
     `select id, fact, category, updated_at from memory_facts
              where workspace_id = $1 and category = $2 order by updated_at desc limit $3`,
     [identity.workspaceId, category, limit])
    : await db.unsafe(
     `select id, fact, category, updated_at from memory_facts
              where workspace_id = $1 order by updated_at desc limit $2`,
     [identity.workspaceId, limit]);
   return { facts: rows };
  },
 });

 add({
  name: 'add_memory',
  description: 'Add a shared workspace memory fact (team knowledge other agents and humans will see).',
  inputSchema: {
   type: 'object',
   properties: {
    fact: { type: 'string', description: 'The fact to remember.' },
    category: { type: 'string', description: 'Category label (default "general").' },
   },
   required: ['fact'],
   additionalProperties: false,
  },
  async run(args, { db, identity, deps }) {
   if (identity.kind === 'invite' && !deps.roleHasWorkspaceCapability(identity.role, 'write')) {
    throw new ToolError('This invite is read-only and cannot add memory');
   }
   const fact = requireString(args, 'fact');
   const category = typeof args?.category === 'string' && args.category.trim() ? args.category.trim() : 'general';
   const rows = await db.unsafe(
    `insert into memory_facts (workspace_id, fact, category) values ($1, $2, $3) returning *`,
    [identity.workspaceId, fact, category]);
   deps.notifyDbSubscribers('memory_facts', 'INSERT', rows);
   return { fact: rows[0] };
  },
 });

 // --- register as an agent, then work AS it over MCP -----------------------
 // A connected client first calls register_agent (popup approval, or auto-approve via an
 // invite link). Once approved, it polls claim_job, generates the reply, and returns it
 // with submit_job_result (or fail_job). Multiple clients can work as the same agent —
 // they share its queue, whoever claims a job answers it.

 add({
  name: 'register_agent',
  kinds: ['workspace', 'user', 'invite'],
  description: 'Register this client as an agent — a brand new one (pass `name`/`handle`) or an existing one (pass `as: "<handle>"`). The workspace owner gets an approve popup; if you joined via an invite link it is auto-approved. Returns a registrationId and status — poll registration_status until "approved", then start claim_job. Call this once after connecting.',
  inputSchema: {
   type: 'object',
   properties: {
    as: { type: 'string', description: 'Existing agent handle to work as (e.g. "q"). Omit to create a new agent.' },
    name: { type: 'string', description: 'Display name for a NEW agent (e.g. "Cursor").' },
    handle: { type: 'string', description: 'Handle for a NEW agent (defaults from name).' },
    label: { type: 'string', description: 'Optional label for this client shown in the approval popup (e.g. "Cursor on laptop").' },
   },
   additionalProperties: false,
  },
  async run(args, { identity, deps }) {
   const asHandle = (typeof args?.as === 'string' && args.as.trim()) ? args.as.trim() : null;
   const name = (typeof args?.name === 'string' && args.name.trim()) ? args.name.trim() : null;
   const handle = (typeof args?.handle === 'string' && args.handle.trim()) ? args.handle.trim() : null;
   if (!asHandle && !name && !handle) throw new ToolError('Pass `as: "<handle>"` to work as an existing agent, or `name` to create a new one.');
   try {
    return await deps.registerAgentRequest({
     workspaceId: identity.workspaceId,
     asHandle, name, handle,
     clientLabel: (typeof args?.label === 'string' ? args.label : identity.name) || '',
     autoApprove: Boolean(identity.autoApprove),
    });
   } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(err && err.message ? err.message : 'register_agent failed');
   }
  },
 });

 add({
  name: 'registration_status',
  kinds: ['workspace', 'user', 'invite'],
  description: 'Check whether your register_agent request has been approved. Poll this until status is "approved" (or "denied"), then begin claim_job.',
  inputSchema: {
   type: 'object',
   properties: { registration_id: { type: 'string', description: 'The registrationId from register_agent.' } },
   required: ['registration_id'],
   additionalProperties: false,
  },
  async run(args, { identity, deps }) {
   const registrationId = requireString(args, 'registration_id');
   try {
    return await deps.getRegistrationStatus({ workspaceId: identity.workspaceId, registrationId });
   } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(err && err.message ? err.message : 'registration_status failed');
   }
  },
 });

 // Resolve which agent this caller is acting as → its id, or a clean ToolError. A
 // connected (non-agent) client may only work as an agent it has had approved.
 async function resolveActingAgent(identity, deps, asHandle) {
  if (identity.kind === 'agent') return { id: identity.agentId, name: identity.name };
  // F8: an invite bearer may only drive an agent when its role grants run_agents.
  if (identity.kind === 'invite' && !deps.roleHasWorkspaceCapability(identity.role, 'run_agents')) {
   throw new ToolError('This invite is read-only and cannot act as an agent');
  }
  const handle = (typeof asHandle === 'string' && asHandle.trim()) ? asHandle.trim() : null;
  if (!handle) throw new ToolError('Pass `as: "<agent handle>"` to choose which agent to work as (e.g. as: "q").');
  const agent = await deps.resolveWorkspaceAgentByHandle(identity.workspaceId, handle);
  if (!agent) throw new ToolError(`No agent "@${handle}" in this workspace.`);
  if (!agent.mcp_approved) throw new ToolError(`@${handle} has not been approved for MCP yet — call register_agent (as: "${handle}") and have it approved first.`);
  return { id: agent.id, name: agent.name };
 }
 // Back-compat shim for the job tools that only need the id.
 async function resolveActingAgentId(identity, deps, asHandle) {
  return (await resolveActingAgent(identity, deps, asHandle)).id;
 }

 add({
  name: 'claim_job',
  description: 'Pull the next queued turn for the agent you are working as, and mark it running. Returns { job: null } when nothing is queued — poll on a loop (every ~5–10s); polling also marks the agent "present" so the workspace routes @mentions to you. When you get a job, generate the agent\'s reply from job.prompt, then call submit_job_result (or fail_job).',
  inputSchema: {
   type: 'object',
   properties: {
    as: { type: 'string', description: 'Agent handle to work as (e.g. "q"). Required for an invite-link client; ignored for a per-agent token.' },
   },
   additionalProperties: false,
  },
  async run(args, { identity, deps }) {
   try {
    const agentId = await resolveActingAgentId(identity, deps, args?.as);
    const job = await deps.claimMcpJob({ workspaceId: identity.workspaceId, agentId });
    return { job: job || null };
   } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(err && err.message ? err.message : 'claim_job failed');
   }
  },
 });

 add({
  name: 'submit_job_result',
  description: 'Return a completed job\'s reply. Posts it into the channel as the agent and resumes the conversation. Call after generating the response for a job from claim_job.',
  inputSchema: {
   type: 'object',
   properties: {
    job_id: { type: 'string', description: 'The jobId from claim_job.' },
    response: { type: 'string', description: 'The agent\'s reply text to post.' },
    as: { type: 'string', description: 'Agent handle you are working as (invite-link clients). Ignored for a per-agent token.' },
   },
   required: ['job_id', 'response'],
   additionalProperties: false,
  },
  async run(args, { identity, deps }) {
   const jobId = requireString(args, 'job_id');
   const response = requireString(args, 'response');
   try {
    const agentId = await resolveActingAgentId(identity, deps, args?.as);
    return await deps.submitMcpJobResult({ workspaceId: identity.workspaceId, agentId, jobId, responseText: response });
   } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(err && err.message ? err.message : 'submit_job_result failed');
   }
  },
 });

 add({
  name: 'fail_job',
  description: 'Report that a job from claim_job could not be completed. Posts a short failure note as the agent and resumes the conversation so the chat does not hang.',
  inputSchema: {
   type: 'object',
   properties: {
    job_id: { type: 'string', description: 'The jobId from claim_job.' },
    error: { type: 'string', description: 'Short reason the job failed.' },
    as: { type: 'string', description: 'Agent handle you are working as (invite-link clients).' },
   },
   required: ['job_id'],
   additionalProperties: false,
  },
  async run(args, { identity, deps }) {
   const jobId = requireString(args, 'job_id');
   const error = (typeof args?.error === 'string' && args.error.trim()) ? args.error.trim() : 'the client could not complete the job';
   try {
    const agentId = await resolveActingAgentId(identity, deps, args?.as);
    return await deps.submitMcpJobResult({ workspaceId: identity.workspaceId, agentId, jobId, errorText: error });
   } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(err && err.message ? err.message : 'fail_job failed');
   }
  },
 });

 // Bootstrap an always-on runtime over MCP: instead of an interactive client
 // trying to hold the agent's connection itself (a turn-based client can't keep
 // claim_job presence alive, so DMs hang), it asks here for the daemon connect
 // command and launches it as a background process. The daemon then holds the
 // WebSocket, shows the agent as "Connected", and answers turns via `claude -p`.
 add({
  name: 'get_connect_command',
  // Minting a full-permission daemon token is a workspace-admin action. Exclude
  // 'invite' (a transient join secret must not be able to mint daemon tokens for
  // arbitrary agents or rotate a running daemon's token). Per-kind authorization
  // is enforced in run(): agent→self, user→manage role, workspace→owner-level.
  kinds: ['agent', 'workspace', 'user'],
  description: 'Get the daemon connect command for an agent so a host can launch an always-on runtime that backs it. Registering as an agent over MCP does NOT make it "connected" — only a running daemon does. Call this, then run the returned `command` as a long-running background process on the machine where the agent should execute; it holds the connection (the agent shows "Connected") and answers turns via `claude -p`. Returns the full `agensis connect …` command, a freshly-minted aga_ token (shown once), and the resolved model / permission settings. NOTE: this ROTATES the agent\'s connect token (restart any existing daemon with the new one) and sets the agent to daemon run-mode.',
  inputSchema: {
   type: 'object',
   properties: {
    as: { type: 'string', description: 'Handle of the agent to connect (e.g. "claude"). Required for a workspace/user/invite token; ignored for a per-agent token (which targets itself).' },
    model: { type: 'string', description: 'Override the model the daemon runs (default: the agent\'s configured model).' },
    permission_mode: { type: 'string', description: 'Daemon permission mode: "yolo" (full access, default), "accept_edits", or "default".' },
    base_url: { type: 'string', description: 'Override the backend --url the daemon connects to (default: the server\'s configured daemon base URL).' },
   },
   additionalProperties: false,
  },
  async run(args, { identity, deps }) {
   if (typeof deps.getAgentConnectionCommand !== 'function') {
    throw new ToolError('This server does not support get_connect_command.');
   }
   const targetHandle = (typeof args?.as === 'string' && args.as.trim()) ? args.as.trim() : null;
   try {
    let agentId;
    if (identity.kind === 'agent') {
     // A per-agent token may only bootstrap ITS OWN daemon (the "auth'd shoe-in").
     agentId = identity.agentId;
    } else {
     if (!targetHandle) throw new ToolError('Pass `as: "<agent handle>"` to choose which agent to connect (e.g. as: "claude").');
     // A user token must hold the manage role (mirrors the HTTP connection-command
     // route). The workspace MCP token is the owner-level control-plane secret —
     // it already gates agent creation and auto-approve — so it may target any
     // agent in its workspace without a per-user role lookup.
     if (identity.kind === 'user') {
      if (typeof deps.enforceWorkspaceRole !== 'function') throw new ToolError('Not permitted to mint a connect command.');
      await deps.enforceWorkspaceRole(identity.userId, identity.workspaceId, 'manage');
     }
     const agent = await deps.resolveWorkspaceAgentByHandle(identity.workspaceId, targetHandle);
     if (!agent) throw new ToolError(`No agent "@${targetHandle}" in this workspace.`);
     agentId = agent.id;
    }
    const payload = await deps.getAgentConnectionCommand({
     agentId,
     workspaceId: identity.workspaceId,
     handle: targetHandle,
     model: (typeof args?.model === 'string' && args.model.trim()) ? args.model.trim() : null,
     permissionMode: (typeof args?.permission_mode === 'string' && args.permission_mode.trim()) ? args.permission_mode.trim() : null,
     baseUrl: (typeof args?.base_url === 'string' && args.base_url.trim()) ? args.base_url.trim() : null,
    });
    return {
     ...payload,
     instructions: [
      `Run "command" on the machine where @${payload.handle} should execute, as a long-running background process — it must keep running to stay connected.`,
      'While it runs, the daemon holds the connection (the agent shows "Connected") and answers each turn via `claude -p`.',
      'The token is shown once and replaces any previous one; if another daemon is already running for this agent, restart it with this command.',
     ],
    };
   } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(err && err.message ? err.message : 'get_connect_command failed');
   }
  },
 });

 return tools;
}

// --- shared tool internals --------------------------------------------------

async function assertChannelInWorkspace(db, channelId, workspaceId) {
 const rows = await db.unsafe(
  'select id from chat_sessions where id = $1 and workspace_id = $2 limit 1',
  [channelId, workspaceId]);
 if (!rows[0]) throw new ToolError('Channel not found in this workspace');
}

async function insertAgentMessage(ctx, channelId, content, threadParentId, actingAgent = null) {
 const { db, identity, deps } = ctx;
 await assertChannelInWorkspace(db, channelId, identity.workspaceId);
 // When a non-agent client (workspace/user/invite) speaks via `as: "<handle>"`,
 // the message must be attributed to that resolved agent, not the raw token —
 // otherwise a workspace-token client could never post AS an agent (the reason
 // post_message/dispatch_agent were unreachable for standard MCP clients).
 const senderKind = identity.kind === 'integration' ? 'integration' : 'agent';
 const senderId = actingAgent
  ? String(actingAgent.id)
  : identity.kind === 'integration'
   ? String(identity.connectionId || '')
   : (identity.agentId ? String(identity.agentId) : null);
 const senderName = actingAgent ? actingAgent.name : identity.name;
 const rows = await db.unsafe(
  `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
     values ($1, 'assistant', $2, $3, $4, $5, $6) returning *`,
  [channelId, content, threadParentId || null, senderKind, senderId, senderName]);
 deps.notifyDbSubscribers('messages', 'INSERT', rows);
 await db.unsafe('update chat_sessions set updated_at = now() where id = $1', [channelId]).catch(() => { });
 return rows[0];
}

// =============================================================================
// JSON-RPC dispatch
// =============================================================================

function createMcpHandler(deps) {
 const {
  getDb,
  verifyMcpToken,
  rateLimiter,
  rateLimitBlocked,
  runtimeSchemaReady,
  serverVersion = '1.0.0',
 } = deps;

 const TOOLS = buildTools();
 const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

 function toolsForIdentity(identity) {
  return TOOLS.filter((tool) => {
   const kinds = tool.kinds || ['agent', 'invite'];
   return kinds.includes(identity.kind) && connectionCanUseTool(identity, tool.name);
  });
 }

 async function handleOne(rpc, identity) {
  const id = rpc && Object.prototype.hasOwnProperty.call(rpc, 'id') ? rpc.id : undefined;
  const isNotification = id === undefined;
  const method = rpc && rpc.method;

  if (!rpc || rpc.jsonrpc !== '2.0' || typeof method !== 'string') {
   return isNotification ? null : jsonrpcError(id, -32600, 'Invalid Request');
  }

  // Notifications never get a response.
  if (method.startsWith('notifications/')) return null;

  switch (method) {
   case 'initialize': {
    const requested = rpc.params && rpc.params.protocolVersion;
    const protocolVersion = (typeof requested === 'string' && requested) ? requested : PROTOCOL_VERSION_DEFAULT;
    return jsonrpcResult(id, {
     protocolVersion,
     capabilities: { tools: { listChanged: false } },
     serverInfo: { name: SERVER_NAME, version: serverVersion },
     instructions: SERVER_INSTRUCTIONS,
    });
   }
   case 'ping':
    return jsonrpcResult(id, {});
   case 'tools/list':
    return jsonrpcResult(id, {
     tools: toolsForIdentity(identity).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
     })),
    });
   case 'resources/list':
    return jsonrpcResult(id, { resources: [] });
   case 'prompts/list':
    return jsonrpcResult(id, { prompts: [] });
   case 'tools/call': {
    const params = rpc.params || {};
    const tool = TOOL_MAP.get(params.name);
    if (!tool) return jsonrpcResult(id, toolError(`Unknown tool: ${params.name}`));
    const kinds = tool.kinds || ['agent', 'invite'];
    if (!kinds.includes(identity.kind)) {
     return jsonrpcResult(id, toolError(`Tool "${tool.name}" is not available for a ${identity.kind} token.`));
    }
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (!connectionCanUseTool(identity, tool.name)) {
     return jsonrpcResult(id, toolError(`Tool "${tool.name}" is outside this connection's granted scopes.`));
    }
    if (identity.kind === 'integration' && identity.channelId) {
     const requestedChannelId = args.channel_id || args.session_id || null;
     if (requestedChannelId) {
      try {
       assertConnectionChannel(identity, requestedChannelId);
      } catch (err) {
       return jsonrpcResult(id, toolError(err.message));
      }
     }
    }
    try {
     const value = await tool.run(args, { db: getDb(), identity, deps });
     return jsonrpcResult(id, toolContent(value));
    } catch (err) {
     if (err instanceof ToolError) return jsonrpcResult(id, toolError(err.message));
     console.error('[mcp] tool execution error', tool.name, err);
     return jsonrpcResult(id, toolError(`Internal error executing ${tool.name}: ${err.message || err}`));
    }
   }
   default:
    return isNotification ? null : jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
 }

 return async function mcpHandler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
   if (runtimeSchemaReady) await runtimeSchemaReady;

   // Auth: Bearer = an agent connect token OR a workspace invite token. Required.
   const header = req.headers['authorization'] || '';
   const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
   const identity = token ? await verifyMcpToken(token, req) : null;
   if (!identity) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="agensis-mcp"');
    return res.status(401).json(jsonrpcError(null, -32001, 'Unauthorized: valid agent or invite Bearer token required'));
   }

   const rateKey = identity.agentId || identity.inviteId || identity.workspaceId;
   if (rateLimiter && rateLimitBlocked && rateLimitBlocked(res, rateLimiter, `mcp:${rateKey}`)) return;

   const body = req.body;
   if (Array.isArray(body)) {
    const responses = [];
    for (const rpc of body) {
     const r = await handleOne(rpc, identity);
     if (r) responses.push(r);
    }
    // All notifications -> 202 with no body, per JSON-RPC.
    if (responses.length === 0) return res.status(202).end();
    return res.json(responses);
   }

   const response = await handleOne(body, identity);
   if (!response) return res.status(202).end();
   return res.json(response);
  } catch (err) {
   console.error('[mcp] handler error', err);
   return res.status(500).json(jsonrpcError(null, -32603, `Internal error: ${err.message || err}`));
  }
 };
}

// Public, side-effect-free summary of the tool surface. Used by the skill/
// marketplace endpoints (server/skills.cjs) so the SKILL.md tool table and the
// copyable agent prompt derive from the SAME source as the live MCP server and
// can never drift when a tool is added or renamed.
function listToolSummaries() {
 return buildTools().map((t) => ({ name: t.name, description: t.description }));
}

module.exports = {
 createMcpHandler,
 listToolSummaries,
 SERVER_INSTRUCTIONS,
 SERVER_NAME,
 __test: { buildTools, ToolError },
};
