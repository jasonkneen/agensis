import { useEffect, useState } from 'react';
import { Headphones, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useHuddle } from '@/hooks/useHuddle';
import { huddleDuration, participantSummary } from '@/lib/huddleState';
import { HuddleBar } from './HuddleBar';
import type { HuddleState } from '@/types';

// The huddle card: one slim strip between the channel header and the transcript.
//
// It is deliberately bound to THIS channel's session. The conversation that
// happens in a huddle belongs to the channel it was called from, so there is no
// "view thread" button pointing somewhere else — a seam an earlier
// implementation shipped, where the link opened an empty thread while the real
// conversation had been archived elsewhere.
//
// Participant state comes from the server's append-only event log (folded in
// useHuddle), which is fed only by LiveKit's signed webhook. A browser cannot
// add itself to the roster; it can only ask for a token for itself.

interface HuddleCardProps {
  workspaceId: string | null;
  sessionId: string | null;
  className?: string;
}

export function HuddleCard({ workspaceId, sessionId, className }: HuddleCardProps) {
  const { state, configured, busy, error, connection, startOrJoin, end, leave } = useHuddle(workspaceId, sessionId);

  if (!workspaceId || !sessionId) return null;

  const live = state?.active ? state : null;
  const recentlyEnded = state && !state.active ? state : null;

  // Nothing to show and nothing to offer: LiveKit is not configured on this
  // deployment, so don't advertise a button that can only fail.
  if (!live && !configured) return null;

  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-1.5 text-xs',
        live ? 'bg-emerald-500/5' : 'bg-card/40',
        className,
      )}
      data-testid="huddle-card"
    >
      <span className="flex shrink-0 items-center gap-1.5 font-medium">
        {live ? (
          <Radio className="size-3.5 text-emerald-500" aria-hidden />
        ) : (
          <Headphones className="size-3.5 text-muted-foreground" aria-hidden />
        )}
        {live ? 'Huddle' : recentlyEnded ? 'Huddle ended' : 'Huddle'}
      </span>

      {live && <HuddleLiveDetail state={live} />}
      {!live && recentlyEnded && <EndedDetail state={recentlyEnded} />}

      {error && <span className="min-w-0 truncate text-destructive">{error}</span>}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {connection ? (
          <HuddleBar connection={connection} onLeave={leave} onEnd={() => void end()} />
        ) : (
          <Button
            type="button"
            size="sm"
            variant={live ? 'default' : 'ghost'}
            className="h-7 gap-1 px-2 text-xs"
            disabled={busy}
            onClick={() => void startOrJoin()}
          >
            <Headphones className="size-3.5" />
            {live ? 'Join' : 'Start huddle'}
          </Button>
        )}
      </div>
    </div>
  );
}

function HuddleLiveDetail({ state }: { state: HuddleState }) {
  const roster = participantSummary(state.participants);
  return (
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
      <HuddleTimer state={state} />
      {/* An active huddle whose roster is empty is real, not a bug: the starter's
          browser has not finished connecting, so LiveKit has not told us anyone
          is in the room yet. Say that, rather than counting someone who isn't
          there — the mistake that makes an ended huddle claim "1 participant". */}
      <span className="min-w-0 truncate">
        {state.participantCount === 0
          ? 'waiting for the first person to connect'
          : `${state.participantCount} in the huddle · ${roster}`}
      </span>
    </span>
  );
}

function EndedDetail({ state }: { state: HuddleState }) {
  // Truthful counts only, all derived from the event log: zero people are in an
  // ended huddle, and "how many were here" is peak/ever, not a floored 1.
  const joined = state.everJoinedCount;
  return (
    <span className="min-w-0 truncate text-muted-foreground">
      {huddleDuration(state, Date.now())}
      {joined > 0 ? ` · ${joined} ${joined === 1 ? 'person' : 'people'} joined` : ' · nobody joined'}
    </span>
  );
}

// A leaf so the 1s tick re-renders four characters, not the whole chat window.
function HuddleTimer({ state }: { state: HuddleState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.active]);
  const label = huddleDuration(state, now);
  if (!label) return null;
  return <span className="font-mono tabular-nums">{label}</span>;
}
