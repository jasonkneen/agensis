'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Orbs: inbound webhooks that turn an external event (a GitHub delivery, say)
// into an agent turn.
//
// UNAUTHENTICATED BY DESIGN — the caller is GitHub, not a person — so the
// signature IS the authorization. verifyOrbDelivery runs before anything else
// touches the body, and an unverifiable delivery fails CLOSED with 503 rather
// than falling through to an unsigned path.
//
// Two protections that look similar and are not: the hourly cap counts only
// ACCEPTED deliveries, so a throttled orb can recover; the dedupe claim is keyed
// on the provider's delivery id. The throttle runs first, deliberately, so a
// flood cannot turn dedupe bookkeeping into write amplification.
//
// The turn is dispatched through continueConversation and NOT awaited: awaiting
// it pushed the response past GitHub's delivery timeout. The 202 is an
// acknowledgement, not the answer.

function mountOrbWebhooksRoutes(app, deps = {}) {
 const {
  jsonError, getDb, notifyDbSubscribers, rateLimitBlocked, clientIpFromReq,
  parseJsonArray, slugHandle, isAgentEnabled, ORB_MAX_BODY_BYTES,
  composeOrbMessage, continueConversation,
  findOrCreateDirectSession, getWorkspaceSecretValue,
  inviteTokenLookupParams, logOrbRejection, normalizeAgentPermissionMode,
  normalizeOrbProvider, normalizeOrbRateLimit, normalizeOrbRouting,
  orbDispatchRefusal, orbSecretKey, parseOrbBody,
  verifyOrbDelivery, webhookRateLimiter,
 } = deps;

 app.post('/backend/webhooks/:token', async (req, res) => {
  const nowMs = Date.now();
  try {
   // No userId/workspaceId is known before the token lookup, so rate-limit by
   // caller IP (needs a trusted x-forwarded-for behind a proxy; falls back to the
   // socket address). This is NOT sufficient on its own for an orb — every GitHub
   // delivery arrives from GitHub's own address space, which is why there is a
   // per-orb hourly cap further down.
   if (rateLimitBlocked(res, webhookRateLimiter, clientIpFromReq(req))) return;

   // A signature is only meaningful over bytes we kept. express.json's `verify`
   // hook populates req.rawBody and only runs for JSON, so a webhook configured
   // as application/x-www-form-urlencoded arrives with no rawBody and fails
   // closed on its own — but say so explicitly, or the operator spends an
   // afternoon debugging a signature mismatch that is really a content-type
   // mismatch.
   if (!String(req.get('content-type') || '').toLowerCase().includes('application/json')) {
    return jsonError(res, 415, new Error('Orb deliveries must be sent with Content-Type: application/json'));
   }
   const rawBody = req.rawBody;
   if (!Buffer.isBuffer(rawBody)) {
    return jsonError(res, 400, new Error('Orb delivery body could not be read as raw bytes'));
   }
   // express.json's global limit is 50mb, which is right for uploads and absurd
   // for an unauthenticated webhook.
   if (rawBody.length > ORB_MAX_BODY_BYTES) {
    return jsonError(res, 413, new Error(`Orb delivery body exceeds ${ORB_MAX_BODY_BYTES} bytes`));
   }

   const token = String(req.params.token || '');
   const rows = await getDb().unsafe(
    'select * from agent_webhooks where token in ($1, $2) and enabled = true limit 1',
    inviteTokenLookupParams(token),
   );
   const orb = rows[0];
   if (!orb) return jsonError(res, 404, new Error('Webhook not found'));

   // An orb with no agent used to fall through to a promptless built-in
   // completion that went nowhere. There is nothing to wake, so say so.
   if (!orb.agent_id) {
    return jsonError(res, 400, new Error('This webhook has no agent assigned — assign one before triggering it'));
   }
   const agentRows = await getDb().unsafe(
    'select * from workspace_agents where id = $1 and workspace_id = $2 limit 1',
    [orb.agent_id, orb.workspace_id],
   );
   const agent = agentRows[0];
   if (!agent) return jsonError(res, 404, new Error('The agent this webhook points at no longer exists'));
   if (!isAgentEnabled(agent)) return jsonError(res, 400, new Error('The agent this webhook points at is deactivated'));

   const provider = normalizeOrbProvider(orb.provider);
   const secret = await getWorkspaceSecretValue(orb.workspace_id, orbSecretKey(orb.id));
   const verdict = verifyOrbDelivery({ provider, secret, rawBody, headers: req.headers, nowMs });
   if (!verdict.ok) {
    await logOrbRejection({
     orb,
     status: 'rejected',
     bodyHash: verdict.bodyHash,
     eventType: verdict.eventType,
     detail: verdict.reason,
    });
    // Fail closed on a misconfiguration rather than degrading to "unsigned":
    // mirrors the huddles webhook returning 503 when the LiveKit keys are unset.
    if (verdict.reason === 'unconfigured') {
     return jsonError(res, 503, new Error(
      `This orb's provider (${provider}) requires a signing secret and none is configured, `
      + 'so the delivery cannot be verified. Nothing was run.',
     ));
    }
    return jsonError(res, 401, new Error('Invalid signature'));
   }

   // The real bound on a successful prompt injection is not the fence in the
   // composed message, it is the permission mode the agent runs at. An
   // unauthenticated HTTP request must not reach a --no-sandbox --yolo run.
   const refusal = orbDispatchRefusal({
    signatureVerified: verdict.signatureVerified,
    agentPermissionMode: normalizeAgentPermissionMode(agent.permission_mode),
   });
   if (refusal) {
    await logOrbRejection({
     orb,
     status: 'rejected',
     bodyHash: verdict.bodyHash,
     eventType: verdict.eventType,
     detail: 'unsigned orb, elevated agent permissions',
    });
    return jsonError(res, 403, new Error(refusal));
   }

   // Per-orb hourly cap, checked BEFORE the dedupe claim. Order matters: a
   // throttled delivery must not consume its (webhook_id, delivery_key)
   // idempotency slot, or the provider's legitimate retry an hour later would be
   // answered "duplicate" and silently dropped.
   //
   // Only 'accepted' rows count. If throttled rows counted toward their own
   // limit, an orb over its cap could never recover — every refusal would extend
   // the window that caused it.
   const limit = normalizeOrbRateLimit(orb.rate_limit_per_hour);
   const usage = await getDb().unsafe(
    `select count(*)::int as used from orb_deliveries
       where webhook_id = $1 and status = 'accepted' and created_at > now() - interval '1 hour'`,
    [orb.id],
   );
   if (Number(usage[0]?.used || 0) >= limit) {
    await logOrbRejection({
     orb,
     status: 'throttled',
     bodyHash: verdict.bodyHash,
     eventType: verdict.eventType,
     detail: `exceeded ${limit} deliveries/hour`,
    });
    return jsonError(res, 429, new Error(`This orb has reached its limit of ${limit} deliveries per hour`));
   }

   // Deduplication. DB-level, not the process-local claimTaskDispatch map: a
   // provider retry can arrive minutes later, after a Fly restart, or on a second
   // machine, none of which an in-memory window can see.
   let delivery = null;
   if (verdict.deliveryKey) {
    // Exact path — the provider gave us a delivery id. This is also GitHub's
    // replay guard, since GitHub does not timestamp its signature.
    const claimed = await getDb().unsafe(
     `insert into orb_deliveries (webhook_id, workspace_id, delivery_key, body_hash, event_type)
          values ($1, $2, $3, $4, $5)
          on conflict (webhook_id, delivery_key) where delivery_key is not null do nothing
          returning *`,
     [orb.id, orb.workspace_id, verdict.deliveryKey, verdict.bodyHash, verdict.eventType],
    );
    // 200, not a 4xx: a 4xx tells the provider to keep retrying a delivery that
    // has already been handled.
    if (!claimed[0]) return res.status(200).json({ data: { duplicate: true }, error: null });
    delivery = claimed[0];
   } else {
    // Best-effort windowed path — no provider delivery id. Deliberately NOT a
    // unique constraint on body_hash: two genuinely distinct events can be
    // byte-identical (a bare "deploy finished" ping) and a hard constraint would
    // drop the second one forever. Send an Idempotency-Key to get the exact path.
    const recent = await getDb().unsafe(
     `select id from orb_deliveries
        where webhook_id = $1 and delivery_key is null and body_hash = $2
          and status = 'accepted' and created_at > now() - interval '10 minutes'
        limit 1`,
     [orb.id, verdict.bodyHash],
    );
    if (recent[0]) return res.status(200).json({ data: { duplicate: true }, error: null });
    const inserted = await getDb().unsafe(
     `insert into orb_deliveries (webhook_id, workspace_id, delivery_key, body_hash, event_type)
          values ($1, $2, null, $3, $4) returning *`,
     [orb.id, orb.workspace_id, verdict.bodyHash, verdict.eventType],
    );
    delivery = inserted[0];
   }

   const handle = slugHandle(agent.handle || agent.name);
   const { content } = composeOrbMessage({
    orbName: orb.name,
    agentHandle: handle,
    prompt: orb.prompt,
    provider,
    eventType: verdict.eventType,
    deliveryKey: verdict.deliveryKey || '',
    signatureVerified: verdict.signatureVerified,
    receivedAt: new Date(nowMs).toISOString(),
    body: parseOrbBody(rawBody),
    payloadFields: parseJsonArray(orb.payload_fields),
   });

   const routing = normalizeOrbRouting(orb.routing);
   let session = null;
   let threadParentId = null;
   if (routing === 'thread') {
    session = await findOrCreateDirectSession(orb.workspace_id, agent);
    if (session && orb.thread_root_message_id) {
     // Messages are SOFT-deleted, so the FK alone does not prove the root is
     // still there — without the deleted_at check the thread reattaches to a
     // message the human removed.
     const rootRows = await getDb().unsafe(
      'select id from messages where id = $1 and session_id = $2 and deleted_at is null limit 1',
      [orb.thread_root_message_id, session.id],
     );
     threadParentId = rootRows[0]?.id || null;
    }
   }
   if (!session) {
    const sessionRows = await getDb().unsafe(
     `insert into chat_sessions (workspace_id, title, model, folder)
          values ($1, $2, $3, $4)
          returning *`,
     [orb.workspace_id, `Webhook: ${orb.name}`, agent.model || 'auto', 'Webhooks'],
    );
    session = sessionRows[0];
    notifyDbSubscribers('chat_sessions', 'INSERT', sessionRows);
   }

   // sender_kind 'system' / sender_name 'Orb' matches what the schedule runner
   // already does with 'system'/'Schedule', so the UI never attributes an
   // external event to a person.
   const messageRows = await getDb().unsafe(
    `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_name)
         values ($1, 'user', $2, $3, 'system', 'Orb')
         returning *`,
    [session.id, content, threadParentId],
   );
   notifyDbSubscribers('messages', 'INSERT', messageRows);
   const messageRow = messageRows[0] || null;
   // Follow postTaskSubthreadMention: the FIRST message becomes its own
   // subthread root, so the agent's reply lands in the thread instead of
   // scattering across the DM timeline.
   if (routing === 'thread' && !threadParentId) threadParentId = messageRow?.id || null;

   const orbRows = routing === 'thread'
    ? await getDb().unsafe(
     `update agent_webhooks
           set last_triggered_at = now(), updated_at = now(),
               session_id = $2, thread_root_message_id = $3
         where id = $1 returning *`,
     [orb.id, session.id, threadParentId],
    )
    : await getDb().unsafe(
     'update agent_webhooks set last_triggered_at = now(), updated_at = now() where id = $1 returning *',
     [orb.id],
    );
   if (orbRows[0]) notifyDbSubscribers('agent_webhooks', 'UPDATE', orbRows);

   const deliveryRows = await getDb().unsafe(
    'update orb_deliveries set session_id = $2, message_id = $3 where id = $1 returning *',
    [delivery.id, session.id, messageRow?.id || null],
   );
   notifyDbSubscribers('orb_deliveries', 'INSERT', deliveryRows.length > 0 ? deliveryRows : [delivery]);

   // Fire and DO NOT await. continueConversation is the only door into real
   // dispatch: it is what routes to a daemon or sandbox agent, takes the
   // per-thread conversation lock, honours max_agent_turns and writes the
   // agent_jobs row. Awaiting it is what used to push the response past GitHub's
   // delivery timeout.
   continueConversation({ workspaceId: orb.workspace_id, sessionId: session.id, threadParentId })
    .catch((error) => console.error('orb dispatch failed', error?.message || error));

   // 202, not 200-with-the-answer. This is an intentional break from the old
   // response shape ({ session, userMessage, assistantMessage } after the model
   // finished) because that shape is what caused the retries.
   res.status(202).json({
    data: {
     deliveryId: delivery.id,
     sessionId: session.id,
     threadParentId,
     messageId: messageRow?.id || null,
     signatureVerified: verdict.signatureVerified,
     duplicate: false,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, 500, error);
  }
 });
}

module.exports = { mountOrbWebhooksRoutes };
