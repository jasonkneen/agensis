'use strict';

// ============================================================================
// tests/link-preview-route.test.cjs
// ----------------------------------------------------------------------------
// The route half of link preview cards. server/link-preview.cjs owns the SSRF
// gate and is tested on its own (tests/link-preview.test.cjs); what has to hold
// HERE is the plumbing around it, and each of these is a way the feature could
// look fine and still be wrong:
//
//   1. The cache actually caches. A fresh row must be answered from the DB with
//      ZERO outbound fetches — otherwise "cached" is a comment, and every reader
//      of a busy channel is a request to somebody else's server.
//   2. The third-party image URL NEVER reaches the client. The response carries
//      only a path on our own origin, so a card cannot hotlink a stranger's CDN
//      (and leak the reader's IP) even by accident.
//   3. Unauthenticated callers cannot make this machine fetch anything.
//   4. A URL the gate would refuse is dropped before any fetch is attempted.
//
// Offline by construction: every fixture URL is an IP LITERAL, which makes
// net.isIP short-circuit DNS, and globalThis.fetch is replaced with a fake that
// passes localhost through to the real one so the test can still talk to the
// server under test.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp, __test } = require('../server/index.cjs');
const { linkPreviewCacheKey } = require('../server/link-preview.cjs');

const USER = 'user-1';
// A public IP literal: no DNS, no network, and the address gate lets it through.
const TARGET = 'https://93.184.216.34/post';
const IMAGE = 'https://93.184.216.34/card.png';
const ROW_ID = '11111111-2222-4333-8444-555555555555';

const realFetch = globalThis.fetch;

/**
 * Replace global fetch. Anything aimed at 127.0.0.1 (the server under test) goes
 * to the real implementation; everything else is answered from `routes`, and an
 * unexpected outbound URL is a test failure rather than a live request.
 */
function installFakeFetch(routes) {
  const outbound = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('127.0.0.1')) return realFetch(url, init);
    outbound.push(href);
    const reply = routes[href];
    if (!reply) throw new Error(`unexpected outbound fetch: ${href}`);
    return reply();
  };
  return outbound;
}

function bodyOf(chunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) return void controller.close();
      const chunk = chunks[index++];
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    },
  });
}

const PAGE = `<html><head>
  <meta property="og:title" content="Crazy how good these models are">
  <meta property="og:description" content="A short thread.">
  <meta property="og:site_name" content="Example">
  <meta property="og:image" content="/card.png">
</head></html>`;

function htmlReply() {
  return { status: 200, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }), body: bodyOf([PAGE]) };
}

function pngReply(bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])) {
  return { status: 200, headers: new Headers({ 'content-type': 'image/png' }), body: bodyOf([bytes]) };
}

function cachedRow(overrides = {}) {
  return {
    id: ROW_ID,
    url_hash: linkPreviewCacheKey(TARGET),
    url: TARGET,
    final_url: TARGET,
    status: 'ok',
    title: 'Cached title',
    description: 'Cached description',
    site_name: 'Example',
    image_url: IMAGE,
    detail: '',
    fetched_at: new Date('2026-07-26T10:00:00.000Z'),
    expires_at: new Date('2026-08-02T10:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Recording fake DB. `cache` is keyed by url_hash and stands in for the fresh
 * rows in link_previews; `inserted` records every upsert the route performs.
 */
function makeDb({ cache = new Map(), images = new Map() } = {}) {
  const calls = [];
  const inserted = [];
  const db = {
    calls,
    inserted,
    cache,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: String(sql), normalized: n, params });
      if (n.startsWith('alter table') || n.startsWith('create table') || n.startsWith('create index')
        || n.startsWith('create extension') || n.startsWith('do $$') || n.startsWith('delete from rate_limits')) {
        return [];
      }
      if (n.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'link-preview-secret' }] : [];
      }
      if (n.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (n.startsWith('insert into rate_limits')) return [{ count: 1 }];
      if (n.startsWith('select id, url_hash, url, final_url, status')) {
        return params.map(hash => cache.get(hash)).filter(Boolean);
      }
      if (n.startsWith('insert into link_previews')) {
        const [urlHash, url, finalUrl, status, title, description, siteName, imageUrl, detail] = params;
        const row = {
          id: ROW_ID,
          url_hash: urlHash,
          url,
          final_url: finalUrl,
          status,
          title,
          description,
          site_name: siteName,
          image_url: imageUrl,
          detail,
          fetched_at: new Date(),
          expires_at: new Date(Date.now() + 86400000),
        };
        inserted.push({ row, ttlSeconds: params[9] });
        cache.set(urlHash, row);
        return [row];
      }
      if (n.startsWith('select image_url from link_previews')) {
        const found = images.get(params[0]);
        return found === undefined ? [] : [{ image_url: found }];
      }
      throw new Error(`Unexpected SQL in link-preview route test: ${sql}`);
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
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function unfurlCalls(db) {
  return db.calls.filter(call => call.normalized.startsWith('select id, url_hash, url, final_url, status'));
}

test.beforeEach(() => {
  __test.resetTestState();
});
test.afterEach(() => {
  __test.resetTestState();
  globalThis.fetch = realFetch;
});

// --- auth -------------------------------------------------------------------

test('POST /backend/link-previews requires auth and fetches nothing without it', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const outbound = installFakeFetch({});
  await withServer(async (baseUrl) => {
    const res = await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [TARGET] }),
    });
    assert.equal(res.status, 401);
    // The whole point of this route is that it makes outbound requests. An
    // unauthenticated caller must not be able to trigger one.
    assert.deepEqual(outbound, []);
    assert.equal(unfurlCalls(db).length, 0);
  });
});

test('GET the image proxy requires auth', async () => {
  const db = makeDb({ images: new Map([[ROW_ID, IMAGE]]) });
  __test.setTestDb(db);
  const outbound = installFakeFetch({});
  await withServer(async (baseUrl) => {
    const res = await realFetch(`${baseUrl}/backend/link-previews/${ROW_ID}/image`);
    assert.equal(res.status, 401);
    assert.deepEqual(outbound, []);
  });
});

// --- the cache --------------------------------------------------------------

test('a fresh cache row is answered with ZERO outbound fetches', async () => {
  const cache = new Map([[linkPreviewCacheKey(TARGET), cachedRow()]]);
  const db = makeDb({ cache });
  __test.setTestDb(db);
  const outbound = installFakeFetch({});
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls: [TARGET] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.previews.length, 1);
    assert.equal(body.data.previews[0].title, 'Cached title');
    // One fetch per URL for the whole install, not one per reader or per render.
    assert.deepEqual(outbound, []);
    assert.equal(db.inserted.length, 0, 'a cache hit must not rewrite the row');
  });
});

test('the cache lookup is bounded to unexpired rows', async () => {
  const db = makeDb({ cache: new Map([[linkPreviewCacheKey(TARGET), cachedRow()]]) });
  __test.setTestDb(db);
  installFakeFetch({});
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls: [TARGET] }),
    });
    const lookup = unfurlCalls(db)[0];
    assert.ok(lookup, 'the cache was consulted');
    // Without this clause the TTL is decorative and a stale card never refreshes.
    assert.match(lookup.normalized, /expires_at > now\(\)/);
    // Explicit projection, never `select *` — a column added later must fail
    // loudly rather than load blank.
    assert.match(lookup.normalized, /^select id, url_hash, url, final_url, status/);
    assert.deepEqual(lookup.params, [linkPreviewCacheKey(TARGET)]);
  });
});

test('a miss fetches once, writes the row, and answers from it', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const outbound = installFakeFetch({ [TARGET]: htmlReply });
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls: [TARGET] }),
    });
    assert.equal(res.status, 200);
    const preview = (await res.json()).data.previews[0];
    assert.equal(preview.status, 'ok');
    assert.equal(preview.title, 'Crazy how good these models are');
    assert.equal(preview.description, 'A short thread.');
    assert.equal(preview.siteName, 'Example');
    assert.deepEqual(outbound, [TARGET]);
    assert.equal(db.inserted.length, 1);
    // A successful unfurl is held for a week.
    assert.equal(db.inserted[0].ttlSeconds, 7 * 24 * 60 * 60);
  });
});

test('the SAME url twice in one request is fetched once', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const outbound = installFakeFetch({ [TARGET]: htmlReply });
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // Three spellings of one page: bare, with a fragment, and duplicated.
      body: JSON.stringify({ urls: [TARGET, `${TARGET}#reply`, TARGET] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.previews.length, 1);
    assert.deepEqual(outbound, [TARGET]);
  });
});

test('the number of urls per request is capped', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  // 20 distinct public IP literals; the cap is 8.
  const urls = Array.from({ length: 20 }, (_unused, index) => `https://93.184.216.${index + 10}/p`);
  const routes = {};
  for (const url of urls) routes[url] = htmlReply;
  const outbound = installFakeFetch(routes);
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.previews.length, 8);
    assert.equal(outbound.length, 8);
  });
});

test('a url the gate refuses is dropped before anything is fetched', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const outbound = installFakeFetch({});
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        urls: [
          'http://169.254.169.254/latest/meta-data/',
          'http://127.0.0.1:8080/admin',
          'http://localhost/x',
          'file:///etc/passwd',
          'https://user:pass@93.184.216.34/x',
          'not a url',
          '',
          null,
          42,
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.previews, []);
    assert.deepEqual(outbound, [], 'nothing on that list may cause a request');
    // Nor may any of them create a cache row.
    assert.equal(db.inserted.length, 0);
  });
});

test('a non-array (or absent) urls field is an empty answer, not a 500', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  installFakeFetch({});
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    for (const body of ['{}', '{"urls":"https://93.184.216.34/x"}', '{"urls":null}', '{"urls":[]}']) {
      const res = await realFetch(`${baseUrl}/backend/link-previews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body,
      });
      assert.equal(res.status, 200, `body ${body} should not 500`);
      assert.deepEqual((await res.json()).data.previews, []);
    }
  });
});

// --- the image never leaks --------------------------------------------------

test('the third-party image URL is never returned to the client', async () => {
  const db = makeDb({ cache: new Map([[linkPreviewCacheKey(TARGET), cachedRow()]]) });
  __test.setTestDb(db);
  installFakeFetch({});
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls: [TARGET] }),
    });
    const raw = await res.text();
    const preview = JSON.parse(raw).data.previews[0];
    // A path on OUR origin. If this were the remote URL, every reader's IP would
    // go to that host on every render — the exact leak unfurling server-side is
    // supposed to prevent.
    assert.equal(preview.imagePath, `/backend/link-previews/${ROW_ID}/image`);
    assert.equal(preview.imageUrl, undefined);
    assert.ok(!raw.includes(IMAGE), 'the remote image URL must not appear anywhere in the response');
  });
});

test('a preview with no image reports no image path at all', async () => {
  const db = makeDb({ cache: new Map([[linkPreviewCacheKey(TARGET), cachedRow({ image_url: '' })]]) });
  __test.setTestDb(db);
  installFakeFetch({});
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls: [TARGET] }),
    });
    assert.equal((await res.json()).data.previews[0].imagePath, '');
  });
});

// --- the image proxy --------------------------------------------------------

test('the image proxy serves bytes with the headers a foreign body needs', async () => {
  const db = makeDb({ images: new Map([[ROW_ID, IMAGE]]) });
  __test.setTestDb(db);
  const outbound = installFakeFetch({ [IMAGE]: () => pngReply() });
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews/${ROW_ID}/image`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(String(res.headers.get('cache-control')), /private/);
    assert.match(String(res.headers.get('content-security-policy')), /default-src 'none'/);
    assert.equal((await res.arrayBuffer()).byteLength, 8);
    assert.deepEqual(outbound, [IMAGE]);
  });
});

test('the proxy takes an ID, so there is no URL for a caller to choose', async () => {
  // This is the reason the proxy is barely an SSRF surface: the only input is a
  // row id, and the URL comes from a row this server unfurled and validated.
  const db = makeDb({ images: new Map([[ROW_ID, IMAGE]]) });
  __test.setTestDb(db);
  const outbound = installFakeFetch({ [IMAGE]: () => pngReply() });
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const attempts = [
      `${baseUrl}/backend/link-previews/${ROW_ID}/image?url=http://169.254.169.254/`,
      `${baseUrl}/backend/link-previews/${ROW_ID}/image?image_url=http://10.0.0.1/x.png`,
    ];
    for (const attempt of attempts) {
      const res = await realFetch(attempt, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
    // Both requests fetched the STORED url; the query string is ignored entirely.
    assert.deepEqual(outbound, [IMAGE, IMAGE]);
  });
});

test('a bad, unknown or imageless id is a 404 and touches no network', async () => {
  const db = makeDb({ images: new Map([['22222222-3333-4333-8444-555555555555', '']]) });
  __test.setTestDb(db);
  const outbound = installFakeFetch({});
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const cases = [
      // Not a uuid: must 404, not 500 on a failed ::uuid cast.
      '../../etc/passwd',
      'not-a-uuid',
      crypto.randomUUID(), // well-formed, no such row
      '22222222-3333-4333-8444-555555555555', // a row with no image
    ];
    for (const id of cases) {
      const res = await realFetch(`${baseUrl}/backend/link-previews/${encodeURIComponent(id)}/image`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 404, `${id} should be a 404`);
    }
    assert.deepEqual(outbound, []);
  });
});

test('an image the gate refuses is a 502, and never a redirect the browser follows', async () => {
  const db = makeDb({ images: new Map([[ROW_ID, IMAGE]]) });
  __test.setTestDb(db);
  installFakeFetch({
    [IMAGE]: () => ({ status: 302, headers: new Headers({ location: 'http://169.254.169.254/' }), body: null }),
  });
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken(USER, '1');
    const res = await realFetch(`${baseUrl}/backend/link-previews/${ROW_ID}/image`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
    });
    // The failure is reported as our own error. We do NOT hand the redirect to
    // the browser, which would make the reader's machine do the fetch we refused.
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('location'), null);
  });
});
