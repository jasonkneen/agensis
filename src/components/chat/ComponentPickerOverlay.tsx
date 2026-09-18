import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { describeElement, type ElementPick } from '../../lib/componentPicker';

// Anything tagged data-picker-ignore is invisible to the picker — the composer,
// this overlay's own popup, etc. — so pointing the inspector at the chat input
// never selects the chat input.
const IGNORE_ATTR = 'data-picker-ignore';

type Rect = { x: number; y: number; width: number; height: number };

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function isIgnored(el: Element | null): boolean {
  return !!el && !!el.closest(`[${IGNORE_ATTR}]`);
}

export function ComponentPickerOverlay({
  active,
  picks,
  onAddPick,
  onDeactivate,
}: {
  active: boolean;
  picks: ElementPick[];
  onAddPick: (pick: Omit<ElementPick, 'id' | 'index'>) => void;
  onDeactivate: () => void;
}) {
  const catcherRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Rect | null>(null);
  // The element frozen for annotation, plus where to float the note popup.
  const [pending, setPending] = useState<{ rect: Rect; describe: ReturnType<typeof describeElement> } | null>(null);
  const [note, setNote] = useState('');
  // Live rects for existing picks, re-derived from their selectors on scroll/resize.
  const [markerRects, setMarkerRects] = useState<Record<string, Rect>>({});

  // Resolve what's under the pointer, ignoring the catcher itself and the composer.
  const elementUnder = useCallback((clientX: number, clientY: number): Element | null => {
    const catcher = catcherRef.current;
    const prev = catcher?.style.pointerEvents;
    if (catcher) catcher.style.pointerEvents = 'none';
    let el = document.elementFromPoint(clientX, clientY);
    if (catcher) catcher.style.pointerEvents = prev ?? '';
    if (isIgnored(el)) el = null;
    return el;
  }, []);

  const handleMove = useCallback((e: React.MouseEvent) => {
    if (pending) return; // frozen while annotating
    const el = elementUnder(e.clientX, e.clientY);
    setHover(el ? rectOf(el) : null);
  }, [elementUnder, pending]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (pending) return;
    e.preventDefault();
    e.stopPropagation();
    const el = elementUnder(e.clientX, e.clientY);
    if (!el) return;
    setPending({ rect: rectOf(el), describe: describeElement(el) });
    setNote('');
  }, [elementUnder, pending]);

  const commit = useCallback(() => {
    if (!pending) return;
    onAddPick({ ...pending.describe, note, rect: pending.rect });
    setPending(null);
    setNote('');
    setHover(null);
  }, [pending, note, onAddPick]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setNote('');
  }, []);

  // Esc closes the note popup if open, otherwise turns the inspector off.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (pending) cancelPending();
        else onDeactivate();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, pending, cancelPending, onDeactivate]);

  // Re-anchor markers to their live elements. Runs on mount and on scroll/resize.
  useLayoutEffect(() => {
    if (picks.length === 0) {
      setMarkerRects({});
      return;
    }
    const recompute = () => {
      const next: Record<string, Rect> = {};
      for (const p of picks) {
        let live: Element | null = null;
        try {
          live = document.querySelector(p.selector);
        } catch {
          live = null;
        }
        next[p.id] = live ? rectOf(live) : p.rect;
      }
      setMarkerRects(next);
    };
    recompute();
    window.addEventListener('scroll', recompute, true);
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('scroll', recompute, true);
      window.removeEventListener('resize', recompute);
    };
  }, [picks]);

  if (typeof document === 'undefined') return null;
  if (!active && picks.length === 0) return null;

  const markerNodes = picks.map(p => {
    const r = markerRects[p.id] || p.rect;
    return (
      <div
        key={p.id}
        {...{ [IGNORE_ATTR]: '' }}
        className="pointer-events-none fixed z-[9997] flex size-5 items-center justify-center rounded-full bg-primary text-2xs font-bold leading-none text-primary-foreground shadow ring-2 ring-background"
        style={{ left: Math.max(2, r.x - 8), top: Math.max(2, r.y - 8) }}
        title={p.note || p.label}
      >
        {p.index}
      </div>
    );
  });

  return createPortal(
    <>
      {markerNodes}
      {active && (
        <div
          ref={catcherRef}
          {...{ [IGNORE_ATTR]: '' }}
          className="fixed inset-0 z-[9998] cursor-crosshair"
          onMouseMove={handleMove}
          onClick={handleClick}
        >
          {/* hover highlight */}
          {hover && !pending && (
            <div
              className="pointer-events-none absolute rounded-sm border-2 border-primary bg-primary/10"
              style={{ left: hover.x, top: hover.y, width: hover.width, height: hover.height }}
            />
          )}
          {/* frozen selection outline */}
          {pending && (
            <div
              className="pointer-events-none absolute rounded-sm border-2 border-primary bg-primary/15"
              style={{ left: pending.rect.x, top: pending.rect.y, width: pending.rect.width, height: pending.rect.height }}
            />
          )}
          {/* hint bar */}
          {!pending && (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-foreground/90 px-3 py-1 text-xs font-medium text-background shadow">
              Click an element to annotate it · Esc to exit
            </div>
          )}
        </div>
      )}
      {/* note popup — outside the catcher so its own clicks aren't intercepted */}
      {active && pending && (
        <NotePopup
          rect={pending.rect}
          label={pending.describe.label}
          note={note}
          onNoteChange={setNote}
          onSubmit={commit}
          onCancel={cancelPending}
        />
      )}
    </>,
    document.body,
  );
}

function NotePopup({
  rect,
  label,
  note,
  onNoteChange,
  onSubmit,
  onCancel,
}: {
  rect: Rect;
  label: string;
  note: string;
  onNoteChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { taRef.current?.focus(); }, []);

  // Clamp the popup into the viewport, biased below the element.
  const width = 280;
  const left = Math.min(Math.max(8, rect.x), window.innerWidth - width - 8);
  const belowTop = rect.y + rect.height + 8;
  const placeBelow = belowTop + 140 < window.innerHeight;
  const top = placeBelow ? belowTop : Math.max(8, rect.y - 148);

  return (
    <div
      {...{ [IGNORE_ATTR]: '' }}
      className="fixed z-[9999] w-[280px] rounded-lg border border-border bg-popover p-2.5 shadow-xl"
      style={{ left, top }}
    >
      <div className="mb-1.5 truncate text-xs font-medium text-foreground">Note on <span className="text-primary">{label}</span></div>
      <textarea
        ref={taRef}
        value={note}
        onChange={e => onNoteChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        rows={3}
        placeholder="What about this element? (⌘↵ to add)"
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Add
        </button>
      </div>
    </div>
  );
}
