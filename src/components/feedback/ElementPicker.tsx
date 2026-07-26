import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MousePointerSquareDashed, X } from 'lucide-react';
import { describeElement, elementChipLabel, type ElementDescriptor } from '@/lib/feedbackElement';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Devtools-style element picker.
//
// The whole risk of this component is what it leaves behind. It has to swallow
// clicks while it is up (or picking a button would also press it) and then stop
// swallowing the instant it exits — a leaked capture-phase listener would make
// the entire app silently unclickable, with no error and nothing on screen to
// explain it. So:
//
//   - every listener is added and removed in ONE effect, with `capture: true`
//     on both sides (a capture listener removed without the flag is NOT
//     removed);
//   - the callbacks live in refs, so the effect body never re-runs and cannot
//     leave a stale registration behind;
//   - the highlight is `pointer-events: none` and the toolbar is marked
//     `data-feedback-ui`, so neither can ever be the thing you pick.
//
// It also cancels `dragstart` and `pointerdown`, because this app's windows,
// canvas objects and dock all start drags on pointerdown — without that, aiming
// at a window title bar would drag the window instead of selecting it.
// ---------------------------------------------------------------------------

interface ElementPickerProps {
  onPick: (descriptor: ElementDescriptor) => void;
  onDone: () => void;
  onCancel: () => void;
  /** Already-picked elements, so the toolbar can show progress. */
  picked: ElementDescriptor[];
  /** Refuses further picks at this many. */
  max: number;
}

export function ElementPicker({ onPick, onDone, onCancel, picked, max }: ElementPickerProps) {
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [label, setLabel] = useState('');
  const targetRef = useRef<Element | null>(null);

  // Refs so the listener effect can run exactly once. Re-running it on every
  // parent render would add/remove document-level capture listeners dozens of
  // times a second and is the easiest way to end up with a leaked one.
  const onPickRef = useRef(onPick);
  const onDoneRef = useRef(onDone);
  const onCancelRef = useRef(onCancel);
  const fullRef = useRef(false);
  onPickRef.current = onPick;
  onDoneRef.current = onDone;
  onCancelRef.current = onCancel;
  fullRef.current = picked.length >= max;

  useEffect(() => {
    const isOwnUi = (node: EventTarget | null) =>
      node instanceof Element && Boolean(node.closest('[data-feedback-ui]'));

    const paint = (element: Element) => {
      const box = element.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
      setLabel(elementChipLabel(describeElement(element)));
    };

    const handleMove = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || isOwnUi(target)) {
        targetRef.current = null;
        setRect(null);
        return;
      }
      targetRef.current = target;
      paint(target);
    };

    // The page scrolls under a fixed highlight, so re-measure rather than
    // leaving the box floating over the wrong thing.
    const handleReflow = () => {
      const target = targetRef.current;
      if (target && target.isConnected) paint(target);
      else setRect(null);
    };

    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof (event as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation === 'function') {
        (event as Event & { stopImmediatePropagation: () => void }).stopImmediatePropagation();
      }
    };

    // Our own toolbar must stay clickable, so it is exempt from every swallow.
    const handlePress = (event: Event) => {
      if (isOwnUi(event.target)) return;
      swallow(event);
    };

    const handleClick = (event: Event) => {
      if (isOwnUi(event.target)) return;
      swallow(event);
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (fullRef.current) return;
      onPickRef.current(describeElement(target));
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        swallow(event);
        onCancelRef.current();
        return;
      }
      if (event.key === 'Enter') {
        swallow(event);
        onDoneRef.current();
      }
    };

    document.addEventListener('pointermove', handleMove, true);
    document.addEventListener('pointerdown', handlePress, true);
    document.addEventListener('mousedown', handlePress, true);
    document.addEventListener('mouseup', handlePress, true);
    document.addEventListener('dragstart', handlePress, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', handleReflow, true);
    window.addEventListener('resize', handleReflow);

    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';

    return () => {
      // `capture: true` on removal too — without the flag these listeners are
      // never removed and the app stops accepting clicks for good.
      document.removeEventListener('pointermove', handleMove, true);
      document.removeEventListener('pointerdown', handlePress, true);
      document.removeEventListener('mousedown', handlePress, true);
      document.removeEventListener('mouseup', handlePress, true);
      document.removeEventListener('dragstart', handlePress, true);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', handleReflow, true);
      window.removeEventListener('resize', handleReflow);
      document.body.style.cursor = previousCursor;
    };
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {rect && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[var(--z-picker)] rounded-[3px] border-2 border-primary bg-primary/15"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        >
          <span
            className={cn(
              'absolute left-0 max-w-[min(28rem,80vw)] truncate rounded-sm bg-primary px-1.5 py-0.5 font-mono text-[10px] leading-4 text-primary-foreground',
              // Flip the caption below the box when there is no room above it.
              rect.top < 22 ? 'top-full mt-0.5' : 'bottom-full mb-0.5',
            )}
          >
            {label}
          </span>
        </div>
      )}

      <div
        data-feedback-ui
        className="fixed top-4 left-1/2 z-[var(--z-picker-hud)] flex -translate-x-1/2 items-center gap-2 rounded-xl border bg-popover/95 px-3 py-2 text-sm text-popover-foreground shadow-lg backdrop-blur"
      >
        <MousePointerSquareDashed className="size-4 shrink-0 text-primary" />
        <span className="text-xs">
          {picked.length >= max
            ? `${max} elements selected — that's the limit`
            : `Click an element to attach it${picked.length > 0 ? ` (${picked.length}/${max})` : ''}`}
        </span>
        <Button type="button" size="xs" onClick={onDone}>
          Done
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" onClick={onCancel} aria-label="Cancel element picker">
          <X />
        </Button>
      </div>
    </>,
    document.body,
  );
}
