import { useState, useCallback } from 'react';
import type { FloatingWindow, FloatingWindowType } from '../types';

let nextZIndex = 100;
const WORKSPACE_WINDOW_MARGIN = 24;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 260;
const TILE_TOLERANCE = 12;

type WindowBounds = { x: number; y: number; width: number; height: number };
type TileEdge = 'left' | 'right' | 'top' | 'bottom';

function generateId(): string {
  return `win_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

  return { width: window.innerWidth, height: window.innerHeight };
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
    height: clampDimension(size.height, MIN_WINDOW_HEIGHT, Math.max(1, viewport.height - margin * 2)),
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
    agents: { width: Math.min(760, Math.max(520, Math.round(viewport.width * 0.58))), height: Math.min(760, Math.max(560, Math.round(viewport.height * 0.76))) },
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
  const maxY = Math.max(0, viewport.height - size.height - WORKSPACE_WINDOW_MARGIN);
  const minX = Math.min(WORKSPACE_WINDOW_MARGIN, maxX);
  const minY = Math.min(WORKSPACE_WINDOW_MARGIN, maxY);
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
  const size = fitWindowSize(bounds, viewport);
  const maxX = Math.max(0, viewport.width - size.width);
  const maxY = Math.max(0, viewport.height - size.height);

  return {
    x: Math.round(clampNumber(bounds.x, 0, maxX)),
    y: Math.round(clampNumber(bounds.y, 0, maxY)),
    width: size.width,
    height: size.height,
  };
}

function getFullViewportBounds(): WindowBounds {
  const viewport = getWorkspaceViewportSize();
  return {
    x: 0,
    y: 0,
    width: Math.round(Math.max(1, viewport.width)),
    height: Math.round(Math.max(1, viewport.height)),
  };
}

function getTileEdge(bounds: WindowBounds): TileEdge | null {
  const viewport = getWorkspaceViewportSize();
  const fullWidth = Math.round(viewport.width);
  const fullHeight = Math.round(viewport.height);
  const halfWidth = Math.max(MIN_WINDOW_WIDTH, Math.round(fullWidth / 2));
  const halfHeight = Math.max(MIN_WINDOW_HEIGHT, Math.round(fullHeight / 2));

  const near = (a: number, b: number) => Math.abs(a - b) <= TILE_TOLERANCE;

  if (near(bounds.y, 0) && near(bounds.height, fullHeight)) {
    if (near(bounds.x, 0) && near(bounds.width, halfWidth)) return 'left';
    if (near(bounds.x, fullWidth - halfWidth) && near(bounds.width, halfWidth)) return 'right';
  }

  if (near(bounds.x, 0) && near(bounds.width, fullWidth)) {
    if (near(bounds.y, 0) && near(bounds.height, halfHeight)) return 'top';
    if (near(bounds.y, fullHeight - halfHeight) && near(bounds.height, halfHeight)) return 'bottom';
  }

  return null;
}

function getComplementaryTile(edge: TileEdge): WindowBounds {
  const viewport = getWorkspaceViewportSize();
  const fullWidth = Math.round(viewport.width);
  const fullHeight = Math.round(viewport.height);
  const halfWidth = Math.max(MIN_WINDOW_WIDTH, Math.round(fullWidth / 2));
  const halfHeight = Math.max(MIN_WINDOW_HEIGHT, Math.round(fullHeight / 2));

  if (edge === 'left') return { x: halfWidth, y: 0, width: Math.max(1, fullWidth - halfWidth), height: fullHeight };
  if (edge === 'right') return { x: 0, y: 0, width: Math.max(1, fullWidth - halfWidth), height: fullHeight };
  if (edge === 'top') return { x: 0, y: halfHeight, width: fullWidth, height: Math.max(1, fullHeight - halfHeight) };
  return { x: 0, y: 0, width: fullWidth, height: Math.max(1, fullHeight - halfHeight) };
}

function applyWindowBoundsUpdate(win: FloatingWindow, updates: Partial<FloatingWindow>): FloatingWindow {
  const merged: FloatingWindow = { ...win, ...updates };
  const hasBoundsUpdate = updates.x !== undefined
    || updates.y !== undefined
    || updates.width !== undefined
    || updates.height !== undefined;

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

function maybeSplitPartner(windows: FloatingWindow[], activeId: string): FloatingWindow[] {
  const active = windows.find(w => w.id === activeId);
  if (!active || active.minimized || active.maximized) return windows;

  const activeBounds = {
    x: active.x,
    y: active.y,
    width: active.width,
    height: active.height,
  };
  const edge = getTileEdge(activeBounds);
  if (!edge) return windows;

  const activeCanvasId = active.canvasId || 'base';
  const partner = windows
    .filter(w => w.id !== activeId && !w.minimized && (w.canvasId || 'base') === activeCanvasId)
    .sort((a, b) => b.zIndex - a.zIndex)[0];
  if (!partner) return windows;

  const partnerBounds = clampToViewport(getComplementaryTile(edge));
  return windows.map(w => (
    w.id === partner.id
      ? {
          ...w,
          ...partnerBounds,
          maximized: false,
          restoreBounds: partnerBounds,
        }
      : w
  ));
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

  const openWindow = useCallback((
    type: FloatingWindowType,
    opts?: { title?: string; sessionId?: string; documentId?: string; canvasId?: string; ownerUserId?: string | null }
  ) => {
    setWindows(prev => {
      if (opts?.sessionId) {
        const existing = prev.find(w => w.sessionId === opts.sessionId && w.canvasId === opts.canvasId);
        if (existing) {
          nextZIndex++;
          return prev.map(w =>
            w.id === existing.id
              ? { ...w, minimized: false, zIndex: nextZIndex }
              : w
          );
        }
      }
      if (opts?.documentId) {
        const existing = prev.find(w => w.documentId === opts.documentId && w.canvasId === opts.canvasId);
        if (existing) {
          nextZIndex++;
          return prev.map(w =>
            w.id === existing.id
              ? { ...w, minimized: false, zIndex: nextZIndex }
              : w
          );
        }
      }

      nextZIndex++;

      const restoreSize = getDefaultRestoreSize(type);
      const restorePos = getSpawnPosition(prev, restoreSize);
      const restoreBounds = clampToViewport({
        x: restorePos.x,
        y: restorePos.y,
        width: restoreSize.width,
        height: restoreSize.height,
      });
      const bounds = getFullViewportBounds();

      const win: FloatingWindow = {
        id: generateId(),
        type,
        title: opts?.title || (type === 'chat' ? 'Untitled' : 'Untitled'),
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        zIndex: nextZIndex,
        minimized: false,
        maximized: false,
        restoreBounds,
        canvasId: opts?.canvasId,
        sessionId: opts?.sessionId,
        documentId: opts?.documentId,
        ownerUserId: opts?.ownerUserId ?? null,
        isPrivate: false,
        locked: false,
        shared: false,
      };

      return [...prev, win];
    });
  }, []);

  const closeWindow = useCallback((id: string) => {
    setWindows(prev => fillSoleVisibleWindow(prev.filter(w => w.id !== id)));
  }, []);

  const focusWindow = useCallback((id: string) => {
    nextZIndex++;
    setWindows(prev =>
      prev.map(w => w.id === id ? { ...w, zIndex: nextZIndex } : w)
    );
  }, []);

  const updateWindow = useCallback((id: string, updates: Partial<FloatingWindow>) => {
    setWindows(prev => {
      const updated = prev.map(w => w.id === id ? applyWindowBoundsUpdate(w, updates) : w);
      return maybeSplitPartner(updated, id);
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

  return { windows, openWindow, closeWindow, focusWindow, updateWindow, minimizeWindow };
}
