// ---------------------------------------------------------------------------
// CHANNEL MENTIONS (browser copy).
//
// DUPLICATED from shared/channelMentions.cjs, which the server uses to decide
// who a message dispatches. They cannot be one file: shared/*.cjs is CommonJS
// server code and nothing under src/ may pull it into the browser bundle — the
// same arrangement as src/lib/channelProfile.ts and shared/channelIntent.cjs.
//
// tests/unit/channelMentions.test.ts runs BOTH implementations over the shared
// PARITY_INPUTS table and fails if they ever disagree. That test is the only
// thing keeping the composer's idea of who a message addresses tied to the
// dispatcher's, and the drift it prevents is invisible: a message that reads as
// addressed to someone, and wakes nobody. If you change a rule here, change it
// there.
// ---------------------------------------------------------------------------

/** Kept as source so both copies hold the literally identical string. */
export const MENTION_PATTERN_SOURCE = '(^|\\s)@([a-zA-Z0-9_.-]{1,64})\\b';

/** A fresh sticky matcher. Never share one — `lastIndex` is state. */
export function mentionPattern(): RegExp {
  return new RegExp(MENTION_PATTERN_SOURCE, 'g');
}

/**
 * A handle's canonical form — the server's `slugHandle`, to the character.
 * The `|| 'agent'` fallbacks are history, not defensiveness: a token that
 * reduces to nothing (`@...`) has always resolved to the handle `agent`.
 */
export function slugMentionHandle(value: unknown): string {
  return String(value || 'agent')
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

/** The one handle that means "everyone in this channel". */
export const CHANNEL_MENTION_HANDLE = 'channel';

/** Handles no agent may hold. Refused at creation; see isReservedAgentHandle. */
export const RESERVED_AGENT_HANDLES: readonly string[] = [CHANNEL_MENTION_HANDLE];

/** True when a handle is claimed by the system and must be refused. */
export function isReservedAgentHandle(value: unknown): boolean {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return false;
  return RESERVED_AGENT_HANDLES.includes(slugMentionHandle(raw));
}

/** The message a create/rename form should show for a reserved handle. */
export function reservedAgentHandleMessage(value: unknown): string {
  return `The handle @${slugMentionHandle(value)} is reserved — it addresses everyone in a channel. Choose another.`;
}

/** Every handle a message mentions, first-appearance order, de-duplicated. */
export function parseMentionHandles(content: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = mentionPattern();
  let match: RegExpExecArray | null;
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
export function mentionsChannel(content: unknown): boolean {
  return parseMentionHandles(content).includes(CHANNEL_MENTION_HANDLE);
}

/** The mentions that name an individual — `@channel` removed. */
export function agentMentionHandles(content: unknown): string[] {
  return parseMentionHandles(content).filter(handle => handle !== CHANNEL_MENTION_HANDLE);
}

/** How many distinct agents ONE `@channel` may wake. See the server's copy. */
export const CHANNEL_MENTION_MAX_AGENTS = 8;

/**
 * chat_sessions.conversation_mode — reply eagerness for un-addressed posts.
 * ONE axis: never ('mention'), unhurried ('social', see src/lib/replyCadence.ts),
 * at once ('auto', the default). See shared/channelMentions.cjs for why cadence
 * is a value here rather than a column of its own.
 */
export type ConversationMode = 'auto' | 'social' | 'mention';
export const CONVERSATION_MODES: readonly ConversationMode[] = ['auto', 'social', 'mention'];
export const DEFAULT_CONVERSATION_MODE: ConversationMode = 'auto';

export function normalizeConversationMode(value: unknown): ConversationMode {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  return (CONVERSATION_MODES as readonly string[]).includes(mode)
    ? (mode as ConversationMode)
    : DEFAULT_CONVERSATION_MODE;
}

/**
 * Whether an un-addressed post here may wake an agent nobody named. A DM always
 * may: its single agent answering a plain message is what makes it a DM.
 *
 * "Not 'mention'" rather than "is 'auto'": 'mention' is the one value that means
 * silence, so a new value on this axis defaults to being answerable instead of
 * silently muting every channel that adopts it.
 */
export function allowsUnpromptedReply(
  { conversationMode, isDirectMessage = false }: { conversationMode?: unknown; isDirectMessage?: boolean } = {},
): boolean {
  if (isDirectMessage) return true;
  return normalizeConversationMode(conversationMode) !== 'mention';
}
