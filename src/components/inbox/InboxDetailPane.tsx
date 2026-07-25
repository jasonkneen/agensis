import { useState } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  CATEGORY_ICON,
  MICRO_LABEL,
  categoryAccent,
} from './inboxPresentation';
import {
  CATEGORY_LABEL,
  absoluteTime,
  relativeTime,
  type InboxGroup,
} from './inboxModel';

// ---------------------------------------------------------------------------
// The reading pane. Same shape as any inbox: a header that answers "what is
// this, who sent it, when, and what can I do about it" without scrolling, then
// the body, then the tail of the thread.
//
// `now` is the same timestamp the list rows were formatted against — the pane
// never reads the clock itself, so nothing here can start a re-render loop.
// ---------------------------------------------------------------------------

interface InboxDetailProps {
  group: InboxGroup;
  now: number;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  onResolveBlocker?: (entityId: string, status: 'answered' | 'dismissed', response?: string) => Promise<boolean>;
}

export function InboxDetail({ group, now, onClose, onOpenSession, onResolveBlocker }: InboxDetailProps) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Closing removes the item from the list, so the pane unmounts on success and
  // there is no state to reset. On failure the blocker stays put and says so —
  // silently swallowing this would leave the agent waiting forever on an answer
  // the human believes they gave.
  const close = async (status: 'answered' | 'dismissed') => {
    if (!onResolveBlocker || !group.entityId || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await onResolveBlocker(group.entityId, status, status === 'answered' ? reply : '');
    if (ok) onClose();
    else { setFailed(true); setBusy(false); }
  };
  const Icon = CATEGORY_ICON[group.category];
  const accent = categoryAccent(group.category);
  const earlier = group.items.slice(1);
  const canOpen = !!group.sessionId && !!onOpenSession;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-card">
      <header className="shrink-0 border-b border-border px-3 pb-2.5 pt-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', accent || 'text-muted-foreground')} />
          <span className={cn(MICRO_LABEL, 'shrink-0')}>{CATEGORY_LABEL[group.category]}</span>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {absoluteTime(group.latestAt)}
          </span>
          <div className="flex-1" />
          {canOpen && (
            <Button
              type="button"
              size="xs"
              className="shrink-0"
              onClick={() => onOpenSession?.(group.sessionId as string)}
            >
              <ExternalLink data-icon="inline-start" />
              Open chat
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            onClick={onClose}
            aria-label="Close detail"
          >
            <X />
          </Button>
        </div>

        <h3 className="mt-1.5 text-sm font-semibold leading-snug tracking-tight">{group.title}</h3>
        {group.actorName && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{group.actorName}</p>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {group.category === 'blocker' && (
            <div className="flex flex-col gap-2 rounded-md border-l-2 border-amber-500 bg-amber-500/[0.06] px-2.5 py-2">
              <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                An agent stopped here and needs a decision from you. Your answer is saved on the
                blocker and the agent reads it back — that is what wakes it up.
              </p>

              {onResolveBlocker && group.entityId && (
                <>
                  <Textarea
                    value={reply}
                    onChange={event => setReply(event.target.value)}
                    disabled={busy}
                    rows={2}
                    placeholder="Your answer (optional) — the agent will read this"
                    className="min-h-0 resize-y bg-background text-[13px]"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      className="h-7"
                      disabled={busy}
                      onClick={() => void close('answered')}
                    >
                      <Check className="size-3.5" />
                      Resolve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-muted-foreground"
                      disabled={busy}
                      onClick={() => void close('dismissed')}
                    >
                      Dismiss
                    </Button>
                    {failed && (
                      <span role="alert" className="text-[11px] text-destructive">
                        Could not save — still open.
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {group.body && (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
              {group.body}
            </p>
          )}

          {(group.entityType || group.entityId) && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border pt-3 text-[11px]">
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
            <div className="flex flex-col border-t border-border pt-3">
              <div className={cn(MICRO_LABEL, 'mb-1')}>Earlier in this thread ({earlier.length})</div>
              {earlier.map(item => {
                const ItemIcon = CATEGORY_ICON[item.category];
                return (
                  <div
                    key={item.id}
                    className="flex h-7 min-w-0 items-center gap-2 border-b border-border/60 text-[13px] last:border-b-0"
                  >
                    <ItemIcon
                      aria-hidden="true"
                      className={cn(
                        'size-3.5 shrink-0',
                        categoryAccent(item.category) || 'text-muted-foreground/70',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground/70">{item.title}</span>
                    <span className="w-[4.25rem] shrink-0 text-right tabular-nums text-muted-foreground">
                      {relativeTime(item.createdAt, now)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {!group.body && earlier.length === 0 && !canOpen && (
            <p className="text-xs text-muted-foreground">Nothing more to show for this one.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
