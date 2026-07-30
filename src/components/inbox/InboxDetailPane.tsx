import { useState } from 'react';
import { ArrowLeft, Check, ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  CATEGORY_ICON,
  MICRO_LABEL,
  PANE_HEADER,
  SCROLL_VIEWPORT_BLOCK,
  categoryAccent,
} from './inboxPresentation';
import {
  absoluteTime,
  inboxPreview,
  inboxTypeLabel,
  relativeTime,
  senderInitials,
  senderLabel,
  type InboxGroup,
} from './inboxModel';
import { inboxOpenTarget } from './inboxSources';
import { PermissionRequestCard } from '../chat/PermissionRequestCard';
import type { InboxOpenSession } from './inboxNavigation';
import type { PermissionRequest, PermissionScope } from '../../types';

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
  /** The live request behind an `approval` row, when it is still answerable. */
  approval?: PermissionRequest | null;
  /** True while any decision is in flight — the buttons go quiet, not away. */
  decidingApproval?: boolean;
  onClose: () => void;
  onOpenSession?: InboxOpenSession;
  onResolveBlocker?: (entityId: string, status: 'answered' | 'dismissed', response?: string) => Promise<boolean>;
  /** Resolves '' on success, or the reason the decision did not land. */
  onDecideApproval?: (requestId: string, behavior: 'allow' | 'deny', scope: PermissionScope) => Promise<string>;
}

export function InboxDetail({
  group,
  now,
  backButtonClass,
  approval = null,
  decidingApproval = false,
  onClose,
  onOpenSession,
  onResolveBlocker,
  onDecideApproval,
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
  const openTarget = inboxOpenTarget(group);
  const canOpen = !!openTarget && !!onOpenSession;

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
        <span className="min-w-0 truncate text-sm font-semibold leading-5 tracking-tight text-foreground">
          {label.chip ? `${label.text} ${label.chip}` : label.text}
        </span>
        <div className="flex-1" />
        {canOpen && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
            onClick={() => onOpenSession?.({ ...(openTarget as NonNullable<typeof openTarget>), beside: true })}
            title="Opens beside the inbox, focused on this thread where there is one."
          >
            <ExternalLink data-icon="inline-start" />
            {openTarget?.threadParentId ? 'Open thread' : 'Open chat'}
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

      <ScrollArea className={cn('min-h-0 flex-1', SCROLL_VIEWPORT_BLOCK)}>
        <div className="flex min-w-0 flex-col gap-3 px-3 py-3">
          {/* Same face, same left edge, same type sizes as the row it came from
              — opening an item should feel like the row grew, not like a jump
              to a different screen. */}
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
            >
              {initials || <Icon className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-5 text-foreground">{sender}</div>
              <div className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
                {absoluteTime(group.latestAt)}
              </div>
            </div>
          </div>

          {/* The question comes BEFORE the answer box. Reading order is the whole
              job of this pane — an answer field above the thing being asked is
              how you get replies to a question nobody read.

              Suppressed for an approval, whose card below restates the same
              summary in full and with the rules attached. */}
          {body && !approval && (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
              {body}
            </p>
          )}

          {/* An agent is holding a tool call open on the other end of a socket,
              and it expires. Answering it HERE is the point of surfacing it
              here at all — bouncing the reader into the transcript to click the
              same four buttons would just add a step to a ten-minute fuse.
              Deliberately the same component the transcript renders, so the two
              places you can answer from cannot offer different scopes. */}
          {approval && onDecideApproval && (
            <PermissionRequestCard
              request={approval}
              bare
              busy={decidingApproval}
              onDecide={async (behavior, scope) => {
                const failure = await onDecideApproval(approval.id, behavior, scope);
                // Thrown, not swallowed: the card catches it and shows the
                // server's own sentence, which is the only thing that explains
                // "that agent is no longer connected" or "already decided".
                if (failure) throw new Error(failure);
              }}
            />
          )}

          {group.category === 'blocker' && (
            <div className="flex flex-col gap-2 rounded-md border-l-2 border-amber-500 bg-amber-500/[0.06] px-2.5 py-2">
              <p className="text-xs leading-snug text-amber-700 dark:text-amber-300/90">
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
                    className="min-h-0 resize-y bg-background text-sm"
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
                      <span role="alert" className="text-xs text-destructive">
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
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
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
                <div key={item.id} className="flex min-w-0 items-baseline gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/50">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.title}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                    {relativeTime(item.createdAt, now)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(group.entityType || group.entityId) && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-xs">
              {group.entityType && (
                <>
                  <dt className="text-muted-foreground">Entity</dt>
                  <dd className="min-w-0 truncate font-mono">{group.entityType}</dd>
                </>
              )}
              {group.entityId && (
                <>
                  <dt className="text-muted-foreground">Id</dt>
                  <dd className="min-w-0 truncate font-mono">{group.entityId}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
