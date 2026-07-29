import type { Automation, AutomationCondition, AutomationRun, AutomationStep } from '../hooks/useAutomations';

// What an automation should SAY on screen.
//
// Pure string work, no React and no DOM — the same split as src/lib/auditEntry.ts,
// so every rendering decision here is unit-testable without mounting a window.
//
// The hard part is not formatting, it is being honest about three things a user
// will otherwise assume wrongly:
//
//   1. An automation cannot wake an agent or spend a token. v1's only action is
//      posting a message, and posting does not advance a conversation. People
//      assume "automation" means "the AI does something", and if they assume
//      that either way they will be surprised — either by a bill that never
//      comes, or by expecting an agent to reply and getting nothing.
//   2. A rule that STOPPED is different from a rule that is OFF. The runaway
//      guard disables rather than throttles, so an automation can switch itself
//      off; a rule that quietly stopped firing is the worst outcome this feature
//      has, and it must never look the same as one someone deliberately paused.
//   3. Authoring is admin-level. That is not a UI opinion, it is what the server
//      enforces, and the copy should say it before someone types a rule they
//      cannot save.

/** The trigger vocabulary, in words rather than dotted event names. */
const EVENT_LABELS: Record<string, string> = {
  'message.created': 'A message is posted',
  'message.updated': 'A message is edited',
  'channel.created': 'A channel is created',
  'channel.updated': 'A channel is renamed or changed',
  'document.created': 'A document is created',
  'document.updated': 'A document is edited',
  'member.created': 'Someone joins the workspace',
  'member.updated': 'A member’s role changes',
  'agent.created': 'An agent is added',
  'agent.updated': 'An agent is changed',
};

const FIELD_LABELS: Record<string, string> = {
  'type': 'the event type',
  'workspaceId': 'the workspace',
  'channelId': 'the channel',
  'data.content': 'the message text',
  'data.title': 'the title',
  'data.role': 'the role',
  'data.senderKind': 'who sent it',
  'data.senderName': 'the sender name',
  'data.senderId': 'the sender',
  'data.name': 'the name',
  'data.handle': 'the handle',
  'data.folder': 'the folder',
};

const OP_LABELS: Record<string, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

export function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

export function conditionLabel(condition: AutomationCondition): string {
  const field = FIELD_LABELS[condition.field] ?? condition.field;
  const op = OP_LABELS[condition.op] ?? condition.op;
  if (condition.op === 'is_empty' || condition.op === 'is_not_empty') return `${field} ${op}`;
  return `${field} ${op} "${condition.value ?? ''}"`;
}

export function stepLabel(step: AutomationStep): string {
  if (step.action === 'post_message') return 'Post a message';
  // Named "create a task", never "assign a task". An automation cannot name an
  // assignee — the step has no such field — and a summary that implied
  // otherwise would describe something the rule cannot do.
  if (step.action === 'create_task') return 'Create a task';
  return step.action;
}

/**
 * The whole rule as one sentence, for the collapsed row.
 *
 * "When a message is posted, and the message text contains "deploy failed",
 *  post a message."
 */
export function ruleSummary(definition: Automation['definition']): string {
  if (!definition?.trigger?.event) return '';
  const when = Array.isArray(definition.when) ? definition.when : [];
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  const trigger = eventLabel(definition.trigger.event).toLowerCase();
  const conditions = when.length
    ? `, and ${when.map(conditionLabel).join(', and ')}`
    : '';
  const actions = steps.length
    ? steps.map(step => stepLabel(step).toLowerCase()).join(', then ')
    : 'do nothing';
  return `When ${trigger}${conditions}, ${actions}.`;
}

export type AutomationState = 'stopped' | 'off' | 'active';

/**
 * Three states, never two.
 *
 * `stopped` means the runaway guard switched it off — the automation was firing
 * more than its limit and disabling it was the safe answer. It looks like `off`
 * in the database (enabled = false) and must NOT look like it on screen: one is
 * a decision someone made, the other is a fault they need to know about.
 */
export function automationState(automation: Pick<Automation, 'enabled' | 'disabled_reason'>): AutomationState {
  if (!automation.enabled && automation.disabled_reason) return 'stopped';
  return automation.enabled ? 'active' : 'off';
}

export function stateLabel(state: AutomationState): string {
  if (state === 'stopped') return 'Stopped automatically';
  if (state === 'active') return 'Active';
  return 'Off';
}

/** Plain-English reason a rule stopped, plus what to do about it. */
export function stoppedExplanation(automation: Pick<Automation, 'disabled_reason'>): string {
  const reason = automation.disabled_reason?.trim();
  if (!reason) return '';
  return `${reason} It was switched off so it could not keep going. Turn it back on when the cause is fixed.`;
}

const RUN_STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting',
  inflight: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  error: 'Failed',
  dead: 'Gave up',
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

/** Did this run do what it was supposed to? Used for the row's tone. */
export function runFailed(run: Pick<AutomationRun, 'status'>): boolean {
  return run.status === 'error' || run.status === 'dead';
}

export function formatRunTime(iso: string | null, locale?: string): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** "12 runs, 1 failed" — or a phrase that does not imply a number it lacks. */
export function runCountLabel(automation: Pick<Automation, 'run_count' | 'fail_count'>): string {
  const runs = Math.max(0, automation.run_count || 0);
  const failed = Math.max(0, automation.fail_count || 0);
  if (runs === 0) return 'Has not run yet';
  const plural = runs === 1 ? 'run' : 'runs';
  return failed > 0 ? `${runs} ${plural}, ${failed} failed` : `${runs} ${plural}`;
}

/**
 * The safety statement, shown in the window rather than buried in docs.
 *
 * This is the copy that stops both wrong assumptions at once. Users reach for
 * "automation" expecting an agent to act; saying plainly that it cannot is
 * cheaper than either a surprised bill or a rule that appears not to work.
 */
export const AUTOMATION_SAFETY_NOTE =
  'An automation can post a message or create a task, and that is all it can do. '
  + 'It cannot wake an agent, start a conversation or spend any tokens, so a rule '
  + 'cannot run up a bill however often it fires. Rules run on the server, so they '
  + 'keep working whether or not anyone is online.';

/**
 * Shown next to the create-a-task fields, not only in the panel-wide note.
 *
 * The omission is the whole safety property and it is invisible: there is no
 * assignee control to notice the absence of, so someone reasonably assumes the
 * rule will give the task to somebody. Saying it here is what stops a rule from
 * being written on that assumption and quietly never being picked up.
 */
export const AUTOMATION_TASK_NOTE =
  'The task is created unassigned, and stays that way until a person picks it up '
  + 'or gives it to someone. A rule cannot assign work, because assigning work to '
  + 'an agent is what starts it running.';

/**
 * Stated before someone types a rule they cannot save. The server enforces
 * this; the client has no role model, so the copy is the only warning available
 * ahead of the attempt.
 */
export const AUTOMATION_PERMISSION_NOTE =
  'Creating or changing an automation needs the admin role, because a rule acts '
  + 'on its own without anyone approving each time.';

/** Shown when the deployment does not have automations switched on. */
export const AUTOMATION_UNAVAILABLE_NOTE =
  'Automations are not switched on for this deployment yet. Nothing is wrong '
  + 'here — the feature ships switched off and an administrator enables it.';

export const AUTOMATION_EMPTY_NOTE =
  'No rules yet. A rule watches for something happening in this workspace and '
  + 'posts a message or creates a task when it does, with no agent involved and '
  + 'nothing to pay for.';
