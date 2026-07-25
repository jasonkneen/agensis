import { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, Mic, MicOff, Radio, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useHuddle } from '@/hooks/useHuddle';
import { useSpeechInput, useSpeechOutput } from '@/hooks/useHuddleVoice';
import { echoGuardUntil, trailingCaption } from '@/lib/huddleVoice';
import { huddleDuration, participantSummary } from '@/lib/huddleState';
import { HuddleBar, type HuddleLocalState } from './HuddleBar';
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
//
// AGENTS IN THE HUDDLE happen here, not in the media plane. While connected,
// this card turns microphone speech into an ordinary chat message (which
// dispatches the agent exactly as typing would) and reads new agent messages
// aloud. The agent never touches audio, so this works for daemon, builtin and
// MCP agents alike and needed no server-side media work at all.

const IDLE_LOCAL: HuddleLocalState = { connected: false, micEnabled: false, speaker: '' };

interface HuddleCardProps {
  workspaceId: string | null;
  sessionId: string | null;
  /**
   * Post a recognised utterance into this session as a normal message. Omit it
   * and the huddle stays voice-only between humans — nothing is transcribed.
   */
  onTranscript?: (text: string) => void;
  className?: string;
}

export function HuddleCard({ workspaceId, sessionId, onTranscript, className }: HuddleCardProps) {
  const { state, configured, busy, error, connection, startOrJoin, end, leave } = useHuddle(workspaceId, sessionId);
  const [local, setLocal] = useState<HuddleLocalState>(IDLE_LOCAL);
  const [outputMuted, setOutputMuted] = useState(false);

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

  const { unavailable: outputUnavailable, speakingName } = useSpeechOutput(
    sessionId,
    !!connection && !outputMuted,
    connection?.joinedAtMs ?? 0,
  );

  // While the browser is talking (and for a moment after), anything the
  // recogniser hears is our own voice coming back off the speakers. Posting it
  // would have the agent answering itself, forever.
  const echoGuardRef = useRef(0);
  useEffect(() => {
    echoGuardRef.current = echoGuardUntil(!!speakingName, Date.now());
  }, [speakingName]);

  const handleUtterance = useCallback((text: string) => {
    if (!onTranscript) return;
    if (Date.now() < echoGuardRef.current) return;
    onTranscript(text);
  }, [onTranscript]);

  // Three gates, all of which must hold: we hold a connection, LiveKit says the
  // session is up, and the mic is not muted. Muting the mic stops transcribing
  // as well as transmitting — one control, no second thing to remember.
  const listenEnabled = !!connection && !!onTranscript && local.connected && local.micEnabled;
  const { unavailable: inputUnavailable, listening, interim, error: inputError } = useSpeechInput(
    listenEnabled,
    handleUtterance,
  );

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

      {live && <HuddleLiveDetail state={live} localConnected={local.connected} />}
      {!live && recentlyEnded && <EndedDetail state={recentlyEnded} />}

      {error && <span className="min-w-0 truncate text-destructive">{error}</span>}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {connection ? (
          <HuddleBar
            connection={connection}
            onLeave={leave}
            onEnd={() => void end()}
            onLocalChange={handleLocalChange}
            outputMuted={outputMuted}
            onToggleOutput={() => setOutputMuted(value => !value)}
          />
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

      {/* Its own full-width row (basis-full) so a long sentence never squeezes
          the controls. Present only while connected, so the strip keeps its
          original height the rest of the time. */}
      {connection && local.connected && (
        <VoiceCaption
          transcribing={!!onTranscript}
          micEnabled={local.micEnabled}
          listening={listening}
          interim={interim}
          inputError={inputError}
          inputUnavailable={inputUnavailable}
          outputUnavailable={outputUnavailable}
          outputMuted={outputMuted}
          speakingName={speakingName}
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
    status = 'Mic muted — unmute to talk to this channel.';
  } else if (speakingName) {
    status = 'Paused while the reply plays.';
  } else if (interim) {
    status = trailingCaption(interim);
    tone = 'text-foreground/80 italic';
    follow = true;
  } else if (hearing) {
    status = 'Listening — say something and it posts here.';
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
