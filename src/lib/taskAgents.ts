import type { AgentConnection, TaskComment, WorkspaceAgent } from '../types';
import type { WorkspaceMember } from '../hooks/useSharing';

export type TaskCommentAuthorKind = 'you' | 'member' | 'agent' | 'unknown';

export interface TaskCommentAuthor {
  kind: TaskCommentAuthorKind;
  label: string;
  email?: string;
  agentId?: string;
}

/**
 * Resolve who wrote a task comment. Agent authorship (a mirrored subthread reply,
 * carrying `agent_id`) takes precedence over any human `user_id`, then the current
 * user, then a workspace member, then an unresolved fallback.
 */
export function resolveTaskCommentAuthor(
  comment: Pick<TaskComment, 'user_id' | 'agent_id'>,
  ctx: {
    members: WorkspaceMember[];
    agents: WorkspaceAgent[];
    currentUserId?: string;
    currentUserEmail?: string;
  },
): TaskCommentAuthor {
  if (comment.agent_id) {
    const agent = ctx.agents.find(a => a.id === comment.agent_id);
    return { kind: 'agent', label: agent?.name || 'Agent', agentId: comment.agent_id };
  }
  if (comment.user_id && ctx.currentUserId && comment.user_id === ctx.currentUserId) {
    return { kind: 'you', label: 'You', email: ctx.currentUserEmail };
  }
  const member = comment.user_id ? ctx.members.find(m => m.user_id === comment.user_id) : null;
  if (member) {
    return { kind: 'member', label: member.email?.split('@')[0] || 'Teammate', email: member.email };
  }
  return { kind: 'unknown', label: 'Teammate' };
}

/**
 * A task is "active" (working) when the agent it's assigned to has a live daemon
 * connection that is currently busy. Assignee ids may point at a member or an
 * agent; only a busy agent connection counts as working.
 */
export function isAssigneeActive(
  assigneeId: string | null | undefined,
  connections: AgentConnection[],
): boolean {
  if (!assigneeId) return false;
  return connections.some(conn => conn.agent_id === assigneeId && conn.status === 'busy');
}
