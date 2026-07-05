'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('agent tool UI treats structured CursorBuddy metadata as hidden metadata, not visible chips', () => {
  const agentsWindow = readText('src/components/windows/AgentsWindowContent.tsx');
  const chatWindow = readText('src/components/windows/ChatWindowContent.tsx');
  const useChat = readText('src/hooks/useChat.ts');
  const css = readText('src/index.css');

  for (const source of [agentsWindow, chatWindow, useChat]) {
    assert.match(source, /for \(const key of \['label', 'name', 'id', 'type'\]\)/);
    assert.doesNotMatch(source, /Object\.values\(.*tools|Object\.values\(value\)\.map/);
  }

  assert.match(agentsWindow, /className="agent-token-chip"/);
  assert.match(chatWindow, /className="agent-token-chip"/);
  assert.match(css, /\.agent-token-chip/);
  assert.match(css, /text-overflow: ellipsis/);
});

test('CursorBuddy provider writes metadata outside workspace agent tools', () => {
  const server = readText('server/index.cjs');
  const netlify = readText('netlify/functions/backend.mjs');

  for (const source of [server, netlify]) {
    assert.match(source, /JSON\.stringify\(\['cursorbuddy'\]\)/);
    assert.match(source, /cursorbuddyProvider: metadata/);
    assert.match(source, /cursorbuddyRuntime: metadata/);
    assert.doesNotMatch(source, /JSON\.stringify\(\[\{ type: 'provider', name: 'cursorbuddy', metadata/);
    assert.doesNotMatch(source, /JSON\.stringify\(\[\{ type: 'runtime', name: 'cursorbuddy', metadata/);
  }
});
