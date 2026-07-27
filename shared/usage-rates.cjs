'use strict';

// ============================================================================
// shared/usage-rates.cjs
// ----------------------------------------------------------------------------
// THE ONE PLACE PRICES LIVE. Nothing else in this codebase may contain a
// number denominated in money.
//
// `usage_events` rows record COUNTS — tokens, characters, seconds — and never a
// price (see shared/usage-metering.cjs). Money is computed from those counts
// here, at the moment a figure is rendered. That split is the whole design:
//
//   * A stored price is a lie with a long half-life. Rates move (Sonnet 5 is on
//     introductory pricing until 2026-08-31 as this is written, and reverts to
//     a 50% higher rate the next day). A dollar figure written into a row on
//     the day of the call cannot be corrected, cannot be told apart from a
//     current one, and quietly makes every historical total wrong.
//   * Rates are also NEGOTIABLE and per-deployment — a volume discount, a
//     committed-spend agreement, a different provider plan. Editing this table
//     re-prices the whole history correctly, because the history is counts.
//
// EVERY FIGURE THIS PRODUCES IS AN ESTIMATE, and the UI is required to say so.
// It cannot be anything else: it is our own count of what we asked for,
// multiplied by a list price we typed in by hand. It is not an invoice, it does
// not know about free tiers, minimums, discounts, or the 1.1x data-residency
// multiplier, and it will not match a provider's bill to the cent. What it is
// good for is "which tenant is expensive, and roughly how much".
// ============================================================================

/**
 * When the numbers below were last checked against the provider's own rate
 * card. Shown in the UI next to every estimate — a rate table with no date on
 * it is indistinguishable from one nobody has looked at since 2024.
 *
 * UPDATE THIS WHENEVER YOU EDIT A RATE.
 */
const RATES_AS_OF = '2026-07-27';

/**
 * USD per MILLION tokens, from platform.claude.com/docs/en/about-claude/pricing.
 *
 * Keyed on the model id as we send it. `cacheWrite` is the 5-minute write rate
 * (1.25x base input); the 1-hour rate (2x) is not represented because nothing
 * in this app requests a 1-hour cache. `cacheRead` is 0.1x base input.
 *
 * Sonnet 5 is priced at its STANDARD rate ($3/$15), not the introductory rate
 * in effect until 2026-08-31, on the principle that a cost screen should round
 * towards over-estimating: an operator who budgets from a number that turns out
 * to be high has a pleasant surprise, and one who budgets from a number that
 * turns out to be low has a problem.
 */
const ANTHROPIC_TOKEN_RATES = {
 'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
 'claude-mythos-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
 'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
 'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
 'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
 'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
 'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
 'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
 'claude-sonnet-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
 'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
 'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
 'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * What an unrecognised model costs. Deliberately the OPUS rate rather than zero
 * or an average: an unknown model is most likely a newer flagship, and pricing
 * it at zero would make the single most expensive thing on the deployment
 * invisible on the screen whose whole job is finding it. `estimateUsd` reports
 * that it fell back, so the UI can mark the figure rather than pass it off as
 * priced.
 */
const ANTHROPIC_FALLBACK_RATE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

/**
 * The providers with no rate yet, and why. Present so the UI can say "metered,
 * not priced" instead of showing a confident $0.00 for a real cost.
 *
 * Each of these is priced per unit that varies by plan more than Anthropic's
 * does, so a typed-in list price here would be a worse guess than no guess.
 * Fill one in and it starts being costed with no other change.
 */
const UNPRICED_PROVIDERS = {
 deepgram: 'Audio minutes are plan-dependent — add a per-second rate to price them.',
 cartesia: 'Characters are plan-dependent — add a per-character rate to price them.',
 livekit: 'Participant minutes are plan-dependent — add a per-second rate to price them.',
 sandbox: 'Sandbox runtime is billed by the provider the workspace supplied its own key for.',
};

const PER_MILLION = 1_000_000;

function rateNumber(value) {
 const parsed = Number(value);
 return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function unitCount(value) {
 const parsed = Number(value);
 return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * PURE: the Anthropic rate card for a model id, plus whether it was a real
 * match. Normalizes case and whitespace only — no prefix matching, because
 * "claude-opus" matching the opus rate would silently price a future
 * `claude-opus-9` at today's number and never tell anyone.
 */
function anthropicRateFor(model) {
 const id = String(model || '').trim().toLowerCase();
 const rate = ANTHROPIC_TOKEN_RATES[id];
 if (rate) return { rate, known: true };
 return { rate: ANTHROPIC_FALLBACK_RATE, known: false };
}

/**
 * PURE: units -> USD, for one usage row (or one pre-summed group of them).
 *
 * Returns `{ usd, priced, estimated, note }`:
 *   usd        the figure, always a number (0 when unpriced)
 *   priced     false when this provider has no rate at all — the UI must NOT
 *              render 0 as if it were the cost
 *   estimated  true when a rate was applied but the exact resource was unknown
 *
 * Rounded to 6 decimal places, not to cents: a single Haiku call can cost
 * fractions of a cent, and rounding per row would floor a thousand of them to
 * zero. Round for presentation, never here.
 */
function estimateUsd({ provider, resource, inputUnits, outputUnits, cacheWriteUnits, cacheReadUnits }) {
 const name = String(provider || '').trim().toLowerCase();

 if (name !== 'anthropic') {
  const note = UNPRICED_PROVIDERS[name] || 'No rate is configured for this provider.';
  return { usd: 0, priced: false, estimated: false, note };
 }

 const { rate, known } = anthropicRateFor(resource);
 const usd = (
  unitCount(inputUnits) * rateNumber(rate.input)
  + unitCount(outputUnits) * rateNumber(rate.output)
  + unitCount(cacheWriteUnits) * rateNumber(rate.cacheWrite)
  + unitCount(cacheReadUnits) * rateNumber(rate.cacheRead)
 ) / PER_MILLION;

 return {
  usd: Math.round(usd * 1e6) / 1e6,
  priced: true,
  estimated: !known,
  note: known ? '' : `No rate is listed for "${String(resource || '').trim() || 'unknown'}" — priced at the Opus rate.`,
 };
}

/**
 * PURE: many per-(provider, resource) groups -> one costed summary.
 *
 * Input rows are the shape `usage_events` aggregates into:
 *   { provider, resource, calls, input_units, output_units, cache_write_units, cache_read_units }
 *
 * Output keeps the priced and the merely-counted apart on purpose. `usd` is the
 * sum of what could be priced; `unpriced_providers` names what is missing from
 * it. A screen that added them together would report a smaller number than the
 * truth with nothing on it to say so.
 */
function summarizeUsage(rows) {
 const list = Array.isArray(rows) ? rows : [];
 const byProvider = new Map();
 let usd = 0;
 let calls = 0;
 let estimatedRates = false;
 const unpriced = new Set();

 for (const row of list) {
  const provider = String(row?.provider || '').trim().toLowerCase() || 'unknown';
  const rowCalls = unitCount(row?.calls);
  const priced = estimateUsd({
   provider,
   resource: row?.resource,
   inputUnits: row?.input_units,
   outputUnits: row?.output_units,
   cacheWriteUnits: row?.cache_write_units,
   cacheReadUnits: row?.cache_read_units,
  });

  if (priced.priced) usd += priced.usd;
  else if (rowCalls > 0 || unitCount(row?.input_units) + unitCount(row?.output_units) > 0) unpriced.add(provider);
  if (priced.estimated) estimatedRates = true;
  calls += rowCalls;

  const bucket = byProvider.get(provider) || {
   provider,
   calls: 0,
   input_units: 0,
   output_units: 0,
   cache_write_units: 0,
   cache_read_units: 0,
   usd: 0,
   priced: priced.priced,
  };
  bucket.calls += rowCalls;
  bucket.input_units += unitCount(row?.input_units);
  bucket.output_units += unitCount(row?.output_units);
  bucket.cache_write_units += unitCount(row?.cache_write_units);
  bucket.cache_read_units += unitCount(row?.cache_read_units);
  bucket.usd = Math.round((bucket.usd + priced.usd) * 1e6) / 1e6;
  bucket.priced = bucket.priced && priced.priced;
  byProvider.set(provider, bucket);
 }

 return {
  usd: Math.round(usd * 1e6) / 1e6,
  calls,
  /** True when at least one figure used the fallback rate for an unknown model. */
  estimated_rates: estimatedRates,
  /** Providers with real usage and no rate — their spend is NOT in `usd`. */
  unpriced_providers: [...unpriced].sort(),
  providers: [...byProvider.values()].sort((a, b) => b.usd - a.usd || a.provider.localeCompare(b.provider)),
  rates_as_of: RATES_AS_OF,
 };
}

module.exports = {
 RATES_AS_OF,
 ANTHROPIC_TOKEN_RATES,
 ANTHROPIC_FALLBACK_RATE,
 UNPRICED_PROVIDERS,
 anthropicRateFor,
 estimateUsd,
 summarizeUsage,
};
