import type { HuddleState, Message } from '../types';

// Where a huddle's words go, and what the channel is told about it afterwards.
//
// A huddle is ad-hoc; the channel is the record. Speech-to-text used to be
// posted straight into the host channel, which turned a live voice call into
// permanent channel history — a dictation system. It now goes into the huddle's
// OWN session (huddles.transcript_session_id), rendered in a side panel, and
// the channel gets one marker row when the call ends.
//
// Everything here is a decision, not a render: which session an utterance
// belongs to, whether a message row is a marker, what the panel's header says.
// No React, no DOM, no fetch — so the routing rule that decides where your
// voice ends up is testable without a microphone or a browser.

/** `messages.message_kind` for the one row a finished huddle leaves behind. */
export const HUDDLE_MARKER_KIND = 'huddle';

/** `chat_sessions.folder` for a huddle's own conversation. */
export const HUDDLE_SESSION_FOLDER = 'huddle';

/**
 * Is this session a huddle's transcript rather than a place you navigate to?
 *
 * Must be asked EVERYWHERE the app enumerates sessions as channels. A huddle
 * transcript carries no `parent_message_id` and no agent-only participant list,
 * so every existing "is this a channel" test says yes: it would appear in the
 * sidebar, and — worse — `useChat` picks `sessions[0]` by `updated_at` as the
 * session you land on, so the channel you opened the app into would be the last
 * call anybody held.
 */
export function isHuddleSession(
  session: { folder?: string | null } | null | undefined,
): boolean {
  return String(session?.folder ?? '').trim().toLowerCase() === HUDDLE_SESSION_FOLDER;
}

/**
 * The session a huddle utterance must be posted into.
 *
 * The whole point of the change: the huddle's own session when it has one, and
 * the host channel ONLY as the fallback for huddles that predate transcript
 * sessions — where the conversation genuinely did live in the channel, so
 * sending it there is not a regression, it is the original behaviour.
 *
 * Returns '' when there is nowhere to post, which the caller must treat as "do
 * not post" rather than "post somewhere sensible". Guessing a session here is
 * how an utterance ends up in the wrong channel.
 */
export function huddleTranscriptTarget(
  state: Pick<HuddleState, 'transcriptSessionId' | 'sessionId'> | null | undefined,
  hostSessionId: string | null | undefined,
): string {
  const transcript = String(state?.transcriptSessionId ?? '').trim();
  if (transcript) return transcript;
  return String(hostSessionId ?? '').trim();
}

/**
 * Does this huddle keep its conversation out of the channel?
 *
 * False for a legacy huddle, and the two callers that ask both need to know:
 * the panel says so instead of showing an empty transcript it cannot explain,
 * and the caption row must not promise privacy it is not delivering.
 */
export function hasOwnTranscript(
  state: Pick<HuddleState, 'transcriptSessionId'> | null | undefined,
): boolean {
  return Boolean(String(state?.transcriptSessionId ?? '').trim());
}

/** Is this message the channel marker a finished huddle left behind? */
export function isHuddleMarkerMessage(
  message: Pick<Message, 'message_kind'> | null | undefined,
): boolean {
  return (message?.message_kind ?? '') === HUDDLE_MARKER_KIND;
}

/**
 * The huddle a marker refers to, or '' if it refers to none.
 *
 * A marker whose huddle row is gone (the workspace was pruned, the column
 * predates the marker) keeps its sentence and loses only its link. Callers key
 * the "open the transcript" affordance off this being non-empty, so a dead
 * marker renders as a statement of fact rather than a button that does nothing.
 */
export function huddleMarkerTarget(
  message: (Pick<Message, 'message_kind'> & { huddle_id?: string | null }) | null | undefined,
): string {
  if (!isHuddleMarkerMessage(message)) return '';
  return String(message?.huddle_id ?? '').trim();
}

/**
 * How an ended huddle is summarised in the panel header.
 *
 * Counts come from the folded event log and are facts. An ended huddle has zero
 * live participants by definition, so "how many were here" is everJoinedCount —
 * reading participantCount here is exactly how an ended call ends up claiming
 * nobody attended it.
 */
export function huddleSummaryLine(state: HuddleState | null | undefined): string {
  if (!state) return '';
  if (state.active) {
    if (state.participantCount === 0) return 'Waiting for the first person to connect';
    return `${state.participantCount} in the huddle`;
  }
  const joined = state.everJoinedCount;
  if (joined === 0) return 'Huddle ended — nobody joined';
  return `Huddle ended — ${joined} ${joined === 1 ? 'person' : 'people'} joined`;
}

/**
 * Should opening a huddle also open its panel?
 *
 * True exactly once per connection: when THIS browser joins a call and the
 * panel is not already the thing on screen. Deliberately not "whenever a huddle
 * is live" — a huddle someone else is holding must not seize a panel out from
 * under whatever you were reading, and re-opening a panel the user just closed
 * is a fight they cannot win.
 */
export function shouldOpenHuddlePanel(
  connectedHuddleId: string | null | undefined,
  lastOpenedForHuddleId: string | null | undefined,
): boolean {
  const current = String(connectedHuddleId ?? '').trim();
  if (!current) return false;
  return current !== String(lastOpenedForHuddleId ?? '').trim();
}

/**
 * The composer placeholder inside the panel.
 *
 * Names the addressee, because a channel huddle dispatches on @mention and
 * "who hears this" is the one thing a person in a call cannot see.
 */
export function huddleComposerPlaceholder(activeHandle: string): string {
  const handle = String(activeHandle || '').trim().replace(/^@+/, '');
  return handle ? `Message @${handle} in this huddle` : 'Message in this huddle';
}

/**
 * A run of consecutive huddle markers, collapsed into one row.
 *
 * Ten "You were in a huddle" lines stacked down a channel is ten rows of
 * chrome for one fact — that voice happened here — and it buried the actual
 * conversation. Consecutive markers therefore fold into a single dated row of
 * small chips, one chip per huddle, each still opening its own transcript.
 *
 * Consecutive means adjacent in the rendered list: any real message between
 * two huddles breaks the group, because the huddles then belong to different
 * moments in the conversation and merging them would misstate the order.
 */
export interface HuddleMarkerGroup {
  kind: 'huddle-group';
  key: string;
  /** The markers in the run, oldest first. */
  messages: Array<{ id: string; created_at?: string | null; content?: string | null; huddle_id?: string | null }>;
}

type MarkerLike = Pick<Message, 'message_kind'> & {
  id: string;
  created_at?: string | null;
  content?: string | null;
  huddle_id?: string | null;
};

/**
 * Fold runs of two-or-more markers into groups, leaving everything else — and
 * any LONE marker — exactly as it was. A single huddle reads better as the
 * sentence it already is than as a one-chip row.
 */
export function groupHuddleMarkers<T extends MarkerLike>(
  messages: readonly T[],
): Array<T | HuddleMarkerGroup> {
  const out: Array<T | HuddleMarkerGroup> = [];
  let run: T[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) out.push(run[0]);
    else out.push({ kind: 'huddle-group', key: `huddle-group-${run[0].id}`, messages: run.slice() });
    run = [];
  };

  for (const message of messages) {
    if (isHuddleMarkerMessage(message)) { run.push(message); continue; }
    flush();
    out.push(message);
  }
  flush();
  return out;
}

/** "3 huddles" / "10 huddles" — the count is the headline, the date the context. */
export function huddleGroupLabel(group: HuddleMarkerGroup): string {
  const count = group.messages.length;
  return `${count} ${count === 1 ? 'huddle' : 'huddles'}`;
}
