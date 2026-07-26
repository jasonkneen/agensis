// How an agent SOUNDS. Pure — no React, no DOM, no network.
//
// Speech is Cartesia (`sonic-3.5`), not the browser's speechSynthesis, and that
// makes this much simpler than it would otherwise be. A Cartesia voice id is a
// SERVER-SIDE identifier: `f9fc912e-…` means the same voice for every user in
// every browser, so it can be stored as-is. There is no "resolve a portable
// preference against whatever this device happens to have" — the reason that
// would have been necessary (getVoices() returning a different list per OS,
// browser and install; Chrome shipping none of Edge's Natural voices) simply
// does not apply to a hosted TTS API.
//
// What is left is the part that still needs care:
//
//   1. TWO AGENTS MUST SOUND DIFFERENT WITH NOBODY CONFIGURING ANYTHING. A fresh
//      workspace has several agents and no voice settings; if they all default
//      to one voice, a channel huddle is unlistenable. Defaults are derived from
//      the agent id, and assignment is coordinated across the roster so a hash
//      collision cannot put two agents on the same voice.
//
//   2. THE CATALOGUE IS NOT ORDERED. Cartesia's /voices endpoint paginates by
//      cursor and promises no ordering, so anything deriving a default from "the
//      Nth English voice" has to sort first, or an agent's voice changes on a
//      whim.
//
// This module does NOT fetch from Cartesia, stream, or play audio — that
// pipeline is owned elsewhere. It answers one question: which voice, at what
// speed and emotion, does this agent have?

/** A voice as Cartesia's `GET /voices` returns it, trimmed to what we use. */
export interface CartesiaVoice {
  id: string;
  name: string;
  description?: string | null;
  gender?: string | null;
  /** ISO 639-1, or a language-locale pair like `en-GB`. */
  language?: string | null;
  country?: string | null;
  is_pro?: boolean;
}

/**
 * What is STORED for an agent. Every field optional; absent means "nobody chose
 * one", which is NOT the same as "chose the default" — the precedence rule on
 * the server turns on exactly that distinction.
 */
export interface AgentVoicePreference {
  /** A Cartesia voice id. Absent = use the deterministic default for this agent. */
  cartesia_voice_id?: string;
  /** Cartesia `generation_config.speed`, 0.6–1.5. */
  speed?: number;
  /** Cartesia `generation_config.emotion`. */
  emotion?: string;
}

/** Everything the TTS pipeline needs in order to speak as this agent. */
export interface ResolvedAgentVoice {
  /** A Cartesia voice id, or '' when the catalogue has not loaded yet. */
  voiceId: string;
  speed: number;
  emotion: string;
  /** True when nobody picked this — it was derived from the agent's id. */
  isDefault: boolean;
}

/** The subset of an agent row this module reads. */
export interface VoiceAgent {
  id: string;
  identity?: { voice?: unknown } | null;
}

/** The Cartesia model these settings are written against. */
export const CARTESIA_MODEL_ID = 'sonic-3.5';

// Cartesia documents generation_config.speed as 0.6–1.5. The older top-level
// `speed: "slow" | "normal" | "fast"` field is deprecated; this is its numeric
// replacement, and values outside the range are rejected by the API.
export const MIN_SPEED = 0.6;
export const MAX_SPEED = 1.5;
export const DEFAULT_SPEED = 1;
export const DEFAULT_EMOTION = 'neutral';

/**
 * "Attitude", as the API actually models it.
 *
 * The persona half — terse, sardonic, patient — changes the WORDS, and `soul`
 * is already the prompt-injected field for that. The delivery half is
 * `generation_config.emotion`, a real Cartesia control rather than something
 * approximated with pitch. Sonic treats it as guidance, not a strict setting.
 *
 * The six Cartesia calls "primary" lead the list. Values are sent verbatim, so
 * this must stay a subset of what the API accepts — the server validates
 * against its own copy in shared/agentIdentity.cjs, and the two are pinned
 * together by a test.
 */
export const PRIMARY_EMOTIONS: string[] = ['neutral', 'calm', 'angry', 'content', 'sad', 'scared'];

export const VOICE_EMOTIONS: string[] = [
  ...PRIMARY_EMOTIONS,
  'happy', 'excited', 'enthusiastic', 'elated', 'euphoric', 'triumphant', 'amazed',
  'surprised', 'flirtatious', 'curious', 'peaceful', 'serene', 'grateful',
  'affectionate', 'trust', 'sympathetic', 'anticipation', 'mysterious', 'mad',
  'outraged', 'frustrated', 'agitated', 'threatened', 'disgusted', 'contempt',
  'envious', 'sarcastic', 'ironic', 'dejected', 'melancholic', 'disappointed',
  'hurt', 'guilty', 'bored', 'tired', 'rejected', 'nostalgic', 'wistful',
  'apologetic', 'hesitant', 'insecure', 'confused', 'resigned', 'anxious',
  'panicked', 'alarmed', 'proud', 'confident', 'distant', 'skeptical',
  'contemplative', 'determined',
];

const EMOTION_SET = new Set(VOICE_EMOTIONS);

// A Cartesia voice id is a UUID for stock voices, but a cloned or org-owned one
// need not be, so this is deliberately permissive about SHAPE while still
// rejecting anything containing a space, a bracket or prose — i.e. a browser
// voice name, or a description pasted into the wrong field.
const VOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function isCartesiaVoiceId(value: unknown): boolean {
  return typeof value === 'string' && VOICE_ID_RE.test(value.trim());
}

/**
 * FNV-1a over a string -> a non-negative 32-bit integer.
 *
 * Any stable hash would do; what matters is that it is DETERMINISTIC. An
 * agent's default voice must not change because React re-rendered, because the
 * page reloaded, or because someone opened the app on a different machine.
 */
export function voiceSeed(value: string): number {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // The FNV prime as shifts, because `hash * 16777619` overflows a double
    // into imprecision.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read a stored preference out of whatever jsonb came back.
 *
 * Tolerant and SPARSE: a field that is missing, null, the wrong type or out of
 * range comes back absent rather than defaulted. Mirrors normalizeVoicePreference
 * in shared/agentIdentity.cjs, which is the VALIDATING copy — this one only has
 * to survive bad data, not defend against it.
 */
export function normalizeVoicePreference(raw: unknown): AgentVoicePreference {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: AgentVoicePreference = {};

  const id = typeof source.cartesia_voice_id === 'string' ? source.cartesia_voice_id.trim() : '';
  if (isCartesiaVoiceId(id)) out.cartesia_voice_id = id;

  const speed = typeof source.speed === 'number' ? source.speed : Number(source.speed);
  if (Number.isFinite(speed)) out.speed = clamp(speed, MIN_SPEED, MAX_SPEED);

  const emotion = typeof source.emotion === 'string' ? source.emotion.trim().toLowerCase() : '';
  if (EMOTION_SET.has(emotion)) out.emotion = emotion;

  return out;
}

/** The stored preference for an agent row, or `{}` when it has none. */
export function readAgentVoice(agent: VoiceAgent | null | undefined): AgentVoicePreference {
  return normalizeVoicePreference(agent?.identity?.voice);
}

/**
 * The English voices from a catalogue, in a STABLE order.
 *
 * Sorted by id — not by name, and not in the order Cartesia returned them.
 * `/voices` paginates with a cursor and promises no ordering, and names are not
 * unique. Sorting by the immutable id is what stops an agent's derived default
 * from moving when a page of results comes back in a different order.
 */
export function englishVoiceIds(catalogue: CartesiaVoice[]): string[] {
  return (Array.isArray(catalogue) ? catalogue : [])
    .filter(voice => voice && typeof voice.id === 'string'
      && String(voice.language || '').toLowerCase().startsWith('en'))
    .map(voice => voice.id)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The voice an agent gets when nobody has chosen one — derived from its id, so
 * a fresh workspace already has agents that sound different from each other.
 *
 * Returns '' when the catalogue is empty (not loaded yet, or the API is down).
 * The caller must treat that as "no voice decided", never as a voice.
 */
export function defaultVoiceIdFor(agentId: string, voiceIds: string[]): string {
  if (!Array.isArray(voiceIds) || voiceIds.length === 0) return '';
  return voiceIds[voiceSeed(String(agentId || '')) % voiceIds.length];
}

/**
 * Resolve ONE agent in isolation — for the preview button, and for a pipeline
 * speaking a single reply with no roster to hand.
 */
export function resolveAgentVoice(
  agent: VoiceAgent | null | undefined,
  voiceIds: string[],
): ResolvedAgentVoice {
  const preference = readAgentVoice(agent);
  const chosen = preference.cartesia_voice_id || '';
  return {
    voiceId: chosen || defaultVoiceIdFor(agent?.id || '', voiceIds),
    speed: preference.speed ?? DEFAULT_SPEED,
    emotion: preference.emotion ?? DEFAULT_EMOTION,
    isDefault: !chosen,
  };
}

/**
 * Resolve a WHOLE ROSTER, guaranteeing the defaults do not collide.
 *
 * With 418 English voices a hash collision between two agents is rare, but rare
 * is not never, and the one place it surfaces is the one place it matters: a
 * channel huddle where two agents suddenly cannot be told apart. So an agent
 * whose derived default is already taken probes forward for a free one.
 *
 * A CHOSEN voice is never moved. If two people deliberately pick the same voice
 * for two agents, that is their call, and quietly reassigning one would be the
 * app overruling an explicit decision. Only derived defaults step aside — and
 * they step aside around chosen voices too, which is why every explicit pick is
 * reserved before any default is derived.
 *
 * Iteration is by agent id, not roster order, so who gets first pick does not
 * change when someone joins or leaves a channel mid-call.
 */
export function assignAgentVoices(
  agents: VoiceAgent[],
  voiceIds: string[],
): Map<string, ResolvedAgentVoice> {
  const out = new Map<string, ResolvedAgentVoice>();
  const list = (Array.isArray(agents) ? agents : []).filter(agent => agent && agent.id);
  if (list.length === 0) return out;

  const catalogue = Array.isArray(voiceIds) ? voiceIds : [];
  const ordered = [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const taken = new Set<string>();
  for (const agent of ordered) {
    const chosen = readAgentVoice(agent).cartesia_voice_id;
    if (chosen) taken.add(chosen);
  }

  for (const agent of ordered) {
    const preference = readAgentVoice(agent);
    const chosen = preference.cartesia_voice_id || '';
    let voiceId = chosen;

    if (!voiceId && catalogue.length > 0) {
      const preferred = voiceSeed(agent.id) % catalogue.length;
      for (let step = 0; step < catalogue.length; step += 1) {
        const candidate = catalogue[(preferred + step) % catalogue.length];
        if (taken.has(candidate)) continue;
        voiceId = candidate;
        break;
      }
      // Fewer voices than agents — impossible against Cartesia's real
      // catalogue, but a filtered or partly-failed fetch could produce it.
      // Fall back to the derived slot rather than leaving an agent voiceless.
      if (!voiceId) voiceId = catalogue[preferred];
      taken.add(voiceId);
    }

    out.set(agent.id, {
      voiceId,
      speed: preference.speed ?? DEFAULT_SPEED,
      emotion: preference.emotion ?? DEFAULT_EMOTION,
      isDefault: !chosen,
    });
  }

  return out;
}

// The preview LINE deliberately does not live here. /tts/bytes bills per
// character, so the transcript is a server-side constant the preview route
// supplies itself — if the browser could choose the text, an authenticated
// button would be a metered text-to-speech endpoint. See CARTESIA_PREVIEW_TEXT
// in server/index.cjs.

/** "Brooke — feminine, en-GB", for a picker row. Falls back to the bare name. */
export function describeVoice(voice: CartesiaVoice | null | undefined): string {
  if (!voice) return '';
  const details = [voice.gender, voice.language].map(part => String(part || '').trim()).filter(Boolean);
  return details.length > 0 ? `${voice.name} — ${details.join(', ')}` : voice.name;
}

/** Case-insensitive filter over name / description / language, for the picker. */
export function filterVoices(catalogue: CartesiaVoice[], query: string): CartesiaVoice[] {
  const list = Array.isArray(catalogue) ? catalogue : [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return list;
  return list.filter(voice => [voice.name, voice.description, voice.language, voice.gender, voice.country]
    .some(field => String(field || '').toLowerCase().includes(needle)));
}
