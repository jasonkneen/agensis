'use strict';

// ---------------------------------------------------------------------------
// REPLY CADENCE — how quickly a room answers, and how many voices answer at all.
//
// THE PROBLEM. Post something casual in a channel with four agents and four
// replies land in the same second. In #incidents that reads as responsiveness.
// In #watercooler it reads as machinery: nobody in a real room answers a joke in
// 400ms, and nobody answers it four times at once.
//
// WHERE THE SIGNAL COMES FROM. chat_sessions.conversation_mode, which already
// exists and already means "how eagerly does this room answer a post nobody
// addressed". It gains a THIRD value rather than a second column, because the
// three values are one ordinal axis:
//
//   'mention'  nobody answers unprompted. Silence is fine.
//   'social'   somebody answers unprompted, unhurried — this file.
//   'auto'     somebody answers unprompted, immediately. Still the default.
//
// A separate `reply_cadence` column would have multiplied into states with no
// meaning ('mention' + paced = paced silence) and given the operator two
// controls for one question. `@channel` already chose to reuse this column
// rather than invent one; so does this.
//
// The channel INTENT is deliberately NOT the signal. It is free prose — the
// owner's example reads "A fun place to share stuff that's not work related and
// interact with each other, joking is fine, clean language" — and keyword-
// matching prose to decide whether paid model turns are delayed is a guess that
// silently governs behaviour. `socialCadenceHint` below reads that prose and
// SUGGESTS the mode in the editor, where a human accepts or ignores it. A hint
// in a dialog is reversible; a guess in a dispatcher is not.
//
// WHAT "NATURAL" MEANS MECHANICALLY. Three things, in this order:
//
//   1. SETTLE. The first reply to a post nobody named waits a few seconds. This
//      is the one that stops it reading as an autoresponder.
//   2. STAGGER. Each later reply in the same burst waits again, and waits a
//      little longer than the one before — the eager voice answers first and the
//      others drift in, which is what a room of people sounds like.
//   3. STAND DOWN. After BROADCAST_REPLY_LIMIT voices have answered a message
//      that named nobody in particular, the rest stay quiet. This is the part
//      the owner actually asked for: a casual remark gets a couple of answers,
//      not one per agent. It is an ELECTION, not a drop — every agent that stood
//      down is still @mentionable, and being named individually is never capped
//      or silenced.
//
// The jitter is DERIVED FROM THE MESSAGE ID, not from Math.random. That makes
// the whole thing a pure function of the conversation — testable to the
// millisecond — and it makes the wait STABLE across re-entry: the dispatcher
// re-reads everything each time it is woken, and a fresh random draw on every
// pass would either compound the wait or reset it.
//
// WHAT IS NEVER PACED. A DM, a huddle transcript, and any channel not on
// 'social'. Those return delayMs 0 before anything else is considered, so a
// work channel, a 1:1 and a live voice call cannot be slowed by this file.
// ---------------------------------------------------------------------------

const { normalizeConversationMode } = require('./channelMentions.cjs');

/** The conversation_mode that turns cadence on. */
const SOCIAL_CONVERSATION_MODE = 'social';

/**
 * The first reply to an un-addressed post lands somewhere in this band, measured
 * from the human's message — not from when the dispatcher happened to wake.
 * Floor is 3s because under that it still reads as a machine answering; ceiling
 * is 9s because over that a person wonders whether anyone is there.
 */
const SETTLE_MIN_MS = 3_000;
const SETTLE_MAX_MS = 9_000;

/**
 * Each later reply in the same burst waits this long after the message before
 * it, plus GROWTH per reply already taken — so the gaps widen instead of
 * marching. Measured from the previous message, so an agent turn that itself
 * took 8s has already served its stagger.
 */
const STAGGER_MIN_MS = 4_000;
const STAGGER_MAX_MS = 10_000;
const STAGGER_GROWTH_MS = 3_000;

/** No single reply is ever held longer than this. Delayed is fine; forgotten is not. */
const MAX_DELAY_MS = 45_000;

/**
 * How many voices may answer one message that named nobody in particular.
 *
 * Two, because two is a conversation and four is a chorus. This is the only
 * place cadence decides WHETHER rather than WHEN, and it applies solely to
 * agents reached by `@channel` or elected unprompted — an agent named by handle
 * is never counted against it and never stood down.
 */
const BROADCAST_REPLY_LIMIT = 2;

/**
 * FNV-1a, 32-bit. Any stable string hash would do; this one is short, has no
 * dependencies and gives a well-spread low byte, which is all the jitter needs.
 */
function stableHash(value) {
 const text = String(value == null ? '' : value);
 let hash = 0x811c9dc5;
 for (let i = 0; i < text.length; i++) {
  hash ^= text.charCodeAt(i);
  // Math.imul keeps the multiply in 32 bits; `>>> 0` keeps it unsigned.
  hash = Math.imul(hash, 0x01000193) >>> 0;
 }
 return hash >>> 0;
}

/** A stable value in [min, max] for this key. Empty key => min (deterministic, never NaN). */
function jitteredMs(key, min, max) {
 const span = Math.max(0, max - min);
 if (span === 0) return min;
 return min + (stableHash(key) % (span + 1));
}

function clampDelay(value) {
 if (!Number.isFinite(value) || value <= 0) return 0;
 return Math.min(MAX_DELAY_MS, Math.round(value));
}

/**
 * When (and whether) this agent's turn should run.
 *
 * PURE. Every input is a value the dispatcher already has in hand, and the
 * answer is the same every time for the same conversation — which is the point:
 * timing that only exists inside a live dispatch loop cannot be reasoned about,
 * and this feature is entirely about feel.
 *
 * @param conversationMode      chat_sessions.conversation_mode.
 * @param isDirectMessage       true for a 1:1. Never paced.
 * @param folder                chat_sessions.folder. 'huddle' is never paced.
 * @param agentTurnsSoFar       agent messages already in this burst. 0 = first reply.
 * @param addressedIndividually was THIS agent named by handle (or answering in
 *                              its own thread)? `@channel` and an unprompted
 *                              election are NOT individual.
 * @param jitterKey             id of the message this reply answers — the seed
 *                              of the wait, so it does not change under re-entry.
 * @param elapsedMs             how long ago that message landed.
 *
 * @returns {{delayMs: number, standDown: boolean, reason: string}}
 *          `standDown` means do not run this turn at all; the agent can still be
 *          @mentioned. `delayMs > 0` means run it later — never instead.
 */
function replyCadencePlan({
 conversationMode,
 isDirectMessage = false,
 folder = '',
 agentTurnsSoFar = 0,
 addressedIndividually = false,
 jitterKey = '',
 elapsedMs = 0,
} = {}) {
 // A DM is a 1:1: there is no crowd to pace and no pile-on to suppress, and its
 // agent answering plain messages promptly is what makes it a DM. Checked FIRST
 // and independently of the mode, so a DM row carrying any mode value at all
 // (they are created with several) still answers immediately.
 if (isDirectMessage) return { delayMs: 0, standDown: false, reason: 'immediate_dm' };

 // A huddle transcript is a live voice call. server/huddles.cjs already creates
 // it on 'mention' precisely so nothing speaks unprompted there (a second agent
 // talking over the first was a real reported bug), so this is a belt: cadence
 // stays out of the voice path even if that mode is ever changed.
 if (String(folder || '') === 'huddle') return { delayMs: 0, standDown: false, reason: 'immediate_huddle' };

 // Every other channel — 'auto' and 'mention' alike — behaves exactly as it did
 // before this file existed. Cadence is opt-in, one enum value wide.
 if (normalizeConversationMode(conversationMode) !== SOCIAL_CONVERSATION_MODE) {
  return { delayMs: 0, standDown: false, reason: 'immediate_mode' };
 }

 const turns = Number.isFinite(Number(agentTurnsSoFar)) ? Math.max(0, Math.trunc(Number(agentTurnsSoFar))) : 0;
 const elapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : 0;

 // Being named is a question, and a question gets an answer. The FIRST reply to
 // "@scout what do you reckon" is immediate even here; the pile behind it still
 // spreads out, so "@scout @coder @nova thoughts?" answers at once and then
 // twice more, unhurried, instead of three times in one second.
 if (addressedIndividually && turns === 0) {
  return { delayMs: 0, standDown: false, reason: 'immediate_addressed' };
 }

 // The chorus gate. Only un-named voices are counted and only un-named voices
 // stand down — an @mention is never refused by cadence.
 if (!addressedIndividually && turns >= BROADCAST_REPLY_LIMIT) {
  return { delayMs: 0, standDown: true, reason: 'social_pile_on' };
 }

 if (turns === 0) {
  const target = jitteredMs(jitterKey, SETTLE_MIN_MS, SETTLE_MAX_MS);
  return { delayMs: clampDelay(target - elapsed), standDown: false, reason: 'social_settle' };
 }

 const target = jitteredMs(jitterKey, STAGGER_MIN_MS, STAGGER_MAX_MS) + (turns - 1) * STAGGER_GROWTH_MS;
 return { delayMs: clampDelay(Math.min(MAX_DELAY_MS, target) - elapsed), standDown: false, reason: 'social_stagger' };
}

// --- the operator-facing hint -----------------------------------------------

/**
 * Phrases in a channel's intent that suggest it is a social room.
 *
 * Deliberately shallow and deliberately non-authoritative. This never reaches
 * the dispatcher: it decides whether the Edit Channel dialog offers "this reads
 * like a social channel — want replies paced?", and a human answers. Prose is
 * the wrong thing to derive behaviour from and the right thing to derive a
 * suggestion from.
 */
const SOCIAL_INTENT_PHRASES = Object.freeze([
 'not work related',
 'not work-related',
 'non work related',
 'non-work',
 'nothing to do with work',
 'off topic',
 'off-topic',
 'water cooler',
 'watercooler',
 'small talk',
 'chit chat',
 'chit-chat',
 'chitchat',
 'banter',
 'joking',
 'jokes',
 'casual',
 'social',
 'hang out',
 'for fun',
 'just for fun',
 'fun place',
]);

/**
 * Whether this intent reads like a social room, and which phrase said so.
 * `{ social: false, phrase: '' }` when nothing matched — the caller shows
 * nothing rather than arguing with the operator.
 */
function socialCadenceHint(intent) {
 const text = String(intent == null ? '' : intent).toLowerCase();
 if (!text.trim()) return { social: false, phrase: '' };
 for (const phrase of SOCIAL_INTENT_PHRASES) {
  if (text.includes(phrase)) return { social: true, phrase };
 }
 return { social: false, phrase: '' };
}

/**
 * One sentence describing what 'social' actually does, DERIVED from the
 * constants above so the dialog cannot promise a timing the dispatcher does not
 * keep. The numbers in the UI and the numbers in the delay are the same numbers.
 *
 * Kept to one line on purpose: it is the detail line of a choice in a list of
 * three, and a four-line option beside two one-line ones reads as the important
 * one rather than as a peer. That the stood-down agents are still reachable is
 * said once, by the dialog's own footer, rather than twice here.
 */
function socialCadenceSummary() {
 return [
  `First reply after ${Math.round(SETTLE_MIN_MS / 1000)}-${Math.round(SETTLE_MAX_MS / 1000)}s,`,
  `any others ${Math.round(STAGGER_MIN_MS / 1000)}-${Math.round(STAGGER_MAX_MS / 1000)}s apart,`,
  `and at most ${BROADCAST_REPLY_LIMIT} answer a message that named nobody.`,
 ].join(' ');
}

// --- parity fixture ---------------------------------------------------------

/**
 * Inputs whose answers must be IDENTICAL in shared/replyCadence.cjs and
 * src/lib/replyCadence.ts.
 *
 * Same arrangement as channelMentions and channelIntent: shared/*.cjs is
 * CommonJS server code and nothing under src/ may pull it into the browser
 * bundle, so there are two implementations and this table is what stops them
 * drifting. The browser copy exists because the Edit Channel dialog quotes the
 * REAL timings — a dialog describing a cadence the dispatcher does not use is
 * how a setting ends up lying about itself.
 *
 * tests/reply-cadence.test.cjs pins this side's answers literally;
 * tests/unit/replyCadence.test.ts imports the TS module and asserts the same
 * table.
 */
const PARITY_INPUTS = [
 // nothing at all
 {},
 // the three modes, un-addressed, first reply
 { conversationMode: 'auto', jitterKey: 'm1' },
 { conversationMode: 'mention', jitterKey: 'm1' },
 { conversationMode: 'social', jitterKey: 'm1' },
 // unrecognised + missing modes must behave as 'auto' (immediate), never as paced
 { conversationMode: 'nonsense', jitterKey: 'm1' },
 { conversationMode: null, jitterKey: 'm1' },
 { conversationMode: 'SOCIAL', jitterKey: 'm1' },
 { conversationMode: ' social ', jitterKey: 'm1' },
 // never paced: DM, huddle
 { conversationMode: 'social', isDirectMessage: true, jitterKey: 'm1' },
 { conversationMode: 'social', folder: 'huddle', jitterKey: 'm1' },
 { conversationMode: 'social', folder: 'Direct messages', jitterKey: 'm1' },
 // named vs un-named, first reply
 { conversationMode: 'social', addressedIndividually: true, jitterKey: 'm1' },
 { conversationMode: 'social', addressedIndividually: false, jitterKey: 'm1' },
 // the stagger, and its growth
 { conversationMode: 'social', agentTurnsSoFar: 1, addressedIndividually: true, jitterKey: 'm2' },
 { conversationMode: 'social', agentTurnsSoFar: 2, addressedIndividually: true, jitterKey: 'm2' },
 { conversationMode: 'social', agentTurnsSoFar: 5, addressedIndividually: true, jitterKey: 'm2' },
 { conversationMode: 'social', agentTurnsSoFar: 40, addressedIndividually: true, jitterKey: 'm2' },
 // the chorus gate
 { conversationMode: 'social', agentTurnsSoFar: 1, addressedIndividually: false, jitterKey: 'm2' },
 { conversationMode: 'social', agentTurnsSoFar: 2, addressedIndividually: false, jitterKey: 'm2' },
 { conversationMode: 'social', agentTurnsSoFar: 9, addressedIndividually: false, jitterKey: 'm2' },
 // elapsed time already served
 { conversationMode: 'social', jitterKey: 'm1', elapsedMs: 1_000 },
 { conversationMode: 'social', jitterKey: 'm1', elapsedMs: 60_000 },
 { conversationMode: 'social', jitterKey: 'm1', elapsedMs: -5 },
 { conversationMode: 'social', jitterKey: 'm1', elapsedMs: Number.NaN },
 // jitter is a function of the key, so different keys give different waits
 { conversationMode: 'social', jitterKey: '' },
 { conversationMode: 'social', jitterKey: 'a' },
 { conversationMode: 'social', jitterKey: 'b' },
 { conversationMode: 'social', jitterKey: '11111111-2222-3333-4444-555555555555' },
 // junk turn counts
 { conversationMode: 'social', agentTurnsSoFar: -3, jitterKey: 'm1' },
 { conversationMode: 'social', agentTurnsSoFar: 1.7, addressedIndividually: true, jitterKey: 'm2' },
 { conversationMode: 'social', agentTurnsSoFar: Number.NaN, jitterKey: 'm1' },
];

/** Intents whose hint answer must match across both copies. */
const HINT_INPUTS = [
 '', '   ', null, undefined,
 'A fun place to share stuff that\'s not work related and interact with each other, joking is fine, clean language',
 'Incident response. Terse, factual, no speculation.',
 'WATERCOOLER',
 'Off-Topic anything goes',
 'Deploys and release coordination',
 'social',
 'antisocial behaviour reports',
];

/** Every decision's answer for every fixture input, as one comparable object. */
function parityAnswers(impl) {
 return {
  plans: PARITY_INPUTS.map((input) => impl.replyCadencePlan(input)),
  hints: HINT_INPUTS.map((intent) => impl.socialCadenceHint(intent)),
  summary: impl.socialCadenceSummary(),
 };
}

module.exports = {
 BROADCAST_REPLY_LIMIT,
 HINT_INPUTS,
 MAX_DELAY_MS,
 PARITY_INPUTS,
 SETTLE_MAX_MS,
 SETTLE_MIN_MS,
 SOCIAL_CONVERSATION_MODE,
 SOCIAL_INTENT_PHRASES,
 STAGGER_GROWTH_MS,
 STAGGER_MAX_MS,
 STAGGER_MIN_MS,
 parityAnswers,
 replyCadencePlan,
 socialCadenceHint,
 socialCadenceSummary,
 stableHash,
};
