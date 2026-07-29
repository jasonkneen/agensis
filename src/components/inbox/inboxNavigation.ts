import type { InboxOpenTarget } from './inboxSources';

/**
 * "Open this where it happened."
 *
 * One signature, shared by the row's hover pill, the detail pane's header
 * button and App's handler, so the three cannot drift. `target` carries the
 * session AND — for a thread reply — the exact thread root to focus, which is
 * the difference between opening a conversation and opening the part of it the
 * row was about.
 *
 * `beside` asks for the conversation to be tiled next to the inbox rather than
 * taking the canvas. It is a request, not a guarantee: with no inbox window to
 * anchor to, in full-expand mode, or on a viewport too narrow for two honest
 * halves, the caller opens it normally instead (see openSessionBeside).
 */
export type InboxOpenSession = (target: InboxOpenTarget & { beside?: boolean }) => void;
