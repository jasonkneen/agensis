// Read receipts: the emit policy and the "who read this" derivation, with no
// React and no transport, so both can be tested without mounting anything.
//
// Follows src/lib/typingPresence.ts deliberately — same shape, same reason. The
// extraction is not stylistic: `tests/unit/**/*.test.ts` is the only glob the
// frontend runner sees, `.test.tsx` is outside it, and there is no
// @testing-library/react in this repo. Logic left inside a `.tsx` component is
// effectively untestable here.
//
// WHY THIS IS DURABLE STATE AND NOT AN EPHEMERAL PRESENCE SIGNAL
//
// Typing rides a broadcast frame that expires 6 seconds after arrival, and that
// expiry IS the design: silence means the signal is gone. A receipt is the
// opposite — you close the tab, come back tomorrow, and the eye is still there.
// Putting a receipt on the ephemeral lane would evaporate it seconds after the
// reader's tab closed.
//
// There is a second, harder blocker. `shouldAnnounceTyping` refuses direct
// messages outright, because `item-presence:<workspaceId>` fans out to every
// member and the frame carries an itemId — announcing on it would tell the whole
// workspace that a private conversation exists and is active. DMs are the case
// people want receipts for most, so a transport that structurally excludes them
// is disqualified before any of the above.
//
// So receipts are rows, and what carries over from the typing work is the
// DISCIPLINE: a pure emit decision, a throttle constant with a written reason,
// and no timestamp on the wire.
//
// WHY THE CLIENT NEVER SENDS A TIME
//
// It sends the ID of the newest message it has seen and the server resolves that
// to the row's own created_at. Markers and messages then come from ONE clock.
// src/lib/activityStatus.ts had to buy 60s of slack purely to absorb browser
// skew; a receipt has no TTL to hide skew in, and a fast client clock would mark
// messages read that arrived after the reader left.

export interface SessionReadMarker {
  session_id: string;
  /**
   * The reader — a human `app_users.id` OR an agent `workspace_agents.id`. One
   * opaque id either way, so the client resolves a name the same for both and
   * never has to branch on which kind of principal read the message.
   */
  reader_id: string;
  /** 'human' | 'agent'. Present from the server; defaulted when absent. */
  reader_kind?: string;
  /** ISO timestamp, resolved server-side from `messages.created_at`. */
  read_at: string;
}

/** The subset of a message this module needs. Keeps it free of the app types. */
export interface ReceiptMessage {
  id: string;
  created_at?: string | null;
  sender_kind?: string | null;
  sender_id?: string | null;
}

/**
 * Minimum gap between marker writes for one session.
 *
 * 3000ms, sitting between typing's 4s re-arm (TYPING_REARM_MS) and the 2s
 * presence heartbeat, chosen so a fast reader scrolling a live channel produces
 * at most ~20 writes a minute rather than one per scroll event.
 *
 * Note this is the SECOND line of defence and not the main one. The main one is
 * the data model: a high-water mark means reading two hundred messages is one
 * write no matter how the UI is driven, so the throttle only shapes the cadence
 * of an already-coalesced signal.
 */
export const RECEIPT_REARM_MS = 3000;

export interface ReceiptEmitState {
  /** The message id last successfully sent for this session, if any. */
  lastSentMessageId: string | null;
  /** When that send happened, in ms. */
  lastSentAt: number;
}

export function initialReceiptEmitState(): ReceiptEmitState {
  return { lastSentMessageId: null, lastSentAt: 0 };
}

export interface ReceiptEmitInput {
  /** The newest message currently on screen, or null when there is none. */
  newestVisible: ReceiptMessage | null;
  /** The reading user. */
  currentUserId: string | null;
  /** document.visibilityState, passed in so this module never touches the DOM. */
  visibility: DocumentVisibilityState;
  state: ReceiptEmitState;
  now: number;
  /**
   * A flush ignores the throttle but nothing else. Used on blur/pagehide so
   * leaving a conversation records what was actually read, rather than losing
   * up to RECEIPT_REARM_MS of it.
   */
  flush?: boolean;
  /** False when the user has switched receipts off; see the reciprocity note. */
  enabled?: boolean;
}

export interface ReceiptEmitDecision {
  /** The message id to send, or null to send nothing. */
  messageId: string | null;
  /** Why nothing is being sent. Present only when messageId is null. */
  reason?: 'disabled' | 'hidden' | 'nothing-visible' | 'unchanged' | 'own-message' | 'throttled';
}

/**
 * Should a marker be written, and for which message?
 *
 * Every suppression here is a claim about the READER, so each one is a reason a
 * receipt would otherwise be a lie:
 *
 *   - a background tab has not been read by anyone;
 *   - your own newest message is not something you "read";
 *   - an unchanged newest id means no new reading happened, so re-confirming the
 *     same position would put traffic on every socket in the session for nothing.
 */
export function decideReceiptEmit(input: ReceiptEmitInput): ReceiptEmitDecision {
  const { newestVisible, currentUserId, visibility, state, now, flush = false, enabled = true } = input;
  if (!enabled) return { messageId: null, reason: 'disabled' };
  // A flush fires from pagehide, where visibility has usually already flipped to
  // 'hidden' — so the visibility check is skipped for a flush, or leaving the
  // page would never record the thing the flush exists to record.
  if (!flush && visibility !== 'visible') return { messageId: null, reason: 'hidden' };
  if (!newestVisible || !newestVisible.id) return { messageId: null, reason: 'nothing-visible' };
  if (newestVisible.id === state.lastSentMessageId) return { messageId: null, reason: 'unchanged' };
  if (isOwnMessage(newestVisible, currentUserId)) return { messageId: null, reason: 'own-message' };
  if (!flush && now - state.lastSentAt < RECEIPT_REARM_MS) return { messageId: null, reason: 'throttled' };
  return { messageId: newestVisible.id };
}

/**
 * Record a send. Returns the NEXT state rather than mutating, so a caller
 * holding the previous one (a retry path, a test) still sees what it had.
 */
export function noteReceiptSent(_state: ReceiptEmitState, messageId: string, now: number): ReceiptEmitState {
  return { lastSentMessageId: messageId, lastSentAt: now };
}

function isOwnMessage(message: ReceiptMessage, currentUserId: string | null): boolean {
  if (!currentUserId) return false;
  if (message.sender_kind === 'agent') return false;
  return String(message.sender_id || '') === String(currentUserId);
}

/**
 * Who has read this message.
 *
 *   readers(M) = { u : marker[u].read_at >= M.created_at } \ { M.author }
 *
 * O(members) in the client with no per-message round trip, and it stays correct
 * as markers arrive over realtime.
 *
 * `>=` and not `>`: a marker is set to the created_at of a message that WAS
 * seen, so the message that is exactly at the marker is read. Using `>` reports
 * the most recently read message as unread, which is the one people look at.
 *
 * The author is excluded because "you read your own message" is not information.
 */
export function readersOf(
  message: ReceiptMessage,
  markers: readonly SessionReadMarker[],
): string[] {
  const createdAt = message.created_at ? Date.parse(message.created_at) : NaN;
  if (!Number.isFinite(createdAt)) return [];
  // The author's id — a user id for a human message, an agent id for an agent
  // message. Reader ids share that namespace, so a single equality check excludes
  // the author of EITHER kind: "you read your own message" is not information,
  // and that now includes an agent not marking its own reply as seen.
  const authorId = String(message.sender_id || '');
  const readers: string[] = [];
  for (const marker of markers) {
    const readAt = Date.parse(marker.read_at);
    if (!Number.isFinite(readAt) || readAt < createdAt) continue;
    const readerId = String(marker.reader_id);
    if (authorId && readerId === authorId) continue;
    if (!readers.includes(readerId)) readers.push(readerId);
  }
  return readers;
}

/**
 * Which of your messages should carry an indicator.
 *
 * ONLY the last message of each of your contiguous runs. A five-message burst
 * would otherwise draw five identical eyes, which is noise rather than
 * information — the run's last message is the one whose receipt answers "did
 * what I just said land".
 *
 * Returns a Set of message ids so a row can ask in O(1) while rendering.
 */
export function receiptAnchorIds(
  messages: readonly ReceiptMessage[],
  currentUserId: string | null,
): Set<string> {
  const anchors = new Set<string>();
  if (!currentUserId) return anchors;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isOwnMessage(message, currentUserId)) continue;
    const next = messages[i + 1];
    if (!next || !isOwnMessage(next, currentUserId)) anchors.add(message.id);
  }
  return anchors;
}

/**
 * "Read by Ana, Ben and 3 others" — never a raw uuid.
 *
 * An id that will not resolve renders as "Someone": a uuid in a tooltip is both
 * useless to the reader and a small identifier leak into a screenshot.
 */
export function describeReaders(
  readerIds: readonly string[],
  resolveName: (userId: string) => string | null,
  maxNames = 3,
): string {
  if (readerIds.length === 0) return '';
  const names = readerIds.map(id => resolveName(id) || 'Someone');
  if (names.length <= maxNames) {
    if (names.length === 1) return `Read by ${names[0]}`;
    return `Read by ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  const shown = names.slice(0, maxNames);
  const rest = names.length - maxNames;
  return `Read by ${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}
