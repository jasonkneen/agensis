'use strict';

// Guards against the class of bug that left shared/backend-core.cjs — the file
// owning auth, RBAC table allowlists, param binding and both rate limiters —
// with ZERO eslint rules applied for months. eslint.config.js listed
// `shared/**/*.mjs`; the only file in shared/ is `backend-core.cjs`. A remediation
// plan for exactly this was written and marked done, because the plan text
// carried the same wrong extension and nobody ran a command to check.
//
// eslint reports nothing for a file it does not match, so "lint is green" and
// "lint never looked at this file" are indistinguishable without asking directly.
// This test asks directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const repoRoot = path.resolve(__dirname, '..');

// One ESLint instance for every lookup — `npx eslint --print-config` per file
// is the same answer but costs ~2s a call, which is most of this file's runtime.
const eslint = new ESLint({ cwd: repoRoot });

async function configFor(relativePath) {
  return eslint.calculateConfigForFile(path.join(repoRoot, relativePath));
}

// Files whose rules being silently dropped would be a security or correctness
// problem, not a style one. Add to this list when a new backend entry point
// lands; do not remove an entry to make the test pass.
const MUST_BE_LINTED = [
  'shared/backend-core.cjs',
  // Silently rewrites user-authored task titles on every create — a correctness
  // problem, not a style one.
  'shared/taskTitle.cjs',
  'server/index.cjs',
  'server/mcp.cjs',
  'server/skills.cjs',
  // Mints LiveKit join tokens and verifies the LiveKit webhook signature.
  'server/huddles.cjs',
  'server/inference-broker.cjs',
  'server/farm-integration.cjs',
  'server/flow-integration.cjs',
  'netlify/functions/backend.mjs',
];

test('every security-critical backend file is matched by an eslint config block', async () => {
  const uncovered = [];
  for (const relativePath of MUST_BE_LINTED) {
    const config = await configFor(relativePath);
    if (Object.keys(config.rules || {}).length === 0) uncovered.push(relativePath);
  }
  assert.deepEqual(
    uncovered,
    [],
    `These files have 0 eslint rules applied — check the file extensions in the\n`
    + `\`files:\` globs in eslint.config.js against what is actually on disk:\n  `
    + uncovered.join('\n  '),
  );
});

test('no-unused-vars is active on the backend, with the _-prefix escape', async () => {
  const config = await configFor('shared/backend-core.cjs');
  const rule = config.rules?.['no-unused-vars'];
  assert.ok(rule, 'no-unused-vars should be configured for backend files');
  // The resolved config normalises severity to its numeric form: 2 === 'error'.
  assert.ok(
    rule[0] === 'error' || rule[0] === 2,
    `no-unused-vars should be an error, not a warning (got ${JSON.stringify(rule[0])})`,
  );
  assert.equal(
    rule[1]?.argsIgnorePattern,
    '^_',
    'the _-prefix convention must stay whitelisted, or six deliberate discards fail the run',
  );
});
