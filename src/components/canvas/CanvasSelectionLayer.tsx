import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useWindowManager } from '../../providers/WindowManagerProvider';

type Point = { x: number; y: number };
type SelectionRect = { x: number; y: number; width: number; height: number };

const MIN_DRAG_SIZE = 8;

function toSelectionRect(start: Point, end: Point): SelectionRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function rectsIntersect(a: SelectionRect, b: SelectionRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function CanvasSelectionLayer() {
  const { windows, selectedWindowIds, setSelectedWindowIds } = useWindowManager();
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ start: Point; pointerId: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<SelectionRect | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedWindowIds([]);
  }, [setSelectedWindowIds]);

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('[data-floating-window]')) {
        clearSelection();
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [clearSelection]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const viewport = layerRef.current?.getBoundingClientRect();
    if (!viewport) return;

    const start = {
      x: e.clientX - viewport.left,
      y: e.clientY - viewport.top,
    };

    dragRef.current = { start, pointerId: e.pointerId };
    setCurrentRect({ x: start.x, y: start.y, width: 0, height: 0 });
    setSelectedWindowIds([]);
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
  }, [setSelectedWindowIds]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const viewport = layerRef.current?.getBoundingClientRect();
    if (!viewport) return;

    const current = {
      x: e.clientX - viewport.left,
      y: e.clientY - viewport.top,
    };
    setCurrentRect(toSelectionRect(dragRef.current.start, current));
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    document.body.style.userSelect = '';

    const viewport = layerRef.current?.getBoundingClientRect();
    if (viewport) {
      const end = {
        x: e.clientX - viewport.left,
        y: e.clientY - viewport.top,
      };
      const selRect = toSelectionRect(dragRef.current.start, end);

      if (selRect.width > MIN_DRAG_SIZE && selRect.height > MIN_DRAG_SIZE) {
        const hits = windows
          .filter(w => !w.minimized && !w.maximized)
          .filter(w => rectsIntersect(selRect, { x: w.x, y: w.y, width: w.width, height: w.height }))
          .map(w => w.id);
        setSelectedWindowIds(hits);
      }
    }

    dragRef.current = null;
    setCurrentRect(null);
  }, [windows, setSelectedWindowIds]);

  const actionBubble = selectedWindowIds.length >= 2 && !currentRect ? (() => {
    const selected = windows.filter(w => selectedWindowIds.includes(w.id));
    if (selected.length === 0) return null;
    const midX = selected.reduce((s, w) => s + w.x + w.width / 2, 0) / selected.length;
    const minY = Math.min(...selected.map(w => w.y));
    return { x: midX, y: Math.max(0, minY - 52) };
  })() : null;

  return (
    <>
      <div
        ref={layerRef}
        className="pointer-events-auto absolute inset-0"
        style={{ zIndex: 0 }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      {currentRect && currentRect.width > MIN_DRAG_SIZE && currentRect.height > MIN_DRAG_SIZE && (
        <div
          className="pointer-events-none absolute rounded border border-primary/70 bg-primary/10"
          style={{
            left: currentRect.x,
            top: currentRect.y,
            width: currentRect.width,
            height: currentRect.height,
            zIndex: 9990,
          }}
        />
      )}

      {actionBubble && (
        <div
          className="absolute flex items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 shadow-md"
          style={{
            left: actionBubble.x,
            top: actionBubble.y,
            transform: 'translateX(-50%)',
            zIndex: 9995,
          }}
          onPointerDown={e => e.stopPropagation()}
        >
          <span className="text-xs text-muted-foreground">{selectedWindowIds.length} windows selected</span>
          <button
            className="ml-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={clearSelection}
            aria-label="Clear selection"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
