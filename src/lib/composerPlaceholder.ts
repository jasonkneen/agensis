// The text shown in an empty message composer.
//
// This is not cosmetic. Every composer textarea is `field-sizing-content`, and
// a field-sizing box with no value is sized by its PLACEHOLDER — so a long
// placeholder physically makes the box taller than its sibling. The channel
// composer used to read
//
//   "Post in #<full channel title>... @agent, @ documents, # canvas groups"
//
// which, next to a thread panel's one-line "Reply in thread...", wrapped to two
// lines and left the two composers at different heights with their control rows
// on different baselines. `field-sizing-fixed` in COMPOSER_TEXTAREA_CLASS now
// stops the placeholder from driving height at all, and these keep it short
// enough to read at a glance regardless.
//
// The rule: name the destination, nothing else. The mention/slash/attachment
// affordances announce themselves (the `+` popover, the `@`/`/` pickers) — they
// do not need to be listed in a hint the user reads once and then never again.

/**
 * Longest name (channel title or agent name) allowed inside a placeholder.
 * Chosen to stay on one line in the narrowest panel the composer renders in
 * (the thread panel at its minimum width).
 */
export const COMPOSER_NAME_MAX_CHARS = 24;

/** Below this fraction of the budget, a word-boundary cut loses too much. */
const WORD_BOUNDARY_MIN_RATIO = 0.6;

/**
 * Collapse a name to a single short line: whitespace normalised, clipped on a
 * word boundary where that keeps most of the budget, ellipsised when clipped.
 *
 * Only spaces are break points. Breaking on `-` too would cut
 * "agensis-agent: state-dir --add-dir fix" to "…: state" — mid-phrase and
 * meaningless — where the space break gives the readable "agensis-agent…".
 */
export function truncateComposerName(name: string, max: number = COMPOSER_NAME_MAX_CHARS): string {
  const normalized = name.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;

  const hard = normalized.slice(0, max);
  const lastSpace = hard.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(max * WORD_BOUNDARY_MIN_RATIO) ? hard.slice(0, lastSpace) : hard;
  return `${cut.replace(/[\s\-–—:,.;/]+$/, '')}…`;
}

/** Placeholder for the main channel composer. */
export function channelComposerPlaceholder(channelTitle?: string | null): string {
  const title = truncateComposerName((channelTitle || '').replace(/^#+/, ''));
  return `Message #${title || 'general'}`;
}

/** Placeholder for the main composer when the session is a DM with one agent. */
export function directMessageComposerPlaceholder(agentName?: string | null): string {
  const name = truncateComposerName(agentName || '');
  return `Message ${name || 'agent'}`;
}

/** Placeholder for the thread panel composer. */
export const THREAD_COMPOSER_PLACEHOLDER = 'Reply in thread';

/** Placeholder for the sub-thread panel composer. */
export const SUB_THREAD_COMPOSER_PLACEHOLDER = 'Message in sub-thread';
