import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Brain,
  CheckCircle2,
  FileText,
  MessageSquare,
  Plus,
} from 'lucide-react';
import type { ActiveView, ChatSession, Document, MemoryFact, Task } from '../../types';
import { stripHtml } from '../../lib/utils';
import { backendClient } from '../../lib/backendClient';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  documents: Document[];
  sessions: ChatSession[];
  facts: MemoryFact[];
  tasks?: Task[];
  onDocumentOpen: (doc: Document) => void;
  onSessionOpen: (session: ChatSession) => void;
  onTaskOpen?: (task: Task) => void;
  onViewChange: (view: ActiveView) => void;
}

interface ResultItem {
  id: string;
  type: 'document' | 'chat' | 'memory' | 'task' | 'action';
  label: string;
  detail?: string;
  icon: React.ReactNode;
  badge: string;
  onSelect: () => void;
}

function scoreMatch(text: string, query: string): number {
  if (!query) return 1;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const exact = lower.indexOf(q);
  if (exact === 0) return 1000;
  if (exact > 0) return 500 - Math.min(exact, 400);

  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length ? 50 : 0;
}

const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  documents,
  sessions,
  facts,
  tasks = [],
  onDocumentOpen,
  onSessionOpen,
  onTaskOpen,
  onViewChange,
}) => {
  const [query, setQuery] = useState('');

  // NET-06: the documents list is metadata-only, so full-content search fetches
  // bodies ONLY while the palette is open (not on every workspace load). Keyed on
  // the doc id+updated_at signature so an edited doc's body is refetched.
  const [docBodies, setDocBodies] = useState<Record<string, string>>({});
  const docSignature = documents.map(d => `${d.id}:${d.updated_at}`).join(',');
  useEffect(() => {
    if (!open || documents.length === 0) return;
    let cancelled = false;
    const workspaceId = documents[0].workspace_id;
    const wanted = new Set(documents.map(d => d.id));
    // NET-06: one batched fetch scoped to the workspace (the query builder only
    // supports eq), then client-filter to the docs we're showing.
    backendClient.from('documents').select('id, content').eq('workspace_id', workspaceId).then(({ data }) => {
      if (cancelled) return;
      const rows = Array.isArray(data) ? data as { id: string; content?: string }[] : [];
      const next: Record<string, string> = {};
      for (const row of rows) if (wanted.has(row.id)) next[row.id] = row.content || '';
      setDocBodies(next);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docSignature captures the docs to fetch; open gates it
  }, [open, docSignature]);

  const actions: ResultItem[] = useMemo(
    () => [
      {
        id: 'action-new-chat',
        type: 'action' as const,
        label: 'New Channel',
        icon: <Plus data-icon="inline-start" className="size-4" />,
        badge: 'Action',
        onSelect: () => {
          onViewChange('chat');
          onClose();
        },
      },
      {
        id: 'action-new-doc',
        type: 'action' as const,
        label: 'New Document',
        icon: <Plus data-icon="inline-start" className="size-4" />,
        badge: 'Action',
        onSelect: () => {
          onViewChange('document');
          onClose();
        },
      },
      {
        id: 'action-go-memory',
        type: 'action' as const,
        label: 'Go to Memory',
        icon: <ArrowRight data-icon="inline-start" className="size-4" />,
        badge: 'Action',
        onSelect: () => {
          onViewChange('memory');
          onClose();
        },
      },
      {
        id: 'action-go-tasks',
        type: 'action' as const,
        label: 'Go to Tasks',
        icon: <CheckCircle2 data-icon="inline-start" className="size-4" />,
        badge: 'Action',
        onSelect: () => {
          onViewChange('tasks');
          onClose();
        },
      },
      {
        id: 'action-go-activity',
        type: 'action' as const,
        label: 'Go to Activity',
        icon: <Activity data-icon="inline-start" className="size-4" />,
        badge: 'Action',
        onSelect: () => {
          onViewChange('activity');
          onClose();
        },
      },
      {
        id: 'action-go-files',
        type: 'action' as const,
        label: 'Go to Files',
        icon: <ArrowRight data-icon="inline-start" className="size-4" />,
        badge: 'Action',
        onSelect: () => {
          onViewChange('files');
          onClose();
        },
      },
    ],
    [onViewChange, onClose],
  );

  const catalog = useMemo(() => {
    const docs = documents.map(doc => {
      const plainContent = stripHtml(docBodies[doc.id] ?? doc.content ?? '');
      return {
        item: {
          id: `doc-${doc.id}`,
          type: 'document' as const,
          label: doc.title,
          detail: plainContent.slice(0, 120),
          icon: <FileText data-icon="inline-start" className="size-4" />,
          badge: 'Document',
          onSelect: () => {
            onDocumentOpen(doc);
            onClose();
          },
        } as ResultItem,
        haystack: `${doc.title}\n${plainContent}`,
      };
    });

    const chats = sessions.map(session => ({
      item: {
        id: `chat-${session.id}`,
        type: 'chat' as const,
        label: session.title,
        icon: <MessageSquare data-icon="inline-start" className="size-4" />,
        badge: 'Channel',
        onSelect: () => {
          onSessionOpen(session);
          onClose();
        },
      } as ResultItem,
      haystack: session.title,
    }));

    const memories = facts.map(fact => ({
      item: {
        id: `memory-${fact.id}`,
        type: 'memory' as const,
        label: fact.fact,
        icon: <Brain data-icon="inline-start" className="size-4" />,
        badge: fact.category || 'Memory',
        onSelect: () => {
          onViewChange('memory');
          onClose();
        },
      } as ResultItem,
      haystack: `${fact.category || ''} ${fact.fact}`,
    }));

    const taskItems = tasks.map(task => ({
      item: {
        id: `task-${task.id}`,
        type: 'task' as const,
        label: task.title,
        detail: task.description ? task.description.slice(0, 120) : `${task.status.replace('_', ' ')} - ${task.priority}`,
        icon: <CheckCircle2 data-icon="inline-start" className="size-4" />,
        badge: task.status === 'done' ? 'Done' : 'Task',
        onSelect: () => {
          if (onTaskOpen) onTaskOpen(task);
          else onViewChange('tasks');
          onClose();
        },
      } as ResultItem,
      haystack: `${task.title} ${task.description || ''}`,
    }));

    const actionItems = actions.map(a => ({ item: a, haystack: a.label }));

    return [...docs, ...chats, ...memories, ...taskItems, ...actionItems];
  }, [documents, docBodies, sessions, facts, tasks, actions, onDocumentOpen, onSessionOpen, onTaskOpen, onViewChange, onClose]);

  const filteredResults = useMemo(() => {
    const q = query.trim();
    if (!q) return catalog.map(c => c.item);
    const scored = catalog
      .map(c => ({ item: c.item, score: scoreMatch(c.haystack, q) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map(s => s.item);
  }, [catalog, query]);

  const groupedResults = useMemo(() => {
    const groups: { label: string; items: ResultItem[] }[] = [];
    const docItems = filteredResults.filter(r => r.type === 'document');
    const chatItems = filteredResults.filter(r => r.type === 'chat');
    const taskItems = filteredResults.filter(r => r.type === 'task');
    const memoryItems = filteredResults.filter(r => r.type === 'memory');
    const actionItems = filteredResults.filter(r => r.type === 'action');

    if (docItems.length > 0) groups.push({ label: 'Documents', items: docItems });
    if (chatItems.length > 0) groups.push({ label: 'Channels', items: chatItems });
    if (taskItems.length > 0) groups.push({ label: 'Tasks', items: taskItems });
    if (memoryItems.length > 0) groups.push({ label: 'Memory', items: memoryItems });
    if (actionItems.length > 0) groups.push({ label: 'Actions', items: actionItems });

    return groups;
  }, [filteredResults]);

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose();
      }}
      title="Command Palette"
      description="Search documents, channels, memory, tasks, and actions."
      className="top-[15vh] w-[min(720px,calc(100vw-2rem))] max-w-none sm:max-w-none translate-y-0"
    >
      <Command shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery} placeholder="Search documents, channels, memory..." />
        <CommandList className="max-h-[400px]">
          <CommandEmpty>No results</CommandEmpty>
          {groupedResults.map(group => (
            <CommandGroup key={group.label} heading={group.label}>
              {group.items.map(item => (
                <CommandItem key={item.id} value={`${item.label} ${item.detail || ''}`} onSelect={item.onSelect}>
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-data-selected/command-item:bg-primary group-data-selected/command-item:text-primary-foreground">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{item.label}</span>
                    {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[11px]">
                    {item.badge}
                  </Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
};

export default CommandPalette;
