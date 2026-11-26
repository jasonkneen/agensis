import { describe, expect, it } from 'vitest';
import { groupActivityRuns, splitSubject } from '../../src/lib/activityRuns';

type E = { id: string; created_at: string; label: string; family: string };
const at = (h: number, m: number) => new Date(2026, 10, 25, h, m).toISOString();
const ev = (id: string, label: string, family: string, time: string): E => ({ id, label, family, created_at: time });
const group = (events: E[]) => groupActivityRuns(events, e => e.family, e => e.label);

describe('splitSubject', () => {
  it('reads an agent handle and a message sender', () => {
    expect(splitSubject('@coder connected', 'agents')).toEqual(['@coder', 'connected']);
    expect(splitSubject('Ada: shipped the build', 'messages')).toEqual(['Ada', 'message']);
    expect(splitSubject('Task created', 'tasks')).toBeNull();
  });
});

describe('groupActivityRuns', () => {
  it('collapses the connect/disconnect flapping from the real feed into one run', () => {
    const items = group([
      ev('1', '@coder connected', 'agents', at(21, 12)),
      ev('2', '@coder disconnected', 'agents', at(21, 12)),
      ev('3', '@coder connected', 'agents', at(21, 1)),
      ev('4', '@coder disconnected', 'agents', at(21, 1)),
      ev('5', '@coder connected', 'agents', at(20, 59)),
      ev('6', '@spark-1 connected', 'agents', at(19, 55)),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe('run');
    if (items[0].kind === 'run') {
      expect(items[0].run.subject).toBe('@coder');
      expect(items[0].run.events).toHaveLength(5);
      expect(items[0].run.verbs).toEqual([['connected', 3], ['disconnected', 2]]);
    }
    expect(items[1]).toEqual({ kind: 'event', event: expect.objectContaining({ id: '6' }) });
  });

  it('keeps short repeats as individual rows — two is not a run', () => {
    const items = group([
      ev('1', '@coder connected', 'agents', at(10, 0)),
      ev('2', '@coder disconnected', 'agents', at(9, 59)),
    ]);
    expect(items.map(i => i.kind)).toEqual(['event', 'event']);
  });

  it('breaks a run across a long gap and across families', () => {
    const items = group([
      ev('1', 'Ada: one', 'messages', at(12, 0)),
      ev('2', 'Ada: two', 'messages', at(11, 59)),
      ev('3', 'Ada: three', 'messages', at(8, 0)), // > 2h gap
      ev('4', '@ada connected', 'agents', at(7, 59)),
    ]);
    expect(items.every(i => i.kind === 'event')).toBe(true);
  });

  it('preserves order and never drops an event', () => {
    const events = Array.from({ length: 9 }, (_, i) => ev(String(i), i % 3 === 0 ? 'Task created' : '@x moved', i % 3 === 0 ? 'tasks' : 'agents', at(10, 59 - i)));
    const flat = group(events).flatMap(i => (i.kind === 'run' ? i.run.events : [i.event])).map(e => e.id);
    expect(flat).toEqual(events.map(e => e.id));
  });
});
