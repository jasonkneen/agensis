import { Headphones, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useHuddleSession } from './HuddleSessionContext';

// The huddle trigger, sized to sit in the channel toolbar next to Messages /
// Files / Threads. It replaces the idle state of the old full-width strip.
//
// It is only ever a TRIGGER. Once you are in a call the in-call controls (mute,
// leave, end, the agent switcher, the live caption) stay in the strip below,
// which has room for them — a h-11 toolbar row does not, and cramming them in
// is how the caption line ends up squeezing the tabs off the edge.

export function HuddleToolbarButton({ className }: { className?: string }) {
  const huddle = useHuddleSession();
  if (!huddle) return null;

  const { state, configured, busy, connection, startOrJoin } = huddle;
  const live = state?.active ? state : null;

  // LiveKit is not configured on this deployment: don't advertise a button that
  // can only fail.
  if (!live && !configured) return null;

  // In the call already — the strip below owns leaving. A second control that
  // looked like "join" but meant nothing would just be a trap.
  if (connection) {
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
      onClick={() => void startOrJoin()}
      title={live ? 'Join the huddle in this channel' : 'Start a voice huddle in this channel'}
    >
      <Headphones data-icon="inline-start" />
      {live ? 'Join' : 'Huddle'}
    </Button>
  );
}
