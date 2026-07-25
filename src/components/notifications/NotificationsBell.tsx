import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useAgentRegistrations } from '../../hooks/useAgentRegistrations';
import { useActivity } from '../../hooks/useActivity';

// A notification is one of:
//  - approval: a pending agent-registration request (needs the owner's decision;
//    the forced-choice RegistrationApprovalPopup collects it, this is read-only)
//  - connection: an agent connect/disconnect event
//  - activity: any other important workspace event (new chat/doc/task, task done,
//    memory added, comment, agent message) sourced from the activity feed.
type NotificationItem =
  | { kind: 'approval'; id: string; handle: string; label: string; isNew: boolean; at: string }
  | { kind: 'connection'; id: string; handle: string; connected: boolean; at: string }
  | { kind: 'activity'; id: string; title: string; tone: NotificationTone; at: string };

type NotificationTone = 'online' | 'offline' | 'pending' | 'info';

// Event types worth surfacing in the bell, mapped to a dot tone. Anything not
// listed (e.g. low-signal internal events) is skipped. `message_sent` is
// intentionally omitted — agent chatter would flood the bell; the chat window
// and sidebar status feed already surface those.
const NOTIFIABLE_ACTIVITY: Record<string, NotificationTone> = {
  chat_created: 'info',
  document_created: 'info',
  document_updated: 'info',
  document_deleted: 'offline',
  task_created: 'info',
  task_updated: 'info',
  task_completed: 'online',
  canvas_updated: 'info',
  memory_added: 'info',
  comment_created: 'info',
  member_joined: 'online',
};

function relative(at: string): string {
  const ms = new Date(at).getTime();
  if (Number.isNaN(ms)) return '';
  try {
    return formatDistanceToNow(ms, { addSuffix: true });
  } catch {
    return '';
  }
}

function StatusDot({ tone }: { tone: NotificationTone }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-1.5 size-2 shrink-0 rounded-full',
        tone === 'online' && 'bg-emerald-500',
        tone === 'offline' && 'bg-muted-foreground/40',
        tone === 'pending' && 'bg-amber-500',
        tone === 'info' && 'bg-sky-500',
      )}
    />
  );
}

export function NotificationsBell({ workspaceId, variant = 'floating' }: { workspaceId: string | null; variant?: 'floating' | 'inline' }) {
  const { pending } = useAgentRegistrations(workspaceId);
  const { events } = useActivity(workspaceId);

  const items = useMemo<NotificationItem[]>(() => {
    const approvals: NotificationItem[] = pending.map((req) => ({
      kind: 'approval',
      id: `approval:${req.id}`,
      handle: req.requested_handle || req.requested_name || 'agent',
      label: req.client_label?.trim() || 'A client',
      isNew: !req.agent_id,
      at: req.created_at,
    }));

    // Agent connect/disconnect history — events arrive newest-first.
    const connections: NotificationItem[] = events
      .filter((e) => e.event_type === 'agent_connected' || e.event_type === 'agent_disconnected')
      .map((e) => {
        const meta = (e.metadata ?? {}) as { handle?: unknown; name?: unknown };
        const handle =
          (typeof meta.handle === 'string' && meta.handle) ||
          (typeof meta.name === 'string' && meta.name) ||
          e.title.replace(/^@/, '').replace(/\s+(connected|disconnected)$/i, '') ||
          'agent';
        return {
          kind: 'connection' as const,
          id: `connection:${e.id}`,
          handle,
          connected: e.event_type === 'agent_connected',
          at: e.created_at,
        };
      });

    // Other important workspace activity (new docs/tasks/chats, task completions,
    // memory, comments). The activity feed already carries a human-readable title.
    const activity: NotificationItem[] = events
      .filter((e) => e.event_type in NOTIFIABLE_ACTIVITY)
      .map((e) => ({
        kind: 'activity' as const,
        id: `activity:${e.id}`,
        title: e.title,
        tone: NOTIFIABLE_ACTIVITY[e.event_type],
        at: e.created_at,
      }));

    // Approvals first (they need a decision), then everything else newest-first.
    const feed = [...connections, ...activity].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
    return [...approvals, ...feed.slice(0, 40)];
  }, [pending, events]);

  // The badge counts only things that need attention — pending approvals.
  // Connection events are informational, so they never light the red badge;
  // instead, activity you haven't opened the bell to see yet drives a soft
  // pulse ring (visually distinct from the approvals badge).
  const badgeCount = pending.length;

  // "Unseen" = the newest surfaced event (connection or important activity) is
  // newer than the last time this workspace's bell was opened. Keyed per
  // workspace so it never bleeds across workspaces.
  const lastSeenKey = workspaceId ? `notif:lastSeen:${workspaceId}` : null;
  const newestActivityAt = useMemo(() => {
    let newest = 0;
    for (const e of events) {
      const shown = e.event_type === 'agent_connected' || e.event_type === 'agent_disconnected' || e.event_type in NOTIFIABLE_ACTIVITY;
      if (!shown) continue;
      const t = new Date(e.created_at).getTime();
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    return newest;
  }, [events]);

  const [lastSeenAt, setLastSeenAt] = useState(0);
  useEffect(() => {
    if (!lastSeenKey) {
      setLastSeenAt(0);
      return;
    }
    const raw = Number(localStorage.getItem(lastSeenKey));
    setLastSeenAt(Number.isFinite(raw) ? raw : 0);
  }, [lastSeenKey]);

  const hasUnseen = newestActivityAt > 0 && newestActivityAt > lastSeenAt;

  // "Unread" (for the All/Unread toggle) is judged against the lastSeenAt that
  // was in effect *before* this popover session opened it — captured into a
  // ref so opening the bell doesn't instantly mark everything read out from
  // under the toggle.
  const unreadBaselineRef = useRef(0);
  const markSeen = () => {
    unreadBaselineRef.current = lastSeenAt;
    const now = Math.max(newestActivityAt, Date.now());
    setLastSeenAt(now);
    if (lastSeenKey) {
      try {
        localStorage.setItem(lastSeenKey, String(now));
      } catch {
        /* localStorage unavailable — degrade to session-only */
      }
    }
  };

  // Per-item dismissal for the "Clear" button. Local/persisted only — the
  // underlying activity feed is an immutable, insert-only audit log, so
  // "clearing" hides items from this popover rather than deleting anything.
  // Approvals are excluded: they represent a pending decision, not a
  // dismissible notification.
  const dismissedKey = workspaceId ? `notif:dismissed:${workspaceId}` : null;
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!dismissedKey) {
      setDismissed(new Set());
      return;
    }
    try {
      const raw = localStorage.getItem(dismissedKey);
      setDismissed(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    } catch {
      setDismissed(new Set());
    }
  }, [dismissedKey]);

  const persistDismissed = (next: Set<string>) => {
    setDismissed(next);
    if (dismissedKey) {
      try {
        // Cap so this never grows unbounded across a long-lived workspace.
        localStorage.setItem(dismissedKey, JSON.stringify([...next].slice(-200)));
      } catch {
        /* localStorage unavailable — degrade to session-only */
      }
    }
  };

  const visibleItems = useMemo(
    () => items.filter((item) => item.kind === 'approval' || !dismissed.has(item.id)),
    [items, dismissed],
  );

  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const filteredItems = showUnreadOnly
    ? visibleItems.filter(
        (item) => item.kind === 'approval' || new Date(item.at).getTime() > unreadBaselineRef.current,
      )
    : visibleItems;

  const clearableIds = visibleItems.filter((item) => item.kind !== 'approval').map((item) => item.id);
  const clearAll = () => {
    if (clearableIds.length === 0) return;
    persistDismissed(new Set([...dismissed, ...clearableIds]));
  };

  return (
    <Popover onOpenChange={(open) => { if (open) markSeen(); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={variant === 'inline' ? 'ghost' : 'default'}
          size={variant === 'inline' ? 'icon-sm' : 'icon-lg'}
          className={
            variant === 'inline'
              ? 'relative'
              : 'relative size-9 rounded-full shadow-lg transition-transform hover:scale-105'
          }
          title={hasUnseen ? 'Notifications — new activity' : 'Notifications'}
          aria-label={
            badgeCount > 0
              ? `Notifications, ${badgeCount} pending`
              : hasUnseen
                ? 'Notifications, new activity'
                : 'Notifications'
          }
        >
          <Bell className="size-4" />
          {hasUnseen && (
            <>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-emerald-400/60 animate-ping"
              />
              {badgeCount === 0 && (
                <span
                  aria-hidden
                  className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-500"
                />
              )}
            </>
          )}
          {badgeCount > 0 && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
            >
              {badgeCount > 9 ? '9+' : badgeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 p-0">
        <PopoverHeader className="flex flex-row items-center justify-between gap-2 px-3 py-2.5">
          <PopoverTitle className="text-sm">Notifications</PopoverTitle>
          <div className="flex items-center gap-1.5">
            <div className="flex items-center rounded-md bg-muted p-0.5 text-[11px] leading-none">
              <button
                type="button"
                onClick={() => setShowUnreadOnly(false)}
                aria-pressed={!showUnreadOnly}
                className={cn(
                  'rounded px-1.5 py-1 font-medium transition-colors',
                  !showUnreadOnly ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setShowUnreadOnly(true)}
                aria-pressed={showUnreadOnly}
                className={cn(
                  'rounded px-1.5 py-1 font-medium transition-colors',
                  showUnreadOnly ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Unread
              </button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={clearAll}
              disabled={clearableIds.length === 0}
            >
              Clear
            </Button>
          </div>
        </PopoverHeader>
        <Separator />
        <div className="max-h-80 overflow-y-auto py-1">
          {filteredItems.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {showUnreadOnly ? 'No unread notifications.' : "You're all caught up."}
            </p>
          ) : (
            filteredItems.map((item) => (
              <div key={item.id} className="flex items-start gap-2.5 px-3 py-2 text-sm">
                <StatusDot
                  tone={
                    item.kind === 'approval'
                      ? 'pending'
                      : item.kind === 'connection'
                        ? (item.connected ? 'online' : 'offline')
                        : item.tone
                  }
                />
                <div className="min-w-0 flex-1">
                  {item.kind === 'approval' ? (
                    <p className="leading-snug">
                      <span className="font-medium">{item.label}</span>{' '}
                      {item.isNew ? 'wants to register as' : 'wants to connect as'}{' '}
                      <span className="font-medium">@{item.handle}</span>
                      <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        Approval pending
                      </span>
                    </p>
                  ) : item.kind === 'connection' ? (
                    <p className="leading-snug">
                      <span className="font-medium">@{item.handle}</span>{' '}
                      <span className="text-muted-foreground">{item.connected ? 'connected' : 'disconnected'}</span>
                    </p>
                  ) : (
                    <p className="leading-snug">{item.title}</p>
                  )}
                  {item.at && <p className="mt-0.5 text-[11px] text-muted-foreground">{relative(item.at)}</p>}
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
