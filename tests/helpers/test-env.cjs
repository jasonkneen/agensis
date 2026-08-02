'use strict';

// The environment a test process is allowed to see.
//
// This file is PRELOADED into every test worker (`--require` in the `test`
// script, `setupFiles` in both vitest.config.ts and vitest.smoke.config.ts) so
// it runs before any test file's top-level code, before any
// `require('../server/index.cjs')`.
//
// Why it exists: `loadEnvFile()` in server/index.cjs reads the repo's `.env`
// into process.env, and it is called from `getWorkspaceSecretValue`,
// `getDatabaseUrl`, `resolveSecret` and the vault crypto helpers. That made the
// suite's behaviour a function of what happened to be on the developer's
// machine. Concretely: three vault/provider tests `delete process.env.BOX_API_KEY`
// to simulate an UNCONFIGURED credential, `loadEnvFile()` put it straight back
// from `.env`, the code found a credential, and the refusal path they exist to
// cover never ran. They passed for months only because nobody had a Box key yet.
//
// The same leak is worse than three red tests. `.env` also carries DATABASE_URL,
// so a code path that reaches `getDb()` without a test db installed would build
// a live postgres client against the production Neon database from inside a test
// run. `getWorkspaceSecretValue` is exactly such a path: it ignores any injected
// db and always uses the module-level `dbUnsafe`, and `resetTestState()` clears
// that module-level db back to undefined after every test that sets one.
//
// So: the test process gets a KNOWN environment, not the machine's.
//
//   1. `AGENSIS_TEST=1` makes `loadEnvFile()` inert (server/index.cjs). Nothing
//      re-reads `.env` mid-test.
//   2. Every name a real `.env` declares, plus a static list of credential-
//      bearing names, is deleted from process.env — that covers a variable
//      exported in the shell, which no amount of `loadEnvFile()` gating touches.
//   3. DATABASE_URL stays UNSET on purpose. `getDb()` then throws
//      "DATABASE_URL is not set" instead of quietly opening a production
//      connection, so a missing `setTestDb` is a loud failure.
//
// tests/env-isolation.test.cjs asserts all three still hold.

const fs = require('node:fs');
const path = require('node:path');

// Same candidates, in the same order, as loadEnvFile() in server/index.cjs. If
// that list changes, change this one — the guard test compares against whatever
// file the server would actually have read.
function envFileCandidates() {
  return [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '..', '.env'),
  ];
}

/**
 * The name/value pairs a real `.env` on this machine declares, or an empty Map
 * on a clean checkout. Values are returned so the guard test can prove none of
 * them reached process.env; they are never logged, asserted-on by value, or
 * included in a failure message.
 */
function declaredEnvFileEntries() {
  const entries = new Map();
  for (const envPath of envFileCandidates()) {
    let raw;
    try {
      raw = fs.readFileSync(envPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key) entries.set(key, line.slice(eq + 1).trim());
    }
    return entries;
  }
  return entries;
}

// Names that must never carry a real value into a test process even when no
// `.env` exists — a CI runner or a developer's shell profile can export any of
// these. Deployment-relevant names come from AGENTS.md's env table.
const ALWAYS_SCRUB = [
  // Anything that could open a connection to a real database.
  'DATABASE_URL',
  'NETLIFY_DATABASE_URL',
  'NETLIFY_DATABASE_URL_UNPOOLED',
  'NETLIFY_DB_URL',
  'POSTGRES_URL',
  // Key material. AUTH_SECRET in particular: several suites do
  // `process.env.AUTH_SECRET ||= '<literal>'`, which silently signs test tokens
  // with the REAL production HMAC secret whenever one is present.
  'AUTH_SECRET',
  'AGENSIS_AUTH_SECRET',
  'SECRETS_ENCRYPTION_KEY',
  'NETLIFY_WEBHOOK_JWS_SECRET',
  // Provider credentials. BOX_API_KEY is the one that turned the suite red.
  'ANTHROPIC_API_KEY',
  'BOX_API_KEY',
  'CARTESIA_API_KEY',
  'DEEPGRAM_API_KEY',
  'NEON_API_KEY',
  'NPM_ACCESS_TOKEN',
];

/** Every name this preload removes: the static list plus whatever `.env` declares. */
function scrubbedNames() {
  return [...new Set([...ALWAYS_SCRUB, ...declaredEnvFileEntries().keys()])];
}

function applyTestEnvironment() {
  // Read BEFORE scrubbing, so `.env` names are collected while they still exist.
  const names = scrubbedNames();
  process.env.AGENSIS_TEST = '1';
  for (const name of names) delete process.env[name];
  return names;
}

applyTestEnvironment();

/**
 * Run `fn` with one env var pinned to `value` (or deleted, when `value` is
 * undefined), restoring the previous state afterwards.
 *
 * It asserts the pin held on both sides of the call. That is the whole point:
 * the tests this replaces set up an "unconfigured credential" by deleting an env
 * var, something under test put it back mid-call, and the failure surfaced deep
 * in the refusal logic as "expected a refusal, got a successful call" — which
 * reads as a bug in the credential path rather than a leak in the harness. Now
 * the leak fails on its own name.
 */
function withEnv(name, value, fn) {
  const assert = require('node:assert');
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  // assert.ok, never assert.equal: node's reporter dumps `actual` alongside the
  // message, and `actual` here is whatever leaked in — a real credential. The
  // comparison is collapsed to a boolean before it can reach a failure message.
  const check = (when) => assert.ok(
    value === undefined
      ? !Object.prototype.hasOwnProperty.call(process.env, name)
      : process.env[name] === value,
    `${name} is not what this test set (${when} the call). Something re-read the environment mid-test; ` +
    'see tests/helpers/test-env.cjs.',
  );
  const restore = () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
  return Promise.resolve()
    .then(() => { check('before'); return fn(); })
    .then(
      (result) => { check('after'); return result; },
      // The pin is checked on the failure path FIRST, before the caller's error
      // is re-thrown. A leak makes the assertions inside `fn` fail in confusing
      // ways ("expected ok:false, got ok:true") and that error would otherwise
      // be the only thing anyone sees.
      (error) => { check('after'); throw error; },
    )
    .finally(restore);
}

module.exports = {
  ALWAYS_SCRUB,
  applyTestEnvironment,
  declaredEnvFileEntries,
  envFileCandidates,
  scrubbedNames,
  withEnv,
};
