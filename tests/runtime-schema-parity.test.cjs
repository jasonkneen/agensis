'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const createdTables = (source) => new Set(
  [...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)]
    .map((match) => match[1].toLowerCase()),
);

test('every inline runtime-bootstrap table is canonical and migrated', () => {
  const runtimeTables = createdTables(read('server/index.cjs'));
  const canonicalTables = createdTables(read('database/neon-schema.sql'));
  const migrationSource = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => read(path.join('supabase/migrations', name)))
    .join('\n');
  const migratedTables = createdTables(migrationSource);

  const missingCanonical = [...runtimeTables]
    .filter((table) => !canonicalTables.has(table))
    .sort();
  const missingMigration = [...runtimeTables]
    .filter((table) => !migratedTables.has(table))
    .sort();

  assert.deepEqual(missingCanonical, [], 'runtime tables missing from database/neon-schema.sql');
  assert.deepEqual(missingMigration, [], 'runtime tables missing from the forward migration chain');
});
