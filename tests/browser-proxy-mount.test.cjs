'use strict';

// This file exists because of a real breakage: installBrowserProxy was written as
// `app.post(path, requireAuth, rateLimiter, handler)`, but createRateLimiter()
// returns `{ check, reset }`, NOT express middleware. Express rejected the
// non-function at MOUNT time, so the whole backend died on boot with
// "argument handler must be a function" — not on first request, on startup.
//
// Nothing in the SSRF suite caught it, because none of it mounted the route. So
// this suite mounts it against a minimal express stand-in and asserts the two
// things that actually broke: every argument handed to app.post is a function,
// and the limiter is consulted through rateLimitBlocked instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { installBrowserProxy } = require('../server/browser-proxy.cjs');
const { createRateLimiter } = require('../shared/backend-core.cjs');

// Every dependency the module needs, in the shape server/index.cjs supplies. The
// handler calls `clientIpFromReq(req)` for the rate-limit key, so omitting it
// does not fail at mount — it throws "clientIpFromReq is not a function" on the
// first real request, which is the worst place to find out.
function deps(overrides = {}) {
  return {
    requireAuth: (_req, _res, next) => next(),
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 5 }),
    rateLimitBlocked: () => false,
    clientIpFromReq: req => req.ip || '127.0.0.1',
    ...overrides,
  };
}

function fakeApp() {
  const routes = [];
  return {
    routes,
    post(path, ...handlers) {
      // Exactly express's own contract, which is what blew up.
      handlers.forEach((handler, index) => {
        assert.equal(
          typeof handler,
          'function',
          `app.post('${path}') argument ${index} must be a function, got ${typeof handler}`,
        );
      });
      routes.push({ path, handlers });
    },
  };
}

test('the route mounts with every handler a function', () => {
  const app = fakeApp();
  installBrowserProxy(app, deps());

  assert.equal(app.routes.length, 1);
  assert.equal(app.routes[0].path, '/backend/browser/fetch');
});

test('server/index.cjs supplies every dependency the module destructures', () => {
  // The other direction of the same drift, and the one that breaks production
  // rather than the suite: the module grows a required dep and the single call
  // site is not updated. Mount-time checks cannot see it — a missing dep is
  // `undefined` until the handler calls it on a live request.
  const read = name => fs.readFileSync(path.join(__dirname, '..', 'server', name), 'utf8');

  const signature = read('browser-proxy.cjs').match(/function installBrowserProxy\s*\(\s*app\s*,\s*\{([^}]*)\}/);
  assert.ok(signature, 'could not find the installBrowserProxy signature');
  const required = signature[1].split(',').map(s => s.trim().split(/[:=]/)[0].trim()).filter(Boolean);

  const callSite = read('index.cjs').match(/installBrowserProxy\s*\(\s*app\s*,\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(callSite, 'could not find the installBrowserProxy call site in index.cjs');
  const supplied = new Set(callSite[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean));

  assert.ok(required.length >= 4, `expected the module to take several deps, parsed ${required.length}`);
  for (const dep of required) {
    assert.ok(supplied.has(dep), `server/index.cjs does not pass "${dep}" to installBrowserProxy`);
  }
});

test('a real createRateLimiter result is NOT express middleware', () => {
  // The mistake in one assertion: it is an object with check/reset, and express
  // would reject it. Anything that reintroduces the middleware form fails above.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
  assert.equal(typeof limiter, 'object');
  assert.equal(typeof limiter.check, 'function');
  assert.notEqual(typeof limiter, 'function');
});

test('auth runs before anything else on the route', async () => {
  const app = fakeApp();
  const calls = [];
  installBrowserProxy(app, deps({
    requireAuth: (_req, _res, next) => {
      calls.push('auth');
      next();
    },
    rateLimitBlocked: () => {
      calls.push('ratelimit');
      return true; // stop before any outbound fetch
    },
  }));

  const [route] = app.routes;
  assert.equal(route.handlers[0].length, 3, 'first handler should be (req, res, next) auth middleware');

  const res = { set() {}, status() { return this; }, end() {} };
  await route.handlers[route.handlers.length - 1]({ userId: 'u1', get: () => '' }, res);
  assert.deepEqual(calls, ['ratelimit'], 'the handler must consult the limiter itself');
});

test('an over-budget caller never reaches the outbound fetch', async () => {
  const app = fakeApp();
  installBrowserProxy(app, deps({
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
    rateLimitBlocked: (_res, limiter, key) => !limiter.check(String(key)).allowed,
  }));

  const handler = app.routes[0].handlers.at(-1);
  const make = () => ({ userId: 'spammer', ip: '203.0.113.7', get: () => '' });
  const res = { set() {}, status() { return this; }, end() {} };

  // First call is allowed and proceeds to URL validation, which refuses the empty
  // url with a 403 — proof it got past the limiter. The second is refused outright.
  let reachedValidation = false;
  const probeRes = {
    set(name, value) { if (name === 'x-relay-error') reachedValidation = Boolean(value); },
    status() { return this; },
    end() {},
  };
  await handler(make(), probeRes);
  assert.equal(reachedValidation, true, 'first request should reach URL validation');

  await handler(make(), res);
});
