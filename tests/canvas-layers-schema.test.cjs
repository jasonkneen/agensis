'use strict';

// canvas_layers — the three-place schema rule (AGENTS.md) plus the access
// allowlists. Layer definitions used to live only in each browser's
// localStorage while canvas_objects.layer_id (shared) pointed at them, so a
// canvas one member created was invisible to everyone else. These assert the
// table is declared everywhere a fresh DB could be built from, and that the
// frontend can actually reach it through /backend/db.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../shared/backend-core.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('canvas_layers is created in all three schema places', () => {
  const runtime = read('server/index.cjs');
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS canvas_layers \(/);
  assert.match(runtime, /CREATE INDEX IF NOT EXISTS idx_canvas_layers_workspace_id/);

  const canonical = read('database/neon-schema.sql');
  assert.match(canonical, /CREATE TABLE IF NOT EXISTS canvas_layers \(/);
  assert.match(canonical, /CREATE INDEX IF NOT EXISTS idx_canvas_layers_workspace_id/);

  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((name) => name.endsWith('_canvas_layers.sql'));
  assert.equal(migrations.length, 1, 'expected exactly one canvas_layers migration');
  const migration = read(path.join('supabase/migrations', migrations[0]));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS canvas_layers \(/);

  // layer_id is the identity canvas_objects.layer_id stores (text, not uuid),
  // and the pair must be unique or the client's adoption pass would duplicate
  // rows on every mount.
  for (const source of [runtime, canonical, migration]) {
    assert.match(source, /layer_id text NOT NULL/);
    assert.match(source, /UNIQUE \(workspace_id, layer_id\)/);
    assert.match(source, /workspace_id uuid NOT NULL REFERENCES workspaces\(id\) ON DELETE CASCADE/);
  }
});

// database/neon-schema.sql is applied top-to-bottom by psql with ON_ERROR_STOP=1,
// so a table must be created AFTER anything it REFERENCES. A forward reference
// breaks fresh-DB provisioning outright (it has happened).
test('neon-schema.sql has no forward REFERENCES', () => {
  const lines = read('database/neon-schema.sql').split('\n');
  const created = new Map();
  const refs = [];
  lines.forEach((raw, index) => {
    const line = index + 1;
    const text = raw.replace(/--.*$/, '');
    const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(text);
    if (create && !created.has(create[1])) created.set(create[1], line);
    const pattern = /REFERENCES\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
    let match;
    while ((match = pattern.exec(text)) !== null) refs.push({ table: match[1], line });
  });

  assert.ok(created.has('canvas_layers'), 'canvas_layers missing from neon-schema.sql');
  assert.ok(created.get('canvas_layers') > created.get('workspaces'), 'canvas_layers must be created after workspaces');

  for (const ref of refs) {
    const createdAt = created.get(ref.table);
    assert.notEqual(createdAt, undefined, `line ${ref.line}: REFERENCES ${ref.table}, never created in this file`);
    assert.ok(
      createdAt <= ref.line,
      `line ${ref.line}: REFERENCES ${ref.table} which is created later, at line ${createdAt}`,
    );
  }
});

test('canvas_layers is reachable through the generic /backend/db routes', () => {
  assert.equal(core.ALLOWED_TABLES.has('canvas_layers'), true);
  assert.equal(core.WORKSPACE_SCOPED_TABLES.has('canvas_layers'), true);
  // A layer is no more privileged than the objects drawn on it.
  assert.deepEqual(core.DB_TABLE_ACCESS.canvas_layers, core.DB_TABLE_ACCESS.canvas_objects);
});
