import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LiveKitRoom, RoomAudioRenderer, useLocalParticipant, useParticipants } from '@livekit/components-react';
import { Loader2, Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { roomParticipantFrom, type HuddleLocalState } from '@/lib/huddleDock';
import type { HuddleConnection } from '@/hooks/useHuddle';

// THE CALL ITSELF. This is the ONLY file in the app that touches the LiveKit
// client, and mounting it is the only thing that establishes a WebRTC session.
//
// It used to live inside the channel's huddle strip. When the huddle moved into
// an app-level dock, the strip's chrome moved but this did not — the dock read
// the join token and used it as a boolean for visibility, so every huddle
// opened a panel that said "connecting" over a call that was never started.
// Nobody, including the local user, ever joined; the roster stayed empty
// because presence is written on connect and nothing connected.
//
// So it is a WRAPPER now, not a strip: whatever the call's UI happens to be
// renders as `children`, INSIDE the room, which is what lets a mic button use
// LiveKit's own hooks. Unmounting it is what tears the session down, so there
// is no separate cleanup to get wrong.
//
// Everything else in the huddle works off the server's folded state, so the
// media plane can change without the hooks or the routes noticing. The one
// thing that leaves here is `onLocalChange`: a few plain values describing OUR
// OWN connection, which the dock needs to gate speech-to-text and captions.

interface HuddleRoomProps {
  connection: HuddleConnection;
  /** Leave for me only. The caller drops the connection, which unmounts this. */
  onLeave: () => void;
  /** Local mic/connection state, lifted so the dock can drive voice and captions. */
  onLocalChange: (state: HuddleLocalState) => void;
  className?: string;
  children?: ReactNode;
}

export function HuddleRoom({ connection, onLeave, onLocalChange, className, children }: HuddleRoomProps) {
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState('');

  // These MUST be stable. LiveKitRoom re-runs its connect effect when a handler
  // prop changes identity, so inline arrows here produced a feedback loop:
  // render -> new arrow -> effect re-runs -> room.connect() -> onConnected ->
  // setConnected -> render. The console filled with "already connected to room"
  // ~80 times in a few seconds, and the constant re-rendering also tore down the
  // speech effects before any utterance could play, which is why replies were
  // silent. Shipped that; this is the fix, and it is why it is still here.
  const handleConnected = useCallback(() => {
    setConnected(true);
    setFailed('');
  }, []);
  const handleError = useCallback((error: Error) => {
    setFailed(error.message || 'Could not connect');
  }, []);
  const roomClassName = useMemo(
    () => cn('flex min-h-0 min-w-0 flex-1 flex-col', className),
    [className],
  );

  return (
    <LiveKitRoom
      data-huddle-room
      token={connection.token}
      serverUrl={connection.url}
      connect
      audio
      video={false}
      className={roomClassName}
      onConnected={handleConnected}
      onDisconnected={onLeave}
      onError={handleError}
    >
      {/* Plays every remote participant's audio. Without this the call is silent. */}
      <RoomAudioRenderer />
      <HuddleRoomState connected={connected} failed={failed} onLocalChange={onLocalChange} />
      {children}
    </LiveKitRoom>
  );
}

/**
 * Reports our own state upward and renders nothing.
 *
 * A component rather than a hook in the parent because these hooks need the
 * room context, and the room context only exists BELOW <LiveKitRoom>.
 */
function HuddleRoomState({
  connected,
  failed,
  onLocalChange,
}: {
  connected: boolean;
  failed: string;
  onLocalChange: (state: HuddleLocalState) => void;
}) {
  const { isMicrophoneEnabled } = useLocalParticipant();
  const participants = useParticipants();

  // Whoever is talking right now, remote first: hearing your own name while you
  // speak is noise, hearing theirs is the thing you actually want to know.
  const speaker = useMemo(() => {
    const speaking = participants.filter(p => p.isSpeaking);
    const chosen = speaking.find(p => !p.isLocal) || speaking[0];
    if (!chosen) return '';
    return chosen.isLocal ? 'You' : (chosen.name || chosen.identity);
  }, [participants]);

  // Everyone in the room — agents included, because the voice worker joins as a
  // real participant and stamps `agensis.*` attributes on itself. This is the
  // single source of truth for who is in the call; there is no separate agent
  // roster to fall out of step with it.
  const roomParticipants = useMemo(
    () => participants.map(roomParticipantFrom),
    [participants],
  );

  // The report is deliberately compared by VALUE upstream (sameHuddleLocalState):
  // LiveKit re-emits participants on every speaking change, so identity-based
  // deps here would re-render the dock continuously while anyone talks.
  useEffect(() => {
    onLocalChange({ connected, micEnabled: isMicrophoneEnabled, speaker, failed, roomParticipants });
  }, [connected, isMicrophoneEnabled, speaker, failed, roomParticipants, onLocalChange]);

  return null;
}

/**
 * Mute/unmute. Must be rendered inside HuddleRoom — it drives the actual
 * published track, not a flag the UI keeps to itself.
 */
export function HuddleMicButton({ connected, className }: { connected: boolean; className?: string }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const [toggling, setToggling] = useState(false);

  const toggleMic = useCallback(async () => {
    setToggling(true);
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } finally {
      setToggling(false);
    }
  }, [localParticipant, isMicrophoneEnabled]);

  if (!connected) {
    return (
      <span className={cn('flex items-center gap-1 text-xs text-muted-foreground', className)}>
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
        Connecting…
      </span>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant={isMicrophoneEnabled ? 'ghost' : 'secondary'}
      className={cn(
        'h-7 gap-1 px-2 text-xs',
        isMicrophoneEnabled && 'text-emerald-600 dark:text-emerald-400',
        className,
      )}
      disabled={toggling}
      onClick={() => void toggleMic()}
      aria-pressed={!isMicrophoneEnabled}
      aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
      title={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
    >
      {isMicrophoneEnabled ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
      {isMicrophoneEnabled ? 'Live' : 'Muted'}
    </Button>
  );
}

/**
 * Who has the floor, straight off the media plane — the one piece of huddle
 * state too fast to route through the database. The dots are the humans in the
 * room; the name is whoever is speaking.
 *
 * Humans only, by construction: an agent hears the transcript and speaks
 * through it but never holds a LiveKit connection, so it is listed from the
 * session roster instead (see buildDockParticipants).
 */
export function HuddleSpeakingNow({ className }: { className?: string }) {
  const participants = useParticipants();
  const speaking = participants.filter(p => p.isSpeaking);
  const chosen = speaking.find(p => !p.isLocal) || speaking[0];
  const name = chosen ? (chosen.isLocal ? 'You' : (chosen.name || chosen.identity)) : '';
  if (participants.length === 0) return null;

  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="flex shrink-0 items-center gap-1">
        {participants.map(p => (
          <span
            key={p.identity}
            title={p.name || p.identity}
            className={cn(
              'size-1.5 rounded-full transition',
              p.isSpeaking ? 'bg-emerald-500 ring-2 ring-emerald-500/30' : 'bg-muted-foreground/40',
            )}
            aria-hidden
          />
        ))}
      </span>
      {name && (
        <span
          className="min-w-0 max-w-32 truncate text-xs font-medium text-emerald-600 dark:text-emerald-400"
          aria-live="polite"
        >
          {name}
        </span>
      )}
    </span>
  );
}
