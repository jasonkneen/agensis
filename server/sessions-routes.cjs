'use strict';

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
  requireAuth, jsonError, enforceWorkspaceRole, enforceSessionRead, getDb,
  buildAgentConnectionCommand, buildWorkspaceBootstrap,
  ensurePrimaryDaemonAgent, normalizeAgentBackendBaseUrl, requestBaseUrl,
  resolveSetupWorkspace, resolveWorkspaceIdForSession,
 } = deps;

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
       where session_id = $1 and deleted_at is null${beforeClause}
       order by created_at desc, id desc
       limit ${limit + 1}`,
    params,
   );
   const hasMore = rows.length > limit;
   const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
   res.json({ data: { messages: page, hasMore }, error: null });
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
