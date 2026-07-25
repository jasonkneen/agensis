import { useState } from 'react';
import { ArrowLeft, Check, ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { CATEGORY_ICON, MICRO_LABEL, PANE_HEADER, categoryAccent } from './inboxPresentation';
import {
  absoluteTime,
  inboxPreview,
  inboxTypeLabel,
  relativeTime,
  senderInitials,
  senderLabel,
  type InboxGroup,
} from './inboxModel';

// ---------------------------------------------------------------------------
// The reading pane.
//
// Its header is the SAME 36px band as the list header, so the two line up
// pixel-for-pixel across the divider. Everything expensive lives here and
// nothing leaks back into the row: the blocker answer box, the raw entity ids,
// the thread tail.
//
// `now` is the same timestamp the list rows were formatted against — the pane
// never reads the clock itself, so nothing here can start a re-render loop.
// ---------------------------------------------------------------------------

interface InboxDetailProps {
  group: InboxGroup;
  now: number;
  /** Container-query class that reveals the back arrow in single-column mode. */
  backButtonClass?: string;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  onResolveBlocker?: (entityId: string, status: 'answered' | 'dismissed', response?: string) => Promise<boolean>;
}

export function InboxDetail({
  group,
  now,
  backButtonClass,
  onClose,
  onOpenSession,
  onResolveBlocker,
}: InboxDetailProps) {
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
  const label = inboxTypeLabel(group);
  const sender = senderLabel(group);
  const initials = senderInitials(sender);
  const body = inboxPreview(group);
  const earlier = group.items.slice(1);
  const canOpen = !!group.sessionId && !!onOpenSession;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <header className={PANE_HEADER}>
        {backButtonClass && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn('shrink-0', backButtonClass)}
            onClick={onClose}
            aria-label="Back to inbox list"
          >
            <ArrowLeft />
          </Button>
        )}
        <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', accent || 'text-muted-foreground')} />
        <span className="min-w-0 truncate text-[13px] font-semibold leading-4 tracking-tight text-foreground">
          {label.chip ? `${label.text} ${label.chip}` : label.text}
        </span>
        <div className="flex-1" />
        {canOpen && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
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
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-3 py-3">
          {/* Same face, same left edge, same type sizes as the row it came from
              — opening an item should feel like the row grew, not like a jump
              to a different screen. */}
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
            >
              {initials || <Icon className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold leading-4 text-foreground">{sender}</div>
              <div className="mt-0.5 truncate text-[11px] leading-[13px] text-muted-foreground">
                {absoluteTime(group.latestAt)}
              </div>
            </div>
          </div>

          {/* The question comes BEFORE the answer box. Reading order is the whole
              job of this pane — an answer field above the thing being asked is
              how you get replies to a question nobody read. */}
          {body && (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{body}</p>
          )}

          {group.category === 'blocker' && (
            <div className="flex flex-col gap-2 rounded-md border-l-2 border-amber-500 bg-amber-500/[0.06] px-2.5 py-2">
              <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-300/90">
                The agent is waiting on this. It reads your answer back to unblock itself.
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

          {/* The blocker's own body field carries the answer already given, which
              is not the same thing as the question shown above it. */}
          {group.category === 'blocker' && group.body.trim() && (
            <div className="rounded-md bg-muted/50 px-2.5 py-2">
              <div className={cn(MICRO_LABEL, 'mb-1')}>Answer on file</div>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
                {group.body}
              </p>
            </div>
          )}

          {earlier.length > 0 && (
            <div className="flex flex-col">
              <div className={cn(MICRO_LABEL, 'mb-1.5')}>Earlier in this thread ({earlier.length})</div>
              {/* Denser than a list row and, like the list, drawn with no rules
                  between entries. */}
              {earlier.map(item => (
                <div key={item.id} className="flex min-w-0 items-baseline gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-muted/50">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.title}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                    {relativeTime(item.createdAt, now)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(group.entityType || group.entityId) && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-[11px]">
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
        </div>
      </ScrollArea>
    </section>
  );
}
