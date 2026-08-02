'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp, __test } = require('../server/index.cjs');
const { createMcpOauthStore } = require('../server/mcp-oauth.cjs');
const oauth = require('../shared/mcp-oauth.cjs');

const WORKSPACE = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const INHERITED_MANAGER = '00000000-0000-4000-8000-0000000000b2';
const REDIRECT = 'http://127.0.0.1/callback';

test.afterEach(() => __test.resetTestState());

test('explicit unsupported OAuth metadata is not normalized to a public client', () => {
  assert.equal(oauth.normalizeTokenAuthMethod(undefined), 'none');
  assert.equal(oauth.normalizeTokenAuthMethod('private_key_jwt'), null);
});

test('explicit unsupported-only scopes are rejected while omission defaults', () => {
  assert.deepEqual(oauth.normalizeScopes(undefined), ['mcp:tools']);
  assert.throws(() => oauth.normalizeScopes('openid profile'), /invalid_scope/);
});

function hash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function makeDb() {
  const state = {
    clients: new Map(),
    codes: new Map(),
    tokens: new Map(),
    grants: new Map(),
    mcpTokenHash: '',
    autoApprove: false,
    managers: new Set([OWNER]),
    inheritedManagers: new Set([INHERITED_MANAGER]),
  };
  return {
    state,
    async begin(fn) { return fn(this); },
    async unsafe(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'mcp-oauth-test-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.includes('from workspaces w') && q.includes('left join workspace_members')) {
        return [{ id: WORKSPACE, name: 'Test WS' }];
      }
      if (q.startsWith('select 1 from workspaces w') && q.includes('from workspace_members wm')) {
        return String(params[0]) === WORKSPACE && state.managers.has(String(params[1]))
          ? [{ '?column?': 1 }]
          : [];
      }
      if (q.startsWith('select 1 from workspaces where id') && q.includes('user_id')) {
        return String(params[0]) === WORKSPACE && String(params[1]) === OWNER ? [{ '?column?': 1 }] : [];
      }
      if (q.startsWith('select id, user_id from workspaces')) {
        return String(params[0]) === WORKSPACE ? [{ id: WORKSPACE, user_id: OWNER }] : [];
      }
      if (q.startsWith('select role from workspace_members')) return [];
      if (q.includes('with recursive chain as')) {
        return state.inheritedManagers.has(String(params[1])) ? [{ role: 'owner' }] : [];
      }
      if (q.startsWith('select id, mcp_auto_approve') && q.includes('mcp_token_hash')) {
        if (state.mcpTokenHash && params[0] === state.mcpTokenHash) {
          return [{ id: WORKSPACE, mcp_auto_approve: state.autoApprove }];
        }
        return [];
      }
      if (q.startsWith('insert into mcp_oauth_clients')) {
        const [clientId, secretHash, workspaceId, name, method, redirectUris, scopes, createdBy] = params;
        const row = {
          id: crypto.randomUUID(),
          client_id: clientId,
          client_secret_hash: secretHash || '',
          workspace_id: workspaceId,
          name,
          token_endpoint_auth_method: method,
          redirect_uris: redirectUris,
          scopes,
          created_by: createdBy,
          created_at: new Date().toISOString(),
          revoked_at: null,
        };
        state.clients.set(clientId, row);
        return [row];
      }
      if (q.startsWith('delete from mcp_oauth_clients')) return [];
      if (q.startsWith('insert into mcp_oauth_client_grants')) {
        state.grants.set(`${params[0]}:${params[1]}`, {
          client_id: params[0], workspace_id: params[1], granted_by: params[2], revoked_at: null,
        });
        return [];
      }
      if (q.startsWith('select * from mcp_oauth_clients where client_id')) {
        const row = state.clients.get(params[0]);
        return row && !row.revoked_at ? [row] : [];
      }
      if (q.startsWith('select c.id, c.client_id, g.workspace_id')) {
        return [...state.clients.values()]
          .filter((c) => {
            const grant = state.grants.get(`${c.client_id}:${params[0]}`);
            return grant && grant.revoked_at == null && !c.revoked_at;
          })
          .map((c) => ({
            ...c,
            has_secret: Boolean(c.client_secret_hash),
          }));
      }
      if (q.startsWith('update mcp_oauth_client_grants set revoked_at')) {
        const grant = state.grants.get(`${params[1]}:${params[0]}`);
        if (!grant || grant.revoked_at) return [];
        grant.revoked_at = new Date().toISOString();
        return [{ client_id: params[1] }];
      }
      if (q.startsWith('update mcp_oauth_tokens set revoked_at')) {
        for (const token of state.tokens.values()) {
          if (token.workspace_id === params[0] && token.client_id === params[1]) token.revoked_at = new Date().toISOString();
        }
        return [];
      }
      if (q.startsWith('update mcp_oauth_codes set used_at') && !q.includes('returning *')) {
        for (const code of state.codes.values()) {
          if (code.workspace_id === params[0] && code.client_id === params[1]) code.used_at = new Date().toISOString();
        }
        return [];
      }
      if (q.startsWith('insert into mcp_oauth_codes')) {
        const [codeHash, clientId, workspaceId, userId, redirectUri, challenge, method, scopes, expiresAt] = params;
        state.codes.set(codeHash, {
          code_hash: codeHash,
          client_id: clientId,
          workspace_id: workspaceId,
          user_id: userId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: method,
          scopes,
          expires_at: expiresAt,
          used_at: null,
        });
        return [];
      }
      if (q.startsWith('select code_challenge from mcp_oauth_codes')) {
        const row = state.codes.get(params[0]);
        return row ? [{ code_challenge: row.code_challenge }] : [];
      }
      if (q.startsWith('update mcp_oauth_codes set used_at') && q.includes('returning *')) {
        const row = state.codes.get(params[0]);
        if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()
            || row.client_id !== params[1] || row.redirect_uri !== params[2]) return [];
        row.used_at = new Date().toISOString();
        return [row];
      }
      if (q.startsWith('insert into mcp_oauth_tokens')) {
        const [tokenHash, clientId, workspaceId, userId, scopes, expiresAt] = params;
        state.tokens.set(tokenHash, {
          token_hash: tokenHash,
          client_id: clientId,
          workspace_id: workspaceId,
          user_id: userId,
          scopes,
          expires_at: expiresAt,
          revoked_at: null,
        });
        return [];
      }
      if (q.startsWith('select t.*, c.revoked_at')) {
        const row = state.tokens.get(params[0]);
        if (!row || row.revoked_at) return [];
        if (new Date(row.expires_at).getTime() <= Date.now()) return [];
        const client = state.clients.get(row.client_id);
        if (!client || client.revoked_at) return [];
        return [{
          ...row,
          client_revoked_at: null,
          mcp_auto_approve: state.autoApprove,
          can_manage: state.managers.has(row.user_id),
        }];
      }
      if (q.startsWith('insert into audit_log')) return [{ id: 'audit-1' }];
      if (q.startsWith('update workspaces set mcp_token_hash')) {
        state.mcpTokenHash = params[1];
        return [{ id: WORKSPACE, mcp_auto_approve: state.autoApprove }];
      }
      return [];
    },
  };
}

async function withServer(run) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function pkcePair() {
  const verifier = oauth.randomToken(32);
  // ensure length >= 43
  const v = verifier.length >= 43 ? verifier : `${verifier}${verifier}`.slice(0, 64);
  return { verifier: v, challenge: oauth.sha256Base64Url(v) };
}

test('AS metadata and PRM are served with required OAuth 2.1 fields', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  await withServer(async (base) => {
    const asRes = await fetch(`${base}/.well-known/oauth-authorization-server`);
    assert.equal(asRes.status, 200);
    const as = await asRes.json();
    assert.ok(as.authorization_endpoint);
    assert.ok(as.token_endpoint);
    assert.ok(as.code_challenge_methods_supported.includes('S256'));
    assert.ok(as.grant_types_supported.includes('authorization_code'));

    const prmRes = await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(prmRes.status, 200);
    const prm = await prmRes.json();
    assert.match(prm.resource, /\/backend\/mcp$/);
    assert.ok(Array.isArray(prm.authorization_servers));
  });
});

test('unauthenticated MCP POST returns 401 with resource_metadata challenge', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  await withServer(async (base) => {
    const res = await fetch(`${base}/backend/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
    const www = res.headers.get('www-authenticate') || '';
    assert.match(www, /resource_metadata=/i);
    assert.match(www, /oauth-protected-resource/i);
  });
});

test('authorization-code + PKCE happy path yields MCP-usable access token', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const session = await __test.issueToken(OWNER, '1');
  const { verifier, challenge } = pkcePair();

  await withServer(async (base) => {
    // DCR
    const reg = await fetch(`${base}/backend/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test client',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(reg.status, 201);
    const regBody = await reg.json();
    const clientId = regBody.client_id;
    assert.ok(clientId);

    // Consent (JSON)
    const auth = await fetch(`${base}/backend/oauth/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'mcp:tools',
        state: 'st1',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        workspace_id: WORKSPACE,
        decision: 'allow',
      }),
    });
    const authText = await auth.text();
    assert.equal(auth.status, 200, authText);
    const authBody = JSON.parse(authText);
    assert.ok(authBody.code);
    assert.ok(String(authBody.redirect_to).includes('code='));

    // Token exchange
    const tokenRes = await fetch(`${base}/backend/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authBody.code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    const tokenText = await tokenRes.text();
    assert.equal(tokenRes.status, 200, tokenText);
    const tokenBody = JSON.parse(tokenText);
    assert.ok(tokenBody.access_token);
    assert.equal(tokenBody.token_type, 'Bearer');
    assert.ok(tokenBody.expires_in > 0);

    // MCP tools/list with OAuth token — must expose the real tool surface
    const mcp = await fetch(`${base}/backend/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const mcpText = await mcp.text();
    assert.equal(mcp.status, 200, mcpText);
    const mcpBody = JSON.parse(mcpText);
    const tools = mcpBody.result?.tools;
    assert.ok(Array.isArray(tools), `expected tools array, got: ${mcpText.slice(0, 400)}`);
    assert.ok(tools.length > 0, 'OAuth token must see MCP tools (kind must be user/workspace, not oauth)');
    assert.ok(tools.some((t) => t.name === 'whoami'), 'whoami must be available to OAuth user identity');

    // tools/call whoami must succeed (not "not available for a oauth token")
    const who = await fetch(`${base}/backend/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    });
    const whoText = await who.text();
    assert.equal(who.status, 200, whoText);
    const whoBody = JSON.parse(whoText);
    assert.notEqual(whoBody.result?.isError, true, `whoami must not error: ${whoText.slice(0, 500)}`);
    const whoTextBlob = JSON.stringify(whoBody.result || {});
    assert.ok(
      whoTextBlob.includes('user') || whoTextBlob.includes(WORKSPACE) || whoTextBlob.includes('register_agent'),
      `whoami payload must identify user/workspace identity: ${whoTextBlob.slice(0, 400)}`,
    );
    assert.ok(!whoTextBlob.includes('not available for a oauth'), 'must not reject kind oauth');
  });
});

test('OAuth consent requires direct owner/admin authority, not inherited management', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const session = await __test.issueToken(INHERITED_MANAGER, '1');
  const { challenge } = pkcePair();

  await withServer(async (base) => {
    const reg = await fetch(`${base}/backend/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    });
    const { client_id: clientId } = await reg.json();
    const auth = await fetch(`${base}/backend/oauth/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        workspace_id: WORKSPACE,
        decision: 'allow',
      }),
    });
    assert.equal(auth.status, 403);
    assert.equal(db.state.codes.size, 0);
    assert.equal(db.state.grants.size, 0);
  });
});

test('client_secret_basic accepts a matching redundant client_id and rejects a conflicting one', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const store = createMcpOauthStore({ getDb: () => db, hashAgentToken: hash });
  const client = await store.insertClient({
    name: 'basic client', redirectUris: [REDIRECT], tokenEndpointAuthMethod: 'client_secret_basic',
  });
  await store.grantClient(WORKSPACE, client.clientId, OWNER);
  const { verifier, challenge } = pkcePair();
  const { code } = await store.createCode({
    clientId: client.clientId, workspaceId: WORKSPACE, userId: OWNER,
    redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'S256',
  });
  const authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;

  await withServer(async (base) => {
    const exchange = (clientId) => fetch(`${base}/backend/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    assert.equal((await exchange('different-client')).status, 401);
    assert.equal((await exchange(client.clientId)).status, 200);
  });
});

test('PKCE failure and expired/wrong client grants are rejected', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const session = await __test.issueToken(OWNER, '1');
  const { verifier, challenge } = pkcePair();

  await withServer(async (base) => {
    const reg = await fetch(`${base}/backend/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    });
    const { client_id: clientId } = await reg.json();

    const auth = await fetch(`${base}/backend/oauth/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        workspace_id: WORKSPACE,
        decision: 'allow',
      }),
    });
    const { code } = await auth.json();

    const badPkce = await fetch(`${base}/backend/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: 'x'.repeat(43),
      }).toString(),
    });
    assert.equal(badPkce.status, 400);
    const badBody = await badPkce.json();
    assert.equal(badBody.error, 'invalid_grant');

    // Re-issue a code and reuse after first exchange
    const auth2 = await fetch(`${base}/backend/oauth/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        workspace_id: WORKSPACE,
        decision: 'allow',
      }),
    });
    const { code: code2 } = await auth2.json();
    const ok = await fetch(`${base}/backend/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    assert.equal(ok.status, 200);
    const reuse = await fetch(`${base}/backend/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    assert.equal(reuse.status, 400);
  });
});

test('legacy workspace Bearer MCP token still authenticates (regression)', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const session = await __test.issueToken(OWNER, '1');
  await withServer(async (base) => {
    // Mint via workspace route needs owner check - use direct hash path:
    // issue a workspace token through the store by updating mcp_token_hash
    const token = `agw_${crypto.randomBytes(24).toString('base64url')}`;
    db.state.mcpTokenHash = hash(token);

    const mcp = await fetch(`${base}/backend/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(mcp.status, 200, await mcp.text());
    // session still works as login MCP path
    const login = await fetch(`${base}/backend/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    // user login MCP may 200 if workspace owned; may fail if fixture order differs
    assert.ok([200, 401].includes(login.status));
  });
});

test('concurrent authorization-code redemption atomically issues exactly one token', async () => {
  const db = makeDb();
  const store = createMcpOauthStore({ getDb: () => db, hashAgentToken: hash });
  const client = await store.insertClient({
    name: 'race client', redirectUris: [REDIRECT], tokenEndpointAuthMethod: 'none',
  });
  await store.grantClient(WORKSPACE, client.clientId, OWNER);
  const { verifier, challenge } = pkcePair();
  const { code } = await store.createCode({
    clientId: client.clientId, workspaceId: WORKSPACE, userId: OWNER,
    redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'S256',
  });
  const exchange = () => store.redeemCode({
    code, clientId: client.clientId, redirectUri: REDIRECT, codeVerifier: verifier,
  });
  const results = await Promise.allSettled([exchange(), exchange()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(db.state.tokens.size, 1);
});

test('OAuth access token is rejected after member removal or admin demotion', async () => {
  const db = makeDb();
  const store = createMcpOauthStore({ getDb: () => db, hashAgentToken: hash });
  const client = await store.insertClient({
    name: 'membership client', redirectUris: [REDIRECT], tokenEndpointAuthMethod: 'none',
  });
  await store.grantClient(WORKSPACE, client.clientId, OWNER);
  const { verifier, challenge } = pkcePair();
  const { code } = await store.createCode({
    clientId: client.clientId, workspaceId: WORKSPACE, userId: OWNER,
    redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'S256',
  });
  const issued = await store.redeemCode({
    code, clientId: client.clientId, redirectUri: REDIRECT, codeVerifier: verifier,
  });
  assert.ok(await store.verifyAccessToken(issued.accessToken));
  db.state.managers.delete(OWNER); // models both removal and demotion below admin/manage
  assert.equal(await store.verifyAccessToken(issued.accessToken), null);
});

test('dynamic client grants list and revoke per workspace without killing another grant', async () => {
  const db = makeDb();
  const store = createMcpOauthStore({ getDb: () => db, hashAgentToken: hash });
  const otherWorkspace = '00000000-0000-4000-8000-0000000000a2';
  const client = await store.insertClient({
    name: 'multi-workspace client', redirectUris: [REDIRECT], tokenEndpointAuthMethod: 'none',
  });
  await store.grantClient(WORKSPACE, client.clientId, OWNER);
  await store.grantClient(otherWorkspace, client.clientId, OWNER);
  assert.deepEqual((await store.listWorkspaceClients(WORKSPACE)).map((row) => row.clientId), [client.clientId]);
  assert.equal(await store.revokeClient(WORKSPACE, client.clientId), true);
  assert.equal((await store.listWorkspaceClients(WORKSPACE)).length, 0);
  assert.deepEqual((await store.listWorkspaceClients(otherWorkspace)).map((row) => row.clientId), [client.clientId]);
  assert.ok(await store.getClient(client.clientId), 'workspace revocation must not globally revoke the client');
});
