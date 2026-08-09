// Pure helpers for the ephemeral huddle voice-text lane.
//
// Server publishes completed speakable sentences on
// `huddle-voice:<workspaceId>` / event `sentence` before the durable message
// UPDATE fans out. The client must:
//   1. only accept frames for the live session
//   2. speak each (messageId, offset) at most once
//   3. keep spokenText prefixes consistent with the durable fallback path

export const HUDDLE_VOICE_CHANNEL_PREFIX = 'huddle-voice';
export const HUDDLE_VOICE_EVENT = 'sentence';

export function huddleVoiceChannel(workspaceId: string | null | undefined): string {
  const id = String(workspaceId || '').trim();
  return id ? `${HUDDLE_VOICE_CHANNEL_PREFIX}:${id}` : '';
}

export interface HuddleVoiceSentencePayload {
  sessionId?: string;
  messageId?: string;
  agentId?: string;
  agentName?: string;
  sentence?: string;
  offset?: number;
  spokenAfter?: string;
  seq?: number;
}

export interface AcceptedVoiceSentence {
  messageId: string;
  agentId: string;
  agentName: string;
  sentence: string;
  spokenAfter: string;
  offset: number;
}

/**
 * Validate and accept an ephemeral sentence for speech.
 * Returns null when the frame is for another session, empty, or already spoken.
 *
 * @param alreadySpoken - cumulative spoken prefix for this messageId (from spokenTextRef)
 */
export function acceptHuddleVoiceSentence(
  payload: HuddleVoiceSentencePayload | null | undefined,
  sessionId: string | null | undefined,
  alreadySpoken: string,
): AcceptedVoiceSentence | null {
  if (!payload || typeof payload !== 'object') return null;
  const liveSession = String(sessionId || '').trim();
  if (!liveSession || String(payload.sessionId || '').trim() !== liveSession) return null;

  const messageId = String(payload.messageId || '').trim();
  const agentId = String(payload.agentId || '').trim();
  const sentence = String(payload.sentence || '').trim();
  if (!messageId || !agentId || !sentence) return null;

  const offset = Number(payload.offset);
  const spoken = String(alreadySpoken || '');
  // Already past this offset (durable path or earlier ephemeral piece).
  if (Number.isFinite(offset) && offset < spoken.length) return null;
  // If we have a spoken prefix and the offset does not continue it, skip —
  // rewrites / out-of-order frames must not re-read earlier text.
  if (spoken && Number.isFinite(offset) && offset !== spoken.length) {
    // Allow small gaps only if spokenAfter still extends the prefix.
    const spokenAfter = String(payload.spokenAfter || '');
    if (!spokenAfter.startsWith(spoken)) return null;
  }

  const spokenAfter = String(payload.spokenAfter || `${spoken}${sentence}`);
  if (spoken && !spokenAfter.startsWith(spoken) && spokenAfter !== spoken) {
    // Non-prefix rewrite: drop (same policy as sentenceChunks).
    return null;
  }
  if (spokenAfter === spoken) return null;

  return {
    messageId,
    agentId,
    agentName: String(payload.agentName || '').trim() || 'Agent',
    sentence,
    spokenAfter,
    offset: Number.isFinite(offset) ? offset : spoken.length,
  };
}
