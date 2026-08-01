'use strict';

const {
 AI_CHAT_SYSTEM_MAX_BYTES,
 loadStoredAiChatContext,
 lockAiChatRunScope,
 truncateUtf8Middle,
} = require('../shared/ai-chat-context.cjs');

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// POST /backend/ai-chat — the browser's chat turn. Two lanes behind one route:
//
//   * BUILT-IN: streams Anthropic directly, with the workspace's own key
//     preferred over the host env var (getAnthropicApiKey).
//   * GATEWAY: when the chosen model id is `gateway:<id>`, streams an external
//     OpenAI-compatible endpoint's SSE straight through.
//
// The gateway branch re-runs assertSafeOutboundUrl on the stored base URL at
// CALL time, not just at save time — rows predate the guard, and a hostname's
// DNS answer can change after it was accepted. That check is injected, not
// re-implemented; see server/lib/net-guard.cjs.
//
// Fly only. The Netlify mirror has its own /backend/ai-chat with no gateway
// branch and no streaming relay, because it has no websocket layer.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING_AI_REPLY = 'Thinking …';
const EMPTY_AI_REPLY = 'AI response finished without content.';

function streamedText(chunk) {
 if (!chunk || typeof chunk !== 'object') return '';
 if (typeof chunk.delta?.text === 'string') return chunk.delta.text;
 const delta = chunk.choices?.[0]?.delta;
 if (typeof delta?.content === 'string') return delta.content;
 if (typeof delta?.text === 'string') return delta.text;
 return '';
}

function statusError(status, error) {
 const issue = error instanceof Error ? error : new Error(String(error || 'AI request failed'));
 issue.status = status;
 return issue;
}

function mountAiChatRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, dbRateLimitBlocked,
  clientIpFromReq, aiChatRateLimiter, aiChatDbRateLimiter, dbQuery,
  inferenceBroker, liveSharedModelRoutes, bindInferenceAbort,
  getAnthropicApiKey, resolveAnthropicModel, buildSystemPrompt,
  normalizeAiChatMessages,
  // Injected, never re-implemented: the same guard the gateway save path and the
  // provider proxy use. See server/lib/net-guard.cjs.
  assertSafeOutboundUrl,
  // Defined inside createApp() rather than at index.cjs top level, so it has to
  // be passed explicitly.
  resolveGatewayRoute,
  emitBridgeOutbound,
  // Metering. This route is one of three Anthropic spend points on the Fly lane
  // (the others are runAnthropicCompletion and streamAnthropicTurn), and
  // tests/usage-metering.test.cjs counts all three across the lane.
  recordAnthropicUsage, createAnthropicUsageAccumulator,
  enforceSessionRead, sessionReadableSql, getDb, notifyDbSubscribers,
  logMessageActivity, parseJsonArray, aiStreamErrorText,
 } = deps;

 app.post('/backend/ai-chat', requireAuth, async (req, res) => {
  let replyPersistence = null;
  let streamedReplyContent = '';
  let streamedReplyError = '';
  try {
   if (await dbRateLimitBlocked(res, aiChatRateLimiter, aiChatDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   const {
    messages, model, memory, documents, workspaceContext, agentContext, workspaceId,
    sessionId, messageId, seedMessageId, threadParentId, replyAgentId,
   } = req.body || {};
   let executionModel = model;
   let executionAgentContext = agentContext;
   let hasVerifiedReplyAgent = false;
   let replyAgentSnapshotVersion = null;
   let storedReplyContext = null;
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'run_agents');

   // Persisting the streamed assistant reply is optional for API compatibility,
   // but when requested it is entirely server-authored. The browser supplies
   // destination ids; it never supplies role/sender attribution or a second
   // copy of the model output.
   if (sessionId != null || messageId != null || threadParentId != null) {
    if (!UUID_RE.test(String(sessionId || ''))
      || !UUID_RE.test(String(messageId || ''))
      || !UUID_RE.test(String(seedMessageId || ''))) {
     return jsonError(
      res,
      400,
      new Error('Valid sessionId, messageId, and seedMessageId are required to save an AI reply'),
     );
    }
    if (threadParentId && !UUID_RE.test(String(threadParentId))) {
     return jsonError(res, 400, new Error('threadParentId must be a valid message id'));
    }
    const sessionRows = await getDb().unsafe(
     'select id, workspace_id, visibility, folder, participants, deleted_at from chat_sessions where id = $1 limit 1',
     [String(sessionId)],
    );
    const session = sessionRows[0];
    if (!session || session.deleted_at || String(session.workspace_id) !== String(workspaceId)) {
     return jsonError(res, 404, new Error('Conversation not found'));
    }
    await enforceWorkspaceRole(req.userId, workspaceId, 'write');
    await enforceSessionRead(req.userId, String(sessionId), session);
    if (threadParentId) {
     const parentRows = await getDb().unsafe(
      'select id from messages where id = $1 and session_id = $2 limit 1',
      [String(threadParentId), String(sessionId)],
     );
     if (!parentRows[0]) return jsonError(res, 400, new Error('Thread parent is not in this conversation'));
    }
    const replyAttribution = {
     senderKind: 'assistant',
     senderId: '',
     senderName: 'Agensis',
    };
    if (replyAgentId != null && String(replyAgentId).trim()) {
     const requestedAgentId = String(replyAgentId);
     if (!UUID_RE.test(requestedAgentId)) {
      return jsonError(res, 400, new Error('replyAgentId must be a valid agent id'));
     }
     const isSessionAgent = parseJsonArray(session.participants).some((participant) =>
      participant?.kind === 'agent' && String(participant.agent_id || '') === requestedAgentId,
     );
     if (!isSessionAgent) {
      return jsonError(res, 400, new Error('Reply agent is not a participant in this conversation'));
     }
     const agentRows = await getDb().unsafe(
      `select id, name, handle, description, system_prompt, soul, instructions,
              tools, skills, model, run_mode, version
         from workspace_agents
        where id = $1 and workspace_id = $2 and enabled is not false
        limit 1`,
      [requestedAgentId, String(workspaceId)],
     );
     const replyAgent = agentRows[0];
     if (!replyAgent) {
      return jsonError(res, 400, new Error('Reply agent is not available'));
     }
     const replyRunMode = String(replyAgent.run_mode || 'builtin');
     if (replyRunMode !== 'builtin') {
      return jsonError(
       res,
       409,
       new Error('Reply agent must answer through its configured connected runtime'),
      );
     }
     replyAttribution.senderKind = 'agent';
     replyAttribution.senderId = String(replyAgent.id);
     replyAttribution.senderName = String(replyAgent.name || 'Agent');
     // An agent-attributed answer must actually be that configured agent's
     // answer. Once the participant and enabled row are proven, the database is
     // the sole source for its provider/model and persona. Accepting the
     // browser's model or agentContext here would let any run_agents user stamp
     // one agent's identity onto a different model/persona.
     executionModel = String(replyAgent.model || 'auto');
     executionAgentContext = {
      id: String(replyAgent.id),
      name: String(replyAgent.name || 'Agent'),
      handle: String(replyAgent.handle || ''),
      description: String(replyAgent.description || ''),
      systemPrompt: String(replyAgent.system_prompt || ''),
      soul: String(replyAgent.soul || ''),
      instructions: String(replyAgent.instructions || ''),
      tools: parseJsonArray(replyAgent.tools),
      skills: parseJsonArray(replyAgent.skills),
      model: executionModel,
      runMode: replyRunMode,
     };
     replyAgentSnapshotVersion = Number.isInteger(Number(replyAgent.version))
      ? Number(replyAgent.version)
      : 1;
     hasVerifiedReplyAgent = true;
    }
    replyPersistence = {
     reserved: false,
	     finalized: false,
	     async reserve() {
	      const rows = await getDb().begin(async (transaction) => {
	       await lockAiChatRunScope({
	        db: (sql, params) => transaction.unsafe(sql, params),
	        workspaceId,
	        userId: req.userId,
	       });
	       const reservedRows = await transaction.unsafe(
       `insert into messages
          (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
        with current_reply_agent as materialized (
          select agent.id
            from workspace_agents agent
           where $10::uuid is not null
             and agent.id = $10::uuid
             and agent.workspace_id = $9
             and agent.enabled is not false
             and agent.run_mode = 'builtin'
             and agent.version = $11
           for share of agent
        ),
        current_reply_seed as materialized (
          select seed.id
            from messages seed
           where seed.id = $12
             and seed.session_id = $2
             and seed.deleted_at is null
             and seed.role = 'user'
             and seed.sender_kind = 'user'
             and seed.sender_id::text = $8::text
             and length(btrim(coalesce(seed.content, ''))) > 0
             and (
               ($4::uuid is null and seed.thread_parent_id is null)
               or seed.thread_parent_id = $4::uuid
             )
           for share of seed
        ),
        accessible_ai_reply_session as materialized (
          select ai_reply_session_scope.id
            from chat_sessions ai_reply_session_scope
           where ai_reply_session_scope.id = $2
             and ai_reply_session_scope.workspace_id = $9
             and ${sessionReadableSql('ai_reply_session_scope', '$8', { lockMembership: true })}
             and exists (select 1 from current_reply_seed)
             and (
               $4::uuid is null
               or exists (
                 select 1
                   from messages reply_parent
                  where reply_parent.id = $4
                    and reply_parent.session_id = ai_reply_session_scope.id
                    and reply_parent.deleted_at is null
               )
             )
             and (
               $10::uuid is null
               or (
                 $5 = 'agent'
                 and $6 = $10::text
                 and exists (select 1 from current_reply_agent)
                 and exists (
                   select 1
                     from jsonb_array_elements(
                       coalesce(ai_reply_session_scope.participants, '[]'::jsonb)
                     ) participant
                    where participant->>'kind' = 'agent'
                      and participant->>'agent_id' = $10::text
                 )
               )
             )
           for share of ai_reply_session_scope
        )
        select $1, $2, 'assistant', $3, $4, $5, $6, $7
          from accessible_ai_reply_session
        returning *`,
       [
        String(messageId),
        String(sessionId),
        PENDING_AI_REPLY,
        threadParentId ? String(threadParentId) : null,
        replyAttribution.senderKind,
        replyAttribution.senderId,
        replyAttribution.senderName,
        req.userId,
        String(workspaceId),
        hasVerifiedReplyAgent ? replyAttribution.senderId : null,
        replyAgentSnapshotVersion,
        String(seedMessageId),
       ],
	       );
	       if (reservedRows.length !== 1) {
	        throw statusError(403, new Error('AI reply could not be reserved from the caller-owned seed'));
	       }
	       storedReplyContext = await loadStoredAiChatContext({
	        db: (sql, params) => transaction.unsafe(sql, params),
	        sessionId: String(sessionId),
	        seedMessageId: String(seedMessageId),
	        threadParentId: threadParentId ? String(threadParentId) : null,
	        userId: req.userId,
	       });
	       return reservedRows;
	      });
      this.reserved = true;
      notifyDbSubscribers('messages', 'INSERT', rows, {
       suppressMessageActivity: true,
       suppressLogicalEvents: true,
      });
     },
	     async finalize(content) {
	      const text = typeof content === 'string' && content ? content : EMPTY_AI_REPLY;
	      const rows = await getDb().begin(async (transaction) => {
	       await lockAiChatRunScope({
	        db: (sql, params) => transaction.unsafe(sql, params),
	        workspaceId,
	        userId: req.userId,
	       });
	       return transaction.unsafe(
       `with current_reply_agent as materialized (
          select agent.id
            from workspace_agents agent
           where $8::uuid is not null
             and agent.id = $8::uuid
             and agent.workspace_id = $7
             and agent.enabled is not false
             and agent.run_mode = 'builtin'
             and agent.version = $9
           for share of agent
        ),
        current_reply_seed as materialized (
          select seed.id
            from messages seed
           where seed.id = $10
             and seed.session_id = $2
             and seed.deleted_at is null
             and seed.role = 'user'
             and seed.sender_kind = 'user'
             and seed.sender_id::text = $6::text
             and seed.content = $11
             and (
               ($12::uuid is null and seed.thread_parent_id is null)
               or seed.thread_parent_id = $12::uuid
             )
           for share of seed
        ),
        accessible_ai_reply_session as materialized (
          select reply_session.id
            from chat_sessions reply_session
           where reply_session.id = $2
             and reply_session.workspace_id = $7
             and ${sessionReadableSql('reply_session', '$6', { lockMembership: true })}
             and exists (select 1 from current_reply_seed)
             and (
               $8::uuid is null
               or (
                 exists (select 1 from current_reply_agent)
                 and exists (
                   select 1
                     from jsonb_array_elements(coalesce(reply_session.participants, '[]'::jsonb)) participant
                    where participant->>'kind' = 'agent'
                      and participant->>'agent_id' = $8::text
                 )
               )
             )
           for share of reply_session
        )
        update messages reply
           set content = $3
          from accessible_ai_reply_session reply_scope
         where reply.id = $1
           and reply.session_id = reply_scope.id
           and reply.role = 'assistant'
           and reply.sender_kind = $4
           and reply.sender_id = $5
           and reply.deleted_at is null
         returning reply.*`,
       [
        String(messageId),
        String(sessionId),
        text,
        replyAttribution.senderKind,
        replyAttribution.senderId,
        req.userId,
        String(workspaceId),
        hasVerifiedReplyAgent ? replyAttribution.senderId : null,
        replyAgentSnapshotVersion,
        String(seedMessageId),
        storedReplyContext.seedContent,
        threadParentId ? String(threadParentId) : null,
       ],
	       );
	      });
      if (rows.length !== 1) {
       throw new Error('Reserved AI reply could not be finalized');
      }
      this.finalized = true;
      notifyDbSubscribers('messages', 'UPDATE', rows, { workflowEventType: 'INSERT' });
      if (typeof logMessageActivity === 'function') await logMessageActivity(rows);
      if (typeof emitBridgeOutbound === 'function') {
       for (const row of rows) {
        void emitBridgeOutbound(row).catch((error) =>
         console.error('emitBridgeOutbound failed', error),
        );
       }
      }
     },
     async abort() {
      if (!this.reserved || this.finalized) return;
      const rows = await getDb().unsafe(
       `update messages
           set deleted_at = coalesce(deleted_at, now())
         where id = $1
           and session_id = $2
           and role = 'assistant'
           and sender_kind = $3
           and sender_id = $4
         returning *`,
       [String(messageId), String(sessionId), replyAttribution.senderKind, replyAttribution.senderId],
      );
      this.finalized = true;
      if (rows.length > 0) {
       notifyDbSubscribers('messages', 'UPDATE', rows, {
        suppressMessageActivity: true,
        suppressLogicalEvents: true,
       });
      }
     },
    };
    await replyPersistence.reserve();
   }

   const chat = storedReplyContext
    ? { messages: storedReplyContext.messages, systemPrompt: '' }
    : normalizeAiChatMessages(messages);
   // A caller-supplied role=system message is elevated instruction just like
   // agentContext. Preserve that legacy input for the unattributed assistant,
   // but never append it to a verified named agent's server-owned persona.
   const clientSystemPrompt = storedReplyContext ? '' : chat.systemPrompt;
   const trustedAgentContext = hasVerifiedReplyAgent
    ? executionAgentContext
    : (storedReplyContext ? null : executionAgentContext);
   const resolvedAgentContext = clientSystemPrompt
    ? {
     ...(trustedAgentContext && typeof trustedAgentContext === 'object' ? trustedAgentContext : {}),
     systemPrompt: [trustedAgentContext?.systemPrompt, clientSystemPrompt].filter(Boolean).join('\n\n'),
     }
    : trustedAgentContext;
   const systemPrompt = truncateUtf8Middle(
    buildSystemPrompt(
     hasVerifiedReplyAgent ? null : memory,
     hasVerifiedReplyAgent ? null : documents,
     hasVerifiedReplyAgent ? null : workspaceContext,
     resolvedAgentContext,
    ),
    AI_CHAT_SYSTEM_MAX_BYTES,
   );

   // Gateway configs route a chat turn at an external OpenAI-compatible endpoint.
   // The browser selects the model id `gateway:<id>`; we call the upstream server
   // directly with the decrypted key and relay its OpenAI SSE chunks unchanged over
   // the same /backend/ai-chat contract the client already speaks.
   if (String(executionModel || '').startsWith('gateway:')) {
    const gatewayId = String(executionModel).slice('gateway:'.length);
    const route = await resolveGatewayRoute(workspaceId, gatewayId);
    if (!route) throw statusError(404, new Error('Gateway is not available'));
    if (!route.baseUrl || !route.model) throw statusError(400, new Error('Gateway is missing a base URL or model'));
    // Re-validate at use time, not just at write time: rows created before this
    // guard existed are still in the table, and a hostname's DNS answer can
    // change after it was accepted.
    try {
     await assertSafeOutboundUrl(route.baseUrl);
    } catch {
     throw statusError(400, new Error(`Gateway ${route.name || route.id} has an unsafe base URL and was not called`));
    }
    const controller = new AbortController();
    let completed = false;
    bindInferenceAbort(req, res, controller, () => completed);
    let upstream;
    try {
     upstream = await fetch(`${route.baseUrl}/chat/completions`, {
      method: 'POST',
      // H1 — never follow redirects: base_url is validated as public at write time,
      // but a permitted host could still 302 this request onto an internal address.
      redirect: 'error',
      signal: controller.signal,
      headers: {
       'Content-Type': 'application/json',
       ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}),
       ...route.headers,
      },
      body: JSON.stringify({
       model: route.model,
       stream: true,
       messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...chat.messages,
       ],
      }),
     });
    } catch (error) {
     completed = true;
     if (controller.signal.aborted) {
      throw statusError(499, new Error('AI request was cancelled before it could reply'));
     }
     throw statusError(502, new Error(`Gateway request failed: ${error?.message || error}`));
    }
    if (!upstream.ok || !upstream.body) {
     completed = true;
     const detail = await upstream.text().catch(() => '');
     throw statusError(
      upstream.status === 401 ? 401 : 502,
      new Error(`Gateway returned ${upstream.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`),
     );
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const decoder = new TextDecoder();
    let streamBuffer = '';
    const collect = (bytes, flush = false) => {
     streamBuffer += decoder.decode(bytes, { stream: !flush });
     const lines = streamBuffer.split('\n');
     streamBuffer = flush ? '' : (lines.pop() ?? '');
     for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
       const parsed = JSON.parse(data);
       streamedReplyError = aiStreamErrorText(parsed) || streamedReplyError;
       streamedReplyContent += streamedText(parsed);
      } catch {
       // A malformed upstream frame is already being relayed as-is; it cannot
       // become a stored assistant message fragment.
      }
     }
    };
    try {
     // The upstream already emits OpenAI `data: {chunk}` SSE framing (including the
     // terminal `data: [DONE]`), so pass its bytes straight through to the client.
     for await (const bytes of upstream.body) {
     collect(bytes);
     res.write(bytes);
    }
    collect(new Uint8Array(), true);
    if (streamedReplyError) throw statusError(502, new Error(streamedReplyError));
    if (replyPersistence) await replyPersistence.finalize(streamedReplyContent);
    } finally {
     completed = true;
    }
    return res.end();
   }

   // Workspace-shared inference routes are first-class chat models. Keep
   // the browser on the same /backend/ai-chat SSE contract while the broker
   // relays OpenAI-compatible chunks over the selected daemon socket.
   if (String(executionModel || '').startsWith(`agensis/${workspaceId}/`)) {
    const routes = await liveSharedModelRoutes(workspaceId);
    const route = routes.find((candidate) => candidate.id === executionModel);
    if (!route) throw statusError(404, new Error(`Shared model '${executionModel}' is not available`));
    const controller = new AbortController();
    let completed = false;
    bindInferenceAbort(req, res, controller, () => completed);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let wroteDelta = false;
    let result;
    try {
     result = await inferenceBroker.request(route, {
      model: executionModel,
      stream: true,
      messages: [
       ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
       ...chat.messages,
      ],
     }, {
      signal: controller.signal,
      onEvent(event) {
       if (event.action !== 'agent_inference_delta' || !event.chunk) return;
       streamedReplyError = aiStreamErrorText(event.chunk) || streamedReplyError;
       wroteDelta = true;
       streamedReplyContent += streamedText(event.chunk);
       res.write(`data: ${JSON.stringify(event.chunk)}\n\n`);
      },
     });
    } finally {
     completed = true;
    }
    if (streamedReplyError) throw statusError(502, new Error(streamedReplyError));
    if (!wroteDelta) {
     const text = result.response?.choices?.[0]?.message?.content;
     if (typeof text === 'string' && text) {
      streamedReplyContent += text;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
     }
    }
    if (replyPersistence) await replyPersistence.finalize(streamedReplyContent);
    res.write('data: [DONE]\n\n');
    return res.end();
   }

   const apiKey = await getAnthropicApiKey(workspaceId);
   if (!apiKey) throw statusError(503, new Error('ANTHROPIC_API_KEY is not configured'));
   const resolvedModel = resolveAnthropicModel(executionModel);

   // Match the gateway/shared-model lanes: a closed browser stream must abort
   // the provider request, otherwise deleting a conversation hides the output
   // while Anthropic keeps generating (and spending) in the background.
   const anthropicController = new AbortController();
   let anthropicCompleted = false;
   bindInferenceAbort(req, res, anthropicController, () => anthropicCompleted);
   let response;
   try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
     method: 'POST',
     signal: anthropicController.signal,
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
      messages: chat.messages,
      system: systemPrompt,
     }),
    });
   } catch (error) {
    if (anthropicController.signal.aborted) {
     throw statusError(499, new Error('AI request was cancelled before it could reply'));
    }
    throw error;
   }

   if (!response.ok || !response.body) {
    throw statusError(response.status, new Error(await response.text()));
   }

   res.setHeader('Content-Type', 'text/event-stream');
   res.setHeader('Cache-Control', 'no-cache');
   res.setHeader('Connection', 'keep-alive');

   const reader = response.body.getReader();
   const decoder = new TextDecoder();
   let buffer = '';
   // The browser only ever sees text deltas — the usage frames are stripped out
   // of the relay. They are read HERE, on the way past, which is the only place
   // this turn's token counts exist at all.
   const usage = createAnthropicUsageAccumulator();
   const consumeAnthropicLine = (line) => {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6);
    if (data === '[DONE]') return;
    try {
     const parsed = JSON.parse(data);
     usage.event(parsed);
     streamedReplyError = aiStreamErrorText(parsed) || streamedReplyError;
     if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      streamedReplyContent += parsed.delta.text;
      res.write(`data: ${JSON.stringify({ delta: { text: parsed.delta.text } })}\n\n`);
     }
    } catch {
     // ignore malformed chunks
    }
   };
   while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // stream:true keeps multibyte chars intact across chunk boundaries.
    buffer += decoder.decode(value, { stream: true });
    // Process only complete lines; keep any trailing partial line buffered
    // so a `data:` event split across reads isn't dropped.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) consumeAnthropicLine(line);
   }
   buffer += decoder.decode();
   for (const line of buffer.split('\n')) consumeAnthropicLine(line);
   // Recorded before res.end() but after the stream drains: a client that
   // disconnects mid-turn still spent whatever the model had already reported.
   await recordAnthropicUsage(dbQuery, {
    workspaceId,
    model: resolvedModel,
    kind: 'ai_chat',
    counts: usage.result(),
   });
   if (streamedReplyError) throw statusError(502, new Error(streamedReplyError));
   if (replyPersistence) await replyPersistence.finalize(streamedReplyContent);
   res.write('data: [DONE]\n\n');
   anthropicCompleted = true;
   res.end();
  } catch (error) {
   const errorText = error?.message || 'AI stream failed';
   if (replyPersistence?.reserved && !replyPersistence.finalized) {
    try {
     await replyPersistence.finalize(errorText);
    } catch (persistError) {
     console.error('[ai-chat] failed to finalize reserved reply:', persistError?.message || persistError);
     try {
      await replyPersistence.abort();
     } catch (abortError) {
      console.error('[ai-chat] failed to remove reserved reply:', abortError?.message || abortError);
     }
    }
   }
   // Once the SSE headers/body have started flushing, the status line is
   // already sent — calling jsonError() here would throw ERR_HTTP_HEADERS_SENT
   // and leave the client with a truncated stream and no terminator. Emit the
   // failure as an SSE frame followed by [DONE] so the client ends cleanly.
   if (res.headersSent) {
    try {
     res.write(`data: ${JSON.stringify({ error: errorText })}\n\n`);
     res.write('data: [DONE]\n\n');
    } catch { /* socket already gone */ }
    res.end();
   } else {
    jsonError(res, error.status || 500, error);
   }
  }
 });
}

module.exports = { mountAiChatRoutes };
