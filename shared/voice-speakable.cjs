'use strict';

// Server-side speakable-sentence extraction for live huddle TTS.
//
// Mirrors src/lib/voiceStream.ts `sentenceChunks` deliberately: the server must
// only publish sentences the browser would also speak from the durable message
// stream, or ephemeral + durable delivery double-speaks or drops tails.
// Keep the regex and soft limit in lockstep with the client (pinned by tests).

// Past this many unspoken characters with no sentence end, speak at a clause
// boundary. Same number as SENTENCE_SOFT_LIMIT in voiceStream.ts.
const SENTENCE_SOFT_LIMIT = 220;

// Terminator followed by whitespace or end of string. Lookbehinds rule out
// decimals ("sonic 3.5") and single-letter initials ("J. Kneen").
const SENTENCE_END_RE = /(?<![0-9])(?<!\b[A-Z])[.!?…](?=\s|$)|[:;](?=\s)/g;

const HUDDLE_VOICE_CHANNEL_PREFIX = 'huddle-voice';
const HUDDLE_VOICE_EVENT = 'sentence';

function huddleVoiceChannel(workspaceId) {
  const id = String(workspaceId || '').trim();
  return id ? `${HUDDLE_VOICE_CHANNEL_PREFIX}:${id}` : '';
}

/**
 * Complete utterances ready to speak now, given growing fullText and what has
 * already been spoken (a prefix of fullText).
 *
 * @returns {{ speak: string[], spoken: string }}
 */
function sentenceChunks(fullText, alreadySpoken) {
  const full = String(fullText || '');
  const spoken = String(alreadySpoken || '');
  if (!full) return { speak: [], spoken };
  if (spoken && !full.startsWith(spoken)) return { speak: [], spoken };

  const tail = full.slice(spoken.length);
  if (!tail.trim()) return { speak: [], spoken };

  const speak = [];
  let consumed = 0;
  SENTENCE_END_RE.lastIndex = 0;
  for (let match = SENTENCE_END_RE.exec(tail); match; match = SENTENCE_END_RE.exec(tail)) {
    const end = match.index + match[0].length;
    const piece = tail.slice(consumed, end).trim();
    if (piece) speak.push(piece);
    consumed = end;
  }

  const rest = tail.slice(consumed);
  if (speak.length === 0 && rest.length > SENTENCE_SOFT_LIMIT) {
    const cut = clauseBreak(rest, SENTENCE_SOFT_LIMIT);
    if (cut > 0) {
      const piece = rest.slice(0, cut).trim();
      if (piece) speak.push(piece);
      consumed += cut;
    }
  }

  return { speak, spoken: spoken + tail.slice(0, consumed) };
}

function clauseBreak(text, limit) {
  const head = text.slice(0, limit);
  const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' — '));
  if (clause > limit * 0.4) return clause + 1;
  const word = head.lastIndexOf(' ');
  return word > limit * 0.4 ? word : 0;
}

/**
 * Progressive list: each piece with the cumulative spoken prefix after it.
 * Used to emit one ephemeral event per sentence with a stable offset.
 *
 * @returns {Array<{ sentence: string, offset: number, spokenAfter: string }>}
 */
function speakableProgress(fullText, alreadySpoken) {
  const full = String(fullText || '');
  let cursor = String(alreadySpoken || '');
  if (!full) return [];
  if (cursor && !full.startsWith(cursor)) return [];

  const out = [];
  // Walk by re-running sentenceChunks one piece at a time so offsets stay exact.
  for (;;) {
    const { speak, spoken } = sentenceChunks(full, cursor);
    if (speak.length === 0) break;
    // sentenceChunks can return multiple pieces; emit them one by one with
    // intermediate prefixes reconstructed from the returned spoken end.
    // When multiple pieces land in one call, slice them out of the delta.
    const delta = spoken.slice(cursor.length);
    let local = 0;
    for (const piece of speak) {
      const at = delta.indexOf(piece, local);
      if (at < 0) {
        // Fallback: append piece to cursor as best-effort.
        const offset = cursor.length;
        cursor = `${cursor}${piece}`;
        out.push({ sentence: piece, offset, spokenAfter: cursor });
        local = delta.length;
        continue;
      }
      const end = at + piece.length;
      const spokenAfter = cursor + delta.slice(0, end);
      out.push({ sentence: piece, offset: cursor.length + at, spokenAfter });
      local = end;
    }
    cursor = spoken;
    // Avoid infinite loop if spoken did not advance.
    if (speak.length === 0) break;
  }
  return out;
}

/**
 * Structured latency marks. Never includes transcript text.
 * Enable with AGENSIS_VOICE_LATENCY=1 (always on outside production).
 */
function voiceLatencyEnabled() {
  // Opt-in only: stage timings are for measuring huddles, not day-to-day noise.
  return process.env.AGENSIS_VOICE_LATENCY === '1';
}

function voiceLatencyMark(stage, ids = {}) {
  if (!voiceLatencyEnabled()) return;
  const safe = {};
  for (const [key, value] of Object.entries(ids || {})) {
    if (value == null || value === '') continue;
    // Never log free text; only ids and numbers.
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  console.log(JSON.stringify({
    type: 'voice_latency',
    stage: String(stage || ''),
    t: Date.now(),
    ...safe,
  }));
}

module.exports = {
  SENTENCE_SOFT_LIMIT,
  SENTENCE_END_RE,
  HUDDLE_VOICE_CHANNEL_PREFIX,
  HUDDLE_VOICE_EVENT,
  huddleVoiceChannel,
  sentenceChunks,
  speakableProgress,
  voiceLatencyEnabled,
  voiceLatencyMark,
};
