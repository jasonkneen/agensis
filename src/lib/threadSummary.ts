import type { Message } from '../types';

// How many participant avatars a reply summary shows before collapsing the rest
// into a "+N" chip.
export const THREAD_SUMMARY_AVATAR_CAP = 3;

export type ThreadSummaryParticipant = {
  /** Stable identity used for dedupe + React keys. */
  key: string;
  name: string;
  /** Resolved avatar value, or '' when the sender has none (falls back to initials). */
  avatar: string;
  isAgent: boolean;
};

export type ThreadReplySummary = {
  count: number;
  /** ISO timestamp of the newest reply, or null when none could be read. */
  lastReplyAt: string | null;
  /** Most recent distinct repliers, capped at THREAD_SUMMARY_AVATAR_CAP, oldest-first. */
  participants: ThreadSummaryParticipant[];
  /** Distinct repliers that did not fit in `participants`. */
  overflow: number;
};

function participantKey(message: Message): string {
  return message.sender_id || message.sender_name || message.role;
}

function participantName(message: Message): string {
  return message.sender_name || (message.role === 'user' ? 'You' : 'Assistant');
}

function timestamp(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Derive per-parent reply summaries from the messages already in memory.
 *
 * This deliberately takes the whole message list rather than fetching: the chat
 * window is already handed every message for the session, and thread replies are
 * just the ones carrying a thread_parent_id.
 *
 * `resolveAvatar` is injected so this stays free of the component's agent/avatar
 * lookup tables.
 */
export function buildThreadReplySummaries(
  messages: Message[],
  resolveAvatar: (message: Message) => string,
): Record<string, ThreadReplySummary> {
  const byParent = new Map<string, Message[]>();
  for (const message of messages) {
    const parentId = message.thread_parent_id;
    if (!parentId) continue;
    const bucket = byParent.get(parentId);
    if (bucket) bucket.push(message);
    else byParent.set(parentId, [message]);
  }

  const summaries: Record<string, ThreadReplySummary> = {};
  for (const [parentId, replies] of byParent) {
    const ordered = [...replies].sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at));
    const lastReply = ordered[ordered.length - 1];

    // Walk newest → oldest so the avatars shown are the people who spoke most
    // recently, then flip back to reading order for display.
    const seen = new Set<string>();
    const newestFirst: ThreadSummaryParticipant[] = [];
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const reply = ordered[i];
      const key = participantKey(reply);
      if (seen.has(key)) continue;
      seen.add(key);
      newestFirst.push({
        key,
        name: participantName(reply),
        avatar: resolveAvatar(reply),
        isAgent: reply.sender_kind === 'agent' || reply.role === 'assistant',
      });
    }

    const participants = newestFirst.slice(0, THREAD_SUMMARY_AVATAR_CAP).reverse();
    summaries[parentId] = {
      count: ordered.length,
      lastReplyAt: lastReply?.created_at ?? null,
      participants,
      overflow: Math.max(0, newestFirst.length - participants.length),
    };
  }
  return summaries;
}

function ago(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/**
 * Relative time for the "last reply …" half of a reply summary. Spelled out
 * ("24 minutes ago") rather than the terse "24m" used in list views, because it
 * reads as a sentence fragment next to the reply count.
 */
export function formatLastReplyTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return ago(Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return ago(Math.floor(seconds / 3600), 'hour');
  if (seconds < 604800) return ago(Math.floor(seconds / 86400), 'day');
  return `on ${new Date(then).toLocaleDateString()}`;
}
