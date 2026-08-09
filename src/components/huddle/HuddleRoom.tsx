import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LiveKitRoom, RoomAudioRenderer, useLocalParticipant, useParticipants, useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { MAX_TARGET_REVISION, MAX_TARGET_REVISION_SYNC_LEAD, VOICE_TARGET_TOPIC, decodeVoiceTarget, decodeVoiceTargetRequest, makeVoiceTarget, makeVoiceTargetRequest } from '@/lib/voiceTarget';
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
  /** Spoken routing target, published over the authenticated LiveKit room. */
  targetAgentId?: string | null;
  rosterAgentIds?: string[];
  targetControllerIdentity?: string;
  onTargetChanged?: (targetAgentId: string | null) => void;
  outputMuted?: boolean;
  className?: string;
  children?: ReactNode;
}

export function HuddleRoom({
  connection, onLeave, onLocalChange, targetAgentId = null, rosterAgentIds = [], targetControllerIdentity = '', onTargetChanged, outputMuted = false, className, children,
}: HuddleRoomProps) {
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
      <RoomAudioRenderer muted={outputMuted} />
      <HuddleRoomState connected={connected} failed={failed} onLocalChange={onLocalChange} />
      <HuddleVoiceTarget
        connected={connected}
        huddleId={connection.huddleId}
        targetAgentId={targetAgentId}
        rosterAgentIds={rosterAgentIds}
        targetControllerIdentity={targetControllerIdentity}
        onTargetChanged={onTargetChanged}
      />
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
const TARGET_REVISION_STORAGE_PREFIX = 'agensis.voice.target.revision:';

function storedTargetRevision(huddleId: string): number {
  if (!huddleId || typeof window === 'undefined') return 0;
  try {
    const value = Number(window.sessionStorage.getItem(`${TARGET_REVISION_STORAGE_PREFIX}${huddleId}`));
    return Number.isInteger(value) && value >= 0 && value <= MAX_TARGET_REVISION ? value : 0;
  } catch {
    return 0;
  }
}

function rememberTargetRevision(huddleId: string, revision: number): void {
  if (!huddleId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(`${TARGET_REVISION_STORAGE_PREFIX}${huddleId}`, String(revision));
  } catch {
    // Storage can be disabled in privacy mode; the live worker handshake still
    // repairs a remount when the browser cannot retain this local hint.
  }
}

/** Publishes the active agent as a versioned reliable room packet. */
function HuddleVoiceTarget({
  connected, huddleId, targetAgentId, rosterAgentIds, targetControllerIdentity, onTargetChanged,
}: {
  connected: boolean;
  huddleId: string;
  targetAgentId: string | null;
  rosterAgentIds: string[];
  targetControllerIdentity: string;
  onTargetChanged?: (targetAgentId: string | null) => void;
}) {
  const room = useRoomContext();
  const participants = useParticipants();
  const revision = useRef(0);
  const pendingTargetPayload = useRef<Uint8Array | string | null>(null);
  const lastPublished = useRef('');
  const lastQueued = useRef('');
  const publishTail = useRef(Promise.resolve());
  const humanIds = [room.localParticipant, ...participants]
    .filter((participant) => participant
      && String(participant.identity || '').startsWith('user:')
      && participant.attributes?.['agensis.kind'] !== 'agent')
    .map((participant) => String(participant.identity || ''))
    .filter(Boolean)
    .sort();
  // A configured starter remains authoritative even while temporarily offline.
  // Only legacy huddles with no controller metadata elect the first human.
  const authoritativeIdentity = targetControllerIdentity || humanIds[0] || '';
  const canControlTarget = !authoritativeIdentity || room.localParticipant.identity === authoritativeIdentity;
  const targetKey = `${huddleId}:${targetAgentId || ''}:${authoritativeIdentity}`;
  const latest = useRef({ huddleId, targetAgentId, rosterAgentIds, canControlTarget, connected, targetKey });
  latest.current = { huddleId, targetAgentId, rosterAgentIds, canControlTarget, connected, targetKey };
  const previousHuddleId = useRef('');
  useEffect(() => {
    if (previousHuddleId.current === huddleId) return;
    previousHuddleId.current = huddleId;
    revision.current = storedTargetRevision(huddleId);
    pendingTargetPayload.current = null;
    lastPublished.current = '';
    lastQueued.current = '';
  }, [huddleId]);

  const publish = useCallback(({ force = false, minRevision = -1 } = {}) => {
    if (!canControlTarget || !connected || room.state !== 'connected' || !huddleId) return;
    const next = latest.current;
    if (!force && (lastPublished.current === targetKey || lastQueued.current === targetKey)) return;
    // A worker can retain a larger revision than a remounted browser. Advance
    // past that floor before publishing; otherwise every packet from the new
    // component is stale forever until the counter catches up.
    if (Number.isInteger(minRevision) && minRevision > revision.current) {
      revision.current = Math.min(MAX_TARGET_REVISION, minRevision);
      rememberTargetRevision(next.huddleId, revision.current);
    }
    // A saturated revision cannot be advanced safely. Re-publishing MAX would
    // be rejected by every worker as stale, so only a new huddle may reset it.
    if (revision.current >= MAX_TARGET_REVISION) return;
    revision.current += 1;
    rememberTargetRevision(next.huddleId, revision.current);
    const revisionToPublish = revision.current;
    const queuedKey = targetKey;
    lastQueued.current = queuedKey;
    const payload = new TextEncoder().encode(JSON.stringify(makeVoiceTarget({
      huddleId: next.huddleId, targetAgentId: next.targetAgentId, revision: revisionToPublish,
    })));
    // LiveKit publish calls are serialized. Without this tail, a target change
    // and reconnect can send an older revision after a newer one, and an older
    // completion can make the retry guard believe the latest packet succeeded.
    publishTail.current = publishTail.current.catch(() => {}).then(async () => {
      if (!latest.current.connected || !latest.current.canControlTarget
        || latest.current.huddleId !== next.huddleId
        || latest.current.targetKey !== queuedKey
        || room.state !== 'connected') return;
      try {
        await room.localParticipant.publishData(payload, { reliable: true, topic: VOICE_TARGET_TOPIC });
        lastPublished.current = queuedKey;
      } catch {
        // LiveKit can close between the room-state check and publishData. A later
        // target change/reconnect/request retries without an unhandled rejection.
      } finally {
        if (lastQueued.current === queuedKey && lastPublished.current !== queuedKey) lastQueued.current = '';
      }
    });
    return publishTail.current;
  }, [canControlTarget, connected, huddleId, room, targetKey]);

  const onTargetData = useCallback((payload: Uint8Array, participant: { identity?: string; attributes?: Record<string, string> } | undefined, _kind: unknown, topic?: string) => {
    if (topic !== VOICE_TARGET_TOPIC) return;
    // Agent requests are the one packet an agent may send. Only the designated
    // human controller answers; target-state packets below still reject agents.
    const senderIdentity = String(participant?.identity || '');
    if (senderIdentity && room.remoteParticipants?.has && !room.remoteParticipants.has(senderIdentity)) return;
    const request = decodeVoiceTargetRequest(payload, huddleId);
    if (request) {
      const requesterAgentId = String(participant?.attributes?.['agensis.agentId'] || '').trim();
      const isKnownAgent = rosterAgentIds.length === 0 || !requesterAgentId || rosterAgentIds.includes(requesterAgentId);
      const requestedRevision = request.currentRevision ?? -1;
      const isPlausibleFloor = requestedRevision < 0
        || requestedRevision <= revision.current + MAX_TARGET_REVISION_SYNC_LEAD;
      if (canControlTarget && participant?.attributes?.['agensis.kind'] === 'agent'
        && isKnownAgent && isPlausibleFloor) {
        void publish({ force: true, minRevision: requestedRevision });
      }
      return;
    }
    if (participant?.attributes?.['agensis.kind'] === 'agent') return;
    // Human identities are server-issued user:<uuid> values. An unknown LiveKit
    // participant kind must never become a target controller by omission.
    if (!senderIdentity.startsWith('user:')) return;
    if (authoritativeIdentity && participant?.identity !== authoritativeIdentity) return;
    const packet = decodeVoiceTarget(payload, huddleId, rosterAgentIds);
    if (!packet) {
      // Agent roster data can arrive after LiveKit's first reliable packet. Keep
      // one authenticated, huddle-scoped packet whenever the only failure is
      // target membership (including a partially loaded, nonempty roster), then
      // revalidate it when the roster completes. Malformed packets are dropped.
      const structurallyValid = decodeVoiceTarget(payload, huddleId, rosterAgentIds, { allowUnknownTarget: true });
      const senderIsController = authoritativeIdentity
        ? participant?.identity === authoritativeIdentity
        : participant?.attributes?.['agensis.kind'] !== 'agent';
      if (structurallyValid && senderIsController) {
        pendingTargetPayload.current = typeof payload === 'string' ? payload : payload.slice();
      }
      return;
    }
    if (packet.revision > revision.current) {
      revision.current = packet.revision;
      rememberTargetRevision(huddleId, revision.current);
      pendingTargetPayload.current = null;
      onTargetChanged?.(packet.targetAgentId);
    }
  }, [authoritativeIdentity, canControlTarget, huddleId, onTargetChanged, publish, room.remoteParticipants, rosterAgentIds]);

  const requestTargetSync = useCallback(() => {
    if (!canControlTarget || !connected || room.state !== 'connected' || !huddleId) return;
    const payload = new TextEncoder().encode(JSON.stringify(makeVoiceTargetRequest(huddleId)));
    void Promise.resolve(room.localParticipant.publishData(payload, { reliable: true, topic: VOICE_TARGET_TOPIC })).catch(() => {});
  }, [canControlTarget, connected, huddleId, room]);

  const publishOnReconnect = useCallback(() => {
    void publish({ force: true });
    void requestTargetSync();
  }, [publish, requestTargetSync]);
  const publishForHumanJoin = useCallback((participant: { attributes?: Record<string, string> }) => {
    if (participant.attributes?.['agensis.kind'] === 'agent') return;
    void publish({ force: true });
  }, [publish]);

  useEffect(() => {
    if (pendingTargetPayload.current && rosterAgentIds.length > 0) {
      const pending = decodeVoiceTarget(pendingTargetPayload.current, huddleId, rosterAgentIds);
      // Keep an authenticated packet until the roster contains its target. A
      // partial roster is normal during room startup; dropping it here makes a
      // later-complete roster unable to apply the already-received state.
      if (pending) {
        pendingTargetPayload.current = null;
        if (pending.revision > revision.current) {
          revision.current = pending.revision;
          rememberTargetRevision(huddleId, revision.current);
          onTargetChanged?.(pending.targetAgentId);
        }
      }
    }
    if (!connected) return undefined;
    // Install listeners before requesting a replay: a local test room or a
    // very fast worker may answer the sync packet in the same turn.
    room.on(RoomEvent.DataReceived, onTargetData);
    room.on(RoomEvent.ParticipantConnected, publishForHumanJoin);
    room.on(RoomEvent.Reconnected, publishOnReconnect);
    void publish();
    // Ask a live worker to replay its revision floor. This is what makes a
    // page/component remount safe without trusting a volatile useRef counter.
    void requestTargetSync();
    return () => {
      room.off(RoomEvent.DataReceived, onTargetData);
      room.off(RoomEvent.ParticipantConnected, publishForHumanJoin);
      room.off(RoomEvent.Reconnected, publishOnReconnect);
    };
  }, [connected, huddleId, onTargetChanged, onTargetData, publish, publishForHumanJoin, publishOnReconnect, requestTargetSync, room, rosterAgentIds]);

  return null;
}

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
