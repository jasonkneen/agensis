import { describe, expect, it } from 'vitest';
import { activityActor } from '../../src/lib/activityFamily';

describe('activityActor', () => {
  it('reads the recorded actor, including metadata that arrives as a JSON string', () => {
    expect(activityActor({ event_type: 'task_updated', metadata: { actor_kind: 'agent' } })).toBe('agent');
    expect(activityActor({ event_type: 'task_updated', metadata: JSON.stringify({ actor_kind: 'person' }) })).toBe('person');
  });

  it('falls back to the family for older rows with no actor', () => {
    expect(activityActor({ event_type: 'agent_connected', metadata: {} })).toBe('agent');
    expect(activityActor({ event_type: 'task_created', metadata: null })).toBe('person');
  });

  it('ignores an unknown actor value', () => {
    expect(activityActor({ event_type: 'task_created', metadata: { actor_kind: 'robot' } })).toBe('person');
  });
});
