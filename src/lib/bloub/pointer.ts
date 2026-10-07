// Shared cursor for every live bot. One listener, not one per SVG.

export type Pointer = {
  x: number;
  y: number;
  present: boolean;
  movedAt: number;
};

let current: Pointer = { x: 0, y: 0, present: false, movedAt: 0 };
let listening = false;

function onMove(event: PointerEvent) {
  current = { x: event.clientX, y: event.clientY, present: true, movedAt: performance.now() };
}

function onLeave() {
  current = { ...current, present: false };
}

function ensure() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerout", (event) => {
    if (event.relatedTarget == null) onLeave();
  });
}

export function getPointer(): Pointer {
  ensure();
  return current;
}

export function pointerIsFresh(now: number, windowMs = 700): boolean {
  return current.present && now - current.movedAt < windowMs;
}
