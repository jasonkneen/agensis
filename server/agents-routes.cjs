'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Agent operations: connections, the connect command, disconnect, memory and
// capability refresh, and dispatch.
//
// Dispatch is the interesting one. The browser first persists a human message,
// then sends only its id here. This route locks that exact caller-owned message
// and its live/readable session, derives mentions and thread routing from the
// STORED content, atomically extends the roster when needed, and only then hands
// off to the live daemon or builtin loop. @channel addresses every agent in a
// channel and therefore spends a paid model turn per member, which is why the
// mention parsing is single-sourced in shared/channelMentions.cjs.
//
// The MCP handler is NOT here. It is constructed in index.cjs beside the routes
// that serve it, because it is a transport door rather than an agent operation
// and it shares mcpToolDeps() verbatim with the builtin tool loop.

function mountAgentsRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, notifyDbSubscribers,
  sendWs, isAgentEnabled, dbRateLimitBlocked, clientIpFromReq,
  allowsUnpromptedReply, buildAgentConnectionCommand, connectedAgents,
  continueConversation, directAgentParticipantFromSession, disconnectAgentDaemons,
  dispatchDbRateLimiter, dispatchRateLimiter, enforceSessionRead, findConnectedAgent,
  forbidden, mentionsChannel, normalizeAgentBackendBaseUrl, parseAgentMentions,
  parseJsonArray, publicAgentConnection, requestBaseUrl, resolveDispatchThreadParent,
  sessionReadableSql, slugHandle,
 } = deps;

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
    actorUserId: req.userId,
   });
   res.json({ data: payload, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/agents/:id/disconnect', requireAuth, async (req, res) => {
  try {
   const agentId = String(req.params.id || '').trim();
   const rows = await getDb().unsafe('select * from workspace_agents where id = $1 limit 1', [agentId]);
   const agent = rows[0];
   if (!agent) return jsonError(res, 404, new Error('Agent not found'));
   await enforceWorkspaceRole(req.userId, agent.workspace_id, 'manage');
   const disconnectedCount = [...connectedAgents.values()].filter(
    entry => String(entry.agentId) === String(agent.id) && String(entry.workspaceId) === String(agent.workspace_id),
   ).length;
   await disconnectAgentDaemons(agent.id, agent.workspace_id, 'disconnected');
   res.json({ data: { id: agentId, disconnected: disconnectedCount }, error: null });
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
   if (await dbRateLimitBlocked(res, dispatchRateLimiter, dispatchDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   const { workspaceId, sessionId, threadParentId, messageId, autoThread } = req.body || {};
   if (!workspaceId || !sessionId || !messageId) {
    return jsonError(res, 400, new Error('workspaceId, sessionId, and messageId are required'));
   }
   await enforceWorkspaceRole(req.userId, workspaceId, 'run_agents');
   const db = getDb();
   // Friendly preflight only. The transaction below repeats every condition and
   // is the authorization boundary; this read exists so a missing conversation
   // remains a 404 rather than becoming an opaque access-change error.
   const sessionRows = await db.unsafe(
    `select id, workspace_id, visibility, folder, deleted_at
       from chat_sessions
      where id = $1 and workspace_id = $2
      limit 1`,
    [sessionId, workspaceId],
   );
   if (!sessionRows[0] || sessionRows[0].deleted_at) {
    return jsonError(res, 404, new Error('Channel not found'));
   }
   await enforceSessionRead(req.userId, sessionId, sessionRows[0]);

   const explicitThreadParentId = threadParentId == null || String(threadParentId).trim() === ''
    ? null
    : String(threadParentId).trim();
   const outcome = await db.begin(async (tx) => {
    // Lock every row that proves this dispatch: the session, caller-owned seed,
    // private membership (inside sessionReadableSql), and direct/inherited
    // workspace role. A clear, revoke, workspace move, role downgrade, seed edit
    // or seed delete therefore either wins BEFORE this statement and is seen, or
    // waits until this authorization has committed. There is no stale middle.
    const locked = await tx.unsafe(
     `with recursive dispatch_workspace_chain as (
        select id, parent_id, 0 as depth
          from workspaces
         where id = $2
        union all
        select parent.id, parent.parent_id, chain.depth + 1
          from workspaces parent
          join dispatch_workspace_chain chain on parent.id = chain.parent_id
         where chain.depth < 10
      ),
      dispatch_locked_workspaces as materialized (
        select workspace.id, workspace.user_id
          from workspaces workspace
          join dispatch_workspace_chain chain on chain.id = workspace.id
         for share of workspace
      ),
      dispatch_locked_memberships as materialized (
        select membership.workspace_id, membership.role
          from workspace_members membership
          join dispatch_locked_workspaces workspace
            on workspace.id = membership.workspace_id
         where membership.user_id = $3
         for share of membership
      )
      select dispatch_session.id,
             dispatch_session.workspace_id,
             dispatch_session.participants,
             dispatch_session.conversation_mode,
             dispatch_session.visibility,
             dispatch_session.folder,
             dispatch_seed.id as seed_id,
             dispatch_seed.content as seed_content,
             dispatch_seed.thread_parent_id as seed_thread_parent_id
        from chat_sessions dispatch_session
        join messages dispatch_seed
          on dispatch_seed.id = $4
         and dispatch_seed.session_id = dispatch_session.id
       where dispatch_session.id = $1
         and dispatch_session.workspace_id = $2
         and dispatch_session.deleted_at is null
         and ${sessionReadableSql('dispatch_session', '$3', { lockMembership: true })}
         and (
           exists (
             select 1 from dispatch_locked_workspaces workspace
              where workspace.user_id = $3
           )
           or exists (
             select 1 from dispatch_locked_memberships membership
              where membership.role in ('owner', 'admin', 'editor')
           )
         )
         and dispatch_seed.deleted_at is null
         and dispatch_seed.role = 'user'
         and dispatch_seed.sender_kind = 'user'
         and dispatch_seed.sender_id::text = $3::text
         and length(btrim(coalesce(dispatch_seed.content, ''))) > 0
         and (
           ($5::text is null and dispatch_seed.thread_parent_id is null)
           or dispatch_seed.thread_parent_id::text = $5::text
         )
       for update of dispatch_session
       for share of dispatch_seed`,
     [sessionId, workspaceId, req.userId, messageId, explicitThreadParentId],
    );
    const session = locked[0];
    if (!session) {
     throw forbidden('Dispatch access changed before the agent run could start');
    }

    // An explicit thread reply must name the same live root the stored seed
    // names. The seed's thread_parent_id is immutable for browser writers, but
    // the root can be deleted; lock it so that cannot happen between validation
    // and commit. A forged cross-session parent is rejected, never flattened.
    if (explicitThreadParentId) {
     const parentRows = await tx.unsafe(
      `select id
         from messages
        where id = $1
          and session_id = $2
          and deleted_at is null
        for share`,
      [explicitThreadParentId, sessionId],
     );
     if (parentRows.length !== 1) {
      throw forbidden('Dispatch thread changed before the agent run could start');
     }
    }

    const storedContent = String(session.seed_content || '');
    const mentions = parseAgentMentions(storedContent);
    const directTarget = directAgentParticipantFromSession(session);
    const isDirectMessage = Boolean(directTarget && directTarget.direct);
    const dmForModeGate = isDirectMessage || session.folder === 'Direct messages';

    // Preserve the existing thread-continuation rule, but derive it from rows
    // locked in this transaction rather than a second unscoped read.
    let threadTarget = null;
    if (mentions.length === 0 && explicitThreadParentId) {
     const threadRows = await tx.unsafe(
      `select id, sender_kind, sender_id, sender_name, content,
              message_kind, tool_name, tool_detail, broadcast_to_channel,
              created_at
         from messages
        where session_id = $1
          and deleted_at is null
          and (id = $2 or thread_parent_id = $2)
        order by created_at desc
        for share`,
      [sessionId, explicitThreadParentId],
     );
     const agentRow = threadRows.find((row) => (
      row.sender_kind === 'agent'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(row.sender_id || ''))
     ));
     if (agentRow) {
      threadTarget = { agentId: String(agentRow.sender_id), handle: slugHandle(agentRow.sender_name || '') };
     } else {
      for (const row of threadRows) {
       const handle = parseAgentMentions(row.content)[0] || '';
       if (handle) {
        threadTarget = { agentId: '', handle };
        break;
       }
      }
     }
    }

    // A mentioned non-participant becomes part of a channel in the SAME locked
    // transaction. DMs stay isolated. This replaces the old best-effort helper:
    // an access or roster race now refuses dispatch instead of silently running
    // with a stale participant set or overwriting somebody else's roster edit.
    let updatedSession = null;
    if (mentions.length > 0 && !(directTarget && directTarget.direct)) {
     const existing = parseJsonArray(session.participants);
     const existingAgentIds = new Set(
      existing
       .filter((participant) => participant && participant.kind === 'agent')
       .map((participant) => String(participant.agent_id || participant.id || '').replace(/^agent:/, ''))
       .filter(Boolean),
     );
     const agents = await tx.unsafe(
      `select id, name, handle, enabled
         from workspace_agents
        where workspace_id = $1
        for share`,
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
     for (const handle of mentions) {
      const agent = byHandle.get(handle);
      if (!agent) continue;
      const agentId = String(agent.id);
      if (existingAgentIds.has(agentId) || seen.has(agentId)) continue;
      seen.add(agentId);
      additions.push({
       id: `agent:${agentId}`,
       kind: 'agent',
       agent_id: agentId,
       user_id: null,
       name: agent.name,
       handle: slugHandle(agent.handle || agent.name),
       status: null,
       direct: false,
       added_at: new Date().toISOString(),
      });
     }
     if (additions.length > 0) {
      const merged = [...existing, ...additions];
      const updated = await tx.unsafe(
       `update chat_sessions
           set participants = $1::jsonb,
               updated_at = now()
         where id = $2
           and workspace_id = $3
           and deleted_at is null
           and participants is not distinct from $4::jsonb
         returning id, workspace_id, participants, conversation_mode, visibility, folder, deleted_at, updated_at`,
       [merged, sessionId, workspaceId, session.participants],
      );
      if (updated.length !== 1) {
       throw forbidden('Channel roster changed before the agent run could start');
      }
      [updatedSession] = updated;
     }
    }

    const addressesChannel = mentionsChannel(storedContent);
    const addressed = mentions.length > 0 || addressesChannel || Boolean(threadTarget)
     || (Boolean(directTarget) && dmForModeGate);
    if (!addressed && !allowsUnpromptedReply({
     conversationMode: session.conversation_mode,
     isDirectMessage: dmForModeGate,
    })) {
     return {
      dispatched: false,
      reason: 'channel_replies_on_mention_only',
      mentions,
      updatedSession,
     };
    }
    if (!(addressed || !isDirectMessage)) {
     return {
      dispatched: false,
      reason: 'no_agent_mention_or_direct_target',
      mentions,
      updatedSession,
     };
    }

    const effectiveThreadParentId = resolveDispatchThreadParent({
     threadParentId: session.seed_thread_parent_id,
     autoThread,
     messageId: session.seed_id,
    });
    const mode = addressesChannel
     ? 'channel'
     : (mentions.length > 0 || threadTarget ? 'mention' : (directTarget ? 'direct' : 'auto'));
    return {
     dispatched: true,
     effectiveThreadParentId,
     mentions,
     mode,
     updatedSession,
    };
   });

   if (outcome.updatedSession) {
    notifyDbSubscribers('chat_sessions', 'UPDATE', [outcome.updatedSession]);
   }
   if (!outcome.dispatched) {
    return res.json({ data: { dispatched: false, reason: outcome.reason }, error: null });
   }
   // Fire and forget: the conversation advances in the background as each agent
   // message lands and is streamed to clients over realtime. Holding the POST
   // open for the whole multi-turn chain would block the user's UI.
   void continueConversation({ workspaceId, sessionId, threadParentId: outcome.effectiveThreadParentId })
    .catch((error) => console.error('continueConversation (dispatch) failed', error));
   return res.json({ data: { dispatched: true, mode: outcome.mode, mentions: outcome.mentions }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

}

module.exports = { mountAgentsRoutes };
