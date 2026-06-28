import { useState, useCallback } from 'react';
import type { FloatingWindow, FloatingWindowType } from '../types';

let nextZIndex = 100;

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
  return sizeMap[type] || sizeMap.chat;
}

function getSpawnPosition(
  existing: FloatingWindow[],
  size: { width: number; height: number }
): { x: number; y: number } {
  if (typeof window === 'undefined') {
    return { x: 200, y: 80 };
  }

  const viewport = getWorkspaceViewportSize();
  const maxX = Math.max(24, viewport.width - size.width - 24);
  const maxY = Math.max(24, viewport.height - size.height - 24);
  const baseX = Math.min(maxX, Math.max(24, (viewport.width - size.width) / 2));
  const baseY = Math.min(maxY, Math.max(24, (viewport.height - size.height) / 2));
  const offset = existing.length * 28;

  return {
    x: Math.round(Math.min(maxX, baseX + (offset % 168))),
    y: Math.round(Math.min(maxY, baseY + (offset % 112))),
  };
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
            w.id === existing.id ? { ...w, zIndex: nextZIndex, minimized: false } : w
          );
        }
      }
      if (opts?.documentId) {
        const existing = prev.find(w => w.documentId === opts.documentId && w.canvasId === opts.canvasId);
        if (existing) {
          nextZIndex++;
          return prev.map(w =>
            w.id === existing.id ? { ...w, zIndex: nextZIndex, minimized: false } : w
          );
        }
      }

      nextZIndex++;

      const size = getDefaultRestoreSize(type);
      const pos = getSpawnPosition(prev, size);

      const win: FloatingWindow = {
        id: generateId(),
        type,
        title: opts?.title || (type === 'chat' ? 'Untitled' : 'Untitled'),
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        zIndex: nextZIndex,
        minimized: false,
        maximized: false,
        restoreBounds: {
          x: pos.x,
          y: pos.y,
          width: size.width,
          height: size.height,
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
      prev.map(w => w.id === id ? { ...w, ...updates } : w)
    );
  }, []);

  const minimizeWindow = useCallback((id: string) => {
    setWindows(prev =>
      prev.map(w => w.id === id ? { ...w, minimized: !w.minimized } : w)
    );
  }, []);

  return { windows, openWindow, closeWindow, focusWindow, updateWindow, minimizeWindow };
}
