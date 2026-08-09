'use strict';

// Ephemeral speakable-sentence fanout for live huddles.
//
// Completes the voice path before the durable messages UPDATE lands: the browser
// can start Cartesia as soon as a full stop arrives in the model stream, without
// waiting for DB commit + db_changes subscription delivery.
//
// Security: workspace-scoped channel `huddle-voice:<workspaceId>` (same grammar
// as agent-status / item-presence) plus fail-closed session audience for private
// sessions. Payload is sentence text + ids only — no tools, thinking, or row.

const {
  huddleVoiceChannel,
  HUDDLE_VOICE_EVENT,
  speakableProgress,
  voiceLatencyMark,
} = require('../shared/voice-speakable.cjs');

function createVoicePublish(deps = {}) {
  const {
    sessionRealtimeAudience = async () => null,
    relayBroadcastToUserIds = () => {},
  } = deps;

  /**
   * Publish any newly completed speakable pieces for a streaming agent message.
   * Returns the new cumulative spoken prefix (for the caller's bookkeeping).
   *
   * @param {{
   *   workspaceId: string,
   *   sessionId: string,
   *   messageId: string,
   *   agentId: string,
   *   agentName?: string,
   *   fullText: string,
   *   previousSpoken?: string,
   *   jobId?: string,
   * }} args
   */
  async function publishHuddleVoiceText({
    workspaceId,
    sessionId,
    messageId,
    agentId,
    agentName = '',
    fullText = '',
    previousSpoken = '',
    jobId = '',
  } = {}) {
    const channel = huddleVoiceChannel(workspaceId);
    if (!channel || !sessionId || !messageId || !agentId) {
      return String(previousSpoken || '');
    }

    const pieces = speakableProgress(fullText, previousSpoken);
    if (pieces.length === 0) return String(previousSpoken || '');

    const audience = await sessionRealtimeAudience(sessionId);
    if (!audience) {
      // Fail closed: unknown / deleted session must not broadcast.
      return String(previousSpoken || '');
    }

    const allowedUserIds = audience.memberUserIds;
    let lastSpoken = String(previousSpoken || '');

    for (let seq = 0; seq < pieces.length; seq += 1) {
      const piece = pieces[seq];
      lastSpoken = piece.spokenAfter;
      voiceLatencyMark('sentence_ephemeral_emit', {
        sessionId,
        messageId,
        agentId,
        jobId: jobId || undefined,
        seq,
        offset: piece.offset,
      });
      relayBroadcastToUserIds(
        channel,
        HUDDLE_VOICE_EVENT,
        {
          sessionId: String(sessionId),
          messageId: String(messageId),
          agentId: String(agentId),
          agentName: String(agentName || ''),
          sentence: piece.sentence,
          offset: piece.offset,
          spokenAfter: piece.spokenAfter,
          seq,
        },
        allowedUserIds,
      );
    }

    return lastSpoken;
  }

  return { publishHuddleVoiceText };
}

module.exports = {
  createVoicePublish,
};
