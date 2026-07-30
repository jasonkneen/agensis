// ---------------------------------------------------------------------------
// REPLY CADENCE (browser copy).
//
// DUPLICATED from shared/replyCadence.cjs, which the dispatcher uses to decide
// when — and whether — an agent's turn runs. They cannot be one file:
// shared/*.cjs is CommonJS server code and nothing under src/ may pull it into
// the browser bundle, the same arrangement as src/lib/channelMentions.ts and
// src/lib/channelProfile.ts.
//
// The browser needs this because the Edit Channel dialog quotes the REAL numbers
// and offers the REAL suggestion. A dialog that says "a few seconds apart" while
// the dispatcher waits a minute is a setting lying about itself, and nobody
// would ever catch it — so the copy is generated from the same constants, and
// tests/unit/replyCadence.test.ts runs both implementations over the shared
// PARITY_INPUTS table and fails if they disagree.
//
// Read the header of shared/replyCadence.cjs for WHY the signal is
// conversation_mode rather than a new column or the intent prose.
// ---------------------------------------------------------------------------

import { normalizeConversationMode } from './channelMentions';

/** The conversation_mode that turns cadence on. */
export const SOCIAL_CONVERSATION_MODE = 'social';

/** The first reply to an un-addressed post lands somewhere in this band. */
export const SETTLE_MIN_MS = 3_000;
export const SETTLE_MAX_MS = 9_000;

/** Each later reply waits this long again, plus GROWTH per reply already taken. */
export const STAGGER_MIN_MS = 4_000;
export const STAGGER_MAX_MS = 10_000;
export const STAGGER_GROWTH_MS = 3_000;

/** No single reply is ever held longer than this. Delayed is fine; forgotten is not. */
export const MAX_DELAY_MS = 45_000;

/** How many voices may answer one message that named nobody in particular. */
export const BROADCAST_REPLY_LIMIT = 2;

/** FNV-1a, 32-bit. Must match shared/replyCadence.cjs bit for bit. */
export function stableHash(value: unknown): number {
  const text = String(value == null ? '' : value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function jitteredMs(key: unknown, min: number, max: number): number {
  const span = Math.max(0, max - min);
  if (span === 0) return min;
  return min + (stableHash(key) % (span + 1));
}

function clampDelay(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_DELAY_MS, Math.round(value));
}

export interface ReplyCadenceInput {
  conversationMode?: unknown;
  isDirectMessage?: boolean;
  folder?: string;
  agentTurnsSoFar?: number;
  addressedIndividually?: boolean;
  jitterKey?: string;
  elapsedMs?: number;
}

export interface ReplyCadencePlan {
  /** How long to hold this turn. 0 = run now. Never a reason not to run it. */
  delayMs: number;
  /** Do not run this turn at all — the room already answered. Still @mentionable. */
  standDown: boolean;
  reason: string;
}

/** When (and whether) an agent's turn should run. See shared/replyCadence.cjs. */
export function replyCadencePlan({
  conversationMode,
  isDirectMessage = false,
  folder = '',
  agentTurnsSoFar = 0,
  addressedIndividually = false,
  jitterKey = '',
  elapsedMs = 0,
}: ReplyCadenceInput = {}): ReplyCadencePlan {
  if (isDirectMessage) return { delayMs: 0, standDown: false, reason: 'immediate_dm' };
  if (String(folder || '') === 'huddle') return { delayMs: 0, standDown: false, reason: 'immediate_huddle' };
  if (normalizeConversationMode(conversationMode) !== SOCIAL_CONVERSATION_MODE) {
    return { delayMs: 0, standDown: false, reason: 'immediate_mode' };
  }

  const turns = Number.isFinite(Number(agentTurnsSoFar)) ? Math.max(0, Math.trunc(Number(agentTurnsSoFar))) : 0;
  const elapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : 0;

  if (addressedIndividually && turns === 0) {
    return { delayMs: 0, standDown: false, reason: 'immediate_addressed' };
  }
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

/** Phrases in an intent that suggest a social room. A HINT — never authority. */
export const SOCIAL_INTENT_PHRASES: readonly string[] = [
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
];

/**
 * Whether this intent reads like a social room, and which phrase said so.
 *
 * Used ONLY to offer a suggestion in the Edit Channel dialog. It never governs
 * dispatch: the operator's stored conversation_mode does, and a suggestion the
 * operator ignored must leave the channel exactly as they set it.
 */
export function socialCadenceHint(intent: unknown): { social: boolean; phrase: string } {
  const text = String(intent == null ? '' : intent).toLowerCase();
  if (!text.trim()) return { social: false, phrase: '' };
  for (const phrase of SOCIAL_INTENT_PHRASES) {
    if (text.includes(phrase)) return { social: true, phrase };
  }
  return { social: false, phrase: '' };
}

/** One sentence describing what 'social' does, derived from the constants above. */
export function socialCadenceSummary(): string {
  return [
    `First reply after ${Math.round(SETTLE_MIN_MS / 1000)}-${Math.round(SETTLE_MAX_MS / 1000)}s,`,
    `any others ${Math.round(STAGGER_MIN_MS / 1000)}-${Math.round(STAGGER_MAX_MS / 1000)}s apart,`,
    `and at most ${BROADCAST_REPLY_LIMIT} answer a message that named nobody.`,
  ].join(' ');
}
