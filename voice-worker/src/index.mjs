// LiveKit media bridge for one selected Agensis agent.
//
// The worker hears the room with Deepgram and posts the final human turn to the
// backend. The backend stores `@selected-handle ...` and dispatches the actual
// Claude/Codex/etc agent. Completed reply sentences return over LiveKit data and
// this worker speaks them with Cartesia. There is intentionally no LLM here.

import {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  JobContext,
  ServerOptions,
  cli,
  defineAgent,
} from '@livekit/agents';
import { RoomEvent } from '@livekit/rtc-node';
import { buildEngine, loadVad, resolveEngine, VOICE_OUTPUT_QUEUE_SIZE_MS } from './providers.mjs';
import { ensureRoomAudioOutputStarted } from './roomAudio.mjs';
import { mirrorTranscript } from './transcript.mjs';
import { createVoiceReplyReceiver, VOICE_REPLY_TOPIC } from './voiceReply.mjs';
import {
  VOICE_TARGET_TOPIC,
  INACTIVE_PARTICIPANT_IDENTITY,
  acceptsTargetPacket,
  MAX_TARGET_REVISION,
  decodeVoiceTarget,
  encodeVoiceTargetRequest,
  isAgentParticipant,
  isVoiceTargetRequest,
  isTargetAgent,
} from './voiceTarget.mjs';

const VOICE_CREDENTIAL_CHECK_INTERVAL_MS = 5_000;

function readJobMetadata(ctx) {
  const raw = String(ctx.job?.metadata || '').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default defineAgent({
  prewarm: async (proc) => {
    try {
      proc.userData.vad = await loadVad();
    } catch (error) {
      console.error(`[voice] Silero prewarm failed: ${error?.message || error}`);
    }
  },

  entry: async (ctx) => {
    const meta = readJobMetadata(ctx);
    const log = console;
    const { engine, missing, requested } = resolveEngine(meta.voice?.engine || meta.engine);
    if (!engine) {
      log.error(`[voice] engine "${requested}" unavailable${missing?.length ? ` (missing ${missing.join(', ')})` : ''}`);
      throw new Error('No voice engine configured');
    }

    const builtPromise = buildEngine({
      engine,
      voice: meta.voice || {},
      vad: ctx.proc?.userData?.vad || null,
    });
    await ctx.connect();
    const built = await builtPromise;

    const agent = new Agent({
      instructions: 'Transcribe room audio only. Reasoning and tool use belong to the selected Agensis agent.',
    });
    const session = new AgentSession({
      stt: built.stt,
      tts: built.tts,
      ...(built.vad ? { vad: built.vad } : {}),
      ...(built.turnDetection ? { turnHandling: { turnDetection: built.turnDetection } } : {}),
    });

    const rosterAgentIds = Array.isArray(meta.rosterAgentIds)
      ? meta.rosterAgentIds.map(String)
      : [String(meta.agentId || '')].filter(Boolean);
    const targetControllerIdentity = String(meta.targetControllerIdentity || '').trim();
    const defaultTargetAgentId = meta.targetAgentId === null
      ? null
      : String(meta.targetAgentId || rosterAgentIds[0] || meta.agentId || '');
    let targetReady = !targetControllerIdentity;
    let targetAgentId = targetReady ? (defaultTargetAgentId || null) : null;
    let targetRevision = targetReady && Number.isInteger(meta.targetRevision)
      ? Math.max(-1, Math.min(MAX_TARGET_REVISION, meta.targetRevision))
      : -1;
    let sessionStarted = false;
    let lastAppliedActive = null;
    const roomAudioAbortController = new AbortController();

    const isSelected = () => targetReady && isTargetAgent({ targetAgentId, agentId: meta.agentId });
    const currentHuman = (excluded = '') => [...(ctx.room.remoteParticipants?.values?.() || [])]
      .find((participant) => participant.identity !== excluded && !isAgentParticipant(participant));
    const currentTargetController = () => {
      const humans = [...(ctx.room.remoteParticipants?.values?.() || [])]
        .filter((participant) => !isAgentParticipant(participant))
        .map((participant) => String(participant.identity || ''))
        .filter(Boolean)
        .sort();
      return targetControllerIdentity || humans[0] || '';
    };

    let voiceSessionClosed = false;
    const publishVoiceReady = async (ready) => {
      if (ready && voiceSessionClosed) return;
      await ctx.room.localParticipant.setAttributes({
        'agensis.voiceReady': ready ? 'true' : 'false',
      }).catch((error) => {
        log.error(`[voice] could not publish ${ready ? 'ready' : 'unready'} state: ${error?.message || error}`);
      });
    };

    await ctx.room.localParticipant.setAttributes({
      'agensis.kind': 'agent',
      'agensis.agentId': String(meta.agentId || ''),
      'agensis.handle': String(meta.handle || ''),
      'agensis.name': String(meta.name || meta.handle || 'Agent'),
      'agensis.accentColor': String(meta.accentColor || ''),
      'agensis.engine': engine,
    }).catch((error) => {
      log.error(`[voice] could not publish agent attributes: ${error?.message || error}`);
    });
    await publishVoiceReady(false);

    const onVoiceSessionClose = () => {
      voiceSessionClosed = true;
      void publishVoiceReady(false);
    };
    session.on(AgentSessionEventTypes.Close, onVoiceSessionClose);

    const transcript = mirrorTranscript({
      session,
      meta,
      log,
      shouldMirror: isSelected,
      // The actual agent reply is already the durable assistant row. Cartesia
      // playback must never mirror a second synthetic assistant message.
      mirrorAssistant: false,
    });

    let credentialCheckTimer = null;
    let credentialCheckPromise = null;
    const checkVoiceCredential = () => {
      const endpoint = String(meta.transcript?.url || '').trim();
      const credential = String(meta.transcript?.token || '').trim();
      if (!endpoint || !credential) return Promise.resolve(false);
      if (credentialCheckPromise) return credentialCheckPromise;
      credentialCheckPromise = (async () => {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
            body: JSON.stringify({ huddleId: meta.huddleId, role: 'user', content: '' }),
          });
          const probe = await response.json().catch(() => null);
          const ended = probe?.data?.reason === 'ended';
          if (response.status === 401 || response.status === 403 || response.status === 404 || ended) {
            log.error('[voice] voice credential or huddle revoked; leaving the huddle');
            ctx.shutdown('voice credential revoked');
            return false;
          }
          return response.ok === undefined
            ? response.status >= 200 && response.status < 300
            : response.ok;
        } catch {
          return false;
        }
      })().finally(() => { credentialCheckPromise = null; });
      return credentialCheckPromise;
    };

    if (meta.transcript?.url && meta.transcript?.token) {
      void checkVoiceCredential();
      credentialCheckTimer = setInterval(() => { void checkVoiceCredential(); }, VOICE_CREDENTIAL_CHECK_INTERVAL_MS);
      credentialCheckTimer.unref?.();
    }

    const applyTarget = () => {
      const roomIO = session?._roomIO;
      const active = isSelected();
      const wasActive = lastAppliedActive;
      lastAppliedActive = active;
      if (!active) {
        if (wasActive === true) transcript.cancelPending?.();
        if (sessionStarted && wasActive === true) {
          try {
            const interruption = session.interrupt({ force: true });
            void interruption?.await?.catch(() => {});
          } catch { /* shutdown race */ }
        }
        roomIO?.setParticipant(INACTIVE_PARTICIPANT_IDENTITY);
        return;
      }
      roomIO?.setParticipant(currentHuman()?.identity || null);
    };

    let targetPacketReceived = false;
    let targetTransportEpoch = 0;
    let targetRequestTimer = null;
    let targetRequestAttempts = 0;
    const requestTarget = () => {
      if (!ctx.room.localParticipant?.publishData || !meta.huddleId) return;
      targetRequestAttempts += 1;
      const pending = ctx.room.localParticipant.publishData(
        encodeVoiceTargetRequest(meta.huddleId, targetRevision),
        { reliable: true, topic: VOICE_TARGET_TOPIC },
      );
      void Promise.resolve(pending).catch(() => {});
    };
    const stopTargetRequests = () => {
      if (targetRequestTimer) clearInterval(targetRequestTimer);
      targetRequestTimer = null;
    };

    const handleTargetData = async (payload, participant) => {
      const senderIdentity = String(participant?.identity || '');
      const remoteParticipants = ctx.room.remoteParticipants;
      if (senderIdentity && remoteParticipants?.has && !remoteParticipants.has(senderIdentity)) return;
      const packet = decodeVoiceTarget(payload);
      if (isVoiceTargetRequest(packet, meta.huddleId)) {
        if (!participant?.identity || isAgentParticipant(participant)) return;
        const controller = currentTargetController();
        if (controller && String(participant.identity) !== controller) return;
        requestTarget();
        return;
      }
      const result = acceptsTargetPacket({
        packet,
        sender: participant,
        huddleId: meta.huddleId,
        rosterAgentIds,
        controllerIdentity: currentTargetController(),
        currentRevision: targetRevision,
      });
      if (!result.accepted) return;
      const packetTransportEpoch = targetTransportEpoch;
      if (targetControllerIdentity && !(await checkVoiceCredential())) return;
      if (packetTransportEpoch !== targetTransportEpoch) return;
      const latestParticipants = ctx.room.remoteParticipants;
      if (latestParticipants?.has && !latestParticipants.has(senderIdentity)) return;
      if (latestParticipants?.get && latestParticipants.get(senderIdentity) !== participant) return;
      const latestController = currentTargetController();
      if (latestController && latestController !== senderIdentity) return;
      if (result.revision <= targetRevision) return;
      targetPacketReceived = true;
      stopTargetRequests();
      targetReady = true;
      targetRevision = result.revision;
      targetAgentId = result.targetAgentId;
      applyTarget();
      log.log(`[voice] @${meta.handle || 'agent'} target is ${targetAgentId || 'none'}`);
    };

    const replyReceiver = createVoiceReplyReceiver({
      meta,
      isActive: () => sessionStarted && isSelected(),
      log,
      speak: async (sentence) => {
        const speech = session.say(sentence, {
          allowInterruptions: true,
          addToChatCtx: false,
        });
        void speech?.waitForPlayout?.().catch((error) => {
          log.error(`[voice] Cartesia playout failed: ${error?.message || error}`);
        });
      },
    });

    let targetPacketChain = Promise.resolve();
    const onRoomData = (payload, participant, _kind, topic) => {
      if (topic === VOICE_REPLY_TOPIC) {
        void replyReceiver.handle(payload, participant, topic);
        return;
      }
      if (topic !== VOICE_TARGET_TOPIC) return;
      targetPacketChain = targetPacketChain
        .then(() => handleTargetData(payload, participant))
        .catch((error) => log.error(`[voice] target packet failed: ${error?.message || error}`));
    };
    const onParticipantConnected = (participant) => {
      if (!isSelected() || isAgentParticipant(participant)) return;
      const roomIO = session?._roomIO;
      if (roomIO && !roomIO.linkedParticipant) roomIO.setParticipant(participant.identity);
    };
    const onParticipantDisconnected = (participant) => {
      if (!isSelected()) return;
      const roomIO = session?._roomIO;
      if (roomIO?.linkedParticipant?.identity !== participant?.identity) return;
      roomIO.setParticipant(currentHuman(participant.identity)?.identity || null);
    };
    const onTargetReconnect = () => {
      targetTransportEpoch = targetTransportEpoch >= Number.MAX_SAFE_INTEGER
        ? Number.MAX_SAFE_INTEGER
        : targetTransportEpoch + 1;
      targetPacketReceived = false;
      targetRequestAttempts = 0;
      if (!targetControllerIdentity) {
        targetReady = true;
        targetAgentId = defaultTargetAgentId || targetAgentId || null;
        applyTarget();
        stopTargetRequests();
        return;
      }
      targetReady = false;
      targetAgentId = null;
      applyTarget();
      stopTargetRequests();
      requestTarget();
      targetRequestTimer = setInterval(() => {
        if (targetPacketReceived || targetRequestAttempts >= 10) return stopTargetRequests();
        requestTarget();
      }, 1_000);
      targetRequestTimer.unref?.();
    };

    ctx.room.on(RoomEvent.DataReceived, onRoomData);
    ctx.room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    ctx.room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    ctx.room.on(RoomEvent.Reconnected, onTargetReconnect);

    applyTarget();
    onTargetReconnect();

    ctx.addShutdownCallback(async () => {
      voiceSessionClosed = true;
      roomAudioAbortController.abort();
      if (credentialCheckTimer) clearInterval(credentialCheckTimer);
      credentialCheckTimer = null;
      stopTargetRequests();
      transcript.stop();
      replyReceiver.clear();
      session.off?.(AgentSessionEventTypes.Close, onVoiceSessionClose);
      ctx.room.off?.(RoomEvent.DataReceived, onRoomData);
      ctx.room.off?.(RoomEvent.ParticipantConnected, onParticipantConnected);
      ctx.room.off?.(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      ctx.room.off?.(RoomEvent.Reconnected, onTargetReconnect);
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        // RoomIO 1.6.1 strands its output initializer when this identity changes
        // while init() awaits the old participant Future. Start parked, publish
        // the output explicitly below, then select the human through applyTarget.
        participantIdentity: INACTIVE_PARTICIPANT_IDENTITY,
        textEnabled: false,
        audioEnabled: true,
        videoEnabled: false,
        closeOnDisconnect: false,
      },
      outputOptions: {
        audioEnabled: true,
        queueSizeMs: VOICE_OUTPUT_QUEUE_SIZE_MS,
        transcriptionEnabled: true,
        syncTranscription: true,
      },
    });

    await ensureRoomAudioOutputStarted({
      session,
      signal: roomAudioAbortController.signal,
      log,
    });
    sessionStarted = true;
    applyTarget();
    await publishVoiceReady(true);
    log.log(`[voice] @${meta.handle || 'agent'} joined ${ctx.room.name} on ${engine}; Agensis owns replies`);
  },
});

if (import.meta.url === `file://${process.argv[1]}`) {
  cli.runApp(new ServerOptions({
    agent: import.meta.filename,
    agentName: process.env.LIVEKIT_AGENT_NAME || 'agensis-voice',
  }));
}

export { JobContext };
