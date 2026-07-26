// ============================================================================
// tests/orbs-wiring.test.cjs
// ----------------------------------------------------------------------------
// Orbs (plans/021) have two failure modes that a unit test over pure functions
// cannot see, both of which this repo has been bitten by before:
//
//   1. SCHEMA DRIFT. agent_webhooks is a FOUR-place table — the Fly runtime
//      bootstrap, database/neon-schema.sql, a supabase migration, AND
//      netlify/functions/backend.mjs, which keeps its own CREATE TABLE for this
//      one table despite AGENTS.md saying that backend has no independent DDL.
//      A column added to three of the four leaves a fresh DB with a blank one.
//
//   2. THE GATES BEING QUIETLY REORDERED. The trigger route's ordering is load
//      bearing: the per-orb throttle must run BEFORE the dedupe claim (or a
//      throttled delivery burns its idempotency slot and the provider's later
//      legitimate retry is answered "duplicate"), and refusals must be logged
//      with a NULL delivery_key for the same reason.
//
// Source-scan assertions, in the style tests/jsonb-bind-hygiene.test.cjs and
// tests/lint-coverage.test.cjs already use: they are the only kind that can
// catch "someone edited three of the four places".
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const SERVER = read('server/index.cjs');
const NEON = read('database/neon-schema.sql');
const NETLIFY = read('netlify/functions/backend.mjs');
const MIGRATION = read('supabase/migrations/20260726160000_orbs.sql');
const CORE = read('shared/backend-core.cjs');

const ORB_WEBHOOK_COLUMNS = [
  'provider',
  'prompt',
  'payload_fields',
  'routing',
  'rate_limit_per_hour',
  'has_signing_secret',
  'session_id',
  'thread_root_message_id',
];

test('every orb column on agent_webhooks exists in all FOUR schema places', () => {
  const missing = [];
  for (const column of ORB_WEBHOOK_COLUMNS) {
    if (!SERVER.includes(`ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS ${column} `)) {
      missing.push(`server/index.cjs ensureRuntimeSchema: ${column}`);
    }
    if (!MIGRATION.includes(`ADD COLUMN IF NOT EXISTS ${column} `)) {
      missing.push(`supabase migration: ${column}`);
    }
    if (!NETLIFY.includes(`ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS ${column} `)) {
      missing.push(`netlify/functions/backend.mjs (the fourth place): ${column}`);
    }
  }
  // neon-schema.sql declares them inline in the CREATE TABLE rather than as ALTERs.
  const neonTable = NEON.slice(
    NEON.indexOf('CREATE TABLE IF NOT EXISTS agent_webhooks'),
    NEON.indexOf('idx_agent_webhooks_workspace_id'),
  );
  for (const column of ORB_WEBHOOK_COLUMNS) {
    if (!new RegExp(`^\\s*${column}\\s`, 'm').test(neonTable)) {
      missing.push(`database/neon-schema.sql: ${column}`);
    }
  }
  assert.deepEqual(missing, [], 'agent_webhooks is a four-place table — see plans/021');
});

test('orb_deliveries exists in the three places that own it, and not in netlify', () => {
  for (const [label, source] of [['server/index.cjs', SERVER], ['neon-schema.sql', NEON], ['migration', MIGRATION]]) {
    assert.ok(source.includes('CREATE TABLE IF NOT EXISTS orb_deliveries'), `${label} must create orb_deliveries`);
    assert.ok(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_orb_deliveries_key[\s\S]{0,160}WHERE delivery_key IS NOT NULL/.test(source),
      `${label} must make the dedupe index PARTIAL — a full unique index would let a rejected `
      + 'or keyless row claim the idempotency slot',
    );
  }
  assert.ok(!NETLIFY.includes('orb_deliveries'), 'the netlify backend has no hand in the delivery ledger');
});

test('orb_deliveries is readable but not client-writable', () => {
  assert.ok(CORE.includes("'orb_deliveries',"), 'must be in ALLOWED_TABLES + WORKSPACE_SCOPED_TABLES');
  assert.ok(
    /orb_deliveries: \{ select: 'read', insert: 'manage', update: 'manage', delete: 'manage' \}/.test(CORE),
    'a client-forged delivery row could pre-claim a delivery id and make the next real '
    + 'delivery look like a duplicate; a client DELETE would erase the audit trail',
  );
});

test('payload_fields is registered as a jsonb column so both backends bind it for their own driver', () => {
  assert.ok(/agent_webhooks: new Set\(\['payload_fields'\]\)/.test(CORE));
});

// --- the trigger route's gate order ---------------------------------------

function orbRouteSource() {
  const start = SERVER.indexOf("app.post('/backend/webhooks/:token'");
  assert.ok(start > 0, 'the orb trigger route must exist');
  const end = SERVER.indexOf("app.post('/backend/auth/signup'", start);
  assert.ok(end > start, 'could not bound the orb trigger route');
  return SERVER.slice(start, end);
}

test('the throttle check runs BEFORE the dedupe claim', () => {
  const route = orbRouteSource();
  const throttle = route.indexOf("status = 'accepted' and created_at > now() - interval '1 hour'");
  const claim = route.indexOf('on conflict (webhook_id, delivery_key)');
  assert.ok(throttle > 0, 'the per-orb hourly cap must be enforced');
  assert.ok(claim > 0, 'the dedupe claim must be an on-conflict insert');
  assert.ok(
    throttle < claim,
    'a throttled delivery must not consume its (webhook_id, delivery_key) slot, or the '
    + "provider's legitimate retry an hour later is answered \"duplicate\" and dropped",
  );
});

test('the hourly cap counts only accepted deliveries, so a throttled orb can recover', () => {
  const route = orbRouteSource();
  assert.ok(
    route.includes("where webhook_id = $1 and status = 'accepted' and created_at > now() - interval '1 hour'"),
    'if throttled rows counted toward their own limit, an orb over its cap could never recover',
  );
});

test('the route verifies the signature before it does anything else with the body', () => {
  const route = orbRouteSource();
  const verify = route.indexOf('verifyOrbDelivery(');
  const compose = route.indexOf('composeOrbMessage(');
  const dispatch = route.indexOf('continueConversation(');
  assert.ok(verify > 0 && compose > verify, 'nothing may be composed from an unverified body');
  assert.ok(dispatch > compose, 'nothing may be dispatched before the message is composed');
});

test('an unverifiable delivery fails closed with 503 and never falls through to unsigned', () => {
  const route = orbRouteSource();
  assert.ok(route.includes("verdict.reason === 'unconfigured'"));
  assert.ok(/jsonError\(res, 503/.test(route), 'a misconfigured provider must refuse, not degrade');
  assert.ok(/jsonError\(res, 401, new Error\('Invalid signature'\)\)/.test(route));
});

test('the route dispatches through continueConversation and does NOT await it', () => {
  const route = orbRouteSource();
  assert.ok(
    !route.includes('runAnthropicCompletion'),
    'the old route ran a one-shot built-in completion inline, so a daemon or sandbox agent '
    + 'never actually ran in its runtime',
  );
  assert.ok(
    /continueConversation\(\{ workspaceId: orb\.workspace_id[^)]*\}\)\s*\n?\s*\.catch\(/.test(route),
    'awaiting the turn is what pushed the response past GitHub\'s delivery timeout',
  );
  assert.ok(/res\.status\(202\)/.test(route), 'the response is an acknowledgement, not the answer');
});

test('a refused delivery is logged with a NULL delivery_key and coalesced', () => {
  const logger = SERVER.slice(SERVER.indexOf('async function logOrbRejection'), SERVER.indexOf('function normalizeOrbConfigInput') + 1);
  const source = logger.includes('orb_deliveries')
    ? logger
    : SERVER.slice(SERVER.indexOf('async function logOrbRejection'), SERVER.indexOf('async function logOrbRejection') + 1800);
  assert.ok(/select \$1, \$2, null, \$3, \$4, \$5, \$6/.test(source), 'the delivery_key column must be bound NULL');
  assert.ok(
    /where not exists \(/.test(source) && /interval '60 seconds'/.test(source),
    'a flood of forged requests must not turn rejection logging into write amplification',
  );
});

test('the orb signing secret is never a column on agent_webhooks', () => {
  // agent_webhooks is in the backendClient allowlists and useAgentWebhooks does a
  // literal select('*'), so a secret column would ship to every manage-role client.
  for (const [label, source] of [
    ['server/index.cjs', SERVER],
    ['neon-schema.sql', NEON],
    ['migration', MIGRATION],
    ['netlify', NETLIFY],
  ]) {
    assert.ok(
      !/agent_webhooks[\s\S]{0,400}signing_secret_cipher/.test(source),
      `${label}: the orb secret belongs in the workspace vault, not on this table`,
    );
  }
  assert.ok(SERVER.includes("return `orb:${String(webhookId || '')}`"), 'vault key namespace');
  assert.ok(
    SERVER.includes("row.key.startsWith('orb:')"),
    'platform-owned orb secrets must be excluded from the user-facing vault list',
  );
});

test('the netlify create route agrees with server/orbs.cjs on the provider list', () => {
  // Duplicated as a literal there on purpose (that function must not pull in the
  // Fly server's module graph), which is exactly why it needs a drift test.
  const { ORB_PROVIDERS, ORB_ROUTING_MODES } = require('../server/orbs.cjs');
  const providerMatch = NETLIFY.match(/const ORB_PROVIDERS = \[([^\]]+)\]/);
  const routingMatch = NETLIFY.match(/const ORB_ROUTING_MODES = \[([^\]]+)\]/);
  assert.ok(providerMatch && routingMatch, 'the netlify create route must declare both lists');
  const parse = (match) => match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(parse(providerMatch), ORB_PROVIDERS);
  assert.deepEqual(parse(routingMatch), ORB_ROUTING_MODES);
});

test('an unknown provider is rejected at the API boundary on both backends', () => {
  // normalizeOrbProvider coerces to 'generic' when READING a row, which is right.
  // At the write boundary it would mean an operator who typed "gitlab" silently
  // got an UNSIGNED orb.
  assert.ok(/throw badRequest\(`Unknown orb provider/.test(SERVER));
  assert.ok(/Unknown orb provider/.test(NETLIFY));
});
