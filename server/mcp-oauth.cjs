'use strict';

// MCP OAuth 2.1 authorization-server store operations (DB-backed).
// Handlers live in mcp-oauth-routes.cjs; pure crypto/metadata in shared/mcp-oauth.cjs.

const oauth = require('../shared/mcp-oauth.cjs');

function createMcpOauthStore({ getDb, hashAgentToken }) {
  const hash = typeof hashAgentToken === 'function' ? hashAgentToken : oauth.hashSecret;

  async function insertClient({
    workspaceId,
    name,
    redirectUris,
    tokenEndpointAuthMethod,
    clientSecret,
    createdBy,
  }) {
    const clientId = oauth.createClientId();
    const method = oauth.normalizeTokenAuthMethod(tokenEndpointAuthMethod);
    const uris = oauth.normalizeRedirectUris(redirectUris);
    if (!uris.length) {
      const err = new Error('At least one valid redirect_uri is required');
      err.status = 400;
      throw err;
    }
    let secret = null;
    let secretHash = '';
    if (method !== 'none') {
      secret = clientSecret || oauth.createClientSecret();
      secretHash = hash(secret);
    }
    const rows = await getDb().unsafe(
      `insert into mcp_oauth_clients
         (client_id, client_secret_hash, workspace_id, name, token_endpoint_auth_method,
          redirect_uris, scopes, created_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       returning id, client_id, workspace_id, name, token_endpoint_auth_method,
                 redirect_uris, scopes, created_at`,
      [
        clientId,
        secretHash,
        workspaceId || null,
        String(name || 'MCP client').slice(0, 120),
        method,
        JSON.stringify(uris),
        JSON.stringify(oauth.MCP_OAUTH_SCOPES),
        createdBy || null,
      ],
    );
    const row = rows[0];
    return {
      id: row.id,
      clientId: row.client_id,
      clientSecret: secret,
      workspaceId: row.workspace_id,
      name: row.name,
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      redirectUris: parseJsonArray(row.redirect_uris),
      scopes: parseJsonArray(row.scopes),
      createdAt: row.created_at,
    };
  }

  async function getClient(clientId) {
    const rows = await getDb().unsafe(
      `select * from mcp_oauth_clients
        where client_id = $1 and revoked_at is null
        limit 1`,
      [String(clientId || '')],
    );
    return rows[0] || null;
  }

  async function listWorkspaceClients(workspaceId) {
    const rows = await getDb().unsafe(
      `select id, client_id, workspace_id, name, token_endpoint_auth_method,
              redirect_uris, scopes, created_at,
              (client_secret_hash <> '') as has_secret
         from mcp_oauth_clients
        where workspace_id = $1 and revoked_at is null
        order by created_at desc
        limit 50`,
      [workspaceId],
    );
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      workspaceId: row.workspace_id,
      name: row.name,
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      redirectUris: parseJsonArray(row.redirect_uris),
      scopes: parseJsonArray(row.scopes),
      hasSecret: row.has_secret === true || row.has_secret === 't' || row.has_secret === 1,
      createdAt: row.created_at,
    }));
  }

  async function revokeClient(workspaceId, clientId) {
    const rows = await getDb().unsafe(
      `update mcp_oauth_clients
          set revoked_at = now()
        where workspace_id = $1 and client_id = $2 and revoked_at is null
        returning client_id`,
      [workspaceId, clientId],
    );
    return Boolean(rows[0]);
  }

  function clientSecretMatches(row, presentedSecret) {
    if (!row) return false;
    const method = oauth.normalizeTokenAuthMethod(row.token_endpoint_auth_method);
    if (method === 'none') return true;
    const expected = String(row.client_secret_hash || '');
    if (!expected) return false;
    return oauth.timingSafeEqualHex(expected, hash(presentedSecret));
  }

  async function createCode({
    clientId,
    workspaceId,
    userId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scopes,
  }) {
    if (String(codeChallengeMethod || '').toUpperCase() !== 'S256') {
      const err = new Error('code_challenge_method must be S256');
      err.status = 400;
      err.oauthError = 'invalid_request';
      throw err;
    }
    const challenge = String(codeChallenge || '');
    if (!challenge || challenge.length < 43) {
      const err = new Error('code_challenge required');
      err.status = 400;
      err.oauthError = 'invalid_request';
      throw err;
    }
    const code = oauth.createAuthorizationCode();
    const expiresAt = new Date(Date.now() + oauth.CODE_TTL_MS).toISOString();
    await getDb().unsafe(
      `insert into mcp_oauth_codes
         (code_hash, client_id, workspace_id, user_id, redirect_uri,
          code_challenge, code_challenge_method, scopes, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)`,
      [
        hash(code),
        clientId,
        workspaceId,
        userId,
        redirectUri,
        challenge,
        'S256',
        JSON.stringify(oauth.normalizeScopes(scopes)),
        expiresAt,
      ],
    );
    return { code, expiresAt };
  }

  async function consumeCode({
    code,
    clientId,
    redirectUri,
    codeVerifier,
  }) {
    const codeHash = hash(code);
    const rows = await getDb().unsafe(
      `select * from mcp_oauth_codes where code_hash = $1 limit 1`,
      [codeHash],
    );
    const row = rows[0];
    if (!row) {
      const err = new Error('Invalid authorization code');
      err.status = 400;
      err.oauthError = 'invalid_grant';
      throw err;
    }
    if (row.used_at) {
      const err = new Error('Authorization code already used');
      err.status = 400;
      err.oauthError = 'invalid_grant';
      throw err;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      const err = new Error('Authorization code expired');
      err.status = 400;
      err.oauthError = 'invalid_grant';
      throw err;
    }
    if (String(row.client_id) !== String(clientId)) {
      const err = new Error('client_id mismatch');
      err.status = 400;
      err.oauthError = 'invalid_grant';
      throw err;
    }
    if (String(row.redirect_uri) !== String(redirectUri)) {
      const err = new Error('redirect_uri mismatch');
      err.status = 400;
      err.oauthError = 'invalid_grant';
      throw err;
    }
    if (!oauth.verifyPkceS256(codeVerifier, row.code_challenge)) {
      const err = new Error('PKCE verification failed');
      err.status = 400;
      err.oauthError = 'invalid_grant';
      throw err;
    }
    await getDb().unsafe(
      `update mcp_oauth_codes set used_at = now() where code_hash = $1 and used_at is null`,
      [codeHash],
    );
    return row;
  }

  async function issueAccessToken({ clientId, workspaceId, userId, scopes }) {
    const token = oauth.createAccessToken();
    const expiresAt = new Date(Date.now() + oauth.ACCESS_TOKEN_TTL_SEC * 1000).toISOString();
    await getDb().unsafe(
      `insert into mcp_oauth_tokens
         (token_hash, client_id, workspace_id, user_id, scopes, expires_at)
       values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
      [
        hash(token),
        clientId,
        workspaceId,
        userId || null,
        JSON.stringify(oauth.normalizeScopes(scopes)),
        expiresAt,
      ],
    );
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: oauth.ACCESS_TOKEN_TTL_SEC,
      scope: oauth.scopesToString(scopes),
      expiresAt,
    };
  }

  async function verifyAccessToken(token) {
    if (!oauth.isOauthAccessToken(token)) return null;
    const rows = await getDb().unsafe(
      `select t.*, c.revoked_at as client_revoked_at, w.mcp_auto_approve
         from mcp_oauth_tokens t
         join mcp_oauth_clients c on c.client_id = t.client_id
         join workspaces w on w.id = t.workspace_id
        where t.token_hash = $1
          and t.revoked_at is null
          and c.revoked_at is null
          and t.expires_at > now()
        limit 1`,
      [hash(token)],
    );
    const row = rows[0];
    if (!row) return null;
    // Map onto existing MCP identity kinds (agent|workspace|user|invite|integration).
    // `oauth` is not in CONNECTED — tools/list would be empty and every tools/call
    // would fail. Consent always stamps user_id; fall back to workspace control.
    const userId = row.user_id ? String(row.user_id) : '';
    if (userId) {
      return {
        kind: 'user',
        userId,
        workspaceId: String(row.workspace_id),
        clientId: row.client_id,
        name: 'OAuth MCP client',
        autoApprove: Boolean(row.mcp_auto_approve),
        scopes: parseJsonArray(row.scopes),
        auth: 'oauth',
      };
    }
    return {
      kind: 'workspace',
      workspaceId: String(row.workspace_id),
      clientId: row.client_id,
      name: 'OAuth MCP client',
      autoApprove: Boolean(row.mcp_auto_approve),
      scopes: parseJsonArray(row.scopes),
      auth: 'oauth',
    };
  }

  return {
    insertClient,
    getClient,
    listWorkspaceClients,
    revokeClient,
    clientSecretMatches,
    createCode,
    consumeCode,
    issueAccessToken,
    verifyAccessToken,
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function renderAuthorizeHtml({
  baseUrl,
  clientId,
  clientName,
  redirectUri,
  scope,
  state,
  codeChallenge,
  codeChallengeMethod,
  workspaceOptions,
  error,
}) {
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const options = (workspaceOptions || []).map((w) => (
    `<option value="${esc(w.id)}">${esc(w.name || w.id)}</option>`
  )).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Authorize MCP access — agensis</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaed;margin:0;padding:2rem;line-height:1.45}
  main{max-width:28rem;margin:0 auto;background:#1a1d24;border:1px solid #2a2f3a;border-radius:12px;padding:1.5rem}
  h1{font-size:1.15rem;margin:0 0 .5rem}
  p,label{font-size:.875rem;color:#a0a8b8}
  input,select,button{width:100%;box-sizing:border-box;margin:.35rem 0 1rem;padding:.55rem .7rem;border-radius:8px;border:1px solid #3a4150;background:#0f1115;color:#e8eaed}
  button{background:#6d5efc;border-color:#6d5efc;font-weight:600;cursor:pointer}
  button.secondary{background:transparent;border-color:#3a4150;color:#a0a8b8}
  .err{color:#ff8a80;font-size:.8rem;margin-bottom:1rem}
  code{font-size:.75rem;word-break:break-all}
</style>
</head><body><main>
  <h1>Authorize MCP client</h1>
  <p><strong>${esc(clientName || clientId)}</strong> wants access to workspace tools
  (<code>${esc(scope || 'mcp:tools')}</code>) on this agensis server.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <form method="post" action="${esc(baseUrl)}/backend/oauth/authorize" id="consent">
    <input type="hidden" name="client_id" value="${esc(clientId)}"/>
    <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}"/>
    <input type="hidden" name="scope" value="${esc(scope)}"/>
    <input type="hidden" name="state" value="${esc(state)}"/>
    <input type="hidden" name="code_challenge" value="${esc(codeChallenge)}"/>
    <input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod || 'S256')}"/>
    <input type="hidden" name="response_type" value="code"/>
    <label for="session_token">Agensis session token (Bearer from your signed-in app)</label>
    <input id="session_token" name="session_token" type="password" autocomplete="off" required placeholder="paste session token"/>
    <label for="workspace_id">Workspace</label>
    <select id="workspace_id" name="workspace_id" required>
      <option value="">Select workspace…</option>
      ${options}
    </select>
    <button type="submit" name="decision" value="allow">Allow</button>
    <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
  </form>
  <p style="font-size:.75rem">OAuth 2.1 authorization code + PKCE. Token endpoint: <code>${esc(baseUrl)}/backend/oauth/token</code></p>
</main>
<script>
// If the SPA stored a session token under known keys, prefill (same browser).
try {
  const keys = ['agensis_auth_token','agensis_session_token','auth_token'];
  for (const k of keys) {
    const v = localStorage.getItem(k);
    if (v && v.length > 20) { document.getElementById('session_token').value = v; break; }
  }
} catch (e) {}
</script>
</body></html>`;
}

module.exports = {
  createMcpOauthStore,
  renderAuthorizeHtml,
  oauth,
};
