import { describe, expect, it } from 'vitest';
import {
  buildDesktopOverlay,
  defaultDesktopName,
  overlayWorkspaceOrder,
  resolveOverlayWorkspaceId,
  type OverlayDesktop,
  type OverlayWorkspace,
} from '../../src/lib/desktopOverlay';

// The two-tier overlay's decisions, without an overlay.
//
// The one that matters is the pairing invariant. App loads desktops for the
// ACTIVE workspace only, and that array lags a workspace switch by at least one
// render — so "show the selected workspace's desktops" is exactly the operation
// that can silently list workspace A's desktops under workspace B's name. That
// is the bug this whole screen exists to kill, so it is pinned hard below.

const WORKSPACES: OverlayWorkspace[] = [
  { id: 'work', name: 'Work' },
  { id: 'sys', name: 'System', is_system: true },
  { id: 'personal', name: 'Personal' },
];

function desktop(id: string, name = id): OverlayDesktop {
  return { id, name };
}

/** A paired build — desktops loaded for the workspace being shown. */
function build(overrides: Partial<Parameters<typeof buildDesktopOverlay>[0]> = {}) {
  const selectedWorkspaceId = overrides.selectedWorkspaceId ?? 'work';
  return buildDesktopOverlay({
    workspaces: WORKSPACES,
    desktops: [],
    desktopsWorkspaceId: selectedWorkspaceId,
    ...overrides,
    selectedWorkspaceId,
  });
}

describe('defaultDesktopName', () => {
  // Every workspace's first layer was called "Workspace 1", which is most of
  // why a workspace and a desktop were impossible to tell apart. The first one
  // is Main, and there is no "Desktop 1" to be confused with it.
  it('names the first desktop "Main"', () => {
    expect(defaultDesktopName([])).toBe('Main');
  });

  it('starts numbering at the second desktop', () => {
    expect(defaultDesktopName([{ name: 'Main' }])).toBe('Desktop 2');
    expect(defaultDesktopName([{ name: 'Main' }, { name: 'Desktop 2' }])).toBe('Desktop 3');
  });

  it('never mints a "Desktop 1"', () => {
    for (let count = 1; count < 6; count += 1) {
      const existing = Array.from({ length: count }, (_, i) => ({ name: i === 0 ? 'Main' : `Desktop ${i + 1}` }));
      expect(defaultDesktopName(existing)).not.toBe('Desktop 1');
    }
  });

  it('fills a gap rather than duplicating a name after a delete', () => {
    expect(defaultDesktopName([{ name: 'Main' }, { name: 'Desktop 3' }])).toBe('Desktop 2');
  });

  it('numbers from the second even when the first has been renamed', () => {
    expect(defaultDesktopName([{ name: 'Design' }])).toBe('Desktop 2');
  });

  it('survives blank and missing names', () => {
    expect(defaultDesktopName([{ name: null }, { name: '' }, {}])).toBe('Desktop 2');
  });
});

describe('resolveOverlayWorkspaceId', () => {
  it('keeps an id that matches', () => {
    expect(resolveOverlayWorkspaceId(WORKSPACES, 'personal')).toBe('personal');
  });

  it('falls back to the first ordinary workspace, never System', () => {
    expect(resolveOverlayWorkspaceId(WORKSPACES, 'deleted')).toBe('work');
    expect(resolveOverlayWorkspaceId([{ id: 'sys', name: 'System', is_system: true }, { id: 'w', name: 'Work' }], ''))
      .toBe('w');
  });

  it('uses System only when it is the only workspace', () => {
    expect(resolveOverlayWorkspaceId([{ id: 'sys', name: 'System', is_system: true }], null)).toBe('sys');
  });

  it('is null when the account has no workspaces', () => {
    expect(resolveOverlayWorkspaceId([], 'work')).toBeNull();
  });
});

describe('the workspace tier', () => {
  it('lists the account\'s workspaces, System grouped apart', () => {
    const model = build();
    expect(model.workspaces.map(t => t.id)).toEqual(['work', 'personal']);
    expect(model.systemWorkspaces.map(t => t.id)).toEqual(['sys']);
    expect(overlayWorkspaceOrder(model).map(t => t.id)).toEqual(['work', 'personal', 'sys']);
  });

  it('marks exactly one workspace active', () => {
    const active = overlayWorkspaceOrder(build({ selectedWorkspaceId: 'personal' })).filter(t => t.active);
    expect(active.map(t => t.id)).toEqual(['personal']);
  });

  it('still marks one active when the selected workspace no longer exists', () => {
    const model = build({ selectedWorkspaceId: 'deleted' });
    expect(model.selectedWorkspaceId).toBe('work');
    expect(model.selectedWorkspaceName).toBe('Work');
    expect(overlayWorkspaceOrder(model).filter(t => t.active).map(t => t.id)).toEqual(['work']);
  });

  // No emoji in the tiles, ever — the rail settled this and the overlay has to
  // agree with it or the same workspace reads as two different things.
  it('paints initials on the same colour the rail gives that workspace', () => {
    const tile = build().workspaces[0];
    expect(tile.initials).toBe('WO');
    expect(tile.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(build().workspaces[0].color).toBe(tile.color);
  });

  it('labels a nameless workspace rather than painting a blank tile', () => {
    const model = buildDesktopOverlay({
      workspaces: [{ id: 'a', name: '' }],
      selectedWorkspaceId: 'a',
      desktops: [],
      desktopsWorkspaceId: 'a',
    });
    expect(model.workspaces[0].name).toBe('Untitled workspace');
    expect(model.workspaces[0].initials).toBe('?');
    expect(model.selectedWorkspaceName).toBe('Untitled workspace');
  });

  it('handles an account with no workspaces at all', () => {
    const model = buildDesktopOverlay({
      workspaces: [],
      selectedWorkspaceId: '',
      desktops: [],
      desktopsWorkspaceId: null,
    });
    expect(model.workspaces).toEqual([]);
    expect(model.selectedWorkspaceId).toBeNull();
    expect(model.selectedWorkspaceName).toBe('Workspace');
    // '' and null are the same "nothing" here — the tier must not sit pending
    // forever on a fresh account.
    expect(model.desktopTier).toBe('empty');
  });
});

describe('the desktop tier', () => {
  it('lists the selected workspace\'s desktops', () => {
    const model = build({ desktops: [desktop('base', 'Main'), desktop('c2', 'Design')], baseDesktopId: 'base' });
    expect(model.desktops.map(d => d.name)).toEqual(['Main', 'Design']);
    expect(model.desktopTier).toBe('ready');
  });

  it('reports a workspace with no desktops as empty rather than pending', () => {
    const model = build({ desktops: [] });
    expect(model.desktops).toEqual([]);
    expect(model.desktopTier).toBe('empty');
  });

  it('counts the items and open windows on each desktop', () => {
    const model = build({
      desktops: [desktop('base'), desktop('c2')],
      baseDesktopId: 'base',
      objects: [{ layer_id: 'base' }, { layer_id: 'c2' }, { layer_id: 'c2' }, { layer_id: null }],
      windows: [
        { canvasId: 'c2' },
        { canvasId: 'c2', minimized: true },
        { canvasId: 'base' },
      ],
    });
    // A null layer_id is a base-desktop object — that is what the DB means by it.
    expect(model.desktops[0]).toMatchObject({ id: 'base', itemCount: 2, windowCount: 1 });
    // A minimized window is not on the desktop as far as the user can see.
    expect(model.desktops[1]).toMatchObject({ id: 'c2', itemCount: 2, windowCount: 1 });
  });

  it('marks the open desktop, and protects Main from deletion', () => {
    const model = build({
      desktops: [desktop('base'), desktop('c2')],
      baseDesktopId: 'base',
      activeDesktopId: 'c2',
    });
    expect(model.desktops.map(d => d.active)).toEqual([false, true]);
    expect(model.desktops.map(d => d.canDelete)).toEqual([false, true]);
  });

  it('labels a nameless desktop', () => {
    expect(build({ desktops: [{ id: 'c', name: '  ' }] }).desktops[0].name).toBe('Untitled desktop');
  });
});

// The reason this module exists. App runs `useCanvasLayers(activeWorkspaceId)`,
// so the desktops in hand always belong to whichever workspace was active when
// they loaded — which, for at least one painted frame after a switch, is not the
// one the heading names.
describe('desktops must belong to the workspace named above them', () => {
  const desktops = [desktop('base', 'Main'), desktop('c2', 'Work scratch')];

  it('refuses to list one workspace\'s desktops under another\'s name', () => {
    const model = buildDesktopOverlay({
      workspaces: WORKSPACES,
      selectedWorkspaceId: 'personal',
      desktops,
      desktopsWorkspaceId: 'work',
    });
    expect(model.selectedWorkspaceName).toBe('Personal');
    expect(model.desktops).toEqual([]);
    expect(model.desktopTier).toBe('pending');
  });

  it('lists them again as soon as the loaded workspace catches up', () => {
    const model = buildDesktopOverlay({
      workspaces: WORKSPACES,
      selectedWorkspaceId: 'personal',
      desktops,
      desktopsWorkspaceId: 'personal',
    });
    expect(model.desktopTier).toBe('ready');
    expect(model.desktops).toHaveLength(2);
  });

  it('pairs against the RESOLVED workspace, not the requested one', () => {
    // Selected workspace is gone, so the tier falls back to 'work' — and the
    // desktops loaded for 'work' are then correctly its own.
    const model = buildDesktopOverlay({
      workspaces: WORKSPACES,
      selectedWorkspaceId: 'deleted',
      desktops,
      desktopsWorkspaceId: 'work',
    });
    expect(model.selectedWorkspaceId).toBe('work');
    expect(model.desktopTier).toBe('ready');
  });

  it('does not pair a stale list with a workspace that has since been deleted', () => {
    const model = buildDesktopOverlay({
      workspaces: WORKSPACES,
      selectedWorkspaceId: 'deleted',
      desktops,
      desktopsWorkspaceId: 'deleted',
    });
    expect(model.selectedWorkspaceId).toBe('work');
    expect(model.desktopTier).toBe('pending');
    expect(model.desktops).toEqual([]);
  });

  it('holds while no workspace has loaded yet', () => {
    const model = buildDesktopOverlay({
      workspaces: WORKSPACES,
      selectedWorkspaceId: 'work',
      desktops,
      desktopsWorkspaceId: null,
    });
    expect(model.desktopTier).toBe('pending');
    expect(model.desktops).toEqual([]);
  });

  it('still renders the workspace tier while the desktop tier is pending', () => {
    const model = buildDesktopOverlay({
      workspaces: WORKSPACES,
      selectedWorkspaceId: 'personal',
      desktops,
      desktopsWorkspaceId: 'work',
    });
    expect(overlayWorkspaceOrder(model)).toHaveLength(3);
    expect(overlayWorkspaceOrder(model).filter(t => t.active).map(t => t.id)).toEqual(['personal']);
  });
});
