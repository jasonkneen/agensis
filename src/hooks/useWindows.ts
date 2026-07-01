import { useState, useCallback, useRef } from 'react';
import type { FloatingWindow, FloatingWindowType } from '../types';
import { WORKSPACE_BOTTOM_RESERVE, WORKSPACE_CHROME_GAP, WORKSPACE_PANEL_EDGE_INSET, WORKSPACE_TOP_RESERVE } from '../lib/workspaceLayout';

const WORKSPACE_WINDOW_MARGIN = WORKSPACE_CHROME_GAP;
const WORKSPACE_WINDOW_EDGE_INSET = WORKSPACE_PANEL_EDGE_INSET;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 260;
const TILE_TOLERANCE = 12;

type WindowBounds = { x: number; y: number; width: number; height: number };
type TileEdge = 'left' | 'right' | 'top' | 'bottom';
type WindowUpdateOptions = { interaction?: 'drag' | 'resize' | 'programmatic' };

type WindowIdentity = {
  type: FloatingWindowType;
  canvasId?: string;
  sessionId?: string;
  documentId?: string;
};

function generateId(): string {
  return `win_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateGroupId(): string {
  return `wgrp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Drop groupId from any window whose group has been reduced to a single
// member — a "group" of one is just a window, and the dock should stop
// drawing a surrounding frame around it.
function cleanupSoloGroups(windows: FloatingWindow[]): FloatingWindow[] {
  const counts = new Map<string, number>();
  windows.forEach(w => {
    if (!w.groupId) return;
    counts.set(w.groupId, (counts.get(w.groupId) || 0) + 1);
  });
  const lonelyGroups = new Set([...counts.entries()].filter(([, count]) => count < 2).map(([groupId]) => groupId));
  if (lonelyGroups.size === 0) return windows;
  return windows.map(w => (w.groupId && lonelyGroups.has(w.groupId) ? { ...w, groupId: null } : w));
}

function getWorkspaceViewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') {
    return { width: 1024, height: 720 };
  }

  const viewport = document.querySelector('[data-workspace-viewport]');
  const rect = viewport?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }

  const leftInset = getWorkspaceInset('--workspace-viewport-left') || getSidebarFallbackInset();
  const rightInset = getWorkspaceInset('--workspace-viewport-right');
  const topInset = getWorkspaceInset('--workspace-viewport-top');
  const bottomInset = getWorkspaceInset('--workspace-viewport-bottom');
  const fallbackWidth = window.innerWidth - leftInset - rightInset;
  const fallbackHeight = window.innerHeight - topInset - bottomInset;
  if (fallbackWidth > 0 && fallbackHeight > 0) {
    return { width: fallbackWidth, height: fallbackHeight };
  }

  return { width: window.innerWidth, height: window.innerHeight };
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampDimension(value: number, min: number, max: number): number {
  const ceiling = Math.max(1, Math.round(max));
  const floor = Math.min(min, ceiling);
  return Math.round(clampNumber(value, floor, ceiling));
}

function fitWindowSize(
  size: { width: number; height: number },
  viewport = getWorkspaceViewportSize(),
  margin = 0,
): { width: number; height: number } {
  return {
    width: clampDimension(size.width, MIN_WINDOW_WIDTH, Math.max(1, viewport.width - margin * 2)),
    height: clampDimension(size.height, MIN_WINDOW_HEIGHT, Math.max(1, viewport.height - WORKSPACE_TOP_RESERVE - WORKSPACE_BOTTOM_RESERVE - margin * 2)),
  };
}

function getDefaultRestoreSize(type: FloatingWindowType): { width: number; height: number } {
  const viewport = getWorkspaceViewportSize();
  const sizeMap: Record<string, { width: number; height: number }> = {
    chat: { width: Math.min(860, Math.max(520, Math.round(viewport.width * 0.72))), height: Math.min(720, Math.max(520, Math.round(viewport.height * 0.72))) },
    document: { width: Math.min(860, Math.max(560, Math.round(viewport.width * 0.68))), height: Math.min(720, Math.max(520, Math.round(viewport.height * 0.7))) },
    memory: { width: Math.min(640, Math.max(440, Math.round(viewport.width * 0.5))), height: Math.min(700, Math.max(520, Math.round(viewport.height * 0.72))) },
    tasks: { width: Math.min(680, Math.max(460, Math.round(viewport.width * 0.52))), height: Math.min(720, Math.max(540, Math.round(viewport.height * 0.74))) },
    activity: { width: Math.min(620, Math.max(420, Math.round(viewport.width * 0.48))), height: Math.min(720, Math.max(540, Math.round(viewport.height * 0.74))) },
    agents: { width: Math.min(980, Math.max(720, Math.round(viewport.width * 0.72))), height: Math.min(760, Math.max(560, Math.round(viewport.height * 0.76))) },
  };
  return fitWindowSize(sizeMap[type] || sizeMap.chat, viewport, WORKSPACE_WINDOW_MARGIN);
}

function getSpawnPosition(
  existing: FloatingWindow[],
  size: { width: number; height: number }
): { x: number; y: number } {
  if (typeof window === 'undefined') {
    return { x: 200, y: 80 };
  }

  const viewport = getWorkspaceViewportSize();
  const maxX = Math.max(0, viewport.width - size.width - WORKSPACE_WINDOW_MARGIN);
  const maxY = Math.max(WORKSPACE_TOP_RESERVE, viewport.height - WORKSPACE_BOTTOM_RESERVE - size.height - WORKSPACE_WINDOW_MARGIN);
  const minX = Math.min(WORKSPACE_WINDOW_MARGIN, maxX);
  const minY = Math.min(WORKSPACE_TOP_RESERVE, maxY);
  const baseX = clampNumber((viewport.width - size.width) / 2, minX, maxX);
  const baseY = clampNumber((viewport.height - size.height) / 2, minY, maxY);
  const offset = existing.length * 28;

  return {
    x: Math.round(clampNumber(baseX + (offset % 168), minX, maxX)),
    y: Math.round(clampNumber(baseY + (offset % 112), minY, maxY)),
  };
}

function clampToViewport(bounds: WindowBounds) {
  const viewport = getWorkspaceViewportSize();
  const size = fitWindowSize(bounds, viewport, WORKSPACE_WINDOW_EDGE_INSET);
  const maxX = Math.max(WORKSPACE_WINDOW_EDGE_INSET, viewport.width - size.width - WORKSPACE_WINDOW_EDGE_INSET);
  const minY = WORKSPACE_TOP_RESERVE;
  const maxY = Math.max(minY, viewport.height - WORKSPACE_BOTTOM_RESERVE - size.height - WORKSPACE_WINDOW_EDGE_INSET);

  return {
    x: Math.round(clampNumber(bounds.x, WORKSPACE_WINDOW_EDGE_INSET, maxX)),
    y: Math.round(clampNumber(bounds.y, minY, maxY)),
    width: size.width,
    height: size.height,
  };
}

function getFullViewportBounds(): WindowBounds {
  const viewport = getWorkspaceViewportSize();
  return {
    x: WORKSPACE_WINDOW_EDGE_INSET,
    y: WORKSPACE_TOP_RESERVE,
    width: Math.round(Math.max(1, viewport.width - WORKSPACE_WINDOW_EDGE_INSET * 2)),
    height: Math.round(Math.max(1, viewport.height - WORKSPACE_TOP_RESERVE - WORKSPACE_BOTTOM_RESERVE - WORKSPACE_WINDOW_EDGE_INSET)),
  };
}

function getWindowIdentityKey(source: WindowIdentity): string {
  const canvasId = source.canvasId || 'base';
  if (source.sessionId) return `${canvasId}:session:${source.sessionId}`;
  if (source.documentId) return `${canvasId}:document:${source.documentId}`;
  return `${canvasId}:type:${source.type}`;
}

function getVisibleBounds(win: FloatingWindow): WindowBounds {
  if (win.maximized) return getFullViewportBounds();

  return clampToViewport({
    x: win.x,
    y: win.y,
    width: win.width,
    height: win.height,
  });
}

function getSplitTile(container: WindowBounds, edge: TileEdge): WindowBounds {
  const fullWidth = Math.round(container.width);
  const fullHeight = Math.round(container.height);
  const halfWidth = Math.max(MIN_WINDOW_WIDTH, Math.round(fullWidth / 2));
  const halfHeight = Math.max(MIN_WINDOW_HEIGHT, Math.round(fullHeight / 2));

  if (edge === 'left') return { x: container.x, y: container.y, width: Math.min(halfWidth, fullWidth), height: fullHeight };
  if (edge === 'right') {
    const width = Math.min(halfWidth, fullWidth);
    return { x: container.x + Math.max(0, fullWidth - width), y: container.y, width, height: fullHeight };
  }
  if (edge === 'top') return { x: container.x, y: container.y, width: fullWidth, height: Math.min(halfHeight, fullHeight) };
  const height = Math.min(halfHeight, fullHeight);
  return { x: container.x, y: container.y + Math.max(0, fullHeight - height), width: fullWidth, height };
}

function getComplementaryTile(container: WindowBounds, edge: TileEdge): WindowBounds {
  const fullWidth = Math.round(container.width);
  const fullHeight = Math.round(container.height);
  const halfWidth = Math.max(MIN_WINDOW_WIDTH, Math.round(fullWidth / 2));
  const halfHeight = Math.max(MIN_WINDOW_HEIGHT, Math.round(fullHeight / 2));

  if (edge === 'left') return { x: container.x + Math.min(halfWidth, fullWidth), y: container.y, width: Math.max(1, fullWidth - Math.min(halfWidth, fullWidth)), height: fullHeight };
  if (edge === 'right') return { x: container.x, y: container.y, width: Math.max(1, fullWidth - Math.min(halfWidth, fullWidth)), height: fullHeight };
  if (edge === 'top') return { x: container.x, y: container.y + Math.min(halfHeight, fullHeight), width: fullWidth, height: Math.max(1, fullHeight - Math.min(halfHeight, fullHeight)) };
  return { x: container.x, y: container.y, width: fullWidth, height: Math.max(1, fullHeight - Math.min(halfHeight, fullHeight)) };
}

function boundsMatch(a: WindowBounds, b: WindowBounds): boolean {
  return Math.abs(a.x - b.x) <= TILE_TOLERANCE
    && Math.abs(a.y - b.y) <= TILE_TOLERANCE
    && Math.abs(a.width - b.width) <= TILE_TOLERANCE
    && Math.abs(a.height - b.height) <= TILE_TOLERANCE;
}

function getTileEdge(bounds: WindowBounds, container: WindowBounds = getFullViewportBounds()): TileEdge | null {
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    if (boundsMatch(bounds, getSplitTile(container, edge))) return edge;
  }
  return null;
}

function applyWindowBoundsUpdate(win: FloatingWindow, updates: Partial<FloatingWindow>): FloatingWindow {
  const merged: FloatingWindow = { ...win, ...updates };
  const hasBoundsUpdate = hasWindowBoundsUpdate(updates);

  if (hasBoundsUpdate && !merged.maximized) {
    Object.assign(merged, clampToViewport({
      x: merged.x,
      y: merged.y,
      width: merged.width,
      height: merged.height,
    }));
  }

  if (updates.restoreBounds) {
    merged.restoreBounds = clampToViewport(updates.restoreBounds);
  }

  return merged;
}

function hasWindowBoundsUpdate(updates: Partial<FloatingWindow>): boolean {
  return updates.x !== undefined
    || updates.y !== undefined
    || updates.width !== undefined
    || updates.height !== undefined;
}

function looksLikeResize(previous: FloatingWindow, next: FloatingWindow): boolean {
  const previousBounds = getVisibleBounds(previous);
  const nextBounds = getVisibleBounds(next);
  const sameOrigin = Math.abs(previousBounds.x - nextBounds.x) <= TILE_TOLERANCE
    && Math.abs(previousBounds.y - nextBounds.y) <= TILE_TOLERANCE;
  const sizeChanged = Math.abs(previousBounds.width - nextBounds.width) > TILE_TOLERANCE
    || Math.abs(previousBounds.height - nextBounds.height) > TILE_TOLERANCE;
  const previousWasFull = Math.abs(previousBounds.x) <= TILE_TOLERANCE
    && Math.abs(previousBounds.y) <= TILE_TOLERANCE
    && Math.abs(previousBounds.width - getFullViewportBounds().width) <= TILE_TOLERANCE
    && Math.abs(previousBounds.height - getFullViewportBounds().height) <= TILE_TOLERANCE;

  return sameOrigin && sizeChanged && !previousWasFull;
}

function maybeSplitPartner(previousWindows: FloatingWindow[], windows: FloatingWindow[], activeId: string): FloatingWindow[] {
  const previousActive = previousWindows.find(w => w.id === activeId);
  const active = windows.find(w => w.id === activeId);
  if (!previousActive || !active || active.minimized || active.maximized) return windows;
  if (looksLikeResize(previousActive, active)) return windows;

  const activeBounds = {
    x: active.x,
    y: active.y,
    width: active.width,
    height: active.height,
  };
  const activeCanvasId = active.canvasId || 'base';
  const visiblePartners = windows
    .filter(w => w.id !== activeId && !w.minimized && (w.canvasId || 'base') === activeCanvasId)
    .sort((a, b) => b.zIndex - a.zIndex);

  const viewportBounds = getFullViewportBounds();
  const workspaceEdge = getTileEdge(activeBounds, viewportBounds);
  if (workspaceEdge) {
    const partner = visiblePartners[0];
    if (!partner) return windows;
    const partnerBounds = clampToViewport(getComplementaryTile(viewportBounds, workspaceEdge));
    const groupId = partner.groupId || active.groupId || generateGroupId();
    return cleanupSoloGroups(windows.map(w => {
      if (w.id === partner.id) {
        return { ...w, ...partnerBounds, maximized: false, restoreBounds: partnerBounds, groupId };
      }
      if (w.id === activeId) return { ...w, groupId };
      return w;
    }));
  }

  const splitTarget = visiblePartners
    .map(partner => {
      const container = getVisibleBounds(partner);
      const edge = getTileEdge(activeBounds, container);
      return edge ? { partner, container, edge } : null;
    })
    .find(Boolean);
  if (!splitTarget) return windows;

  const partnerBounds = clampToViewport(getComplementaryTile(splitTarget.container, splitTarget.edge));
  const groupId = splitTarget.partner.groupId || active.groupId || generateGroupId();
  return cleanupSoloGroups(windows.map(w => {
    if (w.id === splitTarget.partner.id) {
      return { ...w, ...partnerBounds, maximized: false, restoreBounds: partnerBounds, groupId };
    }
    if (w.id === activeId) return { ...w, groupId };
    return w;
  }));
}

// If `after`'s resize moved an edge that used to touch `sibling` (they were
// tiled flush against each other), move sibling's matching edge to follow —
// reproduces "drag the shared divider" so a tiled pair resizes as one unit.
// Returns null when this sibling doesn't share a moved edge with `before`.
function mirrorResizeOntoSibling(before: WindowBounds, after: WindowBounds, sibling: WindowBounds): WindowBounds | null {
  let result: WindowBounds | null = null;

  const leftMoved = Math.abs(after.x - before.x) > TILE_TOLERANCE;
  const rightHeld = Math.abs((after.x + after.width) - (before.x + before.width)) <= TILE_TOLERANCE;
  const rightMoved = Math.abs((after.x + after.width) - (before.x + before.width)) > TILE_TOLERANCE;
  const leftHeld = Math.abs(after.x - before.x) <= TILE_TOLERANCE;

  if (leftMoved && rightHeld && Math.abs((sibling.x + sibling.width) - before.x) <= TILE_TOLERANCE) {
    result = { ...sibling, width: Math.max(MIN_WINDOW_WIDTH, after.x - sibling.x) };
  } else if (rightMoved && leftHeld && Math.abs(sibling.x - (before.x + before.width)) <= TILE_TOLERANCE) {
    const newX = after.x + after.width;
    result = { ...sibling, x: newX, width: Math.max(MIN_WINDOW_WIDTH, (sibling.x + sibling.width) - newX) };
  }

  const topMoved = Math.abs(after.y - before.y) > TILE_TOLERANCE;
  const bottomHeld = Math.abs((after.y + after.height) - (before.y + before.height)) <= TILE_TOLERANCE;
  const bottomMoved = Math.abs((after.y + after.height) - (before.y + before.height)) > TILE_TOLERANCE;
  const topHeld = Math.abs(after.y - before.y) <= TILE_TOLERANCE;

  if (topMoved && bottomHeld && Math.abs((sibling.y + sibling.height) - before.y) <= TILE_TOLERANCE) {
    result = { ...(result || sibling), height: Math.max(MIN_WINDOW_HEIGHT, after.y - sibling.y) };
  } else if (bottomMoved && topHeld && Math.abs(sibling.y - (before.y + before.height)) <= TILE_TOLERANCE) {
    const newY = after.y + after.height;
    result = { ...(result || sibling), y: newY, height: Math.max(MIN_WINDOW_HEIGHT, (sibling.y + sibling.height) - newY) };
  }

  return result;
}

// Keeps a tiled group moving/resizing as one unit: a plain drag translates
// every sibling by the same delta; a resize mirrors the moved edge onto
// whichever sibling shares it, so the shared divider tracks the drag.
function syncGroupBounds(
  windows: FloatingWindow[],
  before: FloatingWindow,
  after: FloatingWindow,
  interaction?: WindowUpdateOptions['interaction'],
): FloatingWindow[] {
  const groupId = after.groupId;
  if (!groupId) return windows;

  const beforeBounds = getVisibleBounds(before);
  const afterBounds = getVisibleBounds(after);
  const dx = afterBounds.x - beforeBounds.x;
  const dy = afterBounds.y - beforeBounds.y;
  const resized = afterBounds.width !== beforeBounds.width || afterBounds.height !== beforeBounds.height;

  return windows.map(w => {
    if (w.id === after.id || w.groupId !== groupId) return w;

    if (interaction === 'resize' && resized) {
      const mirrored = mirrorResizeOntoSibling(beforeBounds, afterBounds, getVisibleBounds(w));
      return mirrored ? { ...w, ...clampToViewport(mirrored), maximized: false } : w;
    }

    if (dx === 0 && dy === 0) return w;
    return { ...w, ...clampToViewport({ x: w.x + dx, y: w.y + dy, width: w.width, height: w.height }), maximized: false };
  });
}

function fillSoleVisibleWindow(windows: FloatingWindow[]): FloatingWindow[] {
  const visibleByCanvas = windows.reduce<Record<string, FloatingWindow[]>>((groups, win) => {
    if (win.minimized) return groups;
    const canvasId = win.canvasId || 'base';
    groups[canvasId] = [...(groups[canvasId] || []), win];
    return groups;
  }, {});

  const fullBounds = getFullViewportBounds();
  const fillIds = new Set(
    Object.values(visibleByCanvas)
      .filter(group => group.length === 1)
      .map(group => group[0].id)
  );
  if (fillIds.size === 0) return windows;

  return windows.map(w => (
    fillIds.has(w.id)
      ? {
          ...w,
          ...fullBounds,
          maximized: false,
        }
      : w
  ));
}

export function useWindows() {
  const [windows, setWindows] = useState<FloatingWindow[]>([]);
  const [selectedWindowIds, setSelectedWindowIds] = useState<string[]>([]);
  const lastBoundsByWindowKey = useRef<Record<string, WindowBounds>>({});
  const nextZIndexRef = useRef(100);

  const rememberWindowBounds = useCallback((win: FloatingWindow) => {
    lastBoundsByWindowKey.current[getWindowIdentityKey(win)] = getVisibleBounds(win);
  }, []);

  const openWindow = useCallback((
    type: FloatingWindowType,
    opts?: { title?: string; sessionId?: string; documentId?: string; canvasId?: string; ownerUserId?: string | null; focusTaskId?: string }
  ) => {
    setWindows(prev => {
      if (opts?.sessionId) {
        const existing = prev.find(w => w.sessionId === opts.sessionId && w.canvasId === opts.canvasId);
        if (existing) {
          nextZIndexRef.current++;
          return prev.map(w =>
            w.id === existing.id
              ? { ...w, minimized: false, zIndex: nextZIndexRef.current }
              : w
          );
        }
      }
      if (opts?.documentId) {
        const existing = prev.find(w => w.documentId === opts.documentId && w.canvasId === opts.canvasId);
        if (existing) {
          nextZIndexRef.current++;
          return prev.map(w =>
            w.id === existing.id
              ? { ...w, minimized: false, zIndex: nextZIndexRef.current }
              : w
          );
        }
      }

      nextZIndexRef.current++;

      const restoreSize = getDefaultRestoreSize(type);
      const restorePos = getSpawnPosition(prev, restoreSize);
      const restoreBounds = clampToViewport({
        x: restorePos.x,
        y: restorePos.y,
        width: restoreSize.width,
        height: restoreSize.height,
      });
      const rememberedBounds = lastBoundsByWindowKey.current[getWindowIdentityKey({ type, ...opts })];
      const bounds = rememberedBounds ? clampToViewport(rememberedBounds) : getFullViewportBounds();

      const win: FloatingWindow = {
        id: generateId(),
        type,
        title: opts?.title || (type === 'chat' ? 'Untitled' : 'Untitled'),
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        zIndex: nextZIndexRef.current,
        minimized: false,
        maximized: false,
        restoreBounds: rememberedBounds ? bounds : restoreBounds,
        canvasId: opts?.canvasId,
        sessionId: opts?.sessionId,
        documentId: opts?.documentId,
        ownerUserId: opts?.ownerUserId ?? null,
        isPrivate: false,
        locked: false,
        shared: false,
        focusTaskId: opts?.focusTaskId,
      };

      return [...prev, win];
    });
  }, []);

  // Open a chat window as a side-by-side split of an existing thread's window:
  // the source is tiled to the left half, the fork to the right half, and both
  // share a groupId so the existing tiled-pair move/resize logic treats them as
  // one unit. Falls back to a full-viewport window if the source isn't open.
  const openSplitWindow = useCallback((
    sourceSessionId: string,
    opts: { title?: string; sessionId: string; canvasId?: string; ownerUserId?: string | null },
  ) => {
    setWindows(prev => {
      // Fork already open on this canvas — just surface it.
      const existingFork = prev.find(w => w.sessionId === opts.sessionId && w.canvasId === opts.canvasId);
      if (existingFork) {
        nextZIndexRef.current++;
        return prev.map(w =>
          w.id === existingFork.id ? { ...w, minimized: false, zIndex: nextZIndexRef.current } : w);
      }

      const canvasKey = opts.canvasId || 'base';
      const source = prev.find(w => w.sessionId === sourceSessionId && (w.canvasId || 'base') === canvasKey);
      const viewport = getFullViewportBounds();
      const leftBounds = clampToViewport(getSplitTile(viewport, 'left'));
      const rightBounds = clampToViewport(getComplementaryTile(viewport, 'left'));
      const groupId = source?.groupId || generateGroupId();

      nextZIndexRef.current++;
      const forkBounds = source ? rightBounds : getFullViewportBounds();
      const fork: FloatingWindow = {
        id: generateId(),
        type: 'chat',
        title: opts.title || 'Untitled',
        x: forkBounds.x,
        y: forkBounds.y,
        width: forkBounds.width,
        height: forkBounds.height,
        zIndex: nextZIndexRef.current,
        minimized: false,
        maximized: false,
        restoreBounds: forkBounds,
        canvasId: opts.canvasId,
        sessionId: opts.sessionId,
        ownerUserId: opts.ownerUserId ?? null,
        isPrivate: false,
        locked: false,
        shared: false,
        groupId: source ? groupId : null,
      };

      const withSource = source
        ? prev.map(w => w.id === source.id
            ? { ...w, ...leftBounds, minimized: false, maximized: false, restoreBounds: leftBounds, groupId }
            : w)
        : prev;

      return [...withSource, fork];
    });
  }, []);

  const closeWindow = useCallback((id: string) => {
    setWindows(prev => {
      const closing = prev.find(w => w.id === id);
      if (closing) rememberWindowBounds(closing);
      return cleanupSoloGroups(fillSoleVisibleWindow(prev.filter(w => w.id !== id)));
    });
  }, [rememberWindowBounds]);

  const focusWindow = useCallback((id: string) => {
    nextZIndexRef.current++;
    setWindows(prev =>
      prev.map(w => w.id === id ? { ...w, zIndex: nextZIndexRef.current } : w)
    );
  }, []);

  // Drop every open window at once. Windows are in-memory only and their
  // canvasId ('base' for a workspace's default layer) is not unique across
  // workspaces, so switching workspaces must clear them or the previous
  // workspace's windows leak into the new one's canvas.
  const closeAllWindows = useCallback(() => {
    setWindows([]);
    setSelectedWindowIds([]);
  }, []);

  // Dock-driven group actions: a tiled pair/cluster is shown as one unit in
  // the dock, so focusing or minimizing any member brings (or hides) the
  // whole group together instead of just the clicked window.
  const focusWindowGroup = useCallback((groupId: string, leadId: string) => {
    setWindows(prev => {
      const members = prev.filter(w => w.groupId === groupId);
      if (members.length === 0) return prev;
      const ordered = [...members.filter(w => w.id !== leadId), ...members.filter(w => w.id === leadId)];
      const zById = new Map<string, number>();
      ordered.forEach(w => {
        nextZIndexRef.current++;
        zById.set(w.id, nextZIndexRef.current);
      });
      return prev.map(w => (zById.has(w.id) ? { ...w, zIndex: zById.get(w.id)!, minimized: false } : w));
    });
  }, []);

  const minimizeWindowGroup = useCallback((groupId: string) => {
    setWindows(prev => prev.map(w => (w.groupId === groupId ? { ...w, minimized: true } : w)));
  }, []);

  const ungroupTiledWindows = useCallback((groupId: string) => {
    setWindows(prev => prev.map(w => (w.groupId === groupId ? { ...w, groupId: null } : w)));
  }, []);

  const updateWindow = useCallback((id: string, updates: Partial<FloatingWindow>, options?: WindowUpdateOptions) => {
    setWindows(prev => {
      const before = prev.find(w => w.id === id);
      const updated = prev.map(w => w.id === id ? applyWindowBoundsUpdate(w, updates) : w);
      if (!hasWindowBoundsUpdate(updates)) return updated;

      // Already-grouped windows move/resize as a unit instead of going through
      // split-detection again — the group itself was formed by an earlier drag.
      if (before?.groupId) {
        const after = updated.find(w => w.id === id);
        return after ? syncGroupBounds(updated, before, after, options?.interaction) : updated;
      }

      if (options?.interaction !== 'drag') return updated;
      return maybeSplitPartner(prev, updated, id);
    });
  }, []);

  const minimizeWindow = useCallback((id: string) => {
    setWindows(prev =>
      prev.map(w => {
        if (w.id !== id) return w;
        if (!w.minimized) return { ...w, minimized: true };

        return { ...w, minimized: false };
      })
    );
  }, []);

  return { windows, openWindow, openSplitWindow, closeWindow, closeAllWindows, focusWindow, updateWindow, minimizeWindow, selectedWindowIds, setSelectedWindowIds, focusWindowGroup, minimizeWindowGroup, ungroupTiledWindows };
}
