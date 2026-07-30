// One definition of the message composer's shape, shared by the main chat
// composer, the thread panel and the sub-thread panel.
//
// These three drifted apart because each carried its own literals: the thread
// panel's control row was `min-h-10` while the other two were `min-h-9`, the two
// side panels had no textarea padding at all where the main composer had
// `px-3 py-2 text-sm leading-relaxed`, and the panels capped growth at
// `max-h-24` against the main composer's `max-h-28`. The visible result was
// three inputs that never lined up on the same horizontal rules and had
// different internal spacing.
//
// Change these here, not at a call site.

/**
 * The textarea itself: growth range, padding and type scale.
 *
 * `field-sizing-fixed flex-none` is load-bearing, and the two only work as a
 * pair:
 *
 * - The base `Textarea` primitive sets `field-sizing-content`, and a
 *   field-sizing box with an EMPTY value is sized by its PLACEHOLDER. The
 *   channel composer's placeholder carried the whole channel title plus a list
 *   of mention affordances, so it wrapped to two lines and left that composer
 *   ~5px taller than the thread panel's one-line sibling next to it, with the
 *   two control rows ~4px off the same baseline. `field-sizing-fixed` takes the
 *   placeholder out of the height calculation entirely.
 * - `InputGroupTextarea` also sets `flex-1`, i.e. `flex-basis: 0%`, which
 *   OUTRANKS the `height` `autosizeComposer` writes — with the content-based
 *   sizing gone the box would then be stuck one row tall forever, ignoring
 *   every inline height. `flex-none` restores `flex-basis: auto` so the
 *   measured height applies.
 *
 * Net: height comes from `min-h-12` and `autosizeComposer` only — what the user
 * typed decides it, the placeholder never does.
 */
export const COMPOSER_TEXTAREA_CLASS = 'field-sizing-fixed flex-none max-h-28 min-h-12 px-3 py-2 text-sm leading-relaxed';

/** The control row beneath the textarea (model selector, send, attachments). */
export const COMPOSER_ADDON_CLASS = 'min-h-10 justify-between gap-2 border-t px-2 py-1.5';

/**
 * The bar the composer sits in, at the bottom of a channel / thread / sub-thread
 * panel. Shared because the thread panel's `p-3` against the other two's `p-2`
 * pushed its whole composer 4px off the channel composer's baseline whenever
 * the two were open side by side.
 */
export const COMPOSER_SHELL_CLASS = 'channel-composer border-t border-border p-2';

/**
 * Autosize ceiling in px. MUST match the `max-h-*` in COMPOSER_TEXTAREA_CLASS —
 * `max-h-28` is 7rem = 112px. The two used to disagree: every composer's
 * onInput handler clamped scrollHeight to a hardcoded 96 while the main
 * composer's CSS allowed 112, so the textarea stopped growing 16px early and
 * the last line sat under the fold.
 */
export const COMPOSER_MAX_HEIGHT_PX = 112;

/**
 * Grow a composer textarea to fit its content, up to COMPOSER_MAX_HEIGHT_PX.
 * Shared so the JS ceiling cannot drift away from the CSS one again.
 */
export function autosizeComposer(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
}
