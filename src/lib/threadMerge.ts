import { channelMessages } from '../components/chat/channelView';
import type { ChatSession, Message } from '../types';
import { messageText } from './chatStream';
import { compareMessagePosition } from './messagePosition';

export const MERGE_BRANCH_MESSAGE_LIMIT = 500;
export const MERGE_SYNTHESIS_MAX_BYTES = 7 * 1024;
export const AGENT_RESULT_MESSAGE_KIND = 'agent_result';
export const MERGE_SYNTHESIS_RECONCILE_MS = 2_000;

export type SplitDivergence =
  | { ok: true; parent: Message[]; fork: Message[] }
  | { ok: false; reason: string };

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateBranchMiddle(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const marker = '\n\n[... middle of this branch omitted at the merge context limit ...]\n\n';
  const markerBytes = utf8Bytes(marker);
  if (maxBytes <= markerBytes + 2) return '';
  const chars = [...value];
  const contentBudget = maxBytes - markerBytes;
  const headTarget = Math.ceil(contentBudget / 2);
  let head = '';
  let headBytes = 0;
  let headIndex = 0;
  while (headIndex < chars.length) {
    const next = chars[headIndex];
    const nextBytes = utf8Bytes(next);
    if (headBytes + nextBytes > headTarget) break;
    head += next;
    headBytes += nextBytes;
    headIndex += 1;
  }
  let tail = '';
  let tailBytes = 0;
  for (let index = chars.length - 1; index >= headIndex; index -= 1) {
    const next = chars[index];
    const nextBytes = utf8Bytes(next);
    if (headBytes + tailBytes + nextBytes > contentBudget) break;
    tail = next + tail;
    tailBytes += nextBytes;
  }
  return `${head}${marker}${tail}`;
}

function branchTranscript(messages: Message[]): string {
  return messages
    .map(message => `${message.sender_name || message.role}: ${messageText(message.content)}`)
    .join('\n\n') || '(no further messages)';
}

/**
 * Bound each branch independently before joining them. A single oversized
 * parent branch can therefore never push the fork entirely beyond the server's
 * context window (the old concatenation did exactly that).
 */
export function buildMergeSynthesisPrompt(
  forkTitle: string,
  parentMessages: Message[],
  forkMessages: Message[],
  maxBytes = MERGE_SYNTHESIS_MAX_BYTES,
): string {
  const title = forkTitle || 'Untitled';
  const prefix =
    'Merge two diverged branches of this thread into a single combined solution.\n\n' +
    "Both branches share this thread's history up to the split. After the split they diverged:\n\n" +
    '=== This thread continued ===\n';
  const between = `\n\n=== Split branch "${title}" continued ===\n`;
  const suffix =
    '\n\nReconcile them: keep the best of each, resolve any conflicts, and produce one combined result. ' +
    'If one branch is clearly better, use it and say why.';
  const budget = Math.max(1024, Number(maxBytes) || MERGE_SYNTHESIS_MAX_BYTES);
  const fixedBytes = utf8Bytes(prefix) + utf8Bytes(between) + utf8Bytes(suffix);
  const branchBudget = Math.max(256, budget - fixedBytes);
  const parent = branchTranscript(parentMessages);
  const branch = branchTranscript(forkMessages);
  const parentBytes = utf8Bytes(parent);
  const branchBytes = utf8Bytes(branch);
  let parentBudget = Math.floor(branchBudget / 2);
  let forkBudget = branchBudget - parentBudget;
  if (parentBytes < parentBudget) {
    forkBudget += parentBudget - parentBytes;
    parentBudget = parentBytes;
  } else if (branchBytes < forkBudget) {
    parentBudget += forkBudget - branchBytes;
    forkBudget = branchBytes;
  }
  return `${prefix}${truncateBranchMiddle(parent, parentBudget)}${between}` +
    `${truncateBranchMiddle(branch, forkBudget)}${suffix}`;
}

export function isDurableMergeSynthesis(message: Message, mergeSeedId: string): boolean {
  const content = messageText(message.content).trim();
  return String(message.thread_parent_id || '') === String(mergeSeedId)
    && message.role === 'assistant'
    && message.sender_kind === 'agent'
    && Boolean(String(message.sender_id || '').trim())
    && message.message_kind === AGENT_RESULT_MESSAGE_KIND
    && !message.deleted_at
    && content.length > 0;
}

type MergePollTimer = ReturnType<typeof setTimeout>;

export interface MergeSynthesisPoller {
  start(): Promise<void>;
  stop(): void;
}

/**
 * Reconcile the durable result even when it lands in the gap between the first
 * database query and the websocket subscription becoming active. Realtime is
 * the fast path; this bounded poll is the correctness path.
 */
export function createMergeSynthesisPoller({
  mergeSeedId,
  load,
  onFound,
  intervalMs = MERGE_SYNTHESIS_RECONCILE_MS,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = timer => clearTimeout(timer),
}: {
  mergeSeedId: string;
  load: () => Promise<Message[]>;
  onFound: (message: Message) => Promise<void> | void;
  intervalMs?: number;
  schedule?: (callback: () => void, delay: number) => MergePollTimer;
  cancel?: (timer: MergePollTimer) => void;
}): MergeSynthesisPoller {
  let stopped = false;
  let running = false;
  let timer: MergePollTimer | null = null;

  const check = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    let found = false;
    try {
      const messages = await load();
      if (stopped) return;
      const synthesis = messages.find(message =>
        isDurableMergeSynthesis(message, mergeSeedId));
      if (synthesis) {
        await onFound(synthesis);
        found = true;
      }
    } catch {
      // A transient read failure must not turn into source-branch deletion or
      // stop later reconciliation. The timeout still bounds this watcher.
    } finally {
      running = false;
      if (!stopped && !found) {
        timer = schedule(() => { void check(); }, intervalMs);
      }
    }
  };

  return {
    start: check,
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}

/**
 * Resolve the two post-split branches from exact server-authored provenance.
 * No text prefix and no browser clock can make a native message disappear.
 */
export function splitDivergence(
  fork: ChatSession,
  parentRows: Message[],
  forkRows: Message[],
): SplitDivergence {
  const baselineId = String(fork.split_baseline_message_id || '');
  if (!baselineId) return { ok: false, reason: 'missing_split_baseline' };
  const baseline = forkRows.find(message =>
    String(message.id) === baselineId && String(message.session_id) === String(fork.id));
  if (!baseline) return { ok: false, reason: 'split_baseline_not_loaded' };

  const sourceBoundaryId = String(fork.split_source_boundary_message_id || '');
  const splitAt = Date.parse(String(fork.split_at || ''));
  let parentAfterBoundary: Message[];
  if (sourceBoundaryId) {
    const boundary = parentRows.find(message =>
      String(message.id) === sourceBoundaryId
      && String(message.session_id) === String(fork.split_parent_id || ''));
    if (!boundary) return { ok: false, reason: 'source_boundary_not_loaded' };
    parentAfterBoundary = parentRows.filter(message => compareMessagePosition(message, boundary) > 0);
  } else {
    if (!Number.isFinite(splitAt)) return { ok: false, reason: 'missing_split_time' };
    parentAfterBoundary = parentRows.filter(message => Date.parse(message.created_at) > splitAt);
  }

  const parent = channelMessages(
    parentAfterBoundary.filter(message => !message.deleted_at),
  ).sort(compareMessagePosition);
  const branch = channelMessages(
    forkRows.filter(message =>
      !message.deleted_at
      && String(message.id) !== baselineId),
  ).sort(compareMessagePosition);
  return { ok: true, parent, fork: branch };
}
