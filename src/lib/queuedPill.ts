import type { AgentWork } from './agentWork';
import { type ReceiptMessage, isOwnReceiptMessage } from './readReceipts';

// The queued pill: "your message landed mid-turn and is waiting its turn".
//
// THE QUESTION IT ANSWERS. You type something while an agent is already
// working. The seen pill tells you the agent's read marker has passed your
// message; it does NOT tell you whether anything is going to happen about it.
// Those are different facts and the silence between them is the whole
// complaint — "it saw it and did nothing" is indistinguishable from "it never
// saw it" without this.
//
// HOW IT IS DERIVED, and why it needs no backend change. The agent-work store
// is fed from `agent_jobs` and each entry carries `anchorAt` — the start of the
// OLDEST still-running job in that scope. A message of yours created AFTER that
// instant cannot be what the running turn is answering: the turn was already
// under way when you pressed enter. So it is behind that turn, which is exactly
// "queued". A message created BEFORE the anchor is (or may be) what the agent
// is working on right now, and gets nothing — the activity line above the
// composer already says "X is thinking…" for that case.
//
// WHY IT IS NOT A JOB STATUS. `agent_jobs` does have a 'queued' status, but the
// work store only ever loads and subscribes to status='running' rows, and a
// message typed mid-turn frequently has NO job row of its own yet — the daemon
// creates one when it picks the work up. Waiting for a 'queued' row would leave
// the gap unexplained for precisely as long as the gap is confusing. The
// derivation above is true the instant the message exists.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM. Not a position ("3rd in queue") and not
// an ETA. The store knows how many jobs are running in a scope, not what any
// agent intends to do next, and a made-up ordinal is worse than none.

/** How far past the anchor a message must be. Guards clock skew, nothing else. */
const QUEUE_EPSILON_MS = 250;

export interface QueuedState {
  queued: boolean;
  /** How many agents are working in this scope, for the label. */
  workers: number;
  /**
   * WHO is working — the agents this message is waiting behind, so the chip can
   * show their faces rather than an anonymous "Queued".
   *
   * These are the running jobs' agent ids, straight off the work store. It is
   * NOT a claim about who will answer: nothing here knows that. It is the far
   * narrower and checkable fact "these are the turns in front of you", which is
   * what makes the wait legible in a channel with three agents in it.
   */
  agentIds: readonly string[];
}

const NOT_QUEUED: QueuedState = { queued: false, workers: 0, agentIds: [] };

/**
 * Is this message of yours waiting behind a turn that was already running?
 *
 * Returns a plain object rather than a boolean so the label can say "behind 2
 * agents" without the caller reaching back into the store a second time.
 */
export function queuedState(
  message: ReceiptMessage | null | undefined,
  work: AgentWork | null | undefined,
  currentUserId: string | null,
): QueuedState {
  if (!message || !work || work.jobs < 1) return NOT_QUEUED;
  // Only YOUR messages. "Somebody else's post is queued" is not a fact you can
  // act on, and it would put a chip on most rows in a busy channel.
  if (!isOwnReceiptMessage(message, currentUserId)) return NOT_QUEUED;
  const createdAt = message.created_at ? Date.parse(message.created_at) : NaN;
  if (!Number.isFinite(createdAt)) return NOT_QUEUED;
  if (!Number.isFinite(work.anchorAt)) return NOT_QUEUED;
  // Strictly after the turn started. Equal timestamps are NOT queued: the
  // ordinary "you sent it and the agent started" case serialises to the same
  // millisecond often enough that treating it as queued would put the chip on
  // the message the agent is actually answering.
  if (createdAt <= work.anchorAt + QUEUE_EPSILON_MS) return NOT_QUEUED;
  return { queued: true, workers: work.jobs, agentIds: work.agentIds || [] };
}

/**
 * The chip's label and title.
 *
 * "Queued" and not "Waiting" or "Pending": queued is what it is — the agent is
 * demonstrably busy and this is next, rather than stalled or lost.
 */
export function queuedLabel(state: QueuedState): { label: string; title: string } {
  if (!state.queued) return { label: '', title: '' };
  return {
    label: 'Queued',
    title: state.workers > 1
      ? `Sent while ${state.workers} agents were already working — this is next in line`
      : 'Sent while the agent was already working — this is next in line',
  };
}
