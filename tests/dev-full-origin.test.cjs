'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = readFileSync(path.join(root, 'scripts/dev-full.mjs'), 'utf8');

test('the one-command dev stack gives join pages the real frontend origin', () => {
  assert.match(source, /const APP_URL = 'http:\/\/localhost:5173'/);
  assert.match(source, /AGENSIS_APP_URL: process\.env\.AGENSIS_APP_URL \|\| APP_URL/);
  assert.match(source, /'--port', '5173', '--strictPort'/);
});
