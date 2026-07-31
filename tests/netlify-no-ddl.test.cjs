'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const NETLIFY_BACKEND = read('netlify/functions/backend.mjs');
const CANONICAL_SCHEMA = read('database/neon-schema.sql');
const MIGRATION_SCHEMA = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => read(path.join('supabase/migrations', name)))
  .join('\n');

const DDL = /\b(?:CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|EXTENSION)|ALTER\s+TABLE)\b/i;
const ENSURE_HELPERS = [
  'ensureSecretsTables',
  'ensureAgentConnectionsTable',
  'ensureCursorBuddyConnectionKeyTables',
  'ensureAppUserProfileColumns',
  'ensureAgentRuntimeTables',
  'ensureActivityEventsIndex',
];

function createdTables(source) {
  return new Set(
    [...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)]
      .map((match) => match[1].toLowerCase()),
  );
}

function schemaColumns(source) {
  const columns = new Map();
  const add = (table, column) => {
    if (!columns.has(table)) columns.set(table, new Set());
    columns.get(table).add(column);
  };

  for (const match of source.matchAll(
    /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\);/gi,
  )) {
    const table = match[1].toLowerCase();
    for (const line of match[2].split('\n')) {
      const column = line.trim().match(/^([a-z_][a-z0-9_]*)\s+/i)?.[1]?.toLowerCase();
      if (!column || ['constraint', 'primary', 'unique', 'check', 'foreign'].includes(column)) continue;
      add(table, column);
    }
  }

  for (const match of source.matchAll(
    /ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi,
  )) {
    add(match[1].toLowerCase(), match[2].toLowerCase());
  }

  return columns;
}

test('the Netlify request handler contains no schema DDL or bootstrap helper', () => {
  assert.doesNotMatch(
    NETLIFY_BACKEND,
    DDL,
    'Netlify shares the primary database and must never mutate its schema at request time',
  );
  for (const helper of ENSURE_HELPERS) {
    assert.doesNotMatch(NETLIFY_BACKEND, new RegExp(`\\b${helper}\\b`), `${helper} must stay removed`);
  }
});

test('every removed Netlify bootstrap dependency is canonical and migrated', () => {
  const requiredTables = [
    'app_settings',
    'workspace_secrets',
    'agent_connections',
    'cursorbuddy_connection_keys',
    'agent_webhooks',
    'activity_events',
  ];
  const requiredColumns = {
    app_users: ['display_name', 'accent_color', 'token_version', 'share_read_receipts'],
    workspace_secrets: ['secret_cipher', 'description'],
    workspace_agents: [
      'soul',
      'instructions',
      'tools',
      'skills',
      'metadata',
      'handle',
      'openpet_avatar_id',
      'accent_color',
      'connect_token_hash',
      'identity',
      'sandbox_provider',
      'sandbox_config',
      'memory_dir',
      'run_mode',
      'permission_mode',
      'version',
      'enabled',
      'ambient_replies',
    ],
  };
  const requiredIndexes = [
    'idx_workspace_secrets_workspace_id',
    'idx_agent_connections_workspace_id',
    'idx_agent_connections_agent_id',
    'idx_agent_connections_status',
    'idx_cursorbuddy_connection_keys_workspace',
    'idx_cursorbuddy_connection_keys_hash',
    'idx_workspace_agents_handle',
    'idx_workspace_agents_connect_token_hash',
    'idx_agent_webhooks_workspace_id',
    'idx_agent_webhooks_agent_id',
    'uq_activity_events_message_sent',
  ];

  const canonicalTables = createdTables(CANONICAL_SCHEMA);
  const migratedTables = createdTables(MIGRATION_SCHEMA);
  const canonicalColumns = schemaColumns(CANONICAL_SCHEMA);
  const migratedColumns = schemaColumns(MIGRATION_SCHEMA);

  for (const table of requiredTables) {
    assert.ok(canonicalTables.has(table), `${table} is missing from database/neon-schema.sql`);
    assert.ok(migratedTables.has(table), `${table} is missing from supabase/migrations`);
  }

  for (const [table, columns] of Object.entries(requiredColumns)) {
    for (const column of columns) {
      assert.ok(
        canonicalColumns.get(table)?.has(column),
        `${table}.${column} is missing from database/neon-schema.sql`,
      );
      assert.ok(
        migratedColumns.get(table)?.has(column),
        `${table}.${column} is missing from supabase/migrations`,
      );
    }
  }

  for (const index of requiredIndexes) {
    const pattern = new RegExp(`\\b${index}\\b`, 'i');
    assert.match(CANONICAL_SCHEMA, pattern, `${index} is missing from database/neon-schema.sql`);
    assert.match(MIGRATION_SCHEMA, pattern, `${index} is missing from supabase/migrations`);
  }

  assert.match(CANONICAL_SCHEMA, /CREATE EXTENSION IF NOT EXISTS pgcrypto/i);
  assert.match(MIGRATION_SCHEMA, /CREATE EXTENSION IF NOT EXISTS pgcrypto/i);

  for (const [label, source] of [
    ['database/neon-schema.sql', CANONICAL_SCHEMA],
    ['supabase/migrations', MIGRATION_SCHEMA],
  ]) {
    const dedupe = source.indexOf('DELETE FROM activity_events a');
    const uniqueIndex = source.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_events_message_sent');
    assert.ok(dedupe >= 0 && dedupe < uniqueIndex, `${label} must deduplicate activity rows before the unique index`);
  }
});
