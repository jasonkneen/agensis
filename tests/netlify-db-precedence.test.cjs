// ============================================================================
// tests/netlify-db-precedence.test.cjs
// ----------------------------------------------------------------------------
// The architecture is TWO BACKENDS OVER ONE DATABASE. This pins the rule that
// keeps that true from the Netlify side.
//
// It did not hold in production. dbPool() resolved
// NETLIFY_DB_URL || NETLIFY_DATABASE_URL || DATABASE_URL, so a Netlify-
// provisioned database silently outranked the configured one and the two
// backends ran on different databases. Google sign-in — the one route that must
// execute on the Netlify origin, because it needs the edge identity context —
// created accounts in that shadow database and minted tokens for them. Every
// other call goes to Fly, which could not find those users and answered 401.
//
// A user could sign in successfully and then get 401 on every request, forever.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(
  path.join(__dirname, '..', 'netlify', 'functions', 'backend.mjs'),
).href;

let resolveDbUrl;
let DB_URL_VARS;

test.before(async () => {
  ({ resolveDbUrl, DB_URL_VARS } = await import(MODULE_URL));
});

test('an explicitly configured DATABASE_URL outranks every auto-provisioned var', () => {
  const resolved = resolveDbUrl({
    DATABASE_URL: 'postgres://configured/real',
    NETLIFY_DATABASE_URL: 'postgres://auto/shadow',
    NETLIFY_DB_URL: 'postgres://auto/shadow2',
  });
  assert.equal(resolved.connectionString, 'postgres://configured/real');
  assert.equal(resolved.source, 'DATABASE_URL');
});

test('DATABASE_URL is first in the precedence list', () => {
  // Belt and braces: the assertion above passes for any order that happens to
  // put DATABASE_URL first today. This pins the intent itself, so reordering
  // the constant fails here rather than silently splitting the databases again.
  assert.equal(DB_URL_VARS[0], 'DATABASE_URL');
});

test('the Netlify-provisioned vars still work when nothing is configured', () => {
  // Local dev and preview deploys legitimately have no DATABASE_URL.
  assert.deepEqual(
    resolveDbUrl({ NETLIFY_DATABASE_URL: 'postgres://auto/only' }),
    { connectionString: 'postgres://auto/only', source: 'NETLIFY_DATABASE_URL', rejected: [] },
  );
  assert.deepEqual(
    resolveDbUrl({ NETLIFY_DB_URL: 'postgres://auto/only' }),
    { connectionString: 'postgres://auto/only', source: 'NETLIFY_DB_URL', rejected: [] },
  );
});

test('blank and whitespace-only values do not count as configured', () => {
  // An env var set to '' is how a misconfigured deploy usually presents. Taking
  // it literally would hand getDatabase an empty connection string instead of
  // falling through to one that works.
  assert.equal(
    resolveDbUrl({ DATABASE_URL: '   ', NETLIFY_DATABASE_URL: 'postgres://auto/real' }).source,
    'NETLIFY_DATABASE_URL',
  );
});

test('no database configuration at all resolves to nothing, not a crash', () => {
  assert.deepEqual(resolveDbUrl({}), { connectionString: '', source: null, rejected: [] });
});

// Production really did have DATABASE_URL set to `=postgresql://…` — one stray
// leading `=`. Promoting it to first place without checking it handed neon() a
// string it rejects and took the whole function down, with a working fallback
// sitting right behind it. A typo must never outrank something that connects.
test('a malformed connection string is skipped, not promoted', () => {
  const resolved = resolveDbUrl({
    DATABASE_URL: '=postgresql://user:pw@host/db',
    NETLIFY_DATABASE_URL: 'postgresql://user:pw@host/db',
  });
  assert.equal(resolved.connectionString, 'postgresql://user:pw@host/db');
  assert.equal(resolved.source, 'NETLIFY_DATABASE_URL');
  assert.deepEqual(resolved.rejected, ['DATABASE_URL']);
});

test('only postgres URLs qualify', () => {
  for (const bad of ['not-a-url', 'http://example.com/db', 'mysql://u:p@h/db', '://x']) {
    assert.equal(resolveDbUrl({ DATABASE_URL: bad }).source, null, `should reject ${bad}`);
  }
  for (const good of ['postgres://u:p@h/db', 'postgresql://u:p@h/db?sslmode=require']) {
    assert.equal(resolveDbUrl({ DATABASE_URL: good }).source, 'DATABASE_URL', `should accept ${good}`);
  }
});
