'use strict';

// OAuth 2.1 authorization server for the MCP resource (additive to Bearer tokens).
// Mounted on Fly (and forwarded from Netlify for discovery/token when possible).

const {
  createMcpOauthStore,
  renderAuthorizeHtml,
  oauth,
} = require('./mcp-oauth.cjs');

function mountMcpOauthRoutes(app, deps = {}) {
  const {
    requireAuth,
    jsonError,
    enforceWorkspaceRole,
    getDb,
    hashAgentToken,
    normalizeBaseUrl,
    requestBaseUrl,
    verifyToken,
    recordAudit,
  } = deps;

  const store = createMcpOauthStore({ getDb, hashAgentToken });

  function publicBase(req) {
    return normalizeBaseUrl(process.env.AGENSIS_DAEMON_BASE_URL)
      || normalizeBaseUrl(process.env.AGENSIS_PUBLIC_URL)
      || requestBaseUrl(req);
  }

  function oauthJsonError(res, status, error, description) {
    res.status(status).json({
      error,
      error_description: description || error,
    });
  }

  // --- Discovery (RFC 8414 + RFC 9728) ------------------------------------

  app.get([
    '/.well-known/oauth-authorization-server',
    '/backend/.well-known/oauth-authorization-server',
  ], (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(oauth.authorizationServerMetadata(publicBase(req)));
  });

  app.get([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/backend/mcp',
    '/backend/.well-known/oauth-protected-resource',
  ], (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(oauth.protectedResourceMetadata(publicBase(req)));
  });

  // --- Dynamic Client Registration (RFC 7591) -----------------------------

  app.post('/backend/oauth/register', async (req, res) => {
    try {
      const body = req.body || {};
      const redirectUris = oauth.normalizeRedirectUris(body.redirect_uris || body.redirectUris);
      if (!redirectUris.length) {
        return oauthJsonError(res, 400, 'invalid_client_metadata', 'redirect_uris required');
      }
      const method = oauth.normalizeTokenAuthMethod(
        body.token_endpoint_auth_method || body.tokenEndpointAuthMethod || 'none',
      );
      // DCR clients are not workspace-bound until consent; workspace is chosen at authorize.
      const created = await store.insertClient({
        workspaceId: null,
        name: body.client_name || body.clientName || 'Registered MCP client',
        redirectUris,
        tokenEndpointAuthMethod: method,
        createdBy: null,
      });
      const payload = {
        client_id: created.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: created.redirectUris,
        token_endpoint_auth_method: created.tokenEndpointAuthMethod,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: oauth.scopesToString(created.scopes),
      };
      if (created.clientSecret) {
        payload.client_secret = created.clientSecret;
        payload.client_secret_expires_at = 0;
      }
      res.status(201).json(payload);
    } catch (error) {
      oauthJsonError(res, error.status || 500, 'invalid_client_metadata', error.message);
    }
  });

  // --- Authorize (code + PKCE) --------------------------------------------

  async function loadOwnedWorkspaces(userId) {
    const rows = await getDb().unsafe(
      `select w.id, w.name
         from workspaces w
         left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = $1
        where w.user_id = $1
           or (wm.user_id = $1 and wm.role in ('owner', 'admin'))
        order by w.name asc
        limit 100`,
      [userId],
    );
    return rows;
  }

  async function assertWorkspaceConsent(userId, workspaceId) {
    // Owner or admin (manage) may grant MCP OAuth for a workspace.
    try {
      await enforceWorkspaceRole(userId, workspaceId, 'manage');
    } catch (error) {
      // Owners always have manage via workspaces.user_id path.
      const owned = await getDb().unsafe(
        'select 1 from workspaces where id = $1 and user_id = $2 limit 1',
        [workspaceId, userId],
      );
      if (!owned[0]) throw error;
    }
  }

  app.get('/backend/oauth/authorize', async (req, res) => {
    try {
      const q = req.query || {};
      const clientId = String(q.client_id || '');
      const redirectUri = String(q.redirect_uri || '');
      const responseType = String(q.response_type || 'code');
      const scope = oauth.scopesToString(q.scope);
      const state = q.state != null ? String(q.state) : '';
      const codeChallenge = String(q.code_challenge || '');
      const codeChallengeMethod = String(q.code_challenge_method || 'S256');

      if (responseType !== 'code') {
        return res.status(400).type('html').send(renderAuthorizeHtml({
          baseUrl: publicBase(req),
          clientId,
          redirectUri,
          scope,
          state,
          codeChallenge,
          codeChallengeMethod,
          error: 'response_type must be code',
        }));
      }

      const client = await store.getClient(clientId);
      if (!client) {
        return res.status(400).type('html').send(renderAuthorizeHtml({
          baseUrl: publicBase(req),
          clientId,
          redirectUri,
          scope,
          state,
          codeChallenge,
          codeChallengeMethod,
          error: 'Unknown client_id',
        }));
      }
      if (!oauth.redirectUriAllowed(parseJson(client.redirect_uris), redirectUri)) {
        return res.status(400).type('html').send(renderAuthorizeHtml({
          baseUrl: publicBase(req),
          clientId,
          clientName: client.name,
          redirectUri,
          scope,
          state,
          codeChallenge,
          codeChallengeMethod,
          error: 'redirect_uri is not registered for this client',
        }));
      }

      // Optional pre-auth: Authorization Bearer session → prefill workspaces.
      let workspaceOptions = [];
      const header = req.headers.authorization || '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (bearer && verifyToken) {
        const userId = await verifyToken(bearer);
        if (userId) workspaceOptions = await loadOwnedWorkspaces(userId);
      }

      res.type('html').send(renderAuthorizeHtml({
        baseUrl: publicBase(req),
        clientId,
        clientName: client.name,
        redirectUri,
        scope,
        state,
        codeChallenge,
        codeChallengeMethod,
        workspaceOptions,
      }));
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/oauth/authorize', async (req, res) => {
    try {
      const body = req.body || {};
      // Session: Authorization header preferred; form field for HTML consent.
      const header = req.headers.authorization || '';
      const bearer = header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : String(body.session_token || body.access_token || '').trim();
      const userId = bearer && verifyToken ? await verifyToken(bearer) : null;
      if (!userId) {
        if (wantsJson(req)) return jsonError(res, 401, new Error('Authentication required'));
        return res.status(401).type('html').send(renderAuthorizeHtml({
          baseUrl: publicBase(req),
          clientId: body.client_id,
          redirectUri: body.redirect_uri,
          scope: body.scope,
          state: body.state,
          codeChallenge: body.code_challenge,
          codeChallengeMethod: body.code_challenge_method,
          error: 'Sign in required — provide a valid session token',
        }));
      }

      const clientId = String(body.client_id || '');
      const redirectUri = String(body.redirect_uri || '');
      const state = body.state != null ? String(body.state) : '';
      const decision = String(body.decision || body.approve || 'allow').toLowerCase();
      const client = await store.getClient(clientId);
      if (!client || !oauth.redirectUriAllowed(parseJson(client.redirect_uris), redirectUri)) {
        return oauthJsonError(res, 400, 'invalid_request', 'Invalid client or redirect_uri');
      }

      if (decision === 'deny' || decision === 'false' || body.approve === false) {
        const loc = oauth.buildAuthorizeRedirect({
          redirectUri,
          state,
          error: 'access_denied',
          errorDescription: 'User denied the request',
        });
        if (wantsJson(req)) return res.json({ redirect_to: loc });
        return res.redirect(302, loc);
      }

      const workspaceId = String(body.workspace_id || client.workspace_id || '').trim();
      if (!workspaceId) {
        return oauthJsonError(res, 400, 'invalid_request', 'workspace_id required');
      }
      await assertWorkspaceConsent(userId, workspaceId);

      const { code } = await store.createCode({
        clientId,
        workspaceId,
        userId,
        redirectUri,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method || 'S256',
        scopes: body.scope,
      });

      const loc = oauth.buildAuthorizeRedirect({ redirectUri, code, state });
      if (wantsJson(req) || String(req.headers.accept || '').includes('application/json')) {
        return res.json({ redirect_to: loc, code, state });
      }
      return res.redirect(302, loc);
    } catch (error) {
      if (error.oauthError) return oauthJsonError(res, error.status || 400, error.oauthError, error.message);
      jsonError(res, error.status || 500, error);
    }
  });

  // --- Token endpoint ----------------------------------------------------

  app.post('/backend/oauth/token', async (req, res) => {
    try {
      const body = parseTokenBody(req);
      const grantType = String(body.grant_type || '');
      if (grantType !== 'authorization_code') {
        return oauthJsonError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported');
      }

      let clientId = String(body.client_id || '');
      let clientSecret = body.client_secret != null ? String(body.client_secret) : '';

      // client_secret_basic
      const basic = parseBasicAuth(req.headers.authorization);
      if (basic) {
        clientId = basic.user || clientId;
        clientSecret = basic.pass || clientSecret;
      }

      const client = await store.getClient(clientId);
      if (!client) return oauthJsonError(res, 401, 'invalid_client', 'Unknown client');
      if (!store.clientSecretMatches(client, clientSecret)) {
        return oauthJsonError(res, 401, 'invalid_client', 'Client authentication failed');
      }

      const codeRow = await store.consumeCode({
        code: body.code,
        clientId,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
      });

      const issued = await store.issueAccessToken({
        clientId,
        workspaceId: codeRow.workspace_id,
        userId: codeRow.user_id,
        scopes: parseJson(codeRow.scopes),
      });

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.json({
        access_token: issued.accessToken,
        token_type: issued.tokenType,
        expires_in: issued.expiresIn,
        scope: issued.scope,
      });
    } catch (error) {
      if (error.oauthError) return oauthJsonError(res, error.status || 400, error.oauthError, error.message);
      oauthJsonError(res, error.status || 500, 'server_error', error.message || 'token error');
    }
  });

  // --- Workspace-static client mint (Settings → Connections) -------------

  app.get('/backend/workspaces/:id/oauth-clients', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      // Prefer owner for mint; manage is enough to list.
      const clients = await store.listWorkspaceClients(workspaceId);
      const base = publicBase(req);
      res.json({
        data: {
          resource: oauth.mcpResourceUrl(base),
          authorizationEndpoint: `${oauth.trimTrailingSlash(base)}/backend/oauth/authorize`,
          tokenEndpoint: `${oauth.trimTrailingSlash(base)}/backend/oauth/token`,
          registrationEndpoint: `${oauth.trimTrailingSlash(base)}/backend/oauth/register`,
          scopes: [...oauth.MCP_OAUTH_SCOPES],
          tokenEndpointAuthMethods: [...oauth.AUTH_METHODS],
          clients,
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.post('/backend/workspaces/:id/oauth-clients', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      // Same owner-or-manage bar as consent: manage capability.
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const body = req.body || {};
      const created = await store.insertClient({
        workspaceId,
        name: body.name || 'Workspace MCP OAuth client',
        redirectUris: body.redirect_uris || body.redirectUris || defaultRedirects(),
        tokenEndpointAuthMethod: body.token_endpoint_auth_method || body.tokenEndpointAuthMethod || 'none',
        createdBy: req.userId,
      });
      if (recordAudit) {
        await recordAudit({
          workspaceId,
          actor: { userId: String(req.userId || '') },
          action: 'workspace.mcp_oauth_client_created',
          target: { type: 'mcp_oauth_client', id: created.clientId },
          detail: {
            tokenEndpointAuthMethod: created.tokenEndpointAuthMethod,
            hasSecret: Boolean(created.clientSecret),
          },
        });
      }
      const base = publicBase(req);
      res.status(201).json({
        data: {
          clientId: created.clientId,
          clientSecret: created.clientSecret || null,
          tokenEndpointAuthMethod: created.tokenEndpointAuthMethod,
          redirectUris: created.redirectUris,
          scopes: created.scopes,
          resource: oauth.mcpResourceUrl(base),
          authorizationEndpoint: `${oauth.trimTrailingSlash(base)}/backend/oauth/authorize`,
          tokenEndpoint: `${oauth.trimTrailingSlash(base)}/backend/oauth/token`,
          registrationEndpoint: `${oauth.trimTrailingSlash(base)}/backend/oauth/register`,
        },
        error: null,
      });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  app.delete('/backend/workspaces/:id/oauth-clients/:clientId', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      const clientId = String(req.params.clientId || '').trim();
      await enforceWorkspaceRole(req.userId, workspaceId, 'manage');
      const ok = await store.revokeClient(workspaceId, clientId);
      if (!ok) return jsonError(res, 404, new Error('OAuth client not found'));
      res.json({ data: { clientId, revoked: true }, error: null });
    } catch (error) {
      jsonError(res, error.status || 500, error);
    }
  });

  return { store };
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  const ct = String(req.headers['content-type'] || '');
  return accept.includes('application/json') || ct.includes('application/json');
}

function parseJson(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function parseTokenBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  return {};
}

function parseBasicAuth(header) {
  const h = String(header || '');
  if (!h.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return { user: decoded, pass: '' };
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function defaultRedirects() {
  // Desktop MCP clients commonly use loopback; also allow a generic https placeholder
  // that operators replace. Registration always requires at least one URI.
  return [
    'http://127.0.0.1/callback',
    'http://localhost/callback',
  ];
}

module.exports = { mountMcpOauthRoutes };
