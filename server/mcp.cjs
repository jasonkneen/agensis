'use strict';

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

class ToolError extends Error {}

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
  const CONNECTED = ['agent', 'workspace', 'user', 'invite'];
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
      const rows = await db.unsafe(
        `select m.id, m.session_id, s.title as channel_title, m.role, m.content,
                m.sender_kind, m.sender_name, m.created_at
           from messages m
           join chat_sessions s on s.id = m.session_id
          where s.workspace_id = $1 and m.content ilike $2
          order by m.created_at desc limit $3`,
        [identity.workspaceId, `%${query}%`, limit],
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
    kinds: ['agent'],
    description: 'Post a message into a channel as this agent. Pure "speak" — it does NOT trigger other agents to respond. Use dispatch_agent if you want @mentioned/direct/auto agents to act on it.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The chat session id to post into.' },
        content: { type: 'string', description: 'The message text (may include @handle mentions).' },
        thread_parent_id: { type: 'string', description: 'If set, post as a reply in that thread.' },
      },
      required: ['channel_id', 'content'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const channelId = requireString(args, 'channel_id');
      const content = requireString(args, 'content');
      const threadParentId = typeof args?.thread_parent_id === 'string' && args.thread_parent_id.trim()
        ? args.thread_parent_id.trim() : null;
      const message = await insertAgentMessage(ctx, channelId, content, threadParentId);
      return { posted: true, message };
    },
  });

  add({
    name: 'dispatch_agent',
    kinds: ['agent'],
    description: 'Post a message into a channel as this agent AND advance the conversation, so @mentioned, direct, or auto-mode agents respond. Use this to delegate work or ask a teammate. Returns immediately; replies arrive asynchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The chat session id to post into.' },
        content: { type: 'string', description: 'The message text. @mention a teammate (e.g. "@scout find X") to direct it.' },
        thread_parent_id: { type: 'string', description: 'If set, dispatch within that thread.' },
      },
      required: ['channel_id', 'content'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const channelId = requireString(args, 'channel_id');
      const content = requireString(args, 'content');
      const threadParentId = typeof args?.thread_parent_id === 'string' && args.thread_parent_id.trim()
        ? args.thread_parent_id.trim() : null;
      const message = await insertAgentMessage(ctx, channelId, content, threadParentId);
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
    description: 'List tasks in the workspace, optionally filtered by status.',
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
    description: 'Create a task in the workspace. Attributed to this agent (source_type=ai).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title.' },
        description: { type: 'string', description: 'Task details.' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'Default "todo".' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Default "normal".' },
        assignee_id: { type: 'string', description: 'User id to assign to (optional).' },
        due_date: { type: 'string', description: 'ISO8601 due date (optional).' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    async run(args, { db, identity, deps }) {
      const title = requireString(args, 'title');
      const status = ['todo', 'in_progress', 'done', 'cancelled'].includes(args?.status) ? args.status : 'todo';
      const priority = ['low', 'normal', 'high', 'urgent'].includes(args?.priority) ? args.priority : 'normal';
      const rows = await db.unsafe(
        `insert into tasks (workspace_id, created_by, assignee_id, title, description, status, priority, due_date, source_type, source_id)
         values ($1, null, $2, $3, $4, $5, $6, $7, 'ai', $8) returning *`,
        [identity.workspaceId,
         typeof args?.assignee_id === 'string' && args.assignee_id.trim() ? args.assignee_id.trim() : null,
         title,
         typeof args?.description === 'string' ? args.description : '',
         status, priority,
         typeof args?.due_date === 'string' && args.due_date.trim() ? args.due_date.trim() : null,
         String(identity.agentId)]);
      deps.notifyDbSubscribers('tasks', 'INSERT', rows);
      return { task: rows[0] };
    },
  });

  add({
    name: 'update_task',
    description: 'Update an existing task (status, title, description, priority, assignee, due date).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task id.' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        assignee_id: { type: 'string' },
        due_date: { type: 'string', description: 'ISO8601 due date.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    async run(args, { db, identity, deps }) {
      const taskId = requireString(args, 'task_id');
      const existing = await db.unsafe(
        'select id from tasks where id = $1 and workspace_id = $2 limit 1', [taskId, identity.workspaceId]);
      if (!existing[0]) throw new ToolError('Task not found in this workspace');
      const status = ['todo', 'in_progress', 'done', 'cancelled'].includes(args?.status) ? args.status : null;
      const priority = ['low', 'normal', 'high', 'urgent'].includes(args?.priority) ? args.priority : null;
      const rows = await db.unsafe(
        `update tasks set
           title = coalesce($3, title),
           description = coalesce($4, description),
           status = coalesce($5, status),
           priority = coalesce($6, priority),
           assignee_id = coalesce($7, assignee_id),
           due_date = coalesce($8, due_date),
           completed_at = case when $5 = 'done' then now() else completed_at end,
           version = version + 1,
           updated_at = now()
         where id = $1 and workspace_id = $2 returning *`,
        [taskId, identity.workspaceId,
         typeof args?.title === 'string' ? args.title : null,
         typeof args?.description === 'string' ? args.description : null,
         status, priority,
         typeof args?.assignee_id === 'string' && args.assignee_id.trim() ? args.assignee_id.trim() : null,
         typeof args?.due_date === 'string' && args.due_date.trim() ? args.due_date.trim() : null]);
      deps.notifyDbSubscribers('tasks', 'UPDATE', rows);
      return { task: rows[0] };
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
  async function resolveActingAgentId(identity, deps, asHandle) {
    if (identity.kind === 'agent') return identity.agentId;
    const handle = (typeof asHandle === 'string' && asHandle.trim()) ? asHandle.trim() : null;
    if (!handle) throw new ToolError('Pass `as: "<agent handle>"` to choose which agent to work as (e.g. as: "q").');
    const agent = await deps.resolveWorkspaceAgentByHandle(identity.workspaceId, handle);
    if (!agent) throw new ToolError(`No agent "@${handle}" in this workspace.`);
    if (!agent.mcp_approved) throw new ToolError(`@${handle} has not been approved for MCP yet — call register_agent (as: "${handle}") and have it approved first.`);
    return agent.id;
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

  return tools;
}

// --- shared tool internals --------------------------------------------------

async function assertChannelInWorkspace(db, channelId, workspaceId) {
  const rows = await db.unsafe(
    'select id from chat_sessions where id = $1 and workspace_id = $2 limit 1',
    [channelId, workspaceId]);
  if (!rows[0]) throw new ToolError('Channel not found in this workspace');
}

async function insertAgentMessage(ctx, channelId, content, threadParentId) {
  const { db, identity, deps } = ctx;
  await assertChannelInWorkspace(db, channelId, identity.workspaceId);
  const rows = await db.unsafe(
    `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
     values ($1, 'assistant', $2, $3, 'agent', $4, $5) returning *`,
    [channelId, content, threadParentId || null, String(identity.agentId), identity.name]);
  deps.notifyDbSubscribers('messages', 'INSERT', rows);
  await db.unsafe('update chat_sessions set updated_at = now() where id = $1', [channelId]).catch(() => {});
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
  const TOOL_LIST = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

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
        return jsonrpcResult(id, { tools: TOOL_LIST });
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
