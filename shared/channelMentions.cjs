'use strict';

// ---------------------------------------------------------------------------
// CHANNEL MENTIONS — who a message is addressed to, and who is compelled to
// answer it.
//
// Two decisions live here, both of which the browser and the server must agree
// on exactly, and both of which used to be a bare regex copied into four files:
//
//   1. WHICH handles a message mentions, including the reserved handle
//      `@channel` — one mention that addresses every agent participant of the
//      channel it was posted in.
//   2. WHETHER an un-addressed post compels an immediate reply at all
//      (chat_sessions.conversation_mode).
//
// `@channel` IS RESERVED. `isReservedAgentHandle` is the door: an agent may not
// take the handle `channel`, the same way the system-owner address is refused
// at signup (isReservedSignupEmail in shared/tenant-admin.cjs). That check is
// belt; the braces are that `@channel` is resolved BEFORE any handle lookup, so
// a row that predates the check — or one written straight into the database —
// still cannot capture the mention.
//
// WHO `@channel` REACHES is the STORED roster of the session, never workspace
// presence. Presence once leaked into channel membership and every agent online
// anywhere appeared in every channel (see buildChannelRoster in
// src/lib/sessionParticipants.ts). A mention that dispatches paid model turns
// must not be able to resurrect that: expandChannelMention takes the
// participant list and nothing else.
//
// SHARED between backends deliberately. src/lib/channelMentions.ts is the
// browser's copy — shared/*.cjs is CommonJS server code and nothing under src/
// may pull it into the bundle — and PARITY_INPUTS below is run by BOTH test
// runners so the two cannot drift. A composer that disagrees with the
// dispatcher about who a message addresses is a silent no-reply.
// ---------------------------------------------------------------------------

/**
 * The mention pattern, as source so both copies are literally the same string.
 *
 * `(^|\s)` — a mention starts a word, so an email address does not contain one.
 * The `\b` end lets punctuation terminate it ("@scout, look"). Deliberately
 * WIDER than the slug charset (it accepts `.`), because the slugger below is
 * what narrows the captured token to a handle.
 */
const MENTION_PATTERN_SOURCE = '(^|\\s)@([a-zA-Z0-9_.-]{1,64})\\b';

/** A fresh sticky matcher. Never share one — `lastIndex` is state. */
function mentionPattern() {
 return new RegExp(MENTION_PATTERN_SOURCE, 'g');
}

/**
 * A handle's canonical form. The CANONICAL implementation of what both backends
 * call `slugHandle`; they delegate to this so a handle minted by one is
 * mentionable through the other.
 *
 * The `|| 'agent'` fallbacks are load-bearing history, not defensiveness: a
 * token that reduces to nothing (`@...`) has always resolved to the handle
 * `agent`, and changing that would change who existing messages dispatch.
 */
function slugMentionHandle(value) {
 return String(value || 'agent')
  .toLowerCase()
  .replace(/^@+/, '')
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || 'agent';
}

/** The one handle that means "everyone in this channel". */
const CHANNEL_MENTION_HANDLE = 'channel';

/**
 * Handles no agent may hold. Sized for exactly one entry on purpose: every name
 * taken from the mention namespace is a name a human cannot give an agent, so
 * this list earns each addition.
 */
const RESERVED_AGENT_HANDLES = Object.freeze([CHANNEL_MENTION_HANDLE]);

/** True when a handle is claimed by the system and must be refused at creation. */
function isReservedAgentHandle(value) {
 const raw = String(value == null ? '' : value).trim();
 if (!raw) return false;
 return RESERVED_AGENT_HANDLES.includes(slugMentionHandle(raw));
}

/** The error a create/rename door should surface for a reserved handle. */
function reservedAgentHandleMessage(value) {
 return `The handle @${slugMentionHandle(value)} is reserved — it addresses everyone in a channel. Choose another.`;
}

/**
 * Every handle a message mentions, in first-appearance order, de-duplicated.
 * `channel` appears in this list like any other handle; callers decide what it
 * means, because it means different things in a channel and in a DM.
 */
function parseMentionHandles(content) {
 const out = [];
 const seen = new Set();
 const re = mentionPattern();
 let match;
 while ((match = re.exec(String(content == null ? '' : content)))) {
  const handle = slugMentionHandle(match[2]);
  if (handle && !seen.has(handle)) {
   seen.add(handle);
   out.push(handle);
  }
 }
 return out;
}

/** True when this text addresses the whole channel. */
function mentionsChannel(content) {
 return parseMentionHandles(content).includes(CHANNEL_MENTION_HANDLE);
}

/** The mentions that name an individual — `@channel` removed. */
function agentMentionHandles(content) {
 return parseMentionHandles(content).filter((handle) => handle !== CHANNEL_MENTION_HANDLE);
}

/**
 * How many distinct agents ONE `@channel` may wake.
 *
 * chat_sessions.max_agent_turns (default 10) already bounds a burst, but it
 * counts TURNS — agent-to-agent replies spend the same budget — so it does not
 * bound how many distinct agents a single `@channel` can queue. This does, and
 * it truncates in stable roster order so the same agents are chosen every time
 * rather than a different subset per attempt.
 */
const CHANNEL_MENTION_MAX_AGENTS = 8;

/**
 * The agents one `@channel` addresses: the session's STORED agent participants,
 * in roster order, capped.
 *
 * `participantAgentIds` is the caller's already-parsed roster (see
 * parseParticipants — the column has held both an array and a JSON string).
 * `agents` is the workspace's agent rows. Nothing else is consulted: not
 * presence, not recent authors, not the whole workspace. An agent that is not
 * in the roster is not in the channel, so `@channel` does not reach it.
 */
function expandChannelMention({ participantAgentIds, agents, isEnabled, limit = CHANNEL_MENTION_MAX_AGENTS }) {
 const wanted = new Set((participantAgentIds || []).map((id) => String(id)));
 if (wanted.size === 0) return [];
 const cap = Math.max(0, Number(limit) || 0);
 if (cap === 0) return [];
 const enabled = typeof isEnabled === 'function' ? isEnabled : () => true;
 const out = [];
 for (const agent of agents || []) {
  if (!agent || !wanted.has(String(agent.id))) continue;
  if (!enabled(agent)) continue;
  out.push(agent);
  if (out.length >= cap) break;
 }
 return out;
}

// --- reply eagerness --------------------------------------------------------

/**
 * chat_sessions.conversation_mode. The column, its two values and the MCP tool
 * that sets them all predate this file; what was missing is that the dispatcher
 * stopped reading it, so every channel behaved as 'auto' regardless.
 *
 *   'auto'    — an un-addressed post may draw ONE agent in unprompted (a cheap
 *               relevance call elects it; it fails closed). The default, and
 *               what every existing channel already does.
 *   'social'  — the same, unhurried. Replies are paced seconds apart and a
 *               message that named nobody draws a couple of answers rather than
 *               one per agent. See shared/replyCadence.cjs; the ONLY thing that
 *               reads this value is the cadence plan.
 *   'mention' — an un-addressed post dispatches NOBODY. It is still posted,
 *               still read, and any agent can be pulled in later with an
 *               @mention or `@channel`. "They do not have to answer now, but
 *               they can whenever."
 *
 * ONE AXIS, three values, deliberately: how eagerly does this room answer a post
 * nobody addressed — never ('mention'), unhurried ('social'), at once ('auto').
 * Cadence became a third value here rather than a second column because a
 * separate control would have multiplied into states with no meaning ('mention'
 * plus paced is paced silence) and asked the operator the same question twice.
 * `@channel` made the same call.
 *
 * Explicit addressing is unaffected by the mode: an @mention, a DM, and a reply
 * inside an agent's thread all dispatch in every mode. The mode only governs
 * the un-addressed case, which is the only case where nobody asked.
 */
const CONVERSATION_MODES = Object.freeze(['auto', 'social', 'mention']);
const DEFAULT_CONVERSATION_MODE = 'auto';

function normalizeConversationMode(value) {
 const mode = String(value == null ? '' : value).trim().toLowerCase();
 return CONVERSATION_MODES.includes(mode) ? mode : DEFAULT_CONVERSATION_MODE;
}

/**
 * Whether an un-addressed post in this session may wake an agent nobody named.
 *
 * A DM always may: its single agent answers plain messages by definition, and
 * that is what makes it a DM rather than a channel of one.
 *
 * Phrased as "not 'mention'" rather than "is 'auto'" ON PURPOSE. 'mention' is
 * the one value that means silence; every other value — today 'auto' and
 * 'social', tomorrow whatever else lands on this axis — means somebody may
 * answer. Written the other way round, adding a value would have made those
 * channels go silent, which is the one failure this file exists to prevent and
 * the one a test cannot see (nothing errors; an agent simply never speaks).
 */
function allowsUnpromptedReply({ conversationMode, isDirectMessage = false } = {}) {
 if (isDirectMessage) return true;
 return normalizeConversationMode(conversationMode) !== 'mention';
}

// --- parity fixture ---------------------------------------------------------

/**
 * Inputs whose answers must be IDENTICAL in shared/channelMentions.cjs and
 * src/lib/channelMentions.ts.
 *
 * Checked by both runners — tests/channel-mention-parity.test.cjs pins this
 * side's answers literally, tests/unit/channelMentions.test.ts imports the real
 * TS module and asserts the same table. The composer's "they'll be added when
 * you send" hint and the server's dispatch decision read the same text; if they
 * disagree the symptom is a message that looks addressed to someone and wakes
 * nobody, which is invisible until an agent is silently missing from a thread.
 */
const PARITY_INPUTS = [
 '', '   ', null, undefined,
 'no mentions here',
 '@scout',
 '@scout can you look',
 'hey @scout and @coder',
 'hey @scout and @scout again',
 'mail me at jason@bouncingfish.com',
 'ping @Scout',
 '@channel',
 '@CHANNEL please look',
 '@Channel',
 'cc @channel and @scout',
 '@channels',
 '@channel-two',
 'end of line @channel',
 '(@channel)',
 'the #channel tag',
 '@...',
 '@-',
 '@a.b.c',
 '@' + 'x'.repeat(80),
 'multi\nline @channel here',
 '\t@channel after a tab',
 'no-space-before@channel',
];

/** Every decision's answer for every fixture input, as one comparable object. */
function parityAnswers(impl) {
 return PARITY_INPUTS.map((value) => ({
  handles: impl.parseMentionHandles(value),
  agents: impl.agentMentionHandles(value),
  channel: impl.mentionsChannel(value),
  reserved: impl.isReservedAgentHandle(value),
  slug: impl.slugMentionHandle(value),
 }));
}

module.exports = {
 CHANNEL_MENTION_HANDLE,
 CHANNEL_MENTION_MAX_AGENTS,
 CONVERSATION_MODES,
 DEFAULT_CONVERSATION_MODE,
 MENTION_PATTERN_SOURCE,
 PARITY_INPUTS,
 RESERVED_AGENT_HANDLES,
 agentMentionHandles,
 allowsUnpromptedReply,
 expandChannelMention,
 isReservedAgentHandle,
 mentionPattern,
 mentionsChannel,
 normalizeConversationMode,
 parityAnswers,
 parseMentionHandles,
 reservedAgentHandleMessage,
 slugMentionHandle,
};
