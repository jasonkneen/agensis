import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Lock, Maximize2, Minimize2, Minus, MoreHorizontal, Share2, Trash2, Unlock, X } from 'lucide-react';
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
import { WORKSPACE_BOTTOM_RESERVE, WORKSPACE_PANEL_EDGE_INSET, WORKSPACE_TOP_RESERVE } from '../../lib/workspaceLayout';

const SNAP_THRESHOLD = 44;
const MAXIMIZED_TOP_RESERVE = WORKSPACE_TOP_RESERVE;
const MAXIMIZED_BOTTOM_RESERVE = WORKSPACE_BOTTOM_RESERVE;
const MAXIMIZED_EDGE_INSET = WORKSPACE_PANEL_EDGE_INSET;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 260;

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

function clampWindowBounds(bounds: WindowBounds, shell: HTMLElement | null): WindowBounds {
  const viewport = getShellViewport(shell);
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

function syncShellBounds(shell: HTMLElement, bounds: WindowBounds) {
  shell.style.left = `${bounds.x}px`;
  shell.style.top = `${bounds.y}px`;
  shell.style.width = `${bounds.width}px`;
  shell.style.height = `${bounds.height}px`;
}

// Other windows tiled into the same group, so a drag can move them in lockstep
// (the real bounds update lands on drop via useWindows' syncGroupBounds).
function groupSiblingShells(shell: HTMLElement | null, groupId: string | null | undefined, ownId: string): HTMLElement[] {
  if (!shell || !groupId) return [];
  const root = shell.closest('[data-workspace-viewport]') || document;
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-window-group="${CSS.escape(groupId)}"]`))
    .filter(el => el.dataset.floatingWindowId !== ownId);
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
    .filter(element => element.dataset.floatingWindowId !== currentId)
    .map(element => {
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

function getSnapPreviewBounds(
  clientX: number,
  clientY: number,
  shell: HTMLElement | null,
): WindowBounds | null {
  const viewport = getShellViewport(shell);
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
  // the workspace and are included in getOtherWindowBounds().
  for (const bounds of getOtherWindowBounds(shell, rect)) {
    if (!pointerInsideBounds(pointerX, pointerY, bounds)) continue;
    const edge = nearestEdge(pointerX, pointerY, bounds);
    if (edge) return clampWindowBounds(splitBounds(bounds, edge), shell);
  }

  return null;
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
  onShare?: () => void;
  presenceMode?: PresenceVisibilityMode;
  currentUserId?: string;
  canControl?: boolean;
  titleIcon?: React.ReactNode;
  breadcrumb?: string;
  children: React.ReactNode;
  isSelected?: boolean;
  adjacentEdges?: Set<'left' | 'right' | 'top' | 'bottom'>;
}

export function FloatingWindowShell({
  window: win,
  onClose,
  onFocus,
  onUpdate,
  onMinimize,
  onShare,
  presenceMode = 'visible',
  currentUserId,
  canControl = true,
  titleIcon,
  breadcrumb,
  children,
  isSelected = false,
  adjacentEdges,
}: FloatingWindowShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; winX: number; winY: number; winW: number; winH: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [snapPreview, setSnapPreview] = useState<WindowBounds | null>(null);
  const isMaximized = Boolean(win.maximized);

  useEffect(() => {
    const syncBounds = () => {
      const shell = shellRef.current;
      if (!shell || isMaximized || isDragging || isResizing) return;
      syncShellBounds(shell, getCurrentWindowBounds(shell, win));
    };

    syncBounds();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const viewport = shellRef.current?.closest('[data-workspace-viewport]')
      || (typeof document !== 'undefined' ? document.querySelector('[data-workspace-viewport]') : null);
    if (!viewport) return undefined;

    const observer = new ResizeObserver(syncBounds);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [win, isMaximized, isDragging, isResizing]);

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    if (!canControl) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    onFocus(win.id);
    const startBounds = isMaximized
      ? restoreBoundsForDrag(e.clientX, e.clientY, shellRef.current, win)
      : getCurrentWindowBounds(shellRef.current, win);
    if (shellRef.current) {
      syncShellBounds(shellRef.current, startBounds);
    }
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      winX: startBounds.x,
      winY: startBounds.y,
    };
    setIsDragging(true);

    const siblings = groupSiblingShells(shellRef.current, win.groupId, win.id);

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      const transform = `translate3d(${dx}px, ${dy}px, 0)`;
      shellRef.current?.style.setProperty('transform', transform);
      // A tiled group moves as one unit — drag every sibling's shell in lockstep
      // so the gesture reads as dragging a single combined view, not two windows.
      siblings.forEach(sibling => sibling.style.setProperty('transform', transform));
      setSnapPreview(getSnapPreviewBounds(ev.clientX, ev.clientY, shellRef.current));
    };

    const onUp = (ev: PointerEvent) => {
      if (dragRef.current) {
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        const fallback = {
          x: dragRef.current.winX + dx,
          y: dragRef.current.winY + dy,
          width: startBounds.width,
          height: startBounds.height,
        };
        const next = getSnapPreviewBounds(ev.clientX, ev.clientY, shellRef.current) || clampWindowBounds(fallback, shellRef.current);
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
  }, [win, onFocus, onUpdate, canControl, isMaximized]);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    if (!canControl || isMaximized) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus(win.id);
    const startBounds = getCurrentWindowBounds(shellRef.current, win);
    if (shellRef.current) {
      syncShellBounds(shellRef.current, startBounds);
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
      syncShellBounds(shellRef.current, next);
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
          syncShellBounds(shellRef.current, next);
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
        syncShellBounds(shellRef.current, startBounds);
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
  }, [win.id, win.x, win.y, win.width, win.height, onFocus, onUpdate, canControl, isMaximized]);

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
  }, [win.id, win.x, win.y, win.width, win.height, win.maximized, win.restoreBounds, onFocus, onUpdate, canControl]);

  if (win.minimized) return null;

  const isDimmed = presenceMode === 'dimmed' || presenceMode === 'hidden';
  const dimmedOpacity = presenceMode === 'hidden' ? 0.22 : 0.35;
  const canTogglePrivacy = !win.ownerUserId || win.ownerUserId === currentUserId;
  const canToggleLock = !win.ownerUserId || win.ownerUserId === currentUserId;
  const privacyBlanked = Boolean(win.isPrivate && win.ownerUserId && win.ownerUserId !== currentUserId);
  const displayBounds = getCurrentWindowBounds(shellRef.current, win);
  const isFullView = isMaximized || isFullWindowBounds(displayBounds, shellRef.current);
  const shellStyle: React.CSSProperties = isMaximized
    ? {
        position: 'absolute',
        left: MAXIMIZED_EDGE_INSET,
        top: MAXIMIZED_TOP_RESERVE,
        width: `calc(100% - ${MAXIMIZED_EDGE_INSET * 2}px)`,
        height: `calc(100% - ${MAXIMIZED_TOP_RESERVE + MAXIMIZED_BOTTOM_RESERVE + MAXIMIZED_EDGE_INSET}px)`,
        zIndex: win.zIndex,
        opacity: isDimmed ? dimmedOpacity : 1,
        filter: isDimmed ? 'saturate(0.55)' : undefined,
        userSelect: isDragging || isResizing ? 'none' : 'auto',
        transition: isDragging || isResizing ? 'none' : 'box-shadow 0.2s ease',
      }
    : {
        position: 'absolute',
        left: displayBounds.x,
        top: displayBounds.y,
        width: displayBounds.width,
        height: displayBounds.height,
        zIndex: win.zIndex,
        opacity: isDimmed ? dimmedOpacity : 1,
        filter: isDimmed ? 'saturate(0.55)' : undefined,
        userSelect: isDragging || isResizing ? 'none' : 'auto',
        transition: isDragging || isResizing ? 'none' : 'box-shadow 0.2s ease',
      };

  const R = 'var(--radius-xl)';
  const cornerStyle: React.CSSProperties = (() => {
    if (!adjacentEdges || adjacentEdges.size === 0) return { borderRadius: R };
    return {
      borderTopLeftRadius: (!adjacentEdges.has('left') && !adjacentEdges.has('top')) ? R : '0px',
      borderTopRightRadius: (!adjacentEdges.has('right') && !adjacentEdges.has('top')) ? R : '0px',
      borderBottomLeftRadius: (!adjacentEdges.has('left') && !adjacentEdges.has('bottom')) ? R : '0px',
      borderBottomRightRadius: (!adjacentEdges.has('right') && !adjacentEdges.has('bottom')) ? R : '0px',
    };
  })();

  return (
    <>
      {isDragging && snapPreview && (
        <div
          className="pointer-events-none absolute border-2 border-primary/80 bg-primary/15 shadow-[inset_0_0_0_1px_hsl(var(--background)/0.6),0_12px_30px_hsl(var(--foreground)/0.16)]"
          style={{
            left: snapPreview.x,
            top: snapPreview.y,
            width: snapPreview.width,
            height: snapPreview.height,
            zIndex: win.zIndex + 1,
            borderRadius: R,
          }}
        />
      )}
      <div
        ref={shellRef}
        data-floating-window
        data-floating-window-id={win.id}
        data-window-group={win.groupId || undefined}
        data-window-view-mode={isFullView ? 'full' : 'floating'}
        onPointerDown={() => onFocus(win.id)}
        onDragOver={e => e.stopPropagation()}
        onDragEnter={e => e.stopPropagation()}
        onDragLeave={e => e.stopPropagation()}
        onDrop={e => e.stopPropagation()}
        className="flex flex-col overflow-visible text-card-foreground"
        style={{ ...shellStyle, ...cornerStyle }}
        >
        <div
          data-window-surface
          className={cn(
            'flex h-full min-h-0 flex-col overflow-hidden border backdrop-blur-xl',
            // Full-view windows sit edge-to-edge (inset 0) inside <main>'s
            // overflow-hidden, so a drop shadow gets clipped into a hard
            // straight line. A full-bleed panel shouldn't float — drop the
            // shadow; only genuinely floating windows keep it.
            isFullView ? 'shadow-none' : 'shadow-xl',
            isFullView ? 'bg-card' : 'bg-card/45',
            isSelected ? 'border-primary/70 ring-2 ring-primary/40' : 'border-border',
          )}
          style={cornerStyle}
        >
        <div
          data-window-titlebar
          onPointerDown={handleDragStart}
          className={cn(
            'flex h-10 shrink-0 flex-nowrap items-center gap-2 border-b border-border bg-transparent px-3 backdrop-blur-xl touch-none',
            canControl ? 'cursor-grab' : 'cursor-default',
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
                <DropdownMenuItem>
                  <Copy />
                  Duplicate
                </DropdownMenuItem>
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
            variant={win.isPrivate ? 'secondary' : 'outline'}
            size="icon-xs"
            onClick={() => {
              if (canTogglePrivacy) onUpdate(win.id, { isPrivate: !win.isPrivate });
            }}
            disabled={!canTogglePrivacy}
            aria-label={win.isPrivate ? 'Window privacy on' : 'Window privacy off'}
            title={win.isPrivate ? 'Privacy on' : 'Privacy off'}
          >
            {win.isPrivate ? <EyeOff /> : <Eye />}
          </Button>

          <Button
            type="button"
            variant={win.locked ? 'secondary' : 'outline'}
            size="icon-xs"
            onClick={() => {
              if (canToggleLock) onUpdate(win.id, { locked: !win.locked });
            }}
            disabled={!canToggleLock}
            aria-label={win.locked ? 'Window locked' : 'Window unlocked'}
            title={win.locked ? 'Locked for others' : 'Unlocked for collaborators'}
          >
            {win.locked ? <Lock /> : <Unlock />}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => onMinimize(win.id)}
            disabled={!canControl}
            aria-label="Minimize"
          >
            <Minus />
          </Button>

          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={handleMaximize}
            disabled={!canControl}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? <Minimize2 /> : <Maximize2 />}
          </Button>
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
      </div>

        <div className={cn('relative min-h-0 flex-1 overflow-hidden', !canControl && 'pointer-events-none')}>
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

        {!isMaximized && (
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
