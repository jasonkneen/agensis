import type { AgentConnection, Task, WorkspaceAgent } from '../../types';

// What the task drawer's agent panel says about an agent assigned to a task. Everything
// here is derived from data the app already has (the task's status, the assigned agent and
// its live connection), never from a guess about a run. The live elapsed time and the
// working state come from TaskActivityChip, which reads the real running job.

export type AgentPresence = 'busy' | 'online' | 'offline';

export interface AgentPanelState {
  /** The assigned agent, or null when the task is not assigned to an agent. */
  agent: WorkspaceAgent | null;
  presence: AgentPresence;
  presenceLabel: string;
  /** One sentence about where the task stands with this agent. */
  summary: string;
  /** The agent is disabled, so it cannot pick the task up. */
  disabled: boolean;
}

/** The assigned agent's most recently seen connection, or undefined when it has none. */
function liveConnection(agentId: string, connections: AgentConnection[]): AgentConnection | undefined {
  return connections
    .filter(conn => conn.agent_id === agentId && conn.status !== 'offline')
    .sort((a, b) => new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime())[0];
}

export function agentPanelState(
  task: Pick<Task, 'assignee_id' | 'status'>,
  agents: WorkspaceAgent[],
  connections: AgentConnection[],
): AgentPanelState {
  const agent = task.assignee_id ? agents.find(item => item.id === task.assignee_id) ?? null : null;
  if (!agent) return { agent: null, presence: 'offline', presenceLabel: '', summary: '', disabled: false };

  const connection = liveConnection(agent.id, connections);
  const presence: AgentPresence = connection ? (connection.status === 'busy' ? 'busy' : 'online') : 'offline';
  const presenceLabel = presence === 'busy' ? 'Busy' : presence === 'online' ? 'Online' : 'Not connected';
  const disabled = agent.enabled === false;

  let summary: string;
  if (disabled) summary = 'This agent is disabled, so it will not pick the task up.';
  else if (task.status === 'done') summary = 'Finished.';
  else if (task.status === 'cancelled') summary = 'Cancelled.';
  else if (task.status === 'in_progress') {
    summary = presence === 'offline' ? 'Started, but the agent is not connected right now.' : 'Working on it.';
  } else {
    summary = presence === 'offline' ? 'Waiting for the agent to connect.' : 'Assigned. Waiting for its turn.';
  }

  return { agent, presence, presenceLabel, summary, disabled };
}
