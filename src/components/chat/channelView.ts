import type { Message as ChatMessage } from '../../types';

/**
 * Which messages the CHANNEL (or DM) view shows.
 *
 * An agent no longer works in the channel: its "Thinking …" placeholder, its
 * tool-step chips and its intermediate text blocks all live in a thread hanging
 * off the human message that started the turn (see resolveWorkThreadParent in
 * server/index.cjs). Only the final answer is flagged `broadcast_to_channel`, and
 * that flag is what lifts it back into this view — following Slack's "Also send to
 * channel". Humans get the same switch from the thread composer.
 *
 * A broadcast reply KEEPS its thread_parent_id, so it appears in BOTH views: the
 * thread it was written in, and the channel. That is deliberate — the channel row
 * carries a "from a thread" affordance back to the working conversation, so it
 * never reads as a top-level message that lost its context.
 */
export function isChannelMessage(message: ChatMessage): boolean {
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
