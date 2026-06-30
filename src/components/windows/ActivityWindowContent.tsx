import React from 'react';
import {
  Activity,
  Brain,
  CheckCircle2,
  FileText,
  MessageCircle,
  MessageSquare,
  Palette,
  UserPlus,
} from 'lucide-react';
import type { ActivityEvent, ActivityEventType } from '../../types';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';

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

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
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

export function ActivityWindowContent({ events, loading }: ActivityWindowContentProps) {
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
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-3">
        {groupByDay(events).map(group => (
          <section key={group.label} className="flex flex-col gap-1.5">
            <Marker variant="separator">
              <MarkerContent>{group.label}</MarkerContent>
            </Marker>
            <ItemGroup className="gap-0.5">
              {group.items.map(event => (
                <Item key={event.id} variant="default" size="xs" className="hover:bg-muted/50">
                  <ItemMedia variant="icon" className="size-6 rounded-full bg-muted [&_svg]:size-3.5">
                    {iconFor(event.event_type)}
                  </ItemMedia>
                  <ItemContent className="min-w-0 flex-row items-baseline gap-1.5">
                    <ItemTitle className="min-w-0 max-w-full flex-1 truncate">{event.title}</ItemTitle>
                    <ItemDescription className="shrink-0 text-xs">{formatTime(event.created_at)}</ItemDescription>
                  </ItemContent>
                  <Badge variant="secondary" className="shrink-0">{event.event_type.replace(/_/g, ' ')}</Badge>
                </Item>
              ))}
            </ItemGroup>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}
