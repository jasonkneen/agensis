import { useCallback, useEffect, useMemo, useState } from 'react';
import { Captions, CaptionsOff, ChevronDown, Headphones, Radio, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CHROME_DEPTH } from '@/lib/chromeDepth';
import {
  buildDockParticipants,
  HUDDLE_DOCK_TABS,
  normalizeHuddleDockTab,
  participantInitials,
  shouldShowHuddleDock,
  type HuddleDockTab,
} from '@/lib/huddleDock';
import { huddleDuration } from '@/lib/huddleState';
import type { HuddleState } from '@/types';
import { useHuddleDock } from './HuddleDockContext';
import { HuddlePanel } from './HuddlePanel';

// ---------------------------------------------------------------------------
// THE HUDDLE, AS ONE PANEL.
//
// Rendered at App level, outside every window and every view, so it survives
// navigation — the whole reason the session was lifted into HuddleDockContext.
// It carries what used to be scattered across a header strip, a side panel and
// a toolbar: who is in the call, the in-call controls, captions, and the
// conversation itself.
//
// It floats ABOVE the window layer and the dock (CHROME_DEPTH.huddlePanel) but
// BELOW modals: a dialog must still be able to open over a call, or a confirm
// raised from inside the huddle would be painted behind it.
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 380;

export function HuddleDock() {
  const dock = useHuddleDock();
  const [tab, setTab] = useState<HuddleDockTab>(() => normalizeHuddleDockTab(null));
  const [captionsOn, setCaptionsOn] = useState(true);

  const session = dock?.session ?? null;
  const state = session?.state ?? null;
  const connection = session?.connection ?? null;

  const participants = useMemo(
    () => buildDockParticipants({
      humans: state?.participants ?? [],
      // The dock does not own the agent roster — the channel does. Agents are
      // read from the huddle state's own participant list where present; the
      // panel below still shows the full roster.
      agents: [],
    }),
    [state?.participants],
  );

  const handleLeave = useCallback(() => {
    session?.leave();
    dock?.closeHuddle();
  }, [session, dock]);

  const handleEnd = useCallback(() => {
    void session?.end();
    dock?.closeHuddle();
  }, [session, dock]);

  if (!dock || !dock.target) return null;

  const visible = shouldShowHuddleDock({
    hasTarget: !!dock.target,
    connected: !!connection,
    live: !!state?.active,
    hasError: !!session?.error,
  });
  if (!visible) return null;

  const live = !!state?.active;

  return (
    <aside
      data-huddle-dock
      aria-label={`Huddle in ${dock.target.title}`}
      className={cn(
        'agensis-glass-panel fixed bottom-4 right-4 flex flex-col overflow-hidden rounded-xl border shadow-2xl',
        dock.collapsed ? 'h-auto' : 'h-[min(34rem,calc(100vh-6rem))]',
      )}
      style={{ width: PANEL_WIDTH, zIndex: CHROME_DEPTH.huddlePanel }}
    >
      {/* Header: what and where, always visible even when collapsed, so a
          minimised call still says which conversation it belongs to. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {live ? (
          <Radio className="size-4 shrink-0 animate-pulse text-emerald-500 motion-reduce:animate-none" aria-hidden />
        ) : (
          <Headphones className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{dock.target.title}</span>
          {state && <DockTimer state={state} />}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={dock.collapsed ? 'Expand huddle' : 'Collapse huddle'}
          aria-expanded={!dock.collapsed}
          onClick={() => dock.setCollapsed(!dock.collapsed)}
        >
          <ChevronDown className={cn('transition-transform', dock.collapsed && 'rotate-180')} />
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={handleLeave}>Leave</Button>
        {live && (
          <Button type="button" variant="ghost" size="xs" className="text-destructive" onClick={handleEnd}>
            End
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close huddle panel" onClick={() => dock.closeHuddle()}>
          <X />
        </Button>
      </div>

      {/* Participants stay visible while collapsed: "who is in this call" is
          the one thing worth seeing without expanding it. */}
      {participants.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
          {participants.map(participant => (
            <span
              key={participant.id}
              title={participant.name}
              className={cn(
                'grid size-6 place-items-center rounded-full text-[10px] font-semibold',
                participant.kind === 'agent'
                  ? 'bg-primary/15 text-primary'
                  : 'bg-muted text-muted-foreground',
                participant.speaking && 'ring-2 ring-emerald-500',
              )}
            >
              {participantInitials(participant.name)}
            </span>
          ))}
        </div>
      )}

      {!dock.collapsed && (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
            {HUDDLE_DOCK_TABS.map(name => (
              <Button
                key={name}
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={tab === name}
                className={cn('capitalize', tab === name && 'bg-muted text-foreground')}
                onClick={() => setTab(name)}
              >
                {name}
              </Button>
            ))}
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={captionsOn ? 'Hide captions' : 'Show captions'}
              aria-pressed={captionsOn}
              title={captionsOn ? 'Hide captions' : 'Show captions'}
              onClick={() => setCaptionsOn(value => !value)}
            >
              {captionsOn ? <Captions /> : <CaptionsOff />}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === 'chat' || tab === 'transcript' ? (
              <HuddlePanel
                workspaceId={dock.target.workspaceId}
                huddleId={state?.id ?? null}
                onClose={handleLeave}
              />
            ) : (
              <div className="p-3 text-sm text-muted-foreground">
                Notes and actions from this call will appear here.
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * The elapsed clock. huddleDuration() takes `now`, so something has to tick —
 * a frozen timestamp would render a duration that never advances.
 *
 * A third local copy of this pattern (HuddleCard and HuddlePanel each have
 * one). Left local rather than extracted because pulling the other two onto a
 * shared component is a refactor of surfaces this change does not otherwise
 * touch, and those have their own tests.
 */
function DockTimer({ state }: { state: HuddleState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.active]);
  const text = huddleDuration(state, now);
  if (!text) return null;
  return <span className="block truncate text-xs text-muted-foreground">{text}</span>;
}
