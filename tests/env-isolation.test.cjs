// SNAPSHOT FIRST — before any require, including the helper this file asserts on.
//
// The question this file answers is "did the isolation run BEFORE the suite?",
// and `require('./helpers/test-env.cjs')` applies that isolation as a side
// effect of being loaded. Reading process.env after the requires would make
// every assertion below true by construction: the guard would pass on exactly
// the broken configuration it exists to catch. (It did, on the first draft.)
const PRELOAD_MARKER_AT_LOAD = process.env.AGENSIS_TEST;
const ENV_AT_LOAD = { ...process.env };

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { __test } = require('../server/index.cjs');
const { ALWAYS_SCRUB, declaredEnvFileEntries, scrubbedNames } = require('./helpers/test-env.cjs');

// The guard on the isolation itself.
//
// A test suite whose result depends on what is in a developer's `.env` is not a
// test suite. Three vault/provider tests went red the day someone put a real
// BOX_API_KEY in `.env`: they delete that variable to simulate an UNCONFIGURED
// credential, and `loadEnvFile()` — called from getWorkspaceSecretValue —
// re-read the file and handed the real key back, so the refusal path they exist
// to cover never ran. They had "passed" for months only because the value did
// not exist yet.
//
// This file fails loudly if that isolation ever comes undone. It never asserts
// on, prints, or embeds a secret VALUE in a message; it compares and reports
// only names and booleans.

const REPO_ROOT = path.join(__dirname, '..');

const PRELOAD_HINT =
  'tests/helpers/test-env.cjs must be preloaded (--require for npm test, setupFiles for vitest).';

test('the isolation ran before this file, not because of it', () => {
  assert.equal(PRELOAD_MARKER_AT_LOAD, '1', PRELOAD_HINT);
});

test('the test process is not carrying any value from a real .env', () => {
  const leaked = [];
  for (const [name, value] of declaredEnvFileEntries()) {
    if (value === '') continue; // an empty declaration cannot leak anything
    // Both moments matter, and they catch different failures. ENV_AT_LOAD only
    // ever holds a real value if the preload did NOT run ahead of this file —
    // including the case where AGENSIS_TEST is exported by hand (so the marker
    // test above passes) but the runner was never wired. `process.env` now is
    // the live check: it catches something re-reading `.env` mid-run, which is
    // the original bug and the one a code change can reintroduce.
    if (ENV_AT_LOAD[name] === value || process.env[name] === value) leaked.push(name);
  }
  assert.deepEqual(
    leaked,
    [],
    `these env vars held their real .env value inside the test process: ${leaked.join(', ')}. ` +
    `${PRELOAD_HINT} loadEnvFile() must also stay inert under AGENSIS_TEST=1.`,
  );
});

test('every credential-bearing name was scrubbed, whatever the machine exports', () => {
  const declared = declaredEnvFileEntries();
  // A suite may install its own deterministic value (several do
  // `process.env.AUTH_SECRET ||= '<literal>'` at module scope), which is fine.
  // What must not survive is the value the machine supplied.
  const untouched = scrubbedNames().filter((name) => declared.has(name) && ENV_AT_LOAD[name] === declared.get(name));
  assert.deepEqual(untouched, [], `not scrubbed: ${untouched.join(', ')}`);
  // The static half is what survives on a machine with no `.env` at all, where
  // the names come from the shell instead.
  for (const name of ['DATABASE_URL', 'AUTH_SECRET', 'ANTHROPIC_API_KEY', 'BOX_API_KEY']) {
    assert.ok(ALWAYS_SCRUB.includes(name), `${name} must always be scrubbed`);
  }
});

test('loadEnvFile() is inert: reading a secret does not repopulate process.env', async () => {
  // Pick a name the local `.env` actually declares with a value, so this asserts
  // against the real file rather than a hypothetical. On a clean checkout there
  // is nothing to leak and the marker test above carries the property.
  const canary = [...declaredEnvFileEntries()].find(([, value]) => value !== '');
  __test.resetTestState(); // clears `envLoaded`, so the next call would re-read the file
  // Any vault/secret helper calls loadEnvFile() first.
  await __test.getWorkspaceSecretValue('ws-isolation', 'ANTHROPIC_API_KEY').catch(() => '');
  if (canary) {
    const [name, value] = canary;
    // assert.ok, not assert.notEqual — see the note in test-env.cjs: node prints
    // `actual` next to the message, and `actual` would be the leaked credential.
    assert.ok(process.env[name] !== value, `loadEnvFile() put ${name} back into the test process`);
  }
});

test('a test process cannot reach a real database', async () => {
  assert.ok(ENV_AT_LOAD.DATABASE_URL === undefined, `DATABASE_URL was set when this file loaded. ${PRELOAD_HINT}`);
  __test.resetTestState();
  assert.ok(!__test.getDatabaseUrl(), 'DATABASE_URL must be unset so getDb() cannot dial a live host');

  // Why this matters beyond "no connection string": getWorkspaceSecretValue and
  // setWorkspaceSecretValue take NO db argument. They always use the module-level
  // `dbUnsafe`, so a test that carefully builds a mock db and passes it somewhere
  // else does not redirect them — only __test.setTestDb does, and resetTestState
  // clears that back to undefined after every test that sets one. With a
  // developer's DATABASE_URL in scope that is a live production client built
  // inside a test run; six were being built per suite run via notifyDbSubscribers
  // -> enqueueFlowWebhookEvents -> flowEventLocation, whose errors are swallowed
  // by a fire-and-forget `.catch`. Unset, it throws here, where somebody sees it.
  await assert.rejects(
    () => __test.getWorkspaceSecretValue('ws-isolation', 'BOX_API_KEY'),
    /DATABASE_URL is not set/,
    'with no test db installed the vault read must throw, not connect',
  );
});

test('EVERY runner preloads the isolation, including ones added later', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(
    pkg.scripts.test,
    /--require \.\/tests\/helpers\/test-env\.cjs/,
    'npm test must preload tests/helpers/test-env.cjs',
  );

  // Discovered, not enumerated. This repo grows test runners — `npm run smoke`
  // (vitest.smoke.config.ts) arrived with its own setupFiles and no env
  // isolation. An enumerated list would have stayed green while a whole new
  // runner read the developer's `.env`, which is the exact failure mode this
  // file exists to make impossible.
  const configs = fs.readdirSync(REPO_ROOT).filter((name) => /^vitest.*\.config\.(ts|js|mjs)$/.test(name));
  assert.ok(configs.length > 0, 'no vitest config found — has this test gone stale?');
  const unprotected = configs.filter((name) => {
    return !fs.readFileSync(path.join(REPO_ROOT, name), 'utf8').includes('tests/helpers/test-env.cjs');
  });
  assert.deepEqual(
    unprotected,
    [],
    `these vitest configs do not preload tests/helpers/test-env.cjs: ${unprotected.join(', ')}. ` +
    "Add it to that config's setupFiles — every runner needs it, not just the first two.",
  );
});

test('the preload reads the same .env candidates the server would have read', () => {
  // If loadEnvFile()'s candidate list changes and this one does not, the preload
  // would scrub names from a file the server never reads while leaving the real
  // one intact — silently restoring the bug.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'server', 'index.cjs'), 'utf8');
  const loader = source.slice(source.indexOf('function loadEnvFile()'));
  assert.match(loader, /path\.join\(process\.cwd\(\), '\.env'\)/);
  assert.match(loader, /path\.join\(__dirname, '\.\.', '\.env'\)/);
  assert.match(loader, /process\.env\.AGENSIS_TEST === '1'/, 'the test bypass must still be there');
});
