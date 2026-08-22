import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Brain,
  CheckCircle2,
  FileText,
  KeyRound,
  MessageCircle,
  MessageSquare,
  Palette,
  Search,
  Send,
  UserPlus,
  X,
} from 'lucide-react';
import type { ActivityEvent, ActivityEventType } from '../../types';
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  activityEntryLabel,
  activityEntryText,
  activityMetadataText,
  hasActivityMetadata,
} from '../../lib/activityEntry';
import {
  activityRowOpacity,
  hasHiddenActivity,
  shouldAnimateEntry,
  takeActivityWindow,
} from '../../lib/activityFeed';
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
    case 'provider_call':
      return <KeyRound />;
    case 'join_link_created':
    case 'join_link_redeemed':
      return <UserPlus />;
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
  // A credentialed provider call an agent made through the server. Filed under
  // Agents because that is what the reader is auditing — which agent spent a
  // provider credential, on what, and what came back.
  provider_call: 'agents',
  // Filed under People for both lanes. The reader auditing a join link is asking
  // "who got into this workspace, and how" — the answer belongs beside
  // member_joined whether the joiner was a person or an agent.
  join_link_created: 'people',
  join_link_redeemed: 'people',
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

// Family -> CSS tag class (see the .activity-family-* block in index.css). A
// solid-block family tag on each row is the trajectory screen's visual grammar:
// a scan of the feed should land on the kind of work, not the clock next to it.
function familyTagClass(family: Exclude<ActivityFilter, 'all'> | 'all' | undefined): string {
  switch (family) {
    case 'docs': return 'activity-family-docs';
    case 'tasks': return 'activity-family-tasks';
    case 'messages': return 'activity-family-messages';
    case 'comments': return 'activity-family-comments';
    case 'agents': return 'activity-family-agents';
    case 'memory': return 'activity-family-memory';
    case 'people': return 'activity-family-people';
    case 'canvas': return 'activity-family-canvas';
    default: return 'activity-family-all';
  }
}

// The family a given event belongs to, or 'all' when its event_type is unmapped.
function familyFor(event: Pick<ActivityEvent, 'event_type'>): Exclude<ActivityFilter, 'all'> | 'all' {
  return ACTIVITY_FAMILY[event.event_type] ?? 'all';
}

// Background hue used for the timeline segment + dot so the strip and the tag
// share one colour identity per family.
function familyDotColor(family: Exclude<ActivityFilter, 'all'> | 'all' | undefined): string {
  switch (family) {
    case 'docs': return 'var(--primary)';
    case 'tasks': return 'oklch(0.62 0.17 150)';
    case 'messages': return 'oklch(0.6 0.18 265)';
    case 'comments': return 'oklch(0.64 0.15 320)';
    case 'agents': return 'oklch(0.6 0.18 35)';
    case 'memory': return 'oklch(0.68 0.11 95)';
    case 'people': return 'oklch(0.62 0.15 20)';
    case 'canvas': return 'oklch(0.64 0.13 285)';
    default: return 'var(--foreground)';
  }
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
              'flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors',
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

// ---------------------------------------------------------------------------
// Trajectory-style overview timeline.
//
// A single "Chrome Network"-style strip over the loaded page of events: one
// coloured segment per row, coloured by family, click-to-select, with a tiny
// lane-legend above. Adapted from the deepseek-harness trajectory screen, whose
// whole point is "you can see the shape of the work at a glance" — in our case
// that is the mix of docs vs tasks vs agent calls over the page, not raw timing.
// ---------------------------------------------------------------------------
function ActivityTimeline({
  events,
  selectedId,
  onSelect,
}: {
  events: ActivityEvent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (events.length === 0) return null;
  return (
    <div className="trajectory-timeline">
      <div className="trajectory-timeline-labels" aria-hidden="true">
        <span><span className="trajectory-timeline-dot" style={{ background: 'var(--primary)', width: 7, height: 7 }} /> Docs</span>
        <span><span className="trajectory-timeline-dot" style={{ background: 'oklch(0.62 0.17 150)', width: 7, height: 7 }} /> Tasks</span>
        <span><span className="trajectory-timeline-dot" style={{ background: 'oklch(0.6 0.18 265)', width: 7, height: 7 }} /> Messages</span>
        <span><span className="trajectory-timeline-dot" style={{ background: 'oklch(0.6 0.18 35)', width: 7, height: 7 }} /> Agents</span>
      </div>
      <div className="trajectory-timeline-track" role="img" aria-label="Activity timeline">
        {events.map((event) => {
          const family = familyFor(event);
          const selected = event.id === selectedId;
          return (
            <button
              key={event.id}
              type="button"
              title={activityEntryLabel(event)}
              aria-label={activityEntryLabel(event)}
              onClick={() => onSelect(event.id)}
              className="group relative h-full min-w-[2px] flex-1 rounded-[2px] transition-opacity"
              style={{
                background: familyDotColor(family),
                opacity: selected ? 1 : 0.55,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// The tabbed right-hand inspector, trajectory-style. Each selected event opens a
// Summary / Metadata / Comments triad instead of a single scrolling column —
// the same "detail has structure" move the trajectory record inspector makes.
function ActivityDetailTabs({
  event,
  workspaceId,
  currentUserId,
}: {
  event: ActivityEvent;
  workspaceId?: string | null;
  currentUserId?: string | null;
}) {
  return (
    <Tabs defaultValue="summary" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TabsList className="mx-1 mt-1 w-fit self-start">
        <TabsTrigger value="summary">Summary</TabsTrigger>
        <TabsTrigger value="metadata">Metadata</TabsTrigger>
        <TabsTrigger value="comments">Comments</TabsTrigger>
      </TabsList>
      <TabsContent value="summary" className="min-h-0 min-w-0 flex-1 overflow-auto p-3 text-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn('activity-family-tag', familyTagClass(familyFor(event)))}>
            {familyFor(event) === 'all' ? event.event_type.replace(/_/g, ' ') : familyFor(event)}
          </span>
          <span className="text-xs text-muted-foreground">{formatFullDate(event.created_at)}</span>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
          {activityEntryText(event)}
        </p>
        <dl className="mt-3 grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {event.entity_type && (
            <>
              <dt className="text-muted-foreground">Entity type</dt>
              <dd className="min-w-0 break-all font-mono">{event.entity_type}</dd>
            </>
          )}
          {event.entity_id && (
            <>
              <dt className="text-muted-foreground">Entity id</dt>
              <dd className="min-w-0 break-all font-mono">{event.entity_id}</dd>
            </>
          )}
          {event.user_id && (
            <>
              <dt className="text-muted-foreground">User id</dt>
              <dd className="min-w-0 break-all font-mono">{event.user_id}</dd>
            </>
          )}
        </dl>
      </TabsContent>
      <TabsContent value="metadata" className="min-h-0 min-w-0 flex-1 overflow-auto p-3 text-sm">
        {hasActivityMetadata(event.metadata) ? (
          <pre className="max-h-full min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-2 text-[11px] leading-relaxed">
            {activityMetadataText(event.metadata)}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">No metadata on this event.</p>
        )}
      </TabsContent>
      <TabsContent value="comments" className="min-h-0 min-w-0 flex-1 overflow-auto p-3 text-sm">
        <ActivityEventComments eventId={event.id} workspaceId={workspaceId} currentUserId={currentUserId} />
      </TabsContent>
    </Tabs>
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

  // Live search across every row's label text, the event type, and its metadata —
  // the trajectory screen's ledger search lifted straight onto the activity feed.
  const [searchQuery, setSearchQuery] = useState('');
  const searchScoped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((event) => {
      const haystack = [
        activityEntryText(event),
        String(event.event_type),
        String(event.entity_type ?? ''),
        String(event.entity_id ?? ''),
        activityMetadataText(event.metadata),
      ].join('\n').toLowerCase();
      return haystack.includes(q);
    });
  }, [filtered, searchQuery]);

  // Collapsed by default: the feed is a firehose, and a hundred equal-weight
  // rows made the newest one indistinguishable from the hundredth.
  const [expanded, setExpanded] = useState(false);
  // A new tab is a new list — carrying "expanded" across would dump the reader
  // into a hundred rows of a category they just opened, and carrying a search
  // whose terms matched nothing under the new tab would look broken.
  useEffect(() => { setExpanded(false); setSearchQuery(''); }, [activeFilter]);

  const windowed = useMemo(() => takeActivityWindow(searchScoped, expanded), [searchScoped, expanded]);
  const days = useMemo(() => groupByDay(windowed), [windowed]);
  // id -> position in the flat window. groupByDay preserves order but splits the
  // list, so without this the ramp would restart at full strength on every day
  // heading — brightest row halfway down the feed.
  const rowDepth = useMemo(
    () => new Map(windowed.map((event, index) => [event.id, index])),
    [windowed],
  );
  const hiddenCount = hasHiddenActivity(searchScoped.length, expanded) ? searchScoped.length - windowed.length : 0;

  // Which row (if any) should play the enter animation. Tracked in a ref so
  // seeing it never triggers another render, and compared against the id rather
  // than the length — a filter change alters the count without anything arriving.
  const newestId = searchScoped.length > 0 ? searchScoped[0].id : null;
  const previousNewestId = useRef<string | null>(null);
  const enteringId = shouldAnimateEntry(newestId ?? '', newestId, previousNewestId.current) ? newestId : null;
  useEffect(() => { previousNewestId.current = newestId; }, [newestId]);

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
      {/* Trajectory-style sticky toolbar: family fold filters on the left, a
          live ledger search pinned to the right. */}
      <div className="activity-tray-toolbar">
        {tabs.length > 1 && (
          <ActivityFilterTabs tabs={tabs} filter={activeFilter} counts={counts} onChange={setFilter} />
        )}
        <div className="activity-tray-search">
          <Search className="size-3 shrink-0" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search activity"
            placeholder="Search…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
          />
        </div>
      </div>

      {/* The segmented overview strip — the trajectory screen's headline visual.
          Rendered over the visible WINDOW (not the whole loaded page): the strip
          maps one segment to one row you can actually see in the list, and a
          workspace with ten thousand events does not create ten thousand flex
          buttons. */}
      <ActivityTimeline events={windowed} selectedId={selectedId} onSelect={(id) => setSelectedId(selectedId === id ? null : id)} />

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
        <div
          className="flex flex-col p-1.5"
          // Collapsed, the list is shorter than the viewport, so a scroll gesture
          // has nothing to move and silently does nothing — which is precisely
          // the gesture a reader reaches for to get the older rows back. Treat a
          // downward wheel as the request it obviously is.
          onWheel={hiddenCount > 0 ? (e) => { if (e.deltaY > 0) setExpanded(true); } : undefined}
        >
          {days.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              Nothing in this category yet.
            </p>
          )}
          {days.map(group => (
            <section key={group.label} className="flex flex-col">
              <Marker variant="separator" className="px-1.5 py-1">
                <MarkerContent className="text-[11px] uppercase tracking-wide text-muted-foreground">{group.label}</MarkerContent>
              </Marker>
              <div className="flex flex-col">
                {group.items.map(event => {
                  const selected = event.id === selectedId;
                  // Depth is GLOBAL, not per-day: the ramp follows how far down
                  // the feed a row is, and a day boundary would otherwise restart
                  // it at full strength halfway down the list.
                  const depth = rowDepth.get(event.id) ?? 0;
                  // A selected row is being read — never dim it out from under
                  // the reader just because it sits low in the window.
                  const opacity = selected ? 1 : activityRowOpacity(depth, windowed.length, expanded);
                  // Shortened for the row, full for the tooltip — a shortened path
                  // is a label, so the exact one stays one hover away.
                  const full = activityEntryText(event);
                  return (
                    <div
                      key={event.id}
                      className={cn('activity-row activity-row-fade', event.id === enteringId && 'activity-row-enter')}
                      style={{ opacity }}
                    >
                    <button
                      type="button"
                      onClick={() => setSelectedId(selected ? null : event.id)}
                      title={`${full}\n${formatFullDate(event.created_at)}`}
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-md border-l-2 border-transparent px-1.5 py-1 text-left text-[14px] transition-colors',
                        selected ? 'border-l-primary bg-primary/10' : 'hover:bg-muted/50',
                      )}
                    >
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatClock(event.created_at)}</span>
                      <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{iconFor(event.event_type)}</span>
                      <span className="min-w-0 flex-1 truncate">{activityEntryLabel(event)}</span>
                      {/* Trajectory-style family tag: a coloured block naming the
                          kind of work, the same grammar the timeline strip uses. */}
                      <span className={cn('activity-family-tag shrink-0', familyTagClass(familyFor(event)))}>
                        {familyFor(event) === 'all' ? event.event_type.replace(/_/g, ' ') : familyFor(event)}
                      </span>
                    </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-0.5 rounded-md px-1.5 py-1.5 text-center text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              {`Show ${hiddenCount} earlier`}
            </button>
          )}
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
          {/* Tabbed inspector, trajectory-style: the selected event is shown as
              a structured set of panes (Summary / Metadata / Comments) instead of
              one long scrolling column. */}
          <ActivityDetailTabs event={selectedEvent} workspaceId={workspaceId} currentUserId={currentUserId} />
        </div>
      )}
      </div>
    </div>
  );
});
