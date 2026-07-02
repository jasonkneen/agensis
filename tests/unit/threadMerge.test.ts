import { describe, it, expect } from 'vitest';
import { computeThreadDivergence } from '../../src/lib/threadMerge';
import type { Message } from '../../src/types';

// Minimal top-level message factory. created_at is the server clock; splitSession
// copies a message into the fork preserving created_at/role/content.
function msg(id: string, created_at: string, content: string, role: Message['role'] = 'user'): Message {
  return { id, session_id: 's', role, content, created_at } as Message;
}

function msgFrom(id: string, created_at: string, content: string, sender_id: string): Message {
  return { id, session_id: 's', role: 'assistant', content, created_at, sender_kind: 'agent', sender_id } as Message;
}

describe('computeThreadDivergence', () => {
  it('separates each branch post-split divergence from shared history', () => {
    // Shared history (copied into the fork at split): a, b.
    const shared = [msg('p1', '2026-07-01T10:00:00.000Z', 'a'), msg('p2', '2026-07-01T10:01:00.000Z', 'b')];
    // Fork keeps copies of shared (new ids, same created_at/role/content) then diverges.
    const forkCopies = [msg('f1', '2026-07-01T10:00:00.000Z', 'a'), msg('f2', '2026-07-01T10:01:00.000Z', 'b')];
    const forkTop = [...forkCopies, msg('f3', '2026-07-01T10:05:00.000Z', 'fork-only')];
    // Parent continues on its own branch.
    const parentTop = [...shared, msg('p3', '2026-07-01T10:06:00.000Z', 'parent-only')];

    const { parentDiverged, forkDiverged } = computeThreadDivergence(parentTop, forkTop);
    expect(parentDiverged.map(m => m.content)).toEqual(['parent-only']);
    expect(forkDiverged.map(m => m.content)).toEqual(['fork-only']);
  });

  it('M7 regression: finds fork divergence even when a browser split_at would sort it as pre-split', () => {
    // The old code compared created_at (server) against split_at (browser). With
    // the browser clock ahead, a fork message sent right after the split has a
    // server created_at EARLIER than split_at and was wrongly treated as
    // pre-split, so forkDiverged came back empty and the fork was discarded.
    // Set-difference ignores split_at entirely, so it still finds the divergence.
    const shared = [msg('p1', '2026-07-01T10:00:00.000Z', 'a')];
    const forkTop = [msg('f1', '2026-07-01T10:00:00.000Z', 'a'), msg('f2', '2026-07-01T10:00:30.000Z', 'real fork work')];
    const parentTop = [...shared];

    const { forkDiverged } = computeThreadDivergence(parentTop, forkTop);
    expect(forkDiverged.map(m => m.content)).toEqual(['real fork work']);
    expect(forkDiverged.length).toBeGreaterThan(0); // would have been 0 under the clock bug
  });

  it('treats same-timestamp/content messages from different senders as distinct', () => {
    // Two agents reply with identical text at the same instant on the two
    // branches — including sender_id in the identity keeps them from cancelling
    // out as "shared", so each branch's reply is correctly seen as divergence.
    const parentTop = [msgFrom('p1', '2026-07-01T10:00:00.000Z', 'done', 'agent-A')];
    const forkTop = [msgFrom('f1', '2026-07-01T10:00:00.000Z', 'done', 'agent-B')];

    const { parentDiverged, forkDiverged } = computeThreadDivergence(parentTop, forkTop);
    expect(parentDiverged.map(m => m.id)).toEqual(['p1']);
    expect(forkDiverged.map(m => m.id)).toEqual(['f1']);
  });

  it('reports no divergence when the fork never diverged (pure-cleanup merge)', () => {
    const shared = [msg('p1', '2026-07-01T10:00:00.000Z', 'a'), msg('p2', '2026-07-01T10:01:00.000Z', 'b')];
    const forkTop = [msg('f1', '2026-07-01T10:00:00.000Z', 'a'), msg('f2', '2026-07-01T10:01:00.000Z', 'b')];

    const { forkDiverged } = computeThreadDivergence(shared, forkTop);
    expect(forkDiverged).toEqual([]);
  });
});
