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
    assert.match(source, /cursorbuddyProvider: metadata/);
    assert.match(source, /cursorbuddyRuntime: metadata/);
    assert.doesNotMatch(source, /JSON\.stringify\(\[\{ type: 'provider', name: 'cursorbuddy', metadata/);
    assert.doesNotMatch(source, /JSON\.stringify\(\[\{ type: 'runtime', name: 'cursorbuddy', metadata/);
  }

  // The two backends bind jsonb OPPOSITELY, and both forms below are correct for
  // their own driver. Verified against the live database:
  //
  //   postgres (porsager, Fly)   bind array -> jsonb array     stringify -> jsonb STRING
  //   @netlify/database (Neon)   bind array -> ERROR           stringify -> jsonb array
  //
  // Getting this backwards is silent on Fly — it stores a jsonb string scalar,
  // every Array.isArray() on the client reads empty, and the data looks present
  // in psql. That is how 88 sessions lost their participants. Copying the
  // "fix" to the Netlify side would instead throw on every write.
  assert.doesNotMatch(server, /JSON\.stringify\(\['cursorbuddy'\]\)/,
    'server/index.cjs must bind the ARRAY (porsager stringifies a string into a jsonb string scalar)');
  assert.match(server, /^\s*\['cursorbuddy'\],$/m,
    'server/index.cjs binds the array literal');
  assert.match(netlify, /JSON\.stringify\(\['cursorbuddy'\]\)/,
    'netlify/functions/backend.mjs must bind the STRING (@netlify/database rejects a raw array)');
});
