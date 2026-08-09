import { assignAgentVoices, readAgentVoice, type VoiceAgent } from './agentVoice';
import { agentAccentColor, agentHandle } from './agentAccent';
import type { ChannelParticipant, WorkspaceAgent } from '../types';

// The pure half of "who is my voice talking to in this huddle".
//
// A DM has exactly one agent and a plain message wakes it. A CHANNEL does not:
// a message with no @mention wakes nobody (bar the auto-interject gate), so
// talking into a channel huddle produced silence. The fix is an ACTIVE AGENT —
// one of the channel's agents at a time — whose handle is prefixed onto the
// transcript so the ordinary mention path dispatches it.
//
// Everything here is strings in, values out. The switching decisions that
// matter (which agent a spoken name means, whether a keystroke is ours) are
// testable without a microphone, a keyboard or a channel.

/** One switchable agent in the huddle strip. */
export interface HuddleAgentOption {
  /** Stable identity for React keys and the "who is active" comparison. */
  id: string;
  name: string;
  /** The slug an @mention must use for the server to dispatch this agent. */
  handle: string;
  /** Raw avatar value (spritesheet path, image URL, short text, or ''). */
  avatar: string;
  /** Hex accent, the same one this agent wears everywhere else in the app. */
  accent: string;
  /**
   * The agent's chosen Cartesia voice, or '' when it has none stored.
   *
   * Carried on the option because the huddle speaks as whichever agent is
   * ACTIVE, and that changes mid-call — looking the voice up separately at
   * speak time means the strip and the voice can disagree about who is
   * talking. '' means "no voice decided"; the caller derives a default, it
   * must never be sent to Cartesia as a voice id.
   */
  voiceId: string;
}

function lookupKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

function isVoiceCapableAgent(agent: WorkspaceAgent | null): boolean {
  if (!agent || agent.enabled === false) return false;
  const mode = String(agent.run_mode || '').trim();
  return !mode || mode === 'builtin' || mode === 'daemon';
}

// Mirrors the composer's participant<->agent matcher (agentMatchesLookupKey in
// ChatWindowContent). Kept local so this module stays pure and importable from
// a test without dragging a 3,000-line component in behind it.
function resolveAgent(participant: ChannelParticipant, agents: WorkspaceAgent[]): WorkspaceAgent | null {
  const keys = new Set(
    [
      participant.agent_id,
      participant.id,
      String(participant.id || '').replace(/^agent:/, ''),
      participant.handle,
      participant.name,
    ]
      .map(lookupKey)
      .filter(Boolean),
  );
  if (keys.size === 0) return null;
  return (
    agents.find(agent =>
      [agent.id, agent.handle, agent.name, agentHandle(agent)]
        .map(lookupKey)
        .some(key => Boolean(key) && keys.has(key)),
    ) || null
  );
}

/**
 * The channel's agents, in roster order, ready to render and to @mention.
 *
 * Driven by the persisted participant list rather than the workspace's agent
 * catalogue: the strip has to offer the people who are actually IN this
 * channel, and an agent that is not a participant would be silently added to
 * the roster by the server the first time you spoke to it.
 *
 * A participant that no longer resolves to a workspace agent is omitted: the
 * voice worker cannot be dispatched for an unknown runtime, and offering it
 * would publish a target that makes every worker go silent.
 */
export function huddleAgentOptions(
  agents: WorkspaceAgent[],
  participants: ChannelParticipant[],
  voiceIds: string[] = [],
): HuddleAgentOption[] {
  const list = Array.isArray(participants) ? participants : [];
  const pool = Array.isArray(agents) ? agents : [];
  const out: HuddleAgentOption[] = [];
  // Parallel to `out`, same id per entry: what assignAgentVoices resolves over
  // to hand every agent a DISTINCT voice below. A chosen voice rides along as
  // identity.voice so it is honoured and never reassigned.
  const voiceAgents: VoiceAgent[] = [];
  const seen = new Set<string>();

  for (const participant of list) {
    if (!participant || participant.kind !== 'agent') continue;
    const agent = resolveAgent(participant, pool);
    if (!isVoiceCapableAgent(agent) || ['external', 'sandbox'].includes(String((participant as ChannelParticipant & { run_mode?: string }).run_mode || '').trim())) continue;
    const rawHandle = agent?.handle || participant.handle || '';
    const rawName = agent?.name || participant.name || '';
    // agentHandle() falls back to the literal 'agent' for an empty input, which
    // would mention whichever agent happens to be slugged 'agent'.
    if (!String(rawHandle).trim() && !String(rawName).trim()) continue;
    const handle = agentHandle({ handle: rawHandle, name: rawName });
    const id = String(agent?.id || participant.agent_id || participant.id || handle);
    if (seen.has(id)) continue;
    seen.add(id);
    // Read from the resolved AGENT row, never the participant: participant rows
    // are denormalised snapshots taken when someone joined a channel and do not
    // carry identity, so a voice chosen afterwards would never appear.
    const chosen = readAgentVoice(agent).cartesia_voice_id || '';
    out.push({
      id,
      name: String(rawName || handle),
      handle,
      avatar: String(agent?.avatar || ''),
      accent: agent
        ? agentAccentColor(agent)
        : agentAccentColor({ id, name: rawName, handle, accent_color: null }),
      voiceId: chosen,
    });
    voiceAgents.push(chosen ? { id, identity: { voice: { cartesia_voice_id: chosen } } } : { id });
  }

  // Fill each UNCONFIGURED agent a distinct default voice rather than leaving it
  // '' — which the speaker collapses onto one shared workspace default, so two
  // agents in a call come out sounding identical. Only once the catalogue has
  // loaded: an empty list means "not fetched yet", where '' still degrades to
  // the old shared-default behaviour instead of guessing a voice. A chosen voice
  // is kept as-is; only derived defaults step aside to avoid collisions.
  if (voiceIds.length > 0) {
    const assigned = assignAgentVoices(voiceAgents, voiceIds);
    for (const option of out) {
      option.voiceId = assigned.get(option.id)?.voiceId || option.voiceId;
    }
  }

  return out;
}

/**
 * Whether two rosters say the same thing, field by field.
 *
 * huddleAgentOptions() rebuilds its array on every render of the channel, so a
 * reference check would report a change constantly. The dock keeps the roster
 * on its target, and a new target object re-renders the whole call — including
 * the speech hooks, whose effects tear a microphone down and back up. Comparing
 * the values is what makes "the channel re-rendered" and "the roster changed"
 * two different things.
 */
export function sameHuddleAgents(
  a: readonly HuddleAgentOption[],
  b: readonly HuddleAgentOption[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((agent, index) => {
    const other = b[index];
    return !!other
      && agent.id === other.id
      && agent.name === other.name
      && agent.handle === other.handle
      && agent.avatar === other.avatar
      && agent.accent === other.accent
      && agent.voiceId === other.voiceId;
  });
}

// ---------------------------------------------------------------------------
// "Coder, what's the status" -> switch to Coder, say "what's the status"
// ---------------------------------------------------------------------------

// How many leading words a name is allowed to span. Four covers "code review
// bot" and stops the parser from chewing through a whole sentence looking for
// an agent that was never named.
const MAX_NAME_TOKENS = 4;

// A token ending in punctuation is where the speaker stopped saying the name.
// "Coder, what's up" must not be read as an agent literally called "coder what".
const NAME_BOUNDARY_RE = /[,.:;!?—–-]$/;

// Leading punctuation between the name and the sentence, plus the space after
// it: "Coder, — what's up" -> "what's up".
const REMAINDER_LEAD_RE = /^[\s,.:;!?—–-]+/;

// A one-character alias would switch agents on "I", "a" or "the". Speech
// recognition emits those constantly; a one-letter agent name does not exist.
const MIN_ALIAS_CHARS = 2;

/** Everything except letters and digits, lowercased. Speech has no spelling. */
function speechToken(raw: string): string {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface TokenSpan {
  raw: string;
  /** Index in the original string just past this token. */
  end: number;
}

function tokenSpans(value: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    spans.push({ raw: match[0], end: match.index + match[0].length });
  }
  return spans;
}

function aliasesFor(agent: HuddleAgentOption): string[] {
  return [speechToken(agent.name), speechToken(agent.handle)].filter(
    alias => alias.length >= MIN_ALIAS_CHARS,
  );
}

export interface LeadingAgentMatch {
  agent: HuddleAgentOption;
  /** The utterance with the name removed. '' when they said only the name. */
  remainder: string;
}

/**
 * The agent named at the START of an utterance, and what is left to say.
 *
 * Deliberately forgiving in every direction speech-to-text is unreliable —
 * case, punctuation, and whether a two-word name arrives as one token or two
 * ("code reviewer" and "codereviewer" both match a @code-reviewer). Deliberately
 * strict in the two directions where a wrong guess is worse than no guess:
 *
 *   - the name must be at the START. An agent mentioned mid-sentence ("ask
 *     coder about it") is being talked ABOUT, not talked TO.
 *   - if the leading words match two different agents, nothing switches.
 *     Sending your sentence to the wrong agent is silent and confusing; not
 *     switching is visible in the strip.
 *
 * The LONGEST match wins, so "Code Reviewer" beats a "Code" that also exists.
 */
export function matchLeadingAgentName(
  text: string,
  agents: HuddleAgentOption[],
): LeadingAgentMatch | null {
  const value = String(text || '').trim();
  const pool = Array.isArray(agents) ? agents : [];
  if (!value || pool.length === 0) return null;

  const spans = tokenSpans(value);
  if (spans.length === 0) return null;

  let limit = Math.min(MAX_NAME_TOKENS, spans.length);
  for (let i = 0; i < limit; i += 1) {
    if (NAME_BOUNDARY_RE.test(spans[i].raw)) {
      limit = i + 1;
      break;
    }
  }

  for (let count = limit; count >= 1; count -= 1) {
    const spoken = spans.slice(0, count).map(span => speechToken(span.raw)).join('');
    if (spoken.length < MIN_ALIAS_CHARS) continue;
    const hits: HuddleAgentOption[] = [];
    for (const agent of pool) {
      if (hits.some(hit => hit.id === agent.id)) continue;
      if (aliasesFor(agent).includes(spoken)) hits.push(agent);
    }
    if (hits.length === 0) continue;
    if (hits.length > 1) return null; // ambiguous — never guess
    const remainder = value.slice(spans[count - 1].end).replace(REMAINDER_LEAD_RE, '').trim();
    return { agent: hits[0], remainder };
  }

  return null;
}

/**
 * The utterance as a message that will actually wake `handle`.
 *
 * A channel dispatches on @mention (pickMentionNextAgent, server/index.cjs), so
 * the transcript is posted with the active agent's handle in front of it — the
 * same content a human would have typed. There is no second dispatch route.
 * An utterance that already opens with that mention is left alone.
 */
export function withAgentMention(text: string, handle: string): string {
  const body = String(text || '').trim();
  if (!body) return '';
  const slug = String(handle || '').trim().replace(/^@+/, '');
  if (!slug) return body;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  // Matches the server's own mention regex, so "already mentioned" here means
  // the same thing it means there.
  if (new RegExp(`(^|\\s)@${escaped}\\b`, 'i').test(body)) return body;
  return `@${slug} ${body}`;
}

// ---------------------------------------------------------------------------
// Cmd/Ctrl + 1…9
// ---------------------------------------------------------------------------

/** The subset of a KeyboardEvent the shortcut decision reads. */
export interface ShortcutKeyEvent {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * The 0-based agent this keystroke selects, or null for "not ours".
 *
 * Meta on macOS, Ctrl everywhere else — testing both is how one binding covers
 * both without sniffing the platform. Alt is excluded because Cmd/Ctrl+Alt+n is
 * a different chord that belongs to the browser.
 *
 * `code` is read first so the binding survives layouts where the digit row is
 * shifted (AZERTY); `key` is the fallback for anything that does not set it.
 */
export function huddleShortcutIndex(event: ShortcutKeyEvent | null | undefined): number | null {
  if (!event) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.altKey) return null;
  const fromCode = /^Digit([1-9])$/.exec(String(event.code || ''));
  const digit = fromCode ? fromCode[1] : String(event.key || '');
  if (!/^[1-9]$/.test(digit)) return null;
  return Number(digit) - 1;
}

/**
 * Is this event target somewhere the human is typing?
 *
 * A window-level shortcut that fires while someone is writing a message would
 * eat Cmd+1 out of the composer. Takes an unknown so the caller can hand it
 * `event.target` without casting.
 */
export function isTextEntryTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const node = target as { tagName?: unknown; isContentEditable?: unknown };
  if (node.isContentEditable === true) return true;
  const tag = String(node.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
