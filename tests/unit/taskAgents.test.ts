import { describe, it, expect } from 'vitest';
import type { AgentConnection, TaskComment, WorkspaceAgent } from '../../src/types';
import type { WorkspaceMember } from '../../src/hooks/useSharing';
import { resolveTaskCommentAuthor, isAssigneeActive } from '../../src/lib/taskAgents';

const agents = [
  { id: 'a-coder', name: 'Coder', handle: 'coder' } as WorkspaceAgent,
  { id: 'a-scout', name: 'Scout', handle: 'scout' } as WorkspaceAgent,
];
const members: WorkspaceMember[] = [
  { user_id: 'u-jason', email: 'jason@example.com' } as WorkspaceMember,
];

function comment(over: Partial<TaskComment>): TaskComment {
  return {
    id: 'c1',
    task_id: 't1',
    workspace_id: 'w1',
    user_id: null,
    parent_id: null,
    content: 'hi',
    resolved: false,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
    ...over,
  };
}

const ctx = { members, agents, currentUserId: 'u-jason', currentUserEmail: 'jason@example.com' };

describe('resolveTaskCommentAuthor', () => {
  it('attributes an agent-authored comment to the agent (by name)', () => {
    const author = resolveTaskCommentAuthor(comment({ agent_id: 'a-coder' }), ctx);
    expect(author.kind).toBe('agent');
    expect(author.label).toBe('Coder');
    expect(author.agentId).toBe('a-coder');
  });

  it('falls back to a generic label when the agent is unknown', () => {
    const author = resolveTaskCommentAuthor(comment({ agent_id: 'a-ghost' }), ctx);
    expect(author.kind).toBe('agent');
    expect(author.label).toBe('Agent');
  });

  it('agent authorship wins over a stray user_id', () => {
    const author = resolveTaskCommentAuthor(comment({ agent_id: 'a-scout', user_id: 'u-jason' }), ctx);
    expect(author.kind).toBe('agent');
    expect(author.label).toBe('Scout');
  });

  it('labels the current user as You', () => {
    const author = resolveTaskCommentAuthor(comment({ user_id: 'u-jason' }), ctx);
    expect(author.kind).toBe('you');
    expect(author.label).toBe('You');
  });

  it('labels another member by email prefix', () => {
    const author = resolveTaskCommentAuthor(comment({ user_id: 'u-jason' }), { ...ctx, currentUserId: 'someone-else' });
    expect(author.kind).toBe('member');
    expect(author.label).toBe('jason');
    expect(author.email).toBe('jason@example.com');
  });

  it('falls back to Teammate for an unresolved author', () => {
    const author = resolveTaskCommentAuthor(comment({ user_id: 'u-unknown' }), ctx);
    expect(author.kind).toBe('unknown');
    expect(author.label).toBe('Teammate');
  });
});

describe('isAssigneeActive', () => {
  const busy = { agent_id: 'a-coder', status: 'busy' } as AgentConnection;
  const online = { agent_id: 'a-coder', status: 'online' } as AgentConnection;
  const otherBusy = { agent_id: 'a-scout', status: 'busy' } as AgentConnection;

  it('is active when the assigned agent has a busy connection', () => {
    expect(isAssigneeActive('a-coder', [online, busy])).toBe(true);
  });

  it('is not active when the assigned agent is only online/idle', () => {
    expect(isAssigneeActive('a-coder', [online])).toBe(false);
  });

  it('is not active when a different agent is busy', () => {
    expect(isAssigneeActive('a-coder', [otherBusy])).toBe(false);
  });

  it('is not active for an unassigned task', () => {
    expect(isAssigneeActive(null, [busy])).toBe(false);
    expect(isAssigneeActive(undefined, [busy])).toBe(false);
  });
});
