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

/** The textarea itself: growth range, padding and type scale. */
export const COMPOSER_TEXTAREA_CLASS = 'max-h-28 min-h-12 px-3 py-2 text-sm leading-relaxed';

/** The control row beneath the textarea (model selector, send, attachments). */
export const COMPOSER_ADDON_CLASS = 'min-h-10 justify-between gap-2 border-t px-2 py-1.5';

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
