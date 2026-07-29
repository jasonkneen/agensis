import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, CaptionsOff, ChevronDown, Headphones, Radio, Volume2, VolumeX, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CHROME_DEPTH } from '@/lib/chromeDepth';
import {
  buildDockParticipants,
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
import { matchLeadingAgentName, withAgentMention, type HuddleAgentOption } from '@/lib/huddleAgents';
import { echoGuardUntil } from '@/lib/huddleVoice';
import { isEchoSuppressed, playbackEchoGuardUntil } from '@/lib/voiceStream';
import { useHuddleHeartbeat } from '@/hooks/useHuddle';
import { useHuddleSend } from '@/hooks/useHuddleTranscript';
import { useSpeechInput, useSpeechOutput, useVoiceEngines } from '@/hooks/useHuddleVoice';
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
// AGENTS IN THE HUDDLE happen here, not in the media plane. While connected,
// microphone speech becomes an ordinary chat message addressed to the huddle's
// OWN session, which dispatches the agent exactly as typing would, and new
// agent messages in that session are read aloud. The agent never touches audio,
// so this works for daemon, builtin and MCP agents alike.
//
// A CHANNEL needs one more thing than a DM: an addressee. A plain message wakes
// nobody in a channel, so the strip picks an ACTIVE AGENT and the transcript is
// posted @mentioning them — the composer's own dispatch path, no second route.
// Hand it no agents (a DM) and none of that happens: the utterance is posted
// verbatim.
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 380;
const NO_AGENTS: HuddleAgentOption[] = [];

export function HuddleDock() {
  const dock = useHuddleDock();
  const [tab, setTab] = useState<HuddleDockTab>(() => normalizeHuddleDockTab(null));
  const [captionsOn, setCaptionsOn] = useState(true);
  const [local, setLocal] = useState<HuddleLocalState>(IDLE_HUDDLE_LOCAL);
  const [outputMuted, setOutputMuted] = useState(false);
  // Which agent hears you. Pure UI state for THIS call: nothing is persisted,
  // because "who am I talking to right now" is not a property of the channel.
  const [activeAgentId, setActiveAgentId] = useState('');

  const session = dock?.session ?? null;
  const state = session?.state ?? null;
  const connection = session?.connection ?? null;
  const workspaceId = dock?.target?.workspaceId ?? null;
  const agents = dock?.target?.agents ?? NO_AGENTS;
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
  const { send } = useHuddleSend(workspaceId, transcriptSessionId || null);

  // The first agent is active until you pick another, and an agent that leaves
  // the roster mid-call hands the floor back to the first rather than leaving
  // the strip pointing at nobody.
  const activeAgent = useMemo(
    () => agents.find(agent => agent.id === activeAgentId) || agents[0] || null,
    [agents, activeAgentId],
  );

  // Stable identity (HuddleRoom reports through it from an effect), and a no-op
  // when nothing actually changed.
  const handleLocalChange = useCallback((next: HuddleLocalState) => {
    setLocal(prev => (sameHuddleLocalState(prev, next) ? prev : next));
  }, []);

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

  // Which engines this deployment can offer. Asked once, before a microphone is
  // opened, so a missing key downgrades to the browser engines with a sentence
  // on screen rather than to a mic that lights up and does nothing.
  const engines = useVoiceEngines(workspaceId, !!connection);

  // Replies are read from the SAME session the transcript goes into. Pointing
  // this at the channel while speech posts into the huddle would mean the agent
  // answers in the huddle and the browser reads the channel aloud — a call
  // where nobody's replies are ever heard.
  const { unavailable: outputUnavailable, speakingName, playbackEndsAtMs } = useSpeechOutput(
    transcriptSessionId || null,
    !!connection && !outputMuted,
    connection?.joinedAtMs ?? 0,
    // The ACTIVE agent's voice, not a fixed one — the strip switches who is
    // speaking mid-call. '' means "none stored"; the speaker derives a default
    // from the agent id rather than sending an empty voice to Cartesia.
    { engine: engines.tts, workspaceId, voiceId: activeAgent?.voiceId || '' },
  );

  // While a reply is playing (and for a moment after), anything the microphone
  // hears is our own voice coming back off the speakers. Posting it would have
  // the agent answering itself, forever.
  //
  // Two sources, because they know different things. Cartesia schedules its
  // audio on an AudioContext, so it can say exactly when the last sample lands;
  // speechSynthesis can only say "still talking", so that path keeps the old
  // boolean-plus-tail guard.
  const echoGuardRef = useRef(0);
  useEffect(() => {
    echoGuardRef.current = playbackEndsAtMs > 0
      ? playbackEchoGuardUntil(playbackEndsAtMs)
      : echoGuardUntil(!!speakingName, Date.now());
  }, [speakingName, playbackEndsAtMs]);

  // Mirrors `activeAgent` so two utterances in the same tick both see a switch
  // the first one made, without waiting for a render in between.
  const activeAgentRef = useRef<HuddleAgentOption | null>(activeAgent);
  activeAgentRef.current = activeAgent;

  const handleUtterance = useCallback((text: string) => {
    if (!transcriptSessionId) return;
    if (isEchoSuppressed(echoGuardRef.current, Date.now())) return;
    // No agents to choose between (a DM): the utterance is posted verbatim and
    // the single agent answers a plain message, exactly as it does when typed.
    if (agents.length === 0) {
      void send(text);
      return;
    }
    let target = activeAgentRef.current;
    let body = text;
    // "Coder, what's the status" switches AND asks. Saying only a name switches
    // and posts nothing — the strip is the acknowledgement.
    const named = matchLeadingAgentName(text, agents);
    if (named) {
      target = named.agent;
      activeAgentRef.current = named.agent;
      setActiveAgentId(named.agent.id);
      body = named.remainder;
    }
    if (!body) return;
    void send(target ? withAgentMention(body, target.handle) : body);
  }, [agents, send, transcriptSessionId]);

  // Three gates, all of which must hold: we hold a connection, LiveKit says the
  // session is up, and the mic is not muted. Muting the mic stops transcribing
  // as well as transmitting — one control, no second thing to remember.
  const listenEnabled = !!connection && !!transcriptSessionId && local.connected && local.micEnabled;
  const { unavailable: inputUnavailable, listening, interim, error: inputError } = useSpeechInput(
    listenEnabled,
    handleUtterance,
    // `suppressed` stops audio LEAVING the browser while a reply plays. The
    // echo guard above is the second line of defence; this is the first, and it
    // also means we are not paying Deepgram to transcribe our own voice.
    { engine: engines.stt, suppressed: !!speakingName },
  );

  const participants = useMemo(
    () => buildDockParticipants({
      humans: state?.participants ?? [],
      // Agents are in the call in every way that matters — they hear the
      // transcript and speak — but never hold a LiveKit connection, so no
      // presence event will ever mention them. Building the chips from LiveKit
      // alone makes a three-agent call look empty.
      agents,
      activeAgentId: activeAgent?.id || '',
      speakingName,
    }),
    [state?.participants, agents, activeAgent?.id, speakingName],
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
    // Posts /leave for this connection epoch, so presence is cleaned up now
    // rather than by the 150s reaper. Dropping the connection unmounts
    // HuddleRoom, and unmounting it is what disconnects LiveKit.
    sessionRef.current?.leave();
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
      {(participants.length > 0 || connection) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {participants.map(participant => (
              <span
                key={participant.id}
                title={participant.name}
                className={cn(
                  'grid size-6 place-items-center rounded-full text-[10px] font-semibold',
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
                aria-label={outputMuted ? 'Read agent replies aloud' : 'Stop reading agent replies aloud'}
                title={outputMuted ? 'Read agent replies aloud' : 'Stop reading agent replies aloud'}
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
                  onSelect={setActiveAgentId}
                  enabled
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
              className="shrink-0 border-b border-border px-3 py-1.5"
              transcribing={!!transcriptSessionId}
              micEnabled={local.micEnabled}
              listening={listening}
              interim={interim}
              inputError={inputError}
              inputUnavailable={inputUnavailable}
              outputUnavailable={outputUnavailable}
              outputMuted={outputMuted}
              speakingName={speakingName}
              activeHandle={activeAgent?.handle || ''}
              engineNotice={engines.notice}
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
      data-huddle-dock
      aria-label={`Huddle in ${dock.target.title}`}
      className={cn(
        'agensis-glass-panel fixed bottom-4 right-4 flex flex-col overflow-hidden rounded-xl border shadow-2xl',
        dock.collapsed ? 'h-auto' : 'h-[min(34rem,calc(100vh-6rem))]',
      )}
      style={{ width: PANEL_WIDTH, zIndex: CHROME_DEPTH.huddlePanel }}
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
          >
            {body}
          </HuddleRoom>
        ) : body}
      </HuddleSessionContext.Provider>
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
  if (!text) return null;
  return <span className="block truncate text-xs text-muted-foreground">{text}</span>;
}
