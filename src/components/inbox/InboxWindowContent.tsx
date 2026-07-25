import React, { useCallback, useMemo, useState } from 'react';
import {
  Activity,
  AtSign,
  ExternalLink,
  Hand,
  Inbox,
  MessageCircle,
  RotateCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { InboxCategory, InboxFilter } from '../../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useInbox } from '../../hooks/useInbox';
import {
  CATEGORY_LABEL,
  INBOX_FILTERS,
  absoluteTime,
  buildInboxRows,
  countByCategory,
  inboxEmptyState,
  relativeTime,
  type InboxGroup,
  type InboxRowModel,
} from './inboxModel';

// ---------------------------------------------------------------------------
// The triage surface. Work that needs a HUMAN collects here instead of being
// lost in channel scrollback — blockers above everything else, because an agent
// stuck on a decision it cannot make is the only thing in this list that is
// actively costing time.
//
// Two interaction rules hold the whole thing up:
//   1. selection is keyed off the group's contextKey (a stable conversation id),
//      so an item arriving mid-read never moves the user's place;
//   2. no timers. Relative times are computed once per data load and allowed to
//      go stale — this app has a history of re-render storms from live clocks.
// ---------------------------------------------------------------------------

const CATEGORY_ICON: Record<InboxCategory, React.ComponentType<{ className?: string }>> = {
  blocker: Hand,
  error: TriangleAlert,
  mention: AtSign,
  comment: MessageCircle,
  activity: Activity,
};

// One tone per category so a full list is scannable without reading a word.
const CATEGORY_TONE: Record<InboxCategory, { icon: string; spine: string; chip: string }> = {
  blocker: {
    icon: 'text-amber-500',
    spine: 'bg-amber-500',
    chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  error: {
    icon: 'text-destructive',
    spine: 'bg-destructive',
    chip: 'bg-destructive/10 text-destructive',
  },
  mention: {
    icon: 'text-sky-500',
    spine: 'bg-sky-500',
    chip: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  },
  comment: {
    icon: 'text-emerald-500',
    spine: 'bg-emerald-500',
    chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  activity: {
    icon: 'text-muted-foreground',
    spine: 'bg-muted-foreground/50',
    chip: 'bg-muted text-muted-foreground',
  },
};

// With a detail pane open the list gives up most of the width — and on a phone
// (where the window IS the viewport) it steps aside entirely, so reading an item
// is not done through a 170px column. Closing the detail brings the list back.
const LIST_NARROW_CLASS = 'w-[44%] shrink-0 border-r border-border max-md:hidden';

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
  const { groups, unreadCount, loading, markRead, refetch } = useInbox(workspaceId, filter);

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

  const handleSelect = useCallback((key: string) => {
    setSelectedKey(key);
    markRead(key);
  }, [markRead]);

  const blockerCount = counts.blocker;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-2">
          <Inbox className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">Inbox</h2>
          {unreadCount > 0 && (
            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
          {blockerCount > 0 && (
            <button
              type="button"
              onClick={() => setFilter('blocker')}
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 outline-none transition-colors hover:bg-amber-500/25 focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-400"
            >
              {blockerCount} need{blockerCount === 1 ? 's' : ''} you
            </button>
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
            <RotateCw />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {INBOX_FILTERS.map(tab => {
            const active = tab.id === filter;
            // Counts are only truthful on the unfiltered fetch — the server
            // returns just the requested slice otherwise.
            const count = filter === 'all' && tab.id !== 'all' ? counts[tab.id] : 0;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                aria-pressed={active}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {tab.label}
                {count > 0 && (
                  <span
                    className={cn(
                      'text-[10px] tabular-nums',
                      active ? 'text-primary-foreground/70' : 'text-muted-foreground/70',
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
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
  const sectioned = blockers.length > 0 && rest.length > 0;

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
            <EmptyDescription>{empty.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <ScrollArea className={cn('h-full min-w-0', narrow ? LIST_NARROW_CLASS : 'flex-1')}>
      <div className="flex flex-col gap-0.5 p-1.5">
        {sectioned && <SectionLabel label="Needs you" />}
        {blockers.map(row => (
          <InboxRow
            key={row.group.key}
            row={row}
            selected={row.group.key === selectedKey}
            onSelect={onSelect}
          />
        ))}
        {sectioned && <SectionLabel label="Everything else" />}
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

function SectionLabel({ label }: { label: string }) {
  return (
    <Marker variant="separator" className="px-1.5 py-1">
      <MarkerContent className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </MarkerContent>
    </Marker>
  );
}

// ---------------------------------------------------------------------------

function InboxRow({
  row,
  selected,
  onSelect,
}: {
  row: InboxRowModel;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const { group, when } = row;
  const tone = CATEGORY_TONE[group.category];
  const Icon = CATEGORY_ICON[group.category];
  const unread = group.unreadCount > 0;
  const blocker = group.category === 'blocker';
  const extra = group.items.length - 1;

  return (
    <button
      type="button"
      onClick={() => onSelect(group.key)}
      aria-current={selected ? 'true' : undefined}
      title={group.title}
      className={cn(
        'group/row relative flex w-full items-start gap-2 rounded-md py-1.5 pl-3 pr-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        blocker && !selected && 'bg-amber-500/[0.07] hover:bg-amber-500/15',
        blocker && selected && 'bg-amber-500/20',
        !blocker && selected && 'bg-primary/10',
        !blocker && !selected && 'hover:bg-muted/60',
      )}
    >
      {/* category spine — the fastest read in the list */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-1 left-1 w-[2px] rounded-full',
          tone.spine,
          unread ? 'opacity-100' : 'opacity-30',
        )}
      />

      <Icon className={cn('mt-0.5 size-3.5 shrink-0', blocker || unread ? tone.icon : 'text-muted-foreground')} />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs leading-snug',
              unread ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
            )}
          >
            {group.title}
          </span>
          {extra > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-4 text-muted-foreground">
              +{extra}
            </span>
          )}
          {unread && (
            <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />
          )}
        </span>

        {group.body && (
          <span className="min-w-0 truncate text-[11px] leading-snug text-muted-foreground">
            {group.body}
          </span>
        )}

        <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          {blocker && (
            <span className="shrink-0 font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Blocked
            </span>
          )}
          {group.actorName && <span className="min-w-0 truncate">{group.actorName}</span>}
          {group.actorName && <span aria-hidden="true">·</span>}
          <span className="shrink-0 font-mono tabular-nums">{when}</span>
        </span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------

interface InboxDetailProps {
  group: InboxGroup;
  now: number;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
}

/** Pure detail pane. `now` is the same sample the list rows were formatted with. */
export function InboxDetail({ group, now, onClose, onOpenSession }: InboxDetailProps) {
  const tone = CATEGORY_TONE[group.category];
  const Icon = CATEGORY_ICON[group.category];
  const lead = group.items[0];
  const earlier = group.items.slice(1);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon className={cn('size-4 shrink-0', tone.icon)} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{group.title}</span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close detail">
          <X />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', tone.chip)}>
              {CATEGORY_LABEL[group.category]}
            </span>
            {group.actorName && <span className="text-xs text-muted-foreground">{group.actorName}</span>}
            <span className="text-xs text-muted-foreground">{absoluteTime(group.latestAt)}</span>
          </div>

          {group.category === 'blocker' && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
              An agent stopped here and needs a decision from you. Answering it in the thread wakes it back up.
            </p>
          )}

          {group.body && (
            <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-2.5 text-xs leading-relaxed">
              {group.body}
            </p>
          )}

          {group.sessionId && onOpenSession && (
            <Button
              type="button"
              size="sm"
              className="self-start"
              onClick={() => onOpenSession(group.sessionId as string)}
            >
              <ExternalLink data-icon="inline-start" />
              Open chat
            </Button>
          )}

          {(group.entityType || group.entityId) && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
              {group.entityType && (
                <>
                  <dt className="text-muted-foreground">Entity</dt>
                  <dd className="truncate font-mono">{group.entityType}</dd>
                </>
              )}
              {group.entityId && (
                <>
                  <dt className="text-muted-foreground">Id</dt>
                  <dd className="truncate font-mono">{group.entityId}</dd>
                </>
              )}
            </dl>
          )}

          {earlier.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Earlier in this thread ({earlier.length})
              </div>
              {earlier.map(item => (
                <div key={item.id} className="flex min-w-0 items-baseline gap-2 rounded-md px-1 py-0.5">
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {relativeTime(item.createdAt, now)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px]">{item.title}</span>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {CATEGORY_LABEL[item.category]}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          {!group.body && earlier.length === 0 && lead && !lead.sessionId && (
            <p className="text-xs text-muted-foreground">Nothing more to show for this one.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
