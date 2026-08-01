'use strict';

const { settleSessionClosure } = require('../shared/session-close.cjs');
const { createSessionSplit } = require('../shared/session-split.cjs');
const { applySessionClosureRuntimeEffects } = require('./session-close-runtime.cjs');

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Per-workspace reads that do not belong to a bigger surface: usage totals, the
// bootstrap payload, a session's messages, and the one-shot connect setup.
//
// The bootstrap select lists its columns EXPLICITLY. That is not style: a column
// added to chat_sessions and forgotten here loads as undefined rather than
// erroring, and the UI silently renders a blank. This repo has shipped that bug
// more than once (canvas_id on sessions, metadata on agents).

function mountSessionsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, forbidden, enforceWorkspaceRole, enforceSessionRead, sessionReadableSql, getDb,
  notifyDbSubscribers, isPrivateSessionRow, redactDeletedMessageRows,
  recordAudit, cancelBuiltinJob, sendToConnection, scheduleTaskQueueDrain, endHuddleRoom,
  buildAgentConnectionCommand, buildWorkspaceBootstrap,
  ensurePrimaryDaemonAgent, normalizeAgentBackendBaseUrl, requestBaseUrl,
  resolveSetupWorkspace, resolveWorkspaceIdForSession,
 } = deps;
 for (const [name, value] of Object.entries({
  cancelBuiltinJob,
  endHuddleRoom,
  scheduleTaskQueueDrain,
  sendToConnection,
 })) {
  if (typeof value !== 'function') {
   throw new Error(`mountSessionsRoutes requires deps.${name}`);
  }
 }

 app.get('/backend/workspace/:id/usage', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await getDb().unsafe(
    `select
        (select coalesce(sum(size), 0)::bigint from uploaded_files where workspace_id = $1) as upload_bytes,
        (select count(*)::bigint from uploaded_files where workspace_id = $1) as file_count,
        (select coalesce(sum(byte_size), 0)::bigint from agent_memory_files where workspace_id = $1) as memory_bytes,
        (select count(*)::bigint from agent_memory_files where workspace_id = $1) as memory_file_count,
        (select count(*)::bigint from documents where workspace_id = $1) as document_count,
        (select count(*)::bigint from tasks where workspace_id = $1) as task_count,
        (select count(*)::bigint from workspace_agents where workspace_id = $1) as agent_count,
        (select count(*)::bigint
           from messages m
           join chat_sessions s on s.id = m.session_id
          where s.workspace_id = $1 and s.deleted_at is null and m.deleted_at is null) as message_count`,
    [workspaceId],
   );
   const row = rows[0] || {};
   const uploadBytes = Number(row.upload_bytes || 0);
   const memoryBytes = Number(row.memory_bytes || 0);
   res.json({
    data: {
     workspaceId,
     uploadBytes,
     memoryBytes,
     totalBytes: uploadBytes + memoryBytes,
     counts: {
      files: Number(row.file_count || 0),
      memoryFiles: Number(row.memory_file_count || 0),
      documents: Number(row.document_count || 0),
      tasks: Number(row.task_count || 0),
      agents: Number(row.agent_count || 0),
      messages: Number(row.message_count || 0),
     },
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Cold-load snapshot: one round-trip for the heaviest workspace-scoped lists
 // so the SPA does not open ~15 parallel queries before first paint.
 app.get('/backend/workspaces/:id/bootstrap', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const data = await buildWorkspaceBootstrap(workspaceId, req.userId);
   res.json({ data, error: null });
  } catch (error) {
   const status = error.status || 500;
   // jsonError only ships a sanitized message to the client, so a 5xx here otherwise leaves
   // no server-side trace. Log the stack + who/where so the (reproduced-only-on-connect)
   // bootstrap 500 is diagnosable from fly logs next time instead of invisible.
   if (status >= 500) {
    console.error('[bootstrap] %d for workspace=%s user=%s:', status, req.params?.id, req.userId, error);
   }
   jsonError(res, status, error);
  }
 });

 // Paginated message history for a session. The client loads the newest page on
 // open (bounded) and calls this with `before=<oldest loaded created_at>` to page
 // backwards on demand — so opening a channel with thousands of messages no longer
 // pulls the entire transcript at once (NET-05). Returns rows ASCENDING (oldest
 // first within the page) plus `hasMore` so the UI can show a "Load earlier" affordance.
 app.get('/backend/sessions/:id/messages', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.id || '').trim();
   if (!sessionId) return jsonError(res, 400, new Error('sessionId is required'));
   const workspaceId = await resolveWorkspaceIdForSession(sessionId);
   if (!workspaceId) return jsonError(res, 404, new Error('Session not found'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   // Then the session gate. Workspace `read` is necessary but no longer
   // sufficient: a private session (a DM, or a sub-thread/huddle split out of
   // one) is readable only by its members.
   await enforceSessionRead(req.userId, sessionId);
   const limit = Math.min(500, Math.max(1, Math.trunc(Number(req.query.limit)) || 200));
   const before = String(req.query.before || '').trim();
   const beforeId = String(req.query.beforeId || '').trim();
   // Compound cursor on (created_at, id): messages can share a millisecond, so a
   // bare `created_at < before` would skip same-timestamp rows at the page
   // boundary. Ordering + cursor on (created_at, id) is total and stable.
   // Fetch limit+1 (DESC) to detect hasMore, then reverse to ascending.
   const params = [sessionId];
   let beforeClause = '';
   if (before) {
    if (beforeId) {
     params.push(before, beforeId);
     beforeClause = ' and (created_at < $2 or (created_at = $2 and id < $3))';
    } else {
     params.push(before);
     beforeClause = ' and created_at < $2';
    }
   }
   const rows = await getDb().unsafe(
    `select * from messages
       where session_id = $1${beforeClause}
       order by created_at desc, id desc
       limit ${limit + 1}`,
    params,
   );
   const hasMore = rows.length > limit;
   const page = redactDeletedMessageRows(
    (hasMore ? rows.slice(0, limit) : rows).reverse(),
   );
   res.json({ data: { messages: page, hasMore }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Deliberately broader than an ordinary message edit: closing a conversation
 // soft-deletes the whole transcript, including agent and other-participant
 // rows. It is therefore limited to a manager who is already a member of a
 // private conversation. A public channel can never pass this route.
 app.post('/backend/sessions/:id/clear', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.id || '').trim();
   if (!sessionId) return jsonError(res, 400, new Error('sessionId is required'));
   const rows = await getDb().unsafe(
    'select id, workspace_id, visibility, folder, deleted_at from chat_sessions where id = $1 limit 1',
    [sessionId],
   );
   const session = rows[0];
   const unavailable = () => jsonError(
    res,
    404,
    new Error('Conversation not found or unavailable'),
   );
   if (!session) return unavailable();
   try {
    // Do not reveal whether a foreign id names a public channel, a private
    // conversation, or an unreadable private conversation. Classification is
    // intentionally checked only after BOTH authority gates succeed.
    await enforceWorkspaceRole(req.userId, session.workspace_id, 'manage');
    await enforceSessionRead(req.userId, sessionId, session);
   } catch (error) {
    if (error?.status === 403 || error?.status === 404) return unavailable();
    throw error;
   }
   if (!isPrivateSessionRow(session)) {
    return jsonError(res, 400, new Error('Only private conversations can be deleted this way'));
   }
   const workspaceId = session.workspace_id;
   // The lock MUST be its own statement inside a transaction. If it sat in the
   // mutation CTE, that statement's snapshot would be taken before a concurrent
   // message INSERT released its SHARE lock; after waiting, the clear could miss
   // that newly committed row and close the session around live content.
   //
   // Lock the current membership row too. Otherwise a revoke could commit after
   // this authorization snapshot but before the mutation. The canonical access
   // predicate remains sessionReadableSql; the join only makes its qualifying
   // row lockable.
   const result = await getDb().begin(async (tx) => {
    const locked = await tx.unsafe(
     `with recursive clear_workspace_chain as (
        select id, parent_id, 0 as depth
          from workspaces
         where id = $5
        union all
        select parent.id, parent.parent_id, chain.depth + 1
          from workspaces parent
          join clear_workspace_chain chain on parent.id = chain.parent_id
         where chain.depth < 10
      ),
      clear_locked_workspace_chain as materialized (
        select workspace.id, workspace.user_id
          from workspaces workspace
          join clear_workspace_chain chain on chain.id = workspace.id
        for share of workspace
      ),
      clear_manager_membership as materialized (
        select membership.workspace_id
          from workspace_members membership
          join clear_locked_workspace_chain workspace
            on workspace.id = membership.workspace_id
         where membership.user_id = $2
           and membership.role in ('owner', 'admin')
        for share of membership
      )
      select clear_session_scope.id
        from chat_sessions clear_session_scope
        join chat_session_members clear_session_member
          on clear_session_member.session_id = clear_session_scope.id
         and clear_session_member.user_id = $2
       where clear_session_scope.id = $1
         and clear_session_scope.deleted_at is null
         and clear_session_scope.visibility is not distinct from $3
         and clear_session_scope.folder is not distinct from $4
         and (
           exists (
             select 1 from clear_locked_workspace_chain workspace
              where workspace.user_id = $2
           )
           or exists (select 1 from clear_manager_membership)
         )
         and ${sessionReadableSql('clear_session_scope', '$2')}
       for update of clear_session_scope, clear_session_member`,
     [sessionId, req.userId, session.visibility ?? null, session.folder ?? null, workspaceId],
    );
    if (locked.length !== 1) {
     throw forbidden('Conversation access changed before the delete completed');
    }
    const effects = await settleSessionClosure({
     query: (sql, params) => tx.unsafe(sql, params),
     hostSessionIds: [sessionId],
     closeHostSessions: true,
    });
    if (!effects.sessions.some(row => String(row.id) === sessionId)) {
     throw forbidden('Conversation access changed before the delete completed');
    }
    return effects;
   });
   await applySessionClosureRuntimeEffects(result, {
    notifyDbSubscribers,
    cancelBuiltinJob,
    sendToConnection,
    scheduleTaskQueueDrain,
    endHuddleRoom,
    onWarn: (message) => console.warn('[session-clear]', message),
   });
   if (typeof recordAudit === 'function') {
    void recordAudit({
     workspaceId,
     actor: { userId: req.userId },
     action: 'chat_session.cleared',
     target: { type: 'chat_session', id: sessionId },
     detail: {
      sessionIds: result.allSessionIds.join(','),
      clearedMessages: result.clearedMessages,
      cancelledJobs: result.jobs.length,
      expiredPermissionRequests: result.permissionRequests.length,
      endedHuddles: result.huddles.length,
     },
    });
   }
   res.json({
    data: {
     sessionId,
     clearedMessages: result.clearedMessages,
     cancelledJobs: result.jobs.length,
     closed: result.sessions.some(row => String(row.id) === sessionId),
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Close any conversation through one lifecycle-aware command. Derived
 // sessions (sub-threads and forks) are write-gated so editors can clean up
 // work they were allowed to create; top-level sessions remain manage-gated.
 // The immutable lineage columns keep that distinction stable after creation.
 app.post('/backend/sessions/:id/close', requireAuth, async (req, res) => {
  try {
   const sessionId = String(req.params.id || '').trim();
   if (!sessionId) return jsonError(res, 400, new Error('sessionId is required'));
   const rows = await getDb().unsafe(
    `select id, workspace_id, visibility, folder, parent_message_id, split_parent_id, deleted_at
       from chat_sessions
      where id = $1
      limit 1`,
    [sessionId],
   );
   const session = rows[0];
   if (!session) return jsonError(res, 404, new Error('Session not found'));
   const derived = Boolean(session.parent_message_id || session.split_parent_id);
   const workspaceId = session.workspace_id;
   await enforceWorkspaceRole(req.userId, workspaceId, derived ? 'write' : 'manage');
   await enforceSessionRead(req.userId, sessionId, session);

   const result = await getDb().begin(async (tx) => {
    const locked = await tx.unsafe(
     `select close_session_scope.id
        from chat_sessions close_session_scope
       where close_session_scope.id = $1
         and close_session_scope.workspace_id = $3
         and close_session_scope.parent_message_id is not distinct from $4
         and close_session_scope.split_parent_id is not distinct from $5
         and ${sessionReadableSql('close_session_scope', '$2', { lockMembership: true })}
       for update of close_session_scope`,
     [
      sessionId,
      req.userId,
      workspaceId,
      session.parent_message_id ?? null,
      session.split_parent_id ?? null,
     ],
    );
    if (locked.length !== 1) {
     throw forbidden('Conversation access changed before the close completed');
    }
    const effects = await settleSessionClosure({
     query: (sql, params) => tx.unsafe(sql, params),
     hostSessionIds: [sessionId],
     closeHostSessions: true,
    });
    if (!effects.sessions.some(row => String(row.id) === sessionId)) {
     throw forbidden('Conversation access changed before the close completed');
    }
    return effects;
   });

   await applySessionClosureRuntimeEffects(result, {
    notifyDbSubscribers,
    cancelBuiltinJob,
    sendToConnection,
    scheduleTaskQueueDrain,
    endHuddleRoom,
    onWarn: (message) => console.warn('[session-close]', message),
   });
   if (typeof recordAudit === 'function') {
    void recordAudit({
     workspaceId,
     actor: { userId: req.userId },
     action: 'chat_session.cleared',
     target: { type: 'chat_session', id: sessionId },
     detail: {
      sessionIds: result.allSessionIds.join(','),
      clearedMessages: result.clearedMessages,
      cancelledJobs: result.jobs.length,
      expiredPermissionRequests: result.permissionRequests.length,
      endedHuddles: result.huddles.length,
     },
    });
   }
   res.json({
    data: {
     sessionId,
     clearedMessages: result.clearedMessages,
     cancelledJobs: result.jobs.length,
     closed: true,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/sessions/:id/split', requireAuth, async (req, res) => {
  try {
   const sourceSessionId = String(req.params.id || '').trim();
   if (!sourceSessionId) return jsonError(res, 400, new Error('sessionId is required'));
   const sourceRows = await getDb().unsafe(
    `select id, workspace_id, visibility, folder, deleted_at
       from chat_sessions
      where id = $1
      limit 1`,
    [sourceSessionId],
   );
   const source = sourceRows[0];
   if (!source || source.deleted_at) return jsonError(res, 404, new Error('Conversation not found'));
   await enforceWorkspaceRole(req.userId, source.workspace_id, 'write');
   await enforceSessionRead(req.userId, sourceSessionId, source);

   const result = await getDb().begin((tx) => createSessionSplit({
    query: (sql, params) => tx.unsafe(sql, params),
    sourceSessionId,
    userId: req.userId,
    // postgres.js binds jsonb as the parsed object/array, never a JSON string.
    jsonParam: value => value,
   }));
   notifyDbSubscribers('chat_sessions', 'INSERT', [result.session]);
   notifyDbSubscribers('messages', 'INSERT', [result.baselineMessage], {
    suppressLogicalEvents: true,
   });
   res.status(201).json({
    data: {
     session: result.session,
     baselineMessageId: result.baselineMessage.id,
     sourceBoundaryMessageId: result.sourceBoundaryMessageId,
    },
    error: null,
   });
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
    // Authenticated setup for a workspace the user can act in — mode override
    // only via allowPermissionModeChange, never actorUserId alone.
    allowPermissionModeChange: true,
    baseUrl,
    profile: false,
    actorUserId: req.userId,
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
}

module.exports = { mountSessionsRoutes };
