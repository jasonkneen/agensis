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

  assert.match(app, /source=cursorbuddy&referrer=cursorbuddy&intent=connect/);
  assert.match(app, /const source = \(params\.get\('source'\) \|\| ''\)\.toLowerCase\(\)/);
  assert.match(app, /const referrer = \(params\.get\('referrer'\) \|\| ''\)\.toLowerCase\(\)/);
  assert.match(app, /const intent = \(params\.get\('intent'\) \|\| ''\)\.toLowerCase\(\)/);
  assert.match(app, /source !== 'cursorbuddy' && referrer !== 'cursorbuddy'/);
  assert.match(app, /!\['connect', 'login', 'setup'\]\.includes\(intent\)/);
  assert.match(app, /handleOpenAgents\(\)/);
  assert.match(app, /params\.delete\('source'\)/);
  assert.match(app, /params\.delete\('referrer'\)/);
  assert.match(app, /params\.delete\('intent'\)/);
});
