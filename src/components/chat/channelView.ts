import type { Message as ChatMessage } from '../../types';

/**
 * Which messages the CHANNEL (or DM) view shows.
 *
 * An agent no longer works in the channel: its "Thinking …" placeholder, its
 * tool-step chips and its intermediate text blocks all live in a thread hanging
 * off the human message that started the turn (see resolveWorkThreadParent in
 * server/index.cjs). Only the final answer is flagged `broadcast_to_channel`, and
 * that flag is what lifts it back into this view. Humans get the same switch
 * from the thread composer ("Send to channel").
 *
 * A broadcast reply KEEPS its thread_parent_id, so it appears in BOTH views: the
 * thread it was written in, and the channel. That is deliberate — the channel row
 * carries a "from a thread" affordance back to the working conversation, so it
 * never reads as a top-level message that lost its context.
 */
export function isChannelMessage(message: ChatMessage): boolean {
  // A tool step is never channel content, whatever its parentage says.
  //
  // This is a second, independent guard rather than a tidy-up. The server tries
  // to thread every step, but when the placeholder row is gone AND neither
  // recorded parent verifies, agent-jobs.cjs writes the step with a null
  // thread_parent_id — and a null parent is exactly what the first clause below
  // treats as top-level. One live DM had 119 such rows: `Bash · grep -n …`,
  // `Read · /Users/…`, context-free, 531 top-level rows against 332 threaded,
  // which pushed the actual conversation off the 200-row page.
  //
  // Filtering on kind fixes every DM already in that state without a migration,
  // and it holds even if a future writer forgets to thread a step.
  if (message.message_kind === 'tool_step') return false;
  return !message.thread_parent_id || Boolean(message.broadcast_to_channel);
}

/** The channel view's transcript: top-level messages plus broadcast thread replies. */
export function channelMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(isChannelMessage);
}

/**
 * True for a channel row that was actually written inside a thread — the rows that
 * need the "from a thread" affordance. A top-level message is not from a thread
 * however it is flagged, so the thread_parent_id check is what decides.
 */
export function isBroadcastFromThread(message: ChatMessage): boolean {
  return Boolean(message.thread_parent_id) && Boolean(message.broadcast_to_channel);
}
