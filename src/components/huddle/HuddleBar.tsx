import { useCallback, useState } from 'react';
import { LiveKitRoom, RoomAudioRenderer, useLocalParticipant, useParticipants, useRoomContext } from '@livekit/components-react';
import { Mic, MicOff, PhoneOff, LogOut, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { HuddleConnection } from '@/hooks/useHuddle';

// The in-call bar. Mounted only while this browser is actually connected, and
// unmounted on leave — unmounting LiveKitRoom is what tears the WebRTC session
// down, so there is no separate cleanup to get wrong.
//
// This is the ONLY file that touches the LiveKit client. Everything else works
// off the server's folded huddle state, so the media plane can change without
// the card, the hook or the routes noticing.

interface HuddleBarProps {
  connection: HuddleConnection;
  /** Leave for me only. The LiveKit webhook records the leave server-side. */
  onLeave: () => void;
  /** End for everyone (also deletes the LiveKit room). */
  onEnd: () => void;
  className?: string;
}

export function HuddleBar({ connection, onLeave, onEnd, className }: HuddleBarProps) {
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
      <HuddleBarControls connected={connected} failed={failed} onLeave={onLeave} onEnd={onEnd} />
    </LiveKitRoom>
  );
}

function HuddleBarControls({
  connected,
  failed,
  onLeave,
  onEnd,
}: {
  connected: boolean;
  failed: string;
  onLeave: () => void;
  onEnd: () => void;
}) {
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const [toggling, setToggling] = useState(false);

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
          piece of state that is too fast to route through the database. */}
      {connected && participants.length > 0 && (
        <div className="flex items-center gap-1">
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
        </div>
      )}

      <Button
        type="button"
        size="sm"
        variant={isMicrophoneEnabled ? 'ghost' : 'secondary'}
        className="h-7 gap-1 px-2 text-xs"
        disabled={!connected || toggling}
        onClick={() => void toggleMic()}
        aria-pressed={!isMicrophoneEnabled}
        aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
      >
        {isMicrophoneEnabled ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
        {isMicrophoneEnabled ? 'Mute' : 'Unmute'}
      </Button>

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
