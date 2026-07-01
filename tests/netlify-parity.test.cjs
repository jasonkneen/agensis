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
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let handler;   // netlify default export
let core;      // shared/backend-core.mjs

test.before(async () => {
  const backend = await import(pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href);
  handler = backend.default;
  core = await import(pathToFileURL(path.resolve(__dirname, '../shared/backend-core.mjs')).href);
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
  const payload = 'user-1.1'; // `${userId}.${tokenVersion}`
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  // Well-formed (userId + version) payload, but the signature doesn't match.
  assert.equal(await core.verifyAuthToken(`Bearer ${payload}.deadbeef`, secret, unreachableGetTokenVersion), null); // bad signature
  // A correctly signed token whose embedded version matches the current
  // (looked-up) version round-trips (sanity that null isn't unconditional).
  assert.equal(await core.verifyAuthToken(`Bearer ${payload}.${sig}`, secret, async () => '1'), 'user-1');
  // Plan 005 — revocation: a correctly signed token whose embedded version no
  // longer matches the CURRENT looked-up version (e.g. after sign-out/password
  // change bumped it) is rejected, even though the signature is perfectly valid.
  assert.equal(await core.verifyAuthToken(`Bearer ${payload}.${sig}`, secret, async () => '2'), null);
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
