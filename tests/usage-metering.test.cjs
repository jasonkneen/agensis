// ============================================================================
// tests/usage-metering.test.cjs
// ----------------------------------------------------------------------------
// Cost metering: the write side (shared/usage-metering.cjs), the pricing side
// (shared/usage-rates.cjs), and the WIRING that says both are actually reached
// from every place this deployment spends money.
//
// The wiring half is the part worth having. A metering module with perfect unit
// tests and no call site records nothing, and looks identical on a dashboard to
// a workspace that genuinely cost nothing — which is the single worst failure
// this feature can have, because it is silent and it is a number somebody will
// make a decision on. So the source of both backends is asserted directly:
// every Anthropic call path names the recorder, and the table exists in all
// three schema places.
//
// The other rule under test is FAIL-OPEN. A metering write must never be able
// to fail a paid turn, so `recordUsageEvent` is exercised against a database
// that throws, a database that is not a function, and a table that does not
// exist — and must return quietly in every case.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { flyLaneSource } = require('./helpers/fly-lane.cjs');
const {
 usageFromAnthropicUsage,
 createAnthropicUsageAccumulator,
 buildUsageEvent,
 recordUsageEvent,
 recordAnthropicUsage,
 USAGE_PROVIDERS,
} = require('../shared/usage-metering.cjs');
const { estimateUsd, summarizeUsage, anthropicRateFor, RATES_AS_OF } = require('../shared/usage-rates.cjs');
const core = require('../shared/backend-core.cjs');

// The Fly lane spans index.cjs plus the server/*-routes.cjs modules extracted
// from it (Wave 2 of the index.cjs reduction). These assertions count Anthropic
// spend points across the LANE — /backend/ai-chat is one of the three — so the
// source has to be the whole lane, not one file.
const serverSource = flyLaneSource();
const netlifySource = fs.readFileSync(path.join(root, 'netlify/functions/backend.mjs'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Reading a provider's own reported usage
// ---------------------------------------------------------------------------

test('an Anthropic usage object becomes the four counts, cache kept separate from input', () => {
 const counts = usageFromAnthropicUsage({
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 500,
  cache_read_input_tokens: 4000,
 });
 // Cache tokens are NOT folded into input: a 5-minute write is 1.25x base input
 // and a read is 0.1x, so summing them would misprice both directions.
 assert.deepEqual(counts, {
  inputUnits: 100,
  outputUnits: 20,
  cacheWriteUnits: 500,
  cacheReadUnits: 4000,
 });
});

test('no reported usage means NO ROW, not a row of zeroes', () => {
 // Nothing is invented. A row of zeroes would inflate the call count while
 // contributing no tokens, making a busy account look cheap for the wrong reason.
 assert.equal(usageFromAnthropicUsage(null), null);
 assert.equal(usageFromAnthropicUsage(undefined), null);
 assert.equal(usageFromAnthropicUsage({}), null);
 assert.equal(usageFromAnthropicUsage({ input_tokens: 0, output_tokens: 0 }), null);
 assert.equal(usageFromAnthropicUsage('120 tokens'), null);
});

test('junk counts become 0 rather than poisoning a SUM', () => {
 const counts = usageFromAnthropicUsage({
  input_tokens: 'lots',
  output_tokens: -5,
  cache_creation_input_tokens: Infinity,
  cache_read_input_tokens: 10,
 });
 assert.deepEqual(counts, { inputUnits: 0, outputUnits: 0, cacheWriteUnits: 0, cacheReadUnits: 10 });
});

// ---------------------------------------------------------------------------
// 2. The streaming accumulator
// ---------------------------------------------------------------------------

test('a streamed turn takes input from message_start and the MAX output from message_delta', () => {
 const usage = createAnthropicUsageAccumulator();
 usage.event({ type: 'message_start', message: { usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 30 } } });
 usage.event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } });
 // Anthropic re-states the RUNNING output total on each message_delta. Summing
 // them would multiply the output bill by the number of frames.
 usage.event({ type: 'message_delta', usage: { output_tokens: 40 } });
 usage.event({ type: 'message_delta', usage: { output_tokens: 120 } });
 assert.deepEqual(usage.result(), {
  inputUnits: 900,
  outputUnits: 120,
  cacheWriteUnits: 0,
  cacheReadUnits: 30,
 });
});

test('a late frame that reports LESS output does not lose the total', () => {
 const usage = createAnthropicUsageAccumulator();
 usage.event({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } });
 usage.event({ type: 'message_delta', usage: { output_tokens: 500 } });
 usage.event({ type: 'message_delta', usage: { output_tokens: 2 } });
 assert.equal(usage.result().outputUnits, 500);
});

test('a stream that reported no usage at all yields null', () => {
 const usage = createAnthropicUsageAccumulator();
 usage.event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } });
 usage.event(null);
 usage.event('garbage');
 assert.equal(usage.result(), null);
});

// ---------------------------------------------------------------------------
// 3. The row that gets written
// ---------------------------------------------------------------------------

test('a usage row records units and a provider, and NEVER a price', () => {
 const row = buildUsageEvent({
  workspaceId: 'ws-1',
  provider: 'Anthropic',
  resource: 'claude-opus-4-5',
  kind: 'ai_chat',
  inputUnits: 100,
  outputUnits: 50,
 });
 assert.equal(row.provider, 'anthropic');
 assert.equal(row.unit, 'tokens');
 assert.equal(row.input_units, 100);
 // The whole point: no money is stored. A price written on the day of the call
 // becomes indistinguishable from a current one the moment the rate card moves.
 const keys = Object.keys(row).join(' ');
 assert.equal(/usd|price|cost|dollar/i.test(keys), false, 'a usage row must carry no money field');
});

test('a row with no units, or no provider, is refused', () => {
 assert.equal(buildUsageEvent({ workspaceId: 'ws-1', provider: 'anthropic' }), null);
 assert.equal(buildUsageEvent({ workspaceId: 'ws-1', provider: '', inputUnits: 10 }), null);
 assert.equal(buildUsageEvent(null), null);
});

test('a row with no workspace is still recorded, with a null workspace_id', () => {
 // It cannot be attributed to an account, but it is real money and belongs in
 // the deployment total. Dropping it would under-report the bill.
 const row = buildUsageEvent({ provider: 'anthropic', inputUnits: 1 });
 assert.equal(row.workspace_id, null);
});

test('an unknown unit falls back to tokens rather than storing a junk string', () => {
 assert.equal(buildUsageEvent({ provider: 'anthropic', unit: 'bananas', inputUnits: 1 }).unit, 'tokens');
 assert.equal(buildUsageEvent({ provider: 'deepgram', unit: 'seconds', inputUnits: 1 }).unit, 'seconds');
});

// ---------------------------------------------------------------------------
// 4. FAIL OPEN — the rule that keeps a broken meter from killing a paid turn
// ---------------------------------------------------------------------------

test('recording never throws when the database throws', async () => {
 const db = async () => { throw new Error('relation "usage_events" does not exist'); };
 assert.equal(await recordUsageEvent(db, { provider: 'anthropic', inputUnits: 10 }), null);
 assert.equal(await recordAnthropicUsage(db, {
  workspaceId: 'ws-1',
  model: 'claude-opus-4-5',
  kind: 'ai_chat',
  usage: { input_tokens: 10, output_tokens: 2 },
 }), null);
});

test('recording never throws when there is no database at all', async () => {
 assert.equal(await recordUsageEvent(null, { provider: 'anthropic', inputUnits: 10 }), null);
 assert.equal(await recordUsageEvent(undefined, { provider: 'anthropic', inputUnits: 10 }), null);
});

test('a recorded call binds nine scalars and no jsonb', async () => {
 const calls = [];
 const db = async (sql, params) => { calls.push({ sql, params }); return []; };
 await recordAnthropicUsage(db, {
  workspaceId: 'ws-1',
  model: 'claude-haiku-4-5',
  kind: 'auto_interject',
  usage: { input_tokens: 400, output_tokens: 12 },
 });
 assert.equal(calls.length, 1);
 assert.match(calls[0].sql, /insert into usage_events/);
 assert.equal(calls[0].params.length, 9);
 // No jsonb anywhere: the repo's most-repeated bind bug (Fly wants the object,
 // Netlify wants the string) is structurally impossible on this table.
 assert.equal(calls[0].sql.includes('jsonb'), false);
 for (const param of calls[0].params) {
  assert.ok(param === null || typeof param === 'string' || typeof param === 'number');
 }
});

test('a call the provider reported no usage for writes nothing', async () => {
 let called = false;
 const db = async () => { called = true; return []; };
 await recordAnthropicUsage(db, { workspaceId: 'ws-1', model: 'x', kind: 'y', usage: undefined });
 assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// 5. Units -> money, at display time only
// ---------------------------------------------------------------------------

test('Anthropic tokens are priced from the rate card', () => {
 // 1M input at $5 + 1M output at $25 on the Opus card.
 const priced = estimateUsd({
  provider: 'anthropic',
  resource: 'claude-opus-4-5',
  inputUnits: 1_000_000,
  outputUnits: 1_000_000,
 });
 assert.equal(priced.priced, true);
 assert.equal(priced.estimated, false);
 assert.equal(priced.usd, 30);
});

test('cache writes and reads are priced at their own rates, not as input', () => {
 const priced = estimateUsd({
  provider: 'anthropic',
  resource: 'claude-opus-4-5',
  cacheWriteUnits: 1_000_000,
  cacheReadUnits: 1_000_000,
 });
 // 1.25x base input, and 0.1x base input.
 assert.equal(priced.usd, 6.25 + 0.5);
});

test('an unknown model is priced at the Opus rate and SAYS it was estimated', () => {
 // Never zero: an unknown model is most likely a newer flagship, and pricing it
 // at zero hides the most expensive thing on the deployment from the one screen
 // built to find it.
 const priced = estimateUsd({ provider: 'anthropic', resource: 'claude-something-new', inputUnits: 1_000_000 });
 assert.equal(priced.priced, true);
 assert.equal(priced.estimated, true);
 assert.equal(priced.usd, 5);
 assert.match(priced.note, /Opus rate/);
});

test('a model id is matched exactly — no prefix matching', () => {
 assert.equal(anthropicRateFor('claude-opus-4-5').known, true);
 assert.equal(anthropicRateFor('claude-opus').known, false);
 assert.equal(anthropicRateFor('CLAUDE-OPUS-4-5  ').known, true);
});

test('a provider with no rate is UNPRICED, which is not the same as free', () => {
 const priced = estimateUsd({ provider: 'deepgram', resource: 'flux', inputUnits: 3600 });
 assert.equal(priced.priced, false);
 assert.equal(priced.usd, 0);
 assert.ok(priced.note.length > 0, 'an unpriced provider must explain itself');
});

test('a summary keeps unpriced spend OUT of the total and names it', () => {
 const summary = summarizeUsage([
  { provider: 'anthropic', resource: 'claude-haiku-4-5', calls: 4, input_units: 1_000_000, output_units: 0 },
  { provider: 'deepgram', resource: 'flux', calls: 2, input_units: 600, output_units: 0 },
 ]);
 assert.equal(summary.usd, 1);           // haiku input only; deepgram contributes nothing
 assert.equal(summary.calls, 6);         // but its CALLS are still counted
 assert.deepEqual(summary.unpriced_providers, ['deepgram']);
 assert.equal(summary.rates_as_of, RATES_AS_OF);
});

test('an empty ledger summarizes to zero calls, which the UI must not render as $0.00', () => {
 const summary = summarizeUsage([]);
 assert.equal(summary.calls, 0);
 assert.equal(summary.usd, 0);
 assert.deepEqual(summary.unpriced_providers, []);
});

test('the rate table carries the date it was last checked', () => {
 assert.match(RATES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------------------
// 6. WIRING — the assertions that say metering is actually reached
// ---------------------------------------------------------------------------

test('every Anthropic call path on the Fly server records usage', () => {
 // Three distinct spend points, and each must record its own row:
 //  * runAnthropicCompletion  — the non-streamed helper (auto-interject)
 //  * streamAnthropicTurn     — ONE STEP of the builtin tool loop, which runs
 //                              up to BUILTIN_TOOL_LOOP_MAX_STEPS + 1 times per
 //                              turn; recording per turn would under-report a
 //                              tool-heavy turn by up to 9x
 //  * /backend/ai-chat        — the browser chat relay
 const recorders = serverSource.match(/recordAnthropicUsage\(/g) || [];
 assert.ok(recorders.length >= 3, `expected 3+ Anthropic metering sites on Fly, found ${recorders.length}`);
 assert.match(serverSource, /createAnthropicUsageAccumulator\(\)/);
 // Every fetch of the Messages API must be inside a function that also meters.
 const messagesCalls = serverSource.match(/api\.anthropic\.com\/v1\/messages/g) || [];
 assert.ok(recorders.length >= messagesCalls.length, 'an Anthropic endpoint call with no metering site');
});

test('the builtin tool loop meters per MODEL CALL, not per turn', () => {
 // The accumulator and the recorder both live inside streamAnthropicTurn, which
 // is the function runToolUseLoop invokes once per step.
 const start = serverSource.indexOf('async function streamAnthropicTurn');
 assert.ok(start > 0, 'streamAnthropicTurn not found');
 const body = serverSource.slice(start, serverSource.indexOf('\nfunction safeFileName', start));
 assert.match(body, /createAnthropicUsageAccumulator\(\)/);
 assert.match(body, /recordAnthropicUsage\(/);
});

test('the Netlify lane records usage too — one table, both backends', () => {
 assert.match(netlifySource, /recordAnthropicUsage\(/);
 assert.match(netlifySource, /createAnthropicUsageAccumulator\(\)/);
 assert.match(netlifySource, /from '\.\.\/\.\.\/shared\/usage-metering\.cjs'/);
});

test('the auto-interject relevance call is metered under its own kind', () => {
 // It is made on EVERY unaddressed message in an 'auto' channel and nobody
 // asked for it, so it needs its own line rather than hiding inside a total.
 assert.match(serverSource, /usageKind: 'auto_interject'/);
});

test('usage_events exists in all THREE schema places', () => {
 assert.match(serverSource, /CREATE TABLE IF NOT EXISTS usage_events/, 'missing from ensureRuntimeSchema');
 const canonical = fs.readFileSync(path.join(root, 'database/neon-schema.sql'), 'utf8');
 assert.match(canonical, /CREATE TABLE IF NOT EXISTS usage_events/, 'missing from database/neon-schema.sql');
 const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .map((name) => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8'));
 assert.ok(
  migrations.some((sql) => /CREATE TABLE IF NOT EXISTS usage_events/.test(sql)),
  'missing from supabase/migrations',
 );
});

test('the metering epoch is stamped once, so "since <date>" is always truthful', () => {
 // Without it, a screen showing a total has nothing honest to label it with —
 // and no usage exists before it, which cannot be back-filled.
 assert.match(serverSource, /usage\.metering_started_at/);
 assert.match(serverSource, /on conflict \(key\) do nothing/);
});

test('usage_events is NOT reachable through the generic /backend/db gate', () => {
 // It is read only through the owner-gated tenant routes. Putting it in the
 // allowlists would let any workspace member read another tenant's spend.
 assert.equal(core.ALLOWED_TABLES.has('usage_events'), false);
 assert.equal(core.WORKSPACE_SCOPED_TABLES.has('usage_events'), false);
 assert.equal(Object.prototype.hasOwnProperty.call(core.DB_TABLE_ACCESS, 'usage_events'), false);
});

test('the provider list names every place this deployment can spend', () => {
 // A provider missing from here is a spend point nobody has looked at. Keep
 // uninstrumented ones IN the list — a named TODO beats a silent gap.
 for (const provider of ['anthropic', 'deepgram', 'cartesia', 'livekit', 'sandbox']) {
  assert.ok(USAGE_PROVIDERS.includes(provider), `${provider} is missing from USAGE_PROVIDERS`);
 }
});
