'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Agent operations: connections, the connect command, disconnect, memory and
// capability refresh, and dispatch.
//
// Dispatch is the interesting one. It resolves who was addressed
// (parseAgentMentions / mentionsChannel), decides which thread the turn belongs
// to (resolveDispatchThreadParent / verifyThreadParent), makes sure the
// mentioned agents are participants, and then hands off to the live daemon
// (findConnectedAgent) or the builtin loop. @channel addresses every agent in a
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
  dispatchDbRateLimiter, dispatchRateLimiter, ensureMentionedParticipants,
  findConnectedAgent, inferThreadAgentTarget, mentionsChannel,
  normalizeAgentBackendBaseUrl, parseAgentMentions, publicAgentConnection,
  requestBaseUrl, resolveDispatchThreadParent, verifyThreadParent,
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
   const { workspaceId, sessionId, content, threadParentId, messageId, autoThread } = req.body || {};
   if (!workspaceId || !sessionId || !content) {
    return jsonError(res, 400, new Error('workspaceId, sessionId, and content are required'));
   }
   await enforceWorkspaceRole(req.userId, workspaceId, 'run_agents');
   // `folder` is in the projection because the mode gate below needs it to
   // recognise a legacy 'Direct messages' DM. An explicit column list that omits
   // a column a decision reads is this repo's blank-column trap — the value
   // arrives as undefined and the decision silently takes the other branch.
   const sessionRows = await getDb().unsafe(
    'select id, workspace_id, participants, conversation_mode, folder from chat_sessions where id = $1 limit 1',
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
   // A true 1:1 DM (a participant flagged direct:true) only routes to its own agent.
   const isDirectMessage = Boolean(directTarget && directTarget.direct);
   // The DM test the MODE GATE uses has to be continueConversation's, not the
   // narrow one above: it also counts the legacy 'Direct messages' folder, whose
   // rows never got a direct-flagged participant. Kept separate so the branch
   // below stays keyed on exactly what it always was.
   const dmForModeGate = isDirectMessage || sessionRows[0].folder === 'Direct messages';
   // `@channel` addresses the roster rather than a handle, so it counts as being
   // addressed even though `mentions` (individual handles) is empty.
   const addressesChannel = mentionsChannel(content);
   // A directTarget only counts as ADDRESSED in a DM. In a channel it is the
   // sole-agent-participant fallback, which is the un-addressed case the mode
   // governs — see the matching gate in continueConversation.
   const addressed = mentions.length > 0 || addressesChannel || Boolean(threadTarget)
    || (Boolean(directTarget) && dmForModeGate);
   // Nothing and nobody was addressed. Whether that still wakes an agent is the
   // channel's conversation_mode — the SAME decision continueConversation makes
   // (allowsUnpromptedReply), asked here only so the client is told the truth
   // rather than being handed dispatched:true for a post nobody will answer.
   if (!addressed && !allowsUnpromptedReply({
    conversationMode: sessionRows[0].conversation_mode,
    isDirectMessage: dmForModeGate,
   })) {
    return res.json({ data: { dispatched: false, reason: 'channel_replies_on_mention_only' }, error: null });
   }
   const willDispatch = addressed || !isDirectMessage;
   if (!willDispatch) {
    return res.json({ data: { dispatched: false, reason: 'no_agent_mention_or_direct_target' }, error: null });
   }
   // Option A auto-threading: thread the agent's reply under the human's main-box
   // message when the UI asks for it (see resolveDispatchThreadParent). Follow-ups
   // already carry threadParentId; sub-thread/MCP/legacy callers stay flat.
   const requestedThreadParentId = resolveDispatchThreadParent({ threadParentId, autoThread, messageId });
   // VERIFY THE PARENT EXISTS before threading under it. messageId arrives from
   // the client and was previously trusted straight into a foreign key, so an
   // optimistic id — or one whose own insert failed — made EVERY agent reply in
   // the job die on messages_thread_parent_id_fkey. The turn is not the place to
   // discover that: a reply that cannot be threaded should land flat, not vanish.
   //
   // Scoped to this session as well as existence, so a caller cannot thread a
   // reply under a message in a conversation they are not in.
   const effectiveThreadParentId = await verifyThreadParent(requestedThreadParentId, sessionId);
   // Fire and forget: the conversation advances in the background as each agent
   // message lands and is streamed to clients over realtime. Holding the POST
   // open for the whole multi-turn chain would block the user's UI.
   void continueConversation({ workspaceId, sessionId, threadParentId: effectiveThreadParentId })
    .catch((error) => console.error('continueConversation (dispatch) failed', error));
   // Diagnostic only (nothing branches on it), but ordered the way
   // pickMentionNextAgent actually decides: an explicit mention outranks the
   // sole-agent direct fallback, so reporting 'direct' for "@coder look" in a
   // one-agent channel was simply describing the wrong reason.
   const dispatchMode = addressesChannel
    ? 'channel'
    : (mentions.length > 0 || threadTarget ? 'mention' : (directTarget ? 'direct' : 'auto'));
   return res.json({ data: { dispatched: true, mode: dispatchMode, mentions }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

}

module.exports = { mountAgentsRoutes };
