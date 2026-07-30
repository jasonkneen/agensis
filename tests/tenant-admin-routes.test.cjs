// ============================================================================
// tests/tenant-admin-routes.test.cjs
// ----------------------------------------------------------------------------
// Route-level tests for the Tenants surface, on BOTH backends. The helper tests
// in tenant-admin-access.test.cjs prove `assertSystemOwner` refuses correctly;
// these prove the ROUTES actually call it. A green helper test cannot tell
// "gated" from "forgot the gate" — only invoking the real handlers can.
//
// What is pinned, per backend:
//   * every tenant route 403s a VALID token that is not the owner's;
//   * everything fails closed with AGENSIS_SYSTEM_OWNER_EMAIL unset — even for
//     the account whose email would match it;
//   * a planted password_hash / token_version / api_key_cipher on a DB row
//     never appears in a response body (the shaping layer must drop them even
//     if a query ever regresses to select *);
//   * the owner-email squat is closed at every account-creation door: password
//     signup on both backends and OAuth creation on Netlify refuse the
//     configured owner address, with a response indistinguishable from the
//     ordinary duplicate-account refusal; with the env var unset nothing is
//     reserved.
//
// Express is exercised through createApp + a fake DB (the backend-auth.test.cjs
// pattern); the Netlify function through its default export with
// @netlify/database and @netlify/identity mocked before import (the
// netlify-parity.test.cjs pattern).
// ============================================================================

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createApp, __test } = require('../server/index.cjs');

const AUTH_SECRET = 'tenant-routes-test-secret';
const OWNER_EMAIL = 'jason@bouncingfish.com';
const DUPLICATE_MESSAGE = 'An account with that email already exists';

// Values planted on every row a tenant query returns. None of them may ever
// reach a response body.
const PLANTED = {
  password_hash: 'planted-scrypt-password-hash',
  token_version: 'planted-token-version-9',
  api_key_cipher: 'planted-api-key-cipher',
};

function assertNoPlantedSecrets(body, label) {
  const serialized = JSON.stringify(body);
  for (const [key, value] of Object.entries(PLANTED)) {
    assert.ok(!serialized.includes(value), `${label}: planted ${key} VALUE leaked into the response`);
    assert.ok(!serialized.includes(key), `${label}: ${key} KEY leaked into the response`);
  }
}

function withOwnerEnv(value, fn) {
  const prev = process.env.AGENSIS_SYSTEM_OWNER_EMAIL;
  if (value === undefined) delete process.env.AGENSIS_SYSTEM_OWNER_EMAIL;
  else process.env.AGENSIS_SYSTEM_OWNER_EMAIL = value;
  const restore = () => {
    if (prev === undefined) delete process.env.AGENSIS_SYSTEM_OWNER_EMAIL;
    else process.env.AGENSIS_SYSTEM_OWNER_EMAIL = prev;
  };
  return fn().finally(restore);
}

// ----------------------------------------------------------------------------
// Shared fixture: two accounts (the owner and an ordinary user) with tenant
// rows that all carry planted secrets, answered for BOTH backends' SQL.
// `answer(sql, params)` returns plain row arrays; each backend adapter wraps it.
// ----------------------------------------------------------------------------

function makeTenantFixture() {
  const users = {
    'owner-1': { email: OWNER_EMAIL },
    'other-1': { email: 'someone@else.test' },
  };
  const emails = new Map(Object.entries(users).map(([id, row]) => [row.email, id]));
  let nextId = 1;

  function accountRow(id) {
    return {
      id,
      email: users[id].email,
      display_name: '',
      accent_color: '',
      created_at: '2026-01-01T00:00:00.000Z',
      owned_workspace_count: '2',
      membership_count: '1',
      ...PLANTED,
    };
  }

  function workspaceRow(id) {
    return {
      id,
      name: `Workspace ${id}`,
      icon: '',
      is_system: false,
      parent_id: null,
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
      member_count: '3',
      agent_count: '1',
      role: 'editor',
      owner_email: OWNER_EMAIL,
      ...PLANTED,
    };
  }

  async function answer(sql, params = []) {
    const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

    // Startup / profile-column DDL from either backend, including the
    // duplicate-row cleanups ensureRuntimeSchema runs before unique indexes.
    if (n.startsWith('alter table') || n.startsWith('create table') || n.startsWith('create index') || n.startsWith('do $$') || n.startsWith('delete from')) {
      return [];
    }
    if (n.startsWith('select value from app_settings')) return [];
    if (n.startsWith('insert into rate_limits')) return [{ count: 1 }];
    if (n.startsWith('select token_version from app_users')) return [{ token_version: '1' }];

    // The owner gate: email resolved from the AUTHENTICATED user id.
    if (n.startsWith('select email from app_users where id = $1')) {
      const row = users[params[0]];
      return row ? [{ email: row.email }] : [];
    }

    // Signup doors.
    if (n.startsWith('select id from app_users where email = $1')) {
      const id = emails.get(params[0]);
      return id ? [{ id }] : [];
    }
    if (n.startsWith('select id, email, display_name, accent_color, created_at, token_version from app_users where email = $1')) {
      const id = emails.get(params[0]);
      return id
        ? [{ id, email: users[id].email, display_name: '', accent_color: '', created_at: '2026-01-01T00:00:00.000Z', token_version: '1' }]
        : [];
    }
    if (n.startsWith('insert into app_users')) {
      const id = `created-${nextId++}`;
      users[id] = { email: params[0] };
      emails.set(params[0], id);
      return [{ id, email: params[0], display_name: '', accent_color: '', created_at: new Date().toISOString(), token_version: '1' }];
    }

    // Tenant list + detail queries (shared/tenant-admin.cjs).
    if (n.startsWith('select count(*) as total from app_users')) {
      return [{ total: String(Object.keys(users).length) }];
    }
    if (n.startsWith('select u.id, u.email') && n.includes('where u.id = $1')) {
      return users[params[0]] ? [accountRow(params[0])] : [];
    }
    if (n.startsWith('select u.id, u.email') && n.includes('limit $1')) {
      return Object.keys(users).map(accountRow);
    }
    if (n.includes('from workspaces w where w.user_id = $1')) {
      return [workspaceRow('ws-owned-1')];
    }
    if (n.includes('from workspace_members m join workspaces w')) {
      return [workspaceRow('ws-member-1')];
    }

    // The activity aggregate (WORKSPACE_STATS_SQL) and the usage ledger. Both
    // carry PLANTED secrets here for the same reason every other tenant fixture
    // does: these are new projections, and a new projection is exactly where a
    // `select *` regression would put a password_hash back into a response.
    if (n.startsWith('with ws as (')) {
      return [{
        workspace_id: 'ws-owned-1',
        user_id: params[0] || 'owner-1',
        channel_count: '4', dm_count: '1', thread_count: '2',
        message_count: '90', agent_message_count: '60', human_message_count: '30',
        huddle_count: '1', live_huddle_count: '0', huddle_seconds: '900',
        agent_count: '2', live_daemon_count: '1',
        document_count: '3', member_count: '3',
        last_activity_at: '2026-07-20T00:00:00.000Z',
        ...PLANTED,
      }];
    }
    if (n.includes('from usage_events') && n.includes('group by')) {
      return [{
        workspace_id: 'ws-owned-1',
        provider: 'anthropic',
        resource: 'claude-opus-4-5',
        calls: '3',
        input_units: '1000',
        output_units: '500',
        cache_write_units: '0',
        cache_read_units: '0',
        first_at: '2026-07-02T00:00:00.000Z',
        last_at: '2026-07-20T00:00:00.000Z',
        ...PLANTED,
      }];
    }
    if (n.includes("usage.metering_started_at")) {
      return [{
        configured_start: '2026-07-01T00:00:00.000Z',
        first_event_at: '2026-07-02T00:00:00.000Z',
        last_event_at: '2026-07-20T00:00:00.000Z',
      }];
    }

    throw new Error(`Unexpected SQL in tenant route test: ${sql}`);
  }

  return { answer };
}

function signToken(userId) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${userId}.1.${issuedAt}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// ----------------------------------------------------------------------------
// Express (server/index.cjs)
// ----------------------------------------------------------------------------

function installExpressDb() {
  const fixture = makeTenantFixture();
  __test.setTestDb({ unsafe: (sql, params) => fixture.answer(sql, params) });
  return fixture;
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

function authedGet(baseUrl, token, pathname) {
  return fetch(`${baseUrl}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
}

function postSignup(baseUrl, email) {
  return fetch(`${baseUrl}/backend/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Tr0ub4dor&3xyz' }),
  });
}

const TENANT_ROUTES = ['/backend/tenants/access', '/backend/tenants', '/backend/tenants/owner-1'];

test.before(() => {
  // Both backends prefer AGENSIS_AUTH_SECRET over AUTH_SECRET; pin the one
  // this file signs its own tokens with.
  delete process.env.AGENSIS_AUTH_SECRET;
  process.env.AUTH_SECRET = AUTH_SECRET;
});

test.beforeEach(() => {
  __test.resetTestState();
});

test.afterEach(() => {
  __test.resetTestState();
});

test('Express: every tenant route 401s without a token', async () => {
  installExpressDb();
  await withOwnerEnv(OWNER_EMAIL, () => withServer(async (baseUrl) => {
    for (const route of TENANT_ROUTES) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 401, route);
    }
  }));
});

test('Express: a VALID non-owner token gets 403 from both data routes and {owner:false} from the probe', async () => {
  installExpressDb();
  await withOwnerEnv(OWNER_EMAIL, () => withServer(async (baseUrl) => {
    const token = await __test.issueToken('other-1', '1');

    const access = await authedGet(baseUrl, token, '/backend/tenants/access');
    assert.equal(access.status, 200);
    assert.deepEqual((await access.json()).data, { owner: false });

    for (const route of ['/backend/tenants', '/backend/tenants/owner-1']) {
      const response = await authedGet(baseUrl, token, route);
      const body = await response.json();
      assert.equal(response.status, 403, route);
      assert.equal(body.data, null, route);
      // The refusal must not be an oracle for the operator's address.
      assert.ok(!JSON.stringify(body).includes('@'), `${route}: refusal leaks an address`);
    }
  }));
});

test('Express: with the env var UNSET everything fails closed, even for the owner-email account', async () => {
  installExpressDb();
  await withOwnerEnv(undefined, () => withServer(async (baseUrl) => {
    const token = await __test.issueToken('owner-1', '1');

    const access = await authedGet(baseUrl, token, '/backend/tenants/access');
    assert.equal(access.status, 200);
    assert.deepEqual((await access.json()).data, { owner: false });

    for (const route of ['/backend/tenants', '/backend/tenants/owner-1']) {
      const response = await authedGet(baseUrl, token, route);
      assert.equal(response.status, 403, route);
    }
  }));
});

test('Express: the owner gets the data, and planted secrets never reach a response body', async () => {
  installExpressDb();
  await withOwnerEnv(OWNER_EMAIL, () => withServer(async (baseUrl) => {
    const token = await __test.issueToken('owner-1', '1');

    const access = await authedGet(baseUrl, token, '/backend/tenants/access');
    assert.deepEqual((await access.json()).data, { owner: true });

    const list = await authedGet(baseUrl, token, '/backend/tenants');
    assert.equal(list.status, 200);
    const listBody = await list.json();
    // Positive control: the list is real (so the 403s above are meaningful).
    assert.ok(listBody.data.accounts.some((account) => account.email === OWNER_EMAIL));
    assertNoPlantedSecrets(listBody, 'list');

    const detail = await authedGet(baseUrl, token, '/backend/tenants/other-1');
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.account.email, 'someone@else.test');
    assert.ok(detailBody.data.owned_workspaces.length > 0);
    assert.ok(detailBody.data.member_workspaces.length > 0);
    assertNoPlantedSecrets(detailBody, 'detail');

    const missing = await authedGet(baseUrl, token, '/backend/tenants/no-such-account');
    assert.equal(missing.status, 404);
  }));
});

test('Express signup: the configured owner address is reserved, indistinguishably from a duplicate', async () => {
  installExpressDb();
  await withOwnerEnv(OWNER_EMAIL, () => withServer(async (baseUrl) => {
    // Exact and case/whitespace variants are all the same address.
    for (const email of [OWNER_EMAIL, '  Jason@Bouncingfish.COM ']) {
      const response = await postSignup(baseUrl, email);
      const body = await response.json();
      assert.equal(response.status, 409, email);
      assert.equal(body.error.message, DUPLICATE_MESSAGE, email);
    }
    // An unrelated address still signs up fine — the reservation is one
    // address, not a lockdown.
    const ok = await postSignup(baseUrl, 'brand-new@example.com');
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).data.token);
  }));
});

test('Express signup: U+212A Kelvin-sign spoofing of the owner address is refused at the door', async () => {
  installExpressDb();
  // The door lowercases with toLowerCase(), which folds U+212A to `k` — so an
  // address typed with the Kelvin sign WOULD be stored as the owner's ASCII
  // address. The reservation checks the folded (stored) form, closing that path.
  await withOwnerEnv('kowner@example.com', () => withServer(async (baseUrl) => {
    const kelvinSign = '\u212A'; // KELVIN SIGN: looks like K, toLowerCase() folds it to k
    const response = await postSignup(baseUrl, `${kelvinSign}owner@example.com`);
    assert.equal(response.status, 409);
  }));
});

test('Express signup: with the env var unset nothing is reserved (fail-safe)', async () => {
  installExpressDb();
  await withOwnerEnv(undefined, () => withServer(async (baseUrl) => {
    const response = await postSignup(baseUrl, 'unreserved-owner@fresh.test');
    assert.equal(response.status, 200);
    assert.ok((await response.json()).data.token);
  }));
});

// ----------------------------------------------------------------------------
// Netlify (netlify/functions/backend.mjs)
// ----------------------------------------------------------------------------

let netlifyHandler;
let netlifyFixture = null; // per-test; module mock closes over this
let identityUser = null;   // what @netlify/identity's getUser() returns

test.before(async () => {
  mock.module('@netlify/database', {
    namedExports: {
      getDatabase: () => ({
        pool: {
          async query(text, params) {
            if (!netlifyFixture) throw new Error(`No tenant fixture installed for: ${text}`);
            return { rows: await netlifyFixture.answer(text, params) };
          },
        },
      }),
    },
  });
  mock.module('@netlify/identity', {
    namedExports: {
      getUser: async () => identityUser,
    },
  });
  const backend = await import(pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href);
  netlifyHandler = backend.default;
});

test.beforeEach(() => {
  netlifyFixture = makeTenantFixture();
  identityUser = null;
});

function netlifyGet(pathname, token) {
  const headers = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return netlifyHandler(new Request(`http://localhost${pathname}`, { headers }));
}

function netlifyPost(pathname, body) {
  return netlifyHandler(new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

test('Netlify: every tenant route 401s without a token', async () => {
  await withOwnerEnv(OWNER_EMAIL, async () => {
    for (const route of TENANT_ROUTES) {
      const response = await netlifyGet(route);
      assert.equal(response.status, 401, route);
    }
  });
});

test('Netlify: a VALID non-owner token gets 403 from both data routes and {owner:false} from the probe', async () => {
  await withOwnerEnv(OWNER_EMAIL, async () => {
    const token = signToken('other-1');

    const access = await netlifyGet('/backend/tenants/access', token);
    assert.equal(access.status, 200);
    assert.deepEqual((await access.json()).data, { owner: false });

    for (const route of ['/backend/tenants', '/backend/tenants/owner-1']) {
      const response = await netlifyGet(route, token);
      const body = await response.json();
      assert.equal(response.status, 403, route);
      assert.equal(body.data, null, route);
      assert.ok(!JSON.stringify(body).includes('@'), `${route}: refusal leaks an address`);
    }
  });
});

test('Netlify: with the env var UNSET everything fails closed, even for the owner-email account', async () => {
  await withOwnerEnv(undefined, async () => {
    const token = signToken('owner-1');

    const access = await netlifyGet('/backend/tenants/access', token);
    assert.equal(access.status, 200);
    assert.deepEqual((await access.json()).data, { owner: false });

    for (const route of ['/backend/tenants', '/backend/tenants/owner-1']) {
      const response = await netlifyGet(route, token);
      assert.equal(response.status, 403, route);
    }
  });
});

test('Netlify: the owner gets the data, and planted secrets never reach a response body', async () => {
  await withOwnerEnv(OWNER_EMAIL, async () => {
    const token = signToken('owner-1');

    const access = await netlifyGet('/backend/tenants/access', token);
    assert.deepEqual((await access.json()).data, { owner: true });

    const list = await netlifyGet('/backend/tenants', token);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.ok(listBody.data.accounts.some((account) => account.email === OWNER_EMAIL));
    assertNoPlantedSecrets(listBody, 'netlify list');

    const detail = await netlifyGet('/backend/tenants/other-1', token);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.account.email, 'someone@else.test');
    assertNoPlantedSecrets(detailBody, 'netlify detail');

    const missing = await netlifyGet('/backend/tenants/no-such-account', token);
    assert.equal(missing.status, 404);
  });
});

test('Netlify signup: the configured owner address is reserved, indistinguishably from a duplicate', async () => {
  await withOwnerEnv(OWNER_EMAIL, async () => {
    const reserved = await netlifyPost('/backend/auth/signup', { email: ' JASON@bouncingfish.com', password: 'Tr0ub4dor&3xyz' });
    const body = await reserved.json();
    assert.equal(reserved.status, 409);
    assert.equal(body.error.message, DUPLICATE_MESSAGE);

    const ok = await netlifyPost('/backend/auth/signup', { email: 'brand-new@example.com', password: 'Tr0ub4dor&3xyz' });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).data.token);
  });
});

test('Netlify signup: with the env var unset nothing is reserved (fail-safe)', async () => {
  await withOwnerEnv(undefined, async () => {
    const response = await netlifyPost('/backend/auth/signup', { email: 'unreserved-owner@fresh.test', password: 'Tr0ub4dor&3xyz' });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).data.token);
  });
});

test('Netlify OAuth: creating an account with the reserved owner address is refused', async () => {
  await withOwnerEnv('unclaimed-owner@fresh.test', async () => {
    // No app_users row exists for this address — this is the squat: an OAuth
    // identity asserting the owner's email would CREATE the owner account.
    identityUser = { id: 'ident-1', email: 'Unclaimed-Owner@fresh.test' };
    const response = await netlifyPost('/backend/auth/oauth', {});
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error.message, DUPLICATE_MESSAGE);
  });
});

test('Netlify OAuth: the EXISTING owner account still signs in through OAuth (nothing breaks for it)', async () => {
  await withOwnerEnv(OWNER_EMAIL, async () => {
    identityUser = { id: 'ident-owner', email: OWNER_EMAIL };
    const response = await netlifyPost('/backend/auth/oauth', {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.user.email, OWNER_EMAIL);
    assert.ok(body.data.token);
  });
});

test('Netlify OAuth: with the env var unset a new account is created as before (fail-safe)', async () => {
  await withOwnerEnv(undefined, async () => {
    identityUser = { id: 'ident-2', email: 'oauth-newcomer@example.com' };
    const response = await netlifyPost('/backend/auth/oauth', {});
    assert.equal(response.status, 200);
    assert.ok((await response.json()).data.token);
  });
});
