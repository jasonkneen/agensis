import { describe, it, expect } from 'vitest';
import { buildDmForkGroups } from '../../src/components/layout/Sidebar';
import type { ChatSession } from '../../src/types';

// Regression: a split of a DM is itself a DM (same agent participant), so the
// per-agent dedup in buildDirectMessageTargets used to swallow the fork and its
// Merge action never rendered. buildDmForkGroups pulls forks OUT of the target
// input and maps them under their parent so they render nested + mergeable.

function dm(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    workspace_id: 'w',
    title: id,
    folder: 'Direct messages',
    ...extra,
  } as ChatSession;
}

describe('buildDmForkGroups', () => {
  it('separates a fork from its parent and maps it under the parent id', () => {
    const parent = dm('parent');
    const fork = dm('fork', { split_parent_id: 'parent' });
    const { dmForksByParent, dmPrimarySessions } = buildDmForkGroups([parent, fork]);

    // The parent stays a primary (agent) row; the fork is pulled out.
    expect(dmPrimarySessions.map(s => s.id)).toEqual(['parent']);
    // The fork is reachable under its parent so it can render nested + merge.
    expect(dmForksByParent.get('parent')?.map(s => s.id)).toEqual(['fork']);
  });

  it('nests a split-of-a-split under its immediate parent (recursive)', () => {
    const parent = dm('parent');
    const fork = dm('fork', { split_parent_id: 'parent' });
    const forkOfFork = dm('fork2', { split_parent_id: 'fork' });
    const { dmForksByParent, dmPrimarySessions } = buildDmForkGroups([parent, fork, forkOfFork]);

    expect(dmPrimarySessions.map(s => s.id)).toEqual(['parent']);
    expect(dmForksByParent.get('parent')?.map(s => s.id)).toEqual(['fork']);
    expect(dmForksByParent.get('fork')?.map(s => s.id)).toEqual(['fork2']);
  });

  it('keeps an orphan fork (parent not in view) as a primary so it never vanishes', () => {
    const orphan = dm('orphan', { split_parent_id: 'missing-parent' });
    const { dmForksByParent, dmPrimarySessions } = buildDmForkGroups([orphan]);

    expect(dmPrimarySessions.map(s => s.id)).toEqual(['orphan']);
    expect(dmForksByParent.size).toBe(0);
  });

  it('treats a plain DM with no lineage as a primary', () => {
    const plain = dm('plain');
    const { dmForksByParent, dmPrimarySessions } = buildDmForkGroups([plain]);

    expect(dmPrimarySessions.map(s => s.id)).toEqual(['plain']);
    expect(dmForksByParent.size).toBe(0);
  });
});
