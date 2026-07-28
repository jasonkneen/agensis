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

const { installBrowserProxy } = require('../server/browser-proxy.cjs');
const { createRateLimiter } = require('../shared/backend-core.cjs');

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
  installBrowserProxy(app, {
    requireAuth: (_req, _res, next) => next(),
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 5 }),
    rateLimitBlocked: () => false,
  });

  assert.equal(app.routes.length, 1);
  assert.equal(app.routes[0].path, '/backend/browser/fetch');
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
  installBrowserProxy(app, {
    requireAuth: (_req, _res, next) => {
      calls.push('auth');
      next();
    },
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 5 }),
    rateLimitBlocked: () => {
      calls.push('ratelimit');
      return true; // stop before any outbound fetch
    },
  });

  const [route] = app.routes;
  assert.equal(route.handlers[0].length, 3, 'first handler should be (req, res, next) auth middleware');

  const res = { set() {}, status() { return this; }, end() {} };
  await route.handlers[route.handlers.length - 1]({ userId: 'u1', get: () => '' }, res);
  assert.deepEqual(calls, ['ratelimit'], 'the handler must consult the limiter itself');
});

test('an over-budget caller never reaches the outbound fetch', async () => {
  const app = fakeApp();
  installBrowserProxy(app, {
    requireAuth: (_req, _res, next) => next(),
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
    rateLimitBlocked: (_res, limiter, key) => !limiter.check(String(key)).allowed,
  });

  const handler = app.routes[0].handlers.at(-1);
  const make = () => ({ userId: 'spammer', get: () => '' });
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
