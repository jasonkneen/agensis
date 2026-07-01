import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ListTodo,
  ListChecks,
  Hand,
  X,
  Maximize2,
  Minimize2,
  CornerDownRight,
  Plus,
  Check,
  Send,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useThreadItems } from '@/hooks/useThreadItems';
import type { ThreadItem, ThreadItemKind } from '@/types';

// ---------------------------------------------------------------------------
// Floating widget overlay — cards float over the empty right gutter of the
// message list (NOT a side panel). The overlay wrapper is click-through
// (pointer-events-none); only the cards themselves capture events, so the
// messages underneath stay scrollable/clickable in the gaps. The parent
// reserves matching right padding on the message column so a card never sits
// on top of message text.
//
// Layout (which widgets, their size + order) persists per session in
// localStorage so the arrangement survives reloads without a backend table.
// ---------------------------------------------------------------------------

type WidgetSize = 1 | 2;
interface WidgetLayout {
  kind: ThreadItemKind;
  w: WidgetSize;
  h: WidgetSize;
}

const DEFAULT_WIDGETS: WidgetLayout[] = [
  { kind: 'todo', w: 1, h: 2 },
  { kind: 'plan', w: 1, h: 2 },
  { kind: 'blocker', w: 2, h: 1 },
];

const KIND_META: Record<ThreadItemKind, { label: string; icon: typeof ListTodo; empty: string }> = {
  todo: { label: 'To-do', icon: ListTodo, empty: 'No to-dos yet' },
  plan: { label: 'Plan', icon: ListChecks, empty: 'No plan yet' },
  blocker: { label: 'Blockers', icon: Hand, empty: 'Nothing blocked' },
};

const ALL_KINDS: ThreadItemKind[] = ['todo', 'plan', 'blocker'];

function layoutKey(sessionId: string) {
  return `thread-widgets:${sessionId}`;
}

function loadWidgets(sessionId: string): WidgetLayout[] {
  try {
    const raw = localStorage.getItem(layoutKey(sessionId));
    if (!raw) return DEFAULT_WIDGETS;
    const parsed = JSON.parse(raw) as { widgets?: WidgetLayout[] };
    if (!parsed || !Array.isArray(parsed.widgets)) return DEFAULT_WIDGETS;
    const seen = new Set<ThreadItemKind>();
    return parsed.widgets
      .filter(w => ALL_KINDS.includes(w.kind) && !seen.has(w.kind) && seen.add(w.kind))
      .map(w => ({ kind: w.kind, w: (w.w === 2 ? 2 : 1) as WidgetSize, h: (w.h === 2 ? 2 : 1) as WidgetSize }));
  } catch {
    return DEFAULT_WIDGETS;
  }
}

// ---------------------------------------------------------------------------

interface ThreadWidgetRailProps {
  workspaceId: string | null;
  sessionId: string | null;
  userId?: string;
  accent?: string;
  collapsed: boolean;
  onTooNarrowChange?: (tooNarrow: boolean) => void;
  onJumpToMessage?: (messageId: string) => void;
  onBlockerAnswered?: (item: ThreadItem, response: string) => void;
}

export function ThreadWidgetRail({
  workspaceId,
  sessionId,
  userId,
  accent,
  collapsed,
  onTooNarrowChange,
  onJumpToMessage,
  onBlockerAnswered,
}: ThreadWidgetRailProps) {
  const { byKind, loading, toggleDone, answerBlocker, deleteItem } = useThreadItems(
    workspaceId,
    sessionId,
    userId,
  );

  // Answering a blocker flips the item to `answered` (in-widget confirmation)
  // AND posts the Q&A back into the chat so it's tracked in the thread and the
  // agent that raised it actually gets woken with the answer.
  const handleAnswer = useCallback((item: ThreadItem, response: string) => {
    answerBlocker(item, response);
    onBlockerAnswered?.(item, response);
  }, [answerBlocker, onBlockerAnswered]);

  const [widgets, setWidgets] = useState<WidgetLayout[]>(DEFAULT_WIDGETS);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Responsive: when the chat surface is too narrow for the cards to float
  // without covering messages, hide the whole rail behind the reopen button.
  const rootRef = useRef<HTMLDivElement>(null);
  const [tooNarrow, setTooNarrow] = useState(false);
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const narrow = e.contentRect.width < 520;
        setTooNarrow(narrow);
        onTooNarrowChange?.(narrow);
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [sessionId, onTooNarrowChange]);

  // Load the saved arrangement whenever the thread changes.
  useEffect(() => {
    if (!sessionId) return;
    setWidgets(loadWidgets(sessionId));
  }, [sessionId]);

  const persist = useCallback((next: WidgetLayout[]) => {
    setWidgets(next);
    if (sessionId) {
      try { localStorage.setItem(layoutKey(sessionId), JSON.stringify({ widgets: next })); } catch { /* ignore quota */ }
    }
  }, [sessionId]);

  const cycleSize = useCallback((index: number) => {
    const next = widgets.slice();
    const cur = next[index];
    if (!cur) return;
    // cycle 1x1 -> 1x2 -> 2x1 -> 2x2 -> 1x1
    const order: Array<[WidgetSize, WidgetSize]> = [[1, 1], [1, 2], [2, 1], [2, 2]];
    const idx = order.findIndex(([w, h]) => w === cur.w && h === cur.h);
    const [w, h] = order[(idx + 1) % order.length];
    next[index] = { ...cur, w, h };
    persist(next);
  }, [widgets, persist]);

  const closeWidget = useCallback((kind: ThreadItemKind) => {
    persist(widgets.filter(w => w.kind !== kind));
  }, [widgets, persist]);

  const reorder = useCallback((from: number, to: number) => {
    if (from === to) return;
    const next = widgets.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persist(next);
  }, [widgets, persist]);

  // Kinds the user has closed — offered back via the "+ add" chips so a closed
  // widget is never lost with no way to restore it.
  const closedKinds = useMemo(
    () => ALL_KINDS.filter(k => !widgets.some(w => w.kind === k)),
    [widgets],
  );

  const addWidget = useCallback((kind: ThreadItemKind) => {
    if (widgets.some(w => w.kind === kind)) return;
    persist([...widgets, { kind, w: 1, h: 2 }]);
  }, [widgets, persist]);

  if (!sessionId || !workspaceId) return null;

  const hidden = collapsed || tooNarrow;

  return (
    // Click-through overlay pinned to the right gutter of the message surface.
    // The container stays mounted even when hidden so the ResizeObserver keeps
    // reporting width; the toggle now lives in the chat header (not here), so
    // it no longer clashes with the per-message action toolbar.
    <div ref={rootRef} className="thread-widget-overlay pointer-events-none absolute inset-y-0 right-1 z-10 flex w-[272px] flex-col gap-2 px-3 py-3">
      {!hidden && (
        <>
          {/* re-add chips for any widget the user has closed */}
          {closedKinds.length > 0 && (
            <div className="pointer-events-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
              {closedKinds.map(kind => (
                <button
                  key={kind}
                  type="button"
                  className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm transition-colors hover:text-foreground"
                  title={`Add ${KIND_META[kind].label} widget`}
                  onClick={() => addWidget(kind)}
                >
                  <Plus className="size-2.5" />
                  {KIND_META[kind].label}
                </button>
              ))}
            </div>
          )}

          <div className="pointer-events-auto grid min-h-0 max-h-full grid-cols-2 content-start gap-2 overflow-y-auto overflow-x-visible px-3 -mx-3 [grid-auto-flow:dense] [grid-auto-rows:116px]">
            {widgets.map((w, index) => (
              <WidgetCard
                key={w.kind}
                index={index}
                layout={w}
                items={byKind[w.kind]}
                loading={loading}
                accent={accent}
                isDragTarget={dropIndex === index && dragIndex !== index}
                onDragStart={() => setDragIndex(index)}
                onDragOver={() => setDropIndex(index)}
                onDragEnd={() => {
                  if (dragIndex !== null && dropIndex !== null) reorder(dragIndex, dropIndex);
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onResize={() => cycleSize(index)}
                onClose={() => closeWidget(w.kind)}
                onToggleDone={toggleDone}
                onAnswer={handleAnswer}
                onDelete={deleteItem}
                onJumpToMessage={onJumpToMessage}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface WidgetCardProps {
  index: number;
  layout: WidgetLayout;
  items: ThreadItem[];
  loading: boolean;
  accent?: string;
  isDragTarget: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  onResize: () => void;
  onClose: () => void;
  onToggleDone: (item: ThreadItem) => void;
  onAnswer: (item: ThreadItem, response: string) => void;
  onDelete: (id: string) => void;
  onJumpToMessage?: (messageId: string) => void;
}

function WidgetCard({
  layout,
  items,
  loading,
  accent,
  isDragTarget,
  onDragStart,
  onDragOver,
  onDragEnd,
  onResize,
  onClose,
  onToggleDone,
  onAnswer,
  onDelete,
  onJumpToMessage,
}: WidgetCardProps) {
  const meta = KIND_META[layout.kind];
  const Icon = meta.icon;
  const openCount = items.filter(i => i.status === 'open').length;

  return (
    <div
      className={cn(
        'thread-widget thread-widget-card group/card pointer-events-auto relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-shadow',
        layout.w === 2 ? 'col-span-2' : 'col-span-1',
        layout.h === 2 ? 'row-span-2' : 'row-span-1',
        isDragTarget && 'ring-2 ring-primary/60',
      )}
      onDragOver={e => { e.preventDefault(); onDragOver(); }}
    >
      {/* header — whole row is the drag handle, no divider, no grip clutter */}
      <div
        className="flex shrink-0 cursor-grab items-center gap-1.5 px-3 pt-2.5 pb-1 active:cursor-grabbing"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <Icon className="size-3.5 shrink-0" style={accent ? { color: accent } : undefined} />
        <span className="truncate text-xs font-semibold tracking-tight">{meta.label}</span>
        {items.length > 0 && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium leading-4 text-muted-foreground">
            {openCount || items.length}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/card:opacity-100"
          title="Resize"
          aria-label="Resize widget"
          onClick={onResize}
        >
          {layout.w === 2 && layout.h === 2 ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
        </button>
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/card:opacity-100"
          title="Close"
          aria-label="Close widget"
          onClick={onClose}
        >
          <X className="size-3" />
        </button>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
        {loading && items.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground/70">{meta.empty}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map(item => (
              <WidgetItemRow
                key={item.id}
                item={item}
                onToggleDone={onToggleDone}
                onAnswer={onAnswer}
                onDelete={onDelete}
                onJumpToMessage={onJumpToMessage}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface WidgetItemRowProps {
  item: ThreadItem;
  onToggleDone: (item: ThreadItem) => void;
  onAnswer: (item: ThreadItem, response: string) => void;
  onDelete: (id: string) => void;
  onJumpToMessage?: (messageId: string) => void;
}

function WidgetItemRow({ item, onToggleDone, onAnswer, onDelete, onJumpToMessage }: WidgetItemRowProps) {
  const isBlocker = item.kind === 'blocker';
  const isDone = item.status === 'done';
  const isAnswered = item.status === 'answered';
  const [answering, setAnswering] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (answering) inputRef.current?.focus(); }, [answering]);

  const jump = item.message_id && onJumpToMessage
    ? () => onJumpToMessage(item.message_id as string)
    : undefined;

  const submitAnswer = () => {
    const value = draft.trim();
    if (!value) return;
    onAnswer(item, value);
    setAnswering(false);
    setDraft('');
  };

  return (
    <li className="group/row flex flex-col gap-0.5 rounded-md px-1 py-1 hover:bg-muted/50">
      <div className="flex items-start gap-1.5">
        {isBlocker ? (
          <Hand className={cn('mt-0.5 size-3 shrink-0', isAnswered ? 'text-muted-foreground' : 'text-amber-500')} />
        ) : (
          <button
            type="button"
            className={cn(
              'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border',
              isDone ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-muted-foreground/40',
            )}
            title={isDone ? 'Mark open' : 'Mark done'}
            aria-label={isDone ? 'Mark open' : 'Mark done'}
            onClick={() => onToggleDone(item)}
          >
            {isDone && <Check className="size-2.5" />}
          </button>
        )}
        <button
          type="button"
          className={cn(
            'min-w-0 flex-1 text-left text-[11px] leading-snug',
            isDone && 'text-muted-foreground line-through',
            jump && 'cursor-pointer hover:underline',
          )}
          onClick={jump}
          title={jump ? 'Jump to message' : undefined}
        >
          {item.content}
        </button>
        {jump && <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground/50" />}
        <button
          type="button"
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted group-hover/row:opacity-100"
          title="Delete"
          aria-label="Delete item"
          onClick={() => onDelete(item.id)}
        >
          <X className="size-2.5" />
        </button>
      </div>

      {/* blocker resolution */}
      {isBlocker && (
        isAnswered ? (
          <p className="ml-5 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {item.response}
          </p>
        ) : answering ? (
          <div className="ml-5 flex items-center gap-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); submitAnswer(); }
                if (e.key === 'Escape') { setAnswering(false); setDraft(''); }
              }}
              placeholder="Your answer…"
              className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-[10px] outline-none"
            />
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded bg-primary text-primary-foreground"
              title="Send answer"
              aria-label="Send answer"
              onClick={submitAnswer}
            >
              <Send className="size-2.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="ml-5 w-fit rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 hover:bg-amber-500/25 dark:text-amber-400"
            onClick={() => setAnswering(true)}
          >
            Respond
          </button>
        )
      )}
    </li>
  );
}
