'use strict';

// NET-08 — the per-key TTL promise cache behind /system/capabilities. Verifies
// cache-hit within TTL, expiry after TTL, in-flight promise sharing (a burst
// shares ONE load), rejections are never cached, and per-key isolation. Uses an
// injectable `now` so time is deterministic (no sleeping).

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const { createTtlPromiseCache } = __test;

test('a second call within TTL reuses the cached result (loader runs once)', async () => {
  let calls = 0;
  const cache = createTtlPromiseCache({ ttlMs: 1000, now: () => 0, loader: async (k) => { calls++; return `v:${k}`; } });
  assert.equal(await cache.get('a'), 'v:a');
  assert.equal(await cache.get('a'), 'v:a');
  assert.equal(calls, 1);
});

test('the cache expires after TTL and reloads', async () => {
  let calls = 0;
  let clock = 0;
  const cache = createTtlPromiseCache({ ttlMs: 1000, now: () => clock, loader: async () => { calls++; return calls; } });
  assert.equal(await cache.get('a'), 1);
  clock = 999; // still within TTL
  assert.equal(await cache.get('a'), 1);
  clock = 1001; // past TTL
  assert.equal(await cache.get('a'), 2);
  assert.equal(calls, 2);
});

test('a burst of concurrent calls shares one in-flight load', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createTtlPromiseCache({ ttlMs: 1000, now: () => 0, loader: async () => { calls++; await gate; return 'done'; } });
  // Fire 5 concurrent gets before the loader resolves.
  const all = Promise.all([cache.get('a'), cache.get('a'), cache.get('a'), cache.get('a'), cache.get('a')]);
  release();
  const results = await all;
  assert.deepEqual(results, ['done', 'done', 'done', 'done', 'done']);
  assert.equal(calls, 1, 'the loader ran exactly once for the whole burst');
});

test('a rejected load is NOT cached — the next call retries', async () => {
  let calls = 0;
  const cache = createTtlPromiseCache({ ttlMs: 1000, now: () => 0, loader: async () => { calls++; if (calls === 1) throw new Error('probe failed'); return 'ok'; } });
  await assert.rejects(() => cache.get('a'), /probe failed/);
  // Second call must retry (not serve the cached rejection).
  assert.equal(await cache.get('a'), 'ok');
  assert.equal(calls, 2);
});

test('distinct keys have independent entries', async () => {
  let calls = 0;
  const cache = createTtlPromiseCache({ ttlMs: 1000, now: () => 0, loader: async (k) => { calls++; return k; } });
  assert.equal(await cache.get('a'), 'a');
  assert.equal(await cache.get('b'), 'b');
  assert.equal(calls, 2);
});

test('keyFn normalizes inputs so equivalent forms share an entry', async () => {
  let calls = 0;
  const cache = createTtlPromiseCache({
    ttlMs: 1000, now: () => 0,
    keyFn: (input) => String(input || '').trim().toLowerCase(),
    loader: async () => { calls++; return calls; },
  });
  await cache.get('ABC');
  await cache.get('  abc  ');
  assert.equal(calls, 1, 'normalized keys collapse to one entry');
});

test('clear() empties the cache', async () => {
  let calls = 0;
  const cache = createTtlPromiseCache({ ttlMs: 1000, now: () => 0, loader: async () => { calls++; return calls; } });
  await cache.get('a');
  cache.clear();
  await cache.get('a');
  assert.equal(calls, 2);
});
