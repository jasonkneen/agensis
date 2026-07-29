// ============================================================================
// tests/realtime-fanout-allowlist.test.cjs
// ----------------------------------------------------------------------------
// The server broadcasts row changes with notifyDbSubscribers(table, ...). A
// client subscribes with { type: 'db_changes', table }, and the server refuses
// any table not in ALLOWED_TABLES. Nothing made those two halves agree, and the
// failure is silent on both ends: the server fans out to nobody, the client's
// subscribe is rejected with an {type:'error'} frame that backendClient drops.
//
// An audit of main-next found EIGHT tables broadcast but not subscribable, two
// of them (agent_schedules, gateway_configs) with live client subscriptions that
// have never worked. 1471 backend and 2434 frontend tests all passed throughout,
// because nothing asserted what the protocol is.
//
// This is a SOURCE-TEXT test: it reads server/ and src/ off disk. That is
// unusual for this repo and is deliberate — the invariant is "the declaration
// matches the code", and only reading the code can check that.
//
// THE FAILURE MODE OF A TEST LIKE THIS is a regex that quietly stops matching:
// every "for each table found, assert X" then passes over an empty set. The
// floor assertions in `scan finds real call sites` exist for exactly that, and
// they are the reason this file is not decoration. If you are here because a
// refactor broke the patterns below, FIX THE PATTERN — do not loosen it, and do
// not lower the floors.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ALLOWED_TABLES } = require('../shared/backend-core.cjs');
const {
  FANOUT_EXEMPT,
  FANOUT_BROKEN,
  DYNAMIC_FANOUT_SITE_COUNT,
  fanoutTableStatus,
} = require('../shared/realtime-fanout.cjs');

const REPO = path.join(__dirname, '..');

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

// Every notifyDbSubscribers call site, split into the ones naming a table
// literally and the ones passing a variable.
function scanFanoutSites() {
  const literal = new Map(); // table -> Set<relative file>
  const dynamic = []; // { file, snippet }
  for (const file of walk(path.join(REPO, 'server'), ['.cjs'])) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO, file);
    // `notifyDbSubscribers(` followed by either 'a_table' or anything else.
    const call = /notifyDbSubscribers\(\s*(?:(['"])([a-z_]+)\1|([^)\s,][^,)]*))/g;
    let match;
    while ((match = call.exec(source)) !== null) {
      // `function notifyDbSubscribers(table, ...)` in server/realtime.cjs is the
      // declaration, not a call. Its parameter list looks exactly like a dynamic
      // call site, so it has to be excluded by name rather than by shape.
      if (/\bfunction\s+$/.test(source.slice(Math.max(0, match.index - 16), match.index))) continue;
      const table = match[2];
      if (table) {
        if (!literal.has(table)) literal.set(table, new Set());
        literal.get(table).add(rel);
        continue;
      }
      const expr = String(match[3] || '').trim();
      // `notifyDbSubscribers: (...a) => ...` is a dependency-injection wiring
      // line in server/index.cjs, not a call that fans anything out.
      if (expr.startsWith('...')) continue;
      dynamic.push({ file: rel, expr });
    }
  }
  return { literal, dynamic };
}

// Client-side db_changes subscriptions: `table: 'name'` inside a subscription
// descriptor. Same literal form everywhere in src/ (see useSchedules.ts:57).
function scanClientSubscriptions() {
  const found = new Map(); // table -> Set<relative file>
  for (const file of walk(path.join(REPO, 'src'), ['.ts', '.tsx'])) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO, file);
    const decl = /\btable:\s*(['"])([a-z_]+)\1/g;
    let match;
    while ((match = decl.exec(source)) !== null) {
      const table = match[2];
      if (!found.has(table)) found.set(table, new Set());
      found.get(table).add(rel);
    }
  }
  return found;
}

const fanout = scanFanoutSites();
const clientSubs = scanClientSubscriptions();

// --------------------------------------------------------------------------
// Anti-vacuity. Everything below iterates over what the scan found; if the
// scan finds nothing, everything below passes and proves nothing. These floors
// are far under the real counts (26 fanout tables, 25 subscribed tables at the
// time of writing) so ordinary churn will not trip them, but a pattern that
// stops matching will.
// --------------------------------------------------------------------------
test('scan finds real call sites (guards against a regex that silently stops matching)', () => {
  assert.ok(
    fanout.literal.size >= 20,
    `expected >=20 literal notifyDbSubscribers tables, found ${fanout.literal.size} — the scan pattern is broken, not the code`,
  );
  assert.ok(
    clientSubs.size >= 20,
    `expected >=20 client table subscriptions, found ${clientSubs.size} — the scan pattern is broken, not the code`,
  );
  // Two names known to be on each side, as a canary that the patterns match the
  // real shapes and not just something.
  assert.ok(fanout.literal.has('messages'), 'expected the messages fanout to be found');
  assert.ok(clientSubs.has('messages'), 'expected the messages subscription to be found');
});

// --------------------------------------------------------------------------
// The rule.
// --------------------------------------------------------------------------
test('every broadcast table is allowlisted, deliberately exempt, or a recorded defect', () => {
  const undeclared = [];
  const conflicted = [];
  for (const [table, files] of fanout.literal) {
    const status = fanoutTableStatus(table, ALLOWED_TABLES.has(table));
    if (status === 'undeclared') undeclared.push(`${table} (broadcast from ${[...files].join(', ')})`);
    else if (status.startsWith('conflict')) conflicted.push(`${table} is ${status}`);
  }
  assert.deepEqual(
    undeclared,
    [],
    'These tables are broadcast but a client cannot subscribe to them, and nothing says why.\n'
    + 'Add each to ALLOWED_TABLES (with a DB_TABLE_ACCESS entry in the SAME commit), or\n'
    + 'declare it in FANOUT_EXEMPT / FANOUT_BROKEN in shared/realtime-fanout.cjs:\n  '
    + undeclared.join('\n  '),
  );
  assert.deepEqual(conflicted, [], `A table may be in exactly one category:\n  ${conflicted.join('\n  ')}`);
});

test('nothing in src/ subscribes to a table declared exempt', () => {
  // The mechanism: adding a subscription to an exempt table has to be a
  // deliberate move of that table out of FANOUT_EXEMPT, not a quiet edit that
  // yields a subscription refused at runtime and swallowed by the client.
  const violations = [];
  for (const table of Object.keys(FANOUT_EXEMPT)) {
    const subscribers = clientSubs.get(table);
    if (subscribers) violations.push(`${table} is exempt but ${[...subscribers].join(', ')} subscribes to it`);
  }
  assert.deepEqual(
    violations,
    [],
    'A client subscribes to a table declared unsubscribable-on-purpose. That subscription is\n'
    + 'refused by the server and the error is dropped by backendClient, so the surface will\n'
    + 'look empty forever. Either drop the subscription or move the table out of FANOUT_EXEMPT\n'
    + `after reading its reason:\n  ${violations.join('\n  ')}`,
  );
});

test('every table recorded as broken really does have a client subscriber', () => {
  // Stops FANOUT_BROKEN becoming a parking bay for things nobody wants to think
  // about. No subscriber means the honest category is FANOUT_EXEMPT.
  const misfiled = [];
  for (const table of Object.keys(FANOUT_BROKEN)) {
    if (!clientSubs.has(table)) misfiled.push(table);
  }
  assert.deepEqual(
    misfiled,
    [],
    `Recorded as a live defect but nothing subscribes — move to FANOUT_EXEMPT:\n  ${misfiled.join('\n  ')}`,
  );
});

test('every declared table is still actually broadcast', () => {
  // A declaration nobody prunes reads as authoritative while being stale, which
  // is worse than no declaration.
  const stale = [];
  for (const table of [...Object.keys(FANOUT_EXEMPT), ...Object.keys(FANOUT_BROKEN)]) {
    if (!fanout.literal.has(table)) stale.push(table);
  }
  assert.deepEqual(
    stale,
    [],
    `Declared in shared/realtime-fanout.cjs but no longer broadcast anywhere under server/.\n`
    + `The fanout was removed; remove the declaration too:\n  ${stale.join('\n  ')}`,
  );
});

test('every exempt/broken table carries a written reason', () => {
  for (const [table, reason] of Object.entries(FANOUT_EXEMPT)) {
    assert.equal(typeof reason, 'string', `${table} must have a reason string`);
    assert.ok(reason.length > 60, `${table}'s exemption reason is too thin to be useful: ${reason}`);
  }
  for (const [table, record] of Object.entries(FANOUT_BROKEN)) {
    assert.ok(record && typeof record.subscriber === 'string' && record.subscriber, `${table} must name its subscriber`);
    assert.ok(record && typeof record.fix === 'string' && record.fix.length > 60, `${table} must record a concrete fix`);
  }
});

test('the set of dynamic fanout call sites has not grown', () => {
  // The generic /backend/db insert/update/delete routes fan out with a variable
  // table name. They are safe because the same routes run ensureTable(table)
  // against ALLOWED_TABLES first — a guarantee that holds for THOSE call sites
  // and is not automatic for a new one.
  assert.equal(
    fanout.dynamic.length,
    DYNAMIC_FANOUT_SITE_COUNT,
    'The number of notifyDbSubscribers call sites passing a variable table changed.\n'
    + 'A dynamic site escapes the allowlist check in this file, so each one has to be\n'
    + 'independently gated by ensureTable. Confirm the new site is gated, then update\n'
    + `DYNAMIC_FANOUT_SITE_COUNT.\nFound:\n  ${fanout.dynamic.map((d) => `${d.file}: ${d.expr}`).join('\n  ')}`,
  );
});

// --------------------------------------------------------------------------
// The one live landmine this pass defuses.
// --------------------------------------------------------------------------
test('channel_bridges config is stripped from the realtime fanout', () => {
  // channel_bridges.config is jsonb holding Slack/Telegram botToken, Slack
  // signingSecret and OpenClaw authToken. The REST projection publicBridge drops
  // it ("a bot token in a JSON response ends up in devtools, in logs, and in a
  // screenshot") but ALL FOUR fanout calls pass raw `returning *` rows and
  // bypass that projection. Today those tokens reach nobody only because the
  // table is not subscribable — one line in ALLOWED_TABLES would hand a live
  // Slack bot token to every workspace member with `read`.
  //
  // Stripping the whole column, not named fields: a new provider added to
  // PROVIDER_FIELDS would otherwise leak by default.
  const { __test } = require('../server/index.cjs');
  const stripped = __test.sanitizeRealtimeRow('channel_bridges', {
    id: 'bridge-1',
    workspace_id: 'ws-1',
    provider: 'slack',
    status: 'connected',
    config: { botToken: 'xoxb-live-token', signingSecret: 'shhh' },
  });
  assert.equal('config' in stripped, false, 'sanitizeRealtimeRow must drop channel_bridges.config');
  assert.equal(stripped.provider, 'slack', 'the rest of the row must survive');
  assert.equal(stripped.status, 'connected', 'the rest of the row must survive');
});
