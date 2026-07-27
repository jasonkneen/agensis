import { describe, expect, it } from 'vitest';
import {
  MEMORY_SPLIT_MAX_LIST_PX,
  MEMORY_SPLIT_MIN_LIST_PX,
  MEMORY_SPLIT_MIN_PREVIEW_PX,
  MEMORY_SPLIT_PREF,
  MEMORY_SUGGESTION_LIMIT,
  memoryBrowserTips,
  memorySplitListWidth,
  suggestedMemoryFiles,
} from '../../src/lib/memoryBrowserView';
import { readPreference, type PreferenceStorage } from '../../src/lib/viewPreferences';
import { PAGE_TIPS } from '../../src/lib/pageTips';
import type { AgentMemoryFile } from '../../src/types';

// The Memory window's "Agent files" decisions: where the divider between the
// file list and the preview may sit, and what the preview offers before
// anything is selected.

function file(path: string, lastSynced: string): AgentMemoryFile {
  return {
    id: `id-${path}`,
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    path,
    kind: 'memory',
    summary: '',
    byte_size: 100,
    editable: false,
    last_synced: lastSynced,
    created_at: lastSynced,
    updated_at: lastSynced,
  };
}

describe('memorySplitListWidth', () => {
  it('opens on a share of the container, not a fixed width', () => {
    // Never dragged: 0 is what the preference stores for that.
    expect(memorySplitListWidth(0, 1000)).toBe(340);
    expect(memorySplitListWidth(null, 1400)).toBe(476);
  });

  it('honours a stored width that fits', () => {
    expect(memorySplitListWidth(420, 1400)).toBe(420);
    expect(memorySplitListWidth(MEMORY_SPLIT_MIN_LIST_PX, 1400)).toBe(MEMORY_SPLIT_MIN_LIST_PX);
  });

  it('CLAMPS A WIDTH STORED IN A WIDE WINDOW INTO A NARROW ONE', () => {
    // 520px of list is comfortable in a 1400px window…
    expect(memorySplitListWidth(520, 1400)).toBe(520);
    // …and would leave 200px of preview in a 720px one, which is below the
    // preview's floor. The preview's floor wins.
    expect(memorySplitListWidth(520, 720)).toBe(720 - MEMORY_SPLIT_MIN_PREVIEW_PX);
    // Nothing was written back, so widening again restores the chosen width.
    expect(memorySplitListWidth(520, 1400)).toBe(520);
  });

  it('NEVER PUTS EITHER PANE BELOW ITS MINIMUM', () => {
    for (const container of [720, 900, 1200, 1600, 2400, 3200]) {
      for (const stored of [null, 0, 12, 240, 520, 1800, 9999]) {
        const list = memorySplitListWidth(stored, container);
        expect(list, `list for stored=${stored} in ${container}`)
          .toBeGreaterThanOrEqual(MEMORY_SPLIT_MIN_LIST_PX);
        expect(container - list, `preview for stored=${stored} in ${container}`)
          .toBeGreaterThanOrEqual(MEMORY_SPLIT_MIN_PREVIEW_PX);
      }
    }
  });

  it('caps the list rather than letting it eat a very wide window', () => {
    expect(memorySplitListWidth(null, 3000)).toBe(MEMORY_SPLIT_MAX_LIST_PX);
    expect(memorySplitListWidth(1200, 3000)).toBe(MEMORY_SPLIT_MAX_LIST_PX);
  });

  it('answers the floor for an unmeasured container rather than 0', () => {
    expect(memorySplitListWidth(0, 0)).toBe(MEMORY_SPLIT_MIN_LIST_PX);
  });
});

describe('MEMORY_SPLIT_PREF', () => {
  const KEY = 'agensis.memory.file-split:ws-1';
  const storageWith = (value: string): PreferenceStorage => ({ getItem: () => value, setItem: () => {} });

  it('round-trips a measurement', () => {
    expect(MEMORY_SPLIT_PREF.serialize(412)).toBe('412');
    expect(readPreference(KEY, MEMORY_SPLIT_PREF, 0, storageWith('412'))).toBe(412);
  });

  it('reads junk back as "never dragged"', () => {
    for (const raw of ['', '0', '-40', 'wide', '{"width":300}', 'NaN', '999999']) {
      expect(readPreference(KEY, MEMORY_SPLIT_PREF, 0, storageWith(raw))).toBe(0);
    }
  });
});

describe('suggestedMemoryFiles', () => {
  it('puts an index file first', () => {
    const files = [
      file('memory/notes.md', '2026-07-27T10:00:00Z'),
      file('memory/MEMORY.md', '2026-07-20T10:00:00Z'),
      file('memory/other.md', '2026-07-26T10:00:00Z'),
    ];
    expect(suggestedMemoryFiles(files).map(f => f.path)).toEqual([
      'memory/MEMORY.md',
      'memory/notes.md',
      'memory/other.md',
    ]);
  });

  it('falls back to most recently synced', () => {
    const files = [
      file('memory/a.md', '2026-07-20T10:00:00Z'),
      file('memory/b.md', '2026-07-27T10:00:00Z'),
      file('memory/c.md', '2026-07-24T10:00:00Z'),
      file('memory/d.md', '2026-07-01T10:00:00Z'),
    ];
    expect(suggestedMemoryFiles(files).map(f => f.path)).toEqual([
      'memory/b.md',
      'memory/c.md',
      'memory/a.md',
    ]);
  });

  it('is stable when two files share a timestamp', () => {
    const files = [
      file('memory/z.md', '2026-07-27T10:00:00Z'),
      file('memory/a.md', '2026-07-27T10:00:00Z'),
    ];
    // Two files is one too few to suggest anything (see below), so ask for a
    // third to exercise the tiebreak.
    const three = [...files, file('memory/m.md', '2026-07-27T10:00:00Z')];
    expect(suggestedMemoryFiles(three).map(f => f.path)).toEqual([
      'memory/a.md',
      'memory/m.md',
      'memory/z.md',
    ]);
  });

  it('offers nothing when the list is already the whole story', () => {
    // One file on screen and a chip pointing at it is noise, not a suggestion.
    expect(suggestedMemoryFiles([])).toEqual([]);
    expect(suggestedMemoryFiles([file('memory/only.md', '2026-07-27T10:00:00Z')])).toEqual([]);
  });

  it('never offers more chips than there are files, or than the limit', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`memory/f${i}.md`, `2026-07-${10 + i}T10:00:00Z`));
    expect(suggestedMemoryFiles(files)).toHaveLength(MEMORY_SUGGESTION_LIMIT);
    expect(suggestedMemoryFiles(files.slice(0, 2))).toHaveLength(2);
    expect(suggestedMemoryFiles(files, 0)).toEqual([]);
  });

  it('survives a missing or unparseable timestamp', () => {
    const broken = { ...file('memory/broken.md', 'not-a-date') };
    const good = file('memory/good.md', '2026-07-27T10:00:00Z');
    const third = file('memory/third.md', '2026-07-26T10:00:00Z');
    expect(suggestedMemoryFiles([broken, good, third]).map(f => f.path)).toEqual([
      'memory/good.md',
      'memory/third.md',
      'memory/broken.md',
    ]);
  });

  it('does not mutate the list it was handed', () => {
    const files = [
      file('memory/a.md', '2026-07-20T10:00:00Z'),
      file('memory/b.md', '2026-07-27T10:00:00Z'),
      file('memory/c.md', '2026-07-24T10:00:00Z'),
    ];
    const order = files.map(f => f.path);
    suggestedMemoryFiles(files);
    expect(files.map(f => f.path)).toEqual(order);
  });
});

describe('memoryBrowserTips', () => {
  it('is the Memory surface tips, not a second copy of them', () => {
    const tips = memoryBrowserTips();
    expect(tips.length).toBeGreaterThan(0);
    expect(tips).toEqual(PAGE_TIPS.filter(tip => tip.surface === 'memory'));
    // Every chip needs a stable id to key the open/closed state off.
    expect(new Set(tips.map(tip => tip.id)).size).toBe(tips.length);
    for (const tip of tips) {
      expect(tip.title.trim()).not.toBe('');
      expect(tip.body.trim()).not.toBe('');
    }
  });
});
