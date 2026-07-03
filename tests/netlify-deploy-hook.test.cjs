'use strict';

// Regression coverage for the Netlify deploy-webhook signature check.
//
// Netlify signs its outgoing "Deploy succeeded" webhook with a compact JWS in the
// X-Webhook-Signature header: base64url(header).base64url(payload).base64url(sig),
// signed HS256 with a shared secret, whose payload carries sha256 = hex SHA-256 of
// the exact request body. verifyNetlifyDeploySignature must accept a genuine signed
// request and reject every tampered / forged / malformed variant. Pure crypto — no DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { __test } = require('../server/index.cjs');
const { verifyNetlifyDeploySignature } = __test;

const SECRET = 'test-netlify-jws-secret';

// Build a valid Netlify-style JWS for a given raw body + secret.
function signNetlify(rawBody, secret, overrides = {}) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const payload = Buffer.from(JSON.stringify({ iss: 'netlify', sha256, ...overrides })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

test('accepts a genuine signature for the exact body', () => {
  const body = Buffer.from(JSON.stringify({ state: 'ready', commit_ref: 'abc123' }));
  const sig = signNetlify(body, SECRET);
  assert.equal(verifyNetlifyDeploySignature(sig, body, SECRET), true);
});

test('rejects when the body was tampered after signing', () => {
  const original = Buffer.from(JSON.stringify({ state: 'ready', commit_ref: 'abc123' }));
  const sig = signNetlify(original, SECRET);
  const tampered = Buffer.from(JSON.stringify({ state: 'ready', commit_ref: 'evil999' }));
  assert.equal(verifyNetlifyDeploySignature(sig, tampered, SECRET), false);
});

test('rejects a signature made with the wrong secret', () => {
  const body = Buffer.from(JSON.stringify({ state: 'ready' }));
  const sig = signNetlify(body, 'attacker-secret');
  assert.equal(verifyNetlifyDeploySignature(sig, body, SECRET), false);
});

test('rejects when the JWS payload sha256 does not match the body', () => {
  const body = Buffer.from(JSON.stringify({ state: 'ready' }));
  // Correctly signed, but the embedded sha256 claim is for a different body.
  const sig = signNetlify(body, SECRET, { sha256: 'deadbeef' });
  assert.equal(verifyNetlifyDeploySignature(sig, body, SECRET), false);
});

test('rejects malformed headers (not three dot-separated parts)', () => {
  const body = Buffer.from('{}');
  assert.equal(verifyNetlifyDeploySignature('not-a-jws', body, SECRET), false);
  assert.equal(verifyNetlifyDeploySignature('only.two', body, SECRET), false);
  assert.equal(verifyNetlifyDeploySignature('', body, SECRET), false);
});

test('rejects when no secret is configured', () => {
  const body = Buffer.from('{}');
  const sig = signNetlify(body, SECRET);
  assert.equal(verifyNetlifyDeploySignature(sig, body, ''), false);
});

test('rejects a non-string signature header', () => {
  const body = Buffer.from('{}');
  assert.equal(verifyNetlifyDeploySignature(undefined, body, SECRET), false);
  assert.equal(verifyNetlifyDeploySignature(null, body, SECRET), false);
});
