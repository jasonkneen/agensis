import { useState, useCallback } from 'react';
import type { FloatingWindow, FloatingWindowType } from '../types';

let nextZIndex = 100;

function generateId(): string {
  return `win_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getSpawnPosition(
  existing: FloatingWindow[],
  size: { width: number; height: number }
): { x: number; y: number } {
  if (typeof window === 'undefined') {
    return { x: 200, y: 80 };
  }

  const baseX = Math.max(24, (window.innerWidth - size.width) / 2);
  const baseY = Math.max(24, (window.innerHeight - size.height) / 2);
  const offset = existing.length * 28;

  return {
    x: Math.round(baseX + (offset % 168)),
    y: Math.round(baseY + (offset % 112)),
  };
}

export function useWindows() {
  const [windows, setWindows] = useState<FloatingWindow[]>([]);

  const openWindow = useCallback((
    type: FloatingWindowType,
    opts?: { title?: string; sessionId?: string; documentId?: string; canvasId?: string }
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

      const sizeMap: Record<string, { width: number; height: number }> = {
        chat: { width: 380, height: 500 },
        document: { width: 520, height: 480 },
        memory: { width: 440, height: 520 },
        tasks: { width: 440, height: 540 },
        activity: { width: 400, height: 540 },
        agents: { width: 480, height: 560 },
      };
      const size = sizeMap[type] || sizeMap.chat;
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
        canvasId: opts?.canvasId,
        sessionId: opts?.sessionId,
        documentId: opts?.documentId,
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
