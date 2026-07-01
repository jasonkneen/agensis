import { useEffect, useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useAgentRegistrations } from '../../hooks/useAgentRegistrations';
import { useActivity } from '../../hooks/useActivity';

// A notification item is either a pending agent-registration request (needs the
// owner's decision) or a single timestamped agent connect/disconnect event.
// Approvals are surfaced read-only here — the forced-choice RegistrationApprovalPopup
// is what actually collects the decision. Connection events are a true history
// (one row per connect/disconnect), sourced from the activity feed.
type NotificationItem =
  | { kind: 'approval'; id: string; handle: string; label: string; isNew: boolean; at: string }
  | { kind: 'connection'; id: string; handle: string; connected: boolean; at: string };

function relative(at: string): string {
  const ms = new Date(at).getTime();
  if (Number.isNaN(ms)) return '';
  try {
    return formatDistanceToNow(ms, { addSuffix: true });
  } catch {
    return '';
  }
}

function StatusDot({ tone }: { tone: 'online' | 'offline' | 'pending' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-1.5 size-2 shrink-0 rounded-full',
        tone === 'online' && 'bg-emerald-500',
        tone === 'offline' && 'bg-muted-foreground/40',
        tone === 'pending' && 'bg-amber-500',
      )}
    />
  );
}

export function NotificationsBell({ workspaceId }: { workspaceId: string | null }) {
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

    // Connect/disconnect history — events arrive newest-first from useActivity.
    // Capped so a chatty workspace doesn't make the list unbounded.
    const connections: NotificationItem[] = events
      .filter((e) => e.event_type === 'agent_connected' || e.event_type === 'agent_disconnected')
      .slice(0, 30)
      .map((e) => {
        const meta = (e.metadata ?? {}) as { handle?: unknown; name?: unknown };
        const handle =
          (typeof meta.handle === 'string' && meta.handle) ||
          (typeof meta.name === 'string' && meta.name) ||
          e.title.replace(/^@/, '').replace(/\s+(connected|disconnected)$/i, '') ||
          'agent';
        return {
          kind: 'connection',
          id: `connection:${e.id}`,
          handle,
          connected: e.event_type === 'agent_connected',
          at: e.created_at,
        };
      });

    return [...approvals, ...connections];
  }, [pending, events]);

  // The badge counts only things that need attention — pending approvals.
  // Connection events are informational, so they never light the red badge;
  // instead, activity you haven't opened the bell to see yet drives a soft
  // pulse ring (visually distinct from the approvals badge).
  const badgeCount = pending.length;

  // "Unseen" = the newest connect/disconnect event is newer than the last time
  // this workspace's bell was opened. Keyed per workspace so it never bleeds
  // across workspaces.
  const lastSeenKey = workspaceId ? `notif:lastSeen:${workspaceId}` : null;
  const newestActivityAt = useMemo(() => {
    let newest = 0;
    for (const e of events) {
      if (e.event_type !== 'agent_connected' && e.event_type !== 'agent_disconnected') continue;
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

  const markSeen = () => {
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

  return (
    <Popover onOpenChange={(open) => { if (open) markSeen(); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="default"
          size="icon-lg"
          className="relative size-9 rounded-full shadow-lg transition-transform hover:scale-105"
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
        <PopoverHeader className="px-3 py-2.5">
          <PopoverTitle className="text-sm">Notifications</PopoverTitle>
        </PopoverHeader>
        <Separator />
        <div className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">You're all caught up.</p>
          ) : (
            items.map((item) => (
              <div key={item.id} className="flex items-start gap-2.5 px-3 py-2 text-sm">
                <StatusDot tone={item.kind === 'approval' ? 'pending' : item.connected ? 'online' : 'offline'} />
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
                  ) : (
                    <p className="leading-snug">
                      <span className="font-medium">@{item.handle}</span>{' '}
                      <span className="text-muted-foreground">{item.connected ? 'connected' : 'disconnected'}</span>
                    </p>
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
