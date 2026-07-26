import { afterEach, describe, expect, it } from 'vitest';
import {
  TOOL_STEP_STALE_MS,
  bucketToolSteps,
  buildTranscriptRows,
  clearThinkingElapsed,
  isStaleStepGroup,
  isStepGroupLive,
  isToolStepMessage,
  recallThinkingElapsed,
  rememberThinkingElapsed,
  resolveGroupChips,
  toolStepParts,
  type TranscriptStepRow,
} from '../../src/components/chat/toolSteps';
import {
  activityChipLabel,
  activityElapsed,
  activitySeenAtMs,
  isLiveActivityPlaceholder,
  parseElapsedMs,
  thoughtChipLabel,
} from '../../src/lib/activityStatus';
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

/** The daemon's in-progress placeholder: an agent message whose whole body is a verb. */
function thinking(seconds = '4s', overrides: Partial<Message> = {}): Message {
  return msg({ sender_kind: 'agent', sender_id: 'agent-1', content: `Thinking ${seconds}`, ...overrides });
}

afterEach(() => {
  clearThinkingElapsed();
});

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

  it('assumes still-live when the timestamp is unusable', () => {
    expect(isStaleStepGroup([step({ created_at: 'not a date' })], now)).toBe(false);
    expect(isStaleStepGroup([], now)).toBe(false);
  });

  it('finds the newest member wherever it sits, not just at the tail', () => {
    // A thinking placeholder is inserted at dispatch, so it can be appended to the
    // group AFTER steps that are newer than it.
    const steps = [
      step({ created_at: new Date(now - 500).toISOString() }),
      thinking('2m 0s', { created_at: new Date(now - 10 * TOOL_STEP_STALE_MS).toISOString() }),
    ];
    expect(isStaleStepGroup(steps, now)).toBe(false);
  });
});

describe('activityElapsed', () => {
  it('reads the duration the server baked into the placeholder', () => {
    expect(activityElapsed('Thinking 0s')).toBe('0s');
    expect(activityElapsed('Thinking 43s')).toBe('43s');
    expect(activityElapsed('Thinking 1m 4s')).toBe('1m 4s');
    expect(activityElapsed('  thinking 12s  ')).toBe('12s');
  });

  it('refuses anything that is not a bare duration', () => {
    expect(activityElapsed('Thinking')).toBe('');
    expect(activityElapsed('Thinking about the schema')).toBe('');
    expect(activityElapsed('reading src/App.tsx')).toBe('');
    expect(activityElapsed('')).toBe('');
  });
});

describe('chip labels', () => {
  it('keeps the clock on the live chip', () => {
    expect(activityChipLabel('Thinking 1m 4s')).toBe('Thinking 1m 4s');
  });

  it('falls back to the shared status line when there is no clock', () => {
    expect(activityChipLabel('thinking')).toBe('Thinking…');
    expect(activityChipLabel('reading src/App.tsx')).toBe('Reading src/App.tsx…');
  });

  it('puts the finished period in the past tense', () => {
    expect(thoughtChipLabel('1m 4s')).toBe('Thought for 1m 4s');
  });
});

describe('thinking elapsed memo', () => {
  it('remembers the last elapsed seen for a placeholder', () => {
    rememberThinkingElapsed('m-1', '3s');
    rememberThinkingElapsed('m-1', '9s');
    expect(recallThinkingElapsed('m-1')).toBe('9s');
  });

  it('ignores an empty id or elapsed instead of storing a blank', () => {
    rememberThinkingElapsed('', '9s');
    rememberThinkingElapsed('m-2', '');
    expect(recallThinkingElapsed('m-2')).toBe('');
  });

  it('evicts the least recently touched entry once it is full', () => {
    for (let index = 0; index < 300; index += 1) rememberThinkingElapsed(`k${index}`, `${index}s`);
    expect(recallThinkingElapsed('k0')).toBe('');
    expect(recallThinkingElapsed('k299')).toBe('299s');
  });
});

describe('buildTranscriptRows — thinking placeholders', () => {
  it('folds a live placeholder into the run instead of breaking it into a bubble', () => {
    const rows = buildTranscriptRows([step(), thinking(), step()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('steps');
    if (rows[0].kind !== 'steps') return;
    expect(rows[0].steps).toHaveLength(2);
    expect(rows[0].thinking).toHaveLength(1);
  });

  it('opens a group on a placeholder that arrives before any tool call', () => {
    const rows = buildTranscriptRows([thinking('0s'), step()]);
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== 'steps') throw new Error('expected a step row');
    expect(rows[0].thinking).toHaveLength(1);
    expect(rows[0].steps).toHaveLength(1);
  });

  it('never counts a placeholder as a tool call', () => {
    const rows = buildTranscriptRows([thinking(), thinking('9s')]);
    if (rows[0].kind !== 'steps') throw new Error('expected a step row');
    expect(rows[0].steps).toEqual([]);
    expect(bucketToolSteps(rows[0].steps)).toEqual([]);
  });

  it('does not merge a placeholder into another agent\'s run', () => {
    const rows = buildTranscriptRows([step({ sender_id: 'a' }), thinking('1s', { sender_id: 'b' })]);
    expect(rows.map(row => row.kind)).toEqual(['steps', 'steps']);
  });

  it('hands the elapsed on as a settled thought once the placeholder becomes the reply', () => {
    const reply = msg({ sender_kind: 'agent', sender_id: 'agent-1', content: 'Here is the answer' });
    const rows = buildTranscriptRows([step(), reply], id => (id === reply.id ? '15s' : ''));
    expect(rows.map(row => row.kind)).toEqual(['steps', 'message']);
    if (rows[0].kind !== 'steps') return;
    expect(rows[0].thoughts).toEqual([{ id: reply.id, elapsed: '15s' }]);
  });

  it('gives the thought a chip row of its own when no run precedes the reply', () => {
    const reply = msg({ sender_kind: 'agent', sender_id: 'agent-1', content: 'Here is the answer' });
    const rows = buildTranscriptRows(
      [msg({ role: 'user', sender_id: 'user-1' }), reply],
      id => (id === reply.id ? '15s' : ''),
    );
    expect(rows.map(row => row.kind)).toEqual(['message', 'steps', 'message']);
    if (rows[1].kind !== 'steps') return;
    // Sits directly above the reply, and never steals the scroll anchor from it.
    expect(rows[1].thoughts).toEqual([{ id: reply.id, elapsed: '15s' }]);
    expect(rows[1].index).toBe(-1);
    expect(rows[2].kind === 'message' && rows[2].message.id).toBe(reply.id);
  });

  it('does not attach a thought to a run belonging to a different sender', () => {
    const reply = msg({ sender_kind: 'agent', sender_id: 'agent-2', content: 'done' });
    const rows = buildTranscriptRows([step({ sender_id: 'agent-1' }), reply], id => (id === reply.id ? '15s' : ''));
    expect(rows.map(row => row.kind)).toEqual(['steps', 'steps', 'message']);
    if (rows[0].kind !== 'steps') return;
    expect(rows[0].thoughts).toEqual([]);
  });

  it('reads the memo the live chip wrote when no lookup is supplied', () => {
    const reply = msg({ sender_kind: 'agent', sender_id: 'agent-1', content: 'done' });
    rememberThinkingElapsed(reply.id, '7s');
    const rows = buildTranscriptRows([step(), reply]);
    if (rows[0].kind !== 'steps') throw new Error('expected a step row');
    expect(rows[0].thoughts).toEqual([{ id: reply.id, elapsed: '7s' }]);
  });

  it('shows no thought chip for a run this client never watched', () => {
    const rows = buildTranscriptRows([step(), msg({ sender_id: 'agent-1', content: 'done' })]);
    if (rows[0].kind !== 'steps') throw new Error('expected a step row');
    expect(rows[0].thoughts).toEqual([]);
  });

  it('still marks a run ended once its placeholder has turned into a reply', () => {
    const rows = buildTranscriptRows([thinking(), step(), msg({ sender_id: 'agent-1', content: 'done' })]);
    expect(rows[0].kind === 'steps' && rows[0].endedByReply).toBe(true);
  });
});

describe('parseElapsedMs', () => {
  it('reads back the durations the server writes', () => {
    expect(parseElapsedMs('0s')).toBe(0);
    expect(parseElapsedMs('43s')).toBe(43000);
    expect(parseElapsedMs('1m 4s')).toBe(64000);
    expect(parseElapsedMs('12m 0s')).toBe(720000);
  });

  it('is zero for anything that is not a duration', () => {
    expect(parseElapsedMs('')).toBe(0);
    expect(parseElapsedMs('soon')).toBe(0);
  });
});

describe('activitySeenAtMs', () => {
  const created = Date.UTC(2026, 0, 1, 12, 0, 0);
  const iso = new Date(created).toISOString();

  it('credits a placeholder with the clock ticking inside its own content', () => {
    // The row is only ever INSERTed once — the daemon rewrites the content about
    // once a second and no column records that — so the elapsed is the only proof
    // a long, silent turn is still running.
    expect(activitySeenAtMs({ created_at: iso, content: 'Thinking 2m 11s' })).toBe(created + 131000);
  });

  it('falls back to the row\'s own timestamp when there is no duration to read', () => {
    expect(activitySeenAtMs({ created_at: iso, content: 'Bash · git log' })).toBe(created);
    expect(activitySeenAtMs({ created_at: iso, content: 'Thinking…' })).toBe(created);
  });

  it('reports no clock at all rather than guessing one', () => {
    expect(Number.isNaN(activitySeenAtMs({ created_at: 'not a date', content: 'Thinking 4s' }))).toBe(true);
    expect(Number.isNaN(activitySeenAtMs({}))).toBe(true);
  });
});

describe('isLiveActivityPlaceholder', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const placeholder = (ageMs: number, content = 'Thinking 4s') => ({
    sender_kind: 'agent',
    content,
    created_at: new Date(now - ageMs).toISOString(),
  });

  it('accepts a placeholder that is still ticking', () => {
    expect(isLiveActivityPlaceholder(placeholder(1000), now)).toBe(true);
  });

  it('rejects one whose run demonstrably ended hours ago', () => {
    // The exact shape that kept the composer claiming "@coder is thinking" long
    // after the job was gone.
    expect(isLiveActivityPlaceholder(placeholder(4 * 60 * 60 * 1000, 'Thinking 2m 11s'), now)).toBe(false);
  });

  it('keeps a long silent run alive on its own elapsed', () => {
    // Ten minutes since the row was inserted, but the daemon is still counting —
    // judging on created_at alone would call a healthy turn dead after one minute.
    expect(isLiveActivityPlaceholder(placeholder(10 * 60 * 1000, 'Thinking 10m 0s'), now)).toBe(true);
  });

  it('never treats a real message as evidence of work in progress', () => {
    expect(isLiveActivityPlaceholder({ sender_kind: 'agent', content: 'Here is the answer', created_at: new Date(now).toISOString() }, now)).toBe(false);
  });
});

describe('isStepGroupLive', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const at = (ageMs: number) => new Date(now - ageMs).toISOString();

  function group(overrides: Partial<TranscriptStepRow> = {}): TranscriptStepRow {
    return {
      kind: 'steps', key: 'k', steps: [], thinking: [], thoughts: [],
      index: 0, endedByReply: false, senderKey: 'agent-1',
      ...overrides,
    };
  }

  it('is live while the run is still producing steps', () => {
    expect(isStepGroupLive(group({ steps: [step({ created_at: at(2000) })] }), now)).toBe(true);
  });

  it('is over once the agent has posted a real message since', () => {
    expect(isStepGroupLive(group({ steps: [step({ created_at: at(2000) })], endedByReply: true }), now)).toBe(false);
  });

  it('is over once nothing in it has shown a sign of life inside the window', () => {
    expect(isStepGroupLive(group({ steps: [step({ created_at: at(TOOL_STEP_STALE_MS + 5000) })] }), now)).toBe(false);
  });

  it('survives server/browser clock skew inside the slack', () => {
    // The server stamped created_at 40s ago by its own clock; the browser's is
    // behind. Tightening the window is what would kill a genuinely live run.
    expect(isStepGroupLive(group({ steps: [step({ created_at: at(TOOL_STEP_STALE_MS - 20000) })] }), now)).toBe(true);
    // Even a timestamp from the FUTURE (browser behind the server) stays live.
    expect(isStepGroupLive(group({ steps: [step({ created_at: at(-5000) })] }), now)).toBe(true);
  });
});

describe('resolveGroupChips', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const at = (ageMs: number) => new Date(now - ageMs).toISOString();

  function group(overrides: Partial<TranscriptStepRow> = {}): TranscriptStepRow {
    return {
      kind: 'steps', key: 'k', steps: [], thinking: [], thoughts: [],
      index: 0, endedByReply: false, senderKey: 'agent-1',
      ...overrides,
    };
  }

  it('leaves a fresh thinking chip live and ticking', () => {
    const placeholder = thinking('4s', { created_at: at(1000) });
    const chips = resolveGroupChips(group({ thinking: [placeholder] }), now);
    expect(chips.live).toBe(true);
    expect(chips.thinking).toEqual([placeholder]);
    expect(chips.thoughts).toEqual([]);
  });

  it('settles a placeholder stranded by a job that never finished', () => {
    // The reported bug: a thread from hours ago still showing "Thinking 2m 11s"
    // highlighted and animating, with zero queued or running jobs behind it.
    const stranded = thinking('2m 11s', { created_at: at(4 * 60 * 60 * 1000) });
    const chips = resolveGroupChips(group({ thinking: [stranded] }), now);
    expect(chips.live).toBe(false);
    expect(chips.thinking).toEqual([]);
    expect(chips.thoughts).toEqual([{ id: stranded.id, elapsed: '2m 11s' }]);
    expect(thoughtChipLabel(chips.thoughts[0].elapsed)).toBe('Thought for 2m 11s');
  });

  it('settles the whole strip once the agent has replied, however recent', () => {
    const placeholder = thinking('9s', { created_at: at(500) });
    const chips = resolveGroupChips(group({ thinking: [placeholder], endedByReply: true }), now);
    expect(chips.live).toBe(false);
    expect(chips.thoughts).toEqual([{ id: placeholder.id, elapsed: '9s' }]);
  });

  it('keeps the periods already settled ahead of the ones it just settled', () => {
    const earlier = { id: 'thought-1', elapsed: '30s' };
    const stranded = thinking('1m 2s', { created_at: at(6 * 60 * 60 * 1000) });
    const chips = resolveGroupChips(group({ thoughts: [earlier], thinking: [stranded] }), now);
    expect(chips.thoughts).toEqual([earlier, { id: stranded.id, elapsed: '1m 2s' }]);
  });

  it('drops a settled placeholder that measured nothing rather than inventing a period', () => {
    const noClock = msg({ sender_kind: 'agent', content: 'Thinking…', created_at: at(3 * 60 * 60 * 1000) });
    const zero = thinking('0s', { created_at: at(3 * 60 * 60 * 1000) });
    const chips = resolveGroupChips(group({ thinking: [noClock, zero] }), now);
    expect(chips.live).toBe(false);
    expect(chips.thinking).toEqual([]);
    expect(chips.thoughts).toEqual([]);
  });

  it('does not settle a live run just because its placeholder row is old', () => {
    // A ten-minute think with no tool calls: created_at is stale, the elapsed is not.
    const placeholder = thinking('10m 0s', { created_at: at(10 * 60 * 1000) });
    expect(resolveGroupChips(group({ thinking: [placeholder] }), now).live).toBe(true);
  });
});

describe('a job that failed', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  // finalizeStuckJob rewrites the placeholder's content in place with this.
  const FAILURE = '@coder stopped responding (the backend restarted). Send again to retry — if it keeps happening, reconnect the daemon from AI Agents.';

  it('reads as a real message, never as an activity placeholder', () => {
    const failed = msg({ sender_kind: 'agent', sender_id: 'agent-1', content: FAILURE, created_at: new Date(now).toISOString() });
    expect(isLiveActivityPlaceholder(failed, now)).toBe(false);
    const rows = buildTranscriptRows([step({ created_at: new Date(now).toISOString() }), failed]);
    expect(rows.map(row => row.kind)).toEqual(['steps', 'message']);
    if (rows[1].kind !== 'message') return;
    expect(rows[1].message.content).toBe(FAILURE);
  });

  it('ends the run it belonged to, so no chip beside it claims to be working', () => {
    const rows = buildTranscriptRows([
      thinking('2m 11s', { created_at: new Date(now).toISOString() }),
      msg({ sender_kind: 'agent', sender_id: 'agent-1', content: FAILURE, created_at: new Date(now).toISOString() }),
    ]);
    if (rows[0].kind !== 'steps') throw new Error('expected a step row');
    const chips = resolveGroupChips(rows[0], now);
    expect(chips.live).toBe(false);
    expect(chips.thinking).toEqual([]);
  });
});
