'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('channel bridge tables exist in runtime, canonical schema, and migration', () => {
  const sources = [
    ['runtime bootstrap', read('server/index.cjs')],
    ['canonical schema', read('database/neon-schema.sql')],
    ['forward migration', read('supabase/migrations/20260731170000_channel_bridges_canonical.sql')],
  ];

  for (const [label, source] of sources) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS channel_bridges\s*\(/i, `${label} must create channel_bridges`);
    assert.match(source, /CREATE TABLE IF NOT EXISTS bridge_messages\s*\(/i, `${label} must create bridge_messages`);
    assert.match(source, /uq_channel_bridges_session/i, `${label} must enforce one bridge per session`);
    assert.match(source, /uq_bridge_messages_external/i, `${label} must make ingress idempotent`);
  }
});

test('runtime creates agent_connections before the bridge foreign key', () => {
  const runtime = read('server/index.cjs');
  const connections = runtime.indexOf('CREATE TABLE IF NOT EXISTS agent_connections');
  const bridges = runtime.indexOf('CREATE TABLE IF NOT EXISTS channel_bridges');
  assert.ok(connections >= 0 && bridges > connections);
});

test('rate limits exist in runtime, canonical schema, and migration', () => {
  for (const [label, source] of [
    ['runtime bootstrap', read('server/index.cjs')],
    ['canonical schema', read('database/neon-schema.sql')],
    ['forward migration', read('supabase/migrations/20260718120000_rate_limits.sql')],
  ]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rate_limits\s*\(/i, `${label} must create rate_limits`);
    assert.match(source, /idx_rate_limits_window_start/i, `${label} must index expiry sweeps`);
  }
});
