import { describe, expect, it } from 'vitest';
import {
  COMPOSER_MAX_HEIGHT_PX,
  COMPOSER_SHELL_CLASS,
  COMPOSER_TEXTAREA_CLASS,
  autosizeComposer,
} from '../../src/lib/composerStyles';

describe('COMPOSER_TEXTAREA_CLASS', () => {
  // These two are a pair and neither works alone. Dropping `field-sizing-fixed`
  // puts the placeholder back in charge of the resting height, which is what
  // left the channel composer taller than the thread composer beside it.
  // Dropping `flex-none` leaves `flex-1`'s `flex-basis: 0%` outranking the
  // height autosizeComposer writes — measured in the browser as an inline
  // `height: 79px` rendering at 45px — so the box silently stops growing as you
  // type. Either one alone is a regression; the failure is visual and silent,
  // hence a test.
  it('keeps field-sizing-fixed and flex-none together', () => {
    const classes = COMPOSER_TEXTAREA_CLASS.split(' ');
    expect(classes).toContain('field-sizing-fixed');
    expect(classes).toContain('flex-none');
  });

  it('still bounds growth at both ends', () => {
    const classes = COMPOSER_TEXTAREA_CLASS.split(' ');
    expect(classes).toContain('min-h-12');
    expect(classes).toContain('max-h-28');
  });
});

describe('COMPOSER_SHELL_CLASS', () => {
  it('carries one padding value for all three composers', () => {
    // The thread panel used p-3 where the channel and sub-thread used p-2,
    // which put its whole composer 4px off theirs whenever two were open side
    // by side. Layout classes (shrink-0) stay at the call site.
    expect(COMPOSER_SHELL_CLASS.split(' ')).toContain('p-2');
    expect(COMPOSER_SHELL_CLASS).not.toContain('p-3');
  });
});

describe('autosizeComposer', () => {
  function fakeTextarea(scrollHeight: number) {
    return { style: { height: '' }, scrollHeight } as unknown as HTMLTextAreaElement;
  }

  it('fits the content', () => {
    const el = fakeTextarea(79);
    autosizeComposer(el);
    expect(el.style.height).toBe('79px');
  });

  it('stops at the ceiling so the composer cannot eat its panel', () => {
    const el = fakeTextarea(4000);
    autosizeComposer(el);
    expect(el.style.height).toBe(`${COMPOSER_MAX_HEIGHT_PX}px`);
  });
});
