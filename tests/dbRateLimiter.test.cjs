'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDbRateLimiter } = require('../shared/backend-core.cjs');

// An in-memory fake of the `rate_limits` table implementing the one atomic
// statement the limiter issues: insert ... on conflict do update ... returning count.
function makeFakeDb() {
  const rows = new Map(); // `${bucket}|${windowIso}` -> count
  const calls = [];
  async function db(sql, params) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    calls.push({ sql: normalized, params });
    if (normalized.startsWith('insert into rate_limits')) {
      const [bucket, windowStart] = params;
      const key = `${bucket}|${new Date(windowStart).toISOString()}`;
      const next = (rows.get(key) || 0) + 1;
      rows.set(key, next);
      return [{ count: next }];
    }
    if (normalized.startsWith('delete from rate_limits')) {
      return [];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }
  return { db, rows, calls };
}

test('allows requests up to max, blocks beyond it', async () => {
  const { db } = makeFakeDb();
  const limiter = createDbRateLimiter({ windowMs: 60_000, max: 3, db, namespace: 't' });

  const r1 = await limiter.check('user-1');
  const r2 = await limiter.check('user-1');
  const r3 = await limiter.check('user-1');
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
  assert.equal(r3.remaining, 0);

  const r4 = await limiter.check('user-1');
  assert.equal(r4.allowed, false);
  assert.equal(r4.blocked, true);
  assert.ok(r4.retryAfterMs > 0 && r4.retryAfterMs <= 60_000);
});

test('separate keys have independent budgets', async () => {
  const { db } = makeFakeDb();
  const limiter = createDbRateLimiter({ windowMs: 60_000, max: 1, db, namespace: 't' });

  assert.equal((await limiter.check('a')).allowed, true);
  assert.equal((await limiter.check('a')).allowed, false);
  // A different key is unaffected.
  assert.equal((await limiter.check('b')).allowed, true);
});

test('namespaces isolate identical keys', async () => {
  const { db } = makeFakeDb();
  const a = createDbRateLimiter({ windowMs: 60_000, max: 1, db, namespace: 'ns-a' });
  const b = createDbRateLimiter({ windowMs: 60_000, max: 1, db, namespace: 'ns-b' });

  assert.equal((await a.check('k')).allowed, true);
  assert.equal((await a.check('k')).allowed, false);
  // Same key, different namespace -> its own budget.
  assert.equal((await b.check('k')).allowed, true);
});

test('fails OPEN when the DB throws (never 429s on infra error)', async () => {
  const db = async () => { throw new Error('db down'); };
  const limiter = createDbRateLimiter({ windowMs: 60_000, max: 1, db, namespace: 't' });

  // Even well beyond max, a throwing DB must return allowed.
  for (let i = 0; i < 5; i++) {
    const r = await limiter.check('user-1');
    assert.equal(r.allowed, true);
    assert.equal(r.blocked, false);
  }
});

test('sweep deletes old windows and never throws', async () => {
  const { db, calls } = makeFakeDb();
  const limiter = createDbRateLimiter({ windowMs: 60_000, max: 5, db, namespace: 't' });
  await limiter.sweep();
  assert.ok(calls.some(c => c.sql.startsWith('delete from rate_limits')));
});

test('sweep swallows DB errors', async () => {
  const db = async (sql) => {
    if (String(sql).toLowerCase().includes('delete')) throw new Error('boom');
    return [{ count: 1 }];
  };
  const limiter = createDbRateLimiter({ windowMs: 60_000, max: 5, db, namespace: 't' });
  await assert.doesNotReject(() => limiter.sweep());
});
