import React, { useMemo, useState } from 'react';
import {
  Activity,
  Brain,
  CheckCircle2,
  FileText,
  MessageCircle,
  MessageSquare,
  Palette,
  Send,
  UserPlus,
  X,
} from 'lucide-react';
import type { ActivityEvent, ActivityEventType } from '../../types';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  activityEntryLabel,
  activityEntryText,
  activityMetadataText,
  hasActivityMetadata,
} from '../../lib/activityEntry';
import { oneOf, viewPreferenceKey } from '../../lib/viewPreferences';
import { usePersistedPreference } from '../../hooks/usePersistedPreference';
import { useActivityEventComments } from '../../hooks/useActivityEventComments';

interface ActivityWindowContentProps {
  events: ActivityEvent[];
  loading: boolean;
  workspaceId?: string | null;
  currentUserId?: string | null;
}

function iconFor(type: ActivityEventType): React.ReactNode {
  switch (type) {
    case 'document_created':
    case 'document_updated':
    case 'document_deleted':
      return <FileText />;
    case 'task_created':
    case 'task_completed':
    case 'task_updated':
      return <CheckCircle2 />;
    case 'chat_created':
      return <MessageSquare />;
    case 'message_sent':
      return <MessageSquare />;
    case 'memory_added':
      return <Brain />;
    case 'comment_created':
      return <MessageCircle />;
    case 'member_joined':
      return <UserPlus />;
    case 'canvas_updated':
      return <Palette />;
    default:
      return <Activity />;
  }
}

// Fixed-width clock for the log rows — a log reads left-to-right by time, so this
// stays monospace and non-relative (unlike formatTime's "2h ago" for the badge/tooltip).
function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

// ---------------------------------------------------------------------------
// Category filters.
//
// These moved here from the Inbox, where they were wrong: the inbox is a triage
// queue you are trying to empty, and slicing it hid the very blockers it exists
// to surface. Activity IS a feed — a chronological log you scan rather than
// clear — so narrowing it to "just the task churn" or "just agent connections"
// is exactly the right move.
//
// The Inbox's categories (Blockers / Comments / Mentions / Errors) do NOT exist
// in activity_events, so they are deliberately NOT reproduced here:
//   * blockers live in thread_items and never reach this table;
//   * errors live in agent_jobs and never reach this table;
//   * "mentions" would need the caller's derived @handle, which only the
//     server's inbox query knows how to build.
// Copying those labels across would have produced tabs that always read 0.
// What Activity actually has is event_type, so these tabs are event_type
// families — the honest mapping.
// ---------------------------------------------------------------------------

type ActivityFilter =
  | 'all' | 'docs' | 'tasks' | 'messages' | 'comments' | 'agents' | 'memory' | 'people' | 'canvas';

const ACTIVITY_FAMILY: Record<ActivityEventType, Exclude<ActivityFilter, 'all'>> = {
  document_created: 'docs',
  document_updated: 'docs',
  document_deleted: 'docs',
  task_created: 'tasks',
  task_completed: 'tasks',
  task_updated: 'tasks',
  comment_created: 'comments',
  chat_created: 'messages',
  message_sent: 'messages',
  memory_added: 'memory',
  member_joined: 'people',
  canvas_updated: 'canvas',
  agent_connected: 'agents',
  agent_disconnected: 'agents',
};

// Remembered per workspace. The tab list is also filtered down to families that
// actually appear in the log, so `activeFilter` below still has the last word:
// a stored tab whose family has scrolled out of the loaded page falls back to
// All without ever having to touch storage.
const ACTIVITY_FILTER_PREF = oneOf<ActivityFilter>(
  ['all', 'docs', 'tasks', 'messages', 'comments', 'agents', 'memory', 'people', 'canvas'],
);

const ACTIVITY_FILTERS: Array<{ id: ActivityFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'docs', label: 'Docs' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'messages', label: 'Messages' },
  { id: 'comments', label: 'Comments' },
  { id: 'agents', label: 'Agents' },
  { id: 'memory', label: 'Memory' },
  { id: 'people', label: 'People' },
  { id: 'canvas', label: 'Canvas' },
];

function countByFamily(events: ActivityEvent[]): Record<ActivityFilter, number> {
  const counts = ACTIVITY_FILTERS.reduce((acc, tab) => {
    acc[tab.id] = 0;
    return acc;
  }, {} as Record<ActivityFilter, number>);
  counts.all = events.length;
  for (const event of events) {
    const family = ACTIVITY_FAMILY[event.event_type];
    if (family) counts[family] += 1;
  }
  return counts;
}

/**
 * A segmented control, not a row of chips: one recessed track, one raised active
 * segment, so the bar reads as "which slice of the log am I looking at" rather
 * than as nine independent buttons.
 *
 * Filtering is client-side over the already-loaded page of events, so the counts
 * are always truthful and the control never resizes underneath the pointer
 * mid-click — which is exactly what the inbox version could not promise, because
 * there the server returned only the requested slice.
 */
function ActivityFilterTabs({
  tabs,
  filter,
  counts,
  onChange,
}: {
  tabs: Array<{ id: ActivityFilter; label: string }>;
  filter: ActivityFilter;
  counts: Record<ActivityFilter, number>;
  onChange: (filter: ActivityFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter activity"
      className={cn(
        'flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/70 p-0.5',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
    >
      {tabs.map(tab => {
        const active = tab.id === filter;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            aria-pressed={active}
            className={cn(
              'flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[11px] font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2',
              active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {counts[tab.id] > 0 && (
              <span className="tabular-nums text-muted-foreground/70">{counts[tab.id]}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function groupByDay(events: ActivityEvent[]): Array<{ label: string; items: ActivityEvent[] }> {
  const groups: Record<string, ActivityEvent[]> = {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  events.forEach(event => {
    const date = new Date(event.created_at);
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    let label: string;
    if (dayStart.getTime() === today.getTime()) label = 'Today';
    else if (dayStart.getTime() === yesterday.getTime()) label = 'Yesterday';
    else label = dayStart.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    (groups[label] = groups[label] || []).push(event);
  });

  return Object.entries(groups).map(([label, items]) => ({ label, items }));
}

// Notes left on a log entry ("look at this later"). Keyed by event id from the
// parent so switching the selected row remounts this with fresh input state
// instead of leaking a draft between entries.
function ActivityEventComments({ eventId, workspaceId, currentUserId }: { eventId: string; workspaceId?: string | null; currentUserId?: string | null }) {
  const { topLevel, loading, createComment } = useActivityEventComments(eventId, workspaceId ?? null, currentUserId ?? undefined);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const content = draft.trim();
    if (!content || submitting) return;
    setSubmitting(true);
    try {
      await createComment({ content });
      setDraft('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Comments{topLevel.length > 0 ? ` (${topLevel.length})` : ''}
      </div>
      {loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : topLevel.length === 0 ? (
        <div className="text-xs text-muted-foreground">No comments yet. Leave one to check back on later.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {topLevel.map(comment => (
            <div key={comment.id} className="min-w-0 rounded-lg border bg-muted/30 p-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="font-medium text-foreground">{comment.user_id === currentUserId ? 'You' : 'Teammate'}</span>
                <span>·</span>
                <span>{formatFullDate(comment.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-xs">{comment.content}</p>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Leave a note on this entry…"
          className="min-h-16 text-xs"
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button type="button" size="sm" onClick={submit} disabled={!draft.trim() || submitting} className="self-end">
          <Send data-icon="inline-start" />
          Comment
        </Button>
      </div>
    </div>
  );
}

export const ActivityWindowContent = React.memo(function ActivityWindowContent({ events, loading, workspaceId, currentUserId }: ActivityWindowContentProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = usePersistedPreference(
    viewPreferenceKey('activity.filter', workspaceId), ACTIVITY_FILTER_PREF, 'all' as ActivityFilter,
  );

  const counts = useMemo(() => countByFamily(events), [events]);
  // Only offer a tab for something that is actually in the log. A workspace that
  // has never touched the canvas should not be shown a Canvas tab reading 0.
  const tabs = useMemo(
    () => ACTIVITY_FILTERS.filter(tab => tab.id === 'all' || counts[tab.id] > 0),
    [counts],
  );
  // Derived, not stored: if the last event of a family scrolls out of the loaded
  // page, its tab disappears and the view falls back to All rather than showing
  // an empty log under a tab that no longer exists.
  const activeFilter = tabs.some(tab => tab.id === filter) ? filter : 'all';

  const filtered = useMemo(
    () => (activeFilter === 'all'
      ? events
      : events.filter(event => ACTIVITY_FAMILY[event.event_type] === activeFilter)),
    [events, activeFilter],
  );
  const days = useMemo(() => groupByDay(filtered), [filtered]);

  // Resolved against the FULL set, so switching tabs never yanks away the entry
  // you were reading in the detail pane.
  const selectedEvent = selectedId ? events.find(e => e.id === selectedId) ?? null : null;

  if (loading && events.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading activity</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  if (events.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Activity />
          </EmptyMedia>
          <EmptyTitle>No activity yet</EmptyTitle>
          <EmptyDescription>Team actions will show up here as they happen.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tabs.length > 1 && (
        <div className="flex shrink-0 items-center border-b border-border/60 px-2 py-1.5">
          <ActivityFilterTabs tabs={tabs} filter={activeFilter} counts={counts} onChange={setFilter} />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
      {/* Radix wraps viewport content in a `display: table` div, which sizes to the
          widest row instead of to the viewport — so `truncate` never fires and the
          list silently scrolls sideways by a thousand pixels. Forcing that wrapper
          to block is the same fix the sidebar already uses. */}
      <ScrollArea
        className={cn(
          'h-full min-w-0 [&_[data-radix-scroll-area-viewport]>div]:!block',
          selectedEvent ? 'w-[46%] shrink-0 border-r' : 'flex-1',
        )}
      >
        <div className="flex flex-col p-1.5">
          {days.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              Nothing in this category yet.
            </p>
          )}
          {days.map(group => (
            <section key={group.label} className="flex flex-col">
              <Marker variant="separator" className="px-1.5 py-1">
                <MarkerContent className="text-[10px] uppercase tracking-wide text-muted-foreground">{group.label}</MarkerContent>
              </Marker>
              <div className="flex flex-col">
                {group.items.map(event => {
                  const selected = event.id === selectedId;
                  // Shortened for the row, full for the tooltip — a shortened path
                  // is a label, so the exact one stays one hover away.
                  const full = activityEntryText(event);
                  return (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => setSelectedId(selected ? null : event.id)}
                      title={`${full}\n${formatFullDate(event.created_at)}`}
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-md border-l-2 border-transparent px-1.5 py-1 text-left text-xs transition-colors',
                        selected ? 'border-l-primary bg-primary/10' : 'hover:bg-muted/50',
                      )}
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{formatClock(event.created_at)}</span>
                      <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{iconFor(event.event_type)}</span>
                      <span className="min-w-0 flex-1 truncate">{activityEntryLabel(event)}</span>
                      {/* Shrinkable, not fixed: the label absorbs every pixel of
                          shrink first, so this only gives at the 320px window
                          minimum — where the alternative is the badge hanging
                          outside the pane. */}
                      <Badge variant="secondary" className="min-w-0 shrink overflow-hidden text-[10px]">{event.event_type.replace(/_/g, ' ')}</Badge>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>

      {selectedEvent && (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
            <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{iconFor(selectedEvent.event_type)}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={activityEntryText(selectedEvent)}>
              {activityEntryLabel(selectedEvent)}
            </span>
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => setSelectedId(null)} aria-label="Close detail">
              <X />
            </Button>
          </div>
          <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
            {/* min-w-0 all the way down: every child here is a flex item, and a flex
                item's default `min-width: auto` lets nowrap/pre content push the
                column wider than the pane instead of wrapping inside it. */}
            <div className="flex min-w-0 flex-col gap-3 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{selectedEvent.event_type.replace(/_/g, ' ')}</Badge>
                <span className="text-xs text-muted-foreground">{formatFullDate(selectedEvent.created_at)}</span>
              </div>
              {/* Ids wrap rather than truncate: a uuid you can only see two thirds
                  of is worth no more than one you cannot see at all. */}
              <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {selectedEvent.entity_type && (
                  <>
                    <dt className="text-muted-foreground">Entity type</dt>
                    <dd className="min-w-0 break-all font-mono">{selectedEvent.entity_type}</dd>
                  </>
                )}
                {selectedEvent.entity_id && (
                  <>
                    <dt className="text-muted-foreground">Entity id</dt>
                    <dd className="min-w-0 break-all font-mono">{selectedEvent.entity_id}</dd>
                  </>
                )}
                {selectedEvent.user_id && (
                  <>
                    <dt className="text-muted-foreground">User id</dt>
                    <dd className="min-w-0 break-all font-mono">{selectedEvent.user_id}</dd>
                  </>
                )}
              </dl>
              {hasActivityMetadata(selectedEvent.metadata) && (
                <div className="min-w-0">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Metadata</div>
                  {/* Wrapped AND capped: pre-wrap so a long value folds into the pane,
                      break-words so an unbroken uuid cannot widen it, max-h so a big
                      blob scrolls itself instead of pushing the comments off screen. */}
                  <pre className="max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-2 text-[11px] leading-relaxed">
                    {activityMetadataText(selectedEvent.metadata)}
                  </pre>
                </div>
              )}
              <div className="min-w-0 border-t pt-3">
                <ActivityEventComments key={selectedEvent.id} eventId={selectedEvent.id} workspaceId={workspaceId} currentUserId={currentUserId} />
              </div>
            </div>
          </ScrollArea>
        </div>
      )}
      </div>
    </div>
  );
});
