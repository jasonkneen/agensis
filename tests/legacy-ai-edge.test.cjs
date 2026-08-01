'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('the unauthenticated legacy Supabase AI spend boundary is absent', () => {
  const legacyPath = path.join(ROOT, 'supabase/functions/ai-chat/index.ts');
  assert.equal(
    fs.existsSync(legacyPath),
    false,
    'AI turns must use the authenticated /backend/ai-chat or agent execution routes',
  );

  for (const relative of ['server/ai-chat-routes.cjs', 'netlify/functions/backend.mjs']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(source, /workspaceId is required/);
    assert.match(source, /run_agents/);
  }
});
