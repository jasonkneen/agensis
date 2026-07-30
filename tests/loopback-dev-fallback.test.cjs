const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const { allowLoopbackAgentDevFallback } = __test;

const VALID_TOKEN = 'aga_validlookingtoken';

function makeReq({ remoteAddress, host } = {}) {
  return {
    socket: { remoteAddress },
    headers: host === undefined ? {} : { host },
  };
}

test('allowLoopbackAgentDevFallback rejects a spoofed Host header from a non-loopback remoteAddress', () => {
  const originalEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const req = makeReq({ remoteAddress: '10.0.0.5', host: 'localhost:3000' });
    assert.equal(allowLoopbackAgentDevFallback(req, VALID_TOKEN), false);
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});

test('allowLoopbackAgentDevFallback still allows a genuinely loopback remoteAddress regardless of Host header', () => {
  const originalEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const req = makeReq({ remoteAddress: '127.0.0.1', host: 'evil.example.com' });
    assert.equal(allowLoopbackAgentDevFallback(req, VALID_TOKEN), true);
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});

test('allowLoopbackAgentDevFallback rejects a non-loopback remoteAddress with no spoofed Host header (no regression)', () => {
  const originalEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const req = makeReq({ remoteAddress: '10.0.0.5' });
    assert.equal(allowLoopbackAgentDevFallback(req, VALID_TOKEN), false);
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});

test('allowLoopbackAgentDevFallback returns false when NODE_ENV=production regardless of remoteAddress', () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const req = makeReq({ remoteAddress: '127.0.0.1', host: 'localhost:3000' });
    assert.equal(allowLoopbackAgentDevFallback(req, VALID_TOKEN), false);
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});
