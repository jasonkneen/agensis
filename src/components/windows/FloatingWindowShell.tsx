import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Expand, Eye, EyeOff, Lock, Maximize2, Minimize2, Minus, MoreHorizontal, Share2, Shrink, Trash2, Unlock, X } from 'lucide-react';
import type { FloatingWindow, PresenceVisibilityMode } from '../../types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { WORKSPACE_BOTTOM_RESERVE, WORKSPACE_CHROME_GAP, WORKSPACE_PANEL_EDGE_INSET, WORKSPACE_TOP_RESERVE } from '../../lib/workspaceLayout';
import { ALL_WINDOW_EDGES, computeFlushEdges, computeFullBleed, type WindowEdge } from '../../lib/windowBleed';
// Shared with the commit path on purpose: the preview and the drop must agree
// on what is splittable, or the preview promises a split that never lands.
import { canSplitContainer } from '../../hooks/useWindows';
import { GROUP_FRAME_PADDING, GROUP_HEADER_HEIGHT } from '../../lib/windowGroups';

const SNAP_THRESHOLD = 44;
const MAXIMIZED_TOP_RESERVE = WORKSPACE_TOP_RESERVE;
// Desktop: maximize + the drag/position clamps fill the whole workspace viewport
// — the visible 8px gap top/bottom comes from the canvas column's padding, so no
// extra bottom reserve is needed. (Floating panels can therefore be dragged all
// the way to the bottom edge too.)
const MAXIMIZED_BOTTOM_RESERVE = 0;
// Mobile still shows one window edge-to-edge but keeps a strip clear at the
// bottom for the floating bell/presence controls.
const MOBILE_BOTTOM_RESERVE = WORKSPACE_BOTTOM_RESERVE;
const MAXIMIZED_EDGE_INSET = WORKSPACE_PANEL_EDGE_INSET;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 260;
// Visible channel between two tiled panes, in px. Split between the two
// neighbours (half each), so this is the width of the finished seam — not the
// amount each pane loses. Paint-time only; stored bounds stay flush.
const GROUP_GUTTER = 6;

type WindowBounds = { x: number; y: number; width: number; height: number };
type WindowUpdateOptions = { interaction?: 'drag' | 'resize' | 'programmatic' };
type ViewportRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampDimension(value: number, min: number, max: number): number {
  const ceiling = Math.max(1, Math.round(max));
  const floor = Math.min(min, ceiling);
  return Math.round(clampNumber(value, floor, ceiling));
}

function getShellViewport(shell: HTMLElement | null): { width: number; height: number; rect: ViewportRect | null } {
  const viewport = shell?.closest('[data-workspace-viewport]')
    || (typeof document !== 'undefined' ? document.querySelector('[data-workspace-viewport]') : null);
  const rect = viewport?.getBoundingClientRect() || null;
  if (rect && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height, rect };
  }
  const parent = shell?.offsetParent instanceof HTMLElement ? shell.offsetParent : null;
  const parentRect = parent?.getBoundingClientRect() || null;
  if (parentRect && parentRect.width > 0 && parentRect.height > 0) {
    return { width: parentRect.width, height: parentRect.height, rect: parentRect };
  }
  if (typeof window !== 'undefined') {
    const leftInset = getWorkspaceInset('--workspace-viewport-left') || getSidebarFallbackInset();
    const rightInset = getWorkspaceInset('--workspace-viewport-right');
    const topInset = getWorkspaceInset('--workspace-viewport-top');
    const bottomInset = getWorkspaceInset('--workspace-viewport-bottom');
    const width = window.innerWidth - leftInset - rightInset;
    const height = window.innerHeight - topInset - bottomInset;
    if (width > 0 && height > 0) {
      return {
        width,
        height,
        rect: { left: leftInset, top: topInset, width, height },
      };
    }
    return { width: window.innerWidth, height: window.innerHeight, rect: null };
  }
  return { width: 1024, height: 720, rect: null };
}

function getWorkspaceInset(name: string): number {
  if (typeof document === 'undefined') return 0;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name);
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function getSidebarFallbackInset(): number {
  if (typeof document === 'undefined') return 0;
  const sidebar = document.querySelector('[data-sidebar-panel]');
  const rect = sidebar?.getBoundingClientRect();
  return rect && rect.width > 0 ? Math.max(0, Math.round(rect.right)) : 0;
}

function clampWindowBounds(
  bounds: WindowBounds,
  shell: HTMLElement | null,
  viewport: ReturnType<typeof getShellViewport> = getShellViewport(shell),
): WindowBounds {
  const width = clampDimension(bounds.width, MIN_WINDOW_WIDTH, Math.max(1, viewport.width - MAXIMIZED_EDGE_INSET * 2));
  const height = clampDimension(bounds.height, MIN_WINDOW_HEIGHT, Math.max(1, viewport.height - MAXIMIZED_TOP_RESERVE - MAXIMIZED_BOTTOM_RESERVE - MAXIMIZED_EDGE_INSET));
  return {
    x: Math.round(clampNumber(bounds.x, MAXIMIZED_EDGE_INSET, Math.max(MAXIMIZED_EDGE_INSET, viewport.width - width - MAXIMIZED_EDGE_INSET))),
    y: Math.round(clampNumber(bounds.y, MAXIMIZED_TOP_RESERVE, Math.max(MAXIMIZED_TOP_RESERVE, viewport.height - MAXIMIZED_BOTTOM_RESERVE - height - MAXIMIZED_EDGE_INSET))),
    width,
    height,
  };
}

function getFullWindowBounds(shell: HTMLElement | null): WindowBounds {
  const viewport = getShellViewport(shell);
  return {
    x: MAXIMIZED_EDGE_INSET,
    y: MAXIMIZED_TOP_RESERVE,
    width: Math.round(Math.max(1, viewport.width - MAXIMIZED_EDGE_INSET * 2)),
    height: Math.round(Math.max(1, viewport.height - MAXIMIZED_TOP_RESERVE - MAXIMIZED_BOTTOM_RESERVE - MAXIMIZED_EDGE_INSET)),
  };
}

function isFullWindowBounds(bounds: WindowBounds, shell: HTMLElement | null): boolean {
  const full = getFullWindowBounds(shell);
  const tolerance = 2;
  return Math.abs(bounds.x - full.x) <= tolerance
    && Math.abs(bounds.y - full.y) <= tolerance
    && Math.abs(bounds.width - full.width) <= tolerance
    && Math.abs(bounds.height - full.height) <= tolerance;
}

function getCurrentWindowBounds(shell: HTMLElement | null, win: FloatingWindow): WindowBounds {
  return clampWindowBounds({
    x: win.x,
    y: win.y,
    width: win.width,
    height: win.height,
  }, shell);
}

/**
 * The difference between a window's STORED box and its PAINTED box: full-bleed
 * edges extend outward into the 8px chrome gap, tiled edges pull inward by half
 * the group gutter. Both are presentation-only — `win` never sees them.
 */
type PaintOffsets = { dx: number; dy: number; dw: number; dh: number };
const NO_PAINT_OFFSETS: PaintOffsets = { dx: 0, dy: 0, dw: 0, dh: 0 };

function syncShellBounds(shell: HTMLElement, bounds: WindowBounds, offsets: PaintOffsets = NO_PAINT_OFFSETS) {
  // Every caller MUST pass the offsets. This writes inline styles directly, and
  // React only rewrites an inline style key when its value changes between
  // renders — so a bare write here permanently wins over shellStyle and repaints
  // the window at its raw stored bounds, wiping the bleed and the gutter.
  shell.style.left = `${bounds.x + offsets.dx}px`;
  shell.style.top = `${bounds.y + offsets.dy}px`;
  shell.style.width = `${bounds.width + offsets.dw}px`;
  shell.style.height = `${bounds.height + offsets.dh}px`;
}

// Other windows tiled into the same group, so a drag can move them in lockstep
// (the real bounds update lands on drop via useWindows' syncGroupBounds).
function groupSiblingShells(shell: HTMLElement | null, groupId: string | null | undefined, ownId: string): HTMLElement[] {
  if (!shell || !groupId) return [];
  const root = shell.closest('[data-workspace-viewport]') || document;
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-window-group="${CSS.escape(groupId)}"]`))
    .filter(el => el.dataset.floatingWindowId !== ownId && el.dataset.windowHidden !== 'true');
}

function splitBounds(bounds: WindowBounds, edge: 'left' | 'right' | 'top' | 'bottom'): WindowBounds {
  if (edge === 'left') {
    return { x: bounds.x, y: bounds.y, width: Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width / 2)), height: bounds.height };
  }
  if (edge === 'right') {
    const width = Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width / 2));
    return { x: bounds.x + Math.max(0, bounds.width - width), y: bounds.y, width, height: bounds.height };
  }
  if (edge === 'top') {
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height / 2)) };
  }
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height / 2));
  return { x: bounds.x, y: bounds.y + Math.max(0, bounds.height - height), width: bounds.width, height };
}

function pointerInsideBounds(pointerX: number, pointerY: number, bounds: WindowBounds) {
  return pointerX >= bounds.x
    && pointerX <= bounds.x + bounds.width
    && pointerY >= bounds.y
    && pointerY <= bounds.y + bounds.height;
}

function nearestEdge(pointerX: number, pointerY: number, bounds: WindowBounds): 'left' | 'right' | 'top' | 'bottom' | null {
  const distances: Array<{ edge: 'left' | 'right' | 'top' | 'bottom'; distance: number }> = [
    { edge: 'left', distance: Math.abs(pointerX - bounds.x) },
    { edge: 'right', distance: Math.abs(pointerX - (bounds.x + bounds.width)) },
    { edge: 'top', distance: Math.abs(pointerY - bounds.y) },
    { edge: 'bottom', distance: Math.abs(pointerY - (bounds.y + bounds.height)) },
  ];
  const nearest = distances.sort((a, b) => a.distance - b.distance)[0];
  return nearest.distance <= SNAP_THRESHOLD ? nearest.edge : null;
}

function getOtherWindowBounds(shell: HTMLElement | null, viewportRect: ViewportRect | null): WindowBounds[] {
  if (!shell || !viewportRect) return [];
  const currentId = shell.dataset.floatingWindowId;
  return Array.from(document.querySelectorAll<HTMLElement>('[data-floating-window]'))
    .filter(element => (
      element.dataset.floatingWindowId !== currentId
      && element.dataset.windowHidden !== 'true'
    ))
    .map(element => {
      // Prefer the window's LOGICAL bounds over its painted rect. The painted
      // rect is not the window: it is inflated by up to 8px per full-bleed edge
      // and deflated by the group gutter, and during a drag it also carries a
      // translate3d. Snapping against it made the shell's preview disagree with
      // useWindows' stored-bounds check (12px tolerance), so a drop could
      // silently fail to split and leave the window floating on top of its
      // target with no group and no feedback. The rect stays as a fallback for
      // anything that has not painted a data-window-bounds yet.
      const logical = element.dataset.windowBounds?.split(',').map(Number);
      if (logical?.length === 4 && logical.every(Number.isFinite)) {
        return { x: logical[0], y: logical[1], width: logical[2], height: logical[3] };
      }
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left - viewportRect.left,
        y: rect.top - viewportRect.top,
        width: rect.width,
        height: rect.height,
      };
    })
    .filter(bounds => bounds.width >= MIN_WINDOW_WIDTH && bounds.height >= MIN_WINDOW_HEIGHT);
}

type DragSnapshot = {
  viewport: ReturnType<typeof getShellViewport>;
  otherBounds: WindowBounds[];
};

// Capture the workspace viewport + every OTHER window's bounds ONCE at drag
// start. Other windows can't move during a single-pointer drag, so re-querying
// them on every pointermove (querySelectorAll + a getBoundingClientRect per
// window = a forced sync reflow ~100×/sec) was pure layout thrash. Snapshot,
// then read cached numbers per frame.
function captureDragSnapshot(shell: HTMLElement | null): DragSnapshot {
  const viewport = getShellViewport(shell);
  return { viewport, otherBounds: getOtherWindowBounds(shell, viewport.rect) };
}

function computeSnapPreview(
  clientX: number,
  clientY: number,
  snapshot: DragSnapshot,
  shell: HTMLElement | null,
): WindowBounds | null {
  const { viewport } = snapshot;
  const rect = viewport.rect;
  const pointerX = rect ? clientX - rect.left : clientX;
  const pointerY = rect ? clientY - rect.top : clientY;

  if (
    pointerX < 0
    || pointerY < 0
    || pointerX > viewport.width
    || pointerY > viewport.height
  ) {
    return null;
  }

  // Snapping is panel-relative: empty workspace edges must not steal a drag.
  // A full-view panel still works as a split target because its own bounds cover
  // the workspace and are included in the snapshot's otherBounds.
  for (const bounds of snapshot.otherBounds) {
    if (!pointerInsideBounds(pointerX, pointerY, bounds)) continue;
    const edge = nearestEdge(pointerX, pointerY, bounds);
    // Mirror useWindows.canSplitContainer: a target too small to hold two
    // minimum-size tiles must not draw a preview, or we promise a split that
    // the commit path will refuse — the drop then leaves the window floating
    // on top of the target with no group and no feedback.
    if (edge && canSplitContainer(bounds, edge)) {
      return clampWindowBounds(splitBounds(bounds, edge), shell, viewport);
    }
  }

  return null;
}

function snapKey(bounds: WindowBounds | null): string | null {
  return bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : null;
}

function restoreBoundsForDrag(
  clientX: number,
  clientY: number,
  shell: HTMLElement | null,
  win: FloatingWindow,
): WindowBounds {
  const viewport = getShellViewport(shell);
  const rect = viewport.rect;
  const pointerX = rect ? clientX - rect.left : clientX;
  const pointerY = rect ? clientY - rect.top : clientY;
  const source = win.restoreBounds || {
    x: win.x,
    y: win.y,
    width: Math.min(Math.max(MIN_WINDOW_WIDTH, Math.round(viewport.width * 0.62)), viewport.width),
    height: Math.min(Math.max(MIN_WINDOW_HEIGHT, Math.round(viewport.height * 0.68)), viewport.height),
  };
  const sourceBounds = clampWindowBounds(source, shell);
  const width = sourceBounds.width;
  const height = sourceBounds.height;
  const pointerRatio = viewport.width > 0 ? Math.min(0.86, Math.max(0.14, pointerX / viewport.width)) : 0.5;

  return clampWindowBounds({
    x: pointerX - width * pointerRatio,
    y: Math.min(pointerY - 20, Math.max(MAXIMIZED_TOP_RESERVE, viewport.height - MAXIMIZED_BOTTOM_RESERVE - height - MAXIMIZED_EDGE_INSET)),
    width,
    height,
  }, shell);
}

interface FloatingWindowShellProps {
  window: FloatingWindow;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
  onUpdate: (id: string, updates: Partial<FloatingWindow>, options?: WindowUpdateOptions) => void;
  onMinimize: (id: string) => void;
  /**
   * A tiled group is presented as ONE composite window: the host pane owns the
   * whole title-bar control cluster and acts on every member, and member panes
   * render their label only. `null`/undefined means the window is not grouped
   * and behaves exactly as before.
   */
  groupRole?: 'host' | 'member' | null;
  onShare?: () => void;
  presenceMode?: PresenceVisibilityMode;
  currentUserId?: string;
  canControl?: boolean;
  /**
   * A non-owner window normally disables pointer input for its body so an
   * untrusted collaborator cannot edit a shared document or task. Some bodies
   * have their own read-only contract (notably shared chat), so they still
   * need scrolling, selection, links, and transcript controls.
   */
  bodyInteractive?: boolean;
  titleIcon?: React.ReactNode;
  breadcrumb?: string;
  children: React.ReactNode;
  isSelected?: boolean;
  adjacentEdges?: Set<'left' | 'right' | 'top' | 'bottom'>;
  /**
   * Keep the subtree mounted while removing the window from paint, focus, and
   * hit-testing. Chat windows use this for minimized/full-expand/mobile states
   * so composer drafts survive visibility switches.
   */
  hidden?: boolean;
  // Phone layout mode: the window fills the viewport, drag/resize are disabled,
  // and only the active window is visible (see CanvasLayerScene). The switcher
  // bar handles moving between windows instead of the free-floating canvas.
  isMobile?: boolean;
  // Full-expand (focus) mode: this window fills the whole workspace viewport as
  // the single visible window, drag/resize/tiling are disabled, and the chrome
  // shows a "shrink" toggle instead of maximize. Driven by useWindows' viewMode.
  isFullExpand?: boolean;
  onToggleFullExpand?: (id: string) => void;
}

export function FloatingWindowShell({
  window: win,
  onClose,
  onFocus,
  onUpdate,
  onMinimize,
  groupRole,
  onShare,
  presenceMode = 'visible',
  currentUserId,
  canControl = true,
  bodyInteractive = false,
  titleIcon,
  breadcrumb,
  children,
  isSelected = false,
  adjacentEdges,
  hidden = false,
  isMobile = false,
  isFullExpand = false,
  onToggleFullExpand,
}: FloatingWindowShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; winX: number; winY: number; winW: number; winH: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [snapPreview, setSnapPreview] = useState<WindowBounds | null>(null);
  const isHidden = hidden || win.minimized;
  const isMaximized = Boolean(win.maximized);
  // On phones the window always fills the viewport (edge-to-edge, one at a time),
  // so it renders with the same geometry as a maximized window regardless of the
  // stored floating bounds — and never runs the bounds-sync/ResizeObserver path.
  // Full-expand windows fill the viewport exactly like a maximized/mobile window
  // and skip the floating bounds-sync + drag/resize paths (single-window mode).
  const fullViewport = isMaximized || isMobile || isFullExpand;

  // Painted-box geometry. Hoisted above the drag/resize callbacks on purpose:
  // syncShellBounds writes straight to element.style and must apply the SAME
  // bleed/gutter offsets as shellStyle, or every drag, drop and resize repaints
  // the window at its raw stored bounds and the gutter flickers away.
  const displayBounds = getCurrentWindowBounds(shellRef.current, win);
  const isFullView = fullViewport || isFullWindowBounds(displayBounds, shellRef.current);

  // Full bleed: a window that fills the whole panel (maximized, or a tiled group
  // whose tiles collectively fill it) drops its corners + chrome gap and paints
  // edge-to-edge into the main panel. Its shell extends by the chrome gap on each
  // boundary-flush edge to cover the padding; <main> un-clips (see App.tsx) so the
  // extension reaches the true panel edge. A maximized window fills the viewport
  // by construction, so use all four edges; otherwise measure which edges are flush.
  const viewportSize = getShellViewport(shellRef.current);
  const flushEdges = fullViewport
    ? new Set<WindowEdge>(ALL_WINDOW_EDGES)
    : computeFlushEdges(displayBounds, viewportSize);
  const { isFullBleed, bleedEdges, squareCorners } = computeFullBleed({
    isMobile,
    isMaximized: isMaximized || isFullExpand,
    adjacentEdges,
    flushEdges,
  });
  const bleedLeft = bleedEdges.has('left') ? WORKSPACE_CHROME_GAP : 0;
  const bleedRight = bleedEdges.has('right') ? WORKSPACE_CHROME_GAP : 0;
  const bleedTop = bleedEdges.has('top') ? WORKSPACE_CHROME_GAP : 0;
  const bleedBottom = bleedEdges.has('bottom') ? WORKSPACE_CHROME_GAP : 0;

  const isFullSurface = isFullView || isFullBleed;

  // Group gutter: tiled panes partition their container EXACTLY (no gap in the
  // stored bounds — the snapping maths depends on that), so the visible seam is
  // produced purely at paint time by pulling each pane in by half a gutter on
  // every edge it shares with a sibling. Two neighbours each give up half, so
  // the seam reads as one GROUP_GUTTER-wide channel with the workspace showing
  // through. Never write this back into `win` — `data-window-bounds` below
  // publishes the un-inset geometry precisely so the inset cannot feed back
  // into the next split and shrink the tiles a little more each time.
  const gutterInset = (edge: WindowEdge) => (
    !isFullSurface && adjacentEdges?.has(edge) ? GROUP_GUTTER / 2 : 0
  );
  const gutterLeft = gutterInset('left') + (groupRole ? GROUP_FRAME_PADDING : 0);
  const gutterRight = gutterInset('right') + (groupRole ? GROUP_FRAME_PADDING : 0);
  const gutterBottom = gutterInset('bottom') + (groupRole ? GROUP_FRAME_PADDING : 0);
  // Panes in the group's TOP row drop below the frame's own title bar. Rows
  // further down already sit under a neighbour, so only the top row pays.
  const gutterTop = gutterInset('top')
    + (groupRole ? GROUP_FRAME_PADDING : 0)
    + (groupRole && !adjacentEdges?.has('top') ? GROUP_HEADER_HEIGHT : 0);

  // Single source of truth for painted-vs-stored, consumed by BOTH shellStyle
  // (the React render) and syncShellBounds (the imperative drag/resize writes).
  // Memoised on the eight numbers rather than rebuilt per render: the drag and
  // resize callbacks below list it as a dependency, and a fresh object every
  // render would recreate all of them every render. Stale offsets are not
  // cosmetic — a callback holding the pre-grouping value would paint the window
  // at the wrong box for the whole gesture right after it joins a group.
  const paintOffsets = useMemo<PaintOffsets>(() => ({
    dx: -bleedLeft + gutterLeft,
    dy: -bleedTop + gutterTop,
    dw: bleedLeft + bleedRight - gutterLeft - gutterRight,
    dh: bleedTop + bleedBottom - gutterTop - gutterBottom,
  }), [bleedLeft, bleedRight, bleedTop, bleedBottom, gutterLeft, gutterRight, gutterTop, gutterBottom]);

  useEffect(() => {
    const syncBounds = () => {
      const shell = shellRef.current;
      if (!shell || fullViewport || isDragging || isResizing) return;
      syncShellBounds(shell, getCurrentWindowBounds(shell, win), paintOffsets);
    };

    syncBounds();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const viewport = shellRef.current?.closest('[data-workspace-viewport]')
      || (typeof document !== 'undefined' ? document.querySelector('[data-workspace-viewport]') : null);
    if (!viewport) return undefined;

    const observer = new ResizeObserver(syncBounds);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [win, fullViewport, isDragging, isResizing, paintOffsets]);

  // CSS-hidden descendants can otherwise retain DOM focus in some browsers and
  // continue consuming keyboard events despite not being visible. Explicitly
  // blur before marking the shell inert; component state (including drafts)
  // remains mounted.
  useEffect(() => {
    if (!isHidden || typeof document === 'undefined') return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && shellRef.current?.contains(activeElement)) {
      activeElement.blur();
    }
  }, [isHidden]);

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    if (!canControl || isMobile || isFullExpand) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    onFocus(win.id);
    const startBounds = isMaximized
      ? restoreBoundsForDrag(e.clientX, e.clientY, shellRef.current, win)
      : getCurrentWindowBounds(shellRef.current, win);
    if (shellRef.current) {
      syncShellBounds(shellRef.current, startBounds, paintOffsets);
    }
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      winX: startBounds.x,
      winY: startBounds.y,
    };
    setIsDragging(true);

    const siblings = groupSiblingShells(shellRef.current, win.groupId, win.id);

    // Snapshot once — other windows can't move during this drag. The snap check
    // then runs against cached numbers, at most once per animation frame, and
    // only touches React state when the snapped bounds actually change.
    const snapshot = captureDragSnapshot(shellRef.current);
    let rafId: number | null = null;
    let pendingX = 0;
    let pendingY = 0;
    let lastSnapKey: string | null = snapKey(null);

    const evaluateSnap = () => {
      rafId = null;
      const snap = computeSnapPreview(pendingX, pendingY, snapshot, shellRef.current);
      const key = snapKey(snap);
      if (key !== lastSnapKey) {
        lastSnapKey = key;
        setSnapPreview(snap);
      }
    };

    const cancelSnapFrame = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      const transform = `translate3d(${dx}px, ${dy}px, 0)`;
      shellRef.current?.style.setProperty('transform', transform);
      // A tiled group moves as one unit — drag every sibling's shell in lockstep
      // so the gesture reads as dragging a single combined view, not two windows.
      siblings.forEach(sibling => sibling.style.setProperty('transform', transform));
      // Position tracks the pointer synchronously (above); only the snap
      // evaluation is rAF-throttled so it can't re-render the applet per event.
      pendingX = ev.clientX;
      pendingY = ev.clientY;
      if (rafId === null) {
        rafId = window.requestAnimationFrame(evaluateSnap);
      }
    };

    const onUp = (ev: PointerEvent) => {
      cancelSnapFrame();
      if (dragRef.current) {
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        const fallback = {
          x: dragRef.current.winX + dx,
          y: dragRef.current.winY + dy,
          width: startBounds.width,
          height: startBounds.height,
        };
        // Land where the last-shown preview was — compute from the SAME snapshot,
        // not a fresh query, so the drop matches what the user saw.
        const next = computeSnapPreview(ev.clientX, ev.clientY, snapshot, shellRef.current)
          || clampWindowBounds(fallback, shellRef.current);
        if (shellRef.current) {
          shellRef.current.style.left = `${next.x}px`;
          shellRef.current.style.top = `${next.y}px`;
          shellRef.current.style.width = `${next.width}px`;
          shellRef.current.style.height = `${next.height}px`;
          shellRef.current.style.removeProperty('transform');
        }
        siblings.forEach(sibling => sibling.style.removeProperty('transform'));
        onUpdate(win.id, {
          ...next,
          maximized: false,
          restoreBounds: next,
        }, { interaction: 'drag' });
      }
      dragRef.current = null;
      setSnapPreview(null);
      setIsDragging(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onCancel);
    };

    const onCancel = () => {
      cancelSnapFrame();
      shellRef.current?.style.removeProperty('transform');
      siblings.forEach(sibling => sibling.style.removeProperty('transform'));
      dragRef.current = null;
      setSnapPreview(null);
      setIsDragging(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onCancel);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    window.addEventListener('blur', onCancel);
  }, [win, onFocus, onUpdate, canControl, isMaximized, isMobile, isFullExpand, paintOffsets]);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    if (!canControl || isMaximized || isMobile || isFullExpand) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus(win.id);
    const startBounds = getCurrentWindowBounds(shellRef.current, win);
    if (shellRef.current) {
      syncShellBounds(shellRef.current, startBounds, paintOffsets);
    }
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      winX: startBounds.x,
      winY: startBounds.y,
      winW: startBounds.width,
      winH: startBounds.height,
    };
    setSnapPreview(null);
    setIsResizing(true);

    const onMove = (ev: PointerEvent) => {
      if (!resizeRef.current || !shellRef.current) return;
      const dx = ev.clientX - resizeRef.current.startX;
      const dy = ev.clientY - resizeRef.current.startY;
      const next = clampWindowBounds({
        x: resizeRef.current.winX,
        y: resizeRef.current.winY,
        width: resizeRef.current.winW + dx,
        height: resizeRef.current.winH + dy,
      }, shellRef.current);
      syncShellBounds(shellRef.current, next, paintOffsets);
    };

    const onUp = (ev: PointerEvent) => {
      if (resizeRef.current) {
        const dx = ev.clientX - resizeRef.current.startX;
        const dy = ev.clientY - resizeRef.current.startY;
        const next = clampWindowBounds({
          x: resizeRef.current.winX,
          y: resizeRef.current.winY,
          width: resizeRef.current.winW + dx,
          height: resizeRef.current.winH + dy,
        }, shellRef.current);
        if (shellRef.current) {
          syncShellBounds(shellRef.current, next, paintOffsets);
        }
        onUpdate(win.id, { ...next, restoreBounds: next }, { interaction: 'resize' });
      }
      resizeRef.current = null;
      setIsResizing(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onCancel);
    };

    const onCancel = () => {
      if (shellRef.current) {
        syncShellBounds(shellRef.current, startBounds, paintOffsets);
      }
      resizeRef.current = null;
      setIsResizing(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onCancel);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    window.addEventListener('blur', onCancel);
  }, [win, onFocus, onUpdate, canControl, isMaximized, isMobile, isFullExpand, paintOffsets]);

  const handleMaximize = useCallback(() => {
    if (!canControl) return;
    onFocus(win.id);
    if (win.maximized) {
      const restoreBounds = clampWindowBounds(win.restoreBounds || {
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
      }, shellRef.current);
      onUpdate(win.id, {
        ...restoreBounds,
        maximized: false,
        restoreBounds: undefined,
      });
      return;
    }

    const currentBounds = getCurrentWindowBounds(shellRef.current, win);
    onUpdate(win.id, {
      maximized: true,
      restoreBounds: currentBounds,
    });
  }, [win, onFocus, onUpdate, canControl]);

  const isDimmed = presenceMode === 'dimmed' || presenceMode === 'hidden';
  const dimmedOpacity = presenceMode === 'hidden' ? 0.22 : 0.35;
  const canTogglePrivacy = !win.ownerUserId || win.ownerUserId === currentUserId;
  const canToggleLock = !win.ownerUserId || win.ownerUserId === currentUserId;
  const privacyBlanked = Boolean(win.isPrivate && win.ownerUserId && win.ownerUserId !== currentUserId);

  const shellStyle: React.CSSProperties = fullViewport
    ? {
      position: 'absolute',
      left: MAXIMIZED_EDGE_INSET - bleedLeft,
      top: MAXIMIZED_TOP_RESERVE - bleedTop,
      width: `calc(100% - ${MAXIMIZED_EDGE_INSET * 2}px + ${bleedLeft + bleedRight}px)`,
      height: `calc(100% - ${MAXIMIZED_TOP_RESERVE + (isMobile ? MOBILE_BOTTOM_RESERVE : MAXIMIZED_BOTTOM_RESERVE) + MAXIMIZED_EDGE_INSET}px + ${bleedTop + bleedBottom}px)`,
      zIndex: win.zIndex,
      opacity: isDimmed ? dimmedOpacity : 1,
      filter: isDimmed ? 'saturate(0.55)' : undefined,
      userSelect: isDragging || isResizing ? 'none' : 'auto',
      transition: isDragging || isResizing ? 'none' : 'box-shadow 0.2s ease',
      display: isHidden ? 'none' : undefined,
    }
    : {
      position: 'absolute',
      left: displayBounds.x + paintOffsets.dx,
      top: displayBounds.y + paintOffsets.dy,
      width: displayBounds.width + paintOffsets.dw,
      height: displayBounds.height + paintOffsets.dh,
      zIndex: win.zIndex,
      opacity: isDimmed ? dimmedOpacity : 1,
      filter: isDimmed ? 'saturate(0.55)' : undefined,
      userSelect: isDragging || isResizing ? 'none' : 'auto',
      transition: isDragging || isResizing ? 'none' : 'box-shadow 0.2s ease',
      display: isHidden ? 'none' : undefined,
    };

  // Corner rounding via Tailwind CLASSES, not an inline `var(--radius-xl)`.
  // The inline-var approach (commit 061650c) put the ONLY reference to
  // --radius-xl in JS, so the radius silently depended on that custom property
  // surviving the CSS pipeline and resolving at runtime — the recurring
  // "corners are square again" bug. Classes emit the radius into the CSS layer
  // where it's cascade-normal and purge-proof. Unlisted corners stay square.
  // Full-bleed windows square every corner (they fill the panel edge-to-edge).
  // Tiled panes now keep ALL FOUR corners rounded. Squaring the shared edges
  // was an attempt to weld two flush panes into one surface, but the outer
  // wrapper and the inner surface carry the radius on different boxes (the
  // wrapper draws the elevation shadow and, under neo, a real 2px border), so a
  // squared corner left a square shadow/border "ear" poking out past the
  // rounded glass — the chrome artifact at every seam. With GROUP_GUTTER the
  // panes no longer touch, so there is nothing to weld: each pane is a plain
  // rounded card and the gap itself shows the join. Full-bleed windows still
  // square everything, because they genuinely do reach the panel edge.
  const cornerClass = squareCorners ? '' : 'rounded-xl';

  return (
    <>
      {!isHidden && isDragging && snapPreview && (
        <div
          className="pointer-events-none absolute rounded-xl border-2 border-primary/80 bg-primary/15 shadow-[inset_0_0_0_1px_hsl(var(--background)/0.6),0_12px_30px_hsl(var(--foreground)/0.16)]"
          style={{
            left: snapPreview.x,
            top: snapPreview.y,
            width: snapPreview.width,
            height: snapPreview.height,
            zIndex: win.zIndex + 1,
          }}
        />
      )}
      <div
        ref={shellRef}
        data-floating-window
        data-floating-window-id={win.id}
        data-window-hidden={isHidden ? 'true' : undefined}
        data-window-group={win.groupId || undefined}
        // The window's LOGICAL box, before bleed inflation and before the group
        // gutter. getOtherWindowBounds reads this instead of measuring, so
        // snapping always works against the same numbers useWindows stores.
        data-window-bounds={`${Math.round(displayBounds.x)},${Math.round(displayBounds.y)},${Math.round(displayBounds.width)},${Math.round(displayBounds.height)}`}
        data-window-view-mode={isFullSurface ? 'full' : 'floating'}
        hidden={isHidden}
        inert={isHidden ? true : undefined}
        aria-hidden={isHidden || undefined}
        onPointerDown={() => onFocus(win.id)}
        onDragOver={e => e.stopPropagation()}
        onDragEnter={e => e.stopPropagation()}
        onDragLeave={e => e.stopPropagation()}
        onDrop={e => e.stopPropagation()}
        className={cn('flex flex-col overflow-visible text-card-foreground', cornerClass)}
        // Drag and resize track the pointer through DOCUMENT-level listeners, and
        // an embedded frame swallows them: an Electron <webview> is a separate
        // process and an <iframe> a separate document, so the moment the pointer
        // crosses one, `pointermove` stops arriving and the `pointerup` that ends
        // the gesture never lands — the window loses the grip mid-drag and then
        // stays stuck resizing forever. This flag is what index.css keys off to
        // make embedded frames pointer-transparent for the length of the gesture,
        // so the events stay with the document that started it.
        data-window-interacting={isDragging || isResizing ? 'true' : undefined}
        style={shellStyle}
      >
        <div
          data-window-surface
          className={cn(
            'flex h-full min-h-0 flex-col overflow-hidden border backdrop-blur-xl',
            cornerClass,
            // The surface never casts its own drop shadow: full-view windows
            // are edge-to-edge and shouldn't float, and floating windows get
            // their layered elevation from the outer [data-window-view-mode]
            // wrapper (see index.css) so the selection ring's box-shadow on
            // this element is never clobbered.
            'shadow-none',
            isFullSurface ? 'bg-card' : 'bg-card/45',
            isSelected ? 'border-primary/70 ring-2 ring-primary/40' : 'border-border',
          )}
        >
          <div
            data-window-titlebar
            onPointerDown={handleDragStart}
            className={cn(
              'flex h-10 shrink-0 flex-nowrap items-center gap-2 border-b border-border bg-transparent px-3 backdrop-blur-xl touch-none',
              canControl && !isMobile ? 'cursor-grab' : 'cursor-default',
            )}
          >
            {titleIcon && (
              <span className="flex shrink-0 items-center text-muted-foreground">
                {titleIcon}
              </span>
            )}
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {breadcrumb && (
                <>
                  <span className="truncate text-xs text-muted-foreground">{breadcrumb}</span>
                  <span className="text-xs text-muted-foreground">{'>'}</span>
                </>
              )}
              <span className="truncate text-xs font-medium">{win.title}</span>
            </div>

            {/* A grouped pane that is not the host shows its label and nothing
                else — the group is one composite window and the host bar owns
                every control. Ungrouping is still reachable from the dock. */}
            {!groupRole && (
            <div className="flex shrink-0 flex-nowrap items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon-xs" aria-label="Window actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      disabled={!onShare}
                      onSelect={() => onShare?.()}
                    >
                      <Share2 />
                      Share
                    </DropdownMenuItem>
                    {/* There is no safe generic duplicate operation: chat
                        windows are session-keyed and documents/tasks carry
                        ownership and identity semantics. Do not expose a
                        menu item that cannot perform a real action. */}
                    <DropdownMenuItem
                      disabled={!canControl}
                      onSelect={() => onUpdate(win.id, { shared: !win.shared })}
                    >
                      <Share2 />
                      {win.shared ? 'Stop sharing this window' : 'Share this window'}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={!canControl} onSelect={handleMaximize}>
                      {isMaximized ? <Minimize2 /> : <Maximize2 />}
                      {isMaximized ? 'Restore' : 'Maximize'}
                    </DropdownMenuItem>
                    {!isMobile && onToggleFullExpand && (
                      <DropdownMenuItem
                        disabled={!canControl}
                        onSelect={() => onToggleFullExpand(win.id)}
                      >
                        {isFullExpand ? <Shrink /> : <Expand />}
                        {isFullExpand ? 'Exit full expand' : 'Full expand'}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      disabled={!canTogglePrivacy}
                      onSelect={() => onUpdate(win.id, { isPrivate: !win.isPrivate })}
                    >
                      {win.isPrivate ? <EyeOff /> : <Eye />}
                      {win.isPrivate ? 'Privacy on' : 'Privacy off'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canToggleLock}
                      onSelect={() => onUpdate(win.id, { locked: !win.locked })}
                    >
                      {win.locked ? <Lock /> : <Unlock />}
                      {win.locked ? 'Locked for others' : 'Unlocked for collaborators'}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={!canControl}
                      onSelect={() => onClose(win.id)}
                    >
                      <Trash2 />
                      Close window
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                // This cluster renders only for UNGROUPED windows now — a group's
                // controls live on WindowGroupFrame's single title bar, which acts
                // on every member. So there is no group case to handle here.
                onClick={() => onMinimize(win.id)}
                disabled={!canControl}
                aria-label="Minimize"
              >
                <Minus />
              </Button>

              {/* Maximize and Full expand used to sit here as their own icon
                  buttons; both are in the "..." menu above now, so the title bar
                  keeps only the three controls a user reaches for blind:
                  overflow, minimize, close. */}
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                onClick={() => onClose(win.id)}
                disabled={!canControl}
                aria-label="Close"
              >
                <X />
              </Button>
            </div>
            )}
          </div>

          <div className={cn(
            'relative min-h-0 flex-1 overflow-hidden',
            !canControl && !bodyInteractive && 'pointer-events-none',
          )}>
            {privacyBlanked ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 bg-muted/40 p-6 text-center">
                <EyeOff className="size-6 text-muted-foreground" />
                <div className="text-sm font-medium">Private window</div>
                <div className="max-w-64 text-xs text-muted-foreground">
                  This user has blanked the contents of this window.
                </div>
              </div>
            ) : children}
          </div>
        </div>

        {!fullViewport && (
          <div
            data-window-resize-handle
            onPointerDown={handleResizeStart}
            className="absolute -right-3 -bottom-3 z-10 size-8 cursor-nwse-resize bg-transparent text-muted-foreground/70 touch-none"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              className="absolute right-2.5 bottom-2.5 opacity-50"
            >
              <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
              <line x1="9" y1="4" x2="4" y2="9" stroke="currentColor" strokeWidth="1" />
              <line x1="9" y1="7" x2="7" y2="9" stroke="currentColor" strokeWidth="1" />
            </svg>
          </div>
        )}
      </div>
    </>
  );
}
