import { describe, expect, it } from 'vitest';
import {
  parseMessageClearMarker,
  serializeMessageClearMarker,
} from '../../src/lib/messageClearMarker';
import { compareMessagePosition } from '../../src/lib/messagePosition';

describe('local clear-view marker', () => {
  it('round-trips the newest server message compound position', () => {
    const value = serializeMessageClearMarker({
      id: 'message-b',
      created_at: '2026-07-31T12:00:00.000Z',
    });
    expect(value).toBe(JSON.stringify({
      createdAt: '2026-07-31T12:00:00.000Z',
      id: 'message-b',
    }));
    expect(parseMessageClearMarker(value)).toEqual({
      created_at: '2026-07-31T12:00:00.000Z',
      id: 'message-b',
    });
  });

  it('keeps later same-timestamp messages visible by comparing the id tie-breaker', () => {
    const marker = parseMessageClearMarker(JSON.stringify({
      createdAt: '2026-07-31T12:00:00.000Z',
      id: 'message-b',
    }));
    expect(marker).not.toBeNull();
    expect(compareMessagePosition(
      { id: 'message-a', created_at: marker!.created_at },
      marker!,
    )).toBeLessThan(0);
    expect(compareMessagePosition(
      { id: 'message-c', created_at: marker!.created_at },
      marker!,
    )).toBeGreaterThan(0);
  });

  it('keeps legacy browser timestamps readable and rejects malformed markers', () => {
    expect(parseMessageClearMarker('2026-07-31T12:00:00.000Z')).toEqual({
      created_at: '2026-07-31T12:00:00.000Z',
      id: '\uffff',
    });
    expect(parseMessageClearMarker('not-a-date')).toBeNull();
    expect(serializeMessageClearMarker({ id: '', created_at: 'not-a-date' })).toBeNull();
  });
});
