import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Headphones, Mic, MicOff, Radio, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useHuddleSession } from './HuddleSessionContext';
import { useSpeechInput, useSpeechOutput, useVoiceEngines } from '@/hooks/useHuddleVoice';
import { echoGuardUntil, trailingCaption } from '@/lib/huddleVoice';
import { isEchoSuppressed, playbackEchoGuardUntil } from '@/lib/voiceStream';
import { huddleDuration, isRecentlyEnded, participantSummary } from '@/lib/huddleState';
import { huddleTranscriptTarget, shouldOpenHuddlePanel } from '@/lib/huddleTranscript';
import { useHuddleSend } from '@/hooks/useHuddleTranscript';
import { useHuddleHeartbeat } from '@/hooks/useHuddle';
import { matchLeadingAgentName, withAgentMention, type HuddleAgentOption } from '@/lib/huddleAgents';
import { HuddleBar, type HuddleLocalState } from './HuddleBar';
import { HuddleAgentStrip } from './HuddleAgentStrip';
import type { HuddleState } from '@/types';

// The huddle card: one slim strip between the channel header and the transcript.
//
// It owns the CALL — LiveKit, the microphone, the speech pipeline — and stays
// mounted for the whole of it. It does NOT own the conversation: that lives in
// HuddlePanel, on the right. The split is deliberate. A huddle is ad-hoc and
// the channel is the record, so what is said in a call must not land in the
// channel's permanent history; but a panel can be closed, and mounting
// LiveKitRoom inside something that can unmount is how closing a panel would
// silently drop the call.
//
// Participant state comes from the server's append-only event log (folded in
// useHuddle), which is fed only by LiveKit's signed webhook. A browser cannot
// add itself to the roster; it can only ask for a token for itself.
//
// AGENTS IN THE HUDDLE happen here, not in the media plane. While connected,
// this card turns microphone speech into an ordinary chat message — now
// addressed to the huddle's OWN session — which dispatches the agent exactly as
// typing would, and reads new agent messages from that session aloud. The agent
// never touches audio, so this works for daemon, builtin and MCP agents alike
// and needed no server-side media work at all.
//
// A CHANNEL needs one more thing than a DM: an addressee. A plain message wakes
// nobody in a channel, so the strip picks an ACTIVE AGENT and the transcript is
// posted @mentioning them — the composer's own dispatch path, no second route.
// Hand it no agents (a DM) and none of that happens: the utterance is posted
// verbatim. The transcript session copies its host's participants, so the DM's
// `direct: true` shortcut works there exactly as it does in the DM itself.

const IDLE_LOCAL: HuddleLocalState = { connected: false, micEnabled: false, speaker: '' };

interface HuddleCardProps {
  workspaceId: string | null;
  /** The channel/DM this card sits in. NOT where the transcript goes. */
  sessionId: string | null;
  /**
   * The channel's agents, in roster order — one of them is active and hears
   * what you say. Empty in a DM, where the single agent already answers a
   * plain message and a strip would be a control with one option.
   */
  agents?: HuddleAgentOption[];
  /** Which agent is active, lifted so the panel's composer addresses the same one. */
  activeAgentId?: string;
  onActiveAgentChange?: (agentId: string) => void;
  /** Open the huddle panel — where the conversation actually is. */
  onOpenPanel?: (huddleId: string) => void;
  className?: string;
}

const NO_AGENTS: HuddleAgentOption[] = [];

export function HuddleCard({
  workspaceId,
  sessionId,
  agents = NO_AGENTS,
  activeAgentId = '',
  onActiveAgentChange,
  onOpenPanel,
  className,
}: HuddleCardProps) {
  // Shared with the toolbar trigger via context, so both drive one hook.
  const session = useHuddleSession();
  const { state, error, connection } = session ?? {};
  const [local, setLocal] = useState<HuddleLocalState>(IDLE_LOCAL);
  const [outputMuted, setOutputMuted] = useState(false);
  // Which agent hears you. Pure UI state for THIS huddle: nothing is persisted,
  // because "who am I talking to right now" is not a property of the channel.
  // Lifted to the parent so the panel's composer addresses the same agent your
  // voice does; the local fallback keeps the card usable on its own.
  const [ownAgentId, setOwnAgentId] = useState('');
  const selectedAgentId = onActiveAgentChange ? activeAgentId : ownAgentId;
  const setSelectedAgentId = useCallback((id: string) => {
    if (onActiveAgentChange) onActiveAgentChange(id);
    else setOwnAgentId(id);
  }, [onActiveAgentChange]);

  // WHERE THE WORDS GO. The huddle's own session when it has one; the host
  // channel only for huddles that predate transcript sessions, where the
  // channel genuinely was the transcript — so the fallback is the old
  // behaviour, not a leak of the new one.
  const transcriptSessionId = huddleTranscriptTarget(state, sessionId);
  const { send } = useHuddleSend(workspaceId, transcriptSessionId || null);
  // The first agent is active until you pick another, and an agent that leaves
  // the roster mid-call hands the floor back to the first rather than leaving
  // the strip pointing at nobody.
  const activeAgent = useMemo(
    () => agents.find(agent => agent.id === selectedAgentId) || agents[0] || null,
    [agents, selectedAgentId],
  );

  // Stable identity (the bar reports through it from an effect), and a no-op
  // when nothing actually changed.
  const handleLocalChange = useCallback((next: HuddleLocalState) => {
    setLocal(prev => (
      prev.connected === next.connected && prev.micEnabled === next.micEnabled && prev.speaker === next.speaker
        ? prev
        : next
    ));
  }, []);

  useEffect(() => {
    if (!connection) setLocal(IDLE_LOCAL);
  }, [connection]);

  // The moment OUR WebRTC session is actually up, tell the server — the roster
  // was fed only by LiveKit's webhook, which requires a dashboard step that in
  // 48 huddles never happened, so it forever read "Waiting for the first
  // person to connect" while that person was live and talking. Keyed on the
  // connection epoch: a retry is the same event, a rejoin is a new one.
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
  // show someone who is not there. Presence expires on the server unless this
  // keeps refreshing it.
  useHuddleHeartbeat(
    workspaceId,
    connection?.huddleId || '',
    connection?.joinedAtMs || 0,
    connection?.heartbeatIntervalMs || 0,
    !!connection && local.connected,
  );

  // Joining a huddle opens the panel — that is where the conversation is now,
  // and a call whose transcript is behind a control you have to find is a call
  // people will keep holding in the channel instead.
  //
  // Exactly once per connection, hence the ref: re-opening a panel the user
  // just closed mid-call is a fight they cannot win. Keyed on the huddle id
  // rather than on `connection` so rejoining the SAME huddle after a reconnect
  // does not reopen it either.
  const openedForRef = useRef('');
  useEffect(() => {
    if (!onOpenPanel) return;
    if (!shouldOpenHuddlePanel(connection?.huddleId, openedForRef.current)) return;
    openedForRef.current = connection?.huddleId || '';
    onOpenPanel(openedForRef.current);
  }, [connection?.huddleId, onOpenPanel]);

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
    // No voice id yet: per-agent Cartesia voices are agent-identity's work, and
    // '' means "the server's default English voice". Every agent sounding the
    // same is still an improvement on every MACHINE sounding different, which
    // is what speechSynthesis gave us.
    // The ACTIVE agent's voice, not a fixed one — the strip switches who is
    // speaking mid-call, so a hardcoded '' meant every agent came out in the
    // same derived default and the voices chosen in the agent panel were never
    // used. '' still means "none stored"; the speaker derives a default from
    // the agent id rather than sending an empty voice to Cartesia.
    { engine: engines.tts, workspaceId, voiceId: activeAgent?.voiceId || '' },
  );

  // While a reply is playing (and for a moment after), anything the microphone
  // hears is our own voice coming back off the speakers. Posting it would have
  // the agent answering itself, forever — and Deepgram is BETTER at hearing a
  // distant speaker than the browser recogniser was, so this got more
  // important, not less.
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
    // No agents to choose between (a DM): today's behaviour, unchanged.
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
      setSelectedAgentId(named.agent.id);
      body = named.remainder;
    }
    if (!body) return;
    void send(target ? withAgentMention(body, target.handle) : body);
  }, [agents, send, setSelectedAgentId, transcriptSessionId]);

  // Three gates, all of which must hold: we hold a connection, LiveKit says the
  // session is up, and the mic is not muted. Muting the mic stops transcribing
  // as well as transmitting — one control, no second thing to remember.
  const listenEnabled = !!connection && !!transcriptSessionId && local.connected && local.micEnabled;
  const { unavailable: inputUnavailable, listening, interim, error: inputError } = useSpeechInput(
    listenEnabled,
    handleUtterance,
    // `suppressed` stops audio LEAVING the browser while a reply plays. The
    // guard above is the second line of defence; this is the first, and it also
    // means we are not paying Deepgram to transcribe our own voice.
    { engine: engines.stt, suppressed: !!speakingName },
  );

  if (!workspaceId || !sessionId || !session) return null;

  const live = state?.active ? state : null;
  const recentlyEnded = isRecentlyEnded(state, Date.now()) ? state : null;

  // The strip carries what a toolbar button cannot: who is in the call, the
  // agent switcher, the in-call controls and the live caption. With none of
  // those present it was a full-width row showing the word "Huddle" and one
  // button — so idle now renders nothing at all and the trigger lives in the
  // channel toolbar instead.
  if (!live && !connection && !recentlyEnded && !error) return null;

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

      {live && <HuddleLiveDetail state={live} localConnected={local.connected} />}
      {!live && recentlyEnded && <EndedDetail state={recentlyEnded} />}

      {/* The conversation is in the panel, not below this strip. Without a way
          back to it, closing the panel mid-call would strand the transcript
          with no affordance to reopen it. */}
      {onOpenPanel && state && (live || connection) && (
        <button
          type="button"
          className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
          onClick={() => onOpenPanel(state.id)}
        >
          Open huddle
        </button>
      )}

      {error && <span className="min-w-0 truncate text-destructive">{error}</span>}

      {/* Only while we are in the call: off it there is no "your voice", so a
          switcher would be a control with nothing behind it — and the ⌘1…⌘9
          bindings it owns must not exist app-wide. */}
      {connection && agents.length > 0 && (
        <HuddleAgentStrip
          agents={agents}
          activeId={activeAgent?.id || ''}
          onSelect={setSelectedAgentId}
          enabled={!!connection}
        />
      )}

      {/* Start/Join is the toolbar's job now. Only the in-call controls, which
          have nowhere else to go, remain here. */}
      {connection && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <HuddleBar
            connection={connection}
            onLeave={session.leave}
            onEnd={() => void session.end()}
            onLocalChange={handleLocalChange}
            outputMuted={outputMuted}
            onToggleOutput={() => setOutputMuted(value => !value)}
          />
        </div>
      )}

      {/* Its own full-width row (basis-full) so a long sentence never squeezes
          the controls. Present only while connected, so the strip keeps its
          original height the rest of the time. */}
      {connection && local.connected && (
        <VoiceCaption
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
    </div>
  );
}

/**
 * The live voice line: what we are hearing, and who is talking back.
 *
 * Deliberately one row of small text rather than a panel — it has to be
 * readable at a glance mid-sentence and invisible the rest of the time.
 */
function VoiceCaption({
  transcribing,
  micEnabled,
  listening,
  interim,
  inputError,
  inputUnavailable,
  outputUnavailable,
  outputMuted,
  speakingName,
  activeHandle,
  engineNotice,
}: {
  transcribing: boolean;
  micEnabled: boolean;
  listening: boolean;
  interim: string;
  inputError: string;
  inputUnavailable: string;
  outputUnavailable: string;
  outputMuted: boolean;
  speakingName: string;
  /** Handle of the agent your voice is addressed to, or '' in a DM. */
  activeHandle: string;
  /** '' when Deepgram and Cartesia are both in use; otherwise which one is not. */
  engineNotice: string;
}) {
  // Input is suppressed while a reply plays, so "listening" must not claim
  // otherwise — the indicator has to match what the mic is actually doing.
  const hearing = transcribing && listening && micEnabled && !speakingName && !inputUnavailable;

  let status = '';
  let tone = 'text-muted-foreground';
  // True only for the live transcript, which is the one line that must follow
  // its own tail rather than showing its beginning.
  let follow = false;
  if (inputError) {
    status = inputError;
    tone = 'text-destructive';
  } else if (transcribing && inputUnavailable) {
    status = inputUnavailable;
  } else if (!micEnabled) {
    status = activeHandle
      ? `Mic muted — unmute to talk to @${activeHandle}.`
      : 'Mic muted — unmute to talk in this huddle.';
  } else if (speakingName) {
    status = 'Paused while the reply plays.';
  } else if (interim) {
    status = trailingCaption(interim);
    tone = 'text-foreground/80 italic';
    follow = true;
  } else if (engineNotice) {
    // A downgrade is a persistent state, not a toast, so it holds the line
    // whenever nothing more urgent is happening. Silently running on the
    // fallback engine is the bug class this pipeline exists to remove: the
    // difference between Cartesia and speechSynthesis is audible, and someone
    // who cannot see why will report it as "the voice changed".
    status = engineNotice;
  } else if (hearing) {
    // Naming the addressee here is the cheapest place to answer "who am I
    // talking to" in words, and it teaches the say-a-name switch by example.
    status = activeHandle
      ? `Listening — @${activeHandle} hears you. Start with another agent's name to switch.`
      : 'Listening — what you say goes in the huddle, not the channel.';
  } else if (transcribing) {
    status = 'Starting the microphone…';
  } else if (outputUnavailable) {
    status = outputUnavailable;
  }

  // Live captions scroll: `truncate` clips the END, which in a narrow window
  // hides the words being said RIGHT NOW and freezes the line on the start of
  // the sentence — the opposite of what this row is for. Fixed statuses read
  // from the beginning, so they only scroll back.
  const trackRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollLeft = follow ? el.scrollWidth : 0;
  }, [status, follow]);

  return (
    <div className="flex w-full min-w-0 basis-full items-center gap-2 text-[11px] leading-tight">
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 font-medium',
          hearing ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
        )}
      >
        {hearing ? (
          <Mic className="size-3 animate-pulse motion-reduce:animate-none" aria-hidden />
        ) : (
          <MicOff className="size-3" aria-hidden />
        )}
        {hearing ? 'Hearing you' : 'Mic idle'}
      </span>

      <span
        ref={trackRef}
        className={cn('min-w-0 flex-1 overflow-hidden whitespace-nowrap', follow ? '' : 'text-ellipsis', tone)}
        aria-live="polite"
      >
        {status}
      </span>

      {speakingName && !outputMuted && (
        <span className="flex shrink-0 items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
          <Volume2 className="size-3 animate-pulse motion-reduce:animate-none" aria-hidden />
          <span className="max-w-24 truncate">{speakingName}</span>
        </span>
      )}
    </div>
  );
}

function HuddleLiveDetail({ state, localConnected }: { state: HuddleState; localConnected: boolean }) {
  const roster = participantSummary(state.participants);
  return (
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
      <HuddleTimer state={state} />
      {/* An active huddle whose roster is empty is real, not a bug: LiveKit's
          webhook has not told us anyone is in the room yet. Say that, rather
          than counting someone who isn't there — the mistake that makes an
          ended huddle claim "1 participant". Our OWN connection is a local
          fact, though, so once WE are in the room we say so instead of
          pretending the huddle is empty. */}
      <span className="min-w-0 truncate">
        {state.participantCount === 0
          ? (localConnected ? "you're in — waiting for others" : 'waiting for the first person to connect')
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
