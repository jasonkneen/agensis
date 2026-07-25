import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveKitRoom, RoomAudioRenderer, useLocalParticipant, useParticipants, useRoomContext } from '@livekit/components-react';
import { Mic, MicOff, PhoneOff, LogOut, Loader2, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { HuddleConnection } from '@/hooks/useHuddle';

// The in-call bar. Mounted only while this browser is actually connected, and
// unmounted on leave — unmounting LiveKitRoom is what tears the WebRTC session
// down, so there is no separate cleanup to get wrong.
//
// This is the ONLY file that touches the LiveKit client. Everything else works
// off the server's folded huddle state, so the media plane can change without
// the card, the hook or the routes noticing. The one thing that leaves here is
// `onLocalChange`: three plain booleans/strings describing OUR OWN mic, which
// the card needs to drive speech-to-text and the caption row.

/** What this browser is doing in the room right now. */
export interface HuddleLocalState {
  /** The WebRTC session is up. */
  connected: boolean;
  /** Our microphone is publishing — the gate on transcribing anything. */
  micEnabled: boolean;
  /** Display name of the participant currently speaking, or ''. */
  speaker: string;
}

interface HuddleBarProps {
  connection: HuddleConnection;
  /** Leave for me only. The LiveKit webhook records the leave server-side. */
  onLeave: () => void;
  /** End for everyone (also deletes the LiveKit room). */
  onEnd: () => void;
  /** Local mic/connection state, lifted so the card can render the caption row. */
  onLocalChange?: (state: HuddleLocalState) => void;
  /** Agent replies are read aloud unless this is true. */
  outputMuted?: boolean;
  onToggleOutput?: () => void;
  className?: string;
}

export function HuddleBar({
  connection,
  onLeave,
  onEnd,
  onLocalChange,
  outputMuted = false,
  onToggleOutput,
  className,
}: HuddleBarProps) {
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState('');

  return (
    <LiveKitRoom
      token={connection.token}
      serverUrl={connection.url}
      connect
      audio
      video={false}
      className={cn('flex min-w-0 items-center gap-2', className)}
      onConnected={() => { setConnected(true); setFailed(''); }}
      onDisconnected={onLeave}
      onError={(error) => setFailed(error.message || 'Could not connect')}
    >
      {/* Plays every remote participant's audio. Without this the call is silent. */}
      <RoomAudioRenderer />
      <HuddleBarControls
        connected={connected}
        failed={failed}
        onLeave={onLeave}
        onEnd={onEnd}
        onLocalChange={onLocalChange}
        outputMuted={outputMuted}
        onToggleOutput={onToggleOutput}
      />
    </LiveKitRoom>
  );
}

function HuddleBarControls({
  connected,
  failed,
  onLeave,
  onEnd,
  onLocalChange,
  outputMuted,
  onToggleOutput,
}: {
  connected: boolean;
  failed: string;
  onLeave: () => void;
  onEnd: () => void;
  onLocalChange?: (state: HuddleLocalState) => void;
  outputMuted: boolean;
  onToggleOutput?: () => void;
}) {
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const [toggling, setToggling] = useState(false);

  // Whoever is talking right now, remote first: hearing your own name while you
  // speak is noise, hearing theirs is the thing you actually want to know.
  const speaker = useMemo(() => {
    const speaking = participants.filter(p => p.isSpeaking);
    const chosen = speaking.find(p => !p.isLocal) || speaking[0];
    if (!chosen) return '';
    return chosen.isLocal ? 'You' : (chosen.name || chosen.identity);
  }, [participants]);

  // Push local state up. Primitive deps only, so this fires on real changes
  // rather than on every LiveKit re-render.
  useEffect(() => {
    onLocalChange?.({ connected, micEnabled: isMicrophoneEnabled, speaker });
  }, [connected, isMicrophoneEnabled, speaker, onLocalChange]);

  const toggleMic = useCallback(async () => {
    setToggling(true);
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } finally {
      setToggling(false);
    }
  }, [localParticipant, isMicrophoneEnabled]);

  // Disconnect first so LiveKit emits our participant_left, then let the parent
  // drop the connection (which unmounts this subtree).
  const leave = useCallback(async () => {
    try {
      await room.disconnect();
    } finally {
      onLeave();
    }
  }, [room, onLeave]);

  const end = useCallback(async () => {
    try {
      await room.disconnect();
    } finally {
      onEnd();
    }
  }, [room, onEnd]);

  if (failed) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs text-destructive">
        <span className="truncate">{failed}</span>
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onLeave}>
          Dismiss
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {!connected && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Connecting…
        </span>
      )}

      {/* Live speaking indicators, straight off the media plane — this is the one
          piece of state that is too fast to route through the database. The dots
          are the roster; the name is who has the floor. */}
      {connected && participants.length > 0 && (
        <span className="flex min-w-0 items-center gap-1.5">
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
          {speaker && (
            <span
              className="min-w-0 max-w-32 truncate text-xs font-medium text-emerald-600 dark:text-emerald-400"
              aria-live="polite"
            >
              {speaker}
            </span>
          )}
        </span>
      )}

      <Button
        type="button"
        size="sm"
        variant={isMicrophoneEnabled ? 'ghost' : 'secondary'}
        className={cn(
          'h-7 gap-1 px-2 text-xs',
          isMicrophoneEnabled && 'text-emerald-600 dark:text-emerald-400',
        )}
        disabled={!connected || toggling}
        onClick={() => void toggleMic()}
        aria-pressed={!isMicrophoneEnabled}
        aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
        title={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
      >
        {isMicrophoneEnabled ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
        {isMicrophoneEnabled ? 'Live' : 'Muted'}
      </Button>

      {onToggleOutput && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="size-7 p-0 text-muted-foreground"
          onClick={onToggleOutput}
          aria-pressed={outputMuted}
          aria-label={outputMuted ? 'Read agent replies aloud' : 'Stop reading agent replies aloud'}
          title={outputMuted ? 'Read agent replies aloud' : 'Stop reading agent replies aloud'}
        >
          {outputMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
        </Button>
      )}

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => void leave()}
      >
        <LogOut className="size-3.5" />
        Leave
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
        onClick={() => void end()}
      >
        <PhoneOff className="size-3.5" />
        End
      </Button>
    </div>
  );
}
