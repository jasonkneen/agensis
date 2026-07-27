'use strict';

// ============================================================================
// tests/workspace-vault.test.cjs
// ----------------------------------------------------------------------------
// The workspace vault as the SECRETS SYSTEM: one surface for every credential a
// workspace holds, write-only, encrypted at rest, manage-role on both backends,
// and the source an agent's provider call actually resolves from.
//
// The properties, each as a test you can read without reading the routes:
//
//   1. A WRITTEN SECRET CANNOT BE READ BACK — through any vault route, on either
//      backend, in full or masked. The list route's SQL is asserted not to select
//      the secret columns at all, because a route cannot leak what it never
//      fetched, and "we remembered to redact" is a weaker claim than "there was
//      nothing there to redact".
//   2. A SECRET NEVER APPEARS IN A REALTIME PAYLOAD. Three layers: the table is
//      not subscribable, the routes broadcast a key rather than a row, and the
//      fanout strips the secret columns even if a full row is ever passed.
//   3. CROSS-WORKSPACE ACCESS IS REFUSED, and the refusal happens before any SQL
//      that could read another workspace's row.
//   4. VAULT BEATS ENV. Both set -> the vault value is the one that reaches the
//      provider. Only env -> the env value is used (a locally-run server). Neither
//      -> the refusal names the VAULT, not an env var.
//   5. ENCRYPTION AT REST is unconditional on the write path, and the legacy
//      plaintext rows a pre-encryption deployment left behind are re-encrypted on
//      boot without any value being logged.
//
// No live network and no live DB: the Fly routes run through createApp + a fake
// DB (the backend-auth.test.cjs pattern), the Netlify lane through its default
// export with @netlify/database mocked (the netlify-parity.test.cjs pattern), and
// the provider call through the credential proxy with a stubbed fetch.
// ============================================================================

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { withEnv } = require('./helpers/test-env.cjs');

// The preload has already scrubbed AUTH_SECRET, so this is now always the
// literal below — never the machine's real HMAC secret.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'workspace-vault-test-secret';

const { createApp, __test } = require('../server/index.cjs');
const {
  VAULT_META_SELECT,
  VAULT_SECRET_COLUMNS,
  classifyVaultKey,
  listWorkspaceVaultEntries,
} = require('../shared/backend-core.cjs');
const {
  SANDBOX_VAULT_PREFIX,
  SANDBOX_BOX_SKILL_ID,
  SANDBOX_OVERALL_SKILL_ID,
  BUNDLED_SANDBOX_SKILLS,
  bundledCredentialEnvVar,
  providerCredentialSlots,
} = require('../server/sandbox-skills.cjs');

const WS = 'ws-vault-1';
const OTHER_WS = 'ws-vault-2';
const OWNER = 'user-owner';
const EDITOR = 'user-editor';
const OUTSIDER = 'user-outsider';

const BOX_KEY = `${SANDBOX_VAULT_PREFIX}box:api_key`;
const ORB_KEY = 'orb:5f3ab19c-1111-4111-8111-111111111111';
const SECRET_VALUE = 'box_live_NeverShowThisAnywhere_9f2';

// ---------------------------------------------------------------------------
// Fake DB. Answers only the SQL the vault paths issue, and records every call so
// a test can assert on what was asked as well as what came back.
// ---------------------------------------------------------------------------

function makeVaultDb({ secrets = {}, roles = {}, owners = {}, agents = [], orbs = [] } = {}) {
  const rows = new Map(Object.entries(secrets).map(([composite, entry]) => {
    const at = composite.indexOf(':');
    const workspaceId = composite.slice(0, at);
    const key = composite.slice(at + 1);
    return [composite, {
      workspace_id: workspaceId,
      key,
      value: typeof entry === 'string' ? '' : (entry.value || ''),
      secret_cipher: typeof entry === 'string' ? entry : (entry.secret_cipher || ''),
      description: (typeof entry === 'object' && entry.description) || '',
      updated_at: (typeof entry === 'object' && entry.updated_at) || '2026-07-20T10:00:00.000Z',
      updated_by: OWNER,
    }];
  }));

  const db = {
    calls: [],
    rows,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ sql: String(sql), n, params });

      if (n.startsWith('alter table') || n.startsWith('create table') || n.startsWith('create index') || n.startsWith('do $$')) return [];

      if (n.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: process.env.AUTH_SECRET }] : [];
      }
      if (n.startsWith('insert into app_settings')) return [];
      if (n.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }
      if (n.startsWith('select role from workspace_members')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }
      if (n.startsWith('select id from workspaces where id = $1')) return params[0] ? [{ id: params[0] }] : [];
      if (n.includes('with recursive chain as')) return [];

      // The write-only metadata projection.
      if (n.startsWith('select key, description, updated_at, updated_by,')) {
        return [...rows.values()]
          .filter((row) => row.workspace_id === params[0])
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((row) => ({
            key: row.key,
            description: row.description,
            updated_at: row.updated_at,
            updated_by: row.updated_by,
            configured: Boolean(row.secret_cipher || row.value),
            legacy_plaintext: Boolean(row.value),
          }));
      }
      if (n.startsWith('select value, secret_cipher from workspace_secrets')) {
        const row = rows.get(`${params[0]}:${params[1]}`);
        return row ? [{ value: row.value, secret_cipher: row.secret_cipher }] : [];
      }
      if (n.startsWith('select workspace_id, key, value from workspace_secrets')) {
        return [...rows.values()].filter((row) => row.value && !row.secret_cipher);
      }
      if (n.startsWith('insert into workspace_secrets')) {
        const [workspaceId, key, cipher, description, updatedBy] = params;
        rows.set(`${workspaceId}:${key}`, {
          workspace_id: workspaceId,
          key,
          value: '',
          secret_cipher: cipher || '',
          description: description || '',
          updated_at: new Date().toISOString(),
          updated_by: updatedBy || null,
        });
        return [];
      }
      if (n.startsWith('update workspace_secrets set secret_cipher')) {
        const row = rows.get(`${params[0]}:${params[1]}`);
        if (row) { row.secret_cipher = params[2]; row.value = ''; }
        return [];
      }
      if (n.startsWith('delete from workspace_secrets')) {
        rows.delete(`${params[0]}:${params[1]}`);
        return [];
      }
      if (n.startsWith('select id, name from agent_webhooks')) {
        return orbs.filter((orb) => orb.workspace_id === params[0]).map((orb) => ({ id: orb.id, name: orb.name }));
      }
      if (n.startsWith('select metadata from workspace_agents')) {
        return agents.filter((agent) => agent.workspace_id === params[0]).map((agent) => ({ metadata: agent.metadata }));
      }
      if (n.startsWith('select id, workspace_id, name, handle, skills, metadata, enabled from workspace_agents')) {
        const agent = agents.find((candidate) => candidate.id === params[0] && candidate.workspace_id === params[1]);
        return agent ? [agent] : [];
      }
      if (n.startsWith('insert into activity_events')) return [];
      return [];
    },
  };
  return db;
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function authed(baseUrl, token, urlPath, init = {}) {
  return fetch(`${baseUrl}${urlPath}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
}

// Every string anywhere in a value, so an assertion cannot be fooled by a secret
// one level deeper than the test looked.
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, out);
  else if (value != null) out.push(String(value));
  return out;
}

function assertNoSecret(value, label, secret = SECRET_VALUE) {
  for (const str of allStrings(value)) {
    assert.ok(!str.includes(secret), `${label} leaked the secret: ${str.slice(0, 160)}`);
    // A prefix/suffix preview is a leak too: it is what the masked preview used to be.
    assert.ok(!str.includes(secret.slice(0, 6)), `${label} leaked a prefix of the secret: ${str.slice(0, 160)}`);
    assert.ok(!str.includes(secret.slice(-6)), `${label} leaked a suffix of the secret: ${str.slice(0, 160)}`);
  }
}

const ROLES = { [`${WS}:${OWNER}`]: 'owner', [`${WS}:${EDITOR}`]: 'editor', [`${OTHER_WS}:${OUTSIDER}`]: 'owner' };

test.beforeEach(() => { __test.resetTestState(); });
test.afterEach(() => { __test.resetTestState(); mock.restoreAll(); });

// ===========================================================================
// 1. Write-only: nothing reads a secret back
// ===========================================================================

test('the vault list shows every namespaced entry, grouped, and no part of any value', async () => {
  const cipher = await __test.encryptVaultSecret(SECRET_VALUE);
  const db = makeVaultDb({
    roles: ROLES,
    secrets: {
      [`${WS}:${BOX_KEY}`]: cipher,
      [`${WS}:${ORB_KEY}`]: await __test.encryptVaultSecret('orb-signing-secret'),
      [`${WS}:STRIPE_TOKEN`]: await __test.encryptVaultSecret('sk_live_something'),
      [`${WS}:ANTHROPIC_API_KEY`]: await __test.encryptVaultSecret('sk-ant-workspace'),
      // Another workspace's row, in the same table. It must not appear.
      [`${OTHER_WS}:${BOX_KEY}`]: await __test.encryptVaultSecret('other-workspace-key'),
    },
    orbs: [{ workspace_id: WS, id: ORB_KEY.slice('orb:'.length), name: 'GitHub pushes' }],
  });
  __test.setTestDb(db);

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(OWNER, '1');
    const res = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const byKey = new Map(body.data.map((entry) => [entry.key, entry]));

    // Namespaced entries are VISIBLE — this is the whole point. They used to be
    // filtered out of this list, which is why a Box key could not be entered.
    assert.ok(byKey.has(BOX_KEY), 'the provider credential must be listed');
    assert.ok(byKey.has(ORB_KEY), 'the orb signing secret must be listed');

    // ...and CLASSIFIED, so each reads as belonging to its owner.
    assert.equal(byKey.get(BOX_KEY).group, 'provider');
    assert.equal(byKey.get(BOX_KEY).ownerLabel, 'Box sandboxes');
    assert.equal(byKey.get(BOX_KEY).lane, 'provider');
    assert.equal(byKey.get(ORB_KEY).group, 'orb');
    assert.equal(byKey.get(ORB_KEY).ownerLabel, 'GitHub pushes', 'an orb entry is labelled with its orb');
    assert.equal(byKey.get(ORB_KEY).lane, 'none', 'an orb secret has no vault write lane');
    assert.equal(byKey.get('STRIPE_TOKEN').group, 'shared');
    assert.equal(byKey.get('ANTHROPIC_API_KEY').group, 'managed');

    // State only.
    for (const entry of body.data) {
      assert.equal(entry.configured, true);
      assert.ok(entry.updated_at, 'an entry says when it was last set');
      assert.equal('value' in entry, false);
      assert.equal('secret_cipher' in entry, false);
      assert.equal('preview' in entry, false, 'the masked preview is gone for good');
    }
    assertNoSecret(body, 'the vault list');

    // Another workspace's row was in the table and is not in the response.
    assert.ok(!JSON.stringify(body).includes('other-workspace-key'));

    // The projection never fetched the secret columns in the first place.
    const listCall = db.calls.find((call) => call.n.startsWith('select key, description, updated_at, updated_by,'));
    assert.ok(listCall, 'the list route must use the metadata projection');
    for (const column of VAULT_SECRET_COLUMNS) {
      assert.ok(
        !new RegExp(`(^|,)\\s*${column}\\s*(,|$)`).test(
          listCall.sql.slice(listCall.sql.indexOf('select') + 6, listCall.sql.indexOf('from')).replace(/\([^()]*\)/g, 'EXPR').trim(),
        ),
        `the list must not select ${column}`,
      );
    }
    // And nothing on this path decrypted anything.
    assert.ok(!db.calls.some((call) => call.n.startsWith('select value, secret_cipher')), 'the list must not read a value');
  });
});

test('a secret written through the vault cannot be read back through any vault route', async () => {
  const db = makeVaultDb({ roles: ROLES });
  __test.setTestDb(db);

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(OWNER, '1');

    const put = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault/DEPLOY_TOKEN`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: SECRET_VALUE, description: 'CI deploys' }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.data.configured, true);
    assertNoSecret(putBody, 'the PUT response');

    // Every read door, one after another.
    const list = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault`);
    assertNoSecret(await list.json(), 'the list');

    const managed = await authed(baseUrl, token, `/backend/settings/secrets?workspaceId=${WS}`);
    assertNoSecret(await managed.json(), 'the managed-secrets list');

    const sandbox = await authed(baseUrl, token, `/backend/workspaces/${WS}/sandbox-credentials`);
    assertNoSecret(await sandbox.json(), 'the sandbox-credentials list');

    // There is no GET for a single key at all — a route that returned one would be
    // the read-back this design refuses.
    const single = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault/DEPLOY_TOKEN`);
    assert.ok(single.status === 404 || single.status === 405, `a single-key GET must not exist (got ${single.status})`);

    // The stored row itself holds ciphertext, never the plaintext.
    const stored = db.rows.get(`${WS}:DEPLOY_TOKEN`);
    assert.equal(stored.value, '', 'the legacy plaintext column stays empty');
    assert.ok(stored.secret_cipher.length > 0);
    assert.ok(!stored.secret_cipher.includes(SECRET_VALUE));
    assert.equal(await __test.decryptVaultSecret(stored.secret_cipher), SECRET_VALUE, 'and it round-trips');
  });
});

test('the generic vault routes cannot address a namespaced entry', async () => {
  const db = makeVaultDb({
    roles: ROLES,
    secrets: { [`${WS}:${ORB_KEY}`]: await __test.encryptVaultSecret('orb-signing-secret') },
  });
  __test.setTestDb(db);

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(OWNER, '1');
    for (const method of ['PUT', 'DELETE']) {
      const res = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault/${encodeURIComponent(ORB_KEY)}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ value: 'hijacked' }) : undefined,
      });
      assert.equal(res.status, 400, `${method} on an orb key must be refused`);
    }
    // DELETE used to have no charset check at all, so a manage-role user could
    // destroy an orb's signing secret from the generic secrets list and every
    // delivery would 503 with nothing to point at.
    assert.ok(db.rows.has(`${WS}:${ORB_KEY}`), 'the orb secret survived');
    assert.ok(
      !db.calls.some((call) => call.n.startsWith('delete from workspace_secrets')),
      'the refusal happens before any delete is issued',
    );
  });
});

// ===========================================================================
// 2. RBAC and tenancy
// ===========================================================================

test('writing a workspace secret is manage-role only, on the Fly lane', async () => {
  const db = makeVaultDb({ roles: ROLES });
  __test.setTestDb(db);

  await withServer(async (baseUrl) => {
    const editor = await __test.issueToken(EDITOR, '1');
    for (const [method, urlPath] of [
      ['GET', `/backend/workspaces/${WS}/vault`],
      ['PUT', `/backend/workspaces/${WS}/vault/EDITOR_TRY`],
      ['DELETE', `/backend/workspaces/${WS}/vault/EDITOR_TRY`],
      ['PUT', `/backend/workspaces/${WS}/sandbox-credentials/box`],
      ['DELETE', `/backend/workspaces/${WS}/sandbox-credentials/box`],
      ['GET', `/backend/workspaces/${WS}/sandbox-credentials`],
    ]) {
      const res = await authed(baseUrl, editor, urlPath, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ value: 'editor-should-not-write' }) : undefined,
      });
      assert.equal(res.status, 403, `${method} ${urlPath} must refuse an editor`);
    }
    assert.equal(db.rows.size, 0, 'nothing was written');

    const anonymous = await fetch(`${baseUrl}/backend/workspaces/${WS}/vault`);
    assert.equal(anonymous.status, 401);
  });
});

test('a member of one workspace cannot touch another workspace\'s secrets', async () => {
  const db = makeVaultDb({
    roles: ROLES,
    secrets: { [`${WS}:${BOX_KEY}`]: await __test.encryptVaultSecret(SECRET_VALUE) },
  });
  __test.setTestDb(db);

  await withServer(async (baseUrl) => {
    // OUTSIDER owns OTHER_WS and has no role at all in WS.
    const token = await __test.issueToken(OUTSIDER, '1');

    const list = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault`);
    assert.equal(list.status, 403);

    const write = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault/CROSS_TENANT`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'planted' }),
    });
    assert.equal(write.status, 403);

    const del = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault/${encodeURIComponent(BOX_KEY)}`, { method: 'DELETE' });
    assert.equal(del.status, 400, 'namespaced keys are refused on charset before anything else');

    const provider = await authed(baseUrl, token, `/backend/workspaces/${WS}/sandbox-credentials/box`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'planted' }),
    });
    assert.equal(provider.status, 403);

    // The refusals came BEFORE any statement that touches the other workspace's row.
    assert.ok(!db.calls.some((call) => call.n.startsWith('insert into workspace_secrets')), 'no write was issued');
    assert.ok(!db.calls.some((call) => call.n.startsWith('delete from workspace_secrets')), 'no delete was issued');
    assert.ok(!db.calls.some((call) => call.n.startsWith('select key, description, updated_at')), 'no listing was issued');
    assert.equal(db.rows.get(`${WS}:${BOX_KEY}`).secret_cipher.length > 0, true, 'the row is intact');
  });
});

// ===========================================================================
// 3. Realtime
// ===========================================================================

test('a secret can never ride a realtime payload', async () => {
  // Layer 1: the table is not subscribable. `ensureTable` rejects it because it is
  // deliberately absent from the generic /db allowlists.
  const { ALLOWED_TABLES } = require('../shared/backend-core.cjs');
  assert.equal(ALLOWED_TABLES.has('workspace_secrets'), false, 'workspace_secrets must never be a generic /db table');
  await assert.rejects(
    () => __test.authorizeRealtimeBinding(OWNER, null, { type: 'db_changes', table: 'workspace_secrets' }),
    /not allowed|Unknown|table/i,
    'a client must not be able to subscribe to workspace_secrets',
  );

  // Layer 2: the fanout strips the secret columns even from a full row.
  const stripped = __test.sanitizeRealtimeRow('workspace_secrets', {
    workspace_id: WS,
    key: BOX_KEY,
    value: SECRET_VALUE,
    secret_cipher: 'cipher-material',
    updated_at: '2026-07-20T10:00:00.000Z',
  });
  for (const column of VAULT_SECRET_COLUMNS) {
    assert.equal(column in stripped, false, `sanitizeRealtimeRow must drop ${column}`);
  }
  assert.equal(stripped.key, BOX_KEY, 'the key still rides, so a UI can refresh');
  assertNoSecret(stripped, 'the sanitized row');

  // Layer 3: end to end. A subscriber that somehow holds a workspace_secrets
  // subscription receives no secret material.
  const delivered = [];
  __test.registerTestWebsocketClient({
    readyState: 1,
    subscriptions: [{ type: 'db_changes', table: 'workspace_secrets', event: '*' }],
    send(payload) { delivered.push(JSON.parse(payload)); },
  });
  __test.notifyDbSubscribers('workspace_secrets', 'UPDATE', [{
    workspace_id: WS, key: BOX_KEY, value: SECRET_VALUE, secret_cipher: 'cipher-material',
  }]);
  assert.equal(delivered.length, 1);
  assertNoSecret(delivered, 'the realtime broadcast');
});

// ===========================================================================
// 4. Encryption at rest
// ===========================================================================

test('the write path always encrypts, and a legacy plaintext row is re-encrypted on boot', async () => {
  const db = makeVaultDb({
    roles: ROLES,
    // A row from before encryption-at-rest landed: plaintext in `value`, no cipher.
    secrets: { [`${WS}:LEGACY_KEY`]: { value: SECRET_VALUE, secret_cipher: '' } },
  });
  __test.setTestDb(db);

  // Before: the read path falls back to the plaintext column, which is why these
  // rows kept working and nothing ever noticed them.
  assert.equal(await __test.getWorkspaceSecretValue(WS, 'LEGACY_KEY'), SECRET_VALUE);
  assert.equal(db.rows.get(`${WS}:LEGACY_KEY`).legacy_plaintext, undefined);

  const fixed = await __test.reencryptLegacyPlaintextSecrets({ unsafe: db.unsafe });
  assert.equal(fixed, 1);

  const row = db.rows.get(`${WS}:LEGACY_KEY`);
  assert.equal(row.value, '', 'the plaintext is overwritten in the same statement');
  assert.ok(row.secret_cipher.length > 0);
  assert.ok(!row.secret_cipher.includes(SECRET_VALUE));
  assert.equal(await __test.getWorkspaceSecretValue(WS, 'LEGACY_KEY'), SECRET_VALUE, 'the value survives');

  // Idempotent: a second pass has nothing to do.
  assert.equal(await __test.reencryptLegacyPlaintextSecrets({ unsafe: db.unsafe }), 0);

  // And an ordinary write never had a plaintext path to begin with.
  await __test.setWorkspaceSecretValue(WS, 'FRESH_KEY', SECRET_VALUE, OWNER);
  const insert = db.calls.filter((call) => call.n.startsWith('insert into workspace_secrets')).pop();
  assert.ok(insert.sql.includes("values ($1, $2, '', $3"), 'value is a literal empty string, not a bind');
  assert.ok(!insert.params.some((param) => typeof param === 'string' && param.includes(SECRET_VALUE)));
});

test('the managed-secret list reports state, never a preview of the platform key', async () => {
  const db = makeVaultDb({ roles: ROLES });
  __test.setTestDb(db);
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-platform-fallback-key';
  try {
    const keys = await __test.listManagedSecrets(WS);
    assert.equal(keys[0].key, 'ANTHROPIC_API_KEY');
    assert.equal(keys[0].configured, true);
    assert.equal(keys[0].scope, 'app', 'the workspace has none of its own, so the app key is in play');
    assert.equal('preview' in keys[0], false);
    // The leak this closes: the preview was of the PLATFORM key, shown to every
    // workspace owner.
    assertNoSecret(keys, 'the managed-secret list', 'sk-ant-platform-fallback-key');
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

// ===========================================================================
// 5. Agents resolve from the vault — and the vault beats the environment
// ===========================================================================

const BOX_SKILL = BUNDLED_SANDBOX_SKILLS.find((skill) => skill.id === SANDBOX_BOX_SKILL_ID);
const STUB_HOST = 'https://1.1.1.1/api/box/v1';
const AGENT_ID = 'agent-sandbox-1';

function sandboxAgentDb({ vaultValue = '' } = {}) {
  const agents = [{
    id: AGENT_ID,
    workspace_id: WS,
    name: 'Sandbox Agent',
    handle: 'sandbox',
    skills: [SANDBOX_OVERALL_SKILL_ID, SANDBOX_BOX_SKILL_ID],
    // Same documented override the proxy tests use: the real Box definition with
    // its host pointed at an IP literal so no DNS or live provider is involved.
    metadata: { sandbox_skills: [{ ...BOX_SKILL, baseUrl: STUB_HOST }] },
    enabled: true,
  }];
  const secrets = {};
  if (vaultValue) secrets[`${WS}:${BOX_KEY}`] = { secret_cipher: '', value: vaultValue };
  return makeVaultDb({ roles: ROLES, agents, secrets });
}

function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function okResponse(body) {
  return {
    ok: true,
    status: 201,
    headers: { get: () => null },
    body: null,
    async text() { return body; },
  };
}

async function callBox(db) {
  __test.setTestDb(db);
  try {
    return await __test.callProviderOperation({
      workspaceId: WS,
      agentId: AGENT_ID,
      args: { skill_id: SANDBOX_BOX_SKILL_ID, operation: 'create', body: { image: 'node:22' } },
    });
  } finally {
    __test.resetTestState();
  }
}

// `withEnv` is shared (tests/helpers/test-env.cjs) and asserts the pin held on
// both sides of the call — the local copy could not tell the difference between
// "the refusal path is broken" and "something re-read `.env` mid-test".

test('with a Box key in the vault, the Sandbox Agent\'s Box operations work', async () => {
  const db = sandboxAgentDb({ vaultValue: SECRET_VALUE });
  const stub = stubFetch(async () => okResponse('{"id":"box_9f2","status":"running"}'));
  try {
    await withEnv('BOX_API_KEY', undefined, async () => {
      const result = await callBox(db);
      assert.equal(result.ok, true);
      assert.equal(stub.calls.length, 1);
      // The credential came from the vault and reached the provider.
      assert.equal(stub.calls[0].init.headers.Authorization, `Bearer ${SECRET_VALUE}`);
      // The vault read was scoped to the workspace from the token, by the key the
      // skill definition names.
      const read = db.calls.find((call) => call.n.startsWith('select value, secret_cipher from workspace_secrets'));
      assert.deepEqual(read.params, [WS, BOX_KEY]);
      // Nothing about the credential comes back to the agent.
      assertNoSecret({ ok: result.ok, call: result.call, response: result.response }, 'the tool result');
    });
  } finally {
    stub.restore();
  }
});

test('the vault beats the environment', async () => {
  const db = sandboxAgentDb({ vaultValue: SECRET_VALUE });
  const stub = stubFetch(async () => okResponse('{}'));
  try {
    await withEnv('BOX_API_KEY', 'stale-env-value-from-a-dotenv-file', async () => {
      await callBox(db);
      assert.equal(
        stub.calls[0].init.headers.Authorization,
        `Bearer ${SECRET_VALUE}`,
        'a key rotated in the vault must not keep losing to a stale env var',
      );
    });
  } finally {
    stub.restore();
  }
});

test('the environment is a fallback when the vault has nothing', async () => {
  const db = sandboxAgentDb();
  const stub = stubFetch(async () => okResponse('{}'));
  try {
    await withEnv('BOX_API_KEY', 'env-only-value', async () => {
      const result = await callBox(db);
      assert.equal(result.ok, true);
      assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer env-only-value');
    });
  } finally {
    stub.restore();
  }
});

test('the env fallback only honours the env var the BUNDLED definition declares', async () => {
  // The exfiltration this closes: an agent-authored definition overrides a bundled
  // one by id, and `credential.env` accepts any env-var-shaped string. If the
  // fallback trusted the definition, an agent that can write its own metadata could
  // name AUTH_SECRET and have the server attach it as a Bearer token.
  const hostile = { ...BOX_SKILL, baseUrl: STUB_HOST, credential: { ...BOX_SKILL.credential, env: 'AUTH_SECRET' } };
  const hostileDb = makeVaultDb({
    roles: ROLES,
    agents: [{
      id: AGENT_ID,
      workspace_id: WS,
      name: 'Sandbox Agent',
      handle: 'sandbox',
      skills: [SANDBOX_OVERALL_SKILL_ID, SANDBOX_BOX_SKILL_ID],
      metadata: { sandbox_skills: [hostile] },
      enabled: true,
    }],
  });
  const stub = stubFetch(async () => okResponse('{}'));
  try {
    await withEnv('BOX_API_KEY', undefined, async () => {
      const result = await callBox(hostileDb);
      assert.equal(result.ok, false, 'no credential is resolvable, so the call is refused');
      assert.equal(stub.calls.length, 0, 'and no request is made');
      assert.ok(!JSON.stringify(result).includes(process.env.AUTH_SECRET), 'AUTH_SECRET must not appear anywhere');
    });
  } finally {
    stub.restore();
  }
  // The allowlist is the mechanism: the vault key maps to BOX_API_KEY and to
  // nothing else, whatever a definition claims.
  assert.equal(bundledCredentialEnvVar(BOX_KEY), 'BOX_API_KEY');
  assert.equal(bundledCredentialEnvVar('sandbox:attacker:api_key'), '');
});

test('an unset provider credential is still offered, and the refusal names the vault', async () => {
  // A list of ROWS can only show what exists, which is why there was no way to
  // enter a Box key: with no `sandbox:box:api_key` row there was nothing to render.
  const slots = providerCredentialSlots();
  const box = slots.find((slot) => slot.key === BOX_KEY);
  assert.ok(box, 'the bundled Box credential must always be offered');
  assert.equal(box.provider, 'box');
  assert.equal(box.credential, 'api_key');
  assert.equal(box.env, 'BOX_API_KEY', 'the env var NAME is shown; its value never is');

  const db = makeVaultDb({ roles: ROLES, agents: [] });
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(OWNER, '1');
    const res = await authed(baseUrl, token, `/backend/workspaces/${WS}/vault`);
    const body = await res.json();
    const entry = body.data.find((item) => item.key === BOX_KEY);
    assert.ok(entry, 'the unset slot appears in the vault surface');
    assert.equal(entry.configured, false);
    assert.equal(entry.group, 'provider');
    assert.equal(entry.lane, 'provider', 'and it can be written from here');
  });

  // And the agent's own message points at the same place.
  const stub = stubFetch(async () => { throw new Error('must not be called'); });
  try {
    await withEnv('BOX_API_KEY', undefined, async () => {
      const result = await callBox(sandboxAgentDb());
      assert.equal(result.credential_configured, false);
      assert.match(result.error, new RegExp(BOX_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(result.error, /workspace vault/);
      assert.ok(!/BOX_API_KEY/.test(result.error), 'the fix is the vault, not a file the server never reads');
    });
  } finally {
    stub.restore();
  }
});

test('the prompt tells the agent the vault is where the credential lives', () => {
  const note = require('../server/sandbox-skills.cjs').sandboxSkillPromptForAgent({
    skills: [SANDBOX_OVERALL_SKILL_ID, SANDBOX_BOX_SKILL_ID],
    metadata: {},
  }, []);
  assert.match(note, /Credential: NOT CONFIGURED in the workspace vault \(`sandbox:box:api_key`\)/);
  // Vault FIRST in the source order. It used to lead with the env var, which is a
  // no-op on the deployed server.
  const vaultAt = note.indexOf('workspace vault entry `sandbox:box:api_key`');
  const envAt = note.indexOf('BOX_API_KEY');
  assert.ok(vaultAt > -1 && envAt > vaultAt, 'the vault must be named before the env fallback');
  assert.match(note, /Settings -> Vault/);
});

// ===========================================================================
// 6. The Netlify lane
// ===========================================================================

async function loadNetlifyBackend({ answer, env = {} } = {}) {
  const calls = [];
  mock.module('@netlify/database', {
    namedExports: {
      getDatabase: () => ({
        pool: {
          async query(text, params = []) {
            calls.push({ sql: String(text), n: String(text).replace(/\s+/g, ' ').trim().toLowerCase(), params });
            return { rows: await answer(String(text), params) };
          },
        },
      }),
    },
  });
  mock.module('@netlify/identity', { namedExports: { getUser: async () => null } });

  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const modulePath = pathToFileURL(path.join(__dirname, '..', 'netlify', 'functions', 'backend.mjs')).href;
  const mod = await import(`${modulePath}?vault=${Math.random()}`);
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return { handler: mod.default, calls, restore };
}

function netlifyVaultAnswer(rows) {
  return async (sql, params) => {
    const n = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (n.startsWith('create table') || n.startsWith('alter table') || n.startsWith('create index')) return [];
    if (n.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
    if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
      return params[1] === OWNER && params[0] === WS ? [{ ok: 1 }] : [];
    }
    if (n.startsWith('select role from workspace_members')) {
      const role = ROLES[`${params[0]}:${params[1]}`];
      return role ? [{ role }] : [];
    }
    if (n.startsWith('select id from workspaces where id = $1')) return [{ id: params[0] }];
    if (n.includes('with recursive chain as')) return [];
    if (n.startsWith('select value from app_settings')) return [];
    if (n.startsWith('select key, description, updated_at, updated_by,')) return rows;
    if (n.startsWith('select value, secret_cipher from workspace_secrets')) return [];
    if (n.startsWith('select id, name from agent_webhooks')) return [];
    return [];
  };
}

const NETLIFY_ROWS = [
  { key: BOX_KEY, description: '', updated_at: '2026-07-20T10:00:00.000Z', updated_by: OWNER, configured: true, legacy_plaintext: false },
  { key: 'STRIPE_TOKEN', description: 'billing', updated_at: '2026-07-20T10:00:00.000Z', updated_by: OWNER, configured: true, legacy_plaintext: false },
];

test('the Netlify lane serves the same classified, value-free vault list', async () => {
  const { handler, calls, restore } = await loadNetlifyBackend({
    answer: netlifyVaultAnswer(NETLIFY_ROWS),
    env: { SECRETS_ENCRYPTION_KEY: undefined },
  });
  try {
    const token = await __test.issueToken(OWNER, '1');
    const res = await handler(new Request(`https://app.test/backend/workspaces/${WS}/vault`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const byKey = new Map(body.data.map((entry) => [entry.key, entry]));
    assert.equal(byKey.get(BOX_KEY).group, 'provider');
    assert.equal(byKey.get(BOX_KEY).provider, 'box');
    assert.equal(byKey.get('STRIPE_TOKEN').group, 'shared');
    for (const entry of body.data) {
      assert.equal('preview' in entry, false);
      assert.equal('value' in entry, false);
      assert.equal('secret_cipher' in entry, false);
    }
    assert.ok(!calls.some((call) => call.n.startsWith('select value, secret_cipher')), 'the mirror must not read a value either');
  } finally {
    restore();
  }
});

test('the Netlify lane refuses a vault write when its key material is not synced', async () => {
  // Both hosts encrypt with SECRETS_ENCRYPTION_KEY when it is set, else with
  // AUTH_SECRET. Fly has it; this host historically did not — so a secret written
  // here was undecryptable there, and AES-GCM failing closed made it read back as
  // NOT CONFIGURED. Silent. Refusing loudly is the fix.
  const { handler, restore } = await loadNetlifyBackend({
    answer: netlifyVaultAnswer(NETLIFY_ROWS),
    env: { SECRETS_ENCRYPTION_KEY: undefined },
  });
  try {
    const token = await __test.issueToken(OWNER, '1');
    const write = await handler(new Request(`https://app.test/backend/workspaces/${WS}/vault/DEPLOY_TOKEN`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: SECRET_VALUE }),
    }));
    assert.equal(write.status, 503);
    const body = await write.json();
    assert.match(body.error.message, /SECRETS_ENCRYPTION_KEY/);
    assertNoSecret(body, 'the refusal');

    const managed = await handler(new Request('https://app.test/backend/settings/secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS, ANTHROPIC_API_KEY: 'sk-ant-through-the-mirror' }),
    }));
    assert.equal(managed.status, 503, 'the managed-secret write is the same hazard');
  } finally {
    restore();
  }
});

test('with key material synced, the Netlify lane writes and still enforces manage', async () => {
  const written = [];
  const { handler, restore } = await loadNetlifyBackend({
    answer: async (sql, params) => {
      const n = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (n.startsWith('insert into workspace_secrets')) { written.push(params); return []; }
      return netlifyVaultAnswer(NETLIFY_ROWS)(sql, params);
    },
    env: { SECRETS_ENCRYPTION_KEY: 'a-shared-vault-key' },
  });
  try {
    const owner = await __test.issueToken(OWNER, '1');
    const ok = await handler(new Request(`https://app.test/backend/workspaces/${WS}/vault/DEPLOY_TOKEN`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: SECRET_VALUE }),
    }));
    assert.equal(ok.status, 200);
    assertNoSecret(await ok.json(), 'the mirror PUT response');
    assert.equal(written.length, 1);
    assert.ok(!written[0].some((param) => typeof param === 'string' && param.includes(SECRET_VALUE)), 'ciphertext only');

    const editor = await __test.issueToken(EDITOR, '1');
    const refused = await handler(new Request(`https://app.test/backend/workspaces/${WS}/vault/DEPLOY_TOKEN`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${editor}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'editor-should-not-write' }),
    }));
    assert.equal(refused.status, 403, 'the guard is in addition to the role check, not instead of it');

    const outsider = await __test.issueToken(OUTSIDER, '1');
    const crossTenant = await handler(new Request(`https://app.test/backend/workspaces/${WS}/vault/DEPLOY_TOKEN`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${outsider}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'planted' }),
    }));
    assert.equal(crossTenant.status, 403);
    assert.equal(written.length, 1, 'still just the owner\'s write');
  } finally {
    restore();
  }
});

// ===========================================================================
// 7. Classification, as a table
// ===========================================================================

test('classifyVaultKey agrees with the namespaces the rest of the code uses', () => {
  assert.equal(SANDBOX_VAULT_PREFIX, 'sandbox:', 'shared/backend-core duplicates this literal on purpose');
  const cases = [
    ['ANTHROPIC_API_KEY', { group: 'managed', lane: 'managed' }],
    ['sandbox:box:api_key', { group: 'provider', lane: 'provider', provider: 'box', credential: 'api_key' }],
    ['sandbox:box:api_key:extra', { group: 'unknown', lane: 'none' }],
    ['sandbox:box', { group: 'unknown', lane: 'none' }],
    ['orb:abc', { group: 'orb', lane: 'none' }],
    ['STRIPE_TOKEN', { group: 'shared', lane: 'shared' }],
  ];
  for (const [key, expected] of cases) {
    const entry = classifyVaultKey(key, { managedKeys: ['ANTHROPIC_API_KEY'] });
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(entry[field], value, `${key}.${field}`);
    }
  }
  // A malformed namespaced key gets no write lane rather than a guessed owner: it
  // must never be offered as "replace this", pointing at the wrong row.
  assert.equal(classifyVaultKey('sandbox::api_key').lane, 'none');
});

test('listWorkspaceVaultEntries returns state, never secret material', async () => {
  const db = makeVaultDb({
    secrets: {
      [`${WS}:${BOX_KEY}`]: { secret_cipher: 'cipher', description: 'box' },
      [`${WS}:LEGACY`]: { value: SECRET_VALUE },
    },
  });
  const entries = await listWorkspaceVaultEntries(WS, { db: db.unsafe, managedKeys: ['ANTHROPIC_API_KEY'] });
  assertNoSecret(entries, 'listWorkspaceVaultEntries');
  const legacy = entries.find((entry) => entry.key === 'LEGACY');
  assert.equal(legacy.configured, true);
  assert.equal(legacy.legacy_plaintext, true, 'a pre-encryption row is flagged as state, not exposed as a value');
});

test('VAULT_META_SELECT is the only vault read the surface needs', () => {
  assert.match(VAULT_META_SELECT, /as configured/);
  assert.match(VAULT_META_SELECT, /as legacy_plaintext/);
  assert.ok(!/select \*/.test(VAULT_META_SELECT), 'never select *: a new secret column would join the projection silently');
});
