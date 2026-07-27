'use strict';

// ============================================================================
// shared/usage-metering.cjs
// ----------------------------------------------------------------------------
// The WRITE half of cost metering: turning a provider's own reported usage into
// one `usage_events` row.
//
// Three rules, and every one of them is load-bearing:
//
//   1. UNITS, NEVER DOLLARS. A row records tokens, characters or seconds plus
//      the provider and the resource (the model, the voice model, the room).
//      It never records a price. Prices change — Sonnet 5 is on introductory
//      pricing until 2026-08-31 as this is written — and a price written into a
//      row on the day of the call becomes a lie the moment the rate card moves,
//      with no way to tell which rows are stale. Money is computed at DISPLAY
//      time from shared/usage-rates.cjs, which is one file to edit.
//
//   2. FAIL OPEN, ALWAYS. `recordUsageEvent` swallows every error. A metering
//      write must never be able to fail a turn the user is paying for: the
//      worst outcome of a broken meter is an under-reported bill, and the worst
//      outcome of a throwing meter is a dead chat. Callers are not expected to
//      await it for correctness and must never wrap it in their own try/catch
//      "just in case" — that would suggest it can throw.
//
//   3. NOTHING IS INVENTED. If a provider did not report usage, no row is
//      written. There is no estimated-from-characters fallback, no
//      "assume 4 chars per token": a cost screen that quietly mixes measured
//      and guessed numbers is worse than one that admits it has no data.
//
// Deliberately NO jsonb column. Every field is a scalar, so this module cannot
// reproduce the repo's most-repeated bind bug (a JSON.stringify'd jsonb bind
// becomes a string scalar on Fly, while Netlify requires the string). One shape
// binds identically on both lanes.
// ============================================================================

/** The countable units a row may carry. `unit` names which one the numbers are. */
const USAGE_UNIT_TOKENS = 'tokens';
const USAGE_UNIT_CHARACTERS = 'characters';
const USAGE_UNIT_SECONDS = 'seconds';

const USAGE_UNITS = [USAGE_UNIT_TOKENS, USAGE_UNIT_CHARACTERS, USAGE_UNIT_SECONDS];

/**
 * Where the money goes. Every place this deployment can spend, whether or not
 * it is instrumented yet — the list is the map of the spend surface, and an
 * uninstrumented provider here is a TODO with a name rather than a gap nobody
 * noticed.
 *
 *   anthropic  model calls (input/output/cache tokens)      INSTRUMENTED
 *   deepgram   huddle speech-to-text (audio seconds)        not yet — see below
 *   cartesia   huddle text-to-speech (characters)           not yet — see below
 *   livekit    huddle participant time (seconds)            not yet — see below
 *   sandbox    provider-skill runtime (seconds)             not yet — see below
 *
 * The three uninstrumented voice providers are not an oversight, and each is
 * blocked on something different:
 *   * Cartesia is spoken BY THE BROWSER against a 120s scoped token, so this
 *     machine never sees the characters. Metering it needs the client to report
 *     what it spoke — a new route, and a number the server cannot verify.
 *   * Deepgram audio does pass through the Fly relay (server/voice.cjs), so the
 *     seconds are countable here — but `voice_stt_start` carries no workspace
 *     id today, and usage with no workspace cannot be attributed to an account.
 *   * LiveKit bills participant-minutes, which are already derivable from
 *     huddles.started_at/ended_at + huddle_events; that makes them a Part-1
 *     statistic today and a usage row only once a rate is attached.
 */
const USAGE_PROVIDERS = ['anthropic', 'deepgram', 'cartesia', 'livekit', 'sandbox'];

/** Text field ceiling. A provider/model name is short; anything longer is a bug or an attack. */
const USAGE_TEXT_MAX = 120;

function usageText(value) {
 return String(value == null ? '' : value).trim().slice(0, USAGE_TEXT_MAX);
}

/**
 * A count. Negative, NaN, Infinity and "12 tokens" all become 0 rather than
 * poisoning a SUM — one bad row must not be able to make a whole account's
 * total nonsense, and 0 is the only value that cannot.
 */
function usageCount(value) {
 const parsed = Number(value);
 if (!Number.isFinite(parsed) || parsed <= 0) return 0;
 return Math.round(parsed);
}

function normalizeUsageUnit(value) {
 const unit = String(value || '').trim().toLowerCase();
 return USAGE_UNITS.includes(unit) ? unit : USAGE_UNIT_TOKENS;
}

/**
 * PURE: an Anthropic `usage` object -> the four counts, or null.
 *
 * Returns null when the object carries no countable tokens at all, which is
 * what keeps rule 3 true: a malformed or absent `usage` produces NO ROW, not a
 * row of zeroes that inflates the call count while contributing nothing.
 *
 * The four fields are the Messages API's own names. `cache_creation_input_tokens`
 * and `cache_read_input_tokens` are kept SEPARATE from `input_tokens` rather
 * than summed because they are priced differently (1.25x and 0.1x of base
 * input) — folding them together would under-report a cache-heavy workload's
 * writes and over-report its reads.
 */
function usageFromAnthropicUsage(usage) {
 if (!usage || typeof usage !== 'object') return null;
 const counts = {
  inputUnits: usageCount(usage.input_tokens),
  outputUnits: usageCount(usage.output_tokens),
  cacheWriteUnits: usageCount(usage.cache_creation_input_tokens),
  cacheReadUnits: usageCount(usage.cache_read_input_tokens),
 };
 const total = counts.inputUnits + counts.outputUnits + counts.cacheWriteUnits + counts.cacheReadUnits;
 return total > 0 ? counts : null;
}

/**
 * Accumulate usage across one Anthropic SSE stream.
 *
 * A streamed turn reports its usage in two places and neither alone is the
 * answer: `message_start` carries the input/cache counts (and an output count
 * of ~1), and `message_delta` carries the running OUTPUT total, re-sent as it
 * grows. So input is taken once from the start frame and output is taken as the
 * MAXIMUM seen — never summed, which would multiply the output bill by the
 * number of delta frames, and never "last wins", which loses the total if a
 * stream is cut off mid-frame.
 *
 * Tolerant by design: it is fed every parsed SSE event, including the dozens of
 * content deltas it ignores, so a caller never has to know which frames matter.
 */
function createAnthropicUsageAccumulator() {
 let inputUnits = 0;
 let cacheWriteUnits = 0;
 let cacheReadUnits = 0;
 let outputUnits = 0;
 let sawUsage = false;

 function absorb(usage) {
  const counts = usageFromAnthropicUsage(usage);
  if (!counts) return;
  sawUsage = true;
  // Input-side counts are stated once, on message_start. Take the largest seen
  // so a re-stated frame cannot double them.
  inputUnits = Math.max(inputUnits, counts.inputUnits);
  cacheWriteUnits = Math.max(cacheWriteUnits, counts.cacheWriteUnits);
  cacheReadUnits = Math.max(cacheReadUnits, counts.cacheReadUnits);
  outputUnits = Math.max(outputUnits, counts.outputUnits);
 }

 return {
  /** Feed one parsed SSE event. Unknown/irrelevant events are ignored. */
  event(parsed) {
   if (!parsed || typeof parsed !== 'object') return;
   if (parsed.type === 'message_start') absorb(parsed.message && parsed.message.usage);
   else if (parsed.type === 'message_delta') absorb(parsed.usage);
  },
  /** The totals, or null when the stream never reported any usage. */
  result() {
   if (!sawUsage) return null;
   const total = inputUnits + outputUnits + cacheWriteUnits + cacheReadUnits;
   return total > 0 ? { inputUnits, outputUnits, cacheWriteUnits, cacheReadUnits } : null;
  },
 };
}

/**
 * PURE: the row that will be written, or null when there is nothing to record.
 *
 * Split out from the insert so the shaping — which fields are required, what a
 * junk count becomes, when a row is refused — is testable without a database.
 * A row with no workspace is still recorded (`workspace_id` null): it cannot be
 * attributed to an account, but it is real money and belongs in the deployment
 * total. A row with no provider or no units is refused.
 */
function buildUsageEvent(event) {
 if (!event || typeof event !== 'object') return null;
 const provider = usageText(event.provider).toLowerCase();
 if (!provider) return null;

 const inputUnits = usageCount(event.inputUnits);
 const outputUnits = usageCount(event.outputUnits);
 const cacheWriteUnits = usageCount(event.cacheWriteUnits);
 const cacheReadUnits = usageCount(event.cacheReadUnits);
 if (inputUnits + outputUnits + cacheWriteUnits + cacheReadUnits === 0) return null;

 const workspaceId = usageText(event.workspaceId);
 return {
  workspace_id: workspaceId || null,
  provider,
  resource: usageText(event.resource),
  kind: usageText(event.kind),
  unit: normalizeUsageUnit(event.unit),
  input_units: inputUnits,
  output_units: outputUnits,
  cache_write_units: cacheWriteUnits,
  cache_read_units: cacheReadUnits,
 };
}

const INSERT_USAGE_SQL = `insert into usage_events
    (workspace_id, provider, resource, kind, unit, input_units, output_units, cache_write_units, cache_read_units)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

/**
 * Write one usage row. NEVER THROWS, NEVER REJECTS.
 *
 * Returns the row that was written, or null when nothing was (refused shape, no
 * db, or the insert failed). The failure path is deliberately quiet at warn
 * level rather than error: on a database whose schema bootstrap has not run yet
 * — Netlify serving a route before a `fly deploy` created the table — every
 * single call would fail, and a red log per model call would bury the deploy
 * that actually needs doing.
 */
async function recordUsageEvent(db, event) {
 const row = buildUsageEvent(event);
 if (!row || typeof db !== 'function') return null;
 try {
  await db(INSERT_USAGE_SQL, [
   row.workspace_id,
   row.provider,
   row.resource,
   row.kind,
   row.unit,
   row.input_units,
   row.output_units,
   row.cache_write_units,
   row.cache_read_units,
  ]);
  return row;
 } catch (error) {
  if (process.env.AGENSIS_DEBUG_USAGE) {
   console.warn('[usage] could not record usage:', error?.message || error);
  }
  return null;
 }
}

/**
 * Record one Anthropic call. The convenience wrapper every call site uses, so
 * the four field names arrive spelled the same way at every one of them.
 * Same contract as `recordUsageEvent`: never throws.
 */
async function recordAnthropicUsage(db, { workspaceId, model, kind, usage, counts }) {
 const resolved = counts || usageFromAnthropicUsage(usage);
 if (!resolved) return null;
 return recordUsageEvent(db, {
  workspaceId,
  provider: 'anthropic',
  resource: model,
  kind,
  unit: USAGE_UNIT_TOKENS,
  ...resolved,
 });
}

module.exports = {
 USAGE_UNIT_TOKENS,
 USAGE_UNIT_CHARACTERS,
 USAGE_UNIT_SECONDS,
 USAGE_UNITS,
 USAGE_PROVIDERS,
 normalizeUsageUnit,
 usageFromAnthropicUsage,
 createAnthropicUsageAccumulator,
 buildUsageEvent,
 recordUsageEvent,
 recordAnthropicUsage,
};
