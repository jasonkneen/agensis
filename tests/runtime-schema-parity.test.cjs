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

const runtimeColumns = (source) => {
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
};

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

test('every runtime-bootstrap column is canonical and migrated', () => {
  const runtime = runtimeColumns(read('server/index.cjs'));
  const canonical = runtimeColumns(read('database/neon-schema.sql'));
  const migrationSource = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => read(path.join('supabase/migrations', name)))
    .join('\n');
  const migrated = runtimeColumns(migrationSource);

  const missingCanonical = [];
  const missingMigration = [];
  for (const [table, columns] of runtime) {
    for (const column of columns) {
      if (!canonical.get(table)?.has(column)) missingCanonical.push(`${table}.${column}`);
      if (!migrated.get(table)?.has(column)) missingMigration.push(`${table}.${column}`);
    }
  }

  assert.deepEqual(missingCanonical.sort(), [], 'runtime columns missing from database/neon-schema.sql');
  assert.deepEqual(missingMigration.sort(), [], 'runtime columns missing from the forward migration chain');
});
