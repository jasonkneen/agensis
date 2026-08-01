'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// CursorBuddy pairing: the connection keys a browser extension or editor plugin
// claims to become an agent in a workspace.
//
// The claim route is the interesting one and is deliberately UNAUTHENTICATED —
// the caller has no session yet, only the key. That is why the key is stored
// hashed (hashAgentToken), why claiming is single-use, and why the response is
// the only place its agent token is ever rendered.
//
// Everything else here is manage-role: minting a key, listing keys (never their
// secrets), and provisioning the provider agent a key maps to.

function mountCursorbuddyRoutes(app, deps = {}) {
 const {
 requireAuth, jsonError, enforceWorkspaceRole, getDb, notifyDbSubscribers,
  clientIpFromReq, cursorBuddyGuidesDbRateLimiter,
  cursorBuddyGuidesRateLimiter, dbQuery, dbRateLimitBlocked,
  createOwnedGuide, deleteOwnedGuide, listCommunityGuides,
  listOwnedGuides, resolveCommunityGuide, submitOwnedGuide,
  updateOwnedGuide,
  parseJsonArray, parseJsonObject, agentRuntimePayload,
  buildAgentConnectionCommand, createCursorBuddyConnectionKey,
  ensureCursorBuddyAgentForKey, ensureCursorBuddyProviderAgent,
  hashAgentToken, normalizeAgentBackendBaseUrl, normalizeCursorBuddyDomain,
  normalizeCursorBuddyScope, normalizeCursorBuddySurface,
  publicCursorBuddyConnectionKey, requestBaseUrl, shellQuote,
 } = deps;

 app.get('/backend/cursorbuddy/guides/community', async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, clientIpFromReq(req))) return;
   res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
   res.json({ data: await listCommunityGuides(dbQuery), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/cursorbuddy/guides/resolve', async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, clientIpFromReq(req))) return;
   const guide = await resolveCommunityGuide(dbQuery, req.query.url);
   res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
   res.json({ data: guide, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/cursorbuddy/guides', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, req.userId)) return;
   res.json({ data: await listOwnedGuides(dbQuery, req.userId), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/cursorbuddy/guides', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, req.userId)) return;
   res.status(201).json({ data: await createOwnedGuide(dbQuery, req.userId, req.body), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.patch('/backend/cursorbuddy/guides/:id', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, req.userId)) return;
   res.json({ data: await updateOwnedGuide(dbQuery, req.userId, req.params.id, req.body), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/cursorbuddy/guides/:id', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, req.userId)) return;
   res.json({ data: await deleteOwnedGuide(dbQuery, req.userId, req.params.id), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/cursorbuddy/guides/:id/submit', requireAuth, async (req, res) => {
  try {
   if (await dbRateLimitBlocked(res, cursorBuddyGuidesRateLimiter, cursorBuddyGuidesDbRateLimiter, req.userId)) return;
   res.json({ data: await submitOwnedGuide(dbQuery, req.userId, req.params.id), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/cursorbuddy/connection-keys', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.query.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const rows = await getDb().unsafe(
    `select *
         from cursorbuddy_connection_keys
         where workspace_id = $1
         order by created_at desc
         limit 100`,
    [workspaceId],
   );
   res.json({ data: rows.map(publicCursorBuddyConnectionKey), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/cursorbuddy/connection-keys', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.body?.workspaceId || req.body?.workspace_id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');

   const agentId = String(req.body?.agentId || req.body?.agent_id || '').trim() || null;
   if (agentId) {
    const agentRows = await getDb().unsafe(
     'select id from workspace_agents where id = $1 and workspace_id = $2 limit 1',
     [agentId, workspaceId],
    );
    if (!agentRows[0]) return jsonError(res, 404, new Error('Agent not found in this workspace'));
   }

   const surface = normalizeCursorBuddySurface(req.body?.surface);
   const scope = normalizeCursorBuddyScope(req.body?.scope);
   const domain = normalizeCursorBuddyDomain(req.body?.domain);
   const name = String(req.body?.name || 'CursorBuddy runtime').trim().slice(0, 80) || 'CursorBuddy runtime';
   const requestMetadata = parseJsonObject(req.body?.metadata);
   const metadata = {
    ...requestMetadata,
    requestedBy: req.userId,
    setup: 'cursorbuddy',
    runtimeKind: String(req.body?.runtimeKind || '').trim().slice(0, 80),
   };
   const key = createCursorBuddyConnectionKey(surface);
   const rows = await getDb().unsafe(
    `insert into cursorbuddy_connection_keys
           (workspace_id, agent_id, created_by, key_hash, name, surface, scope, domain, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         returning *`,
    [workspaceId, agentId, req.userId, hashAgentToken(key), name, surface, scope, domain, metadata],
   );
   notifyDbSubscribers('cursorbuddy_connection_keys', 'INSERT', rows.map(publicCursorBuddyConnectionKey));
   res.json({
    data: {
     ...publicCursorBuddyConnectionKey(rows[0]),
     key,
     command: `agensis buddy connect --key ${shellQuote(key)}`,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/cursorbuddy/provider-agent', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.body?.workspaceId || req.body?.workspace_id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
   const agent = await ensureCursorBuddyProviderAgent({
    workspaceId,
    userId: req.userId,
    body: req.body || {},
   });
   const providerTool = parseJsonArray(agent.tools).find(tool => tool?.type === 'provider' && tool?.name === 'cursorbuddy');
   const providerMetadata = {
    ...parseJsonObject(providerTool?.metadata),
    ...parseJsonObject(parseJsonObject(agent.metadata).cursorbuddyProvider),
   };
   res.json({
    data: {
     workspaceId,
     workspace_id: workspaceId,
     agentId: agent.id,
     agent_id: agent.id,
     provider: 'cursorbuddy',
     mode: 'built_in_provider',
     providerScope: providerMetadata.providerScope || '',
     domain: providerMetadata.domain || '',
     agent: agentRuntimePayload(agent),
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/cursorbuddy/connection-keys/claim', async (req, res) => {
  try {
   const key = String(req.body?.key || '').trim();
   if (!/^cbk_[a-z0-9_]+_[A-Z2-9]{18}$/.test(key)) return jsonError(res, 400, new Error('A valid CursorBuddy connection key is required'));
   const rows = await getDb().unsafe(
    'select * from cursorbuddy_connection_keys where key_hash = $1 limit 1',
    [hashAgentToken(key)],
   );
   const record = rows[0];
   if (!record) return jsonError(res, 404, new Error('CursorBuddy connection key not found'));
   if (record.status === 'claimed') return jsonError(res, 409, new Error('CursorBuddy connection key has already been claimed'));
   if (record.status === 'revoked') return jsonError(res, 410, new Error('CursorBuddy connection key was revoked'));
   if (record.status === 'expired' || (record.expires_at && new Date(record.expires_at) < new Date())) {
    await getDb().unsafe(
     `update cursorbuddy_connection_keys
           set status = 'expired', updated_at = now()
           where id = $1 and status = 'created'`,
     [record.id],
    );
    return jsonError(res, 410, new Error('CursorBuddy connection key has expired'));
   }

   const claim = {
    host: req.body?.host,
    cwd: req.body?.cwd,
    name: req.body?.name,
    surface: req.body?.surface,
    scope: req.body?.scope,
    permissionMode: req.body?.permissionMode || req.body?.permission_mode,
   };
   const agent = await ensureCursorBuddyAgentForKey(record, claim);
   const baseUrl = normalizeAgentBackendBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
    || normalizeAgentBackendBaseUrl(req.body?.baseUrl)
    || normalizeAgentBackendBaseUrl(requestBaseUrl(req));
   const payload = await buildAgentConnectionCommand({
    agentId: agent.id,
    workspaceId: record.workspace_id,
    handle: agent.handle || agent.name,
    model: req.body?.model || agent.model,
    // Unauthenticated claim path must not escalate permission_mode from the
    // request body. Stored agent mode only; manage sets mode before mint.
    permissionMode: null,
    allowPermissionModeChange: false,
    baseUrl,
    // This route is deliberately unauthenticated — the connection key IS the
    // credential — so there is no req.userId to attribute the mint to. The
    // responsible party is whoever MINTED the key, which is the account that
    // decided a runtime could claim an agent here.
    actorUserId: record.created_by,
   });
   const metadata = {
    ...parseJsonObject(record.metadata),
    claimedBy: {
     host: String(req.body?.host || '').trim().slice(0, 160),
     cwd: String(req.body?.cwd || '').trim().slice(0, 500),
     runtimeKind: String(req.body?.runtimeKind || 'machine').trim().slice(0, 80),
     version: String(req.body?.version || '').trim().slice(0, 80),
    },
    cursorBuddy: {
     websiteSource: String(req.body?.websiteSource || '').trim().slice(0, 2048),
     page: parseJsonObject(req.body?.page),
     client: parseJsonObject(req.body?.client),
     manifest: parseJsonObject(req.body?.manifest),
     metadata: parseJsonObject(req.body?.metadata),
    },
   };
   const updateRows = await getDb().unsafe(
    `update cursorbuddy_connection_keys
         set status = 'claimed',
             agent_id = $2,
             claimed_at = now(),
             metadata = $3::jsonb,
             updated_at = now()
         where id = $1
         returning *`,
    [record.id, agent.id, metadata],
   );
   notifyDbSubscribers('cursorbuddy_connection_keys', 'UPDATE', updateRows.map(publicCursorBuddyConnectionKey));
   res.json({
    data: {
     ...payload,
     workspaceId: record.workspace_id,
     agentId: agent.id,
     connectionKey: publicCursorBuddyConnectionKey(updateRows[0]),
     command: payload.command,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountCursorbuddyRoutes };
