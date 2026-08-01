import { describe, expect, it } from 'vitest';
import {
  AGENT_RESULT_MESSAGE_KIND,
  buildMergeSynthesisPrompt,
  createMergeSynthesisPoller,
  isDurableMergeSynthesis,
  MERGE_SYNTHESIS_RECONCILE_MS,
  splitDivergence,
} from '../../src/lib/threadMerge';
import { QUOTED_CONTEXT_PREFIX } from '../../src/lib/quotedSessionContext';
import type { ChatSession, Message } from '../../src/types';

const PARENT = 'parent-session';
const FORK = 'fork-session';
const BOUNDARY = '20000000-0000-4000-8000-000000000010';
const BASELINE = '30000000-0000-4000-8000-000000000010';
const AT = '2026-07-31T12:00:00.000Z';

function fork(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: FORK,
    workspace_id: 'workspace',
    title: 'Split',
    model: 'auto',
    split_parent_id: PARENT,
    split_at: AT,
    split_baseline_message_id: BASELINE,
    split_source_boundary_message_id: BOUNDARY,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

function message(
  id: string,
  sessionId: string,
  createdAt: string,
  content = id,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    session_id: sessionId,
    role: 'user',
    sender_kind: 'user',
    sender_id: 'alice',
    sender_name: 'Alice',
    content,
    created_at: createdAt,
    ...overrides,
  };
}

const boundary = () => message(BOUNDARY, PARENT, '2026-07-31T11:59:59.000Z');
const baseline = () => message(
  BASELINE,
  FORK,
  '2026-07-31T12:00:00.010Z',
  `${QUOTED_CONTEXT_PREFIX}"Parent"`,
  { attachments: [{ id: 'file-1', name: 'diagram.png', type: 'image/png', size: 42 }] },
);

describe('split merge provenance', () => {
  it('treats an untouched fork baseline as pure cleanup', () => {
    const result = splitDivergence(fork(), [boundary()], [baseline()]);
    expect(result).toEqual({ ok: true, parent: [], fork: [] });
  });

  it('keeps evidence from both oversized branches inside one bounded synthesis prompt', () => {
    const parent = message(
      'parent-huge',
      PARENT,
      '2026-07-31T12:00:01.000Z',
      `PARENT_START ${'p'.repeat(16_000)} PARENT_END`,
    );
    const branch = message(
      'fork-huge',
      FORK,
      '2026-07-31T12:00:02.000Z',
      `FORK_START ${'f'.repeat(16_000)} FORK_END`,
    );
    const prompt = buildMergeSynthesisPrompt('Alternative', [parent], [branch], 2_048);
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(2_048);
    expect(prompt).toContain('PARENT_START');
    expect(prompt).toContain('PARENT_END');
    expect(prompt).toContain('FORK_START');
    expect(prompt).toContain('FORK_END');
    expect(prompt).toContain('=== This thread continued ===');
    expect(prompt).toContain('=== Split branch "Alternative" continued ===');
  });

  it('requires the server-authored result marker and rejects every terminal notice shape', () => {
    const seedId = 'merge-seed';
    const reply = message('reply', PARENT, '2026-07-31T12:00:03.000Z', 'Combined result', {
      role: 'assistant',
      sender_kind: 'agent',
      sender_id: 'agent-1',
      thread_parent_id: seedId,
      message_kind: AGENT_RESULT_MESSAGE_KIND,
    });
    expect(isDurableMergeSynthesis(reply, seedId)).toBe(true);
    expect(isDurableMergeSynthesis({ ...reply, message_kind: '' }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({
      ...reply,
      message_kind: '',
      content: 'Thinking 12s',
    }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({
      ...reply,
      message_kind: '',
      content: '@ada failed: connection lost',
    }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({
      ...reply,
      message_kind: '',
      content: '@ada stopped: it reached the hard time limit.',
    }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({
      ...reply,
      message_kind: '',
      content: '@ada is set to Relay, but no host is online.',
    }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({
      ...reply,
      message_kind: '',
      content: '@ada cannot start an Amp orb because support is unavailable.',
    }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({
      ...reply,
      message_kind: '',
      content: '@ada finished without output.',
    }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({ ...reply, sender_kind: 'assistant' }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({ ...reply, sender_id: '' }, seedId)).toBe(false);
    expect(isDurableMergeSynthesis({ ...reply, thread_parent_id: 'other-seed' }, seedId)).toBe(false);
  });

  it('reconciles a durable synthesis missed between the query and realtime subscription', async () => {
    const seedId = 'merge-seed';
    const reply = message('reply', PARENT, '2026-07-31T12:00:03.000Z', 'Combined result', {
      role: 'assistant',
      sender_kind: 'agent',
      sender_id: 'agent-1',
      thread_parent_id: seedId,
      message_kind: AGENT_RESULT_MESSAGE_KIND,
    });
    let loads = 0;
    let scheduled: (() => void) | null = null;
    let scheduledDelay = 0;
    let found = 0;
    const poller = createMergeSynthesisPoller({
      mergeSeedId: seedId,
      load: async () => (++loads === 1 ? [] : [reply]),
      onFound: async () => { found += 1; },
      schedule(callback, delay) {
        scheduled = callback;
        scheduledDelay = delay;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel() {},
    });

    await poller.start();
    expect(found).toBe(0);
    expect(scheduledDelay).toBe(MERGE_SYNTHESIS_RECONCILE_MS);
    expect(scheduled).not.toBeNull();

    scheduled?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(loads).toBe(2);
    expect(found).toBe(1);
    expect(scheduled).not.toBeNull();
    poller.stop();
  });

  it('separates parent-only and fork-only divergence', () => {
    const parentOnly = message('parent-new', PARENT, '2026-07-31T12:00:01.000Z');
    const forkOnly = message('fork-new', FORK, '2026-07-31T12:00:02.000Z');
    const result = splitDivergence(
      fork(),
      [parentOnly, boundary()],
      [forkOnly, baseline()],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parent.map(row => row.id)).toEqual(['parent-new']);
    expect(result.fork.map(row => row.id)).toEqual(['fork-new']);
  });

  it('does not use the fork message clock to classify native branch work', () => {
    const skewed = message(
      'fork-clock-skew',
      FORK,
      '2026-07-31T11:00:00.000Z',
      'native message created on a skewed client',
    );
    const result = splitDivergence(fork(), [boundary()], [baseline(), skewed]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fork.map(row => row.id)).toEqual(['fork-clock-skew']);
  });

  it('keeps same-content rows from different authors and a native quote-like prefix', () => {
    const a = message('fork-a', FORK, '2026-07-31T12:00:01.000Z', 'same', {
      sender_id: 'alice',
      sender_name: 'Alice',
    });
    const b = message('fork-b', FORK, '2026-07-31T12:00:02.000Z', 'same', {
      sender_kind: 'agent',
      sender_id: 'agent-1',
      sender_name: 'Agent',
    });
    const markerLike = message(
      'fork-marker-like',
      FORK,
      '2026-07-31T12:00:03.000Z',
      `${QUOTED_CONTEXT_PREFIX}"not provenance"`,
    );
    const result = splitDivergence(fork(), [boundary()], [baseline(), a, b, markerLike]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fork.map(row => row.id)).toEqual(['fork-a', 'fork-b', 'fork-marker-like']);
  });

  it('uses the compound source boundary when timestamps tie', () => {
    const beforeId = '10000000-0000-4000-8000-000000000001';
    const afterId = 'f0000000-0000-4000-8000-000000000001';
    const tiedBefore = message(beforeId, PARENT, boundary().created_at);
    const tiedAfter = message(afterId, PARENT, boundary().created_at);
    const result = splitDivergence(
      fork(),
      [tiedAfter, boundary(), tiedBefore],
      [baseline()],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parent.map(row => row.id)).toEqual([afterId]);
  });

  it('fails closed when exact provenance rows are absent', () => {
    expect(splitDivergence(fork(), [boundary()], [])).toEqual({
      ok: false,
      reason: 'split_baseline_not_loaded',
    });
    expect(splitDivergence(fork(), [], [baseline()])).toEqual({
      ok: false,
      reason: 'source_boundary_not_loaded',
    });
  });

  it('keeps bounded validated attachment references on the exact baseline row only', () => {
    const result = splitDivergence(fork(), [boundary()], [baseline()]);
    expect(result.ok).toBe(true);
    expect(baseline().attachments).toEqual([
      { id: 'file-1', name: 'diagram.png', type: 'image/png', size: 42 },
    ]);
    if (!result.ok) return;
    expect(result.fork).toEqual([]);
  });
});
