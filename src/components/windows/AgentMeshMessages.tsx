import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useSessionMessages } from '../../hooks/useSessionMessages';
import { useTaskComments } from '../../hooks/useTaskComments';
import { resolveTaskCommentAuthor } from '../../lib/taskAgents';
import type { WorkspaceAgent } from '../../types';
import type { MeshPopupTarget } from './agentMeshModel';

// The level-4 read-only transcript. Deliberately its OWN component, mounted only
// while a leaf is open, so the diagram never fetches: a count badge must never
// cost a round-trip per thread, and mounting is the cheapest possible "lazy".

const MONO = "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

interface Row {
  id: string;
  author: string;
  body: string;
  at: string;
  self: boolean;
}

function Shell({ title, subtitle, rows, loading, onClose }: {
  title: string;
  subtitle: string;
  rows: Row[];
  loading: boolean;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  return (
    <div
      className="absolute inset-y-6 right-4 flex w-[320px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur-sm"
      role="dialog"
      aria-label={`Messages in ${title}`}
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-[10px] tracking-widest text-muted-foreground" style={{ fontFamily: MONO }}>
            {subtitle}
          </div>
        </div>
        <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close messages">
          <X size={13} />
        </Button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
        {loading && rows.length === 0 ? (
          <div className="flex h-full items-center justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
            Nothing has been said here yet.
          </div>
        ) : (
          rows.map(row => (
            <div key={row.id} className="space-y-0.5">
              <div className="flex items-baseline gap-1.5 text-[10px]" style={{ fontFamily: MONO }}>
                <span className={row.self ? 'font-semibold text-primary' : 'font-semibold text-foreground'}>{row.author}</span>
                <span className="text-muted-foreground/60">{row.at}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-muted-foreground">
                {row.body}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function shortTime(value?: string | null): string {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function SessionTranscript({ target, onClose }: { target: MeshPopupTarget; onClose: () => void }) {
  const { messages } = useSessionMessages(target.id);
  const rows: Row[] = messages.slice(-60).map(message => ({
    id: message.id,
    author: message.sender_name || (message.role === 'assistant' ? 'Agent' : 'You'),
    body: message.content || '',
    at: shortTime(message.created_at),
    self: message.role === 'user',
  }));
  return <Shell title={target.title} subtitle="THREAD" rows={rows} loading={false} onClose={onClose} />;
}

function TaskTranscript({ target, workspaceId, userId, agents, onClose }: {
  target: MeshPopupTarget;
  workspaceId: string | null;
  userId?: string | null;
  agents: WorkspaceAgent[];
  onClose: () => void;
}) {
  const { comments, loading } = useTaskComments(target.id, workspaceId, userId ?? undefined);
  const rows: Row[] = comments.slice(-60).map(comment => {
    const author = resolveTaskCommentAuthor(comment, { members: [], agents, currentUserId: userId ?? undefined });
    return {
      id: comment.id,
      author: author.label,
      body: comment.content || '',
      at: shortTime(comment.created_at),
      self: author.kind === 'you',
    };
  });
  return <Shell title={target.title} subtitle="TASK THREAD" rows={rows} loading={loading} onClose={onClose} />;
}

export function AgentMeshMessages({ target, workspaceId, userId, agents, onClose }: {
  target: MeshPopupTarget;
  workspaceId?: string | null;
  userId?: string | null;
  agents: WorkspaceAgent[];
  onClose: () => void;
}) {
  if (target.kind === 'task') {
    return (
      <TaskTranscript
        target={target}
        workspaceId={workspaceId ?? null}
        userId={userId}
        agents={agents}
        onClose={onClose}
      />
    );
  }
  return <SessionTranscript target={target} onClose={onClose} />;
}
