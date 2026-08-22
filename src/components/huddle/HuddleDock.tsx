import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, CaptionsOff, ChevronDown, GripVertical, Headphones, Radio, Volume2, VolumeX, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CHROME_DEPTH } from '@/lib/chromeDepth';
import {
  buildRoomDockParticipants,
  huddleVoiceInputState,
  HUDDLE_DOCK_TABS,
  IDLE_HUDDLE_LOCAL,
  normalizeHuddleDockTab,
  participantInitials,
  sameHuddleLocalState,
  shouldShowHuddleDock,
  type HuddleDockTab,
  type HuddleLocalState,
} from '@/lib/huddleDock';
import { huddleDuration } from '@/lib/huddleState';
import { huddleTranscriptTarget } from '@/lib/huddleTranscript';
import type { HuddleAgentOption } from '@/lib/huddleAgents';
import { useHuddleHeartbeat } from '@/hooks/useHuddle';
import type { HuddleState } from '@/types';
import { useHuddleDock } from './HuddleDockContext';
import { HuddleSessionContext } from './HuddleSessionContext';
import { HuddleAgentStrip } from './HuddleAgentStrip';
import { HuddleCaption } from './HuddleCaption';
import { HuddleNotes } from './HuddleNotes';
import { HuddlePanel } from './HuddlePanel';
import { HuddleMicButton, HuddleRoom, HuddleSpeakingNow } from './HuddleRoom';

// ---------------------------------------------------------------------------
// THE HUDDLE, AS ONE PANEL.
//
// Rendered at App level, outside every window and every view, so it survives
// navigation — the whole reason the session was lifted into HuddleDockContext.
// It carries what used to be scattered across a header strip, a side panel and
// a toolbar: who is in the call, the in-call controls, captions, and the
// conversation itself.
//
// AND IT OWNS THE CALL. That is the part that shipped missing: the dock read
// the join token and used it as a boolean for visibility, so it rendered a
// panel around a WebRTC session that was never established. Nobody connected,
// including the local user, and the roster was empty in every huddle because
// presence is written when a browser confirms its own connection — which
// nothing did. <HuddleRoom> below is the fix, and it is mounted HERE rather
// than in a channel view precisely because this is the thing that survives
// navigation.
//
// It floats ABOVE the window layer and the dock (CHROME_DEPTH.huddlePanel) but
// BELOW modals: a dialog must still be able to open over a call, or a confirm
// raised from inside the huddle would be painted behind it.
//
// AGENTS IN THE HUDDLE are real LiveKit participants. The browser publishes
// the selected active agent as a reliable room signal; that worker owns the
// human audio input and publishes speech back into the room. Other agent tiles
// remain visible but stay silent until selected. Typed channel messages keep
// their existing @handle/composer dispatch path; they are not duplicated into
// the voice media plane.
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 380;
const NO_AGENTS: HuddleAgentOption[] = [];

export function HuddleDock() {
  const dock = useHuddleDock();
  const [tab, setTab] = useState<HuddleDockTab>(() => normalizeHuddleDockTab(null));
  const [captionsOn, setCaptionsOn] = useState(true);
  const [local, setLocal] = useState<HuddleLocalState>(IDLE_HUDDLE_LOCAL);
  const [outputMuted, setOutputMuted] = useState(false);
  // Which agent owns the shared voice floor. It is room-scoped ephemeral state,
  // mirrored from the huddle controller rather than persisted to the channel.
  // Keep the huddle key beside the selection: the dock survives navigation and
  // can render huddle B before the target packet arrives, so a selection from A
  // must never become B's first publish.
  const [activeAgentId, setActiveAgentId] = useState('');
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [activeAgentHuddleId, setActiveAgentHuddleId] = useState('');

  // WHERE THE PANEL SITS. null means "leave it pinned bottom-right", which is
  // the default and what everyone who never touches the grip keeps. Once it has
  // been dragged we own both axes explicitly, so the CSS anchor is dropped.
  const panelRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const clamp = useCallback((x: number, y: number) => {
    const rect = panelRef.current?.getBoundingClientRect();
    const w = rect?.width ?? PANEL_WIDTH;
    const h = rect?.height ?? 0;
    return {
      x: Math.min(Math.max(x, 8), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(y, 8), Math.max(8, window.innerHeight - h - 8)),
    };
  }, []);

  const startDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    setPos(clamp(rect.left, rect.top));

    const move = (e: PointerEvent) => {
      const grab = dragRef.current;
      if (!grab) return;
      setPos(clamp(e.clientX - grab.dx, e.clientY - grab.dy));
    };
    const stop = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [clamp]);

  // The grip is a button, so it takes focus; arrow keys have to move the panel
  // or it is a drag affordance nobody without a mouse can use.
  const nudge = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 32 : 8;
    const delta =
      event.key === 'ArrowLeft' ? [-step, 0]
      : event.key === 'ArrowRight' ? [step, 0]
      : event.key === 'ArrowUp' ? [0, -step]
      : event.key === 'ArrowDown' ? [0, step]
      : null;
    if (!delta) return;
    event.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos(clamp(rect.left + delta[0], rect.top + delta[1]));
  }, [clamp]);

  // A window that shrinks under a dragged panel must not strand it off-screen —
  // and neither must expanding a collapsed panel that was dragged low.
  const collapsed = !!dock?.collapsed;
  const positioned = !!pos;
  useEffect(() => {
    if (!positioned) return;
    const reclamp = () => setPos(current => (current ? clamp(current.x, current.y) : current));
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
    // `pos` is deliberately absent: re-running on every drag frame would fight
    // the pointer. Only viewport or panel-height changes need a re-clamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, positioned, clamp]);

  const session = dock?.session ?? null;
  const state = session?.state ?? null;
  const connection = session?.connection ?? null;
  const workspaceId = dock?.target?.workspaceId ?? null;
  const targetAgents = dock?.target?.agents ?? NO_AGENTS;

  // Voice workers receive a roster snapshot when the huddle starts. Keep the
  // selector on that same snapshot: a live channel roster can gain an agent
  // later, but no worker (and no target validator) exists for it in this room.
  const voiceRoster = useRef<{ huddleId: string; ids: string[] | null }>({ huddleId: '', ids: null });
  const voiceHuddleId = connection?.huddleId || '';
  if (voiceRoster.current.huddleId !== voiceHuddleId) {
    voiceRoster.current = { huddleId: voiceHuddleId, ids: null };
  }
  if (voiceHuddleId && voiceRoster.current.ids === null && targetAgents.length > 0) {
    voiceRoster.current.ids = targetAgents.map(agent => agent.id);
  }
  const agents = useMemo(() => {
    const ids = voiceRoster.current.ids;
    return ids ? targetAgents.filter(agent => ids.includes(agent.id)) : targetAgents;
  }, [targetAgents]);
  // READING one huddle rather than being in a call. The channel marker
  // ("You were in a huddle · 12:04 · Ada, Sam") opens this, and the huddle it
  // points at may have ended months ago. The dock is the only place a huddle is
  // shown now — the channel's side panel is gone — so this mode has to exist
  // here or that marker would be a link to nothing.
  const recordHuddleId = dock?.target?.huddleId || '';

  // WHERE THE WORDS GO. The huddle's own session when it has one; the host
  // channel only for huddles that predate transcript sessions, where the
  // channel genuinely was the transcript — so the fallback is the old
  // behaviour, not a leak of the new one.
  const transcriptSessionId = huddleTranscriptTarget(state, dock?.target?.sessionId ?? null);

  // The first agent is active until you pick another, and an agent that leaves
  // the roster mid-call hands the floor back to the first rather than leaving
  // the strip pointing at nobody.
  const selectedAgentId = activeAgentHuddleId === voiceHuddleId ? activeAgentId : '';
  const activeAgent = useMemo(
    () => agents.find(agent => agent.id === selectedAgentId) || agents[0] || null,
    [agents, selectedAgentId],
  );
  const voiceInput = useMemo(
    () => huddleVoiceInputState(local, activeAgent?.id || ''),
    [local, activeAgent?.id],
  );
  // The target is a shared room floor, not a per-browser preference. The
  // huddle starter is the sole publisher so two humans cannot race revisions
  // and make different workers answer at once.
  const legacyHumanIds = [...new Set([
    ...local.roomParticipants.filter(participant => participant.kind === 'human').map(participant => participant.identity),
    connection?.identity || '',
  ].filter(Boolean))].sort();
  const legacyControllerIdentity = legacyHumanIds[0] || connection?.identity || '';
  const canControlTarget = state?.startedBy
    ? !connection?.identity || connection.identity === `user:${state.startedBy}`
    : !legacyControllerIdentity || legacyControllerIdentity === connection?.identity;

  // Stable identity (HuddleRoom reports through it from an effect), and a no-op
  // when nothing actually changed.
  const handleLocalChange = useCallback((next: HuddleLocalState) => {
    setLocal(prev => (sameHuddleLocalState(prev, next) ? prev : next));
  }, []);
  const handleTargetChanged = useCallback((next: string | null) => {
    setActiveAgentHuddleId(voiceHuddleId);
    setActiveAgentId(next || '');
  }, [voiceHuddleId]);
  const handleAgentSelect = useCallback((next: string) => {
    setActiveAgentHuddleId(voiceHuddleId);
    setActiveAgentId(next);
  }, [voiceHuddleId]);

  useEffect(() => {
    if (!connection) setLocal(IDLE_HUDDLE_LOCAL);
  }, [connection]);

  // The moment OUR WebRTC session is actually up, tell the server — the roster
  // is fed only by LiveKit's webhook otherwise, which requires a dashboard step
  // that in 48 huddles never happened, so it forever read "waiting for the
  // first person to connect" while that person was live and talking. Keyed on
  // the connection epoch: a retry is the same event, a rejoin is a new one.
  const confirmedEpochRef = useRef(0);
  useEffect(() => {
    if (!connection || !local.connected) return;
    if (confirmedEpochRef.current === connection.joinedAtMs) return;
    confirmedEpochRef.current = connection.joinedAtMs;
    void session?.confirmJoin(connection);
  }, [connection, local.connected, session]);

  // …and keep saying it. The confirm above is a one-off claim, and a browser
  // that crashes, sleeps or is force-quit never posts the matching /leave — so
  // without a heartbeat that claim would stand forever and the roster would
  // show someone who is not there.
  useHuddleHeartbeat(
    workspaceId,
    connection?.huddleId || '',
    connection?.joinedAtMs || 0,
    connection?.heartbeatIntervalMs || 0,
    !!connection && local.connected,
  );

  // Replies are read from the SAME session the transcript goes into. Pointing
  // this at the channel while speech posts into the huddle would mean the agent
  // answers in the huddle and the browser reads the channel aloud — a call
  // where nobody's replies are ever heard.
  // Speech is no longer this browser's job.
  //
  // The agent is a real LiveKit participant now (voice-worker/): it subscribes to
  // room audio, runs STT and VAD server-side, and publishes its reply as an audio
  // track that RoomAudioRenderer plays like anyone else's voice. That deletes an
  // entire parallel pipeline — a SECOND getUserMedia feeding Deepgram, and TTS
  // played to the local speakers outside the room — along with the echo guard it
  // needed, because LiveKit cancels echo on a track it actually owns.
  //
  // Barge-in follows for free: capture is never muted, so talking over an agent
  // reaches it mid-sentence instead of being discarded.
  const speakingName = useMemo(() => {
    const speaking = local.roomParticipants.filter(participant => participant.isSpeaking && !participant.isLocal);
    return speaking[0]?.name || '';
  }, [local.roomParticipants]);

  // The chips come from the ROOM, so a chip can only show someone actually
  // connected. Previously agents had no LiveKit presence at all and had to be
  // synthesised from a roster no presence event ever mentioned.
  const participants = useMemo(
    () => buildRoomDockParticipants(local.roomParticipants, activeAgent?.id || ''),
    [local.roomParticipants, activeAgent?.id],
  );

  // PERMANENTLY STABLE, via refs. handleLeave is also LiveKitRoom's
  // `onDisconnected`, and useHuddle returns a fresh object every render — so a
  // dependency array would give this a new identity on every provider render
  // and re-run LiveKit's own event-binding effect each time. The neighbouring
  // connect effect keys on `onError` in the same way, and that one reconnects:
  // an unstable handler there is how this component once called room.connect()
  // eighty times in a few seconds.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const dockRef = useRef(dock);
  dockRef.current = dock;

  const handleLeave = useCallback(() => {
    setShowLeaveDialog(true);
  }, []);

  const confirmLeave = useCallback(() => {
    setShowLeaveDialog(false);
    // closeHuddle posts /leave for this connection epoch before clearing the
    // one-slot target, so presence is cleaned up rather than left to the reaper.
    dockRef.current?.closeHuddle();
  }, []);

  const handleEnd = useCallback(() => {
    void sessionRef.current?.end();
    dockRef.current?.closeHuddle();
  }, []);

  if (!dock || !dock.target) return null;

  const visible = shouldShowHuddleDock({
    hasTarget: !!dock.target,
    connected: !!connection,
    live: !!state?.active,
    hasError: !!session?.error,
    record: !!recordHuddleId,
  });
  if (!visible) return null;

  const live = !!state?.active;
  const error = session?.error || local.failed;

  const body = (
    <>
      {/* Header: what and where, always visible even when collapsed, so a
          minimised call still says which conversation it belongs to. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-3">
        {/* Drag handle. The dock is pinned bottom-right otherwise, and when it
            is collapsed the header IS the whole panel — so this is the only
            place a grip can live and still be reachable. */}
        <button
          type="button"
          aria-label="Move huddle panel"
          title="Drag to move"
          onPointerDown={startDrag}
          onKeyDown={nudge}
          className="-ml-1 shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
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
        {/* Nothing to leave or end when you are reading a call that is over —
            those buttons would act on a huddle you are not in. */}
        {!recordHuddleId && (
          <>
            <Button type="button" variant="ghost" size="xs" onClick={handleLeave}>Leave</Button>
            {live && (
              <Button type="button" variant="ghost" size="xs" className="text-destructive" onClick={handleEnd}>
                End
              </Button>
            )}
          </>
        )}
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close huddle panel" onClick={() => dock.closeHuddle()}>
          <X />
        </Button>
      </div>

      {/* WHO is here and WHAT you can do about it, on ONE line.
          These were two stacked bars, each ~34px with its own divider, holding
          six small controls between them. In a dock this narrow that is two
          rules across the width to separate an avatar from a microphone.

          Participants stay visible while collapsed — "who is in this call" is
          the one thing worth seeing without expanding it — and the controls
          still appear only while we hold a connection: off the call there is no
          microphone of ours to mute and no voice to silence. */}
      {/* Fixed height, single line. This row used to wrap: one more participant,
          or the speaker's name appearing mid-sentence, pushed it onto a second
          line and the whole dock jumped every time someone started or stopped
          talking. Avatars now clip instead of wrapping. */}
      {(participants.length > 0 || connection) && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
            {participants.map(participant => (
              <span
                key={participant.id}
                title={participant.name}
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold',
                  participant.kind === 'agent'
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-muted-foreground',
                  participant.active && 'ring-1 ring-primary',
                  participant.speaking && 'ring-2 ring-emerald-500',
                )}
              >
                {participantInitials(participant.name)}
              </span>
            ))}
          </div>
          {connection && <HuddleSpeakingNow />}
          {connection && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <HuddleMicButton connected={local.connected} />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="size-7 p-0 text-muted-foreground"
                onClick={() => setOutputMuted(value => !value)}
                aria-pressed={outputMuted}
                aria-label={outputMuted ? 'Play huddle audio' : 'Mute huddle audio'}
                title={outputMuted ? 'Play huddle audio' : 'Mute huddle audio'}
              >
                {outputMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
              </Button>
              {/* Who your voice goes to. Only in a channel: a DM has one agent,
                  and a switcher with one option is a control with nothing
                  behind it. */}
              {agents.length > 0 && (
                <HuddleAgentStrip
                  agents={agents}
                  activeId={activeAgent?.id || ''}
                  onSelect={handleAgentSelect}
                  enabled={canControlTarget}
                  selectable={canControlTarget}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* The one thing that must never be swallowed. A call that cannot be
          established has to say so here — the panel sitting on "connecting"
          forever is indistinguishable from the bug this file exists to fix. */}
      {error && (
        <div data-testid="huddle-dock-error" className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-destructive">
          {error}
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

          {connection && captionsOn && (
            <HuddleCaption
              className="h-7 shrink-0 border-b border-border px-3"
              transcribing={!!connection}
              transcriptInHuddle={!!transcriptSessionId}
              micEnabled={local.micEnabled}
              // A live mic is only transport. The selected agent's room worker
              // owns STT, so "Hearing you" waits for that participant too.
              listening={voiceInput.listening}
              interim=""
              inputError=""
              inputUnavailable={voiceInput.unavailable}
              outputUnavailable=""
              outputMuted={outputMuted}
              speakingName={speakingName}
              activeHandle={activeAgent?.handle || ''}
              engineNotice=""
            />
          )}

          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === 'chat' || tab === 'transcript' ? (
              <HuddlePanel
                workspaceId={dock.target.workspaceId}
                huddleId={recordHuddleId || state?.id || null}
                agents={agents}
                activeAgentId={activeAgent?.id || ''}
                mode={tab}
              />
            ) : (
              <HuddleNotes
                workspaceId={dock.target.workspaceId}
                huddleId={recordHuddleId || state?.id || null}
              />
            )}
          </div>
        </>
      )}
    </>
  );

  return (
    <aside
      ref={panelRef}
      data-huddle-dock
      aria-label={`Huddle in ${dock.target.title}`}
      className={cn(
        'agensis-glass-panel fixed flex flex-col overflow-hidden rounded-xl border shadow-2xl',
        !pos && 'bottom-4 right-4',
        dock.collapsed ? 'h-auto' : 'h-[min(34rem,calc(100vh-6rem))]',
      )}
      style={{
        width: PANEL_WIDTH,
        zIndex: CHROME_DEPTH.huddlePanel,
        ...(pos ? { left: pos.x, top: pos.y } : null),
      }}
    >
      {/* The panel reads the huddle from the DOCK's session, not from a
          channel-scoped provider it is mounted outside of — without this it
          re-fetched the same huddle once and then never saw it change. */}
      <HuddleSessionContext.Provider value={session}>
        {connection ? (
          <HuddleRoom
            connection={connection}
            onLeave={handleLeave}
            onLocalChange={handleLocalChange}
            targetAgentId={activeAgent?.id || null}
            rosterAgentIds={agents.map(agent => agent.id)}
            targetControllerIdentity={state?.startedBy ? `user:${state.startedBy}` : ''}
            onTargetChanged={handleTargetChanged}
            outputMuted={outputMuted}
          >
            {body}
          </HuddleRoom>
        ) : body}
      </HuddleSessionContext.Provider>

      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave huddle?</AlertDialogTitle>
            <AlertDialogDescription>
              You're about to leave the huddle in {dock.target.title}. You'll stop hearing the conversation and your microphone will disconnect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmLeave} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Leave Huddle
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

/**
 * The elapsed clock. huddleDuration() takes `now`, so something has to tick —
 * a frozen timestamp would render a duration that never advances.
 *
 * A second local copy of this pattern (HuddlePanel has the other). Left local
 * rather than extracted because pulling them onto a shared component is a
 * refactor of surfaces this change does not otherwise touch.
 */
function DockTimer({ state }: { state: HuddleState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.active]);
  const text = huddleDuration(state, now);
  // Always occupies its line. Returning null here collapsed the header by a
  // row the moment a duration appeared or stopped resolving, which in the
  // collapsed dock is the entire panel changing height under the pointer.
  return <span className="block h-4 truncate text-xs leading-4 text-muted-foreground">{text}</span>;
}
