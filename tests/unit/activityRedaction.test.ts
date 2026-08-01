import { describe, expect, it } from 'vitest';
import { redactActivityEvents } from '../../src/lib/activityRedaction';
import type { ActivityEvent } from '../../src/types';

function event(id: string, entityId: string, sessionId: string): ActivityEvent {
  return {
    id,
    workspace_id: 'workspace-1',
    user_id: null,
    event_type: 'message_sent',
    entity_type: 'message',
    entity_id: entityId,
    title: `Leaked body ${id}`,
    metadata: JSON.stringify({ session_id: sessionId, content: `Leaked body ${id}` }) as unknown as Record<string, unknown>,
    created_at: '2026-07-31T00:00:00.000Z',
  };
}

describe('redactActivityEvents', () => {
  it('evicts one stale message body by its trusted entity id', () => {
    const events = [event('a1', 'm1', 's1'), event('a2', 'm2', 's1')];
    expect(redactActivityEvents(events, { messageId: 'm1' }).map(row => row.id)).toEqual(['a2']);
  });

  it('evicts every stale body from a cleared session and preserves other events', () => {
    const connected: ActivityEvent = {
      ...event('connection', 'agent-1', 's1'),
      event_type: 'agent_connected',
    };
    const events = [event('a1', 'm1', 's1'), event('a2', 'm2', 's2'), connected];
    expect(redactActivityEvents(events, { sessionId: 's1' }).map(row => row.id)).toEqual(['a2', 'connection']);
  });
});
