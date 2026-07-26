// The pure half of the streaming voice pipeline: audio format conversion, the
// Deepgram Flux turn state machine, sentence splitting for streaming TTS, and
// the echo guard. No React, no DOM, no network — every decision that can be
// got wrong here is a function of its arguments and nothing else.
//
// Its counterparts with side effects are src/lib/deepgramMic.ts (capture) and
// src/lib/cartesiaSpeaker.ts (playback), which are deliberately thin: they own
// an AudioContext and a socket and defer every judgement to this file.

// ---------------------------------------------------------------------------
// Audio format
// ---------------------------------------------------------------------------

/**
 * Browser mic samples -> the linear16 Deepgram wants.
 *
 * Clamped before scaling: an AudioContext can hand back values slightly outside
 * [-1, 1] after gain, and letting those wrap round Int16 turns a loud syllable
 * into a burst of white noise that the model then faithfully fails to
 * transcribe. Asymmetric scale factors because Int16 holds -32768 but only
 * +32767.
 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

/**
 * Cartesia's pcm_s16le bytes -> what an AudioBuffer takes.
 *
 * Little-endian by contract (that is what `pcm_s16le` means), read explicitly
 * rather than via Int16Array over the buffer: the incoming bytes come from a
 * base64 decode with no alignment guarantee, and a big-endian host would
 * otherwise produce noise.
 */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const lo = bytes[i * 2];
    const hi = bytes[i * 2 + 1];
    const signed = ((hi << 8) | lo) << 16 >> 16;
    out[i] = signed / 0x8000;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deepgram Flux turn state machine
// ---------------------------------------------------------------------------

/** The Flux events we act on. Anything else is reported as 'other'. */
export type FluxEventKind = 'connected' | 'start' | 'update' | 'eager' | 'resumed' | 'final' | 'error' | 'other';

export interface FluxEvent {
  kind: FluxEventKind;
  transcript: string;
  /** Flux's confidence that the speaker has finished, 0 when it did not say. */
  endOfTurnConfidence: number;
  /** Present only on kind 'error'. */
  message: string;
}

/**
 * One raw Flux frame -> the four facts we care about.
 *
 * Flux is the reason for this whole migration: it answers "has this person
 * finished talking" itself, where the browser recogniser and nova-3 both leave
 * that to a silence timer that cuts people off mid-thought.
 */
export function readFluxEvent(raw: unknown): FluxEvent {
  const msg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const transcript = typeof msg.transcript === 'string' ? msg.transcript.trim() : '';
  const confidence = typeof msg.end_of_turn_confidence === 'number' ? msg.end_of_turn_confidence : 0;
  const base = { transcript, endOfTurnConfidence: confidence, message: '' };

  if (msg.type === 'Connected') return { ...base, kind: 'connected' };
  if (msg.type === 'Error' || msg.type === 'FatalError') {
    return { ...base, kind: 'error', message: String(msg.description || msg.code || 'Transcription failed.') };
  }
  if (msg.type !== 'TurnInfo') return { ...base, kind: 'other' };

  switch (msg.event) {
    case 'StartOfTurn': return { ...base, kind: 'start' };
    case 'Update': return { ...base, kind: 'update' };
    case 'EagerEndOfTurn': return { ...base, kind: 'eager' };
    case 'TurnResumed': return { ...base, kind: 'resumed' };
    case 'EndOfTurn': return { ...base, kind: 'final' };
    default: return { ...base, kind: 'other' };
  }
}

export interface TurnState {
  /** Words heard but not committed — this is what the live caption shows. */
  interim: string;
  /** Set exactly once, on the frame that ends a turn. Never re-emitted. */
  utterance: string;
  /** '' unless the stream reported a problem worth showing. */
  error: string;
}

export const IDLE_TURN: TurnState = { interim: '', utterance: '', error: '' };

/**
 * Advance the turn state by one Flux event.
 *
 * `utterance` is populated ONLY by EndOfTurn, never by EagerEndOfTurn — and
 * that is a decision, not an oversight. Eager exists so a voice agent can start
 * generating early and throw the work away if TurnResumed follows. Our
 * "generation" is posting a chat message, which dispatches an agent and cannot
 * be un-posted, so acting on a guess would mean the agent answers half a
 * sentence and then answers it again. We ask for no eager threshold, so these
 * frames should never arrive; they are handled anyway because a server-side
 * default is not ours to rely on.
 */
export function reduceTurn(state: TurnState, event: FluxEvent): TurnState {
  switch (event.kind) {
    case 'start':
      return { interim: event.transcript, utterance: '', error: '' };
    case 'update':
    case 'eager':
    case 'resumed':
      // Flux resends the whole turn each time, so this is an assignment, not an
      // append. An empty transcript on an eager/resumed frame keeps whatever the
      // last Update said rather than blanking the caption mid-sentence.
      return event.transcript
        ? { ...state, interim: event.transcript, utterance: '' }
        : { ...state, utterance: '' };
    case 'final':
      return { interim: '', utterance: event.transcript || state.interim, error: '' };
    case 'error':
      return { interim: '', utterance: '', error: event.message };
    default:
      return state.utterance ? { ...state, utterance: '' } : state;
  }
}

// ---------------------------------------------------------------------------
// Sentence chunking for streaming TTS
// ---------------------------------------------------------------------------

// Past this many unspoken characters with no sentence end in sight, speak at
// the best clause boundary available. An agent that writes a 400-character
// sentence should not buy itself 400 characters of silence.
export const SENTENCE_SOFT_LIMIT = 220;

// A terminator followed by whitespace or the end of the string. The lookbehind
// rules out the two things that end in a full stop but are not a sentence: a
// decimal ("sonic 3.5") and a single-letter initial ("J. Kneen").
const SENTENCE_END_RE = /(?<![0-9])(?<!\b[A-Z])[.!?…](?=\s|$)|[:;](?=\s)/g;

export interface SentenceSplit {
  /** Complete utterances, in order, ready to speak now. */
  speak: string[];
  /** The new "already spoken" prefix of the full text. */
  spoken: string;
}

/**
 * What can be SPOKEN now, given a message that is still being written.
 *
 * The old browser pipeline waited 700ms for the text to stop changing, then
 * said the whole block. Cartesia answers in ~110ms, so the wait was most of the
 * perceived latency — this instead hands over each sentence the moment its full
 * stop arrives, and holds only the trailing fragment.
 *
 * Growth is a prefix; a rewrite is not. On a rewrite this returns nothing and
 * keeps the old prefix, because re-reading a paragraph the listener already
 * heard is worse than dropping the tail of a rare edit (the same policy as
 * nextSpeechChunk in huddleVoice.ts, which this replaces for the streaming case).
 */
export function sentenceChunks(fullText: string, alreadySpoken: string): SentenceSplit {
  const full = String(fullText || '');
  const spoken = String(alreadySpoken || '');
  if (!full) return { speak: [], spoken };
  if (spoken && !full.startsWith(spoken)) return { speak: [], spoken };

  const tail = full.slice(spoken.length);
  if (!tail.trim()) return { speak: [], spoken };

  const speak: string[] = [];
  let consumed = 0;
  SENTENCE_END_RE.lastIndex = 0;
  for (let match = SENTENCE_END_RE.exec(tail); match; match = SENTENCE_END_RE.exec(tail)) {
    const end = match.index + match[0].length;
    const piece = tail.slice(consumed, end).trim();
    if (piece) speak.push(piece);
    consumed = end;
  }

  // Nothing terminated, but the fragment has grown long enough that waiting is
  // worse than a slightly early breath.
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

/** The last clause or word boundary at or before `limit`, or 0 if there is none worth using. */
function clauseBreak(text: string, limit: number): number {
  const head = text.slice(0, limit);
  const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' — '));
  if (clause > limit * 0.4) return clause + 1;
  const word = head.lastIndexOf(' ');
  return word > limit * 0.4 ? word : 0;
}

/**
 * Everything still unspoken, whether or not it ends in a full stop.
 *
 * Called when the message is known to be finished, so the trailing fragment
 * sentenceChunks is holding gets said instead of being silently dropped.
 */
export function flushRemainder(fullText: string, alreadySpoken: string): SentenceSplit {
  const full = String(fullText || '');
  const spoken = String(alreadySpoken || '');
  if (!full) return { speak: [], spoken };
  if (spoken && !full.startsWith(spoken)) return { speak: [], spoken };
  const tail = full.slice(spoken.length).trim();
  return tail ? { speak: [tail], spoken: full } : { speak: [], spoken: full };
}

// ---------------------------------------------------------------------------
// Echo guard
// ---------------------------------------------------------------------------

// How long after the last sample plays out a recognised utterance is still
// treated as our own voice arriving back through the microphone.
export const PLAYBACK_ECHO_TAIL_MS = 600;

/**
 * The timestamp until which transcription must be discarded as our own echo.
 *
 * The browser version of this keyed off "speechSynthesis says it is speaking",
 * which is a boolean that arrives late and clears early. Cartesia audio is
 * scheduled on an AudioContext, so we know to the sample WHEN the last chunk
 * finishes — pass that, and the guard is exact instead of a guess.
 *
 * The tail is longer than the browser pipeline's 400ms because Deepgram is
 * genuinely better at hearing a quiet speaker across a room, which cuts both
 * ways: it will happily transcribe our own reply off the laptop speakers and
 * feed it back to the agent as if the human had said it. Headphones make the
 * problem disappear, which is exactly why it must not be left to chance.
 *
 * `playbackEndsAtMs` of 0 means nothing has been queued, and the guard is open.
 * A time already in the past yields a window that has already closed, which is
 * the same thing said arithmetically — no branch needed.
 */
export function playbackEchoGuardUntil(playbackEndsAtMs: number, tailMs = PLAYBACK_ECHO_TAIL_MS): number {
  const ends = Number(playbackEndsAtMs) || 0;
  return ends <= 0 ? 0 : ends + tailMs;
}

/** Is `atMs` inside the guard window? The one question callers actually ask. */
export function isEchoSuppressed(guardUntilMs: number, atMs: number): boolean {
  return atMs < guardUntilMs;
}

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

export interface VoiceCapabilities {
  stt: { provider: string; model: string; encoding: string } | null;
  tts: { provider: string; model: string; version: string; defaultVoiceId: string } | null;
}

export type SttEngine = 'deepgram' | 'browser' | 'none';
export type TtsEngine = 'cartesia' | 'browser' | 'none';

export interface EngineChoice {
  stt: SttEngine;
  tts: TtsEngine;
  /** '' when both hosted engines are in use; otherwise what to tell the user. */
  notice: string;
}

/**
 * Which engines to use, and what to say when they are not the good ones.
 *
 * Falling back is cheap here — the browser engines are the code that shipped
 * last week and they still work — so a missing key degrades to a working mic
 * with a worse voice rather than to a dead one. What it must NOT do is degrade
 * silently: a huddle where nobody can tell whether they are being heard is the
 * exact failure this pipeline was built to end, so every downgrade returns a
 * sentence and the caption row prints it.
 */
export function chooseEngines(
  capabilities: VoiceCapabilities | null,
  browser: { sttAvailable: boolean; ttsAvailable: boolean },
): EngineChoice {
  const hostedStt = capabilities?.stt?.provider === 'deepgram';
  const hostedTts = capabilities?.tts?.provider === 'cartesia';

  const stt: SttEngine = hostedStt ? 'deepgram' : browser.sttAvailable ? 'browser' : 'none';
  const tts: TtsEngine = hostedTts ? 'cartesia' : browser.ttsAvailable ? 'browser' : 'none';

  const notes: string[] = [];
  if (!hostedStt) {
    notes.push(stt === 'browser'
      ? 'Deepgram is unavailable — falling back to browser speech recognition.'
      : 'Deepgram is unavailable and this browser cannot transcribe speech.');
  }
  if (!hostedTts) {
    notes.push(tts === 'browser'
      ? 'Cartesia is unavailable — falling back to the built-in browser voice.'
      : 'Cartesia is unavailable and this browser cannot read replies aloud.');
  }
  return { stt, tts, notice: notes.join(' ') };
}
