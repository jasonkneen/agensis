import { type ReceiptMessage, isOwnReceiptMessage } from './readReceipts';

// ============================================================================
// SETTLED — DO NOT RE-DECIDE THIS WITHOUT THE HUMAN SAYING SO.
//
// On 2026-08-03 this moved four times in one afternoon. Three agents, each
// working alone, each landed a defensible call and each undid the one before
// it: chip in the reaction row -> eye in the meta row -> eye on every read
// message -> back again. None of them was wrong on the merits; what was missing
// was a written decision to defer to. This is it.
//
// THE SHAPE, as asked for by Jason in #testtest:
//
//   * 👀 IS A CHIP IN THE REACTION ROW. It means LOOKED AT, it is derived from
//     the read markers, and it is the ONLY read indicator. There is no eye in
//     the meta row and no second line under the pills — src/components/chat/
//     ReadReceipt.tsx was deleted so there is nothing left to wire back up.
//   * 👍 MEANS ACKNOWLEDGED. That one is a REAL reaction, not a derived chip:
//     an agent adds it with the react_to_message MCP tool (b6c9daa4) when it
//     has taken something on. Looked-at and acknowledged are different facts
//     and this is the whole reason they are two different glyphs.
//   * THE QUEUED CHIP STAYS, in the same row. See src/lib/queuedPill.ts.
//   * EVERY CHIP SHOWS WHOSE FACE, not a count — src/lib/readerFaces.ts.
//   * THE ACTIVITY DOTS ARE UNRELATED AND UNTOUCHED.
//
// WHAT WAS GIVEN UP, deliberately, so nobody "fixes" it as a bug: a chip cannot
// render absence, so "sent, not read yet" shows NOTHING. There is no hollow
// eye and no "Sent" chip. That state was tried (UnseenPill, 2808a551) and cut.
// ============================================================================

// The "seen" pill: the read receipt rendered as a reaction-shaped chip instead
// of an eye in the meta row.
//
// WHY THIS IS NOT A REAL REACTION. It looks like one, and it deliberately must
// not be one. A row in `messages.reactions` is user-authored content: anyone
// with write access can add it, remove it, and it survives whatever the reader
// actually did. "Seen" is an assertion the SYSTEM makes from the read markers,
// so it is DERIVED at render time from the same markers the eye used — nobody
// can toggle it, nobody can forge it onto someone else's behalf, and it cannot
// drift from `session_read_state`. The chip shape is a presentation choice; the
// data path underneath is unchanged.
//
// WHY 👀 IS ALLOWED HERE. The project rule bans decorative emoji in chrome, and
// ReadReceipt.tsx argued the eye on exactly that ground. The rule still holds —
// what changed is the ask: the signal now lives in the reaction row, next to
// real emoji pills, and an SVG among emoji reads as a broken pill rather than a
// consistent one. It stays distinguishable from a user's own 👀 reaction by
// being non-interactive, uncounted in the reaction map, and labelled "Seen by"
// rather than "Reacted with".
//
// STILL NO TIMESTAMP, EVER. The marker is a high-water mark and deliberately
// cannot say which message was read at which instant. The UI must not invent a
// finer clock than the model kept.

export const SEEN_GLYPH = '\u{1F440}';

/**
 * "Seen by Coder, Grok and 3 others" — never a raw uuid.
 *
 * An id that will not resolve renders as "Someone", because a uuid in a tooltip
 * is useless to the reader and a small identifier leak into a screenshot.
 */
export function describeSeenBy(
  readerIds: readonly string[],
  resolveName: (readerId: string) => string | null,
  maxNames = 4,
): string {
  if (readerIds.length === 0) return '';
  const names = readerIds.map(id => resolveName(id) || 'Someone');
  if (names.length <= maxNames) {
    if (names.length === 1) return `Seen by ${names[0]}`;
    return `Seen by ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  const shown = names.slice(0, maxNames);
  const rest = names.length - maxNames;
  return `Seen by ${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

/**
 * The accessible name. A screen reader reaching only the glyph learns nothing —
 * 👀 announces as "eyes" — so the count goes in words and the names follow.
 */
export function seenPillLabel(
  readerIds: readonly string[],
  resolveName: (readerId: string) => string | null,
): string {
  const count = readerIds.length;
  if (count === 0) return 'Not seen yet';
  return `Seen by ${count} ${count === 1 ? 'reader' : 'readers'}: ${describeSeenBy(readerIds, resolveName)
    .replace(/^Seen by /, '')}`;
}

/**
 * Which of your messages carry a seen pill.
 *
 * THE TRAILING RUN IS THE WHOLE POINT. `receiptAnchorIds` marks only the LAST
 * message of each of your contiguous runs, which is right for a single "did it
 * land" eye and wrong for this feature: the specific case asked for is typing
 * mid-stream — three messages in a row while an agent is still working — and
 * wanting to see that each of them registered. So every message of your CURRENT
 * (trailing) run is an anchor.
 *
 * Earlier runs keep the last-of-run rule. Back in the transcript the question
 * has already been answered by the reply that follows, and a pill on every
 * historical message of yours is furniture.
 *
 * Returns a Set of message ids so a row can ask in O(1) while rendering.
 */
/**
 * The single message that may carry an "unread" chip, or null.
 *
 * WHY THIS EXISTS AT ALL. Moving the receipt into the reaction row lost one
 * state the old eye had: in a DM it drew a HOLLOW eye for "sent, not read yet".
 * A pill cannot show absence — it renders nothing until somebody reads — so
 * "did that land" went unanswered in the one place where it is the whole
 * question. This puts it back, deliberately narrowly:
 *
 *   * DMs only. An unread chip on every message in a 30-person channel is
 *     furniture; "nobody has read this yet" there is the normal state of the
 *     world for the first few seconds of every message ever sent.
 *   * The LAST message of your trailing run only — never the whole run, unlike
 *     the seen pill. Three "Not seen yet" chips stacked say one thing three
 *     times, and the run's last message is the one whose answer you are waiting
 *     for.
 *   * Nothing once anybody has read it: the seen pill takes over, and showing
 *     both would be a contradiction on one row.
 */
export function unseenAnchorId(
  messages: readonly ReceiptMessage[],
  currentUserId: string | null,
): string | null {
  if (!currentUserId) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message?.id) continue;
    // Scan back from the end and stop at the first message either way: if the
    // transcript does not END with one of yours, the other party has replied,
    // which answers "did it land" far better than a chip could.
    return isOwnReceiptMessage(message, currentUserId) ? String(message.id) : null;
  }
  return null;
}

export function seenAnchorIds(
  messages: readonly ReceiptMessage[],
  currentUserId: string | null,
): Set<string> {
  const anchors = new Set<string>();
  if (!currentUserId) return anchors;

  // Where the trailing run of your own messages starts. -1 when the transcript
  // does not end with one (somebody replied last), in which case nothing is
  // "in flight" and every run is historical.
  let trailingStart = messages.length;
  while (
    trailingStart > 0
    && isOwnReceiptMessage(messages[trailingStart - 1], currentUserId)
  ) trailingStart -= 1;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message?.id) continue;
    if (!isOwnReceiptMessage(message, currentUserId)) continue;
    if (i >= trailingStart) { anchors.add(message.id); continue; }
    const next = messages[i + 1];
    if (!next || !isOwnReceiptMessage(next, currentUserId)) anchors.add(message.id);
  }
  return anchors;
}
