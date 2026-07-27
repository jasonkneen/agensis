'use strict';

const crypto = require('crypto');

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Agent webhooks (orb configuration) and the Netlify deploy hook.
//
// The deploy hook is unauthenticated in the usual sense — Netlify signs it with
// a JWS whose payload carries a SHA-256 of the exact request body, so
// verifyNetlifyDeploySignature needs the UNTOUCHED bytes. That is why index.cjs
// captures rawBody in its express.json verify callback; parsing discards them.
//
// Orb secrets are written to the workspace vault under orb:<webhook id> and
// never returned — the list reports only whether one is configured.

function mountAgentWebhooksRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, notifyDbSubscribers,
  broadcastGlobal, hashAgentToken, normalizeOrbConfigInput, orbSecretKey, setWorkspaceSecretValue,
  verifyNetlifyDeploySignature,  } = deps;

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
   // Orb config is optional on create (an omitted field keeps the column default,
   // which reproduces the pre-orb behaviour) but must be settable here, or an orb
   // created while the config route is unreachable comes back generic/unsigned
   // with no prompt and the operator cannot tell why.
   const config = normalizeOrbConfigInput(req.body || {});
   const rows = await getDb().unsafe(
    `insert into agent_webhooks
         (workspace_id, agent_id, name, token, provider, prompt, payload_fields, routing, rate_limit_per_hour)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         returning *`,
    [
     workspaceId,
     agentId || null,
     String(name).trim(),
     hashAgentToken(token),
     config.provider,
     config.prompt,
     config.payloadFields,
     config.routing,
     config.rateLimitPerHour,
    ],
   );
   notifyDbSubscribers('agent_webhooks', 'INSERT', rows);
   res.json({ data: { ...rows[0], token }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Orb configuration (plans/021). Guards are deliberately identical to the create
 // route above — requireAuth plus enforceWorkspaceRole(..., 'manage') — rather
 // than a new limiter: 'manage' is already the access level agent_webhooks
 // carries in DB_TABLE_ACCESS, and the only unauthenticated surface in this
 // feature is the trigger route, which has webhookRateLimiter plus its own
 // per-orb hourly cap.
 //
 // `signing_secret` is WRITE-ONLY. It goes to the workspace vault, never to a
 // column on agent_webhooks (which the frontend reads with select('*')), and is
 // never returned. An empty string clears it.
 app.put('/backend/agent-webhooks/:id', requireAuth, async (req, res) => {
  try {
   const webhookId = String(req.params.id || '').trim();
   if (!webhookId) return jsonError(res, 400, new Error('webhook id is required'));
   const existing = await getDb().unsafe('select * from agent_webhooks where id = $1 limit 1', [webhookId]);
   const orb = existing[0];
   if (!orb) return jsonError(res, 404, new Error('Webhook not found'));
   await enforceWorkspaceRole(req.userId, orb.workspace_id, 'manage');

   const config = normalizeOrbConfigInput(req.body || {}, orb);
   let hasSecret = orb.has_signing_secret === true;
   if (typeof req.body?.signing_secret === 'string') {
    const secret = req.body.signing_secret.trim();
    if (secret && secret.length < 16) {
     return jsonError(res, 400, new Error('A signing secret must be at least 16 characters'));
    }
    await setWorkspaceSecretValue(
     orb.workspace_id,
     orbSecretKey(orb.id),
     secret,
     req.userId,
     `Signing secret for orb "${String(orb.name || '').slice(0, 80)}"`,
    );
    hasSecret = Boolean(secret);
   }
   // A non-generic provider with no secret can never verify a delivery, so the
   // trigger route answers 503. Refuse the configuration that guarantees that
   // instead of letting the operator discover it from a provider's retry log.
   if (config.provider !== 'generic' && !hasSecret) {
    return jsonError(res, 400, new Error(
     `Provider "${config.provider}" signs its deliveries, so this orb needs a signing secret. `
     + 'Set signing_secret in the same request, or leave the provider as generic.',
    ));
   }

   const name = typeof req.body?.name === 'string' && req.body.name.trim()
    ? req.body.name.trim().slice(0, 200)
    : orb.name;
   const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : orb.enabled;
   const rows = await getDb().unsafe(
    `update agent_webhooks
          set name = $2, enabled = $3, provider = $4, prompt = $5, payload_fields = $6::jsonb,
              routing = $7, rate_limit_per_hour = $8, has_signing_secret = $9, updated_at = now()
        where id = $1
        returning *`,
    [
     orb.id,
     name,
     enabled,
     config.provider,
     config.prompt,
     config.payloadFields,
     config.routing,
     config.rateLimitPerHour,
     hasSecret,
    ],
   );
   notifyDbSubscribers('agent_webhooks', 'UPDATE', rows);
   res.json({ data: rows[0], error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountAgentWebhooksRoutes };
