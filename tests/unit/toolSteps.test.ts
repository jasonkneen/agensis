import { describe, expect, it } from 'vitest';
import {
  TOOL_STEP_STALE_MS,
  bucketToolSteps,
  buildTranscriptRows,
  isStaleStepGroup,
  isToolStepMessage,
  toolStepParts,
} from '../../src/components/chat/toolSteps';
import type { Message } from '../../src/types';

let seq = 0;

function msg(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    session_id: 's1',
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function step(overrides: Partial<Message> = {}): Message {
  return msg({ message_kind: 'tool_step', sender_id: 'agent-1', ...overrides });
}

describe('isToolStepMessage', () => {
  it('only matches the tool_step kind', () => {
    expect(isToolStepMessage(step())).toBe(true);
    expect(isToolStepMessage(msg())).toBe(false);
    expect(isToolStepMessage(msg({ message_kind: '' }))).toBe(false);
    expect(isToolStepMessage(msg({ message_kind: null }))).toBe(false);
    expect(isToolStepMessage(undefined)).toBe(false);
  });
});

describe('toolStepParts', () => {
  it('prefers the structured columns', () => {
    const parts = toolStepParts(step({ tool_name: 'Read', tool_detail: 'src/App.tsx', content: 'ignored · nope' }));
    expect(parts).toEqual({ name: 'Read', detail: 'src/App.tsx' });
  });

  it('keeps a structured name that has no detail', () => {
    expect(toolStepParts(step({ tool_name: 'TodoWrite' }))).toEqual({ name: 'TodoWrite', detail: '' });
  });

  it('recovers both halves from content when the columns are empty', () => {
    const parts = toolStepParts(step({ content: 'Bash · cd ~/repo && git log' }));
    expect(parts).toEqual({ name: 'Bash', detail: 'cd ~/repo && git log' });
  });

  it('splits on the first separator only, so detail keeps its own middots', () => {
    expect(toolStepParts(step({ content: 'Bash · echo a · b' }))).toEqual({ name: 'Bash', detail: 'echo a · b' });
  });

  it('does not invent a tool name from prose that happens to contain a middot', () => {
    expect(toolStepParts(step({ content: 'well then · something happened' })))
      .toEqual({ name: '', detail: 'well then · something happened' });
  });

  it('falls back to the whole content when there is no separator', () => {
    expect(toolStepParts(step({ content: 'doing something' }))).toEqual({ name: '', detail: 'doing something' });
  });

  it('collapses whitespace so a chip can never wrap to two lines', () => {
    expect(toolStepParts(step({ content: '  Bash ·  git\n  log  ' }))).toEqual({ name: 'Bash', detail: 'git log' });
  });

  it('survives a non-string content payload', () => {
    expect(toolStepParts(step({ content: undefined as unknown as string }))).toEqual({ name: '', detail: '' });
  });
});

describe('bucketToolSteps', () => {
  it('counts per tool and orders buckets by first appearance', () => {
    const buckets = bucketToolSteps([
      step({ tool_name: 'Bash' }),
      step({ tool_name: 'Grep' }),
      step({ tool_name: 'Bash' }),
    ]);
    expect(buckets.map(b => [b.name, b.steps.length])).toEqual([['Bash', 2], ['Grep', 1]]);
  });

  it('files unnamed steps under a single fallback bucket', () => {
    const buckets = bucketToolSteps([step({ content: 'just doing a thing' }), step({ tool_name: 'Read' })]);
    expect(buckets.map(b => b.name)).toEqual(['Step', 'Read']);
  });
});

describe('buildTranscriptRows', () => {
  it('leaves a list with no steps completely alone', () => {
    const messages = [msg(), msg(), msg()];
    const rows = buildTranscriptRows(messages);
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.kind === 'message')).toBe(true);
  });

  it('collapses consecutive steps from one agent into a single row', () => {
    const messages = [msg({ role: 'user', sender_id: 'user-1' }), step(), step(), step()];
    const rows = buildTranscriptRows(messages);
    expect(rows).toHaveLength(2);
    expect(rows[1].kind).toBe('steps');
    if (rows[1].kind === 'steps') expect(rows[1].steps).toHaveLength(3);
  });

  it('does not merge steps from different agents', () => {
    const rows = buildTranscriptRows([step({ sender_id: 'a' }), step({ sender_id: 'b' })]);
    expect(rows.map(row => row.kind)).toEqual(['steps', 'steps']);
  });

  it('does not merge steps separated by a real message', () => {
    const rows = buildTranscriptRows([step(), msg({ sender_id: 'agent-1' }), step()]);
    expect(rows.map(row => row.kind)).toEqual(['steps', 'message', 'steps']);
  });

  it('preserves order and message identity', () => {
    const a = msg({ role: 'user', sender_id: 'user-1' });
    const s = step();
    const b = msg({ sender_id: 'agent-1' });
    const rows = buildTranscriptRows([a, s, b]);
    expect(rows[0].kind === 'message' && rows[0].message.id).toBe(a.id);
    expect(rows[1].kind === 'steps' && rows[1].steps[0].id).toBe(s.id);
    expect(rows[2].kind === 'message' && rows[2].message.id).toBe(b.id);
  });

  it('reports the index of the last step so scroll anchoring still lands', () => {
    const messages = [msg({ role: 'user', sender_id: 'user-1' }), step(), step()];
    const rows = buildTranscriptRows(messages);
    expect(rows[1].index).toBe(messages.length - 1);
  });

  it('marks a group ended once that agent posts a real message after it', () => {
    const rows = buildTranscriptRows([step(), msg({ sender_id: 'agent-1' })]);
    expect(rows[0].kind === 'steps' && rows[0].endedByReply).toBe(true);
  });

  it('still ends the group when a user message sits between it and the reply', () => {
    const rows = buildTranscriptRows([
      step(),
      msg({ role: 'user', sender_id: 'user-1' }),
      msg({ sender_id: 'agent-1' }),
    ]);
    expect(rows[0].kind === 'steps' && rows[0].endedByReply).toBe(true);
  });

  it('leaves a trailing group live when only another agent has spoken since', () => {
    const rows = buildTranscriptRows([step({ sender_id: 'agent-1' }), msg({ sender_id: 'agent-2' })]);
    expect(rows[0].kind === 'steps' && rows[0].endedByReply).toBe(false);
  });

  it('leaves the newest group live when nothing follows it', () => {
    const rows = buildTranscriptRows([msg({ sender_id: 'agent-1' }), step()]);
    expect(rows[1].kind === 'steps' && rows[1].endedByReply).toBe(false);
  });
});

describe('isStaleStepGroup', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('treats a just-arrived group as live', () => {
    const steps = [step({ created_at: new Date(now - 1000).toISOString() })];
    expect(isStaleStepGroup(steps, now)).toBe(false);
  });

  it('treats scrollback as already settled', () => {
    const steps = [step({ created_at: new Date(now - TOOL_STEP_STALE_MS - 1000).toISOString() })];
    expect(isStaleStepGroup(steps, now)).toBe(true);
  });

  it('judges by the newest step, not the oldest', () => {
    const steps = [
      step({ created_at: new Date(now - 10 * TOOL_STEP_STALE_MS).toISOString() }),
      step({ created_at: new Date(now - 500).toISOString() }),
    ];
    expect(isStaleStepGroup(steps, now)).toBe(false);
  });

  it('leaves the quiet timer in charge when the timestamp is unusable', () => {
    expect(isStaleStepGroup([step({ created_at: 'not a date' })], now)).toBe(false);
    expect(isStaleStepGroup([], now)).toBe(false);
  });
});
