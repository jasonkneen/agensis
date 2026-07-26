import { isActivityPlaceholderMessage } from '../../lib/activityStatus';
import type { Message as ChatMessage } from '../../types';

/** `messages.message_kind` for one agent tool call. Anything else is a real message. */
export const TOOL_STEP_KIND = 'tool_step';

/**
 * A group whose newest member is already this old cannot still be in flight —
 * scrolling back through history, or reopening a finished thread. It stops showing
 * its live marker instead of pulsing forever at a run that ended yesterday.
 *
 * Deliberately generous: `created_at` comes from the server clock and is compared
 * against the browser's, so a minute of slack keeps ordinary skew from declaring a
 * genuinely live run dead on sight.
 */
export const TOOL_STEP_STALE_MS = 60000;

/** Bucket name for a step that carries no recognisable tool name. */
export const UNNAMED_TOOL_NAME = 'Step';

// The server writes the same step into `content` as `Bash · cd ~/repo && git log`
// (see agentStepContent in server/index.cjs), so rows inserted before tool_name /
// tool_detail existed can still be split back into their two halves.
const STEP_SEPARATOR = ' · ';
const TOOL_NAME_PATTERN = /^[A-Za-z][\w.:-]{0,31}$/;

export interface ToolStepParts {
  name: string;
  detail: string;
}

export interface ToolStepBucket {
  name: string;
  steps: ChatMessage[];
}

export interface TranscriptMessageRow {
  kind: 'message';
  key: string;
  message: ChatMessage;
  index: number;
}

/** A thinking period that is already over, rendered as one settled chip. */
export interface ThoughtChip {
  /** The message the placeholder became — also the key its elapsed was recalled under. */
  id: string;
  /** Preformatted duration, e.g. "43s" or "1m 4s". */
  elapsed: string;
}

export interface TranscriptStepRow {
  kind: 'steps';
  key: string;
  /** Tool calls only. Never contains a thinking placeholder. */
  steps: ChatMessage[];
  /** Live "Thinking 15s" placeholders caught in this run — chips, not bubbles. */
  thinking: ChatMessage[];
  /** Placeholders from this run that have already turned into real replies. */
  thoughts: ThoughtChip[];
  /** Index of the LAST member in the source list, so `scrollAnchor` checks still work. */
  index: number;
  /** A later non-step message from the same sender exists — the run is demonstrably over. */
  endedByReply: boolean;
  /** Whose run this is. Held explicitly because `steps` can be empty. */
  senderKey: string;
}

export type TranscriptRow = TranscriptMessageRow | TranscriptStepRow;

export function isToolStepMessage(message: Pick<ChatMessage, 'message_kind'> | null | undefined): boolean {
  return (message?.message_kind ?? '') === TOOL_STEP_KIND;
}

/**
 * The last elapsed seen on a live "Thinking Ns" placeholder, keyed by message id.
 *
 * The placeholder row is REWRITTEN IN PLACE into the agent's reply, so the instant
 * text arrives the duration is gone from the data for good and no column holds it.
 * Whatever this client last saw is therefore the only record — and it is enough,
 * because the chip only has to survive the transition it describes. A reader who
 * never watched the run (scrollback, a second tab) simply sees no thought chip,
 * which is honest: nobody here measured it.
 */
const THOUGHT_MEMO_LIMIT = 256;
const thoughtElapsedById = new Map<string, string>();

export function rememberThinkingElapsed(id: string, elapsed: string): void {
  if (!id || !elapsed) return;
  // Delete-then-set so the Map's insertion order doubles as an LRU and the entry
  // evicted below is genuinely the least recently touched.
  thoughtElapsedById.delete(id);
  thoughtElapsedById.set(id, elapsed);
  if (thoughtElapsedById.size > THOUGHT_MEMO_LIMIT) {
    const oldest = thoughtElapsedById.keys().next();
    if (!oldest.done) thoughtElapsedById.delete(oldest.value);
  }
}

export function recallThinkingElapsed(id: string): string {
  return thoughtElapsedById.get(id) ?? '';
}

/** Test seam — the memo is module state, so a suite has to be able to reset it. */
export function clearThinkingElapsed(): void {
  thoughtElapsedById.clear();
}

function normalizeStepText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Structured fields win; `content` is the fallback for rows the daemon wrote before
 * the columns existed. A step with no usable name renders its whole content as the
 * chip label, which is exactly what the old full-message rendering showed.
 */
export function toolStepParts(message: ChatMessage): ToolStepParts {
  const name = normalizeStepText(message.tool_name);
  if (name) return { name, detail: normalizeStepText(message.tool_detail) };

  const content = normalizeStepText(message.content);
  const cut = content.indexOf(STEP_SEPARATOR);
  if (cut > 0) {
    const candidate = content.slice(0, cut);
    // Only treat the head as a tool name if it looks like one — a prose message that
    // happens to contain a middot must not invent a bucket called "Well then".
    if (TOOL_NAME_PATTERN.test(candidate)) {
      return { name: candidate, detail: content.slice(cut + STEP_SEPARATOR.length) };
    }
  }
  return { name: '', detail: content };
}

/** One line per step, for the chip label and its `title` tooltip. */
export function toolStepLabel(message: ChatMessage): string {
  const { name, detail } = toolStepParts(message);
  if (name && detail) return `${name} ${detail}`;
  return name || detail;
}

/** Steps in source order, grouped by tool name, buckets ordered by first appearance. */
export function bucketToolSteps(steps: ChatMessage[]): ToolStepBucket[] {
  const buckets: ToolStepBucket[] = [];
  for (const step of steps) {
    const name = toolStepParts(step).name || UNNAMED_TOOL_NAME;
    const existing = buckets.find(bucket => bucket.name === name);
    if (existing) existing.steps.push(step);
    else buckets.push({ name, steps: [step] });
  }
  return buckets;
}

/**
 * True when the newest member is old enough that the run cannot still be in flight.
 *
 * Scans for the MAXIMUM rather than reading the tail: a group also carries its
 * thinking placeholder, which was inserted at dispatch — before every step it
 * precedes — so "last in the array" is not "most recent in time".
 */
export function isStaleStepGroup(steps: ChatMessage[], now: number = Date.now()): boolean {
  let newest = Number.NaN;
  for (const step of steps) {
    const at = step?.created_at ? new Date(step.created_at).getTime() : Number.NaN;
    if (Number.isFinite(at) && (Number.isNaN(newest) || at > newest)) newest = at;
  }
  if (!Number.isFinite(newest)) return false; // no usable clock — assume still live
  return now - newest > TOOL_STEP_STALE_MS;
}

function senderKey(message: ChatMessage): string {
  return message.sender_id || message.sender_name || message.role || 'unknown';
}

/**
 * Collapse runs of CONSECUTIVE tool steps from the same sender into one row, leaving
 * every other message exactly where it was. Never reorders: "consecutive" means
 * adjacent in the list as given.
 *
 * A live "Thinking Ns" placeholder joins the run instead of breaking it, so a turn
 * reads as one continuous strip rather than chips / bubble / chips. When the daemon
 * rewrites that placeholder into the real reply, the duration this client last saw
 * comes back as a settled thought chip: on the tail of the run it came out of when
 * there is one, otherwise as a chip row of its own directly above the reply. Either
 * way the chip stays where the placeholder was standing.
 *
 * `recallThought` is injectable purely so tests can drive that lookup; in the app it
 * reads the module memo the live chip writes.
 */
export function buildTranscriptRows(
  messages: ChatMessage[],
  recallThought: (id: string) => string = recallThinkingElapsed,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let open: TranscriptStepRow | null = null;

  const openGroup = (message: ChatMessage, index: number, keyPrefix = 'tool-steps'): TranscriptStepRow => {
    const row: TranscriptStepRow = {
      kind: 'steps',
      key: `${keyPrefix}-${message.id}`,
      steps: [],
      thinking: [],
      thoughts: [],
      index,
      endedByReply: false,
      senderKey: senderKey(message),
    };
    rows.push(row);
    return row;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isStep = isToolStepMessage(message);
    const isThinking = !isStep && isActivityPlaceholderMessage(message);

    if (isStep || isThinking) {
      if (!open || open.senderKey !== senderKey(message)) open = openGroup(message, index);
      (isThinking ? open.thinking : open.steps).push(message);
      open.index = index;
      continue;
    }

    const elapsed = recallThought(message.id);
    if (elapsed) {
      const thought: ThoughtChip = { id: message.id, elapsed };
      if (open && open.senderKey === senderKey(message)) open.thoughts.push(thought);
      // A standalone thought row is never the scroll anchor — the reply it sits
      // above is, one row later — so it deliberately claims no source index.
      else openGroup(message, -1, 'thought').thoughts.push(thought);
    }
    open = null;
    rows.push({ kind: 'message', key: message.id, message, index });
  }

  // Walk backwards so a group settles as soon as ANY later message from that sender
  // exists, not only when its reply lands immediately after (a user message can sit
  // in between). Cheap single pass — no per-group scan.
  const repliedSenders = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === 'message') {
      repliedSenders.add(senderKey(row.message));
      continue;
    }
    row.endedByReply = repliedSenders.has(row.senderKey);
  }

  return rows;
}
