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

test('verifyAuthToken returns null for missing/garbage tokens (gates every requireUserId route)', () => {
  const secret = 'parity-secret';
  assert.equal(core.verifyAuthToken(undefined, secret), null);     // no header
  assert.equal(core.verifyAuthToken('', secret), null);            // empty header
  assert.equal(core.verifyAuthToken('Bearer garbage', secret), null); // no dot -> not a token
  assert.equal(core.verifyAuthToken('Bearer user-1.deadbeef', secret), null); // bad signature
  // A correctly signed token round-trips (sanity that null isn't unconditional).
  const crypto = require('node:crypto');
  const sig = crypto.createHmac('sha256', secret).update('user-1').digest('base64url');
  assert.equal(core.verifyAuthToken(`Bearer user-1.${sig}`, secret), 'user-1');
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
    const sig = require('crypto').createHmac('sha256', 'change-password-test-secret').update('user-1').digest('base64url');
    const token = `user-1.${sig}`;

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
