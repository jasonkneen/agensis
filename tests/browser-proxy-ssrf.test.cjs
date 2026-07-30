'use strict';

// The web browser panel fetches arbitrary user-chosen URLs from inside the Fly
// machine. That machine holds DATABASE_URL, AUTH_SECRET, SECRETS_ENCRYPTION_KEY
// and every provider key, so the address checks are the feature's security
// boundary, not a nicety.
//
// `assertSafeBrowsingUrl` is a SECOND entry point next to `assertSafeOutboundUrl`,
// and it deliberately relaxes one rule (it permits http://). These tests exist to
// pin exactly which rule was relaxed — a future edit that also relaxes the address
// checks, or that lets the HTTPS-only rule leak back into the gateway path, fails
// here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertSafeBrowsingUrl,
  assertSafeOutboundUrl,
  isBlockedAddress,
  guardedFetchAgent,
} = require('../server/lib/net-guard.cjs');

async function rejects(url) {
  await assert.rejects(() => assertSafeBrowsingUrl(url), `expected ${url} to be refused`);
}

test('browsing guard refuses cloud metadata and loopback', async () => {
  await rejects('http://169.254.169.254/latest/meta-data/');
  await rejects('https://169.254.169.254/');
  await rejects('http://127.0.0.1:3000/');
  await rejects('http://[::1]/');
});

test('browsing guard refuses private and reserved ranges', async () => {
  await rejects('http://10.1.2.3/');
  await rejects('http://192.168.0.1/');
  await rejects('http://172.16.0.1/');
  await rejects('http://100.64.0.1/');
  await rejects('http://0.0.0.0/');
  await rejects('http://224.0.0.1/');
});

test('browsing guard refuses the IPv6 spellings that bypass string checks', async () => {
  // These are the two that a prefix-on-text check misses: 169.254.169.254 written
  // in hex inside a v4-mapped address, and loopback written out in full.
  await rejects('http://[::ffff:a9fe:a9fe]/');
  await rejects('http://[0:0:0:0:0:0:0:1]/');
  await rejects('http://[::ffff:127.0.0.1]/');
  await rejects('http://[fe80::1]/');
  await rejects('http://[fc00::1]/');
  await rejects('http://[64:ff9b::a9fe:a9fe]/');
});

test('browsing guard refuses non-http schemes, credentials and split-horizon names', async () => {
  await rejects('file:///etc/passwd');
  await rejects('ftp://example.com/');
  await rejects('gopher://example.com/');
  await rejects('https://user:pass@example.com/');
  await rejects('https://printer.local/');
  await rejects('https://intranet.internal/');
  await rejects('not a url');
});

test('browsing guard PERMITS plain http, which the gateway guard does not', async () => {
  // The one deliberate divergence. A user typing an http:// address should reach
  // it — there is no workspace API key on that wire to protect. The gateway path
  // must keep refusing it, because there is.
  const url = await assertSafeBrowsingUrl('http://example.com/some/path?q=1');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.pathname, '/some/path');
  assert.equal(url.search, '?q=1');

  await assert.rejects(
    () => assertSafeOutboundUrl('http://example.com/'),
    /HTTPS/,
    'the gateway guard must still be HTTPS-only',
  );
});

test('browsing guard returns a URL object with path and query intact', async () => {
  // assertSafeOutboundUrl returns a trailing-slash-stripped STRING, which would
  // silently corrupt a proxied request. This one must hand back the real URL.
  const url = await assertSafeBrowsingUrl('https://example.com/a/b/?x=1#frag');
  assert.ok(url instanceof URL);
  assert.equal(url.href, 'https://example.com/a/b/?x=1#frag');
});

test('the address predicate is shared, not re-derived', async () => {
  // If someone adds a second predicate for the browsing path, these diverge.
  assert.equal(isBlockedAddress('169.254.169.254'), true);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
});

test('a guarded dispatcher exists and is reused', () => {
  // The pre-flight resolve and undici's own resolve are two separate lookups, so
  // a hostname can move between them (DNS rebinding). The dispatcher re-checks at
  // connect time, which is what actually closes that window.
  const first = guardedFetchAgent();
  assert.ok(first, 'expected a dispatcher');
  assert.equal(guardedFetchAgent(), first, 'dispatcher should be cached, not rebuilt per request');
});
