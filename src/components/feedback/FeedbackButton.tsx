import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageSquareWarning } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiAuthHeaders, apiUrl } from '@/lib/backendClient';
import { BUILD_ID } from '@/lib/appVersion';
import { CHROME_DEPTH } from '@/lib/chromeDepth';
import {
  buildDiagnosticsSnapshot,
  consoleCaptureTruncated,
  getCapturedConsole,
  getCapturedErrors,
  type DiagnosticsSnapshot,
} from '@/lib/feedbackDiagnostics';
import type { ElementDescriptor } from '@/lib/feedbackElement';
import {
  buildFeedbackSubmission,
  FEEDBACK_MAX_SELECTIONS,
  type FeedbackPageRef,
} from '@/lib/feedbackReport';
import {
  clampFeedbackAnchor,
  DEFAULT_FEEDBACK_ANCHOR,
  FEEDBACK_BUTTON_SIZE,
  feedbackAnchorPreference,
  isPointerNearFeedback,
  NO_FEEDBACK_DODGE,
  resolveFeedbackDodge,
  type FeedbackAnchor,
  type FeedbackDodge,
  type FeedbackRect,
  type FeedbackViewport,
} from '@/lib/feedbackAnchor';
import { DRAG_THRESHOLD_PX } from '@/lib/fidgetSpring';
import { usePersistedPreference } from '@/hooks/usePersistedPreference';
import { viewPreferenceKey } from '@/lib/viewPreferences';
import { ElementPicker } from './ElementPicker';
import { FeedbackDialog } from './FeedbackDialog';

const BUTTON_SIZE = FEEDBACK_BUTTON_SIZE;

/**
 * What counts as something worth getting out of the way of. Deliberately the
 * things a person CLICKS — not every box that happens to be underneath.
 */
const OBSTRUCTION_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  'input',
  'select',
  'textarea',
  '[data-feedback-avoid]',
].join(', ');

/**
 * An "important button under it" is a control, not a region. Anything taller
 * than this matched the selector by being a big clickable container (a card, a
 * message row), and sliding a 40px launcher clear of a 400px panel would fling
 * it into the middle of the screen.
 */
const MAX_OBSTRUCTION_HEIGHT = 120;

/** How far the pointer must get from a dodged button before it comes home. */
const DODGE_RELEASE_MARGIN = 20;

function toRect(rect: DOMRect): FeedbackRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function readViewport(): FeedbackViewport {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The topmost clickable thing sitting under the launcher, or null.
 *
 * Probes the centre and the four corners rather than the centre alone: an action
 * bar clipped by the button's edge is exactly the case in the bug report, and a
 * centre-only probe misses it. `elementsFromPoint` already returns the whole
 * ancestor chain at each point, so the `<button>` wrapping an icon is in the
 * list without walking up from the `<svg>`.
 */
function findObstruction(node: HTMLElement): FeedbackRect | null {
  if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null;
  const rect = node.getBoundingClientRect();
  const inset = 4;
  const probes: [number, number][] = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + inset, rect.top + inset],
    [rect.right - inset, rect.top + inset],
    [rect.left + inset, rect.bottom - inset],
    [rect.right - inset, rect.bottom - inset],
  ];
  for (const [x, y] of probes) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (!(element instanceof HTMLElement)) continue;
      if (node === element || node.contains(element)) continue;
      if (!element.matches(OBSTRUCTION_SELECTOR)) continue;
      const hit = element.getBoundingClientRect();
      if (hit.height > MAX_OBSTRUCTION_HEIGHT || hit.height <= 0) continue;
      return toRect(hit);
    }
  }
  return null;
}

interface FeedbackButtonProps {
  workspaceId: string | null;
  userId: string | null;
  /** Human anchor for the report — the workspace/canvas the user is looking at. */
  contextLabel: string;
}

/**
 * Persistent feedback trigger. Bottom-right by default; wherever the user put it
 * after that.
 *
 * Home is the same horizontal band as the window dock (which is bottom-CENTRE
 * with a `calc(100% - 12rem)` max width, leaving ~96px of clear space each side)
 * so the two read as one row and can never overlap. It stays below the dialog
 * layer (z 11990+) and above the dock (z 11000), and well above floating
 * windows, whose z-indexes start at 100.
 *
 * ## It moves, two ways
 *
 * **Dragged.** Press and move past a few pixels and it follows the pointer; let
 * go and it stays. The position is stored per USER (not per workspace — this is
 * where a person's hand goes, and it should not change when they switch
 * project) and is clamped into the current window on every paint, so a spot
 * chosen on a wide monitor cannot strand it off-canvas on a narrow one. A drag
 * never fires the click, and the click is never a drag: below
 * `DRAG_THRESHOLD_PX` of travel nothing is suppressed.
 *
 * **Dodges.** It is solid and high-contrast on purpose, which is precisely why
 * it covers things — the reported case is a message row's action buttons. When
 * the pointer arrives and there is a real control underneath, it slides clear of
 * that control (up, or left when there is no room above) and stays clear until
 * the pointer leaves the area, then comes home.
 *
 * The mechanism is deliberately "move", not "fade" or "pointer-events: none".
 * Both of those make it unclickable exactly where it is standing, and this is
 * the control a confused user needs to be able to hit. Moving keeps it visible,
 * solid, and reachable — it is just somewhere slightly different for a moment.
 * Nothing is computed unless the pointer is actually on the button, so there is
 * no observer, no polling and no layout thrash in the idle case.
 */
export function FeedbackButton({ workspaceId, userId, contextLabel }: FeedbackButtonProps) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [description, setDescription] = useState('');
  const [selections, setSelections] = useState<ElementDescriptor[]>([]);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- position -------------------------------------------------------------

  // Scoped to the USER, not the workspace: `viewPreferenceKey` takes whatever
  // scope it is given, and a launcher that jumps across the screen on a
  // workspace switch would be a bug, not a feature. A null id (still booting,
  // signed out) means in-memory only, never a shared bucket.
  const [storedAnchor, setStoredAnchor] = usePersistedPreference(
    viewPreferenceKey('feedback.anchor', userId),
    feedbackAnchorPreference,
    DEFAULT_FEEDBACK_ANCHOR,
  );
  const [viewport, setViewport] = useState<FeedbackViewport>(readViewport);

  // Clamped for PAINT, not on the way into storage. Re-widening the window then
  // puts the button back where the user actually left it, instead of having
  // quietly rewritten their choice to fit the narrowest window they ever had.
  const anchor = useMemo(() => clampFeedbackAnchor(storedAnchor, viewport), [storedAnchor, viewport]);

  const nodeRef = useRef<HTMLButtonElement | null>(null);
  // The single source of truth for what is PAINTED. A drag and a dodge both
  // write here and push to the node directly, so neither costs a render — and
  // the layout effect below replays it after any render React does for its own
  // reasons, which would otherwise snap a half-finished drag back to its start.
  const paintedRef = useRef<{ anchor: FeedbackAnchor; dodge: FeedbackDodge }>({
    anchor,
    dodge: NO_FEEDBACK_DODGE,
  });

  const syncNode = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    const { anchor: at, dodge } = paintedRef.current;
    node.style.right = `${at.right}px`;
    node.style.bottom = `${at.bottom}px`;
    // Cleared rather than written as zeros: an inline identity transform still
    // outranks the Button primitive's `active:translate-y-px` press feedback.
    node.style.transform = dodge.dx === 0 && dodge.dy === 0
      ? ''
      : `translate3d(${dodge.dx}px, ${dodge.dy}px, 0)`;
  }, []);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    from: FeedbackAnchor;
    latest: FeedbackAnchor;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // No dep array on purpose: the node must agree with `paintedRef` after EVERY
  // render, including ones that land mid-drag.
  useLayoutEffect(() => {
    if (!dragRef.current) paintedRef.current.anchor = anchor;
    syncNode();
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // --- dodging --------------------------------------------------------------

  const releaseDodge = useCallback(() => {
    if (paintedRef.current.dodge === NO_FEEDBACK_DODGE) return;
    paintedRef.current = { ...paintedRef.current, dodge: NO_FEEDBACK_DODGE };
    syncNode();
  }, [syncNode]);

  const handlePointerEnter = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    // Hover is a mouse affordance. On touch the first thing that happens is the
    // tap itself, and sliding the button out from under a finger mid-tap would
    // land the press on whatever it was covering — the opposite of helpful.
    if (event.pointerType !== 'mouse') return;
    if (dragRef.current) return;
    // Already out of the way: re-measuring here is what causes the classic
    // oscillation (dodge, no longer overlapping, come home, overlap again).
    if (paintedRef.current.dodge !== NO_FEEDBACK_DODGE) return;
    const node = nodeRef.current;
    if (!node) return;
    const obstruction = findObstruction(node);
    if (!obstruction) return;
    const home = toRect(node.getBoundingClientRect());
    const dodge = resolveFeedbackDodge(home, obstruction);
    if (dodge === NO_FEEDBACK_DODGE) return;
    paintedRef.current = { ...paintedRef.current, dodge };
    syncNode();
  }, [syncNode]);

  // While dodged, the release is decided from the WINDOW's pointer position: the
  // button's own `pointerleave` fires the instant it slides away, and acting on
  // that would bring it straight back under the pointer, forever.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onMove = (event: PointerEvent) => {
      const node = nodeRef.current;
      const { dodge } = paintedRef.current;
      if (!node || dodge === NO_FEEDBACK_DODGE || dragRef.current) return;
      const current = toRect(node.getBoundingClientRect());
      const home: FeedbackRect = {
        left: current.left - dodge.dx,
        top: current.top - dodge.dy,
        right: current.right - dodge.dx,
        bottom: current.bottom - dodge.dy,
      };
      if (!isPointerNearFeedback({ x: event.clientX, y: event.clientY }, home, current, DODGE_RELEASE_MARGIN)) {
        releaseDodge();
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [releaseDodge]);

  // --- dragging -------------------------------------------------------------

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    // Left button / touch / pen only: a right-click is a context menu.
    if (event.button !== 0 || dragRef.current) return;
    const node = event.currentTarget;
    nodeRef.current = node;
    // setPointerCapture THROWS NotFoundError when the pointer is already gone
    // between dispatch and this handler. Unguarded it aborts before any drag
    // state exists, leaving the control inert for that press. Capture is an
    // improvement (the drag survives leaving the button), not a requirement.
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // No capture; everything below still works.
    }
    node.style.transition = 'none';
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: paintedRef.current.anchor,
      latest: paintedRef.current.anchor,
      moved: false,
    };
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    // Insets are measured from the bottom-right, so they shrink as the pointer
    // moves right and down.
    drag.latest = clampFeedbackAnchor(
      { right: drag.from.right - dx, bottom: drag.from.bottom - dy },
      viewportRef.current,
    );
    paintedRef.current = { anchor: drag.latest, dodge: NO_FEEDBACK_DODGE };
    syncNode();
  }, [syncNode]);

  const finishDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const node = event.currentTarget;
    try {
      if (node.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
    } catch {
      // Releasing a capture we never took, or one the browser already dropped.
    }
    node.style.transition = '';
    if (!drag.moved) return;
    // A drag is a move, not a press.
    suppressClickRef.current = true;
    setStoredAnchor(drag.latest);
  }, [setStoredAnchor]);

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const page: FeedbackPageRef = useMemo(() => ({
    path: typeof window !== 'undefined' ? window.location.pathname : '',
    hash: typeof window !== 'undefined' ? window.location.hash : '',
    label: contextLabel,
  }), [contextLabel]);

  // Snapshot at OPEN time, not at submit time: by the time someone has finished
  // typing a paragraph the ring buffer has usually rolled past the lines that
  // explain the bug they are describing.
  const takeSnapshot = useCallback((): DiagnosticsSnapshot => buildDiagnosticsSnapshot(
    {
      buildId: BUILD_ID,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      url: typeof window !== 'undefined' ? window.location.href : '',
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
      viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
      language: typeof navigator !== 'undefined' ? navigator.language : '',
      capturedAt: new Date().toISOString(),
    },
    getCapturedConsole(),
    getCapturedErrors(),
    consoleCaptureTruncated(),
  ), []);

  const handleOpen = useCallback(() => {
    setDescription('');
    setSelections([]);
    setIncludeDiagnostics(true);
    setError(null);
    setDiagnostics(takeSnapshot());
    setOpen(true);
  }, [takeSnapshot]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setPicking(false);
  }, []);

  const handleStartPicking = useCallback(() => setPicking(true), []);
  const handleStopPicking = useCallback(() => setPicking(false), []);

  const handlePick = useCallback((descriptor: ElementDescriptor) => {
    setSelections(prev => (prev.length >= FEEDBACK_MAX_SELECTIONS ? prev : [...prev, descriptor]));
  }, []);

  const handleRemoveSelection = useCallback((index: number) => {
    setSelections(prev => prev.filter((_, i) => i !== index));
  }, []);

  const submission = useMemo(() => buildFeedbackSubmission({
    description,
    workspaceId,
    page,
    selections,
    diagnostics,
    includeDiagnostics,
  }), [description, workspaceId, page, selections, diagnostics, includeDiagnostics]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(apiUrl('/backend/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify(submission),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.error) {
        setError(payload?.error?.message || `Could not send feedback (${response.status})`);
        return;
      }
      toast.success('Thanks — your report is in.');
      handleClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send feedback');
    } finally {
      setSubmitting(false);
    }
  }, [submission, handleClose]);

  return (
    <>
      {/*
        Hidden while picking. It carries `data-feedback-ui`, so the picker
        exempts it from click-swallowing — which would make it the one thing on
        the page that still reacts, and pressing it mid-pick would reset the
        description the user has already typed.
      */}
      {!picking && (
        <Button
          ref={nodeRef}
          type="button"
          size="icon"
          data-feedback-ui
          onClick={handleOpen}
          onPointerEnter={handlePointerEnter}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onClickCapture={handleClickCapture}
          title="Send feedback — drag to move"
          aria-label="Send feedback"
          // INVERTED against the page, deliberately. As a glass panel this sat
          // on top of whatever was behind it and read as another piece of
          // chrome — the one control a confused user needs to find was the
          // hardest to see. Solid near-black on light, solid near-white on
          // dark: the strongest contrast available without introducing a
          // colour, and it inverts with the theme rather than picking a side.
          //
          // `touch-none` so a drag on a touchscreen is a drag and not a scroll.
          className="fixed touch-none rounded-full border-0 bg-neutral-900 text-white shadow-lg shadow-black/20 transition-[background-color,transform] duration-150 hover:bg-neutral-800 motion-reduce:transition-none dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-white"
          style={{
            // right/bottom are OWNED by the layout effect above, which writes
            // the live drag/dodge position straight to the node. They are here
            // as well so the very first paint is already in the right place.
            right: anchor.right,
            bottom: anchor.bottom,
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            // Above the window dock, below dialogs/sheets, so an open dialog is
            // never fighting a floating button for clicks. See the ladder in
            // src/lib/chromeDepth.ts.
            zIndex: CHROME_DEPTH.appDock,
          }}
        >
          <MessageSquareWarning className="size-4" />
        </Button>
      )}

      <FeedbackDialog
        // Hidden, not unmounted, while picking: the user is out on the page
        // choosing an element and must come back to the text they already typed.
        open={open && !picking}
        onClose={handleClose}
        description={description}
        onDescriptionChange={setDescription}
        workspaceId={workspaceId}
        userId={userId}
        page={page}
        selections={selections}
        onRemoveSelection={handleRemoveSelection}
        onStartPicking={handleStartPicking}
        maxSelections={FEEDBACK_MAX_SELECTIONS}
        includeDiagnostics={includeDiagnostics}
        onToggleDiagnostics={setIncludeDiagnostics}
        diagnostics={diagnostics}
        submission={submission}
        submitting={submitting}
        error={error}
        onSubmit={handleSubmit}
      />

      {picking && (
        <ElementPicker
          onPick={handlePick}
          onDone={handleStopPicking}
          onCancel={handleStopPicking}
          picked={selections}
          max={FEEDBACK_MAX_SELECTIONS}
        />
      )}
    </>
  );
}
