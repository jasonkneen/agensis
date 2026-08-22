import React, { useMemo, useState } from 'react';
import { Check, CornerDownRight, MessageCircle, Send, Trash2, X } from 'lucide-react';
import type { DocumentComment } from '../../types';
import type { CreateCommentInput } from '../../hooks/useDocumentComments';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty';
import { Item, ItemContent } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface DocumentCommentsProps {
  comments: DocumentComment[];
  topLevel: DocumentComment[];
  replyMap: Record<string, DocumentComment[]>;
  currentUserId?: string;
  currentUserEmail: string;
  pendingAnchor?: string;
  onAnchorConsumed?: () => void;
  onCreate: (input: CreateCommentInput) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onClose?: () => void;
  /**
   * Agent id -> display name, for comments an AGENT authored (through the
   * reply_to_comment MCP tool). Optional: without it an agent comment still
   * says "Agent" rather than claiming a human wrote it, which is the part that
   * must never be wrong.
   */
  agentNames?: Record<string, string>;
}

const avatarColors = [
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-green-500',
  'bg-cyan-500',
  'bg-blue-500',
  'bg-violet-500',
  'bg-pink-500',
];

function userInitial(email?: string): string {
  return (email?.[0] || 'U').toUpperCase();
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return date.toLocaleDateString();
}

export function DocumentComments({
  comments,
  topLevel,
  replyMap,
  currentUserEmail,
  pendingAnchor,
  onAnchorConsumed,
  onCreate,
  onResolve,
  onDelete,
  onClose,
  agentNames,
}: DocumentCommentsProps) {
  const [newContent, setNewContent] = useState('');
  const [anchorText, setAnchorText] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  if (pendingAnchor && pendingAnchor !== anchorText) {
    setAnchorText(pendingAnchor);
    onAnchorConsumed?.();
  }

  const visibleTopLevel = useMemo(
    () => topLevel.filter(c => showResolved || !c.resolved),
    [topLevel, showResolved],
  );

  const unresolvedCount = topLevel.filter(c => !c.resolved).length;
  const canSubmit = newContent.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onCreate({
      content: newContent.trim(),
      parent_id: replyTo,
      anchor_text: replyTo ? undefined : anchorText || undefined,
    });
    setNewContent('');
    setAnchorText('');
    setReplyTo(null);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l border-border/60 bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <MessageCircle data-icon="inline-start" className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground">Comments</span>
        {unresolvedCount > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {unresolvedCount}
          </Badge>
        )}
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setShowResolved(v => !v)}
          title={showResolved ? 'Hide resolved' : 'Show resolved'}
          className={cn(showResolved && 'text-primary')}
        >
          {showResolved ? 'Hide resolved' : 'Show all'}
        </Button>
        {onClose && (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} title="Close comments">
            <X data-icon="inline-start" className="size-3" />
          </Button>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-2.5">
          {visibleTopLevel.length === 0 ? (
            <Empty className="min-h-40 border-0 p-4">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircle className="size-4" />
                </EmptyMedia>
                <EmptyDescription className="text-xs">
                  {comments.length === 0
                    ? 'No comments yet. Start a conversation about this doc.'
                    : 'No unresolved comments.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            visibleTopLevel.map(comment => (
              <CommentThread
                key={comment.id}
                comment={comment}
                replies={replyMap[comment.id] || []}
                isReplyTarget={replyTo === comment.id}
                onStartReply={() => setReplyTo(comment.id)}
                onCancelReply={() => setReplyTo(null)}
                onResolve={onResolve}
                onDelete={onDelete}
                agentNames={agentNames}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <footer className="shrink-0 space-y-2 border-t border-border/60 p-3">
        {anchorText && !replyTo && (
          <Item variant="muted" size="xs" className="items-start border-l-2 border-l-primary text-xs italic">
            <ItemContent className="min-w-0">
              <p className="line-clamp-2 text-muted-foreground">
                &ldquo;{anchorText.slice(0, 120)}{anchorText.length > 120 ? '...' : ''}&rdquo;
              </p>
            </ItemContent>
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => setAnchorText('')} title="Clear anchor">
              <X data-icon="inline-start" className="size-3" />
            </Button>
          </Item>
        )}
        {replyTo && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <CornerDownRight className="size-3" />
            <span>Replying to comment</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto size-5"
              onClick={() => setReplyTo(null)}
              title="Cancel reply"
            >
              <X data-icon="inline-start" className="size-3" />
            </Button>
          </div>
        )}
        <div className="flex items-start gap-2 rounded-lg border bg-card p-2">
          <UserAvatar email={currentUserEmail} className="size-5" />
          <Textarea
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            onKeyDown={handleKey}
            placeholder={replyTo ? 'Reply...' : 'Add a comment...'}
            rows={2}
            className="min-h-10 flex-1 resize-none border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
          />
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title="Send (Cmd+Enter)"
            size="icon-xs"
            className="rounded-full"
          >
            <Send data-icon="inline-start" className="size-3" />
          </Button>
        </div>
      </footer>
    </aside>
  );
}

function CommentThread({
  comment,
  replies,
  isReplyTarget,
  onStartReply,
  onCancelReply,
  onResolve,
  onDelete,
  agentNames,
}: {
  comment: DocumentComment;
  replies: DocumentComment[];
  isReplyTarget: boolean;
  agentNames?: Record<string, string>;
  onStartReply: () => void;
  onCancelReply: () => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Item
      variant={isReplyTarget ? 'outline' : 'muted'}
      className={cn(
        'block rounded-lg p-2.5',
        isReplyTarget && 'border-primary/40 bg-primary/5',
        comment.resolved && 'opacity-60',
      )}
    >
      <CommentBody comment={comment} onResolve={onResolve} onDelete={onDelete} agentNames={agentNames} />

      {comment.anchor_text && (
        <blockquote className="mt-2 line-clamp-2 rounded border-l-2 border-l-primary bg-muted/60 px-2 py-1 text-[10px] italic text-muted-foreground">
          "{comment.anchor_text.slice(0, 120)}{comment.anchor_text.length > 120 ? '...' : ''}"
        </blockquote>
      )}

      {replies.length > 0 && (
        <div className="mt-2 space-y-1.5 border-l border-border pl-3">
          {replies.map(r => (
            <CommentBody key={r.id} comment={r} onResolve={onResolve} onDelete={onDelete} compact agentNames={agentNames} />
          ))}
        </div>
      )}

      {!comment.resolved && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-1 h-5 px-1.5 text-[10px] text-muted-foreground"
          onClick={isReplyTarget ? onCancelReply : onStartReply}
        >
          {isReplyTarget ? 'Cancel' : 'Reply'}
        </Button>
      )}
    </Item>
  );
}

function CommentBody({
  comment,
  onResolve,
  onDelete,
  compact,
  agentNames,
}: {
  comment: DocumentComment;
  agentNames?: Record<string, string>;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <UserAvatar seed={comment.agent_id || comment.user_id || comment.id} className={compact ? 'size-4' : 'size-5'} />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          {/* An agent-authored comment must never render as "Teammate". Where
              the agent's name is unavailable it says "Agent" — vaguer, but
              true, which is the half that matters when the question is whether
              a person or a machine wrote this. */}
          <span className={cn('font-semibold text-foreground', compact ? 'text-[10px]' : 'text-[11px]')}>
            {comment.agent_id ? (agentNames?.[comment.agent_id] || 'Agent') : 'Teammate'}
          </span>
          {comment.agent_id && (
            <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">agent</span>
          )}
          <span className="text-[9px] text-muted-foreground">{formatTime(comment.created_at)}</span>
          <div className="flex-1" />
          {!compact && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={cn('size-5', comment.resolved && 'text-primary')}
              onClick={() => onResolve(comment.id, !comment.resolved)}
              title={comment.resolved ? 'Reopen' : 'Resolve'}
            >
              <Check data-icon="inline-start" className="size-3" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 text-muted-foreground"
            onClick={() => onDelete(comment.id)}
            title="Delete"
          >
            <Trash2 data-icon="inline-start" className="size-3" />
          </Button>
        </div>
        <p className={cn('whitespace-pre-wrap break-words text-foreground', compact ? 'text-[11px]' : 'text-xs')}>
          {comment.content}
        </p>
      </div>
    </div>
  );
}

function UserAvatar({ email, seed, className }: { email?: string; seed?: string; className?: string }) {
  const source = email || seed || 'user';
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  const color = avatarColors[Math.abs(hash) % avatarColors.length];

  return (
    <Avatar className={cn(className)}>
      <AvatarFallback className={cn(color, 'text-[10px] font-bold text-white')}>{userInitial(email || source)}</AvatarFallback>
    </Avatar>
  );
}
