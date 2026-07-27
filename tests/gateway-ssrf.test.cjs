'use strict';

// The inference-gateway `base_url` is set by any workspace member with the
// `manage` role and is then fetched BY THE FLY MACHINE, with the response body
// relayed back to the caller over SSE. Before this guard it was validated with
// `String(...).trim().slice(0, 500)` and nothing else, which made it a request
// forgery primitive against cloud metadata (169.254.169.254), localhost admin
// ports, and Fly's private network.
//
// These tests pin the guard's contract. If one starts failing because "the URL
// is obviously fine", check whether the range table lost an entry before
// relaxing the assertion.

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');
const { assertSafeOutboundUrl, isBlockedAddress } = __test;

async function rejects(url, because) {
  await assert.rejects(
    () => assertSafeOutboundUrl(url),
    (error) => {
      assert.equal(error.status, 400, `${url} should be a 400, not a 500`);
      return true;
    },
    `${url} should have been rejected (${because})`,
  );
}

test('blocks the addresses that make SSRF worth doing', () => {
  const blocked = [
    '169.254.169.254', // cloud metadata — the whole reason this exists
    '127.0.0.1', '127.1.2.3', '0.0.0.0',
    '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', // CGNAT
    '198.18.0.1', // benchmarking range
    '224.0.0.1', // multicast
    '240.0.0.1', // reserved
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:169.254.169.254', // IPv4-mapped metadata address
    '::ffff:127.0.0.1',
    'not-an-ip',
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }
});

test('allows ordinary public addresses', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.167.255.255', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
  }
});

// The IPv6 tests above all matched because the address happened to be spelled the
// way the string checks expected. Two spellings of the SAME blocked addresses did
// not, and reached a fetch:
//
//   ::ffff:a9fe:a9fe  is 169.254.169.254 with the embedded v4 written in hex, so
//                     the `^::ffff:(\d+\.\d+\.\d+\.\d+)$` match missed it and none
//                     of the f-prefix tests applied.
//   0:0:0:0:0:0:0:1   is loopback written out, and is not the string '::1'.
//
// Both are now judged on the NUMBERS. This matters more since the provider proxy
// landed: a credentialed outbound call runs through the same guard, so a bypass
// here is the workspace's provider key posted to whatever the address serves.
test('a blocked IPv6 address is blocked in every spelling of it', () => {
  const blocked = [
    '::ffff:a9fe:a9fe',                    // 169.254.169.254, hex-embedded
    '::ffff:7f00:1',                       // 127.0.0.1, hex-embedded
    '::ffff:0a00:1',                       // 10.0.0.1, hex-embedded
    '0:0:0:0:0:0:0:1',                     // loopback, fully written out
    '0:0:0:0:0:0:0:0',                     // unspecified, fully written out
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::a9fe:a9fe',                         // v4-compatible (deprecated) metadata
    'FE80::1',                             // link-local, uppercase
    'fEc0:0:0:0:0:0:0:1',                  // unique-local, mixed case
    '64:ff9b::a9fe:a9fe',                  // NAT64 — reaches v4 space
    '2001:db8::1',                         // documentation range
    'ff05:0:0:0:0:0:0:2',                  // multicast, written out
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }
});

test('ordinary public IPv6 still passes in expanded form', () => {
  for (const address of [
    '2606:4700:4700:0000:0000:0000:0000:1111',
    '2606:4700:4700::1111',
    '2a00:1450:4009:81f::200e',
  ]) {
    assert.equal(isBlockedAddress(address), false, `${address} should be allowed`);
  }
});

test('172.16.0.0/12 boundaries are exact', () => {
  assert.equal(isBlockedAddress('172.15.255.255'), false, 'just below the range is public');
  assert.equal(isBlockedAddress('172.16.0.0'), true);
  assert.equal(isBlockedAddress('172.31.255.255'), true);
  assert.equal(isBlockedAddress('172.32.0.0'), false, 'just above the range is public');
});

test('rejects private and loopback literals passed as a base_url', async () => {
  await rejects('http://169.254.169.254/latest/meta-data/', 'cloud metadata');
  await rejects('http://127.0.0.1:8080/v1', 'loopback');
  await rejects('http://localhost:3000/v1', 'localhost resolves to loopback');
  await rejects('http://[::1]:3000/v1', 'bracketed IPv6 loopback');
  await rejects('http://192.168.0.10/v1', 'private LAN');
});

test('rejects non-HTTP schemes and embedded credentials', async () => {
  await rejects('file:///etc/passwd', 'file scheme');
  await rejects('gopher://example.com/', 'gopher scheme');
  await rejects('ftp://example.com/', 'ftp scheme');
  await rejects('https://user:pass@example.com/v1', 'credentials in the URL');
  await rejects('', 'empty');
  await rejects('/relative/path', 'not absolute');
  await rejects('example.com/v1', 'no scheme');
});

test('accepts a public https endpoint and strips trailing slashes', async () => {
  // An IP literal on purpose: a hostname here would make the suite depend on
  // DNS resolution, which is a silent flake waiting to happen in CI.
  const normalized = await assertSafeOutboundUrl('https://1.1.1.1/v1///');
  assert.equal(normalized, 'https://1.1.1.1/v1');
});

test('the error message names the field so the UI can surface it', async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl('http://127.0.0.1', 'base_url'),
    (error) => /^base_url /.test(error.message),
  );
});
