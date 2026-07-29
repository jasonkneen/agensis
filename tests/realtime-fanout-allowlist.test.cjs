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
// had never worked. 1471 backend and 2434 frontend tests all passed throughout,
// because nothing asserted what the protocol is. Those two are allowlisted now;
// the last test in this file pins every part of that fix, including the parts
// that are security rather than plumbing.
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

const {
  ALLOWED_TABLES,
  WORKSPACE_SCOPED_TABLES,
  DB_TABLE_ACCESS,
  safeSelectColumns,
  stripPrivilegedDbValues,
} = require('../shared/backend-core.cjs');
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
  // The two tables this file was written about, on BOTH sides. FANOUT_BROKEN is
  // empty now, so the tests that iterate it prove nothing on their own; these
  // four assertions are what keeps the scan honest about the pair that mattered.
  // If a hook is deleted or a fanout call removed, the right failure is here and
  // not a silently-vacuous suite.
  for (const table of ['agent_schedules', 'gateway_configs']) {
    assert.ok(fanout.literal.has(table), `expected a notifyDbSubscribers('${table}', …) call site under server/`);
    assert.ok(clientSubs.has(table), `expected a client db_changes subscription to ${table} under src/`);
  }
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
  // Anti-vacuity: the exempt list is where the vault's second defence layer is
  // recorded, so an empty FANOUT_EXEMPT must fail here rather than sail through
  // the loop below. Deliberately a floor and not an exact count — pruning a stale
  // exemption is a normal, correct edit.
  assert.ok(
    Object.keys(FANOUT_EXEMPT).length >= 6,
    `expected at least 6 declared exemptions, found ${Object.keys(FANOUT_EXEMPT).length}`,
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(FANOUT_EXEMPT, 'workspace_secrets'),
    'workspace_secrets must stay declared exempt — its absence from ALLOWED_TABLES is a documented vault defence layer',
  );
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

test('workspace_invites.token is stripped from the realtime fanout', () => {
  // The column is NAMED token and STORES hashAgentToken(token) — the same class
  // of value workspace_join_links spells token_hash, which is already stripped.
  // All five fanout calls in server/members-invites-routes.cjs pass raw
  // `returning *` rows. Nothing subscribes today; this is the same pre-emptive
  // line as its sibling, and it exists so the pair cannot read as a judgement
  // that one of them is safe on the wire.
  const { __test } = require('../server/index.cjs');
  const stripped = __test.sanitizeRealtimeRow('workspace_invites', {
    id: 'invite-1',
    workspace_id: 'ws-1',
    token: 'b6a1…the-hash',
    email: 'someone@example.com',
    role: 'editor',
    status: 'pending',
  });
  assert.equal('token' in stripped, false, 'sanitizeRealtimeRow must drop workspace_invites.token');
  assert.equal(stripped.status, 'pending', 'the rest of the row must survive');
  assert.equal(stripped.role, 'editor', 'the rest of the row must survive');
});

// ==========================================================================
// The two live defects this file was written to force a decision on.
//
// agent_schedules and gateway_configs are now in ALLOWED_TABLES, so
// FANOUT_BROKEN is empty and every test above that iterates it proves nothing.
// THIS is the replacement, and it is deliberately behavioural: it exercises the
// real gate, the real column projection and the real fanout sanitizer rather
// than re-reading the Sets that configure them. Delete a table from
// ALLOWED_TABLES, from WORKSPACE_SCOPED_TABLES, from SELECTABLE_COLUMNS_BY_TABLE
// or from REALTIME_HEAVY_FIELDS and a test here fails; each was checked by
// making exactly that mutation.
// ==========================================================================

function eq(column, value) {
  return { column, operator: 'eq', value };
}

// The smallest fixture that can answer "what role does this user hold here".
// Everything else THROWS: a code path that reaches for data this test did not
// anticipate has to announce itself rather than resolve to undefined and let an
// authorization check pass by accident.
function makeRoleDb({ owners = {}, roles = {} } = {}) {
  return async function db(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
      return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
    }
    if (normalized.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
      const role = roles[`${params[0]}:${params[1]}`];
      return role ? [{ role }] : [];
    }
    // The inherited-role ancestor walk. Flat fixtures inherit nothing.
    if (normalized.includes('with recursive chain as')) return [];
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
}

// The SAME case against BOTH gate implementations. server/index.cjs carries its
// own copy of enforceDbOperationAccess (positional args, its own getWorkspaceRole)
// alongside the shared object-form that netlify/functions/backend.mjs calls; they
// read the same Sets but they are two bodies of code, and a table that is gated on
// Fly and ungated on Netlify is the same leak with a longer URL.
async function onBothBackends(fixture, { table, op, filters, values }, assertOutcome) {
  const { __test } = require('../server/index.cjs');
  const db = makeRoleDb(fixture);

  __test.setTestDb({ unsafe: (sql, params) => db(sql, params) });
  await assertOutcome(
    () => __test.enforceDbOperationAccess('actor', table, op, { filters, values }),
    'server/index.cjs (Fly)',
  );

  const core = require('../shared/backend-core.cjs');
  await assertOutcome(
    () => core.enforceDbOperationAccess({
      userId: 'actor', table, op, filters, payload: { values }, db,
    }),
    'shared/backend-core.cjs (Netlify)',
  );
}

const allows = async (call, backend) => {
  await assert.doesNotReject(call, `${backend} should have allowed this`);
};
const refusesWith = (status, message) => async (call, backend) => {
  await assert.rejects(call, (error) => {
    assert.equal(error.status, status, `${backend}: expected ${status}, got ${error.status} (${error.message})`);
    assert.equal(error.message, message, `${backend}: wrong refusal message`);
    return true;
  }, `${backend} should have refused this`);
};

test('the two subscriptions this file was written for are subscribable at all', () => {
  // authorizeRealtimeBinding -> ensureTable refuses any table outside
  // ALLOWED_TABLES, and src/lib/backendClient.ts drops the {type:'error'} frame,
  // so this single line is the whole difference between a live list and a list
  // that silently never updates.
  for (const table of ['agent_schedules', 'gateway_configs']) {
    assert.ok(ALLOWED_TABLES.has(table), `${table} must be in ALLOWED_TABLES or its subscription is refused`);
  }
});

test('gateway_configs rows are scoped to a workspace on both backends', async () => {
  // The cross-tenant test. enforceDbOperationAccess RETURNS EARLY for any table
  // outside WORKSPACE_SCOPED_TABLES — so if gateway_configs falls out of that Set
  // while staying in ALLOWED_TABLES, both calls below succeed and any signed-in
  // user reads every tenant's gateway rows. Mutation-checked: removing
  // 'gateway_configs' from WORKSPACE_SCOPED_TABLES turns both of these green-to-red.
  await onBothBackends(
    { roles: { 'ws-other:actor': 'owner' } },
    { table: 'gateway_configs', op: 'select', filters: [] },
    refusesWith(400, 'A workspace filter is required for this operation'),
  );

  await onBothBackends(
    { roles: { 'ws-other:actor': 'owner' } },
    { table: 'gateway_configs', op: 'select', filters: [eq('workspace_id', 'ws-1')] },
    refusesWith(403, 'You do not have access to this workspace'),
  );
});

test('gateway_configs: any member may read, only manage may write', async () => {
  // 'read' on select MATCHES GET /backend/workspaces/:id/gateways, which is what
  // makes the subscription usable by the members who see the model selector. It
  // gives nothing away because the selectable-column test below holds the generic
  // select to strictly less than that route returns.
  await onBothBackends(
    { roles: { 'ws-1:actor': 'viewer' } },
    { table: 'gateway_configs', op: 'select', filters: [eq('workspace_id', 'ws-1')] },
    allows,
  );

  // 'editor' HAS write and run_agents and does NOT have manage. If any of the
  // three write operations slipped to DEFAULT_TABLE_ACCESS ('write'), an editor
  // could create or retarget a gateway through /backend/db/insert without ever
  // passing the routes that validate it.
  for (const [op, payload] of [
    ['insert', { values: { workspace_id: 'ws-1', name: 'mine' } }],
    ['update', { filters: [eq('workspace_id', 'ws-1')], values: { name: 'mine' } }],
    ['delete', { filters: [eq('workspace_id', 'ws-1')] }],
  ]) {
    await onBothBackends(
      { roles: { 'ws-1:actor': 'editor' } },
      { table: 'gateway_configs', op, ...payload },
      refusesWith(403, 'You do not have permission to manage this workspace'),
    );
  }
});

test('agent_schedules: any member may read, only manage may write', async () => {
  await onBothBackends(
    { roles: { 'ws-1:actor': 'viewer' } },
    { table: 'agent_schedules', op: 'select', filters: [eq('workspace_id', 'ws-1')] },
    allows,
  );

  // Deliberately STRICTER than POST /backend/workspaces/:id/schedules, which asks
  // for 'run_agents'. A schedule is a standing "run this agent on a timer" grant,
  // and the dedicated route is the only place agent_id and session_id are checked
  // to belong to this workspace — so an editor holding run_agents must not be able
  // to mint one through the generic path instead.
  for (const [op, payload] of [
    ['insert', { values: { workspace_id: 'ws-1', name: 'nightly' } }],
    ['update', { filters: [eq('workspace_id', 'ws-1')], values: { enabled: true } }],
    ['delete', { filters: [eq('workspace_id', 'ws-1')] }],
  ]) {
    await onBothBackends(
      { roles: { 'ws-1:actor': 'editor' } },
      { table: 'agent_schedules', op, ...payload },
      refusesWith(403, 'You do not have permission to manage this workspace'),
    );
  }
});

test('a generic select can never return a gateway key or its headers', () => {
  // "The API key is stored encrypted and is NEVER returned to the client" is the
  // stated contract of server/workspaces-routes.cjs. Opening the generic /db path
  // is what put `columns: '*'` in reach of api_key_cipher, so the projection is
  // the thing that keeps the contract true on the new path.
  const projected = safeSelectColumns('gateway_configs', '*');
  const columns = String(projected).split(',').map((column) => column.trim());
  assert.ok(columns.length > 0, 'the projection must not be empty');
  assert.equal(columns.includes('api_key_cipher'), false, `'*' expanded to include api_key_cipher: ${projected}`);
  assert.equal(columns.includes('headers'), false, `'*' expanded to include headers: ${projected}`);
  // The list has to still be USEFUL — a projection down to nothing would pass the
  // two assertions above while breaking the feature.
  for (const needed of ['id', 'workspace_id', 'name', 'base_url', 'model']) {
    assert.ok(columns.includes(needed), `the gateway list needs ${needed}`);
  }

  // Asked for by name, the denial is visible rather than a silently absent field.
  for (const secret of ['api_key_cipher', 'headers']) {
    assert.throws(
      () => safeSelectColumns('gateway_configs', secret),
      (error) => error.status === 403,
      `selecting ${secret} by name must be refused`,
    );
  }
});

test('a generic write cannot set the gateway columns the routes validate', () => {
  // base_url is the SSRF surface: assertSafeOutboundUrl (tests/gateway-ssrf.test.cjs)
  // runs on the dedicated POST/PATCH and nowhere else, and the row is later fetched
  // server-side by the ai-chat gateway branch. A generic write that could set
  // base_url would be a way around a guard that is currently live.
  const written = stripPrivilegedDbValues('gateway_configs', {
    workspace_id: 'ws-1',
    name: 'Renamed',
    model: 'gpt-4o-mini',
    base_url: 'http://169.254.169.254/latest/meta-data/',
    api_key_cipher: 'attacker-chosen-ciphertext',
    headers: { Authorization: 'Bearer someone-elses-key' },
  });
  assert.equal('base_url' in written, false, 'base_url must not be settable through /backend/db');
  assert.equal('api_key_cipher' in written, false, 'api_key_cipher must not be settable through /backend/db');
  assert.equal('headers' in written, false, 'headers must not be settable through /backend/db');
  assert.equal(written.name, 'Renamed', 'a plain rename must still go through');
  assert.equal(written.model, 'gpt-4o-mini', 'a plain model change must still go through');
});

test('the gateway fanout carries no key and no headers', () => {
  // The three dedicated call sites already map through publicGatewayConfig. The
  // GENERIC /backend/db/update|delete routes do not — they fan out raw
  // `returning *` rows, and allowlisting the table is exactly what opened them.
  // So this is the only strip on that path.
  const { __test } = require('../server/index.cjs');
  const stripped = __test.sanitizeRealtimeRow('gateway_configs', {
    id: 'gw-1',
    workspace_id: 'ws-1',
    name: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_cipher: 'v1:live-encrypted-provider-key',
    model: 'deepseek/deepseek-v4-flash',
    protocol: 'openai-chat',
    headers: { Authorization: 'Bearer live-key' },
  });
  assert.equal('api_key_cipher' in stripped, false, 'sanitizeRealtimeRow must drop gateway_configs.api_key_cipher');
  assert.equal('headers' in stripped, false, 'sanitizeRealtimeRow must drop gateway_configs.headers');
  // workspace_id has to survive: notifyDbSubscribers matches each subscriber's
  // `workspace_id=eq.…` filter against the row it is about to send, so stripping it
  // would deliver every workspace's gateway changes to every subscriber.
  assert.equal(stripped.workspace_id, 'ws-1', 'the filter column must survive the strip');
  assert.equal(stripped.name, 'OpenRouter', 'the metadata the list shows must survive');
});

test('the schedule fanout is NOT stripped', () => {
  // useSchedules applies payload.new straight into its list (unlike useGateways,
  // which refetches over REST), so a REALTIME_HEAVY_FIELDS entry here would blank
  // fields in the UI rather than protect anything. agent_schedules has no secret
  // column: GET /backend/workspaces/:id/schedules returns `select *` at 'read', so
  // the fanout row is exactly what a member can already fetch.
  const { __test } = require('../server/index.cjs');
  const row = {
    id: 'sched-1',
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    session_id: 'session-1',
    name: 'Daily standup',
    prompt: 'Summarise yesterday',
    interval_seconds: 86400,
    enabled: true,
    next_run_at: '2026-07-30T09:00:00.000Z',
  };
  assert.deepEqual(__test.sanitizeRealtimeRow('agent_schedules', row), row);
});
