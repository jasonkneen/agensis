'use strict';

// Who an agent SAYS it is, and who gets the last word.
//
// An agent declares an identity — avatar, name, profile, how it sounds — every
// single time it connects. That happens on every daemon restart, every MCP
// reconnect, potentially several times an hour. So the interesting question is
// not "how do we store it" but "what happens when the stored value and the
// declared value disagree", and there is exactly one answer that is not a
// data-loss bug:
//
//   A HUMAN'S EXPLICIT CHOICE BEATS THE AGENT'S SELF-DECLARATION.
//   The agent's values are a DEFAULT for fields no human has ever set.
//
// Without that, a name or avatar someone picked in the UI is destroyed the next
// time the daemon restarts, and the app looks like it forgot. (Same rule already
// established for the thread widget rail: the automatic behaviour applies only
// until the user expresses a choice.)
//
// Which means an UNSET field and a field set to the same value as the default
// are different things, and the difference has to be RECORDED rather than
// guessed. `identity.human_set` is that record: a map of field name -> true,
// written only by a human's own write, never by an agent's declaration.
//
// Three callers, one code path:
//   - MCP        register_agent           (server/mcp.cjs)
//   - daemon     agent_register WS action (server/index.cjs)
//   - the human  POST /backend/db/update  (both backends)
// The first two go through applyIdentityDeclaration; the third through
// markHumanIdentityWrite. Everything either of them knows about precedence lives
// in this file.

// Identity fields that are real columns on workspace_agents.
const IDENTITY_COLUMNS = ['name', 'avatar', 'accent_color', 'description', 'soul'];
// …plus `voice`, which lives inside the identity jsonb rather than a column.
const IDENTITY_FIELDS = [...IDENTITY_COLUMNS, 'voice'];

// Speech is Cartesia (`sonic-3.5`). A Cartesia voice id is a server-side
// identifier — the same voice for every user in every browser — so it is stored
// verbatim, and `generation_config.speed` / `.emotion` are the real API controls
// rather than anything we approximate ourselves.
const CARTESIA_MODEL_ID = 'sonic-3.5';
const MIN_SPEED = 0.6;
const MAX_SPEED = 1.5;

// "Attitude", in the half of it a voice control can actually change.
//
// A persona — terse, sardonic, patient — changes the WORDS, and `soul` is
// already the prompt-injected field for that (see buildSystemPrompt's
// "Agent soul:" section). DELIVERY is Cartesia's `emotion`, which is a genuine
// model control, so it is stored by name and passed straight through.
//
// This is the VALIDATING copy: an emotion that is not in this set never reaches
// the API. MUST stay identical to VOICE_EMOTIONS in src/lib/agentVoice.ts — the
// frontend cannot import this file (tsconfig only includes `src`), so the two
// copies are pinned together by tests/unit/agentVoice.test.ts, which imports
// both and asserts they match.
const PRIMARY_EMOTIONS = ['neutral', 'calm', 'angry', 'content', 'sad', 'scared'];

const VOICE_EMOTIONS = [
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

// Stock Cartesia voices are UUIDs; a cloned or org-owned voice need not be. So
// this bounds the SHAPE without assuming UUID, while still rejecting anything
// with a space, a bracket or prose in it — a browser voice name, a description
// pasted into the wrong field, or an injection attempt heading for a URL path.
const VOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function clamp(value, min, max) {
 return Math.min(max, Math.max(min, value));
}

function finiteOrNull(value) {
 const num = typeof value === 'number' ? value : Number(value);
 return Number.isFinite(num) ? num : null;
}

/** Parse a jsonb column that may arrive as an object or as a JSON string. */
function asObject(value) {
 if (!value) return {};
 if (typeof value === 'string') {
  try {
   const parsed = JSON.parse(value);
   return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
   return {};
  }
 }
 return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** True when a value is usable as a Cartesia voice id. */
function isCartesiaVoiceId(value) {
 return typeof value === 'string' && VOICE_ID_RE.test(value.trim());
}

/**
 * A declared voice preference, sanitized to exactly what Cartesia accepts.
 *
 * Accepts the aliases an agent would naturally reach for (`voice_id`, `id`,
 * `attitude`) alongside the stored names. Everything is validated rather than
 * trusted: an unknown emotion is DROPPED, not forwarded, because a declaration
 * arrives from a process we do not control and an unrecognised value would come
 * back as a 400 from Cartesia in the middle of a live huddle.
 *
 * Returns a SPARSE object: a field that was not declared stays absent, because
 * "unset" and "set to the default" have to stay distinguishable for the
 * precedence rule to work at all.
 */
function normalizeVoicePreference(raw) {
 const source = asObject(raw);
 const out = {};

 const voiceId = String(source.cartesia_voice_id || source.voice_id || source.id || '').trim();
 if (isCartesiaVoiceId(voiceId)) out.cartesia_voice_id = voiceId;

 const speed = finiteOrNull(source.speed);
 if (speed !== null) out.speed = clamp(speed, MIN_SPEED, MAX_SPEED);

 const emotion = String(source.emotion || source.attitude || '').trim().toLowerCase();
 if (EMOTION_SET.has(emotion)) out.emotion = emotion;

 return out;
}

/** True when two sparse voice preferences would sound the same. */
function sameVoicePreference(a, b) {
 const left = a || {};
 const right = b || {};
 return ['cartesia_voice_id', 'speed', 'emotion'].every((key) => (left[key] ?? null) === (right[key] ?? null));
}

/**
 * THE HANDOFF TO THE TTS PIPELINE. Given an agent row and the English slice of
 * the Cartesia catalogue, say which voice speaks for it and how.
 *
 * `voiceIds` must be in a stable order (sort by id — `/voices` paginates with a
 * cursor and promises no ordering), or an agent's derived default moves between
 * calls. Mirrors resolveAgentVoice in src/lib/agentVoice.ts so the panel
 * previews exactly what the pipeline will speak.
 */
function resolveAgentVoice(agent, voiceIds) {
 const preference = normalizeVoicePreference(asObject(asObject(agent && agent.identity).voice));
 const catalogue = Array.isArray(voiceIds) ? voiceIds : [];
 const chosen = preference.cartesia_voice_id || '';
 const agentId = String((agent && agent.id) || '');
 return {
  voiceId: chosen || (catalogue.length > 0 ? catalogue[voiceSeed(agentId) % catalogue.length] : ''),
  speed: preference.speed != null ? preference.speed : 1,
  emotion: preference.emotion || 'neutral',
  isDefault: !chosen,
  modelId: CARTESIA_MODEL_ID,
 };
}

/**
 * FNV-1a -> a non-negative 32-bit integer. Must produce the same number as
 * voiceSeed in src/lib/agentVoice.ts, or an agent's default voice differs
 * between what the panel shows and what the pipeline speaks. Pinned by a test.
 */
function voiceSeed(value) {
 let hash = 0x811c9dc5;
 const text = String(value || '');
 for (let i = 0; i < text.length; i += 1) {
  hash ^= text.charCodeAt(i);
  hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
 }
 return hash >>> 0;
}

// Column length caps. A declaration arrives over a socket from a process we do
// not control, so every text field is bounded before it reaches the DB.
const FIELD_LIMITS = { name: 80, avatar: 500, accent_color: 32, description: 500, soul: 4000 };
const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/**
 * An identity declaration, sanitized. Unknown keys are dropped, blank values are
 * dropped (clearing a field is a human action, not something a reconnect should
 * do by omission or by sending '').
 */
function normalizeIdentityDeclaration(raw) {
 const source = asObject(raw);
 const out = {};
 for (const field of IDENTITY_COLUMNS) {
  if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
  const value = String(source[field] ?? '').trim();
  if (!value) continue;
  if (field === 'accent_color' && !HEX_COLOR_RE.test(value)) continue;
  out[field] = value.slice(0, FIELD_LIMITS[field]);
 }
 if (Object.prototype.hasOwnProperty.call(source, 'voice')) {
  const voice = normalizeVoicePreference(source.voice);
  if (Object.keys(voice).length > 0) out.voice = voice;
 }
 return out;
}

/** The set of identity fields a human has explicitly chosen for this agent. */
function humanSetFields(identity) {
 const record = asObject(asObject(identity).human_set);
 return new Set(IDENTITY_FIELDS.filter((field) => record[field] === true));
}

/**
 * Fold an agent's self-declaration into what is already stored.
 *
 * @param current  the workspace_agents row (null when the row is being created)
 * @param declared the raw declaration off the wire
 * @param isNew    true only while the row is being created
 *
 * Returns `{ columns, identity, changed }` — `columns` holds only the column
 * values that should actually be written, `identity` the new jsonb value (or
 * null when the voice did not change), and `changed` whether there is anything
 * to write at all. A declaration identical to what is stored writes nothing, so
 * a daemon that reconnects every ten minutes does not produce an UPDATE and a
 * realtime fanout every ten minutes.
 *
 * NAME IS DIFFERENT: it applies only to a brand new agent. The product rule is
 * "select their name (for new ones)", and an agent that can rename itself on
 * every reconnect is a channel roster nobody can rely on. Renaming an existing
 * agent stays a human action.
 */
function applyIdentityDeclaration({ current = null, declared = null, isNew = false } = {}) {
 const declaration = normalizeIdentityDeclaration(declared);
 const row = current || {};
 const identity = asObject(row.identity);
 const locked = humanSetFields(identity);

 const columns = {};
 for (const field of IDENTITY_COLUMNS) {
  if (!Object.prototype.hasOwnProperty.call(declaration, field)) continue;
  if (field === 'name' && !isNew) continue;
  if (locked.has(field)) continue;
  if (String(row[field] ?? '') === declaration[field]) continue;
  columns[field] = declaration[field];
 }

 let nextIdentity = null;
 if (Object.prototype.hasOwnProperty.call(declaration, 'voice') && !locked.has('voice')) {
  if (!sameVoicePreference(asObject(identity.voice), declaration.voice)) {
   nextIdentity = { ...identity, voice: declaration.voice };
  }
 }

 return {
  columns,
  identity: nextIdentity,
  changed: Object.keys(columns).length > 0 || nextIdentity !== null,
 };
}

/**
 * The other half of the rule: record that a HUMAN chose these fields, so the
 * next self-declaration leaves them alone.
 *
 * Called from the generic POST /backend/db/update path — the one chokepoint
 * every human agent edit goes through, whichever dialog it came from. Doing it
 * here rather than in the UI means a field edited from a screen nobody has
 * written yet is still protected.
 *
 * Returns `{ values, voice, lockPatch }`:
 *
 * - `values` — the caller's values with `identity` REMOVED. The identity jsonb
 *   is never written wholesale from a client object: the only key a human may
 *   set through this path is `voice`, so a payload like
 *   `{"identity":{"human_set":{...}}}` (or `{"identity":{}}`) can neither
 *   forge a lock nor erase one — it simply writes nothing.
 * - `voice` — undefined when the update did not touch `identity.voice`;
 *   otherwise the NORMALIZED preference to graft onto the stored column
 *   (`{}` = the human cleared it).
 * - `lockPatch` — null when no identity field was touched; otherwise a
 *   `{field: boolean}` object the caller must merge INTO the stored
 *   `identity.human_set` (see identityWriteSql) rather than over it — a rename
 *   must not un-protect a previously chosen avatar. A field written non-empty
 *   locks (`true`); a field explicitly CLEARED unlocks (`false`) — locking a
 *   field at '' would pin emptiness against the agent's own declaration, and
 *   "clear" reads as "go back to the default".
 */
function markHumanIdentityWrite(table, values) {
 if (table !== 'workspace_agents') return { values, voice: undefined, lockPatch: null };
 if (!values || typeof values !== 'object' || Array.isArray(values)) return { values, voice: undefined, lockPatch: null };
 const lockPatch = {};
 for (const field of IDENTITY_COLUMNS) {
  if (!Object.prototype.hasOwnProperty.call(values, field)) continue;
  lockPatch[field] = String(values[field] ?? '').trim() !== '';
 }
 // The voice is not a column: it is set by writing `identity.voice`, which only
 // the voice editor does. Validated here exactly like a declaration — a human's
 // browser is still a client we do not control.
 let voice;
 const identityTouched = Object.prototype.hasOwnProperty.call(values, 'identity');
 if (identityTouched) {
  const identity = asObject(values.identity);
  if (Object.prototype.hasOwnProperty.call(identity, 'voice')) {
   voice = normalizeVoicePreference(identity.voice);
   lockPatch.voice = Object.keys(voice).length > 0;
  }
 }
 const next = { ...values };
 if (identityTouched) delete next.identity;
 return { values: next, voice, lockPatch: Object.keys(lockPatch).length > 0 ? lockPatch : null };
}

/**
 * The SET fragment for every client-driven `identity` write.
 *
 * The base is ALWAYS the stored column — never a caller's object — with the
 * validated voice grafted in when the update touched it, and `human_set` taken
 * from the STORED row unioned with the lock patch. There is deliberately no
 * spelling of this fragment in which any part of the caller's own `human_set`
 * reaches the row.
 */
function identityWriteSql(voicePlaceholder, patchPlaceholder) {
 const base = voicePlaceholder
  ? `jsonb_set(coalesce("identity", '{}'::jsonb), '{voice}', ${voicePlaceholder})`
  : `coalesce("identity", '{}'::jsonb)`;
 return `jsonb_set(${base}, '{human_set}',`
  + ` coalesce("identity"->'human_set', '{}'::jsonb) || ${patchPlaceholder})`;
}

/**
 * Repair a stored identity written through the era of the double-encoded jsonb
 * bind on the Fly server: a pre-stringified value bound into `$n::jsonb` on
 * postgres.js is JSON-serialized AGAIN and lands as a jsonb STRING SCALAR.
 * From there `human_set || patch` degrades to ARRAY concatenation (one
 * corrupted append per human edit) and `jsonb_set` errors outright — both
 * confirmed against live rows.
 *
 * Collapses either corruption back to the canonical object: a whole-value
 * scalar is parsed; a human_set array is folded left-to-right (string elements
 * parsed, later entries winning); only genuine `field: true` locks on known
 * fields survive; the voice is re-validated. Returns null when the stored
 * value is already canonical — the caller writes nothing for those.
 */
function repairStoredIdentity(raw) {
 const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
 if (isPlainObject(raw)
  && (!('human_set' in raw) || isPlainObject(raw.human_set))
  && (!('voice' in raw) || isPlainObject(raw.voice))) {
  return null;
 }
 const identity = asObject(raw);
 const out = {};
 const voice = normalizeVoicePreference(identity.voice);
 if (Object.keys(voice).length > 0) out.voice = voice;

 const entries = [];
 const collect = (candidate) => {
  if (typeof candidate === 'string') {
   try {
    collect(JSON.parse(candidate));
   } catch {
    // an unparseable fragment carries no recoverable lock — drop it
   }
   return;
  }
  if (isPlainObject(candidate)) entries.push(candidate);
 };
 if (Array.isArray(identity.human_set)) identity.human_set.forEach(collect);
 else collect(identity.human_set);
 const merged = Object.assign({}, ...entries);
 const humanSet = {};
 for (const field of IDENTITY_FIELDS) {
  if (merged[field] === true) humanSet[field] = true;
 }
 if (Object.keys(humanSet).length > 0) out.human_set = humanSet;
 return out;
}

/**
 * The INSERT half: a row a human creates through the generic /backend/db/insert
 * path carries their creation-time choices, which must survive the agent's
 * FIRST connect just as they survive every later one. Synthesizes
 * `identity.human_set` server-side from what was actually provided — non-empty
 * fields lock, empty ones stay open for the agent's declaration to fill — and
 * rebuilds `identity` from scratch, so a client-supplied `human_set` (or any
 * other junk key) never reaches the row. Only a validated `voice` survives.
 */
function synthesizeHumanIdentityInsert(table, row) {
 if (table !== 'workspace_agents') return row;
 if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
 const humanSet = {};
 for (const field of IDENTITY_COLUMNS) {
  if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
  if (String(row[field] ?? '').trim() !== '') humanSet[field] = true;
 }
 const identity = {};
 const supplied = asObject(row.identity);
 if (Object.prototype.hasOwnProperty.call(supplied, 'voice')) {
  const voice = normalizeVoicePreference(supplied.voice);
  if (Object.keys(voice).length > 0) {
   identity.voice = voice;
   humanSet.voice = true;
  }
 }
 if (Object.keys(humanSet).length > 0) identity.human_set = humanSet;
 return { ...row, identity };
}

module.exports = {
 IDENTITY_COLUMNS,
 IDENTITY_FIELDS,
 CARTESIA_MODEL_ID,
 PRIMARY_EMOTIONS,
 VOICE_EMOTIONS,
 MIN_SPEED,
 MAX_SPEED,
 isCartesiaVoiceId,
 voiceSeed,
 resolveAgentVoice,
 normalizeVoicePreference,
 normalizeIdentityDeclaration,
 sameVoicePreference,
 humanSetFields,
 applyIdentityDeclaration,
 markHumanIdentityWrite,
 identityWriteSql,
 synthesizeHumanIdentityInsert,
 repairStoredIdentity,
 FIELD_LIMITS,
};
