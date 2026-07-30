'use strict';

// ============================================================================
// tests/browser-proxy-response-cap.test.cjs
// ----------------------------------------------------------------------------
// The WEB browser panel's egress relay reads a capped number of bytes.
//
// It did not. `Buffer.from(await upstream.arrayBuffer())` materialised the whole
// remote body in RAM before anything was written back, and the file's only cap
// (MAX_BODY_BYTES) was applied to the inbound REQUEST body and nowhere else. The
// request direction is bounded by what a logged-in user can be bothered to
// upload; the response direction is whatever URL they type. One navigation to a
// large asset is an OOM of a 2gb Fly machine (fly.toml [[vm]]), and the rate
// limiter on this route allows 900 requests a minute.
//
// Why this tests readCapped and not the route: assertSafeBrowsingUrl blocks
// 127.0.0.0/8, so there is no upstream a test is permitted to point the route
// at. Adding an escape hatch to the SSRF guard so a test could reach a local
// server would weaken the one thing on this path that must never be weakened —
// this module fetches attacker-chosen URLs from inside the machine that holds
// DATABASE_URL. The cap is where the logic lives, so the cap is what is tested.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/browser-proxy.cjs');

const { readCapped } = __test;

/**
 * The parts of a fetch Response that readCapped touches: a headers.get and an
 * async-iterable body. `cancelled` records whether the reader was released,
 * which is the difference between abandoning a download and leaving it draining
 * in the background.
 */
function fakeResponse({ chunks, contentLength = null }) {
  const state = { cancelled: false, pulled: 0 };
  return {
    state,
    headers: { get: (name) => (name === 'content-length' && contentLength !== null ? String(contentLength) : null) },
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          state.pulled += 1;
          yield Buffer.from(chunk);
        }
      },
      cancel: async () => { state.cancelled = true; },
    },
  };
}

test('a body under the cap is returned intact', () => {
  const response = fakeResponse({ chunks: ['hello ', 'world'] });
  return readCapped(response, 1024).then((buffer) => {
    assert.equal(buffer.toString(), 'hello world');
  });
});

test('an oversized body is refused mid-stream, not after it has been buffered', async () => {
  // THE assertion. The point is not merely that it throws — it is that it stops
  // PULLING. A cap enforced after the fact would have already allocated the very
  // bytes it exists to refuse.
  //
  // MUTATION: go back to `await upstream.arrayBuffer()` -> this fails.
  const chunks = Array.from({ length: 100 }, () => 'x'.repeat(1000)); // 100KB in 100 chunks
  const response = fakeResponse({ chunks });
  await assert.rejects(
    () => readCapped(response, 10_000),
    (error) => error.code === 'ERELAYTOOLARGE',
  );
  assert.ok(
    response.state.pulled <= 12,
    `must stop pulling at the cap, pulled ${response.state.pulled}/100 chunks`,
  );
  assert.ok(response.state.cancelled, 'the body must be cancelled so the socket is released');
});

test('a declared content-length over the cap is refused before a single byte is read', async () => {
  // The cheap early exit. Content-Length is foreign, client-influenced data so it
  // is NOT the enforcement point — the streaming tally above is — but when a
  // server is honest about sending 4GB there is no reason to start reading it.
  const response = fakeResponse({ chunks: ['x'], contentLength: 4 * 1024 * 1024 * 1024 });
  await assert.rejects(
    () => readCapped(response, 10_000),
    (error) => error.code === 'ERELAYTOOLARGE',
  );
  assert.equal(response.state.pulled, 0, 'nothing should have been pulled');
});

test('a LYING content-length does not get past the streaming tally', async () => {
  // The reason the header is not trusted: a hostile upstream declares 10 bytes
  // and then sends 100KB. Only the running total can catch that.
  //
  // MUTATION: make the content-length check the only enforcement -> this fails.
  const chunks = Array.from({ length: 100 }, () => 'x'.repeat(1000));
  const response = fakeResponse({ chunks, contentLength: 10 });
  await assert.rejects(
    () => readCapped(response, 10_000),
    (error) => error.code === 'ERELAYTOOLARGE',
  );
  assert.ok(response.state.cancelled, 'the body must still be cancelled');
});

test('a response with no body is an empty buffer, not a crash', async () => {
  const buffer = await readCapped({ headers: { get: () => null }, body: null }, 1024);
  assert.equal(buffer.length, 0);
});

test('the response cap and the upstream deadline are actually set', () => {
  assert.equal(typeof __test.MAX_RESPONSE_BYTES, 'number');
  assert.ok(__test.MAX_RESPONSE_BYTES > 0 && __test.MAX_RESPONSE_BYTES <= 64 * 1024 * 1024);
  assert.equal(typeof __test.UPSTREAM_TIMEOUT_MS, 'number');
  assert.ok(__test.UPSTREAM_TIMEOUT_MS > 0);
});
