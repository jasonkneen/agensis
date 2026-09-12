import { describe, it, expect } from 'vitest';
import { runPickSend, resolveAlwaysHandle } from '../../src/providers/PickerProvider';
import type { MarkupAgent } from '../../src/components/chat/MarkupToolbarControl';

// These cover the two decisions the global picker's send path turns on — the
// ones a human notices when they fail: do the optimistically-cleared marks come
// back, and does a stale "always send" handle quietly target a departed agent.

describe('runPickSend — restore-on-failure decision', () => {
  it('restores when the send throws synchronously', async () => {
    const { restore } = await runPickSend(() => { throw new Error('boom'); });
    expect(restore).toBe(true);
  });

  it('restores when the send rejects', async () => {
    const { restore } = await runPickSend(async () => { throw new Error('boom'); });
    expect(restore).toBe(true);
  });

  it('restores on a resolved delivered:false outcome (a failure that never threw)', async () => {
    const { restore } = await runPickSend(async () => ({ delivered: false }));
    expect(restore).toBe(true);
  });

  it('keeps the picks cleared on a resolved delivered:true outcome', async () => {
    const { restore } = await runPickSend(async () => ({ delivered: true }));
    expect(restore).toBe(false);
  });

  it('keeps the picks cleared when the send resolves void (no outcome reported)', async () => {
    const { restore } = await runPickSend(async () => { /* success, no outcome */ });
    expect(restore).toBe(false);
  });

  it('keeps the picks cleared for a synchronous void return', async () => {
    const { restore } = await runPickSend(() => undefined);
    expect(restore).toBe(false);
  });
});

describe('resolveAlwaysHandle — stale-handle guard', () => {
  const agents: MarkupAgent[] = [
    { id: '1', handle: 'claude', name: 'Claude' },
    { id: '2', handle: 'codex', name: 'Codex' },
  ];

  it('keeps a handle that is still in the roster', () => {
    expect(resolveAlwaysHandle('codex', agents)).toBe('codex');
  });

  it('drops a stale handle for an agent that has left the workspace', () => {
    expect(resolveAlwaysHandle('ghost', agents)).toBeNull();
  });

  it('returns null when nothing is remembered', () => {
    expect(resolveAlwaysHandle(null, agents)).toBeNull();
  });

  it('returns null when the roster is empty', () => {
    expect(resolveAlwaysHandle('claude', [])).toBeNull();
  });
});
