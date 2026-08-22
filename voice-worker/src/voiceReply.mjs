export const VOICE_REPLY_TOPIC = 'agensis.voice.reply';
export const VOICE_REPLY_VERSION = 1;
export const MAX_VOICE_REPLY_CHARS = 2_000;
export const MAX_SEEN_VOICE_REPLIES = 256;

function textPayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
    return Buffer.from(payload).toString('utf8');
  }
  return '';
}

/** Parse the closed server -> worker sentence packet. */
export function decodeVoiceReply(payload) {
  let value;
  try {
    value = JSON.parse(textPayload(payload));
  } catch {
    return null;
  }
  if (!value || value.v !== VOICE_REPLY_VERSION) return null;
  const packet = {
    v: VOICE_REPLY_VERSION,
    huddleId: String(value.huddleId || '').trim(),
    sessionId: String(value.sessionId || '').trim(),
    messageId: String(value.messageId || '').trim(),
    agentId: String(value.agentId || '').trim(),
    agentName: String(value.agentName || '').trim().slice(0, 200),
    sentence: String(value.sentence || '').trim().slice(0, MAX_VOICE_REPLY_CHARS),
    offset: Number(value.offset),
    seq: Number(value.seq),
  };
  const safeId = (candidate) => /^[A-Za-z0-9._:-]{1,256}$/.test(candidate);
  if (!safeId(packet.huddleId) || !safeId(packet.sessionId)
    || !safeId(packet.messageId) || !safeId(packet.agentId)
    || !packet.sentence || !Number.isSafeInteger(packet.offset) || packet.offset < 0
    || !Number.isSafeInteger(packet.seq) || packet.seq < 0) return null;
  return packet;
}

export function voiceReplyKey(packet) {
  return packet ? `${packet.messageId}:${packet.offset}` : '';
}

/**
 * Validates, scopes, deduplicates and speaks trusted server sentences.
 * A participant-bearing packet came from a browser/room participant and is
 * refused even if it copied the topic and JSON shape.
 */
export function createVoiceReplyReceiver({ meta = {}, isActive = () => false, speak, log = console } = {}) {
  const seen = new Set();

  const handle = async (payload, participant, topic) => {
    if (topic !== VOICE_REPLY_TOPIC || participant) return false;
    const packet = decodeVoiceReply(payload);
    if (!packet || !isActive()) return false;
    if (packet.huddleId !== String(meta.huddleId || '')
      || packet.sessionId !== String(meta.transcriptSessionId || meta.sessionId || '')
      || packet.agentId !== String(meta.agentId || '')) return false;

    const key = voiceReplyKey(packet);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    while (seen.size > MAX_SEEN_VOICE_REPLIES) seen.delete(seen.values().next().value);

    try {
      await speak(packet.sentence, packet);
      return true;
    } catch (error) {
      // A failed TTS attempt may be retried by a duplicate server sentence.
      seen.delete(key);
      log.error?.(`[voice] Cartesia playback failed message=${packet.messageId} offset=${packet.offset}: ${error?.message || error}`);
      return false;
    }
  };

  return { handle, clear: () => seen.clear() };
}
