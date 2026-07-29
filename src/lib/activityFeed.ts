// Presentation rules for the activity feed.
//
// The feed is a firehose — a busy agent writes a row every few seconds, so the
// window filled with a hundred equal-weight lines and the newest one was
// indistinguishable from the hundredth. These rules keep it short by default,
// fade the tail so the eye lands on the top, and let the reader pull the rest
// back by scrolling.
//
// Pure and dependency-free so the ramp and the window can be tested without
// mounting a scroll container.

/** Rows shown before the reader asks for more. */
export const ACTIVITY_PEEK_COUNT = 12;

/** How many of those rows carry the fade. */
export const ACTIVITY_FADE_TAIL = 5;

/** The faintest a faded row goes — never 0, or it reads as a rendering bug. */
export const ACTIVITY_MIN_OPACITY = 0.2;

/**
 * The slice to render.
 *
 * Expanded shows everything; collapsed shows the newest ACTIVITY_PEEK_COUNT.
 * The list is already newest-first, so this is a head, not a tail.
 */
export function takeActivityWindow<T>(events: readonly T[], expanded: boolean): T[] {
  return expanded ? [...events] : events.slice(0, ACTIVITY_PEEK_COUNT);
}

/** True when collapsing actually hid something — drives the "earlier" affordance. */
export function hasHiddenActivity(total: number, expanded: boolean): boolean {
  return !expanded && total > ACTIVITY_PEEK_COUNT;
}

/**
 * Opacity for the row at `index` (0 = newest) of a `visibleCount` window.
 *
 * Only the last ACTIVITY_FADE_TAIL rows fade, and only while collapsed —
 * expanding restores every row to full strength, which is what makes scrolling
 * feel like recovering them rather than merely reaching them.
 *
 * A short list never fades: with fewer rows than the tail the ramp would dim
 * the second item on screen, which looks broken rather than deliberate.
 */
export function activityRowOpacity(index: number, visibleCount: number, expanded: boolean): number {
  if (expanded) return 1;
  if (visibleCount <= ACTIVITY_FADE_TAIL) return 1;
  const fadeStart = visibleCount - ACTIVITY_FADE_TAIL;
  if (index < fadeStart) return 1;
  const depth = index - fadeStart + 1; // 1..ACTIVITY_FADE_TAIL
  const opacity = 1 - (1 - ACTIVITY_MIN_OPACITY) * (depth / ACTIVITY_FADE_TAIL);
  // Guard the ends against float drift so a row can never render at 0 or >1.
  return Math.min(1, Math.max(ACTIVITY_MIN_OPACITY, Number(opacity.toFixed(3))));
}

/**
 * Should this row play the enter animation?
 *
 * Only the newest row, and only when it is genuinely new to THIS view — not on
 * first paint (where every row would animate at once), and not when the same id
 * merely re-renders. `previousNewestId` of null means "nothing seen yet".
 */
export function shouldAnimateEntry(
  eventId: string,
  newestId: string | null,
  previousNewestId: string | null,
): boolean {
  if (!previousNewestId) return false;
  if (!newestId || eventId !== newestId) return false;
  return newestId !== previousNewestId;
}
