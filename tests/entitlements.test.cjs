// The spec for shared/entitlements.cjs, salvaged with it.
//
// THIS BRANCH IS NOT MERGED, ON PURPOSE. Nothing in main calls this module:
// there is no `plan` column on an account, and main's voice code does not use
// the engine vocabulary this file gates ('cartesia-deepgram', 'openai-realtime'
// — main knows only 'browser'). Merging it would put an unreachable module and
// an unreachable test into the shipped tree.
//
// It is preserved because it is the one piece of worktree-voice-pipeline that
// main genuinely lacked, and because the decisions encoded here — fail closed
// to free, baseline voice for everybody, one file to change when billing
// arrives — are worth more than the twenty minutes it would take to retype.
//
// The fourth test from the original file is deliberately NOT here: it pinned
// src/lib/voiceEngineIds.ts against shared/voice-core.cjs, and that pairing
// belongs to the voice-engine architecture that did not ship.

const test = require('node:test');
const assert = require('node:assert');
const entitlements = require('../shared/entitlements.cjs');

test('every plan gets the baseline engine and the no-key fallback', () => {
  for (const plan of entitlements.PLANS) {
    const engines = entitlements.entitledVoiceEngines(plan);
    assert.ok(engines.includes('cartesia-deepgram'), `${plan} must get the baseline engine`);
    assert.ok(engines.includes('browser'), `${plan} must keep the no-key fallback`);
  }
});

test('an unreadable plan value fails CLOSED to free', () => {
  for (const value of [null, undefined, '', '   ', 'PRO ', 'enterprise', 'Free', 42, {}]) {
    const plan = entitlements.normalizePlan(value);
    assert.ok(entitlements.PLANS.includes(plan));
    if (value === 'PRO ' || value === 'Free') continue; // case/space normalise to real plans
    assert.equal(plan, 'free', `${JSON.stringify(value)} must not grant a paid tier`);
  }
  // Trimmed and lowercased, so a stored 'PRO ' is still the pro plan.
  assert.equal(entitlements.normalizePlan('PRO '), 'pro');
});

test('only the upgraded plan is entitled to the upgrade engine', () => {
  assert.equal(entitlements.voiceEngineEntitled('free', 'openai-realtime'), false);
  assert.equal(entitlements.voiceEngineEntitled('pro', 'openai-realtime'), true);
  assert.equal(entitlements.voiceEngineEntitled('free', 'cartesia-deepgram'), true);
  assert.match(entitlements.voiceEngineDeniedReason('free', 'openai-realtime'), /upgraded plan/i);
  assert.equal(entitlements.voiceEngineDeniedReason('free', 'cartesia-deepgram'), '');
  // An engine nobody has ever heard of is a different sentence from a paid one.
  assert.match(entitlements.voiceEngineDeniedReason('pro', 'telepathy'), /does not exist/i);
});
