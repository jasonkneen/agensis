import { describe, expect, it } from 'vitest';
import { agentTriageCounts } from '../../src/components/agents/AgentTriageStrip';

const agents = [{ id: 'a1' }, { id: 'a2' }];
const now = new Date('2026-11-26T15:00:00');
const task = (assignee_id: string | null, status: string, completed_at: string | null = null) =>
  ({ assignee_id, status, completed_at, parent_id: null }) as never;

describe('agentTriageCounts', () => {
  it('counts only tasks assigned to an agent', () => {
    const counts = agentTriageCounts(agents, [
      task('a1', 'in_review'),
      task('human-1', 'in_review'),
      task(null, 'todo'),
      task('a2', 'todo'),
      task('a2', 'backlog'),
    ], 1, now);
    expect(counts).toEqual({ needsYou: 1, working: 1, queued: 2, doneToday: 0 });
  });

  it('done today means completed since local midnight, not ever', () => {
    const counts = agentTriageCounts(agents, [
      task('a1', 'done', '2026-11-26T09:00:00'),
      task('a1', 'done', '2026-11-25T23:59:00'),
      task('a2', 'done', null),
    ], 0, now);
    expect(counts.doneToday).toBe(1);
  });

  it('ignores in-progress and cancelled work in the task counts', () => {
    const counts = agentTriageCounts(agents, [task('a1', 'in_progress'), task('a1', 'cancelled')], 0, now);
    expect(counts).toEqual({ needsYou: 0, working: 0, queued: 0, doneToday: 0 });
  });
});
