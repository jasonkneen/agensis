import type { ChannelParticipant, ChatSession } from '../types';
import type { ChannelTemplate } from './channelTemplates';
import { dedupeSessionParticipants, toPersistedParticipant } from './sessionParticipants';
import { normalizeChannelDescription, normalizeChannelIcon, normalizeChannelIntent } from './channelProfile';
import { normalizeConversationMode, type ConversationMode } from './channelMentions';

// ---------------------------------------------------------------------------
// The channel creation STEP MACHINE, as pure functions.
//
// Extracted from NewChannelDialog for the same reason src/lib/skillTokens.ts
// extracts its keyboard state machine: the rules worth pinning ("step 2 is
// unreachable without a name", "the draft never carries a visibility key") are
// exactly the ones that are painful to assert through a mounted dialog, and a
// rule nobody tests is a rule that regresses.
//
// The flow the owner asked for, in order:
//   1. NAME the channel      — nothing is suggested before there is a name
//   2. suggested MEMBERS     — ranked from that name (channelMemberSuggestions)
//   3. confirm or adjust     — nothing is ever added automatically
//   4. create
//
// Bridge templates are NOT part of this: they keep their existing
// create-then-attach path, whose ordering is load-bearing and documented in
// NewChannelDialog. Threading a member step through it buys nothing and risks
// a flow that already works.
// ---------------------------------------------------------------------------

export type ChannelCreateStep = 'name' | 'members';

/** The title column is text, but the channel editor clamps here — match it. */
export const MAX_CHANNEL_TITLE_CHARS = 200;

/** Over this many agents, an `auto` channel is worth a word of warning. See `chorusNote`. */
export const CHORUS_THRESHOLD = 3;

export interface ChannelCreateDraft {
  title: string;
  icon: string;
  description: string;
  intent: string;
  conversation_mode: ConversationMode;
  participants: ChannelParticipant[];
}

/** Exactly what the channel editor would accept back unchanged. */
export function normalizeChannelTitle(value: unknown): string {
  return String(value ?? '').trim().slice(0, MAX_CHANNEL_TITLE_CHARS);
}

/**
 * Whether the name step is satisfied.
 *
 * `.trim()` and not `.length`: a channel called "   " is unreachable in the
 * sidebar and indistinguishable from the "New Channel" fallback this whole
 * feature exists to remove.
 */
export function canAdvanceToMembers(name: string): boolean {
  return normalizeChannelTitle(name).length > 0;
}

/**
 * The name a template contributes when one is picked.
 *
 * Fills an EMPTY field only. A template is a modifier here, not a gate, and
 * silently overwriting a name somebody typed — because they then clicked
 * "Project" to set the tone — is the kind of small theft that makes a form feel
 * hostile.
 */
export function applyTemplateName(currentName: string, template: ChannelTemplate): string {
  if (normalizeChannelTitle(currentName).length > 0) return currentName;
  return template.title;
}

/**
 * A channel whose name already exists, or null.
 *
 * A WARNING, never a block: `chat_sessions` has no unique constraint on title,
 * duplicate names are legal, and adding a constraint here would be a schema
 * change for a cosmetic problem. Computed from sessions already in memory.
 */
export function duplicateChannelName(
  sessions: readonly ChatSession[],
  name: string,
): string | null {
  const target = normalizeChannelTitle(name).toLowerCase();
  if (!target) return null;
  for (const session of sessions) {
    if (session.deleted_at) continue;
    if (session.parent_message_id) continue;
    if (String(session.folder || '') === 'Direct messages') continue;
    const title = String(session.title || '').trim();
    if (title.toLowerCase() === target) return title;
  }
  return null;
}

/**
 * The one-line warning shown when a roster is about to become a chorus.
 *
 * The participant roster is not cosmetic — the server reads it to decide who is
 * a candidate to answer a post — so putting six agents in an `auto` channel
 * means six agents are candidates for every message. `social` paces replies and
 * caps a broadcast; `mention` waits to be asked. Informative, never blocking:
 * a busy room is a legitimate thing to want.
 */
export function chorusNote(agentCount: number, mode: ConversationMode): string | null {
  if (mode !== 'auto') return null;
  if (agentCount <= CHORUS_THRESHOLD) return null;
  return `${agentCount} agents on "auto" will all be candidates to answer every post. `
    + '"Social" paces replies; "mention" waits to be asked.';
}

/**
 * The row written into `chat_sessions.participants`, from whatever the picker
 * selected. Goes through the shared writer so creation and the in-channel add
 * dialog produce byte-identical rows.
 */
export function toDraftParticipants(
  selected: readonly (Pick<ChannelParticipant, 'id' | 'name' | 'kind'> & Partial<ChannelParticipant>)[],
): ChannelParticipant[] {
  return dedupeSessionParticipants(selected.map(toPersistedParticipant));
}

/**
 * Everything the insert needs, and NOTHING else.
 *
 * Two absences are deliberate and both are asserted by tests:
 *
 * 1. `participants` is a real ARRAY, never JSON text. Binding a stringified
 *    array into a `$n::jsonb` placeholder stores a jsonb string scalar, which
 *    every `Array.isArray` consumer reads as "nobody" — that is how 51 of 70
 *    live sessions ended up with empty-looking rosters. The generic insert path
 *    casts it correctly; the only way to reintroduce the bug is to pre-stringify
 *    here.
 *
 * 2. NO `visibility` key. The column IS client-settable on a top-level channel:
 *    `chat_sessions` has no entry in PRIVILEGED_DB_COLUMNS_BY_TABLE, and the
 *    server's override only fires for sessions that INHERIT privacy (those with
 *    parent_message_id or split_parent_id — see resolveInheritedSessionVisibility
 *    in server/index.cjs), which a new channel has neither of. Meanwhile
 *    `chat_session_members` is deliberately not allowlisted for generic writes,
 *    because that table is a self-grant primitive. So a client that sets
 *    visibility:'private' here creates a channel with ZERO members — unreadable
 *    by everyone including whoever just made it, unfixable from the client, and
 *    reported as no error at all, because nothing failed. It is not corrupt,
 *    it is invisible, which is worse.
 *
 *    A member picker is precisely the screen that invites a "Private channel"
 *    checkbox. Doing it properly means a route that inserts the session and the
 *    creator's chat_session_members row in one transaction, the way
 *    findOrCreateDirectSession already does. That is a backend change with its
 *    own RBAC surface, and it is out of scope here.
 */
export function composeChannelDraft(
  template: ChannelTemplate,
  name: string,
  selected: readonly (Pick<ChannelParticipant, 'id' | 'name' | 'kind'> & Partial<ChannelParticipant>)[],
  modeOverride?: ConversationMode,
): ChannelCreateDraft {
  return {
    title: normalizeChannelTitle(name),
    icon: normalizeChannelIcon(template.channelIcon),
    description: normalizeChannelDescription(template.channelDescription),
    intent: normalizeChannelIntent(template.intent),
    conversation_mode: normalizeConversationMode(modeOverride ?? template.conversationMode),
    participants: toDraftParticipants(selected),
  };
}
