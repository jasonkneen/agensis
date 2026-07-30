'use strict';

const crypto = require('crypto');

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Agent webhooks and the Netlify deploy hook.
//
// The deploy hook is unauthenticated in the usual sense — Netlify signs it with
// a JWS whose payload carries a SHA-256 of the exact request body, so
// verifyNetlifyDeploySignature needs the UNTOUCHED bytes. That is why index.cjs
// captures rawBody in its express.json verify callback; parsing discards them.
function mountAgentWebhooksRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, notifyDbSubscribers,
  broadcastGlobal, clientIpFromReq, continueConversation, hashAgentToken,
  inviteTokenLookupParams, rateLimitBlocked, slugHandle,
  verifyNetlifyDeploySignature, webhookRateLimiter,
 } = deps;

 app.post('/backend/netlify-deploy-hook', (req, res) => {
  try {
   const secret = process.env.NETLIFY_WEBHOOK_JWS_SECRET || '';
   const signature = req.get('X-Webhook-Signature') || req.get('x-webhook-signature') || '';
   if (secret) {
    if (!verifyNetlifyDeploySignature(signature, req.rawBody, secret)) {
     return res.status(401).json({ data: null, error: 'Invalid signature' });
    }
   } else if (process.env.NODE_ENV === 'production') {
    // Fail closed in production: unsigned deploy webhooks would let anyone
    // spoof "new version — reload" to all connected clients.
    console.error('[netlify-hook] NETLIFY_WEBHOOK_JWS_SECRET not set — rejecting (production fail-closed)');
    return res.status(503).json({
     data: null,
     error: 'Deploy webhook secret is not configured',
    });
   } else {
    // Dev/test only: accept so local wiring works before the secret is set.
    console.warn('[netlify-hook] NETLIFY_WEBHOOK_JWS_SECRET not set — accepting unsigned deploy webhook (non-production)');
   }

   const deploy = req.body || {};
   // Netlify's "Deploy succeeded" event is the published-and-live signal; its body
   // reports state 'ready'. If some other event is wired here, only broadcast on a
   // ready/published state so we never nag on a build-started or failed hook.
   const state = typeof deploy.state === 'string' ? deploy.state.toLowerCase() : '';
   const isPublished = state === '' || state === 'ready' || state === 'current';
   if (!isPublished) {
    return res.status(200).json({ data: { ignored: true, state }, error: null });
   }

   const payload = {
    commit: deploy.commit_ref || deploy.commit_url || null,
    branch: deploy.branch || null,
    site: deploy.name || null,
    url: deploy.deploy_ssl_url || deploy.ssl_url || deploy.url || null,
    at: deploy.published_at || deploy.updated_at || null,
   };
   const delivered = broadcastGlobal({ type: 'system', event: 'deploy_published', payload });
   console.log(`[netlify-hook] deploy_published broadcast to ${delivered} client(s)`, payload.commit || '');
   return res.status(200).json({ data: { broadcast: delivered }, error: null });
  } catch (error) {
   // Never 500 on Netlify's own request — that risks the hook being auto-disabled.
   console.error('[netlify-hook] handler error', error);
   return res.status(200).json({ data: { error: 'handled' }, error: null });
  }
 });

 app.post('/backend/agent-webhooks', requireAuth, async (req, res) => {
  try {
   const { workspace_id: workspaceId, agent_id: agentId, name } = req.body || {};
   if (!workspaceId || !name) return jsonError(res, 400, new Error('workspace_id and name are required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   if (agentId) {
    const agentRows = await getDb().unsafe(
     'select id from workspace_agents where id = $1 and workspace_id = $2 limit 1',
     [agentId, workspaceId],
    );
    if (!agentRows[0]) return jsonError(res, 404, new Error('Agent not found in this workspace'));
   }
   // F10: store only the hash — the trigger route below does a dual-path lookup
   // (inviteTokenLookupParams) so legacy plaintext rows keep working during the
   // transition. The plaintext is returned ONCE here, on creation.
   const token = crypto.randomBytes(32).toString('base64url');
   const rows = await getDb().unsafe(
    `insert into agent_webhooks (workspace_id, agent_id, name, token)
         values ($1, $2, $3, $4)
         returning *`,
    [workspaceId, agentId || null, String(name).trim(), hashAgentToken(token)],
   );
   notifyDbSubscribers('agent_webhooks', 'INSERT', rows);
   res.json({ data: { ...rows[0], token }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // The URL token is the credential for this generic integration. Deliveries are
 // translated into normal conversation work so daemon-backed agents (including
 // the Amp runtime) run through the same job/streaming path as an in-app message.
 app.post('/backend/webhooks/:token', async (req, res) => {
  try {
   if (rateLimitBlocked(res, webhookRateLimiter, clientIpFromReq(req))) return;
   const token = String(req.params.token || '');
   const rows = await getDb().unsafe(
    `select w.*,
            a.id as agent_row_id,
            a.name as agent_name,
            a.handle as agent_handle,
            a.model,
            a.enabled as agent_enabled
       from agent_webhooks w
       left join workspace_agents a on a.id = w.agent_id
      where w.token in ($1, $2) and w.enabled = true
      limit 1`,
    inviteTokenLookupParams(token),
   );
   const webhook = rows[0];
   if (!webhook) return jsonError(res, 404, new Error('Webhook not found'));
   if (!webhook.agent_row_id || webhook.agent_enabled === false) {
    return jsonError(res, 409, new Error('Webhook is not connected to an enabled agent'));
   }

   const prompt = String(
    req.body?.prompt || req.body?.text || req.body?.message || JSON.stringify(req.body || {}),
   ).trim();
   if (!prompt) return jsonError(res, 400, new Error('Webhook payload did not include prompt, text, or message'));

   const handle = slugHandle(webhook.agent_handle || webhook.agent_name);
   const sessionRows = await getDb().unsafe(
    `insert into chat_sessions (workspace_id, title, model, folder)
         values ($1, $2, $3, 'Webhooks')
         returning *`,
    [webhook.workspace_id, `Webhook: ${webhook.name}`, webhook.model || 'auto'],
   );
   const session = sessionRows[0];
   const messageRows = await getDb().unsafe(
    `insert into messages (session_id, role, content, sender_kind, sender_name)
         values ($1, 'user', $2, 'system', 'Webhook')
         returning *`,
    [session.id, `@${handle} ${prompt}`],
   );
   const webhookRows = await getDb().unsafe(
    'update agent_webhooks set last_triggered_at = now(), updated_at = now() where id = $1 returning *',
    [webhook.id],
   );
   notifyDbSubscribers('chat_sessions', 'INSERT', sessionRows);
   notifyDbSubscribers('messages', 'INSERT', messageRows);
   if (webhookRows[0]) notifyDbSubscribers('agent_webhooks', 'UPDATE', webhookRows);

   continueConversation({ workspaceId: webhook.workspace_id, sessionId: session.id })
    .catch((error) => console.error('webhook dispatch failed', error?.message || error));

   res.status(202).json({
    data: {
     sessionId: session.id,
     messageId: messageRows[0]?.id || null,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountAgentWebhooksRoutes };
