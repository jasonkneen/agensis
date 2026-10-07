import { useEffect } from 'react';
import { playInterfaceSound } from '@/lib/interfaceSound';

const CONTROL = 'button, [role=button], [role=switch], [role=checkbox]';
const OPT_OUT = ':disabled, [aria-disabled=true], [data-sound=off]';

/** Plays a soft tap for real user clicks on controls. Mount once. */
export function InterfaceSound() {
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const control = event.target.closest(CONTROL);
      if (!control || control.matches(OPT_OUT)) return;
      void playInterfaceSound(control.getAttribute('aria-checked') === 'true' ? 'toggleOn' : 'tap');
    };
    document.addEventListener('click', click);
    return () => document.removeEventListener('click', click);
  }, []);
  return null;
}
