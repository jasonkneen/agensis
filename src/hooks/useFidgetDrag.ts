import { useCallback, useEffect, useRef } from 'react';
import {
  DRAG_THRESHOLD_PX,
  FIDGET_SPRING,
  MAX_FRAME_SECONDS,
  isSpringAtRest,
  releaseVelocity,
  rubberBand,
  stepSpring,
  type SpringState,
} from '@/lib/fidgetSpring';

// ---------------------------------------------------------------------------
// Drag a card around, let go, watch it spring home.
//
// The physics is pure and lives in lib/fidgetSpring.ts; this is the plumbing:
// pointer capture, an rAF loop, and the transform.
//
// NOTHING HERE TOUCHES REACT STATE. A 60fps setState on a card in a grid of
// them would re-render the whole surface sixty times a second while someone
// fidgets — this repo has already paid for that lesson once with per-token
// re-renders. The transform is written straight to the node, so a drag costs
// zero renders and React never learns it happened.
//
// The card keeps its click: movement under DRAG_THRESHOLD_PX is a click and
// passes through untouched, and only a real drag suppresses it. A fidget must
// never be a mis-select — that would make the toy a hazard.
// ---------------------------------------------------------------------------

/** Ceiling on travel, px. About a third of a card: elastic, never colliding. */
const PULL_LIMIT_PX = 46;

interface FidgetHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

export interface FidgetDrag {
  /**
   * Spread onto EVERY card. One hook instance serves a whole grid: a pointer
   * can only drag one card at a time, and the element under the pointer comes
   * from the event itself, so there is no per-card state to keep. A second
   * simultaneous touch on another card is ignored rather than fought over —
   * two-finger fidgeting on two different cards is not a thing worth the
   * bookkeeping.
   */
  handlers: FidgetHandlers;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useFidgetDrag(): FidgetDrag {
  const nodeRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef(0);
  const springRef = useRef<{ x: SpringState; y: SpringState } | null>(null);
  const lastFrameRef = useRef(0);

  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    samples: { t: number; x: number; y: number }[];
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  // --- painting -------------------------------------------------------------

  const paint = useCallback((x: number, y: number) => {
    const node = nodeRef.current;
    if (!node) return;
    if (x === 0 && y === 0) {
      // Clear rather than write zeros: the card's hover lift is a Tailwind
      // transform class, and an inline transform — even an identity one —
      // outranks it, so a settled card would silently lose its hover.
      node.style.transform = '';
      node.style.willChange = '';
      node.style.transition = '';
      return;
    }
    node.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
  }, []);

  const stopAnimation = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    springRef.current = null;
  }, []);

  // --- the settle loop ------------------------------------------------------

  const tick = useCallback((now: number) => {
    const spring = springRef.current;
    if (!spring) return;
    // Clamp: a backgrounded tab returns one enormous dt, and integrating it
    // whole would fling the card off-screen instead of settling it.
    const dt = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - lastFrameRef.current) / 1000));
    lastFrameRef.current = now;

    const next = { x: stepSpring(spring.x, dt, FIDGET_SPRING), y: stepSpring(spring.y, dt, FIDGET_SPRING) };
    springRef.current = next;

    if (isSpringAtRest(next.x) && isSpringAtRest(next.y)) {
      stopAnimation();
      paint(0, 0);
      return;
    }
    paint(next.x.x, next.y.x);
    frameRef.current = requestAnimationFrame(tick);
  }, [paint, stopAnimation]);

  const release = useCallback((vx: number, vy: number, x: number, y: number) => {
    springRef.current = { x: { x, v: vx }, y: { x: y, v: vy } };
    lastFrameRef.current = performance.now();
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(tick);
  }, [tick]);

  // --- pointer handling -----------------------------------------------------

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Left button / touch / pen only: a right-click is a context menu, and a
    // middle-click drag belongs to the scroller.
    if (event.button !== 0 || prefersReducedMotion()) return;
    // A drag already in flight owns the loop; a second pointer is ignored.
    if (dragRef.current) return;
    stopAnimation();
    const node = event.currentTarget;
    nodeRef.current = node;
    // setPointerCapture THROWS NotFoundError when the pointer is no longer
    // active — verified in Chromium. It happens for real when a pointer is
    // released between dispatch and this handler running, and unguarded it
    // aborts the whole gesture before any drag state exists, so the card
    // becomes inert for that press and React logs an uncaught error. Capture is
    // an improvement (the drag survives leaving the element), not a
    // requirement: without it the card still tracks the pointer inside itself.
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // No capture; the drag below works regardless.
    }
    node.style.transition = 'none';
    node.style.willChange = 'transform';
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      samples: [{ t: performance.now(), x: 0, y: 0 }],
      moved: false,
    };
  }, [stopAnimation]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rawX = event.clientX - drag.originX;
    const rawY = event.clientY - drag.originY;

    if (!drag.moved && Math.hypot(rawX, rawY) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;

    const x = rubberBand(rawX, PULL_LIMIT_PX);
    const y = rubberBand(rawY, PULL_LIMIT_PX);
    // Velocity is measured on the DAMPED offset, not the raw pointer: the
    // spring starts from the damped position, so a flick's momentum has to
    // match what the card was actually doing, not what the hand was.
    drag.samples.push({ t: performance.now(), x, y });
    if (drag.samples.length > 12) drag.samples.shift();
    paint(x, y);
  }, [paint]);

  const finish = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Releasing a capture we never took, or one the browser already dropped.
    }
    if (!drag.moved) {
      // Never travelled: leave the click alone and restore the stylesheet.
      paint(0, 0);
      return;
    }
    suppressClickRef.current = true;
    const last = drag.samples[drag.samples.length - 1];
    const { vx, vy } = releaseVelocity(drag.samples);
    release(vx, vy, last.x, last.y);
  }, [paint, release]);

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    // A drag is a fidget, not a selection.
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => stopAnimation, [stopAnimation]);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onClickCapture,
    },
  };
}
