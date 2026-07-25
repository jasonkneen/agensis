import React, { useState } from 'react';
import {
  Activity,
  Brain,
  CheckCircle2,
  FileText,
  MessageCircle,
  MessageSquare,
  Palette,
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
import { cn } from '@/lib/utils';

interface ActivityWindowContentProps {
  events: ActivityEvent[];
  loading: boolean;
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

export const ActivityWindowContent = React.memo(function ActivityWindowContent({ events, loading }: ActivityWindowContentProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    <div className="flex h-full min-h-0">
      <ScrollArea className={cn('h-full min-w-0', selectedEvent ? 'w-[46%] shrink-0 border-r' : 'flex-1')}>
        <div className="flex flex-col p-1.5">
          {groupByDay(events).map(group => (
            <section key={group.label} className="flex flex-col">
              <Marker variant="separator" className="px-1.5 py-1">
                <MarkerContent className="text-[10px] uppercase tracking-wide text-muted-foreground">{group.label}</MarkerContent>
              </Marker>
              <div className="flex flex-col">
                {group.items.map(event => {
                  const selected = event.id === selectedId;
                  return (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => setSelectedId(selected ? null : event.id)}
                      title={formatFullDate(event.created_at)}
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-md border-l-2 border-transparent px-1.5 py-1 text-left text-xs transition-colors',
                        selected ? 'border-l-primary bg-primary/10' : 'hover:bg-muted/50',
                      )}
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{formatClock(event.created_at)}</span>
                      <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{iconFor(event.event_type)}</span>
                      <span className="min-w-0 flex-1 truncate">{event.title}</span>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">{event.event_type.replace(/_/g, ' ')}</Badge>
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
            <span className="text-muted-foreground [&_svg]:size-4">{iconFor(selectedEvent.event_type)}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{selectedEvent.title}</span>
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => setSelectedId(null)} aria-label="Close detail">
              <X />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{selectedEvent.event_type.replace(/_/g, ' ')}</Badge>
                <span className="text-xs text-muted-foreground">{formatFullDate(selectedEvent.created_at)}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {selectedEvent.entity_type && (
                  <>
                    <dt className="text-muted-foreground">Entity type</dt>
                    <dd className="truncate font-mono">{selectedEvent.entity_type}</dd>
                  </>
                )}
                {selectedEvent.entity_id && (
                  <>
                    <dt className="text-muted-foreground">Entity id</dt>
                    <dd className="truncate font-mono">{selectedEvent.entity_id}</dd>
                  </>
                )}
                {selectedEvent.user_id && (
                  <>
                    <dt className="text-muted-foreground">User id</dt>
                    <dd className="truncate font-mono">{selectedEvent.user_id}</dd>
                  </>
                )}
              </dl>
              {selectedEvent.metadata && Object.keys(selectedEvent.metadata).length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Metadata</div>
                  <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-2 text-[11px] leading-relaxed">
                    {JSON.stringify(selectedEvent.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
});
