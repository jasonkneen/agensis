import { describe, expect, it } from 'vitest';
import {
  applyMessageRow,
  createMessageSnapshotOverlay,
  reconcileMessageSnapshot,
  recordMessageSnapshotChange,
  resetMessageSnapshotOverlay,
} from '../../src/lib/messageSnapshot';
import type { Message } from '../../src/types';

function message(
  id: string,
  sessionId: string,
  content: string,
  createdAt = '2026-07-31T12:00:00.000Z',
): Message {
  return {
    id,
    session_id: sessionId,
    role: 'user',
    content,
    created_at: createdAt,
  } as Message;
}

describe('message snapshot reconciliation', () => {
  it('keeps realtime updates and deletes that land while an older GET is in flight', () => {
    const overlay = createMessageSnapshotOverlay();
    resetMessageSnapshotOverlay(overlay, 'session-a');
    recordMessageSnapshotChange(
      overlay,
      'session-a',
      message('updated', 'session-a', 'new realtime body', '2026-07-31T12:00:02.000Z'),
    );
    recordMessageSnapshotChange(overlay, 'session-a', null, 'deleted');
    recordMessageSnapshotChange(
      overlay,
      'session-a',
      message('inserted', 'session-a', 'arrived live', '2026-07-31T12:00:03.000Z'),
    );

    const reconciled = reconcileMessageSnapshot([
      message('deleted', 'session-a', 'stale deleted body', '2026-07-31T12:00:00.000Z'),
      message('updated', 'session-a', 'stale update body', '2026-07-31T12:00:01.000Z'),
      message('foreign', 'session-b', 'must never cross sessions'),
    ], overlay, 'session-a');

    expect(reconciled.map(row => row.id)).toEqual(['updated', 'inserted']);
    expect(reconciled[0]?.content).toBe('new realtime body');
    expect(reconciled.some(row => row.content.includes('stale'))).toBe(false);
  });

  it('clears overlay history when the active session changes', () => {
    const overlay = createMessageSnapshotOverlay();
    resetMessageSnapshotOverlay(overlay, 'session-a');
    recordMessageSnapshotChange(overlay, 'session-a', null, 'same-id');
    resetMessageSnapshotOverlay(overlay, 'session-b');

    expect(reconcileMessageSnapshot(
      [message('same-id', 'session-b', 'belongs to B')],
      overlay,
      'session-b',
    )).toEqual([message('same-id', 'session-b', 'belongs to B')]);
    expect(overlay.changes.size).toBe(0);
  });

  it('merges an existing row and preserves compound chronological order', () => {
    const current = [
      message('b', 'session-a', 'second', '2026-07-31T12:00:00.000Z'),
      message('c', 'session-a', 'third', '2026-07-31T12:00:01.000Z'),
    ];
    const next = applyMessageRow(
      current,
      message('b', 'session-a', 'updated second', '2026-07-31T12:00:00.000Z'),
    );
    const withTie = applyMessageRow(
      next,
      message('a', 'session-a', 'first by id', '2026-07-31T12:00:00.000Z'),
    );

    expect(withTie.map(row => row.id)).toEqual(['a', 'b', 'c']);
    expect(withTie[1]?.content).toBe('updated second');
  });
});
