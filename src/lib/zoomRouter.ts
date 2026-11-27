// Which pane owns Cmd+= right now.
//
// The desktop shell intercepts the zoom chords below the application menu (see
// interceptZoomChords in electron/main.cjs) — the stock zoom roles would
// otherwise scale every window at once — and forwards them here. This module
// decides: components register a handler for their own DOM node, and a chord is
// routed to the handler whose node is focused, or, when nothing in particular is
// focused, to the handler whose node contains the pointer.
//
// The fall-through matters as much as the routing. A handler returns `false`
// when it did not zoom (a terminal that has not opened its shell yet, a browser
// pane on the web where the guest is an <iframe> that cannot be zoomed), and
// that `false` is what lets the app fall back to zooming the entire window, so
// the shortcut never becomes a dead key.

/** A pane's claim on the zoom chords. `true` means it zoomed and the app must not. */
export type ZoomPaneHandler = (command: 'in' | 'out' | 'reset') => boolean;

interface Registration {
  pane: string;
  element: HTMLElement;
  handler: ZoomPaneHandler;
}

const registrations: Registration[] = [];

/** True when `node` is inside the registered pane's element. */
function isInside(element: HTMLElement, node: Node | null): boolean {
  return node !== null && (element === node || element.contains(node));
}

function focusedElement(): Element | null {
  const active = document.activeElement;
  if (!active) return null;
  // Focus can sit inside a shadow root (xterm's hidden textarea lives in the
  // light DOM, but a webview guest reports the <webview> element itself), so
  // walk out through any shadow hosts.
  let current: Element | null = active;
  while (current && current.shadowRoot?.activeElement) current = current.shadowRoot.activeElement;
  return current;
}

/** Last known pointer position, tracked so "hovered pane" survives a focus loss. */
let lastPointer: { x: number; y: number } | null = null;
let tracking = false;

function trackPointer() {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  window.addEventListener(
    'pointermove',
    event => {
      lastPointer = { x: event.clientX, y: event.clientY };
    },
    { passive: true, capture: true },
  );
}

function hoveredElement(): Element | null {
  if (!lastPointer || typeof document === 'undefined') return null;
  return document.elementFromPoint(lastPointer.x, lastPointer.y);
}

/**
 * Register a pane's zoom handler. Returns the unsubscribe function, so the
 * natural call site is `useEffect(() => registerZoomHandler(...), [...])`.
 */
export function registerZoomHandler(pane: string, handler: ZoomPaneHandler, element?: HTMLElement | null): () => void {
  // jsdom and a browser tab without the desktop shell both take this path; the
  // registration is inert because no IPC will ever ask.
  if (typeof document === 'undefined') return () => {};
  trackPointer();
  const registration: Registration = { pane, element: element ?? document.body, handler };
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
  };
}

/**
 * Route one zoom command to the pane that owns it.
 *
 * Order: the pane containing the focused element first (that is "the thing you
 * are typing in"), then the pane under the pointer. A handler that declines is
 * skipped and the next candidate may take it.
 */
export function dispatchZoom(command: 'in' | 'out' | 'reset'): boolean {
  if (registrations.length === 0) return false;
  const focused = focusedElement();

  const ordered: Registration[] = [];
  if (focused) {
    for (const registration of registrations) {
      if (isInside(registration.element, focused)) ordered.push(registration);
    }
  }
  const hovered = hoveredElement();
  if (hovered) {
    for (const registration of registrations) {
      if (!ordered.includes(registration) && isInside(registration.element, hovered)) ordered.push(registration);
    }
  }

  for (const registration of ordered) {
    try {
      if (registration.handler(command) === true) return true;
    } catch {
      // A pane that throws must not block the others, nor the app fallback.
    }
  }
  return false;
}

/**
 * Whether the app-level chords should be intercepted at all. In the browser
 * build the native browser shortcut already zooms the page the user is on, so
 * nothing here should take the chord — the router is only installed by the
 * desktop shell, which is what supplies the IPC bridge.
 */
export function hasDesktopZoomBridge(): boolean {
  if (typeof window === 'undefined') return false;
  const api = (window as unknown as {
    electronAPI?: { onZoomCommand?: (handler: (command: string) => boolean) => () => void };
  }).electronAPI;
  return typeof api?.onZoomCommand === 'function';
}

/** Test seam: forget every registration and the tracked pointer. */
export function __resetZoomRouter() {
  registrations.length = 0;
  lastPointer = null;
}
