'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Agensis opens agent connections when launched from CursorBuddy connect flow', () => {
  const app = readText('src/App.tsx');

  assert.match(app, /const source = \(params\.get\('source'\) \|\| ''\)\.toLowerCase\(\)/);
  assert.match(app, /const referrer = \(params\.get\('referrer'\) \|\| ''\)\.toLowerCase\(\)/);
  assert.match(app, /const intent = \(params\.get\('intent'\) \|\| ''\)\.toLowerCase\(\)/);
  assert.match(app, /const isCursorBuddy = source === 'cursorbuddy' \|\| referrer === 'cursorbuddy'/);
  assert.match(app, /!\['connect', 'login', 'setup'\]\.includes\(intent\)/);
  assert.match(app, /handleOpenAgents\(\)/);
  assert.match(app, /for \(const key of \['source', 'referrer', 'intent', 'callback', 'state', 'profile', 'host', 'cwd', 'handle', 'name'\]\)/);
});

test('Agensis CLI setup launch posts daemon credentials back to localhost callback', () => {
  const app = readText('src/App.tsx');

  assert.match(app, /const isAgensisCli = source === 'agensis-cli' \|\| referrer === 'agensis-cli'/);
  assert.match(app, /isAgensisCli && intent === 'setup' && callback && state/);
  assert.match(app, /apiUrl\('\/backend\/agensis\/setup\/connect'\)/);
  assert.match(app, /workspaceId,\s*\n\s*profile: params\.get\('profile'\) \|\| 'default'/);
  assert.match(app, /fetch\(callbackUrl,/);
  assert.match(app, /daemonArgs: body\.data\.daemonArgs/);
});
