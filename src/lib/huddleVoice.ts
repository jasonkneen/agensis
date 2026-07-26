import { parseBlocks } from './markdownBlocks';
import { stripHtml } from './utils';
import { isActivityPlaceholderMessage } from './activityStatus';

// The pure half of huddle voice. No DOM APIs, no React, no SpeechRecognition —
// everything here is a string in, a string (or a boolean) out, so the decisions
// that matter can be tested without a microphone.
//
// Three questions live here:
//   1. What does an agent message SOUND like?  (speechTextFromMarkdown)
//   2. Should it be spoken at all?             (isSpeakableAgentMessage)
//   3. How much of it is left to say?          (nextSpeechChunk)
//
// All three are deliberately conservative. Speaking the wrong thing in a live
// call is worse than staying quiet: a "Thinking 0s" placeholder read aloud, a
// tool-step chip announced as prose, or a 4 KB reply that talks over the human
// for two minutes each break the conversation in a way silence does not.

/** The subset of a message row this module reads. */
export interface VoiceMessage {
  id?: string;
  content?: unknown;
  sender_kind?: string | null;
  sender_id?: string | null;
  sender_name?: string | null;
  message_kind?: string | null;
  deleted_at?: string | null;
  created_at?: string | null;
}

/** One thing to say, and who is saying it. */
export interface SpeechItem {
  id: string;
  text: string;
  speaker: string;
  /**
   * The agent whose voice this should be read in — `messages.sender_id`.
   * Carried separately from `speaker` (a display name) because the voice
   * preference is keyed on the agent's id, and two agents can share a name.
   * '' when the row has no sender id, in which case the reader falls back to
   * the device default.
   */
  agentId: string;
}

// A spoken sentence runs ~15 chars/second, so this is roughly 80 seconds of
// uninterrupted talking — already too long for a call, and a hard stop against
// an agent that pastes a whole file into the channel.
export const MAX_SPEECH_CHARS = 1200;

// How long after the browser stops talking a recognised utterance is still
// treated as our own voice echoing back off the speakers rather than the human.
export const ECHO_TAIL_MS = 400;

/**
 * Flatten inline markdown to what a person would actually say.
 *
 * Link and image syntax collapses to its label because "open bracket docs close
 * bracket open paren h t t p s colon slash slash…" is unlistenable, and a bare
 * URL becomes the word "link" for the same reason.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    // Images first — `![alt](src)` is a link with a `!`, so the link rule would
    // otherwise leave a stray leading `!`.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    // Whatever URL survived the link rule (a bare one, pasted on its own).
    .replace(/https?:\/\/\S+/g, 'link')
    // "@ada" is read as "at ada" by every engine we can't configure; the handle
    // alone is what a person would say.
    .replace(/(^|\s)@([a-z0-9][\w-]*)/gi, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// A rule (`---`, `***`, `===`) is a visual divider with nothing to say.
const RULE_LINE_RE = /^\s*([-*_=])\1{2,}\s*$/;

// Punctuation that already gives the engine a pause, so no full stop is added.
const ENDS_SENTENCE_RE = /[.!?:;,…—-]$/;

function speakableLines(value: string): string {
  return value
    .split('\n')
    .filter(line => !RULE_LINE_RE.test(line))
    .join(' ');
}

/** Cut at a sentence, then a word, then wherever — never mid-word. */
export function truncateForSpeech(text: string, limit = MAX_SPEECH_CHARS): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (sentence > limit * 0.5) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  return `${(word > 0 ? head.slice(0, word) : head).trimEnd()}…`;
}

/**
 * Markdown -> the sentence a browser should say.
 *
 * Code blocks and tables are dropped outright rather than transliterated: read
 * aloud, a fenced diff or a pipe table is a minute of noise the listener cannot
 * act on, and it is already on screen a few inches away. A message that is
 * ONLY code therefore returns '' and is not spoken at all — silence plus a
 * visible message beats ninety seconds of punctuation.
 *
 * Deliberately NOT truncated here: the full text is what the caller diffs
 * against what it has already said (see nextSpeechChunk), and truncating first
 * would make a growing message look like a rewritten one.
 */
export function speechTextFromMarkdown(content: unknown): string {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return '';

  const parts: string[] = [];
  for (const block of parseBlocks(raw)) {
    if (block.type === 'code' || block.type === 'table') continue;
    if (block.type === 'list') {
      // A period between items is what gives the engine a beat between them;
      // joined with commas they run together into one breathless sentence.
      parts.push(block.items.map(item => speakableLines(item)).filter(Boolean).join('. '));
      continue;
    }
    parts.push(speakableLines(block.content));
  }

  // Blocks are separated by a full stop so the engine takes a breath between
  // them — but only when the previous block did not end in punctuation of its
  // own, which is what keeps "Results:" from being read as "Results colon dot".
  // Nothing is ever appended to the LAST block: a message that is still
  // streaming must stay a prefix of its finished self, or the "what is left to
  // say" diff in nextSpeechChunk sees a rewrite and drops the tail.
  let joined = '';
  for (const part of parts.map(part => part.trim()).filter(Boolean)) {
    if (!joined) joined = part;
    else joined += ENDS_SENTENCE_RE.test(joined) ? ` ${part}` : `. ${part}`;
  }
  if (!joined) return '';
  // stripHtml runs AFTER the block split so raw `<` inside a fence can never
  // reach the parser — the fence is already gone.
  return stripInlineMarkdown(stripHtml(joined)).replace(/\s*\.\s*\./g, '.').trim();
}

/**
 * Should this row be read aloud in a huddle?
 *
 * Agent messages only. Not the human's own transcript coming back from the
 * database (it was said out loud a second ago), not tool-step chips, not the
 * "Thinking 0s" / "reading src/App.tsx" activity placeholders the daemon
 * updates in place several times a second, and not a row whose speakable text
 * is empty once code and tables are removed.
 */
export function isSpeakableAgentMessage(message: VoiceMessage | null | undefined): boolean {
  if (!message) return false;
  if (message.sender_kind !== 'agent') return false;
  if (message.message_kind === 'tool_step') return false;
  if (message.deleted_at) return false;
  if (isActivityPlaceholderMessage(message)) return false;
  return speechTextFromMarkdown(message.content).length > 0;
}

/**
 * The speech item for a message, or null if it should not be spoken.
 *
 * `joinedAtMs` is the moment this browser entered the huddle: anything written
 * before it is backlog, and reading a channel's history aloud on join is the
 * single most obnoxious thing a voice feature can do. A row with no parseable
 * timestamp is treated as backlog (fail quiet).
 */
export function speechItemFor(
  message: VoiceMessage | null | undefined,
  joinedAtMs: number,
): SpeechItem | null {
  if (!message?.id) return null;
  if (!isSpeakableAgentMessage(message)) return null;
  const created = Date.parse(String(message.created_at ?? ''));
  if (!Number.isFinite(created) || created < joinedAtMs) return null;
  const text = speechTextFromMarkdown(message.content);
  if (!text) return null;
  return {
    id: String(message.id),
    text,
    speaker: String(message.sender_name || 'Agent').trim() || 'Agent',
    agentId: String(message.sender_id || ''),
  };
}

/**
 * What is left to say for a message, given what has already been said for it.
 *
 * An agent message is written once and then UPDATEd as its text streams in, so
 * "the row changed" can mean either "there is more" or "it was rewritten":
 *
 *   - nothing said yet          -> say all of it,
 *   - the text GREW (a prefix)  -> say only the new tail, so a reply whose
 *                                  stream paused mid-way still finishes,
 *   - the text CHANGED          -> say nothing. Re-reading a whole paragraph
 *                                  the listener already heard is worse than
 *                                  dropping the tail of a rare rewrite.
 */
export function nextSpeechChunk(fullText: string, alreadySpoken: string): string {
  const full = String(fullText || '');
  const spoken = String(alreadySpoken || '');
  if (!full) return '';
  if (!spoken) return truncateForSpeech(full);
  if (!full.startsWith(spoken)) return '';
  const tail = full.slice(spoken.length).trim();
  return tail ? truncateForSpeech(tail) : '';
}

/**
 * A recognised utterance, ready to post as a chat message — or '' for anything
 * that is only whitespace. SpeechRecognition emits a leading space on nearly
 * every continuous result, and empty finals are routine when a mic clips.
 */
export function normalizeTranscript(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

// How much of a live interim transcript the caption row shows.
export const CAPTION_CHARS = 140;

/**
 * The TAIL of a live transcript, for a one-line caption.
 *
 * Truncating the end (what `truncate` does in CSS) would hide the words being
 * said right now and freeze the caption on the beginning of the sentence —
 * exactly backwards for the thing whose job is "can you see you are being
 * heard, and did it mishear you".
 */
export function trailingCaption(text: string, limit = CAPTION_CHARS): string {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `…${value.slice(value.length - limit)}`;
}

/**
 * The timestamp until which recognised speech must be discarded as our own
 * echo — Infinity while the browser is talking, and a short tail afterwards for
 * the words already in the recogniser's buffer.
 *
 * Without this, a laptop with speakers hears the agent, transcribes it, posts
 * it, and the agent answers itself forever. Headphones make the problem vanish,
 * which is exactly why it must not be left to chance.
 */
export function echoGuardUntil(speaking: boolean, nowMs: number, tailMs = ECHO_TAIL_MS): number {
  return speaking ? Number.POSITIVE_INFINITY : nowMs + tailMs;
}

/**
 * Pick the best available voice rather than whatever speechSynthesis defaults to.
 *
 * This matters more than it sounds: the default is usually a low-quality legacy
 * system voice, while Edge and Chrome both expose Microsoft's free neural voices
 * ("Microsoft Ava Online (Natural) - English (United States)"). Same API, no key,
 * dramatically better output — but only if you ask for it by name.
 *
 * Ranked: Natural/Online neural first, then any remote (server-rendered) voice,
 * then a local voice in the right language. Returns null when nothing matches, in
 * which case the caller should leave `utterance.voice` unset and let the platform
 * choose — that is still better than forcing a worse voice than the default.
 *
 * INTERIM. Huddle playback still goes through the browser here, but agent
 * voices are moving to Cartesia (`sonic-3.5`), where a voice id means the same
 * thing on every machine and this scoring is unnecessary. Verified in Chrome:
 * 204 voices, zero Microsoft Natural — those exist only inside Edge, so this
 * path was never going to give two people the same voice anyway. It stays until
 * the Cartesia playback pipeline lands, because deleting it first would leave
 * huddles silent. Which agent is speaking is on SpeechItem.agentId, and its
 * chosen voice is on identity.voice.cartesia_voice_id (src/lib/agentVoice.ts).
 */
export function pickSpeechVoice(
  voices: SpeechSynthesisVoice[],
  lang = 'en',
): SpeechSynthesisVoice | null {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const wanted = lang.toLowerCase().slice(0, 2);
  const langMatch = (v: SpeechSynthesisVoice) => (v.lang || '').toLowerCase().startsWith(wanted);
  const candidates = voices.filter(langMatch);
  const pool = candidates.length > 0 ? candidates : voices;

  const score = (v: SpeechSynthesisVoice) => {
    const name = (v.name || '').toLowerCase();
    // Edge/Chrome neural voices announce themselves in the name; there is no
    // structured flag for quality on SpeechSynthesisVoice.
    if (name.includes('natural')) return 4;
    if (name.includes('online')) return 3;
    if (name.includes('neural')) return 3;
    if (!v.localService) return 2; // remote = server-rendered, generally better
    return 1;
  };

  let best: SpeechSynthesisVoice | null = null;
  let bestScore = 0;
  for (const voice of pool) {
    const s = score(voice);
    if (s > bestScore) { best = voice; bestScore = s; }
  }
  // Nothing above a plain local voice is not worth overriding the default for.
  return bestScore > 1 ? best : null;
}
