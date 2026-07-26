// ---------------------------------------------------------------------------
// tests/unit/replyCadence.test.ts
//
// The browser's cadence module must answer EXACTLY what the dispatcher's does.
//
// The two exist because shared/*.cjs is CommonJS server code and nothing under
// src/ may pull it into the bundle. The browser copy is what the Edit Channel
// dialog quotes — "the first reply lands 3-9 seconds later" — so a drift here is
// a setting that lies about itself: the dialog describes one cadence and the
// dispatcher keeps another, with nothing in between to notice.
//
// Both implementations are run over the fixture exported by the CJS side (the
// one the server uses), so the table cannot be edited on one side only.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  BROADCAST_REPLY_LIMIT, MAX_DELAY_MS,
  SETTLE_MAX_MS, SETTLE_MIN_MS,
  STAGGER_GROWTH_MS, STAGGER_MAX_MS, STAGGER_MIN_MS,
  SOCIAL_CONVERSATION_MODE, SOCIAL_INTENT_PHRASES,
  replyCadencePlan, socialCadenceHint, socialCadenceSummary, stableHash,
} from '../../src/lib/replyCadence';
import { CONVERSATION_MODES, allowsUnpromptedReply, normalizeConversationMode } from '../../src/lib/channelMentions';

const require_ = createRequire(import.meta.url);
const shared = require_('../../shared/replyCadence.cjs');

const browser = {
  replyCadencePlan,
  socialCadenceHint,
  socialCadenceSummary,
};

describe('reply cadence parity', () => {
  it('answers identically to shared/replyCadence.cjs for every fixture input', () => {
    expect(shared.parityAnswers(browser)).toEqual(shared.parityAnswers(shared));
  });

  it('shares every constant, so the dialog and the delay are the same numbers', () => {
    expect(SETTLE_MIN_MS).toBe(shared.SETTLE_MIN_MS);
    expect(SETTLE_MAX_MS).toBe(shared.SETTLE_MAX_MS);
    expect(STAGGER_MIN_MS).toBe(shared.STAGGER_MIN_MS);
    expect(STAGGER_MAX_MS).toBe(shared.STAGGER_MAX_MS);
    expect(STAGGER_GROWTH_MS).toBe(shared.STAGGER_GROWTH_MS);
    expect(MAX_DELAY_MS).toBe(shared.MAX_DELAY_MS);
    expect(BROADCAST_REPLY_LIMIT).toBe(shared.BROADCAST_REPLY_LIMIT);
    expect(SOCIAL_CONVERSATION_MODE).toBe(shared.SOCIAL_CONVERSATION_MODE);
    expect([...SOCIAL_INTENT_PHRASES]).toEqual([...shared.SOCIAL_INTENT_PHRASES]);
  });

  it('hashes identically — the jitter IS the hash, so a mismatch is a mismatch in timing', () => {
    for (const key of ['', 'a', 'b', 'msg-1', '11111111-2222-3333-4444-555555555555', 'ünïcøde']) {
      expect(stableHash(key)).toBe(shared.stableHash(key));
    }
  });
});

describe('what the cadence actually does', () => {
  it('settles the first reply to a post that named nobody', () => {
    const plan = replyCadencePlan({ conversationMode: 'social', jitterKey: 'msg-1' });
    expect(plan.reason).toBe('social_settle');
    expect(plan.standDown).toBe(false);
    expect(plan.delayMs).toBeGreaterThanOrEqual(SETTLE_MIN_MS);
    expect(plan.delayMs).toBeLessThanOrEqual(SETTLE_MAX_MS);
  });

  it('widens the gap for each later reply, up to the ceiling', () => {
    const at = (turns: number) => replyCadencePlan({
      conversationMode: 'social', agentTurnsSoFar: turns, addressedIndividually: true, jitterKey: 'k',
    }).delayMs;
    expect(at(2) - at(1)).toBe(STAGGER_GROWTH_MS);
    expect(at(3) - at(2)).toBe(STAGGER_GROWTH_MS);
    expect(at(500)).toBeLessThanOrEqual(MAX_DELAY_MS);
  });

  it('stands down the chorus but never someone who was named', () => {
    expect(replyCadencePlan({
      conversationMode: 'social', agentTurnsSoFar: BROADCAST_REPLY_LIMIT, jitterKey: 'k',
    })).toEqual({ delayMs: 0, standDown: true, reason: 'social_pile_on' });
    expect(replyCadencePlan({
      conversationMode: 'social', agentTurnsSoFar: BROADCAST_REPLY_LIMIT, addressedIndividually: true, jitterKey: 'k',
    }).standDown).toBe(false);
  });

  it('leaves DMs, huddles and every other mode immediate', () => {
    expect(replyCadencePlan({ conversationMode: 'social', isDirectMessage: true }).delayMs).toBe(0);
    expect(replyCadencePlan({ conversationMode: 'social', folder: 'huddle' }).delayMs).toBe(0);
    for (const mode of CONVERSATION_MODES) {
      if (mode === SOCIAL_CONVERSATION_MODE) continue;
      expect(replyCadencePlan({ conversationMode: mode, jitterKey: 'k' })).toEqual(
        { delayMs: 0, standDown: false, reason: 'immediate_mode' },
      );
    }
  });
});

describe('the third conversation_mode', () => {
  it('is answerable — a new value on this axis must not silence a channel', () => {
    // allowsUnpromptedReply used to ask `=== 'auto'`. Under that phrasing a
    // channel switched to 'social' would have dispatched nobody, silently: the
    // composer would not even make the request (useChat reads the same helper).
    expect(allowsUnpromptedReply({ conversationMode: 'social' })).toBe(true);
    expect(allowsUnpromptedReply({ conversationMode: 'mention' })).toBe(false);
    for (const mode of CONVERSATION_MODES) {
      expect(allowsUnpromptedReply({ conversationMode: mode })).toBe(mode !== 'mention');
    }
  });

  it('normalizes, and junk still lands on the default rather than on silence', () => {
    expect(normalizeConversationMode('social')).toBe('social');
    expect(normalizeConversationMode('SOCIAL')).toBe('social');
    expect(normalizeConversationMode(' social ')).toBe('social');
    for (const value of ['', null, undefined, 'sociable', 'paced', 0, {}]) {
      expect(normalizeConversationMode(value)).toBe('auto');
    }
  });
});

describe('the intent hint', () => {
  it("recognises the owner's own example intent, and says which phrase it saw", () => {
    expect(socialCadenceHint(
      "A fun place to share stuff that's not work related and interact with each other, joking is fine, clean language",
    )).toEqual({ social: true, phrase: 'not work related' });
  });

  it('leaves a work channel alone', () => {
    expect(socialCadenceHint('Deploy coordination. Terse, factual.')).toEqual({ social: false, phrase: '' });
    for (const value of ['', '   ', null, undefined]) {
      expect(socialCadenceHint(value)).toEqual({ social: false, phrase: '' });
    }
  });

  it('is a hint and nothing else — it cannot pace a channel by itself', () => {
    // The prose says watercooler; the stored mode says auto; the answer is
    // immediate. This is the whole reason the signal is the mode and not the text.
    expect(socialCadenceHint('watercooler banter').social).toBe(true);
    expect(replyCadencePlan({ conversationMode: 'auto', jitterKey: 'k' }).delayMs).toBe(0);
  });

  it('quotes the real timings in the sentence the dialog shows', () => {
    const summary = socialCadenceSummary();
    expect(summary).toContain(`${SETTLE_MIN_MS / 1000}-${SETTLE_MAX_MS / 1000}s`);
    expect(summary).toContain(`${STAGGER_MIN_MS / 1000}-${STAGGER_MAX_MS / 1000}s`);
    expect(summary).toContain(`at most ${BROADCAST_REPLY_LIMIT}`);
    expect(summary).toBe(shared.socialCadenceSummary());
  });
});
