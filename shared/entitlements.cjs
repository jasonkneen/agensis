'use strict';

// What a plan is allowed to do. Pure: a plan name in, capabilities out, no DB,
// no request, no clock.
//
// This is deliberately the SMALLEST honest thing that can gate a feature. There
// is no billing here, no checkout, no upgrade flow, no usage metering and no
// quota — those are the owner's problem, and inventing them here would be
// building a product nobody asked for. What exists is one table of plan names
// and one map from plan to capability, so that when real billing arrives there
// is exactly one file to change and one column to populate.
//
// The first capability is `voiceEngines`, because huddle voice is the first
// feature with a paid tier above it:
//
//   EVERY account gets `cartesia-deepgram`. That is the baseline voice
//   experience, not an add-on and not opt-in — a fresh free account joins a
//   huddle and hears a proper voice with no configuration at all.
//
//   `browser` is always allowed too. It needs no key and no money; it is the
//   fallback that keeps a microphone alive when a server key is missing, and
//   gating it would mean an unconfigured deployment has no voice at all.
//
// There is no model-provider voice engine. LiveKit carries audio; each selected
// Agensis agent keeps its own runtime and model.

/** Every plan name the app understands. `free` is what an unset column means. */
const PLANS = ['free', 'pro'];
const DEFAULT_PLAN = 'free';

// Ordered best-first within each plan. The client walks this list and takes the
// first engine that is also CONFIGURED on the server, so the order here is the
// preference order when an agent has expressed none.
const PLAN_ENTITLEMENTS = Object.freeze({
  free: Object.freeze({
    voiceEngines: Object.freeze(['cartesia-deepgram', 'browser']),
  }),
  pro: Object.freeze({
    voiceEngines: Object.freeze(['cartesia-deepgram', 'browser']),
  }),
});

/**
 * A stored plan value -> a plan this module knows.
 *
 * Null, empty, unknown and misspelt all become `free`. Fails CLOSED: a typo in
 * the column must not accidentally grant the paid tier, and an account whose
 * plan cannot be read still gets the full baseline experience.
 */
function normalizePlan(value) {
  const plan = String(value ?? '').trim().toLowerCase();
  return PLANS.includes(plan) ? plan : DEFAULT_PLAN;
}

/** Everything `plan` is entitled to. Always an object, never null. */
function entitlementsForPlan(value) {
  return PLAN_ENTITLEMENTS[normalizePlan(value)];
}

/** The voice engines this plan may use, best-first. */
function entitledVoiceEngines(plan) {
  return [...entitlementsForPlan(plan).voiceEngines];
}

/** May this plan use this engine at all? The server-side gate's one question. */
function voiceEngineEntitled(plan, engineId) {
  return entitlementsForPlan(plan).voiceEngines.includes(String(engineId || ''));
}

/**
 * Why this plan cannot use this engine, as a sentence, or '' when it can.
 *
 * A sentence rather than a boolean because the caller puts it on screen and in
 * an HTTP error body. "Not available" with no reason sends people hunting for a
 * setting that does not exist.
 */
function voiceEngineDeniedReason(plan, engineId) {
  if (voiceEngineEntitled(plan, engineId)) return '';
  const known = new Set();
  for (const entry of Object.values(PLAN_ENTITLEMENTS)) {
    for (const engine of entry.voiceEngines) known.add(engine);
  }
  if (!known.has(String(engineId || ''))) return 'That voice engine does not exist.';
  return 'That voice engine needs an upgraded plan.';
}

module.exports = {
  PLANS,
  DEFAULT_PLAN,
  normalizePlan,
  entitlementsForPlan,
  entitledVoiceEngines,
  voiceEngineEntitled,
  voiceEngineDeniedReason,
};
