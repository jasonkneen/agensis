// The "Get started" checklist's steps, as a pure function.
//
// This used to be a useMemo inside GetStartedChecklist. It moved out because the
// sidebar footer is now shared with per-surface tips, and the rule for which of
// the two the space shows (src/lib/pageTips.ts) needs to know how much
// onboarding is left. One computation, read by both, rather than a component
// deciding its own visibility and a second copy of the counting elsewhere.

import type { ChatSession, WorkspaceAgent } from '../types';

/**
 * Handles seeded into every workspace by default — an agent OUTSIDE this set
 * means the user actually created their own, so "Create your first agent" is real.
 */
export const DEFAULT_AGENT_HANDLES: ReadonlySet<string> = new Set([
  'scout', 'research', 'coder', 'q', 'mills', 'general',
]);

/** The folder value that marks a session as a DM rather than a channel. */
export const DIRECT_MESSAGES_FOLDER = 'Direct messages';

export type ChecklistStepId = 'agent' | 'room' | 'message' | 'invite';

export interface ChecklistStep {
  id: ChecklistStepId;
  label: string;
  done: boolean;
}

/**
 * The four first-run steps and whether each is done.
 *
 * Takes the narrowest shape it can rather than the full row types, so the tests
 * are fixtures of two fields instead of whole agents and sessions.
 */
export function computeChecklistSteps(input: {
  agents: readonly Pick<WorkspaceAgent, 'handle'>[];
  sessions: readonly Pick<ChatSession, 'folder'>[];
  memberCount: number;
}): ChecklistStep[] {
  const createdAgent = input.agents.some(
    agent => !DEFAULT_AGENT_HANDLES.has(String(agent.handle || '').toLowerCase()),
  );
  const startedRoom = input.sessions.some(session => session.folder !== DIRECT_MESSAGES_FOLDER);
  const messagedAgent = input.sessions.some(session => session.folder === DIRECT_MESSAGES_FOLDER);
  const invited = input.memberCount > 1;
  return [
    { id: 'agent', label: 'Create your first agent', done: createdAgent },
    { id: 'room', label: 'Start your first channel', done: startedRoom },
    { id: 'message', label: 'Message an agent', done: messagedAgent },
    { id: 'invite', label: 'Invite teammates', done: invited },
  ];
}

/** How many steps are still outstanding. Zero means onboarding is finished. */
export function remainingStepCount(steps: readonly ChecklistStep[]): number {
  return steps.reduce((count, step) => (step.done ? count : count + 1), 0);
}
