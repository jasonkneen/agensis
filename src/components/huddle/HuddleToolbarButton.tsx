import { useEffect } from 'react';
import { Headphones, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { HuddleAgentOption } from '@/lib/huddleAgents';
import { useHuddleSession } from './HuddleSessionContext';
import { useHuddleDock } from './HuddleDockContext';

// The huddle trigger, sized to sit in the channel toolbar next to Messages /
// Files / Threads. It replaces the idle state of the old full-width strip.
//
// It is only ever a TRIGGER. Once you are in a call the in-call controls (mute,
// leave, end, the agent switcher, the live caption) live in the app-level dock,
// which has room for them — a h-11 toolbar row does not.
//
// It is also the one place that can see BOTH the channel's agent roster and the
// dock, so it is where the roster is handed over. The dock is mounted above
// every view and has no way to look a channel's participants up for itself.

const NO_AGENTS: HuddleAgentOption[] = [];

export function HuddleToolbarButton({
  className,
  workspaceId,
  sessionId,
  title,
  agents = NO_AGENTS,
}: {
  className?: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  title?: string;
  /** The channel's agents, in roster order. Empty in a DM. */
  agents?: HuddleAgentOption[];
}) {
  const huddle = useHuddleSession();
  const dock = useHuddleDock();

  // Keep the dock's copy current for as long as this channel is on screen.
  // Snapshotting at click time is not enough: participants are still loading
  // when the button is first clickable, so the call would start with no agents
  // and every spoken sentence in a channel would wake nobody.
  const setTargetAgents = dock?.setTargetAgents;
  useEffect(() => {
    if (!setTargetAgents || !sessionId) return;
    setTargetAgents(sessionId, agents);
  }, [setTargetAgents, sessionId, agents]);

  if (!huddle) return null;

  const { state, configured, busy, connection, startOrJoin } = huddle;
  const live = state?.active ? state : null;

  // LiveKit is not configured on this deployment: don't advertise a button that
  // can only fail.
  if (!live && !configured) return null;

  // Already in this call — the dock owns leaving. A second control that looked
  // like "join" but meant nothing would just be a trap.
  if (connection || dock?.target?.sessionId === sessionId) {
    return (
      <span
        className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-emerald-500', className)}
        title="You are in this huddle"
      >
        <Radio className="size-4 animate-pulse" aria-hidden />
        In huddle
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant={live ? 'default' : 'ghost'}
      size="sm"
      className={cn('h-8 shrink-0 px-2', className)}
      disabled={busy}
      onClick={() => {
        // The app-level dock owns the connection from here: it is mounted
        // above every view, so navigating away no longer ends the call. The
        // channel-scoped session below still supplies this button's label.
        if (dock && workspaceId && sessionId) {
          dock.openHuddle({ workspaceId, sessionId, title: title || 'this conversation', agents });
          return;
        }
        void startOrJoin();
      }}
      title={live ? 'Join the huddle in this channel' : 'Start a voice huddle in this channel'}
    >
      <Headphones data-icon="inline-start" />
      {live ? 'Join' : 'Huddle'}
    </Button>
  );
}
