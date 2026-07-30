import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceRail,
  clampWorkspaceRailWidth,
  isWorkspaceRailExpanded,
  nudgeWorkspaceRailWidth,
  pickInitialWorkspaceId,
  readWorkspaceRailWidth,
  resolveActiveWorkspaceId,
  toggleWorkspaceRailWidth,
  workspaceGlyph,
  workspaceInitials,
  workspaceRailFocusOrder,
  workspaceRailKeyTarget,
  workspaceTileColor,
  WORKSPACE_RAIL_COLLAPSED_WIDTH,
  WORKSPACE_RAIL_DEFAULT_EXPANDED_WIDTH,
  WORKSPACE_RAIL_MAX_WIDTH,
  WORKSPACE_RAIL_MIN_EXPANDED_WIDTH,
  WORKSPACE_RAIL_SNAP_WIDTH,
  type WorkspaceRailSource,
} from '../../src/lib/workspaceRail';

// The switcher's decisions, without a rail.
//
// The risky ones are the fallbacks. `workspaces.icon` is free text a human typed
// into a 4-char input, and `activeWorkspaceId` routinely names a workspace that
// is no longer in the list (deleted elsewhere, or a stored id from an account
// you've left). Both failures are silent in the UI — a blank tile, or a rail
// where nothing is marked active — so they're pinned here.

function ws(overrides: Partial<WorkspaceRailSource> & { id: string }): WorkspaceRailSource {
  return { name: overrides.id, ...overrides };
}

describe('workspaceInitials', () => {
  it('takes the first two letters of a one-word name', () => {
    expect(workspaceInitials('Personal')).toBe('PE');
  });

  it('takes one letter from each of the first two words', () => {
    expect(workspaceInitials('My Cool Space')).toBe('MC');
  });

  it('ignores an emoji prefix and reads the actual name', () => {
    expect(workspaceInitials('🌱 Garden')).toBe('GA');
    expect(workspaceInitials('💼Work')).toBe('WO');
  });

  it('treats hyphens and underscores as word breaks', () => {
    expect(workspaceInitials('front-end')).toBe('FE');
    expect(workspaceInitials('data_pipeline')).toBe('DP');
  });

  it('falls back to the first character when the name has no letters at all', () => {
    // Astral-plane emoji: one character, not the two code units a naive slice
    // would take (which renders as a replacement box).
    expect(workspaceInitials('🌱')).toBe('🌱');
    expect(workspaceInitials('···')).toBe('·');
  });

  it('does not invent letters for a one-character name', () => {
    expect(workspaceInitials('X')).toBe('X');
  });

  it('paints a placeholder rather than nothing for an empty name', () => {
    expect(workspaceInitials('')).toBe('?');
    expect(workspaceInitials('   ')).toBe('?');
    expect(workspaceInitials(null)).toBe('?');
    expect(workspaceInitials(undefined)).toBe('?');
  });

  it('handles non-Latin names', () => {
    expect(workspaceInitials('東京 支社')).toBe('東支');
  });
});

describe('workspaceGlyph', () => {
  // No emoji in the rail, ever. Emoji renders as a different typeface at a
  // different weight on every platform, so a column of tiles stops reading as
  // one control — and it is illegible at tile size. Initials on a solid colour
  // instead: identical on every platform and still legible at 20px.
  it('ignores the icon column entirely and always uses initials', () => {
    expect(workspaceGlyph({ name: 'Personal', icon: '🌱' })).toEqual({ glyph: 'PE', fromIcon: false });
    expect(workspaceGlyph({ name: 'Work', icon: '💼' })).toEqual({ glyph: 'WO', fromIcon: false });
  });

  it('uses initials when the icon is missing or blank', () => {
    expect(workspaceGlyph({ name: 'Personal', icon: '' })).toEqual({ glyph: 'PE', fromIcon: false });
    expect(workspaceGlyph({ name: 'Personal', icon: '   ' })).toEqual({ glyph: 'PE', fromIcon: false });
    expect(workspaceGlyph({ name: 'Personal', icon: null })).toEqual({ glyph: 'PE', fromIcon: false });
    expect(workspaceGlyph({ name: 'Personal' })).toEqual({ glyph: 'PE', fromIcon: false });
  });

  it('a pasted string in the icon column cannot blow the tile out', () => {
    // It is not read at all now, but the initials path caps at two either way.
    expect(workspaceGlyph({ name: 'Personal', icon: 'ABCDEFG' }).glyph).toBe('PE');
  });

  it('gives each workspace a stable, distinct tile colour', () => {
    const a = workspaceTileColor({ id: 'a', name: 'Work' });
    expect(a).toMatch(/^#[0-9a-f]{6}$/i);
    // Stable across calls — a tile that changes colour on reload is unusable
    // as a spatial cue.
    expect(workspaceTileColor({ id: 'a', name: 'Work' })).toBe(a);
    expect(workspaceTileColor({ id: 'b', name: 'Personal' })).not.toBe(a);
  });
});

describe('resolveActiveWorkspaceId', () => {
  const list = [ws({ id: 'a' }), ws({ id: 'b' }), ws({ id: 'c' })];

  it('keeps an id that matches', () => {
    expect(resolveActiveWorkspaceId(list, 'b')).toBe('b');
  });

  it('falls back to the first workspace when the id matches nothing', () => {
    expect(resolveActiveWorkspaceId(list, 'gone')).toBe('a');
  });

  it('falls back to the first workspace for the empty initial id', () => {
    expect(resolveActiveWorkspaceId(list, '')).toBe('a');
    expect(resolveActiveWorkspaceId(list, null)).toBe('a');
    expect(resolveActiveWorkspaceId(list, undefined)).toBe('a');
  });

  it('returns null when there are no workspaces', () => {
    expect(resolveActiveWorkspaceId([], 'a')).toBeNull();
    expect(resolveActiveWorkspaceId([], null)).toBeNull();
  });
});

describe('pickInitialWorkspaceId', () => {
  const list = [ws({ id: 'a' }), ws({ id: 'b' })];

  it('reopens the workspace the user was last in', () => {
    expect(pickInitialWorkspaceId('b', list)).toBe('b');
  });

  it('does not strand the user on a stored id they no longer have', () => {
    expect(pickInitialWorkspaceId('left-this-one', list)).toBe('a');
  });

  it('is null before any workspace has loaded', () => {
    expect(pickInitialWorkspaceId('b', [])).toBeNull();
  });
});

describe('buildWorkspaceRail', () => {
  const workspaces = [
    ws({ id: 'a', name: 'Personal', icon: '🌱' }),
    ws({ id: 'sys', name: 'System', icon: '🛟', is_system: true }),
    ws({ id: 'b', name: 'Work' }),
  ];

  it('marks exactly one tile active', () => {
    const model = buildWorkspaceRail(workspaces, 'b');
    const active = workspaceRailFocusOrder(model).filter(tile => tile.active);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('b');
    expect(model.activeId).toBe('b');
  });

  it('still marks a tile active when the active id matches no workspace', () => {
    const model = buildWorkspaceRail(workspaces, 'deleted');
    expect(model.activeId).toBe('a');
    expect(model.tiles[0].active).toBe(true);
  });

  it('pulls the System workspace into its own group', () => {
    const model = buildWorkspaceRail(workspaces, 'a');
    expect(model.tiles.map(t => t.id)).toEqual(['a', 'b']);
    expect(model.systemTiles.map(t => t.id)).toEqual(['sys']);
    expect(model.systemTiles[0].isSystem).toBe(true);
  });

  it('can mark the System tile active like any other workspace', () => {
    const model = buildWorkspaceRail(workspaces, 'sys');
    expect(model.systemTiles[0].active).toBe(true);
    expect(model.tiles.every(t => !t.active)).toBe(true);
  });

  it('preserves the caller order rather than re-sorting', () => {
    const shuffled = [ws({ id: 'z', name: 'Zulu' }), ws({ id: 'm', name: 'Mike' }), ws({ id: 'a', name: 'Alpha' })];
    expect(buildWorkspaceRail(shuffled, 'z').tiles.map(t => t.id)).toEqual(['z', 'm', 'a']);
  });

  it('is stable: the same input twice produces the same tiles', () => {
    const first = buildWorkspaceRail(workspaces, 'a');
    const second = buildWorkspaceRail(workspaces, 'a');
    expect(second).toEqual(first);
  });

  it('handles an empty workspace list', () => {
    const model = buildWorkspaceRail([], '');
    expect(model.tiles).toEqual([]);
    expect(model.systemTiles).toEqual([]);
    expect(model.activeId).toBeNull();
    expect(workspaceRailFocusOrder(model)).toEqual([]);
  });

  it('labels a nameless workspace rather than rendering an empty tooltip', () => {
    const model = buildWorkspaceRail([ws({ id: 'a', name: '' })], 'a');
    expect(model.tiles[0].name).toBe('Untitled workspace');
    expect(model.tiles[0].glyph).toBe('?');
  });

  it('walks ordinary tiles first, then System', () => {
    const model = buildWorkspaceRail(workspaces, 'a');
    expect(workspaceRailFocusOrder(model).map(t => t.id)).toEqual(['a', 'b', 'sys']);
  });
});

describe('workspaceRailKeyTarget', () => {
  it('moves down and up', () => {
    expect(workspaceRailKeyTarget('ArrowDown', 0, 3)).toBe(1);
    expect(workspaceRailKeyTarget('ArrowUp', 2, 3)).toBe(1);
  });

  it('wraps at both ends', () => {
    expect(workspaceRailKeyTarget('ArrowDown', 2, 3)).toBe(0);
    expect(workspaceRailKeyTarget('ArrowUp', 0, 3)).toBe(2);
  });

  it('jumps to the ends', () => {
    expect(workspaceRailKeyTarget('Home', 2, 3)).toBe(0);
    expect(workspaceRailKeyTarget('End', 0, 3)).toBe(2);
  });

  it('ignores keys the rail does not own', () => {
    expect(workspaceRailKeyTarget('Enter', 0, 3)).toBeNull();
    expect(workspaceRailKeyTarget('1', 0, 3)).toBeNull();
    expect(workspaceRailKeyTarget('Tab', 0, 3)).toBeNull();
  });

  it('does nothing on an empty rail', () => {
    expect(workspaceRailKeyTarget('ArrowDown', 0, 0)).toBeNull();
  });

  it('recovers from an out-of-range current index', () => {
    expect(workspaceRailKeyTarget('ArrowDown', -1, 3)).toBe(1);
    expect(workspaceRailKeyTarget('ArrowDown', 99, 3)).toBe(1);
  });
});

// Regression: falling back to workspaces[0] put users in the SYSTEM workspace
// whenever it sorted first, which it does the moment a feedback report touches
// it (the list is ordered by updated_at). Landing in an empty workspace reads
// as data loss — that happened to a real account with 64 sessions.
describe('the System workspace is never an automatic landing place', () => {
  const sys = { id: 'sys', name: 'System', is_system: true };
  const work = { id: 'work', name: 'Work' };
  const personal = { id: 'personal', name: 'Personal' };

  it('skips System when it sorts first and nothing is stored', () => {
    expect(pickInitialWorkspaceId(null, [sys, work, personal])).toBe('work');
  });

  it('still honours a stored id, even the System one — going there on purpose is fine', () => {
    expect(pickInitialWorkspaceId('sys', [sys, work])).toBe('sys');
  });

  it('falls back to the first ordinary workspace when the stored id is gone', () => {
    expect(pickInitialWorkspaceId('deleted', [sys, work])).toBe('work');
  });

  it('uses System only when it is genuinely the only workspace', () => {
    expect(pickInitialWorkspaceId(null, [sys])).toBe('sys');
  });
});

// The rail drags between an icon strip and a column wide enough for names and
// canvases. The band between the two is the interesting part: a rail left at
// 90px is wide enough to look deliberate and too narrow to read, so no drag may
// end there. Everything downstream (the canvas viewport's left inset, the
// traffic-light clearance) is arithmetic off this number.
describe('clampWorkspaceRailWidth', () => {
  it('snaps shut below the snap threshold', () => {
    expect(clampWorkspaceRailWidth(WORKSPACE_RAIL_SNAP_WIDTH - 1)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(clampWorkspaceRailWidth(60)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(clampWorkspaceRailWidth(WORKSPACE_RAIL_COLLAPSED_WIDTH)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
  });

  it('opens to the minimum readable width AT the threshold', () => {
    expect(clampWorkspaceRailWidth(WORKSPACE_RAIL_SNAP_WIDTH)).toBe(WORKSPACE_RAIL_MIN_EXPANDED_WIDTH);
  });

  it('leaves nothing representable between the two shapes', () => {
    // Every width in the dead band resolves to one end or the other.
    for (let width = 0; width <= WORKSPACE_RAIL_MIN_EXPANDED_WIDTH; width += 1) {
      const clamped = clampWorkspaceRailWidth(width);
      expect(
        clamped === WORKSPACE_RAIL_COLLAPSED_WIDTH || clamped === WORKSPACE_RAIL_MIN_EXPANDED_WIDTH,
      ).toBe(true);
    }
  });

  it('keeps a width above the threshold, rounded', () => {
    expect(clampWorkspaceRailWidth(240)).toBe(240);
    expect(clampWorkspaceRailWidth(240.4)).toBe(240);
  });

  it('caps at the maximum', () => {
    expect(clampWorkspaceRailWidth(WORKSPACE_RAIL_MAX_WIDTH + 1)).toBe(WORKSPACE_RAIL_MAX_WIDTH);
    expect(clampWorkspaceRailWidth(5000)).toBe(WORKSPACE_RAIL_MAX_WIDTH);
  });

  it('treats nonsense as collapsed rather than propagating NaN into a layout inset', () => {
    expect(clampWorkspaceRailWidth(Number.NaN)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(clampWorkspaceRailWidth(Number.POSITIVE_INFINITY)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(clampWorkspaceRailWidth(-500)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
  });
});

describe('isWorkspaceRailExpanded', () => {
  it('is false at and below the snap threshold', () => {
    expect(isWorkspaceRailExpanded(WORKSPACE_RAIL_COLLAPSED_WIDTH)).toBe(false);
    expect(isWorkspaceRailExpanded(WORKSPACE_RAIL_SNAP_WIDTH - 1)).toBe(false);
  });

  it('is true from the snap threshold up', () => {
    expect(isWorkspaceRailExpanded(WORKSPACE_RAIL_SNAP_WIDTH)).toBe(true);
    expect(isWorkspaceRailExpanded(WORKSPACE_RAIL_MIN_EXPANDED_WIDTH)).toBe(true);
    expect(isWorkspaceRailExpanded(WORKSPACE_RAIL_MAX_WIDTH)).toBe(true);
  });
});

describe('readWorkspaceRailWidth', () => {
  it('opens collapsed for a browser that has never dragged the rail', () => {
    // The shape the app has always had — an upgrade must change nothing until
    // the user asks for it.
    expect(readWorkspaceRailWidth(null)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(readWorkspaceRailWidth(undefined)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(readWorkspaceRailWidth('')).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(readWorkspaceRailWidth('wide please')).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
  });

  it('restores a saved width, clamped', () => {
    expect(readWorkspaceRailWidth('224')).toBe(224);
    expect(readWorkspaceRailWidth('9999')).toBe(WORKSPACE_RAIL_MAX_WIDTH);
  });
});

// Regression: the first version nudged by a flat ±24 and clamped. From 52 that
// lands on 76, which clamps straight back to 52 — the handle was focusable and
// completely inert, caught by driving it with the keyboard rather than by
// reading it. A pointer crosses the dead band in one gesture; a keyboard has to
// be given the step.
describe('nudgeWorkspaceRailWidth', () => {
  it('steps a collapsed rail over the dead band, not into it', () => {
    expect(nudgeWorkspaceRailWidth(WORKSPACE_RAIL_COLLAPSED_WIDTH, 24)).toBe(WORKSPACE_RAIL_MIN_EXPANDED_WIDTH);
    expect(nudgeWorkspaceRailWidth(WORKSPACE_RAIL_COLLAPSED_WIDTH, 1)).toBe(WORKSPACE_RAIL_MIN_EXPANDED_WIDTH);
  });

  it('steps the narrowest expanded rail shut rather than stalling on the floor', () => {
    expect(nudgeWorkspaceRailWidth(WORKSPACE_RAIL_MIN_EXPANDED_WIDTH, -24)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
  });

  it('moves by the step in the open band', () => {
    expect(nudgeWorkspaceRailWidth(240, 24)).toBe(264);
    expect(nudgeWorkspaceRailWidth(240, -24)).toBe(216);
  });

  it('does not run off either end', () => {
    expect(nudgeWorkspaceRailWidth(WORKSPACE_RAIL_MAX_WIDTH, 24)).toBe(WORKSPACE_RAIL_MAX_WIDTH);
    expect(nudgeWorkspaceRailWidth(WORKSPACE_RAIL_COLLAPSED_WIDTH, -24)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
  });

  it('is reachable in both directions from every legal width', () => {
    // Anything the handle can be at must be able to grow and to shrink.
    for (const width of [WORKSPACE_RAIL_COLLAPSED_WIDTH, WORKSPACE_RAIL_MIN_EXPANDED_WIDTH, 220, WORKSPACE_RAIL_MAX_WIDTH]) {
      const wider = nudgeWorkspaceRailWidth(width, 24);
      const narrower = nudgeWorkspaceRailWidth(width, -24);
      if (width !== WORKSPACE_RAIL_MAX_WIDTH) expect(wider).toBeGreaterThan(width);
      if (width !== WORKSPACE_RAIL_COLLAPSED_WIDTH) expect(narrower).toBeLessThan(width);
    }
  });
});

describe('toggleWorkspaceRailWidth', () => {
  it('opens a collapsed rail to the default width', () => {
    expect(toggleWorkspaceRailWidth(WORKSPACE_RAIL_COLLAPSED_WIDTH)).toBe(WORKSPACE_RAIL_DEFAULT_EXPANDED_WIDTH);
  });

  it('shuts an expanded rail whatever width it was left at', () => {
    expect(toggleWorkspaceRailWidth(WORKSPACE_RAIL_MIN_EXPANDED_WIDTH)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(toggleWorkspaceRailWidth(WORKSPACE_RAIL_MAX_WIDTH)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
  });

  it('round-trips', () => {
    const opened = toggleWorkspaceRailWidth(WORKSPACE_RAIL_COLLAPSED_WIDTH);
    expect(toggleWorkspaceRailWidth(opened)).toBe(WORKSPACE_RAIL_COLLAPSED_WIDTH);
  });
});
