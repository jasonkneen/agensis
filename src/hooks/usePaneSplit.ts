import { useCallback, useEffect, useRef, useState } from 'react';
import { clampPaneSplit, type PaneSplitBounds } from '../lib/paneSplit';
import { pixelPreference } from '../lib/viewPreferences';
import { usePersistedPreference } from './usePersistedPreference';

// A draggable divider between two panes: the state, the persistence, the
// measurement and the pointer handling, once.
//
// The clamp is in lib/paneSplit.ts (pure, tested); this is the plumbing around
// it, which had been copied into every window that wanted a resizable pane.
// Three details are the reason this is worth sharing rather than re-typing:
//
//   1. THE STORED VALUE IS NEVER THE LAYOUT. `size` is re-derived from the
//      measured container on every render, so a window resize re-clamps and a
//      split stored for a big window cannot hide a pane in a small one. Nothing
//      is written back on resize, so growing the window returns the user's
//      actual choice.
//   2. STORAGE IS WRITTEN ONCE PER DRAG, on release. `usePersistedPreference`
//      writes through on every change and a drag changes sixty times a second,
//      so the live value is held in a draft until the pointer comes up.
//   3. `setPointerCapture` THROWS `NotFoundError` when the pointer is already
//      gone — verified in Chromium, and documented in useFidgetDrag. Unguarded
//      it aborts the gesture before any drag state exists. Capture is an
//      improvement (the drag survives leaving the strip), not a requirement.

/** Sanity ceiling on a stored pane size; the real clamp is the container. */
const PANE_SIZE_PREF = pixelPreference(4000);

/** How far one arrow-key press moves the divider, px. */
const KEY_STEP_PX = 24;

export interface PaneSplitOptions {
  /**
   * From `viewPreferenceKey(name, workspaceId)`. Null means "in memory only" —
   * the split still works, it just does not survive a reload.
   */
  preferenceKey: string | null;
  /**
   * The split container's flex direction. `column` stacks the panes and the
   * leading pane's size is its HEIGHT (drag tracks Y, Up/Down arrows); `row`
   * puts them side by side and the size is its WIDTH (drag tracks X,
   * Left/Right arrows).
   */
  direction: 'row' | 'column';
  bounds: PaneSplitBounds;
  /** Accessible name for the divider, e.g. "Resize file list". */
  label: string;
}

export interface PaneSplit {
  /** The leading pane's size in px, already clamped. Apply as width or height. */
  size: number;
  /** The container's measured size along the split axis; 0 until measured. */
  containerSize: number;
  /** Attach to the element the two panes share. Measured, not guessed. */
  containerRef: (node: HTMLElement | null) => void;
  /** Spread onto a `<button>` sitting on the seam. Styling stays with the caller. */
  dividerProps: {
    type: 'button';
    'aria-label': string;
    title: string;
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
    onDoubleClick: () => void;
  };
}

export function usePaneSplit({ preferenceKey, direction, bounds, label }: PaneSplitOptions): PaneSplit {
  const [stored, setStored] = usePersistedPreference(preferenceKey, PANE_SIZE_PREF, 0);
  // Non-null only while the divider is under the pointer.
  const [draft, setDraft] = useState<number | null>(null);
  const [containerSize, setContainerSize] = useState(0);
  const dragRef = useRef<{ origin: number; size: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  // A callback ref rather than an effect: a split pane mounts and unmounts with
  // the view mode and the empty states, so the measurement is tied to the node
  // existing rather than to a dependency list that has to predict every reason
  // it might not.
  const containerRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const read = () => (direction === 'column' ? node.clientHeight : node.clientWidth);
    const measure = () => setContainerSize(current => (current === read() ? current : read()));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observerRef.current = observer;
  }, [direction]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const size = clampPaneSplit(draft ?? stored, containerSize, bounds);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* drag works uncaptured */ }
    dragRef.current = { origin: direction === 'column' ? event.clientY : event.clientX, size };
    setDraft(size);
  }, [direction, size]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Unclamped on the way in: the clamp is applied on the way OUT, so dragging
    // past a floor and back again tracks the pointer instead of sticking.
    const position = direction === 'column' ? event.clientY : event.clientX;
    setDraft(drag.size + (position - drag.origin));
  }, [direction]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch { /* never captured, or the browser already dropped it */ }
    // Store the CLAMPED size, not the raw pointer distance.
    setStored(size);
    setDraft(null);
  }, [size, setStored]);

  // Keyboard parity: a drag-only control is unreachable without a pointer.
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const back = direction === 'column' ? 'ArrowUp' : 'ArrowLeft';
    const forward = direction === 'column' ? 'ArrowDown' : 'ArrowRight';
    const step = event.key === back ? -KEY_STEP_PX : event.key === forward ? KEY_STEP_PX : 0;
    if (!step) return;
    event.preventDefault();
    setStored(clampPaneSplit(size + step, containerSize, bounds));
  }, [direction, size, containerSize, bounds, setStored]);

  const onDoubleClick = useCallback(() => {
    setDraft(null);
    // 0 is the codec's "never dragged" value, so this restores the default ratio.
    setStored(0);
  }, [setStored]);

  return {
    size,
    containerSize,
    containerRef,
    dividerProps: {
      type: 'button',
      'aria-label': label,
      title: 'Drag to resize. Double-click to reset.',
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick,
    },
  };
}
