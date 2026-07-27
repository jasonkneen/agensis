import { useCallback, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// The plumbing behind a draggable divider: pointer capture, a keyboard
// equivalent, and double-click to reset.
//
// This exists because the app had FOUR hand-rolled copies of the same twenty
// lines (the inbox, Tenants, the Agents "Both" view, the Memory file browser)
// and they had already drifted: two of them called `setPointerCapture`
// unguarded, so a pointer released between dispatch and the handler threw
// NotFoundError and left the divider inert for that press — the exact bug
// useFidgetDrag documents and guards. One had a keyboard path; three did not.
//
// Two rules the call sites get for free:
//
//   1. CAPTURE IS AN IMPROVEMENT, NOT A REQUIREMENT. Without it the drag still
//      tracks the pointer inside the strip; with it, the drag survives leaving
//      the strip. So a throw from `setPointerCapture` must never abort the
//      gesture, and `releasePointerCapture` must tolerate a capture that was
//      never taken or that the browser already dropped.
//   2. THE CLAMP IS APPLIED ON THE WAY OUT, NOT ON THE WAY IN. `onPreview` gets
//      the raw pointer distance so that dragging past a floor and back again
//      tracks the hand instead of sticking at the floor; `onCommit` gets the
//      clamped value, so what is stored is always something the layout allows.
//
// Where the divider is ALLOWED to sit is not here — that is
// `clampSplitPrimary` in lib/splitPane.ts, which is pure and tested.
// ---------------------------------------------------------------------------

/** Which axis the divider moves along: `x` for a column split, `y` for a row split. */
export type SplitAxis = 'x' | 'y';

export interface SplitResizeOptions {
  axis: SplitAxis;
  /** The primary pane's size right now, px. A drag starts from here. */
  size: number;
  /** Whatever the layout allows, applied on commit. Identity by default. */
  clamp?: (value: number) => number;
  /** px per arrow-key press. */
  step?: number;
  /** Every pointer move, with the RAW (unclamped) size. Optional. */
  onPreview?: (raw: number) => void;
  /** Release, or an arrow key, with the CLAMPED size. */
  onCommit: (value: number) => void;
  /** Double-click on the divider. Omit to make double-click do nothing. */
  onReset?: () => void;
}

export interface SplitResizeHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

export interface SplitResize {
  /** Spread onto the grab strip. */
  handlers: SplitResizeHandlers;
  /** True between pointerdown and release — for keeping the hairline lit mid-drag. */
  dragging: boolean;
}

/** Arrow keys that move a divider on this axis, and which way they push it. */
function keyStep(axis: SplitAxis, key: string): number {
  if (axis === 'y') {
    if (key === 'ArrowUp') return -1;
    if (key === 'ArrowDown') return 1;
    return 0;
  }
  if (key === 'ArrowLeft') return -1;
  if (key === 'ArrowRight') return 1;
  return 0;
}

export function useSplitResize(options: SplitResizeOptions): SplitResize {
  // Read through a ref so the handlers keep a stable identity across renders
  // and still see the current size — a divider re-created on every frame of its
  // own drag is how a stale closure gets one.
  const latest = useRef(options);
  latest.current = options;

  const dragRef = useRef<{ pointerId: number; origin: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clampNow = useCallback((value: number) => {
    const clamp = latest.current.clamp;
    return clamp ? clamp(value) : Math.round(value);
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Left button / touch / pen. A right-click is a context menu.
    if (event.button !== 0) return;
    event.preventDefault();
    // THROWS NotFoundError when the pointer is already gone — see rule 1 above.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No capture; the drag below works regardless.
    }
    const { axis, size } = latest.current;
    dragRef.current = {
      pointerId: event.pointerId,
      origin: axis === 'y' ? event.clientY : event.clientX,
      size,
    };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const now = latest.current.axis === 'y' ? event.clientY : event.clientX;
    latest.current.onPreview?.(drag.size + (now - drag.origin));
  }, []);

  const finish = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Releasing a capture we never took, or one the browser already dropped.
    }
    // The CLAMPED size, not the raw pointer distance: `size` has already been
    // re-derived from the previews, so clamping it again is what gets stored.
    latest.current.onCommit(clampNow(latest.current.size));
  }, [clampNow]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const { axis, size, step } = latest.current;
    const direction = keyStep(axis, event.key);
    if (!direction) return;
    event.preventDefault();
    latest.current.onCommit(clampNow(size + direction * (step ?? 24)));
  }, [clampNow]);

  const onDoubleClick = useCallback(() => {
    latest.current.onReset?.();
  }, []);

  const handlers = useMemo(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onKeyDown,
      onDoubleClick,
    }),
    [onPointerDown, onPointerMove, finish, onKeyDown, onDoubleClick],
  );

  return { handlers, dragging };
}
