import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../../src/types';
import { projectActivity } from '../../src/lib/pm/projectActivity';

function event(over: Partial<ActivityEvent> & { id: string }): ActivityEvent {
  return {
    workspace_id: 'ws-1',
    user_id: null,
    event_type: 'task_updated',
    entity_type: 'task',
    entity_id: 't1',
    title: 'Task updated',
    metadata: {},
    created_at: '2026-10-13T10:00:00.000Z',
    ...over,
  };
}

describe('projectActivity', () => {
  const tasks = [{ id: 't1' }, { id: 't2' }];

  it('keeps task events for the project tasks and drops everything else', () => {
    const result = projectActivity(
      [
        event({ id: 'a', entity_id: 't1' }),
        event({ id: 'b', entity_id: 'other-project-task' }),
        event({ id: 'c', entity_type: 'document', entity_id: 't1' }),
        event({ id: 'd', entity_id: null }),
        event({ id: 'e', entity_id: 't2' }),
      ],
      tasks,
    );
    expect(result.map(item => item.id).sort()).toEqual(['a', 'e']);
  });

  it('sorts newest first', () => {
    const result = projectActivity(
      [
        event({ id: 'old', created_at: '2026-10-01T09:00:00.000Z' }),
        event({ id: 'new', created_at: '2026-10-12T09:00:00.000Z' }),
        event({ id: 'mid', created_at: '2026-10-05T09:00:00.000Z' }),
      ],
      tasks,
    );
    expect(result.map(item => item.id)).toEqual(['new', 'mid', 'old']);
  });

  it('caps the list at the limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, created_at: `2026-10-0${i + 1}T09:00:00.000Z` }));
    expect(projectActivity(many, tasks, 3).map(item => item.id)).toEqual(['e4', 'e3', 'e2']);
  });

  it('returns nothing for a project with no tasks', () => {
    expect(projectActivity([event({ id: 'a' })], [])).toEqual([]);
  });
});
