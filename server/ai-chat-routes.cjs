'use strict';

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
  // Metering. This route is one of three Anthropic spend points on the Fly lane
  // (the others are runAnthropicCompletion and streamAnthropicTurn), and
  // tests/usage-metering.test.cjs counts all three across the lane.
  recordAnthropicUsage, createAnthropicUsageAccumulator,
 } = deps;

 app.post('/backend/ai-chat', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, aiChatRateLimiter, aiChatDbRateLimiter, req.userId || clientIpFromReq(req))) return;
   const { messages, model, memory, documents, workspaceContext, agentContext, workspaceId } = req.body || {};
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'run_agents');
   const chat = normalizeAiChatMessages(messages);
   const resolvedAgentContext = chat.systemPrompt
    ? {
     ...(agentContext && typeof agentContext === 'object' ? agentContext : {}),
     systemPrompt: [agentContext?.systemPrompt, chat.systemPrompt].filter(Boolean).join('\n\n'),
    }
    : agentContext;
   const systemPrompt = buildSystemPrompt(memory, documents, workspaceContext, resolvedAgentContext);

   // Gateway configs route a chat turn at an external OpenAI-compatible endpoint.
   // The browser selects the model id `gateway:<id>`; we call the upstream server
   // directly with the decrypted key and relay its OpenAI SSE chunks unchanged over
   // the same /backend/ai-chat contract the client already speaks.
   if (String(model || '').startsWith('gateway:')) {
    const gatewayId = String(model).slice('gateway:'.length);
    const route = await resolveGatewayRoute(workspaceId, gatewayId);
    if (!route) return jsonError(res, 404, new Error('Gateway is not available'));
    if (!route.baseUrl || !route.model) return jsonError(res, 400, new Error('Gateway is missing a base URL or model'));
    // Re-validate at use time, not just at write time: rows created before this
    // guard existed are still in the table, and a hostname's DNS answer can
    // change after it was accepted.
    try {
     await assertSafeOutboundUrl(route.baseUrl);
    } catch {
     return jsonError(res, 400, new Error(`Gateway ${route.name || route.id} has an unsafe base URL and was not called`));
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
     if (controller.signal.aborted) { try { res.end(); } catch { /* client gone */ } return; }
     return jsonError(res, 502, new Error(`Gateway request failed: ${error?.message || error}`));
    }
    if (!upstream.ok || !upstream.body) {
     completed = true;
     const detail = await upstream.text().catch(() => '');
     return jsonError(res, upstream.status === 401 ? 401 : 502, new Error(`Gateway returned ${upstream.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`));
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
     // The upstream already emits OpenAI `data: {chunk}` SSE framing (including the
     // terminal `data: [DONE]`), so pass its bytes straight through to the client.
     for await (const bytes of upstream.body) {
      res.write(bytes);
     }
    } finally {
     completed = true;
    }
    return res.end();
   }

   // Workspace-shared inference routes are first-class chat models. Keep
   // the browser on the same /backend/ai-chat SSE contract while the broker
   // relays OpenAI-compatible chunks over the selected daemon socket.
   if (String(model || '').startsWith(`agensis/${workspaceId}/`)) {
    const routes = await liveSharedModelRoutes(workspaceId);
    const route = routes.find((candidate) => candidate.id === model);
    if (!route) return jsonError(res, 404, new Error(`Shared model '${model}' is not available`));
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
      model,
      stream: true,
      messages: [
       ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
       ...chat.messages,
      ],
     }, {
      signal: controller.signal,
      onEvent(event) {
       if (event.action !== 'agent_inference_delta' || !event.chunk) return;
       wroteDelta = true;
       res.write(`data: ${JSON.stringify(event.chunk)}\n\n`);
      },
     });
    } finally {
     completed = true;
    }
    if (!wroteDelta) {
     const text = result.response?.choices?.[0]?.message?.content;
     if (typeof text === 'string' && text) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
     }
    }
    res.write('data: [DONE]\n\n');
    return res.end();
   }

   const apiKey = await getAnthropicApiKey(workspaceId);
   if (!apiKey) return jsonError(res, 503, new Error('ANTHROPIC_API_KEY is not configured'));
   const resolvedModel = resolveAnthropicModel(model);

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
     messages: chat.messages,
     system: systemPrompt,
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
   // The browser only ever sees text deltas — the usage frames are stripped out
   // of the relay. They are read HERE, on the way past, which is the only place
   // this turn's token counts exist at all.
   const usage = createAnthropicUsageAccumulator();
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
      usage.event(parsed);
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
       res.write(`data: ${JSON.stringify({ delta: { text: parsed.delta.text } })}\n\n`);
      }
     } catch {
      // ignore malformed chunks
     }
    }
   }
   // Recorded before res.end() but after the stream drains: a client that
   // disconnects mid-turn still spent whatever the model had already reported.
   await recordAnthropicUsage(dbQuery, {
    workspaceId,
    model: resolvedModel,
    kind: 'ai_chat',
    counts: usage.result(),
   });
   res.end();
  } catch (error) {
   // Once the SSE headers/body have started flushing, the status line is
   // already sent — calling jsonError() here would throw ERR_HTTP_HEADERS_SENT
   // and leave the client with a truncated stream and no terminator. Emit the
   // failure as an SSE frame followed by [DONE] so the client ends cleanly.
   if (res.headersSent) {
    try {
     res.write(`data: ${JSON.stringify({ error: error?.message || 'AI stream failed' })}\n\n`);
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
