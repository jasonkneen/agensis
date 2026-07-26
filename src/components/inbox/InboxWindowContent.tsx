import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useInbox } from '../../hooks/useInbox';
import { InboxDetail } from './InboxDetailPane';
import { InboxRow } from './InboxRow';
import { InboxSelectionBar } from './InboxSelectionBar';
import {
  FOCUS_RING,
  LIST_COLUMN_CLASS,
  PANE_HEADER,
  ROW_PADDING,
  SCROLL_VIEWPORT_BLOCK,
} from './inboxPresentation';
import { buildInboxRows, inboxEmptyState, type InboxRowModel } from './inboxModel';
import {
  NO_SELECTION,
  availableBulkActions,
  beginSelection,
  bulkResultMessage,
  clearSelection,
  dismissableBlockerIds,
  isAllSelected,
  isSelecting,
  pruneSelection,
  runBulk,
  selectAll,
  selectRange,
  summarizeSelection,
  toggleSelection,
  unreadGroupKeys,
  type InboxBulkActionId,
} from './inboxSelection';

// ---------------------------------------------------------------------------
// The triage surface. Work that needs a HUMAN collects here instead of being
// lost in channel scrollback — blockers above everything else, because an agent
// stuck on a decision it cannot make is the only thing in this list that is
// actively costing time.
//
// It is an INBOX, not a feed: one flat chronological stream of ~90px rows, each
// three lines of text against a 32px face, with NOTHING drawn between them. No
// section headers, no date dividers, no per-row rules, no cards, no counts, no
// badges. Restraint is the whole design — see InboxRow.tsx.
//
// The category filter bar that used to sit under this header now lives in
// Activity, which is a feed and is where slicing by category actually helps.
// What is left here is the one filter an inbox genuinely needs: unread.
//
// Two interaction rules hold the whole thing up:
//   1. selection is keyed off the group's contextKey (a stable conversation id),
//      so an item arriving mid-read never moves the user's place;
//   2. no timers. `now` is sampled once per data load; the list timestamps are
//      absolute clock times, which cannot go stale, and the one relative label
//      (the thread tail in the detail pane) is allowed to — this app has a
//      history of re-render storms from live clocks.
// ---------------------------------------------------------------------------

const DEFAULT_LIST_WIDTH = 340;
const MIN_LIST_WIDTH = 240;
const MAX_LIST_WIDTH = 520;
const LIST_WIDTH_KEY = 'agensis.inbox.list-width';

/**
 * The floor the detail pane is entitled to whenever both panes are on screen.
 *
 * The list's cap used to be a bare `62%`, a number that happened to work at the
 * widths it was tried at and says nothing about whether what is left is
 * readable. Expressed the other way round — `max-width: calc(100% - 18rem)` —
 * the guarantee is the one that matters and it holds at every container width:
 * the detail pane never gets less than 18rem, however far the divider is
 * dragged and however small the window gets. Below 42rem there is no width left
 * to divide and SINGLE_COLUMN_HIDE takes over entirely.
 *
 * In REM because it is a readability floor, and readability is a character
 * count. It has to grow when the user turns the base font size up, exactly as
 * SINGLE_COLUMN_HIDE's own 42rem threshold already does — 270px at the 15px
 * default, 306px at 17px.
 */
const MIN_DETAIL_REM = 18;

/**
 * The rem→px conversion the drag clamp needs. Reads the root font size rather
 * than assuming 16: this app sets `html { font-size: var(--agensis-ui-font-size) }`,
 * so 1rem is 15px by default and anywhere from 12 to 18 by user setting.
 */
function minDetailPx(): number {
  if (typeof document === 'undefined') return MIN_DETAIL_REM * 16;
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return MIN_DETAIL_REM * (Number.isFinite(root) && root > 0 ? root : 16);
}

/**
 * Under 42rem (672px) the two panes cannot both hold a readable column, so the
 * list goes full-width and the detail REPLACES it (with a back arrow) rather
 * than being read through a 170px slot. Done as a container query on the
 * window, not a media query — this lives in a floating window whose width has
 * nothing to do with the viewport's, and a container query costs no re-renders
 * where a ResizeObserver would cost one per frame of a window drag.
 *
 * Written out in full rather than composed, because Tailwind scans source text
 * for literal class names and never sees a concatenated one.
 */
const SINGLE_COLUMN_HIDE = '@max-2xl/inboxwin:hidden';

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_LIST_WIDTH;
  try {
    const raw = Number(window.sessionStorage.getItem(LIST_WIDTH_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIST_WIDTH;
    return Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.round(raw)));
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

interface InboxWindowContentProps {
  workspaceId: string | null;
  /** Offered on any item that carries a session — "go read it where it happened". */
  onOpenSession?: (sessionId: string) => void;
}

export const InboxWindowContent = React.memo(function InboxWindowContent({
  workspaceId,
  onOpenSession,
}: InboxWindowContentProps) {
  const { groups, unreadCount, loading, markRead, resolveBlocker, refetch } = useInbox(workspaceId);

  // STABLE SELECTION: the contextKey, never an index and never the newest item's
  // id. New arrivals re-sort the list around the user without moving them.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [listWidth, setListWidth] = useState(readStoredWidth);

  // `now` is sampled here and nowhere else — one timestamp per data load, no
  // interval, no per-second re-render.
  const { rows, now } = useMemo(() => {
    const sampled = Date.now();
    return { rows: buildInboxRows(groups, sampled), now: sampled };
  }, [groups]);

  const visibleRows = useMemo(
    () => (unreadOnly ? rows.filter(row => row.group.unreadCount > 0) : rows),
    [rows, unreadOnly],
  );

  const selected = useMemo(
    () => (selectedKey ? groups.find(group => group.key === selectedKey) ?? null : null),
    [groups, selectedKey],
  );

  const handleSelect = useCallback((key: string) => {
    setSelectedKey(key);
    markRead(key);
  }, [markRead]);

  // --- Bulk selection -----------------------------------------------------
  //
  // Keyed off the same contextKeys the list is, so a realtime arrival cannot
  // shuffle what is selected any more than it can shuffle what is open.
  const [selection, setSelection] = useState(NO_SELECTION);
  const [busy, setBusy] = useState<InboxBulkActionId | null>(null);

  const visibleKeys = useMemo(() => visibleRows.map(row => row.group.key), [visibleRows]);

  // A row that has left the list (filter flipped, blocker resolved, refetch)
  // must leave the selection with it — a bulk action must never reach something
  // the user cannot see. pruneSelection returns the same object when nothing
  // changed, so this settles in one pass instead of looping.
  useEffect(() => {
    setSelection(current => pruneSelection(current, visibleKeys));
  }, [visibleKeys]);

  const selecting = isSelecting(selection);
  const summary = useMemo(() => summarizeSelection(groups, selection), [groups, selection]);
  const bulkActions = useMemo(() => availableBulkActions(groups, selection), [groups, selection]);
  const allSelected = useMemo(() => isAllSelected(selection, visibleKeys), [selection, visibleKeys]);

  const handleToggleSelect = useCallback((key: string, extend: boolean) => {
    setSelection(current => {
      if (!isSelecting(current)) return beginSelection(key);
      return extend ? selectRange(current, key, visibleKeys) : toggleSelection(current, key);
    });
    // Bulk work wants the full-width list, and the header the selection puts up
    // does not fit the 340px column the detail pane leaves behind.
    setSelectedKey(null);
  }, [visibleKeys]);

  const handleToggleAll = useCallback(() => {
    setSelection(current => (isAllSelected(current, visibleKeys)
      ? clearSelection()
      : selectAll(current, visibleKeys)));
  }, [visibleKeys]);

  const exitSelection = useCallback(() => setSelection(clearSelection()), []);

  /**
   * Both bulk actions are N per-item calls — the inbox has no batch endpoint —
   * so they run a few at a time and REPORT what actually happened. Reporting
   * "done" over a half-applied batch is the failure mode worth engineering
   * against here: a dismissed-but-not-really blocker leaves an agent waiting
   * forever on an answer the human believes they gave.
   */
  const runAction = useCallback(async (id: InboxBulkActionId) => {
    if (busy) return;
    setBusy(id);
    try {
      if (id === 'mark-read') {
        const keys = unreadGroupKeys(groups, selection);
        // markRead flips the row locally FIRST and treats a dropped POST as a
        // non-event — the marker is monotonic server-side and self-heals on the
        // next open — so it reports no failure and there is none to report. The
        // count is still worth showing: it is the only confirmation that a
        // select-all touched everything the user thought it did.
        const result = await runBulk(keys, async key => {
          await markRead(key);
          return true;
        });
        toast.success(bulkResultMessage('Marked read', result));
      } else {
        const ids = dismissableBlockerIds(groups, selection);
        const result = await runBulk(ids, id2 => resolveBlocker(id2, 'dismissed'));
        if (result.failed > 0) toast.error(bulkResultMessage('Dismissed', result));
        else toast.success(bulkResultMessage('Dismissed', result));
      }
      setSelection(clearSelection());
    } finally {
      setBusy(null);
    }
  }, [busy, groups, selection, markRead, resolveBlocker]);

  // Drag-to-resize, via pointer capture so it needs no window listeners and
  // cannot leak a handler if the window unmounts mid-drag.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; width: number } | null>(null);

  /**
   * Clamped against the CONTAINER, not against two absolute constants. 240..520
   * is the range the list is allowed to want; what it is allowed to have also
   * depends on leaving MIN_DETAIL_WIDTH behind. Read straight off the ref — no
   * ResizeObserver, no state, so a window drag still costs zero re-renders.
   */
  const clampWidth = useCallback((value: number) => {
    const container = rootRef.current?.clientWidth ?? 0;
    const ceiling = container > 0
      ? Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, container - minDetailPx()))
      : MAX_LIST_WIDTH;
    return Math.min(ceiling, Math.max(MIN_LIST_WIDTH, Math.round(value)));
  }, []);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, width: listWidth };
  }, [listWidth]);

  const handleResizeMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setListWidth(clampWidth(drag.width + (event.clientX - drag.x)));
  }, [clampWidth]);

  const handleResizeEnd = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      window.sessionStorage.setItem(LIST_WIDTH_KEY, String(listWidth));
    } catch {
      // Width is a nicety; a storage-denied browser just gets the default back.
    }
  }, [listWidth]);

  const resetWidth = useCallback(() => setListWidth(DEFAULT_LIST_WIDTH), []);

  return (
    <div
      ref={rootRef}
      className="@container/inboxwin flex h-full min-h-0 bg-card text-card-foreground"
    >
      <section
        className={cn(
          'relative flex min-h-0 min-w-0 flex-col',
          selected ? cn('shrink-0 border-r border-border/60', SINGLE_COLUMN_HIDE) : 'flex-1',
        )}
        style={selected ? { width: listWidth, maxWidth: `calc(100% - ${MIN_DETAIL_REM}rem)` } : undefined}
        onKeyDown={event => {
          // Esc is the fastest way out of a mode you entered by accident.
          if (event.key === 'Escape' && selecting && !busy) {
            event.preventDefault();
            exitSelection();
          }
        }}
      >
        {selecting ? (
          <InboxSelectionBar
            count={summary.groups}
            itemCount={summary.items}
            allSelected={allSelected}
            actions={bulkActions}
            busy={busy}
            onToggleAll={handleToggleAll}
            onRun={id => void runAction(id)}
            onExit={exitSelection}
          />
        ) : (
        <div className={PANE_HEADER}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'relative -ml-1 flex h-6 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70',
                  FOCUS_RING,
                )}
              >
                <span>{unreadOnly ? 'Unread' : 'All'}</span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
                {unreadCount > 0 && !unreadOnly && (
                  <span
                    aria-hidden="true"
                    className="absolute right-0 top-0 size-1.5 rounded-full bg-primary ring-2 ring-card"
                  />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuRadioGroup
                value={unreadOnly ? 'unread' : 'all'}
                onValueChange={value => setUnreadOnly(value === 'unread')}
              >
                <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="unread">
                  Unread
                  {unreadCount > 0 && (
                    <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.65rem] font-semibold leading-none text-primary-foreground">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex-1" />

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={refetch}
            aria-label="Refresh inbox"
            title="Refresh"
          >
            <RotateCw className={loading ? 'animate-spin' : undefined} />
          </Button>
        </div>
        )}

        <InboxList
          rows={visibleRows}
          unreadOnly={unreadOnly}
          loading={loading}
          selectedKey={selectedKey}
          selectionMode={selecting}
          selectedKeys={selection.keys}
          onSelect={handleSelect}
          onToggleSelect={handleToggleSelect}
          onMarkRead={markRead}
          onOpenSession={onOpenSession}
        />

        {/* An invisible 12px grab strip whose hairline only appears under the
            pointer — the divider is the pane border, not this. */}
        {selected && (
          <button
            type="button"
            aria-label="Resize inbox list"
            title="Drag to resize. Double-click to reset."
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={resetWidth}
            className={cn(
              'group/resize absolute inset-y-0 -right-1.5 z-30 w-3 cursor-col-resize',
              SINGLE_COLUMN_HIDE,
              FOCUS_RING,
            )}
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-border group-focus-visible/resize:bg-border"
            />
          </button>
        )}
      </section>

      {selected && (
        <InboxDetail
          group={selected}
          now={now}
          /* The back arrow exists only when the detail has replaced the list. */
          backButtonClass="hidden @max-2xl/inboxwin:inline-flex"
          onClose={() => setSelectedKey(null)}
          onOpenSession={onOpenSession}
          onResolveBlocker={resolveBlocker}
        />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------

interface InboxListProps {
  rows: InboxRowModel[];
  unreadOnly: boolean;
  loading: boolean;
  selectedKey: string | null;
  /** Bulk-selection mode is open: rows toggle instead of opening. */
  selectionMode?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onSelect: (key: string) => void;
  onToggleSelect?: (key: string, extend: boolean) => void;
  onMarkRead: (key: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

const NO_KEYS: ReadonlySet<string> = new Set<string>();
const noop = () => {};

/** Pure list pane — takes pre-formatted rows so it never reads the clock. */
export function InboxList({
  rows,
  unreadOnly,
  loading,
  selectedKey,
  selectionMode = false,
  selectedKeys = NO_KEYS,
  onSelect,
  onToggleSelect = noop,
  onMarkRead,
  onOpenSession,
}: InboxListProps) {
  // Arrow keys walk the rows; the rows are real buttons, so Enter/Space already
  // open them and no extra key handling is needed.
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-inbox-row]'),
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown'
      ? (current < 0 ? 0 : Math.min(current + 1, buttons.length - 1))
      : (current < 0 ? buttons.length - 1 : Math.max(current - 1, 0));
    event.preventDefault();
    buttons[next]?.focus();
  }, []);

  if (loading && rows.length === 0) {
    return (
      <div className="min-h-0 flex-1" data-inbox-skeleton="">
        <div className={LIST_COLUMN_CLASS}>
          {[0, 1, 2, 3].map(index => (
            <div key={index} className={cn('flex items-start gap-2.5', ROW_PADDING)}>
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="ml-auto h-3 w-10" />
                </div>
                <Skeleton className="mt-1.5 h-2.5 w-16" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-1 h-3 w-3/5" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    // Two lines of plain text, centred. No illustration, no icon, no CTA — an
    // empty inbox is good news and does not need decorating.
    const empty = inboxEmptyState(unreadOnly);
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-[16rem]">
          <p className="text-sm font-medium text-foreground">{empty.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{empty.description}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className={cn('min-h-0 flex-1', SCROLL_VIEWPORT_BLOCK)}>
      {/* One flat stream, newest first, blockers pinned above it. Nothing is
          drawn between rows — see InboxRow. Capped and centred (LIST_COLUMN_CLASS)
          so a wide window doesn't stretch rows into a thin edge-to-edge ribbon. */}
      <div className={cn('flex flex-col pb-2', LIST_COLUMN_CLASS)} onKeyDown={handleKeyDown}>
        {rows.map(row => (
          <InboxRow
            key={row.group.key}
            row={row}
            selected={row.group.key === selectedKey}
            selectionMode={selectionMode}
            checked={selectedKeys.has(row.group.key)}
            onSelect={onSelect}
            onToggleSelect={onToggleSelect}
            onMarkRead={onMarkRead}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
