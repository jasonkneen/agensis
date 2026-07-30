// ============================================================================
// tests/audit-log-append-only.test.cjs
// ----------------------------------------------------------------------------
// audit_log must be unreachable from every generic client path.
//
// The whole value of this table is that a client cannot forge a row into it or
// erase one out of it. That property is not enforced by a role check — it is
// enforced by the table being ABSENT from ALLOWED_TABLES, so ensureTable()
// rejects it before any /backend/db/* handler and before authorizeRealtimeBinding
// gets as far as consulting a capability.
//
// Read the REAL exported sets rather than a mock. A mock that restates the rule
// tests the mock; this reads the same objects the running server destructures,
// so allowlisting the table in production code fails these tests.
//
// THE MUTATION THIS EXISTS TO CATCH: a future contributor wanting
// `backendClient.from('audit_log')` for the panel's convenience adds one line to
// ALLOWED_TABLES and silently restores generic INSERT/UPDATE/DELETE access to
// the audit trail. The read route works fine without it. Do not add it.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../shared/backend-core.cjs');
const { ensureTable } = require('../server/lib/db-sql.cjs');

const root = path.resolve(__dirname, '..');

test('audit_log is absent from ALLOWED_TABLES', () => {
  assert.equal(
    core.ALLOWED_TABLES.has('audit_log'),
    false,
    'audit_log must never be reachable through /backend/db/* — see this file header',
  );
});

test('audit_log is absent from DB_TABLE_ACCESS', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(core.DB_TABLE_ACCESS, 'audit_log'),
    false,
    'a DB_TABLE_ACCESS mapping implies a generic route exists; there must not be one',
  );
  // WORKSPACE_SCOPED_TABLES only matters for tables the generic path serves.
  assert.equal(core.WORKSPACE_SCOPED_TABLES.has('audit_log'), false);
  assert.equal(core.VERSIONED_TABLES.has('audit_log'), false);
});

test('ensureTable rejects audit_log', () => {
  // This is the actual gate: every generic handler and every realtime subscribe
  // calls ensureTable first, so this throwing IS the guarantee.
  assert.throws(() => ensureTable('audit_log'), /table/i);
  // Sanity: the same function accepts a table that IS allowlisted, so the
  // assertion above is about audit_log and not about ensureTable being broken.
  assert.doesNotThrow(() => ensureTable('activity_events'));
});

test('no generic client write path names audit_log', () => {
  // Belt and braces on top of the allowlist: the frontend must not be reaching
  // for this table through backendClient at all, even in dead code.
  const clientSources = ['src/lib/backendClient.ts', 'src/hooks/useActivity.ts'];
  for (const file of clientSources) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(
      /['"`]audit_log['"`]/.test(source),
      false,
      `${file} names audit_log — the only client path to it is the manage-gated GET route`,
    );
  }
});

test('the audit table is written by exactly one function', () => {
  // `insert into audit_log` must appear in shared/backend-core.cjs (inside
  // recordAuditEntry) and nowhere else. A second writer would be a writer with
  // its own, unreviewed redaction rules.
  const searchDirs = ['server', 'shared', 'netlify/functions'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(cjs|mjs|js)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/insert\s+into\s+audit_log/i.test(source)) offenders.push(path.relative(root, full));
    }
  };
  for (const dir of searchDirs) walk(path.join(root, dir));
  assert.deepEqual(offenders, ['shared/backend-core.cjs']);
});
