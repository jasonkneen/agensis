// ============================================================================
// tests/netlify-parity.test.cjs
// ----------------------------------------------------------------------------
// Recommended Minimum Test Plan — ITEM 2: Netlify parity negative tests.
//
// The serverless backend (netlify/functions/backend.mjs) was previously
// UNAUTHENTICATED. C1 hardened it to call the same shared guard as the Express
// reference. These tests assert every hardened route returns 401 when no valid
// Authorization token is presented.
//
// All protected routes call `requireUserId(req)` (-> verifyAuthToken) BEFORE any
// DB access, so the real handler can be invoked here without a live Postgres:
// the 401 is thrown during auth, before `query()` is ever reached.
//
// A second block asserts the shared guards themselves (verifyAuthToken /
// enforceDbOperationAccess / assertWorkspaceRole) fail closed, with comments
// mapping each core assertion to the route it protects.
// ============================================================================

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let handler;   // netlify default export
let core;      // shared/backend-core.mjs

// Plan 005 — token expiry and revocation — means requireUserId (-> verifyAuthToken
// -> getTokenVersion) now needs a real `select token_version from app_users ...`
// row for ANY successfully-authenticated request, including ones that only care
// about post-auth route behavior. There is still no live Postgres in this test
// file (by design, see the file header) and backend.mjs has no DB-injection test
// hook, so `@netlify/database` itself is mocked at the module level, before
// backend.mjs is imported (ESM mocks must be installed before the module under
// test is first loaded). `dbQueryImpl` is a per-test override (see the
// change-password test below); the default only ever needs to answer the
// token_version lookup, since every other test in this file either never
// authenticates successfully (401-before-DB) or calls the shared core functions
// directly with their own mock `db`/`getTokenVersion`.
let dbQueryImpl = null;

test.before(async () => {
  // H9 (2026-07 review): getAuthSecret() no longer falls back to a hardcoded
  // placeholder just because NODE_ENV isn't 'production' — Netlify does not
  // guarantee NODE_ENV in the Functions runtime, so an unconfigured deploy was
  // signing sessions with a public constant. It now throws 500 unless a secret
  // is configured, so these tests (which assert 401 for missing/garbage tokens)
  // must configure one, exactly as a real deploy does.
  // Own both names outright rather than branching on what the machine has. The
  // backend reads `AGENSIS_AUTH_SECRET || AUTH_SECRET` (backend.mjs), so a
  // machine that exported the ALIAS used to skip this literal entirely and sign
  // every token below with the real production HMAC — or, if the two differed,
  // 401 the whole file. The preload scrubs both; this makes the file correct on
  // its own terms too.
  delete process.env.AGENSIS_AUTH_SECRET;
  process.env.AUTH_SECRET = 'netlify-parity-test-secret';
  mock.module('@netlify/database', {
    namedExports: {
      getDatabase: () => ({
        pool: {
          async query(text, params) {
            if (dbQueryImpl) return dbQueryImpl(text, params);
            const normalized = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
            if (normalized.startsWith('alter table') || normalized.startsWith('create table') || normalized.startsWith('create index')) {
              return { rows: [] }; // ensureAppUserProfileColumns() etc. — schema DDL, not under test here
            }
            if (/select token_version from app_users/i.test(text)) {
              return { rows: [{ token_version: '1' }] };
            }
            throw new Error(`Unexpected DB query in netlify-parity test (no dbQueryImpl set): ${text}`);
          },
        },
      }),
    },
  });
  const backend = await import(pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href);
  handler = backend.default;
  core = await import(pathToFileURL(path.resolve(__dirname, '../shared/backend-core.cjs')).href);
});

function makeRequest(method, pathname, { token } = {}) {
  const headers = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://localhost${pathname}`, { method, headers });
}

// The hardened routes C1 wrapped with requireUserId, each expected to 401
// without a valid token.
const PROTECTED_ROUTES = [
  ['POST', '/backend/db/select'],
  ['POST', '/backend/db/insert'],
  ['POST', '/backend/db/update'],
  ['POST', '/backend/db/delete'],
  ['GET', '/backend/settings/secrets'],
  ['POST', '/backend/settings/secrets'],
  ['POST', '/backend/ai-chat'],
  ['POST', '/backend/agent-webhooks'],
  ['POST', '/backend/agents/agent-123/connection-command'],
  // Nostr community preview performs a server-side metadata fetch and must be
  // mirrored here; a 404 would mean the UI's Check button hit Netlify without
  // reaching the authenticated route.
  ['POST', '/backend/nostr-communities/preview'],
  // Feedback submission is open to ANY signed-in user, which makes it easy to
  // mistake for a public endpoint. It is not: it writes a task into the System
  // workspace, so it must still refuse an anonymous caller.
  ['POST', '/backend/feedback'],
  // Reactions and read receipts. Listed here for TWO reasons: the obvious one
  // (they must refuse an anonymous caller), and the parity one — a route that
  // exists on Fly and not here is a shipped UI calling something that 404s
  // against whichever deploy the user happens to reach, which is this repo's
  // most repeated bug. A 401 proves the route is MATCHED; a 404 would mean it
  // was never mirrored.
  ['POST', '/backend/messages/msg-123/reactions'],
  ['POST', '/backend/sessions/sess-123/read'],
  ['GET', '/backend/sessions/sess-123/read-state'],
];

for (const [method, pathname] of PROTECTED_ROUTES) {
  test(`${method} ${pathname} returns 401 with no Authorization header`, async () => {
    const res = await handler(makeRequest(method, pathname));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.data, null);
    assert.ok(body.error, 'expected an error payload');
  });

  test(`${method} ${pathname} returns 401 with a garbage Bearer token`, async () => {
    const res = await handler(makeRequest(method, pathname, { token: 'not-a-real-token' }));
    assert.equal(res.status, 401);
  });

  test(`${method} ${pathname} returns 401 with a tampered-signature token`, async () => {
    // Looks like `${userId}.${sig}` but the HMAC won't verify.
    const res = await handler(makeRequest(method, pathname, { token: 'user-1.deadbeef' }));
    assert.equal(res.status, 401);
  });
}

// ----------------------------------------------------------------------------
// Shared-guard fail-closed assertions. Each maps to the route(s) above that now
// depend on it, so the parity contract is pinned even if handler wiring changes.
// ----------------------------------------------------------------------------

test('verifyAuthToken returns null for missing/garbage tokens (gates every requireUserId route)', async () => {
  const secret = 'parity-secret';
  // Never reached for any of the malformed cases below (all rejected on format
  // or signature before the revocation check runs), so a function that would
  // throw if called is a stronger assertion than a stub that always succeeds.
  const unreachableGetTokenVersion = async () => { throw new Error('should not be called'); };
  assert.equal(await core.verifyAuthToken(undefined, secret, unreachableGetTokenVersion), null);     // no header
  assert.equal(await core.verifyAuthToken('', secret, unreachableGetTokenVersion), null);            // empty header
  assert.equal(await core.verifyAuthToken('Bearer garbage', secret, unreachableGetTokenVersion), null); // no dot -> not a token
  assert.equal(await core.verifyAuthToken('Bearer user-1.deadbeef', secret, unreachableGetTokenVersion), null); // 1 dot -> no version segment
  const crypto = require('node:crypto');
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `user-1.1.${issuedAt}`; // `${userId}.${tokenVersion}.${issuedAt}`
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  // Well-formed payload, but the signature doesn't match.
  assert.equal(await core.verifyAuthToken(`Bearer ${payload}.deadbeef`, secret, unreachableGetTokenVersion), null); // bad signature
  // A correctly signed token whose embedded version matches the current
  // (looked-up) version round-trips (sanity that null isn't unconditional).
  assert.equal(await core.verifyAuthToken(`Bearer ${payload}.${sig}`, secret, async () => '1'), 'user-1');
  // Plan 005 — revocation: a correctly signed token whose embedded version no
  // longer matches the CURRENT looked-up version (e.g. after sign-out/password
  // change bumped it) is rejected, even though the signature is perfectly valid.
  assert.equal(await core.verifyAuthToken(`Bearer ${payload}.${sig}`, secret, async () => '2'), null);
  // TTL: correctly signed + matching version but past expiry is rejected.
  assert.equal(
    await core.verifyAuthToken(`Bearer ${payload}.${sig}`, secret, async () => '1', {
      nowSec: issuedAt + core.DEFAULT_TOKEN_TTL_SEC + 1,
    }),
    null,
  );
});

test('createTokenVersionCache actually caches: serves a stale version within its TTL, then refreshes', async () => {
  const { mock } = require('node:test');
  const cache = core.createTokenVersionCache({ ttlMs: 10_000 });
  let version = '1';
  const calls = [];
  const db = async (sql, params) => {
    calls.push({ sql, params });
    return [{ token_version: version }];
  };

  mock.timers.enable({ apis: ['Date'] });
  try {
    assert.equal(await cache.get('user-1', db), '1');
    assert.equal(calls.length, 1); // first call is a real DB read

    version = '2'; // bump out-of-band, bypassing the cache
    assert.equal(await cache.get('user-1', db), '1'); // still within TTL: stale cached value served
    assert.equal(calls.length, 1); // no new DB read yet — proves the cache is real, not a no-op

    mock.timers.tick(10_001);
    assert.equal(await cache.get('user-1', db), '2'); // TTL expired: re-reads and picks up the bump
    assert.equal(calls.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test('createTokenVersionCache.set() lets a caller immediately reflect a version it just wrote itself', async () => {
  const cache = core.createTokenVersionCache({ ttlMs: 10_000 });
  const db = async () => { throw new Error('should not be called: set() must satisfy the read from cache'); };
  cache.set('user-1', 3);
  assert.equal(await cache.get('user-1', db), '3');
});

test('enforceDbOperationAccess throws 401 when userId is absent (gates POST /backend/db/*)', async () => {
  const db = async () => [];
  await assert.rejects(
    () => core.enforceDbOperationAccess({ userId: null, table: 'tasks', op: 'select', filters: [], db }),
    { status: 401 },
  );
});

test('assertWorkspaceRole throws 403 without a role (gates settings/secrets, ai-chat, agent-webhooks)', async () => {
  // Empty db => getWorkspaceRole returns null => forbidden.
  const db = async () => [];
  // settings/secrets GET+POST require capability:'manage'
  await assert.rejects(
    () => core.assertWorkspaceRole({ userId: 'u', workspaceId: 'ws-1', capability: 'manage', db }),
    { status: 403, message: 'You do not have access to this workspace' },
  );
  // ai-chat requires capability:'run_agents'
  await assert.rejects(
    () => core.assertWorkspaceRole({ userId: 'u', workspaceId: 'ws-1', capability: 'run_agents', db }),
    { status: 403 },
  );
});

// ----------------------------------------------------------------------------
// Plan 004 — server-side auth hardening (password policy + rate limiting).
//
// handleAuth's very first line calls `ensureAppUserProfileColumns()`, which
// hits a real DB connection before any of our new checks run, and this test
// file (unlike backend-auth.test.cjs) has no `setTestDb`-style seam for the
// Netlify path. So — following the same pattern already used above for
// verifyAuthToken/enforceDbOperationAccess/assertWorkspaceRole — these test
// the shared-core building blocks directly rather than a full handler
// round-trip. `handleChangeMyPassword` is the one exception: it validates the
// new password BEFORE touching the DB, so it's reachable end-to-end here.
// ----------------------------------------------------------------------------

test('evaluatePasswordServerSide enforces length + character-class-count policy (Netlify copy)', () => {
  const weakShort = core.evaluatePasswordServerSide('abc123');
  assert.equal(weakShort.valid, false);

  const weakSingleClass = core.evaluatePasswordServerSide('abcdefgh');
  assert.equal(weakSingleClass.valid, false);
  assert.equal(weakSingleClass.classesMet, 1);

  const compliant = core.evaluatePasswordServerSide('Tr0ub4dor&3xyz');
  assert.equal(compliant.valid, true);
});

test('createRateLimiter (the factory backing the signin/signup limiters) blocks past its max', () => {
  const limiter = core.createRateLimiter({ windowMs: 60_000, max: 5 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check('same-key').allowed, true, `attempt ${i + 1} should be allowed`);
  }
  const sixth = limiter.check('same-key');
  assert.equal(sixth.allowed, false);
  assert.ok(sixth.retryAfterMs > 0);

  // A different key has its own independent budget (per-email/per-IP isolation).
  assert.equal(limiter.check('other-key').allowed, true);
});

test('POST /backend/users/me/change-password rejects a weak newPassword (validated before any DB call)', async () => {
  const prevSecret = process.env.AUTH_SECRET;
  try {
    process.env.AUTH_SECRET = 'change-password-test-secret';
    // Token format: `${userId}.${tokenVersion}.${issuedAt}.${sig}`.
    // token_version '1' matches the default the module-level DB mock answers.
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = `user-1.1.${issuedAt}`;
    const sig = require('crypto').createHmac('sha256', 'change-password-test-secret').update(payload).digest('base64url');
    const token = `${payload}.${sig}`;

    const req = new Request('http://localhost/backend/users/me/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'whatever-current', newPassword: 'abc123' }),
    });
    const res = await handler(req);
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.match(body.error.message, /character|characters/i);
  } finally {
    if (prevSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prevSecret;
  }
});

// ----------------------------------------------------------------------------
// 2026-07 release review — H9 / H3 / M6 / M7.
// ----------------------------------------------------------------------------

// H9: the insecure placeholder secret is now opt-in, and the AGENSIS_AUTH_SECRET
// alias (which the Fly server already honours) is accepted.
test('H9: Netlify auth secret fails closed without an explicit insecure opt-in', async () => {
  const prev = {
    auth: process.env.AUTH_SECRET,
    alias: process.env.AGENSIS_AUTH_SECRET,
    allow: process.env.AGENSIS_ALLOW_INSECURE_AUTH,
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    delete process.env.AUTH_SECRET;
    delete process.env.AGENSIS_AUTH_SECRET;
    delete process.env.AGENSIS_ALLOW_INSECURE_AUTH;
    delete process.env.NODE_ENV; // the old guard would have handed out the placeholder here

    const unconfigured = await handler(makeRequest('POST', '/backend/db/select'));
    assert.equal(unconfigured.status, 500);

    // The alias alone is enough to configure auth (an operator who set only
    // AGENSIS_AUTH_SECRET used to silently get the hardcoded placeholder).
    process.env.AGENSIS_AUTH_SECRET = 'alias-only-secret';
    const withAlias = await handler(makeRequest('POST', '/backend/db/select', { token: 'not-a-real-token' }));
    assert.equal(withAlias.status, 401);
    delete process.env.AGENSIS_AUTH_SECRET;

    // Explicit opt-in keeps the local/preview sandbox working.
    process.env.AGENSIS_ALLOW_INSECURE_AUTH = 'true';
    const optedIn = await handler(makeRequest('POST', '/backend/db/select', { token: 'not-a-real-token' }));
    assert.equal(optedIn.status, 401);
  } finally {
    for (const [key, value] of Object.entries({
      AUTH_SECRET: prev.auth,
      AGENSIS_AUTH_SECRET: prev.alias,
      AGENSIS_ALLOW_INSECURE_AUTH: prev.allow,
      NODE_ENV: prev.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// H3: workspace_agents.metadata carries host_folders, which becomes `--add-dir`
// for the agent's coding CLI — an editor ('write') must not be able to widen it.
test('H3: setting agent metadata/sandbox columns requires manage, not just write', async () => {
  const roles = { 'ws-1:user-editor': 'editor', 'ws-1:user-admin': 'admin' };
  const rowWorkspaces = { workspace_agents: { 'agent-1': 'ws-1' } };
  const db = async (sql, params = []) => {
    const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) return [];
    if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
      const role = roles[`${params[0]}:${params[1]}`];
      return role ? [{ role }] : [];
    }
    const m = n.match(/^select workspace_id from "?([a-z_]+)"? where id = \$1 limit 1/);
    if (m) {
      const ws = rowWorkspaces[m[1]]?.[params[0]];
      return ws ? [{ workspace_id: ws }] : [];
    }
    // Nested workspaces: the inherited-role ancestor walk (see
    // shared/workspace-tree.cjs). Flat fixtures — nothing above to inherit.
    if (n.includes('with recursive chain as')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const update = (userId, values) => core.enforceDbOperationAccess({
    userId, table: 'workspace_agents', op: 'update',
    filters: [{ column: 'id', operator: 'eq', value: 'agent-1' }],
    payload: { values }, db,
  });

  await assert.rejects(
    () => update('user-editor', { metadata: { host_folders: ['/', '/Users/owner/.ssh'] } }),
    { status: 403, message: 'You do not have permission to manage this workspace' },
  );
  // A JSON string payload is the same write, so it must be gated too.
  await assert.rejects(
    () => update('user-editor', { metadata: '{"host_folders":["/"]}' }),
    { status: 403 },
  );
  await assert.rejects(
    () => update('user-editor', { sandbox_provider: 'e2b' }),
    { status: 403 },
  );
  // The Agents window's host-folders editor still works — for an admin/owner.
  await assert.doesNotReject(() => update('user-admin', { metadata: { host_folders: ['/tmp/project'] } }));
  // Ordinary agent edits, and the empty sandbox defaults the create form always
  // sends, stay at 'write'.
  await assert.doesNotReject(() => update('user-editor', { name: 'Coder' }));
  await assert.doesNotReject(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'workspace_agents', op: 'insert',
      payload: { values: { workspace_id: 'ws-1', name: 'New', sandbox_provider: null, sandbox_config: {} } }, db,
    }),
  );
});

// M6: 'admin' is an invitable role that HAS 'manage', so a workspaces UPDATE
// must not be able to carry ownership/credential columns.
test('M6: workspaces ownership and MCP credential columns are stripped from generic writes', () => {
  const values = core.stripPrivilegedDbValues('workspaces', {
    name: 'Renamed',
    user_id: 'attacker-uuid',
    mcp_token_hash: 'deadbeef',
    mcp_auto_approve: true,
  });
  assert.equal(values.name, 'Renamed');
  assert.equal(Object.prototype.hasOwnProperty.call(values, 'user_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(values, 'mcp_token_hash'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(values, 'mcp_auto_approve'), false);
});

// M7: a self-scoped app_users SELECT is allowed, so the projection is what keeps
// the scrypt password_hash (and the revocation counter) out of the response.
test('M7: app_users selects are projected to a safe column set', () => {
  assert.equal(core.safeSelectColumns('app_users', '*'), 'id, email, display_name, accent_color, created_at');
  assert.equal(core.safeSelectColumns('app_users', undefined), 'id, email, display_name, accent_color, created_at');
  assert.equal(core.safeSelectColumns('app_users', 'id, email'), 'id, email');
  assert.throws(() => core.safeSelectColumns('app_users', 'password_hash'), { status: 403 });
  assert.throws(() => core.safeSelectColumns('app_users', 'id,token_version'), { status: 403 });
  // Tasks are now pinned too: dispatch_requested_by is server-owned private-DM
  // routing provenance, not task content a generic reader should receive.
  assert.equal(
    core.safeSelectColumns('tasks', '*'),
    'id, workspace_id, created_by, assignee_id, title, description, status, priority, due_date, source_type, source_id, completed_at, version, created_at, updated_at, parent_id, start_date, depends_on, attachments',
  );
  assert.equal(core.safeSelectColumns('tasks', '*').includes('dispatch_requested_by'), false);
  assert.equal(core.safeSelectColumns('tasks', 'id, title'), 'id, title');
});

// M7, parity half. The helper above is only a guard if BOTH backends actually
// call it. During the 2026-07 review fix it was wired into the Netlify mirror
// only, leaving the scrypt password_hash still selectable on the Fly server —
// which is the backend agensis.io actually talks to. Assert the wiring itself,
// because a helper nobody calls passes every unit test.
test('M7 parity: both backends project db/select through safeSelectColumns', () => {
  const fs = require('node:fs');
  const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  for (const rel of ['server/index.cjs', 'netlify/functions/backend.mjs']) {
    const source = read(rel);
    assert.ok(
      source.includes('normalizeColumns(safeSelectColumns(table, columns))'),
      `${rel} must project /backend/db/select through safeSelectColumns`,
    );
    assert.ok(
      !/select \$\{normalizeColumns\(columns\)\}/.test(source),
      `${rel} still has an unprojected select — password_hash would leak`,
    );
  }
});
