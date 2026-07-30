'use strict';

// ============================================================================
// tests/audit-log-realtime.test.cjs
// ----------------------------------------------------------------------------
// A browser must not be able to SUBSCRIBE to audit_log.
//
// Audit rows say who changed whose role and which vault key was written; a
// realtime db_changes binding would fan that to every subscribed browser holding
// the channel, sidestepping the manage gate on the read route entirely.
//
// This property currently holds BY ACCIDENT: authorizeRealtimeBinding calls
// ensureTable, which rejects anything outside ALLOWED_TABLES, and audit_log is
// deliberately outside it. That is exactly why it is worth pinning — it would
// break silently the day someone allowlists the table for the read route's
// convenience, and nothing else would fail.
//
// MUTATION: add 'audit_log' to ALLOWED_TABLES in shared/backend-core.cjs
// -> the subscribe stops throwing and this test fails.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealtime } = require('../server/realtime.cjs');
const { ensureTable } = require('../server/lib/db-sql.cjs');

function forbidden(message) {
  return Object.assign(new Error(message), { status: 403 });
}

/** A realtime instance with just enough wired for the authorization path. */
function makeRealtime() {
  return createRealtime({
    ensureTable,
    forbidden,
    // If either of these is ever reached for audit_log the guard has already
    // failed, so they throw rather than quietly allowing.
    enforceDbOperationAccess: async () => { throw new Error('reached enforceDbOperationAccess'); },
    enforceWorkspaceRole: async () => { throw new Error('reached enforceWorkspaceRole'); },
  });
}

test('a db_changes subscription to audit_log is refused', async () => {
  const realtime = makeRealtime();
  await assert.rejects(
    () => realtime.authorizeRealtimeBinding('user-1', 'db:audit_log', {
      type: 'db_changes', table: 'audit_log',
    }),
    /Table not allowed: audit_log/,
  );
});

test('a filtered subscription to audit_log is refused too', async () => {
  // The filter is where someone would try to make it look legitimate.
  const realtime = makeRealtime();
  for (const filter of ['workspace_id=eq.w1', 'actor_user_id=eq.user-1', '']) {
    await assert.rejects(
      () => realtime.authorizeRealtimeBinding('user-1', 'db:audit_log', {
        type: 'db_changes', table: 'audit_log', filter,
      }),
      /Table not allowed: audit_log/,
      `filter ${JSON.stringify(filter)} must not open a path`,
    );
  }
});

test('audit_log is not in the realtime heavy-field strip list, because it is unreachable', () => {
  // sanitizeRealtimeRow's strip list is the LAST line of defence for tables that
  // CAN be subscribed. audit_log needs no entry precisely because no binding to
  // it can ever be authorized — if that ever changes, this comment is the note
  // that a strip list entry is now required.
  const source = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../server/realtime.cjs'), 'utf8',
  );
  const heavy = source.slice(source.indexOf('const REALTIME_HEAVY_FIELDS'));
  assert.equal(heavy.slice(0, heavy.indexOf('};')).includes('audit_log'), false);
});

test('nothing broadcasts audit_log rows', () => {
  // notifyDbSubscribers('audit_log', ...) would push rows at whatever bindings
  // exist without going through authorizeRealtimeBinding at all.
  const fs = require('node:fs');
  const path = require('node:path');
  const dirs = ['server', 'shared'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(cjs|mjs)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/notifyDbSubscribers\(\s*['"`]audit_log['"`]/.test(source)) offenders.push(entry.name);
    }
  };
  for (const dir of dirs) walk(path.resolve(__dirname, '..', dir));
  assert.deepEqual(offenders, []);
});
