'use strict';

// ============================================================================
// tests/reply-cadence.test.cjs
// ----------------------------------------------------------------------------
// A social room answers like a room, not like a switchboard.
//
// Four things are asserted, and the first is the one that matters most: the
// decision is a PURE FUNCTION of the conversation. Timing that only exists
// inside a live dispatch loop cannot be reasoned about or verified, and this
// feature is entirely about feel — so every millisecond of it is derived from
// values a test can supply, including the jitter (seeded from the message id,
// never Math.random).
//
//   A. THE PLAN. Settle, stagger, growth, the chorus gate, and the exact
//      millisecond each produces, pinned literally.
//   B. NOTHING ELSE IS SLOWED. A DM, a huddle transcript and a channel on
//      'auto' or 'mention' answer with delayMs 0 — proven for the whole input
//      space, not just for a sample, since only one enum value can pace anything.
//   C. THE WAKE IS BOOKED, NOT DROPPED. A held turn registers exactly one
//      pending wake for its conversation and cannot be double-booked (which
//      would let a busy channel starve a reply by re-scheduling it forever).
//   D. THE THIRD MODE IS WIRED EVERYWHERE. 'social' is answerable (a value added
//      to this column must not silence the channels that adopt it), it survives
//      normalization, and the dispatcher reads it at the one place turns start.
//
// The parity half — that shared/replyCadence.cjs and src/lib/replyCadence.ts
// agree — is pinned here and re-run against the TS module in
// tests/unit/replyCadence.test.ts.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cadence = require('../shared/replyCadence.cjs');
const mentions = require('../shared/channelMentions.cjs');
const { __test } = require('../server/index.cjs');

const {
 BROADCAST_REPLY_LIMIT, MAX_DELAY_MS,
 SETTLE_MIN_MS, SETTLE_MAX_MS,
 STAGGER_MIN_MS, STAGGER_MAX_MS, STAGGER_GROWTH_MS,
 replyCadencePlan,
} = cadence;

// --- A: the plan ------------------------------------------------------------

test('an un-addressed post in a social channel settles inside the band', () => {
  // Every key must land in [SETTLE_MIN, SETTLE_MAX] — a delay outside the band
  // is either an autoresponder or a channel that looks dead.
  for (let i = 0; i < 500; i++) {
    const plan = replyCadencePlan({ conversationMode: 'social', jitterKey: `msg-${i}` });
    assert.equal(plan.reason, 'social_settle');
    assert.equal(plan.standDown, false);
    assert.ok(
      plan.delayMs >= SETTLE_MIN_MS && plan.delayMs <= SETTLE_MAX_MS,
      `key msg-${i} gave ${plan.delayMs}ms, outside ${SETTLE_MIN_MS}-${SETTLE_MAX_MS}`,
    );
  }
});

test('the jitter is spread, not a constant dressed up as one', () => {
  // A hash that collapsed to one value would still pass the band test above and
  // would make every reply land at exactly the same offset — metronomic, which is
  // the thing being fixed.
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    seen.add(replyCadencePlan({ conversationMode: 'social', jitterKey: `msg-${i}` }).delayMs);
  }
  assert.ok(seen.size > 100, `only ${seen.size} distinct delays across 500 keys`);
});

test('the same message always waits the same amount — re-entry must not re-roll', () => {
  // The dispatcher re-reads everything when it wakes. A fresh random draw each
  // pass would either compound the wait or reset it, and neither is a cadence.
  const first = replyCadencePlan({ conversationMode: 'social', jitterKey: 'stable-key' });
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(replyCadencePlan({ conversationMode: 'social', jitterKey: 'stable-key' }), first);
  }
});

test('time already elapsed is served, so a wake dispatches instead of waiting again', () => {
  const target = replyCadencePlan({ conversationMode: 'social', jitterKey: 'k' }).delayMs;
  assert.ok(target > 0);
  // Half the wait done => half remains.
  const half = replyCadencePlan({ conversationMode: 'social', jitterKey: 'k', elapsedMs: Math.floor(target / 2) });
  assert.equal(half.delayMs, target - Math.floor(target / 2));
  // The whole wait done => run now. This is what makes the wake terminate.
  assert.equal(replyCadencePlan({ conversationMode: 'social', jitterKey: 'k', elapsedMs: target }).delayMs, 0);
  assert.equal(replyCadencePlan({ conversationMode: 'social', jitterKey: 'k', elapsedMs: target + 5_000 }).delayMs, 0);
});

test('being named earns an immediate first answer; the pile behind it staggers', () => {
  // "@scout what do you reckon" is a question. It is answered now, even here.
  assert.deepEqual(
    replyCadencePlan({ conversationMode: 'social', addressedIndividually: true, jitterKey: 'k' }),
    { delayMs: 0, standDown: false, reason: 'immediate_addressed' },
  );
  // "@scout @coder @nova thoughts?" answers once at once, then twice unhurried,
  // instead of three times in the same second.
  const second = replyCadencePlan({ conversationMode: 'social', agentTurnsSoFar: 1, addressedIndividually: true, jitterKey: 'k' });
  assert.equal(second.reason, 'social_stagger');
  assert.ok(second.delayMs >= STAGGER_MIN_MS && second.delayMs <= STAGGER_MAX_MS, `${second.delayMs}ms`);
});

test('each later reply waits longer than the one before it', () => {
  // Same key, so only the turn index moves: the gaps must WIDEN. A room where
  // the fourth voice arrives as fast as the second still reads as a fan-out.
  const delays = [1, 2, 3, 4].map(
    (turns) => replyCadencePlan({ conversationMode: 'social', agentTurnsSoFar: turns, addressedIndividually: true, jitterKey: 'k' }).delayMs,
  );
  for (let i = 1; i < delays.length; i++) {
    assert.equal(delays[i] - delays[i - 1], STAGGER_GROWTH_MS, `turn ${i + 1} did not grow by ${STAGGER_GROWTH_MS}`);
  }
});

test('no reply is ever held longer than MAX_DELAY_MS', () => {
  // Growth is unbounded arithmetic; the clamp is what stops a long burst from
  // scheduling a reply minutes out, which a human would read as lost.
  for (const turns of [1, 3, 10, 50, 5_000]) {
    const plan = replyCadencePlan({ conversationMode: 'social', agentTurnsSoFar: turns, addressedIndividually: true, jitterKey: 'k' });
    assert.ok(plan.delayMs <= MAX_DELAY_MS, `turn ${turns} gave ${plan.delayMs}ms`);
  }
});

test('the chorus gate stands down un-named voices, and only un-named ones', () => {
  // Under the limit: answer, paced.
  for (let turns = 1; turns < BROADCAST_REPLY_LIMIT; turns++) {
    assert.equal(replyCadencePlan({ conversationMode: 'social', agentTurnsSoFar: turns, jitterKey: 'k' }).standDown, false);
  }
  // At and above it: stay quiet. This is the "four replies to a joke" fix.
  for (const turns of [BROADCAST_REPLY_LIMIT, BROADCAST_REPLY_LIMIT + 1, 8]) {
    const plan = replyCadencePlan({ conversationMode: 'social', agentTurnsSoFar: turns, jitterKey: 'k' });
    assert.equal(plan.standDown, true, `turn ${turns} should stand down`);
    assert.equal(plan.reason, 'social_pile_on');
  }
  // Being NAMED is never refused, however long the burst has run. Cadence
  // decides when someone speaks; it never overrules being asked.
  for (const turns of [BROADCAST_REPLY_LIMIT, BROADCAST_REPLY_LIMIT + 5, 20]) {
    assert.equal(
      replyCadencePlan({ conversationMode: 'social', agentTurnsSoFar: turns, addressedIndividually: true, jitterKey: 'k' }).standDown,
      false,
      `a named agent must still answer at turn ${turns}`,
    );
  }
});

test('a stand-down is the ONLY way cadence declines a turn', () => {
  // Everything else it returns is a delay. If a future edit ever starts dropping
  // turns some other way, this fails: a lost reply must be a deliberate election
  // with a name, not a side effect of timing.
  for (const input of cadence.PARITY_INPUTS) {
    const plan = replyCadencePlan(input);
    if (plan.standDown) {
      assert.equal(plan.reason, 'social_pile_on', `unexpected stand-down reason ${plan.reason}`);
      assert.equal(plan.delayMs, 0, 'a stood-down turn is not also scheduled');
    } else {
      assert.ok(Number.isFinite(plan.delayMs) && plan.delayMs >= 0, `bad delay ${plan.delayMs}`);
    }
  }
});

// --- B: nothing else is slowed ----------------------------------------------

test('a DM is never paced, whatever its mode or folder says', () => {
  // Task dispatch, comment @mentions and the whole agent-DM path run through
  // here. A held turn there would be a latency bug in the busiest lane, and the
  // task queue would have read the deferral as a refusal.
  for (const conversationMode of ['auto', 'social', 'mention', 'nonsense', null]) {
    for (const folder of ['Direct messages', 'Channels', 'huddle', '']) {
      for (const turns of [0, 1, 5]) {
        const plan = replyCadencePlan({ conversationMode, folder, isDirectMessage: true, agentTurnsSoFar: turns, jitterKey: 'k' });
        assert.deepEqual(plan, { delayMs: 0, standDown: false, reason: 'immediate_dm' });
      }
    }
  }
});

test('a huddle transcript is never paced — voice latency is the whole point', () => {
  // server/huddles.cjs already creates the transcript session on 'mention' (see
  // tests/huddle-transcript-mode.test.cjs) so nothing speaks unprompted in a live
  // call. This is the belt: even if that mode is ever changed, folder='huddle'
  // keeps cadence out of the voice path.
  for (const conversationMode of ['auto', 'social', 'mention']) {
    for (const turns of [0, 1, 4]) {
      const plan = replyCadencePlan({ conversationMode, folder: 'huddle', agentTurnsSoFar: turns, jitterKey: 'k' });
      assert.deepEqual(plan, { delayMs: 0, standDown: false, reason: 'immediate_huddle' });
    }
  }
});

test("a work channel — 'auto' or 'mention' — is bit-for-bit as immediate as before", () => {
  // Cadence is one enum value wide. Every other value, including junk and
  // absent, answers now: no existing channel changed behaviour.
  for (const conversationMode of ['auto', 'mention', 'nonsense', '', null, undefined, 0, {}, 'socialise', 'Social ']) {
    for (const turns of [0, 1, 2, 9]) {
      for (const addressedIndividually of [true, false]) {
        const plan = replyCadencePlan({ conversationMode, agentTurnsSoFar: turns, addressedIndividually, jitterKey: 'k' });
        if (mentions.normalizeConversationMode(conversationMode) === 'social') continue; // ' social ' trims to social
        assert.equal(plan.delayMs, 0, `${JSON.stringify(conversationMode)} turn ${turns} was delayed`);
        assert.equal(plan.standDown, false, `${JSON.stringify(conversationMode)} turn ${turns} stood down`);
        assert.equal(plan.reason, 'immediate_mode');
      }
    }
  }
});

test('only one conversation_mode value can pace anything', () => {
  // Asserted over the whole enum rather than by inspection, so a fourth value
  // added later cannot quietly inherit pacing.
  const paced = mentions.CONVERSATION_MODES.filter(
    (mode) => replyCadencePlan({ conversationMode: mode, jitterKey: 'k' }).delayMs > 0,
  );
  assert.deepEqual(paced, [cadence.SOCIAL_CONVERSATION_MODE]);
});

// --- C: the wake is booked, not dropped -------------------------------------

test('a held turn books exactly one wake per conversation', async () => {
  __test.clearCadenceWakes();
  const key = 'session-1::';
  assert.equal(__test.scheduleCadenceWake(key, 50_000, { workspaceId: 'w', sessionId: 'session-1', threadParentId: null }), true);
  assert.equal(__test.cadenceWakes.size, 1);
  // A second booking is REFUSED rather than replacing the first. Pushing the wake
  // back on every attempt is how a busy channel would starve a reply forever.
  assert.equal(__test.scheduleCadenceWake(key, 50_000, { workspaceId: 'w', sessionId: 'session-1', threadParentId: null }), false);
  assert.equal(__test.cadenceWakes.size, 1);
  // A different thread of the same session is a different conversation.
  assert.equal(__test.scheduleCadenceWake('session-1::msg-9', 50_000, { workspaceId: 'w', sessionId: 'session-1', threadParentId: 'msg-9' }), true);
  assert.equal(__test.cadenceWakes.size, 2);
  __test.clearCadenceWakes();
  assert.equal(__test.cadenceWakes.size, 0);
});

test('the wake fires and re-drives the conversation', async () => {
  // The delay must live on the SERVER, not in a browser: the reply has to arrive
  // whether or not the tab that posted is still open. Proven by letting a wake
  // fire with no client involved at all.
  __test.resetTestState();
  // An empty DB, so the re-drive reaches continueConversation and bails at
  // 'no_session' instead of trying to open a real connection.
  const seen = [];
  __test.setTestDb({ async unsafe(sql, params) { seen.push([String(sql), params]); return []; } });
  const key = 'session-2::';
  __test.scheduleCadenceWake(key, 5, { workspaceId: 'w', sessionId: 'session-2', threadParentId: null });
  await new Promise((resolve) => setTimeout(resolve, 40));
  // Fired => de-registered, so the next turn of the burst can book its own.
  assert.equal(__test.cadenceWakes.has(key), false);
  // ...and it really re-read the conversation rather than just clearing a timer.
  assert.ok(
    seen.some(([sql, params]) => /from chat_sessions where id = \$1/.test(sql) && params?.[0] === 'session-2'),
    'the wake must re-drive continueConversation, which re-reads the session',
  );
  __test.resetTestState();
});

test('resetTestState clears pending wakes so suites cannot bleed into each other', () => {
  __test.scheduleCadenceWake('session-3::', 60_000, { workspaceId: 'w', sessionId: 'session-3', threadParentId: null });
  assert.equal(__test.cadenceWakes.size, 1);
  __test.resetTestState();
  assert.equal(__test.cadenceWakes.size, 0);
});

test('a deferred turn is requeued by the task queue, never reported as a failure', () => {
  // Unreachable today (task work is a DM, and a DM is immediate), but if a task
  // is ever dispatched into a social channel the queue must read "the agent will
  // get to it", not "could not start".
  for (const reason of ['cadence_deferred', 'cadence_stand_down']) {
    assert.ok(__test.TASK_QUEUE_BUSY_RUN_REASONS.has(reason), `${reason} must count as busy`);
  }
});

// --- naming: what counts as being addressed ---------------------------------

test('being named counts; being included in @channel does not', () => {
  const scout = { id: 'a1', name: 'Scout', handle: 'scout' };
  const named = (content) => __test.agentNamedInBurst(scout, [{ content }]);
  assert.equal(named('@scout can you look'), true);
  assert.equal(named('hey @Scout'), true, 'case-folded through slugHandle');
  assert.equal(named('@channel anyone about?'), false, 'a broadcast is not being named');
  assert.equal(named('anyone about?'), false);
  assert.equal(named('mail me at jason@scout.com'), false, 'an email is not a mention');
  // The distinction is the whole feature: @channel is paced, @scout is not.
  assert.equal(
    replyCadencePlan({ conversationMode: 'social', addressedIndividually: named('@channel anyone?'), jitterKey: 'k' }).reason,
    'social_settle',
  );
  assert.equal(
    replyCadencePlan({ conversationMode: 'social', addressedIndividually: named('@scout anyone?'), jitterKey: 'k' }).reason,
    'immediate_addressed',
  );
});

test('a name matched anywhere in the burst counts, not just in the last message', () => {
  const coder = { id: 'a2', name: 'Coder', handle: 'coder' };
  assert.equal(
    __test.agentNamedInBurst(coder, [{ content: '@coder take a look' }, { content: 'on it' }]),
    true,
  );
  assert.equal(__test.agentNamedInBurst(coder, []), false);
  assert.equal(__test.agentNamedInBurst(null, [{ content: '@coder' }]), false);
});

test('msSinceTimestamp is 0 for anything unreadable, never NaN', () => {
  // A NaN elapsed would poison the subtraction and clamp to 0 — a social channel
  // that silently stopped pacing. Answered here rather than discovered later.
  for (const value of [null, undefined, '', 'not-a-date', {}, 0]) {
    assert.equal(__test.msSinceTimestamp(value), 0, `${JSON.stringify(value)}`);
  }
  assert.ok(__test.msSinceTimestamp(new Date(Date.now() - 5_000).toISOString()) >= 4_500);
  assert.equal(__test.msSinceTimestamp(new Date(Date.now() + 60_000).toISOString()), 0, 'a future stamp is not a negative wait');
});

// --- D: the third mode is wired everywhere ----------------------------------

test("'social' is answerable — adding a value must not silence the channels that adopt it", () => {
  // The trap this catches: allowsUnpromptedReply used to ask `=== 'auto'`. With
  // that phrasing, a channel switched to 'social' would dispatch NOBODY — no
  // error, no log, an agent that simply never speaks again.
  assert.equal(mentions.allowsUnpromptedReply({ conversationMode: 'social' }), true);
  assert.equal(mentions.allowsUnpromptedReply({ conversationMode: 'auto' }), true);
  assert.equal(mentions.allowsUnpromptedReply({ conversationMode: 'mention' }), false);
  assert.equal(mentions.allowsUnpromptedReply({}), true, 'the default answers');
  // Every mode except the one that means silence.
  for (const mode of mentions.CONVERSATION_MODES) {
    assert.equal(
      mentions.allowsUnpromptedReply({ conversationMode: mode }),
      mode !== 'mention',
      `${mode} eagerness`,
    );
  }
});

test("'social' survives normalization and junk still reads as 'auto'", () => {
  assert.equal(mentions.normalizeConversationMode('social'), 'social');
  assert.equal(mentions.normalizeConversationMode('SOCIAL'), 'social');
  assert.equal(mentions.normalizeConversationMode('  social '), 'social');
  assert.equal(mentions.normalizeConversationMode('sociable'), 'auto');
  assert.equal(mentions.DEFAULT_CONVERSATION_MODE, 'auto', 'the default must not move');
});

test('the dispatcher consults cadence at the point a turn starts', () => {
  // Source-contract, like tests/huddle-transcript-mode.test.cjs: continueConversation
  // is not exported in a shape a mock DB can drive to this branch, and the thing
  // worth pinning is the ORDER — after the busy check, before runAgentTurn, with
  // the message this reply answers as the jitter seed.
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const gate = source.indexOf('const cadence = replyCadencePlan({');
  assert.ok(gate > 0, 'continueConversation must call replyCadencePlan');
  const busy = source.indexOf('hasActiveBurstJob(sessionId, nextAgent.id)');
  const run = source.indexOf('const result = await runAgentTurn(nextAgent,');
  assert.ok(busy > 0 && run > 0);
  assert.ok(busy < gate, 'cadence must be asked AFTER the busy check — never book a turn that cannot run');
  assert.ok(gate < run, 'cadence must be asked BEFORE the turn goes in flight');
  // The seed is the message being answered, so the wait is stable under re-entry.
  assert.match(source, /const cadenceRef = agentTurns === 0 \? burst\[0\] : latest;/);
  // Held, not dropped.
  assert.match(source, /scheduleCadenceWake\(lockKey, cadence\.delayMs,/);
});

test('cadenceWakes is written from exactly one place', () => {
  // If a second writer appears, the "one wake per conversation" guarantee above
  // stops being a guarantee, and a reply can be scheduled twice.
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const sets = source.match(/cadenceWakes\.set\(/g) || [];
  assert.equal(sets.length, 1, `cadenceWakes.set appears ${sets.length} times`);
  const calls = source.match(/scheduleCadenceWake\(/g) || [];
  // The definition (server/task-dispatch.cjs, Wave 4), the ONE call site in
  // continueConversation, and index.cjs's destructure of the module.
  assert.equal(calls.length, 2, `expected the definition and ONE call site, found ${calls.length}`);
});

// --- the parity fixture -----------------------------------------------------

test('the cadence answers are pinned, and the TS copy must match them', () => {
  // The literal snapshot. tests/unit/replyCadence.test.ts runs the same fixture
  // through src/lib/replyCadence.ts; if the two drift, the dialog quotes a timing
  // the dispatcher does not keep, which nobody would ever notice by looking.
  const answers = cadence.parityAnswers(cadence);
  assert.equal(answers.plans.length, cadence.PARITY_INPUTS.length);
  assert.equal(answers.hints.length, cadence.HINT_INPUTS.length);
  assert.deepEqual(answers.plans.slice(0, 12), [
    { delayMs: 0, standDown: false, reason: 'immediate_mode' },   // {}
    { delayMs: 0, standDown: false, reason: 'immediate_mode' },   // auto
    { delayMs: 0, standDown: false, reason: 'immediate_mode' },   // mention
    { delayMs: 3999, standDown: false, reason: 'social_settle' }, // social
    { delayMs: 0, standDown: false, reason: 'immediate_mode' },   // nonsense
    { delayMs: 0, standDown: false, reason: 'immediate_mode' },   // null
    { delayMs: 3999, standDown: false, reason: 'social_settle' }, // 'SOCIAL'
    { delayMs: 3999, standDown: false, reason: 'social_settle' }, // ' social '
    { delayMs: 0, standDown: false, reason: 'immediate_dm' },
    { delayMs: 0, standDown: false, reason: 'immediate_huddle' },
    // folder alone is NOT a DM: continueConversation decides that (it also counts
    // the legacy 'Direct messages' folder) and passes isDirectMessage in.
    { delayMs: 3999, standDown: false, reason: 'social_settle' },
    { delayMs: 0, standDown: false, reason: 'immediate_addressed' },
  ]);
  assert.equal(answers.summary, cadence.socialCadenceSummary());
});

test('the intent hint suggests, and is honest about which phrase it saw', () => {
  // The owner's own example intent.
  const hint = cadence.socialCadenceHint(
    "A fun place to share stuff that's not work related and interact with each other, joking is fine, clean language",
  );
  assert.deepEqual(hint, { social: true, phrase: 'not work related' });
  // A work channel is left alone. A hint that fired on everything would be a
  // guess dressed as a suggestion.
  assert.deepEqual(
    cadence.socialCadenceHint('Incident response. Terse, factual, no speculation.'),
    { social: false, phrase: '' },
  );
  for (const value of ['', '   ', null, undefined]) {
    assert.deepEqual(cadence.socialCadenceHint(value), { social: false, phrase: '' });
  }
  assert.equal(cadence.socialCadenceHint('WATERCOOLER').social, true, 'case-insensitive');
});

test('the hint never governs dispatch — only the stored mode does', () => {
  // The load-bearing claim about deriving anything from prose: an intent that
  // screams "watercooler" changes NOTHING until the operator changes the mode.
  const social = "not work related, joking is fine";
  assert.equal(cadence.socialCadenceHint(social).social, true);
  assert.equal(
    replyCadencePlan({ conversationMode: 'auto', jitterKey: 'k' }).delayMs,
    0,
    'prose must not pace a channel the operator left on auto',
  );
  // And it is not reachable from the dispatcher at all.
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  assert.doesNotMatch(source, /socialCadenceHint/, 'the server must never read the prose hint');
});

test('the editor quotes the real numbers, generated from the real constants', () => {
  // A dialog that hardcoded "a few seconds" would keep saying it after someone
  // changed the band. The summary is built from the constants, so it cannot.
  const summary = cadence.socialCadenceSummary();
  assert.match(summary, new RegExp(`${SETTLE_MIN_MS / 1000}-${SETTLE_MAX_MS / 1000}s`));
  assert.match(summary, new RegExp(`${STAGGER_MIN_MS / 1000}-${STAGGER_MAX_MS / 1000}s`));
  assert.match(summary, new RegExp(`at most ${BROADCAST_REPLY_LIMIT}`));
  // One line, so the social option does not tower over its two peers.
  assert.ok(summary.length <= 120, `summary is ${summary.length} chars — too long for a choice detail`);
  const dialog = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'chat', 'EditChannelDialog.tsx'), 'utf8',
  );
  assert.match(dialog, /detail: socialCadenceSummary\(\)/, 'the social option must quote the generated summary');
  assert.match(dialog, /mode: 'social'/, 'the operator needs a control for it — a mode nothing can set is not a setting');
});

test('the MCP create_channel tool offers the third mode too', () => {
  // "Wired into one lane, missing from the other" is this repo's most repeated
  // bug. An agent creating a social room through MCP must be able to say so.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'mcp.cjs'), 'utf8');
  assert.match(source, /enum: \['mention', 'social', 'auto'\]/);
});

test('no DDL was needed, and the schema says why', () => {
  // conversation_mode is unconstrained text normalized in shared code, so a third
  // value is not a schema change. Asserted so nobody "fixes" it into a CHECK
  // constraint that would reject 'social' on a fresh DB and pass on ours.
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'neon-schema.sql'), 'utf8');
  assert.match(schema, /conversation_mode text NOT NULL DEFAULT 'auto',/);
  assert.doesNotMatch(schema, /conversation_mode[^\n]*CHECK/i, 'a CHECK here would have needed a migration');
  assert.match(schema, /'social'/, 'the canonical schema should document the values');
});
