'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migrationName = '20260731170000_messages_live_session_guard.sql';

function sources() {
  return {
    runtime: read('server/index.cjs'),
    canonical: read('database/neon-schema.sql'),
    migration: read(path.join('supabase/migrations', migrationName)),
  };
}

test('the live-session message guard exists in all three schema places', () => {
  for (const [place, source] of Object.entries(sources())) {
    assert.match(source, /CREATE OR REPLACE FUNCTION messages_require_live_session\(\)/, place);
    assert.match(source, /DROP TRIGGER IF EXISTS trg_messages_require_live_session ON messages;/, place);
    assert.match(source, /CREATE TRIGGER trg_messages_require_live_session/, place);
    assert.match(source, /BEFORE INSERT OR UPDATE ON messages/, place);
    assert.match(source, /CONSTRAINT = 'messages_live_session_write_guard'/, place);
  }
});

test('the database rejects every transcript-resurrection shape', () => {
  for (const [place, source] of Object.entries(sources())) {
    const start = source.indexOf('CREATE OR REPLACE FUNCTION messages_require_live_session()');
    assert.ok(start >= 0, `${place}: function missing`);
    const body = source.slice(start, source.indexOf('$$;', start) + 3);

    assert.match(body, /NEW\.session_id IS DISTINCT FROM OLD\.session_id/, `${place}: session moves`);
    assert.match(body, /OLD\.deleted_at IS NOT NULL/, `${place}: tombstone mutation`);
    assert.match(body, /FROM chat_sessions[\s\S]*id = NEW\.session_id[\s\S]*deleted_at IS NULL/, `${place}: live session`);
    assert.match(body, /FOR SHARE;/, `${place}: inserts must serialize with clear`);
    assert.match(body, /IF NOT FOUND THEN/, `${place}: missing or closed session must fail`);
    assert.doesNotMatch(body, /RETURN NULL/, `${place}: the trigger must not silently drop writes`);
  }
});

test('runtime placement follows the Fly-only DDL contract', () => {
  const runtime = read('server/index.cjs');
  const start = runtime.indexOf('async function ensureRuntimeSchema()');
  const end = runtime.indexOf('\nasync function ', start + 10);
  const trigger = runtime.indexOf('CREATE OR REPLACE FUNCTION messages_require_live_session()');

  assert.ok(start >= 0 && end > start, 'ensureRuntimeSchema bounds missing');
  assert.ok(trigger > start && trigger < end, 'message guard fell outside ensureRuntimeSchema');
  assert.doesNotMatch(
    read('netlify/functions/backend.mjs'),
    /CREATE OR REPLACE FUNCTION messages_require_live_session/,
    'Netlify must not run independent DDL',
  );
});

test('the guard is declared after messages.deleted_at exists', () => {
  for (const [place, source] of Object.entries({
    runtime: read('server/index.cjs'),
    canonical: read('database/neon-schema.sql'),
  })) {
    const column = source.indexOf('ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at');
    const trigger = source.indexOf('CREATE OR REPLACE FUNCTION messages_require_live_session()');
    assert.ok(column >= 0 && trigger > column, `${place}: trigger precedes messages.deleted_at`);
  }
});

test('exactly one live-session guard migration exists', () => {
  const names = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((name) => name.endsWith('_messages_live_session_guard.sql'));
  assert.deepEqual(names, [migrationName]);
});
