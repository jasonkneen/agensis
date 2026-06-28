import { useState, useCallback } from 'react';
import type { FloatingWindow, FloatingWindowType } from '../types';

let nextZIndex = 100;
const WORKSPACE_WINDOW_MARGIN = 24;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 260;

type WindowBounds = { x: number; y: number; width: number; height: number };

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

function restoreOpenedWindow(win: FloatingWindow) {
  const viewport = getWorkspaceViewportSize();
  const isFullViewport = win.maximized
    || win.width >= viewport.width - 24
    || win.height >= viewport.height - 24;
  const fallbackSize = getDefaultRestoreSize(win.type);
  const fallbackPosition = getSpawnPosition([], fallbackSize);
  const source = win.maximized && win.restoreBounds
    ? win.restoreBounds
    : isFullViewport
    ? { ...fallbackPosition, ...fallbackSize }
    : (win.restoreBounds || { x: win.x, y: win.y, width: win.width, height: win.height });
  const next = clampToViewport(source);
  return {
    ...win,
    ...next,
    minimized: false,
    maximized: false,
    restoreBounds: next,
  };
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
            w.id === existing.id ? { ...restoreOpenedWindow(w), zIndex: nextZIndex } : w
          );
        }
      }
      if (opts?.documentId) {
        const existing = prev.find(w => w.documentId === opts.documentId && w.canvasId === opts.canvasId);
        if (existing) {
          nextZIndex++;
          return prev.map(w =>
            w.id === existing.id ? { ...restoreOpenedWindow(w), zIndex: nextZIndex } : w
          );
        }
      }

      nextZIndex++;

      const size = getDefaultRestoreSize(type);
      const pos = getSpawnPosition(prev, size);
      const bounds = clampToViewport({
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
      });

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
        restoreBounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
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
    setWindows(prev => prev.filter(w => w.id !== id));
  }, []);

  const focusWindow = useCallback((id: string) => {
    nextZIndex++;
    setWindows(prev =>
      prev.map(w => w.id === id ? { ...w, zIndex: nextZIndex } : w)
    );
  }, []);

  const updateWindow = useCallback((id: string, updates: Partial<FloatingWindow>) => {
    setWindows(prev =>
      prev.map(w => w.id === id ? applyWindowBoundsUpdate(w, updates) : w)
    );
  }, []);

  const minimizeWindow = useCallback((id: string) => {
    setWindows(prev =>
      prev.map(w => {
        if (w.id !== id) return w;
        if (!w.minimized) return { ...w, minimized: true };

        return restoreOpenedWindow(w);
      })
    );
  }, []);

  return { windows, openWindow, closeWindow, focusWindow, updateWindow, minimizeWindow };
}
