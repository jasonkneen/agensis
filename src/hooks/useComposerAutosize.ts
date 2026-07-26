import { useEffect, type RefObject } from 'react';
import { autosizeComposer } from '@/lib/composerStyles';

/**
 * Keep a composer textarea's height in step with its value.
 *
 * Until the composers stopped being sized by their content (see
 * COMPOSER_TEXTAREA_CLASS), the inline height `autosizeComposer` writes was
 * inert — `flex-1`'s `flex-basis: 0%` outranked it and `field-sizing: content`
 * did all the growing, for free, whatever the value changed. Now that height is
 * an explicit measurement, something has to re-measure on every value change
 * and not just on `onInput`: a send clears the value through React state with
 * no input event, as does inserting a slash command or an @mention from the
 * picker. Without this the box keeps the height of the message you already
 * sent.
 */
export function useComposerAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useEffect(() => {
    if (ref.current) autosizeComposer(ref.current);
  }, [ref, value]);
}
