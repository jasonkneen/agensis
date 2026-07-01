import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ListTodo,
  ListChecks,
  Hand,
  X,
  Plus,
  Maximize2,
  Minimize2,
  GripVertical,
  CornerDownRight,
  PanelRightClose,
  PanelRightOpen,
  Check,
  Send,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useThreadItems } from '@/hooks/useThreadItems';
import type { ThreadItem, ThreadItemKind } from '@/types';

// ---------------------------------------------------------------------------
// Layout persistence — per-session widget arrangement lives in localStorage so
// the board survives reloads without needing a backend layout table (v1).
// ---------------------------------------------------------------------------

type WidgetSize = 1 | 2;
interface WidgetLayout {
  kind: ThreadItemKind;
  w: WidgetSize;
  h: WidgetSize;
}
interface RailLayout {
  collapsed: boolean;
  widgets: WidgetLayout[];
}

const DEFAULT_LAYOUT: RailLayout = {
  collapsed: false,
  widgets: [
    { kind: 'todo', w: 1, h: 2 },
    { kind: 'plan', w: 1, h: 2 },
    { kind: 'blocker', w: 2, h: 1 },
  ],
};

const KIND_META: Record<ThreadItemKind, { label: string; icon: typeof ListTodo; addPlaceholder: string; empty: string }> = {
  todo: { label: 'To-do', icon: ListTodo, addPlaceholder: 'Add a to-do…', empty: 'No to-dos yet' },
  plan: { label: 'Plan', icon: ListChecks, addPlaceholder: 'Add a plan step…', empty: 'No plan yet' },
  blocker: { label: 'Blockers', icon: Hand, addPlaceholder: 'Add a blocker…', empty: 'Nothing blocked' },
};

const ALL_KINDS: ThreadItemKind[] = ['todo', 'plan', 'blocker'];

function layoutKey(sessionId: string) {
  return `thread-widgets:${sessionId}`;
}

function loadLayout(sessionId: string): RailLayout {
  try {
    const raw = localStorage.getItem(layoutKey(sessionId));
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as RailLayout;
    if (!parsed || !Array.isArray(parsed.widgets)) return DEFAULT_LAYOUT;
    // keep only known kinds, dedupe
    const seen = new Set<ThreadItemKind>();
    const widgets = parsed.widgets
      .filter(w => ALL_KINDS.includes(w.kind) && !seen.has(w.kind) && seen.add(w.kind))
      .map(w => ({ kind: w.kind, w: (w.w === 2 ? 2 : 1) as WidgetSize, h: (w.h === 2 ? 2 : 1) as WidgetSize }));
    return { collapsed: !!parsed.collapsed, widgets };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

// ---------------------------------------------------------------------------

interface ThreadWidgetRailProps {
  workspaceId: string | null;
  sessionId: string | null;
  userId?: string;
  accent?: string;
  onJumpToMessage?: (messageId: string) => void;
}

export function ThreadWidgetRail({
  workspaceId,
  sessionId,
  userId,
  accent,
  onJumpToMessage,
}: ThreadWidgetRailProps) {
  const { byKind, loading, createItem, toggleDone, answerBlocker, deleteItem } = useThreadItems(
    workspaceId,
    sessionId,
    userId,
  );

  const [layout, setLayout] = useState<RailLayout>(DEFAULT_LAYOUT);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Load the saved arrangement whenever the thread changes.
  useEffect(() => {
    if (!sessionId) return;
    setLayout(loadLayout(sessionId));
  }, [sessionId]);

  const persist = useCallback((next: RailLayout) => {
    setLayout(next);
    if (sessionId) {
      try { localStorage.setItem(layoutKey(sessionId), JSON.stringify(next)); } catch { /* ignore quota */ }
    }
  }, [sessionId]);

  const setCollapsed = useCallback((collapsed: boolean) => {
    persist({ ...layout, collapsed });
  }, [layout, persist]);

  const cycleSize = useCallback((index: number) => {
    const widgets = layout.widgets.slice();
    const cur = widgets[index];
    if (!cur) return;
    // cycle 1x1 -> 1x2 -> 2x1 -> 2x2 -> 1x1
    const order: Array<[WidgetSize, WidgetSize]> = [[1, 1], [1, 2], [2, 1], [2, 2]];
    const idx = order.findIndex(([w, h]) => w === cur.w && h === cur.h);
    const [w, h] = order[(idx + 1) % order.length];
    widgets[index] = { ...cur, w, h };
    persist({ ...layout, widgets });
  }, [layout, persist]);

  const closeWidget = useCallback((kind: ThreadItemKind) => {
    persist({ ...layout, widgets: layout.widgets.filter(w => w.kind !== kind) });
  }, [layout, persist]);

  const addWidget = useCallback((kind: ThreadItemKind) => {
    if (layout.widgets.some(w => w.kind === kind)) return;
    persist({ ...layout, widgets: [...layout.widgets, { kind, w: 1, h: 2 }] });
  }, [layout, persist]);

  const reorder = useCallback((from: number, to: number) => {
    if (from === to) return;
    const widgets = layout.widgets.slice();
    const [moved] = widgets.splice(from, 1);
    widgets.splice(to, 0, moved);
    persist({ ...layout, widgets });
  }, [layout, persist]);

  const missingKinds = useMemo(
    () => ALL_KINDS.filter(k => !layout.widgets.some(w => w.kind === k)),
    [layout.widgets],
  );

  if (!sessionId || !workspaceId) return null;

  // Collapsed → thin reopen strip.
  if (layout.collapsed) {
    return (
      <div className="thread-widget-rail-collapsed flex h-full shrink-0 flex-col items-center border-l border-border bg-card/40 px-1 py-2">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          title="Show widgets"
          aria-label="Show widgets"
          onClick={() => setCollapsed(false)}
        >
          <PanelRightOpen className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="thread-widget-rail flex h-full w-[320px] shrink-0 flex-col overflow-hidden border-l border-border bg-card/30">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="text-xs font-medium text-muted-foreground">Widgets</span>
        <div className="flex-1" />
        {missingKinds.length > 0 && (
          <div className="flex items-center gap-0.5">
            {missingKinds.map(kind => {
              const Icon = KIND_META[kind].icon;
              return (
                <Button
                  key={kind}
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  title={`Add ${KIND_META[kind].label} widget`}
                  aria-label={`Add ${KIND_META[kind].label} widget`}
                  onClick={() => addWidget(kind)}
                >
                  <Icon className="size-3.5" />
                </Button>
              );
            })}
          </div>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          title="Hide widgets"
          aria-label="Hide widgets"
          onClick={() => setCollapsed(true)}
        >
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-2 gap-2 [grid-auto-flow:dense] [grid-auto-rows:150px]">
          {layout.widgets.map((w, index) => (
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
              onAdd={content => createItem({ kind: w.kind, content })}
              onToggleDone={toggleDone}
              onAnswer={answerBlocker}
              onDelete={deleteItem}
              onJumpToMessage={onJumpToMessage}
            />
          ))}
          {layout.widgets.length === 0 && (
            <div className="col-span-2 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              No widgets. Add one from the header above.
            </div>
          )}
        </div>
      </div>
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
  onAdd: (content: string) => void;
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
  onAdd,
  onToggleDone,
  onAnswer,
  onDelete,
  onJumpToMessage,
}: WidgetCardProps) {
  const meta = KIND_META[layout.kind];
  const Icon = meta.icon;
  const [adding, setAdding] = useState('');
  const openCount = items.filter(i => i.status === 'open').length;

  const submitAdd = () => {
    const value = adding.trim();
    if (!value) return;
    onAdd(value);
    setAdding('');
  };

  return (
    <div
      className={cn(
        'thread-widget group/card relative flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-md transition-shadow hover:shadow-lg',
        layout.w === 2 ? 'col-span-2' : 'col-span-1',
        layout.h === 2 ? 'row-span-2' : 'row-span-1',
        isDragTarget && 'ring-2 ring-primary/60',
      )}
      onDragOver={e => { e.preventDefault(); onDragOver(); }}
    >
      {/* header / drag handle */}
      <div
        className="flex h-7 shrink-0 cursor-grab items-center gap-1 border-b border-border/60 px-1.5 active:cursor-grabbing"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <GripVertical className="size-3 shrink-0 text-muted-foreground/50" />
        <Icon className="size-3.5 shrink-0" style={accent ? { color: accent } : undefined} />
        <span className="truncate text-xs font-medium">{meta.label}</span>
        {items.length > 0 && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
            {openCount || items.length}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/card:opacity-100"
          title="Resize"
          aria-label="Resize widget"
          onClick={onResize}
        >
          {layout.w === 2 && layout.h === 2 ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
        </button>
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/card:opacity-100"
          title="Close"
          aria-label="Close widget"
          onClick={onClose}
        >
          <X className="size-3" />
        </button>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {loading && items.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">{meta.empty}</p>
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

      {/* add affordance */}
      <div className="flex shrink-0 items-center gap-1 border-t border-border/60 px-1.5 py-1">
        <input
          value={adding}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitAdd(); } }}
          placeholder={meta.addPlaceholder}
          className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
        />
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          title="Add"
          aria-label="Add item"
          onClick={submitAdd}
        >
          <Plus className="size-3" />
        </button>
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
