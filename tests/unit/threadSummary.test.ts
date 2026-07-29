import { describe, it, expect } from 'vitest';
import {
  THREAD_SUMMARY_AVATAR_CAP,
  buildThreadReplySummaries,
  formatLastReplyTime,
} from '../../src/lib/threadSummary';
import type { Message } from '../../src/types';

function reply(over: Partial<Message> & { id: string; created_at: string }): Message {
  return {
    session_id: 's1',
    role: 'assistant',
    content: 'hi',
    thread_parent_id: 'm1',
    ...over,
  } as Message;
}

const noAvatars = () => '';

describe('buildThreadReplySummaries', () => {
  it('ignores top-level messages and counts only replies', () => {
    const summaries = buildThreadReplySummaries(
      [
        { id: 'm1', session_id: 's1', role: 'user', content: 'q', created_at: '2026-07-24T10:00:00Z' } as Message,
        reply({ id: 'r1', created_at: '2026-07-24T10:01:00Z', sender_id: 'a1', sender_name: 'Ada' }),
        reply({ id: 'r2', created_at: '2026-07-24T10:02:00Z', sender_id: 'a2', sender_name: 'Bo' }),
      ],
      noAvatars,
    );
    expect(Object.keys(summaries)).toEqual(['m1']);
    expect(summaries.m1.count).toBe(2);
    expect(summaries.m1.lastReplyAt).toBe('2026-07-24T10:02:00Z');
  });

  it('splits tool-call steps out of count into toolCount', () => {
    const summaries = buildThreadReplySummaries(
      [
        reply({ id: 'r1', created_at: '2026-07-24T10:01:00Z', sender_id: 'a1', sender_name: 'Ada' }),
        reply({ id: 't1', created_at: '2026-07-24T10:01:30Z', sender_id: 'a1', sender_name: 'Ada', message_kind: 'tool_step' }),
        reply({ id: 't2', created_at: '2026-07-24T10:01:45Z', sender_id: 'a1', sender_name: 'Ada', message_kind: 'tool_step' }),
        reply({ id: 'r2', created_at: '2026-07-24T10:02:00Z', sender_id: 'a2', sender_name: 'Bo' }),
      ],
      noAvatars,
    );
    expect(summaries.m1.count).toBe(2);
    expect(summaries.m1.toolCount).toBe(2);
    // The last REAL reply, not the last tool step, even though a step landed later.
    expect(summaries.m1.lastReplyAt).toBe('2026-07-24T10:02:00Z');
  });

  it('reports toolCount 0 for a thread with no tool steps', () => {
    const summaries = buildThreadReplySummaries(
      [reply({ id: 'r1', created_at: '2026-07-24T10:01:00Z', sender_id: 'a1', sender_name: 'Ada' })],
      noAvatars,
    );
    expect(summaries.m1.toolCount).toBe(0);
  });

  it('dedupes participants and keeps the most recent speakers, oldest-first', () => {
    const summaries = buildThreadReplySummaries(
      [
        reply({ id: 'r1', created_at: '2026-07-24T10:01:00Z', sender_id: 'a1', sender_name: 'Ada' }),
        reply({ id: 'r2', created_at: '2026-07-24T10:02:00Z', sender_id: 'a2', sender_name: 'Bo' }),
        reply({ id: 'r3', created_at: '2026-07-24T10:03:00Z', sender_id: 'a1', sender_name: 'Ada' }),
      ],
      noAvatars,
    );
    expect(summaries.m1.count).toBe(3);
    expect(summaries.m1.participants.map(p => p.key)).toEqual(['a2', 'a1']);
    expect(summaries.m1.overflow).toBe(0);
  });

  it('caps avatars and reports the remainder as overflow', () => {
    const summaries = buildThreadReplySummaries(
      ['a1', 'a2', 'a3', 'a4', 'a5'].map((id, i) =>
        reply({ id: `r${i}`, created_at: `2026-07-24T10:0${i}:00Z`, sender_id: id, sender_name: id })),
      noAvatars,
    );
    expect(summaries.m1.participants).toHaveLength(THREAD_SUMMARY_AVATAR_CAP);
    // Newest three speakers, rendered oldest-first.
    expect(summaries.m1.participants.map(p => p.key)).toEqual(['a3', 'a4', 'a5']);
    expect(summaries.m1.overflow).toBe(2);
  });

  it('orders by created_at even when the input list is unsorted', () => {
    const summaries = buildThreadReplySummaries(
      [
        reply({ id: 'r2', created_at: '2026-07-24T10:05:00Z', sender_id: 'a2', sender_name: 'Bo' }),
        reply({ id: 'r1', created_at: '2026-07-24T10:01:00Z', sender_id: 'a1', sender_name: 'Ada' }),
      ],
      noAvatars,
    );
    expect(summaries.m1.lastReplyAt).toBe('2026-07-24T10:05:00Z');
    expect(summaries.m1.participants.map(p => p.key)).toEqual(['a1', 'a2']);
  });

  it('resolves avatars through the injected lookup and flags agents', () => {
    const summaries = buildThreadReplySummaries(
      [
        reply({ id: 'r1', created_at: '2026-07-24T10:01:00Z', sender_id: 'a1', sender_name: 'Ada', sender_kind: 'agent' }),
        reply({ id: 'r2', created_at: '2026-07-24T10:02:00Z', role: 'user', sender_id: 'u1', sender_name: 'Jason', sender_kind: 'user' }),
      ],
      m => (m.sender_kind === 'agent' ? 'pet:cat' : ''),
    );
    const [user, agent] = [summaries.m1.participants[1], summaries.m1.participants[0]];
    expect(agent).toMatchObject({ key: 'a1', avatar: 'pet:cat', isAgent: true });
    expect(user).toMatchObject({ key: 'u1', avatar: '', isAgent: false });
  });

  it('falls back to a sender name, then role, for identity', () => {
    const summaries = buildThreadReplySummaries(
      [
        reply({ id: 'r1', created_at: '2026-07-24T10:01:00Z', sender_name: 'Ada' }),
        reply({ id: 'r2', created_at: '2026-07-24T10:02:00Z' }),
      ],
      noAvatars,
    );
    expect(summaries.m1.participants.map(p => p.key)).toEqual(['Ada', 'assistant']);
    expect(summaries.m1.participants.map(p => p.name)).toEqual(['Ada', 'Assistant']);
  });
});

describe('formatLastReplyTime', () => {
  const now = new Date('2026-07-24T12:00:00Z').getTime();
  const at = (iso: string) => formatLastReplyTime(iso, now);

  it('returns empty string for missing or unparseable input', () => {
    expect(formatLastReplyTime(null, now)).toBe('');
    expect(formatLastReplyTime(undefined, now)).toBe('');
    expect(formatLastReplyTime('not-a-date', now)).toBe('');
  });

  it('spells out minutes, hours and days', () => {
    expect(at('2026-07-24T11:59:30Z')).toBe('just now');
    expect(at('2026-07-24T11:59:00Z')).toBe('1 minute ago');
    expect(at('2026-07-24T11:36:00Z')).toBe('24 minutes ago');
    expect(at('2026-07-24T09:00:00Z')).toBe('3 hours ago');
    expect(at('2026-07-22T12:00:00Z')).toBe('2 days ago');
  });

  it('switches to a date past a week', () => {
    expect(at('2026-07-10T12:00:00Z')).toMatch(/^on /);
  });

  it('never reports a future reply as negative', () => {
    expect(at('2026-07-24T12:05:00Z')).toBe('just now');
  });
});
