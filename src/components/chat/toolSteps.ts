import type { Message as ChatMessage } from '../../types';

/** `messages.message_kind` for one agent tool call. Anything else is a real message. */
export const TOOL_STEP_KIND = 'tool_step';

/**
 * How long a step group waits without a new step before it gathers itself into a
 * single summary chip. Long enough that a slow Bash call doesn't collapse the run
 * mid-flight, short enough that a finished run tidies up while you're still looking.
 */
export const TOOL_STEP_SETTLE_MS = 8000;

/**
 * A group whose newest step is already this old was never live in this session —
 * scrolling back through history, or reopening a finished thread. It renders settled
 * from the first paint instead of pretending to stream for the quiet window.
 *
 * Deliberately much larger than the quiet window: `created_at` comes from the server
 * clock and is compared against the browser's, so a minute of slack keeps ordinary
 * skew from collapsing a genuinely live run on sight.
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

export interface TranscriptStepRow {
  kind: 'steps';
  key: string;
  steps: ChatMessage[];
  /** Index of the LAST step in the source list, so `scrollAnchor` checks still work. */
  index: number;
  /** A later non-step message from the same sender exists — the run is demonstrably over. */
  endedByReply: boolean;
}

export type TranscriptRow = TranscriptMessageRow | TranscriptStepRow;

export function isToolStepMessage(message: Pick<ChatMessage, 'message_kind'> | null | undefined): boolean {
  return (message?.message_kind ?? '') === TOOL_STEP_KIND;
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

/** True when the newest step is old enough that the run cannot still be in flight. */
export function isStaleStepGroup(steps: ChatMessage[], now: number = Date.now()): boolean {
  const newest = steps[steps.length - 1];
  const at = newest?.created_at ? new Date(newest.created_at).getTime() : Number.NaN;
  if (!Number.isFinite(at)) return false; // no usable clock — let the quiet timer decide
  return now - at > TOOL_STEP_STALE_MS;
}

function senderKey(message: ChatMessage): string {
  return message.sender_id || message.sender_name || message.role || 'unknown';
}

/**
 * Collapse runs of CONSECUTIVE tool steps from the same sender into one row, leaving
 * every other message exactly where it was. Never reorders: "consecutive" means
 * adjacent in the list as given.
 */
export function buildTranscriptRows(messages: ChatMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let open: TranscriptStepRow | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isToolStepMessage(message)) {
      open = null;
      rows.push({ kind: 'message', key: message.id, message, index });
      continue;
    }
    if (open && senderKey(open.steps[0]) === senderKey(message)) {
      open.steps.push(message);
      open.index = index;
      continue;
    }
    open = { kind: 'steps', key: `tool-steps-${message.id}`, steps: [message], index, endedByReply: false };
    rows.push(open);
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
    row.endedByReply = repliedSenders.has(senderKey(row.steps[0]));
  }

  return rows;
}
