import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Hand, Inbox, RotateCw } from 'lucide-react';
import type { InboxFilter } from '../../types';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useInbox } from '../../hooks/useInbox';
import { InboxDetail } from './InboxDetailPane';
import { InboxFilterTabs } from './InboxFilterTabs';
import { InboxRow } from './InboxRow';
import { MICRO_LABEL } from './inboxPresentation';
import {
  buildInboxRows,
  countByCategory,
  inboxEmptyState,
  type InboxRowModel,
} from './inboxModel';

// ---------------------------------------------------------------------------
// The triage surface. Work that needs a HUMAN collects here instead of being
// lost in channel scrollback — blockers above everything else, because an agent
// stuck on a decision it cannot make is the only thing in this list that is
// actively costing time.
//
// It is built as an INBOX, not a feed: uniform ~34px single-line rows on a
// hairline rule, five columns that land on the same verticals all the way down,
// one type size, and colour spent only on urgency. Everything about the row is
// in InboxRow.tsx; the column geometry is in inboxPresentation.ts.
//
// Two interaction rules hold the whole thing up:
//   1. selection is keyed off the group's contextKey (a stable conversation id),
//      so an item arriving mid-read never moves the user's place;
//   2. no timers. Relative times are computed once per data load and allowed to
//      go stale — this app has a history of re-render storms from live clocks.
// ---------------------------------------------------------------------------

// With a detail pane open the list gives up most of the width — and on a phone
// (where the window IS the viewport) it steps aside entirely, so reading an item
// is not done through a 170px column. Closing the detail brings the list back.
const LIST_NARROW_CLASS = 'w-[44%] shrink-0 border-r border-border max-md:hidden';

const EMPTY_COUNTS = countByCategory([]);

function sameCounts(a: Record<InboxFilter, number>, b: Record<InboxFilter, number>): boolean {
  return (Object.keys(a) as InboxFilter[]).every(key => a[key] === b[key]);
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
  const [filter, setFilter] = useState<InboxFilter>('all');
  const { groups, unreadCount, loading, markRead, resolveBlocker, refetch } = useInbox(workspaceId, filter);

  // STABLE SELECTION: the contextKey, never an index and never the newest item's
  // id. New arrivals re-sort the list around the user without moving them.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // `now` is sampled here and nowhere else — one timestamp per data load, no
  // interval, no per-second re-render.
  const { rows, now } = useMemo(() => {
    const sampled = Date.now();
    return { rows: buildInboxRows(groups, sampled), now: sampled };
  }, [groups]);

  const counts = useMemo(() => countByCategory(groups), [groups]);
  const selected = useMemo(
    () => (selectedKey ? groups.find(group => group.key === selectedKey) ?? null : null),
    [groups, selectedKey],
  );

  // Counts are only truthful on the unfiltered fetch — the server returns just
  // the requested slice otherwise. Hold the last full snapshot so the segmented
  // control keeps its numbers (and, more importantly, its WIDTH) while a filter
  // is applied, instead of collapsing the moment you click a tab.
  const [snapshot, setSnapshot] = useState<{
    workspaceId: string | null;
    counts: Record<InboxFilter, number>;
  }>({ workspaceId: null, counts: EMPTY_COUNTS });

  useEffect(() => {
    if (filter !== 'all' || loading) return;
    setSnapshot(prev =>
      prev.workspaceId === workspaceId && sameCounts(prev.counts, counts)
        ? prev
        : { workspaceId, counts },
    );
  }, [filter, loading, counts, workspaceId]);

  const tabCounts =
    filter === 'all'
      ? counts
      : snapshot.workspaceId === workspaceId
        ? snapshot.counts
        : EMPTY_COUNTS;

  const handleSelect = useCallback((key: string) => {
    setSelectedKey(key);
    markRead(key);
  }, [markRead]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2 pb-1.5 pt-2">
        <div className="flex h-6 items-center gap-2 px-0.5">
          <Inbox className="size-3.5 shrink-0 text-muted-foreground" />
          <h2 className="text-[13px] font-semibold tracking-tight">Inbox</h2>
          {unreadCount > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-primary-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
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

        <InboxFilterTabs filter={filter} counts={tabCounts} onChange={setFilter} />
      </header>

      <div className="flex min-h-0 flex-1">
        <InboxList
          rows={rows}
          filter={filter}
          loading={loading}
          selectedKey={selectedKey}
          narrow={!!selected}
          onSelect={handleSelect}
        />
        {selected && (
          <InboxDetail
            group={selected}
            now={now}
            onClose={() => setSelectedKey(null)}
            onOpenSession={onOpenSession}
            onResolveBlocker={resolveBlocker}
          />
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------

interface InboxListProps {
  rows: InboxRowModel[];
  filter: InboxFilter;
  loading: boolean;
  selectedKey: string | null;
  narrow: boolean;
  onSelect: (key: string) => void;
}

/** Pure list pane — takes pre-formatted rows so it never reads the clock. */
export function InboxList({ rows, filter, loading, selectedKey, narrow, onSelect }: InboxListProps) {
  const blockers = rows.filter(row => row.group.category === 'blocker');
  const rest = rows.filter(row => row.group.category !== 'blocker');
  // Two sections only when there is genuinely a boundary to draw. A lone
  // "Needs you" heading over the whole list would be noise.
  const sectioned = blockers.length > 0 && rest.length > 0;

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
      <div className={cn('min-w-0', narrow ? LIST_NARROW_CLASS : 'flex-1')}>
        <Empty className="h-full border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Collecting what needs you</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  if (rows.length === 0) {
    const empty = inboxEmptyState(filter);
    return (
      <div className={cn('min-w-0', narrow ? LIST_NARROW_CLASS : 'flex-1')}>
        <Empty className="h-full border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {filter === 'blocker' ? <Hand /> : <Inbox />}
            </EmptyMedia>
            <EmptyTitle>{empty.title}</EmptyTitle>
            <EmptyDescription className="text-xs/relaxed">{empty.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <ScrollArea
      className={cn('@container/inbox h-full min-w-0', narrow ? LIST_NARROW_CLASS : 'flex-1')}
    >
      {/* No gaps, no padding, no rounded row cards — rows butt onto a hairline
          rule so the columns read as one continuous table. */}
      <div className="flex flex-col" onKeyDown={handleKeyDown}>
        {sectioned && <SectionHeader label="Needs you" count={blockers.length} />}
        {blockers.map(row => (
          <InboxRow
            key={row.group.key}
            row={row}
            selected={row.group.key === selectedKey}
            onSelect={onSelect}
          />
        ))}
        {sectioned && <SectionHeader label="Everything else" count={rest.length} />}
        {rest.map(row => (
          <InboxRow
            key={row.group.key}
            row={row}
            selected={row.group.key === selectedKey}
            onSelect={onSelect}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 * Sticks to the top of the viewport while its section scrolls under it, so you
 * always know whether the row you are looking at is one that needs you.
 */
function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      className={cn(
        'sticky top-0 z-10 flex h-[22px] items-center gap-1.5 border-b border-border/60 bg-card px-2',
        MICRO_LABEL,
      )}
    >
      <span>{label}</span>
      <span className="font-normal tabular-nums text-muted-foreground/60">{count}</span>
    </div>
  );
}
