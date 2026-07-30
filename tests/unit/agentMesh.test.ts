import { describe, expect, it } from 'vitest';
import {
  buildMeshView,
  crumbPath,
  drillInto,
  drillOut,
  idleOffset,
  meshChildren,
  meshContentExtent,
  meshLayout,
  meshLevel,
  meshViewBox,
  motionConfig,
  openTaskCount,
  popupTarget,
  previewChildren,
  resolvePath,
  ringLayout,
  satelliteFan,
  sessionsForAgent,
  shortestAngleDelta,
  stepSpring,
  tasksForSession,
  truncateLabel,
  type MeshNode,
  type MeshPath,
  type MeshSource,
} from '../../src/components/windows/agentMeshModel';
import { CX, CY } from '../../src/components/windows/agentNetworkModel';
import type { AgentConnection, ChatSession, Task, WorkspaceAgent } from '../../src/types';

// The drill-down map, without an SVG.
//
// The interesting failures here are silent ones: a breadcrumb that navigates to
// the wrong depth, a badge that counts finished work, a ring that stacks two
// nodes on the same point, and — the one that would ruin the whole interaction —
// motion terms that survive `prefers-reduced-motion`. All of them are position
// or count arithmetic, so all of them are checkable without a browser.

function agent(overrides: Partial<WorkspaceAgent> & { id: string }): WorkspaceAgent {
  return {
    workspace_id: 'ws1',
    name: overrides.id,
    avatar: '',
    description: '',
    system_prompt: '',
    model: 'auto',
    created_by: null,
    created_at: '2026-07-25T10:00:00.000Z',
    updated_at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  };
}

function session(overrides: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    workspace_id: 'ws1',
    title: overrides.id,
    model: 'auto',
    created_at: '2026-07-25T10:00:00.000Z',
    updated_at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  };
}

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    workspace_id: 'ws1',
    created_by: null,
    assignee_id: null,
    parent_id: null,
    title: overrides.id,
    description: '',
    status: 'todo',
    priority: 'normal',
    due_date: null,
    start_date: null,
    source_type: null,
    source_id: null,
    completed_at: null,
    created_at: '2026-07-25T10:00:00.000Z',
    updated_at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  };
}

function connection(overrides: Partial<AgentConnection> & { id: string }): AgentConnection {
  return {
    workspace_id: 'ws1',
    agent_id: null,
    name: '',
    handle: '',
    host: '',
    cwd: '',
    status: 'online',
    metadata: {},
    connected_at: '2026-07-25T10:00:00.000Z',
    last_seen_at: '2026-07-25T10:00:00.000Z',
    updated_at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  };
}

const CODER = agent({ id: 'a-coder', name: 'Coder', handle: 'coder', run_mode: 'daemon' });
const ADA = agent({ id: 'a-ada', name: 'Ada', handle: 'ada' });

const BUILD = session({
  id: 's-build',
  title: 'build',
  participants: [{ id: 'p1', name: 'Coder', kind: 'agent', agent_id: 'a-coder' }, { id: 'u1', name: 'Jason', kind: 'user' }, { id: 'u2', name: 'Sam', kind: 'user' }],
  updated_at: '2026-07-25T12:00:00.000Z',
});
const CODER_DM = session({
  id: 's-dm',
  title: 'Coder',
  folder: 'Direct messages',
  participants: [{ id: 'p1', name: 'Coder', kind: 'agent', agent_id: 'a-coder', direct: true }],
  updated_at: '2026-07-25T11:00:00.000Z',
});
const BUILD_FORK = session({
  id: 's-build-fork',
  title: 'build (split)',
  split_parent_id: 's-build',
  participants: [{ id: 'p1', name: 'Coder', kind: 'agent', agent_id: 'a-coder' }],
});
const ARCHIVED = session({
  id: 's-old',
  title: 'old',
  archived_at: '2026-07-01T00:00:00.000Z',
  participants: [{ id: 'p1', name: 'Coder', kind: 'agent', agent_id: 'a-coder' }],
});

const FIX_PARSER = task({ id: 't-1', title: 'Fix the parser', assignee_id: 'a-coder', status: 'in_progress', source_type: 'chat', source_id: 's-build' });
const SHIP = task({ id: 't-2', title: 'Ship it', assignee_id: 'a-coder', status: 'todo', source_type: 'chat', source_id: 's-build' });
const DONE = task({ id: 't-3', title: 'Old thing', assignee_id: 'a-coder', status: 'done', source_type: 'chat', source_id: 's-build' });
const CANCELLED = task({ id: 't-4', title: 'Dropped', assignee_id: 'a-coder', status: 'cancelled', source_type: 'chat', source_id: 's-build' });

function makeSource(overrides: Partial<MeshSource> = {}): MeshSource {
  return {
    workspaceName: 'agensis',
    agents: [CODER, ADA],
    connections: [connection({ id: 'c1', agent_id: 'a-coder', status: 'busy' })],
    sessions: [BUILD, CODER_DM, BUILD_FORK, ARCHIVED],
    tasks: [FIX_PARSER, SHIP, DONE, CANCELLED],
    ...overrides,
  };
}

const SOURCE = makeSource();

function pathTo(...ids: string[]): MeshPath {
  let path: MeshPath = [];
  for (const id of ids) {
    const node = meshChildren(SOURCE, path).find(n => n.id === id);
    if (!node) throw new Error(`no child ${id} at depth ${path.length}`);
    path = drillInto(path, node);
  }
  return path;
}

describe('task counting', () => {
  it('counts only open work — a badge that only goes up is noise', () => {
    expect(openTaskCount(SOURCE.tasks, 'a-coder')).toBe(2);
  });

  it('is zero for an agent with nothing assigned, so the chip can be omitted', () => {
    expect(openTaskCount(SOURCE.tasks, 'a-ada')).toBe(0);
    const ada = meshChildren(SOURCE, []).find(n => n.refId === 'a-ada');
    expect(ada?.badge).toBe(0);
  });

  it('is zero for a missing assignee id rather than counting unassigned rows', () => {
    expect(openTaskCount(SOURCE.tasks, '')).toBe(0);
  });

  it('lists a session\'s tasks open-first and drops cancelled ones', () => {
    expect(tasksForSession(SOURCE.tasks, 's-build').map(t => t.id)).toEqual(['t-1', 't-2', 't-3']);
  });
});

describe('session <-> agent association', () => {
  it('matches by participant agent_id, DMs first then newest', () => {
    expect(sessionsForAgent(SOURCE.sessions, CODER).map(s => s.id)).toEqual(['s-dm', 's-build', 's-build-fork']);
  });

  it('matches a legacy participant row that only carries a handle', () => {
    const legacy = session({ id: 's-legacy', participants: [{ id: 'p', name: 'Coder', kind: 'agent', handle: '@coder' }] });
    expect(sessionsForAgent([legacy], CODER).map(s => s.id)).toEqual(['s-legacy']);
  });

  it('excludes archived and soft-deleted sessions', () => {
    expect(sessionsForAgent(SOURCE.sessions, CODER).some(s => s.id === 's-old')).toBe(false);
    const deleted = session({ id: 's-del', deleted_at: '2026-07-02T00:00:00.000Z', participants: [{ id: 'p', name: 'Coder', kind: 'agent', agent_id: 'a-coder' }] });
    expect(sessionsForAgent([deleted], CODER)).toEqual([]);
  });

  it('does not associate an agent with a session it is not in', () => {
    expect(sessionsForAgent(SOURCE.sessions, ADA)).toEqual([]);
  });
});

describe('drilling down and back up', () => {
  it('walks workspace -> agent -> session -> task', () => {
    expect(meshLevel([])).toBe('workspace');
    const atAgent = pathTo('agent:a-coder');
    expect(meshLevel(atAgent)).toBe('agent');
    const atSession = pathTo('agent:a-coder', 'session:s-build');
    expect(meshLevel(atSession)).toBe('session');
    const atTask = pathTo('agent:a-coder', 'session:s-build', 'task:t-1');
    expect(meshLevel(atTask)).toBe('task');
  });

  it('refuses to drill past the leaf level', () => {
    const atTask = pathTo('agent:a-coder', 'session:s-build', 'task:t-1');
    expect(meshChildren(SOURCE, atTask)).toEqual([]);
    const stray: MeshNode = {
      id: 'task:x', kind: 'task', refId: 'x', label: 'x', sublabel: '', glyph: '',
      status: 'idle', color: '#000000', accent: '#000000', live: false, dim: 1, badge: 0, childCount: 0,
    };
    expect(drillInto(atTask, stray)).toBe(atTask);
  });

  it('refuses to drill into a provider endpoint', () => {
    const provider = buildMeshView(SOURCE, []).providers[0];
    expect(provider).toBeTruthy();
    expect(drillInto([], provider)).toEqual([]);
  });

  it('pops one level at a time and stops at the root', () => {
    const atTask = pathTo('agent:a-coder', 'session:s-build', 'task:t-1');
    const atSession = drillOut(atTask);
    expect(atSession.map(e => e.refId)).toEqual(['a-coder', 's-build']);
    const atAgent = drillOut(atSession);
    expect(atAgent.map(e => e.refId)).toEqual(['a-coder']);
    const root = drillOut(atAgent);
    expect(root).toEqual([]);
    expect(drillOut(root)).toBe(root);
  });

  it('trims the path when a row it points at disappears', () => {
    const atTask = pathTo('agent:a-coder', 'session:s-build', 'task:t-1');
    const without = makeSource({ tasks: [SHIP] });
    expect(resolvePath(without, atTask).map(e => e.refId)).toEqual(['a-coder', 's-build']);
    const noSession = makeSource({ sessions: [CODER_DM] });
    expect(resolvePath(noSession, atTask).map(e => e.refId)).toEqual(['a-coder']);
    const noAgent = makeSource({ agents: [ADA] });
    expect(resolvePath(noAgent, atTask)).toEqual([]);
  });
});

describe('children at each level', () => {
  it('workspace level lists every agent, including disabled ones', () => {
    const source = makeSource({ agents: [CODER, agent({ id: 'a-off', name: 'Off', enabled: false })] });
    const children = meshChildren(source, []);
    expect(children.map(n => n.id)).toEqual(['agent:a-coder', 'agent:a-off']);
    expect(children[1].status).toBe('inactive');
  });

  it('agent level lists that agent\'s sessions', () => {
    expect(meshChildren(SOURCE, pathTo('agent:a-coder')).map(n => n.id))
      .toEqual(['session:s-dm', 'session:s-build', 'session:s-build-fork']);
  });

  it('session level lists split threads then tasks', () => {
    expect(meshChildren(SOURCE, pathTo('agent:a-coder', 'session:s-build')).map(n => n.id))
      .toEqual(['session:s-build-fork', 'task:t-1', 'task:t-2', 'task:t-3']);
  });

  it('marks a busy agent live and a finished task dim', () => {
    const coder = meshChildren(SOURCE, []).find(n => n.refId === 'a-coder');
    expect(coder?.status).toBe('busy');
    expect(coder?.live).toBe(true);
    const done = meshChildren(SOURCE, pathTo('agent:a-coder', 'session:s-build')).find(n => n.refId === 't-3');
    expect(done?.live).toBe(false);
    expect(done?.dim).toBeLessThan(1);
  });

  it('keeps node ids stable between the ring and the centre', () => {
    const onRing = meshChildren(SOURCE, []).find(n => n.refId === 'a-coder');
    const centred = buildMeshView(SOURCE, pathTo('agent:a-coder')).center;
    // Continuity of the click->centre travel depends on this being the same id.
    expect(centred.id).toBe(onRing?.id);
  });
});

describe('breadcrumb', () => {
  it('is just the workspace at the root', () => {
    expect(buildMeshView(SOURCE, []).breadcrumb).toEqual([{ id: 'workspace:root', label: 'agensis', depth: 0 }]);
  });

  it('reads workspace > agent > channel > task at full depth', () => {
    const view = buildMeshView(SOURCE, pathTo('agent:a-coder', 'session:s-build', 'task:t-1'));
    expect(view.breadcrumb.map(c => c.label)).toEqual(['agensis', 'Coder', '#build', 'Fix the parser']);
    expect(view.breadcrumb.map(c => c.depth)).toEqual([0, 1, 2, 3]);
  });

  it('navigates back to the depth each crumb reports', () => {
    const full = pathTo('agent:a-coder', 'session:s-build', 'task:t-1');
    const crumbs = buildMeshView(SOURCE, full).breadcrumb;
    expect(crumbPath(full, crumbs[0].depth)).toEqual([]);
    expect(crumbPath(full, crumbs[1].depth).map(e => e.refId)).toEqual(['a-coder']);
    expect(crumbPath(full, crumbs[2].depth).map(e => e.refId)).toEqual(['a-coder', 's-build']);
    expect(crumbPath(full, crumbs[3].depth)).toEqual(full);
  });

  it('clamps an out-of-range depth instead of throwing', () => {
    const full = pathTo('agent:a-coder');
    expect(crumbPath(full, 99)).toEqual(full);
    expect(crumbPath(full, -3)).toEqual([]);
  });
});

describe('ring layout', () => {
  it('produces nothing for an empty level', () => {
    expect(ringLayout(0, 200)).toEqual([]);
    expect(ringLayout(-1, 200)).toEqual([]);
  });

  it('puts a single child at twelve o\'clock', () => {
    const [only] = ringLayout(1, 200);
    expect(only.x).toBeCloseTo(CX, 6);
    expect(only.y).toBeCloseTo(CY - 200, 6);
  });

  it('puts two children opposite each other', () => {
    const [top, bottom] = ringLayout(2, 200);
    expect(top.y).toBeCloseTo(CY - 200, 6);
    expect(bottom.y).toBeCloseTo(CY + 200, 6);
    expect(bottom.x).toBeCloseTo(CX, 6);
  });

  it('spaces many children evenly and never stacks two on one point', () => {
    const slots = ringLayout(12, 240);
    expect(slots).toHaveLength(12);
    for (const slot of slots) {
      expect(Math.hypot(slot.x - CX, slot.y - CY)).toBeCloseTo(240, 6);
    }
    const seen = new Set(slots.map(s => `${s.x.toFixed(3)},${s.y.toFixed(3)}`));
    expect(seen.size).toBe(12);
  });

  it('shrinks nodes and breathes the ring outward as a level fills up', () => {
    const view = buildMeshView(makeSource({ agents: Array.from({ length: 20 }, (_, i) => agent({ id: `a${i}` })) }), []);
    const small = buildMeshView(SOURCE, []);
    expect(view.layout.nodeR).toBeLessThan(small.layout.nodeR);
    expect(view.layout.ring).toBeGreaterThan(small.layout.ring);
  });

  it('parks the centre node at the hub with radius zero', () => {
    const view = buildMeshView(SOURCE, pathTo('agent:a-coder'));
    const slot = view.slots.get(view.center.id);
    expect(slot).toEqual({ index: -1, angle: -Math.PI / 2, radius: 0, x: view.layout.cx, y: view.layout.cy });
  });

  it('gives every rendered node a slot', () => {
    const view = buildMeshView(SOURCE, []);
    for (const node of view.nodes) expect(view.slots.has(node.id)).toBe(true);
  });
});

describe('fitting the drawing to its pane', () => {
  const layout = meshLayout(6);
  const bare = meshContentExtent(layout, 0);
  const withProviders = meshContentExtent(layout, 3);

  it('reaches further sideways than down once endpoints are on screen', () => {
    // A provider is a pill up to 190 wide and 30 tall. A single bounding circle
    // would reserve that sideways room in every direction, and the graph would
    // sit small in a box mostly made of its own margin.
    expect(withProviders.halfWidth).toBeGreaterThan(withProviders.halfHeight);
    expect(withProviders.halfWidth).toBeGreaterThan(bare.halfWidth);
  });

  it('covers the ring nodes and their labels when there are no endpoints', () => {
    expect(bare.halfWidth).toBe(bare.halfHeight);
    expect(bare.halfWidth).toBeGreaterThan(layout.ring + layout.nodeR);
  });

  it('stays centred on the hub whatever the pane is shaped like', () => {
    for (const [w, h] of [[1200, 300], [300, 1200], [700, 700], [0, 0]] as const) {
      const box = meshViewBox(layout, withProviders, w, h);
      expect(box.x + box.width / 2).toBeCloseTo(layout.cx, 6);
      expect(box.y + box.height / 2).toBeCloseTo(layout.cy, 6);
    }
  });

  it('takes the pane\'s aspect ratio, so the graph fills it instead of letterboxing', () => {
    // The split view's shape: wide and short. The old fixed 1000x840 box scaled
    // the whole diagram down to the height and left the width empty.
    const wide = meshViewBox(layout, withProviders, 1200, 300);
    expect(wide.width / wide.height).toBeCloseTo(4, 6);
    const tall = meshViewBox(layout, withProviders, 300, 1200);
    expect(tall.width / tall.height).toBeCloseTo(0.25, 6);
  });

  it('never clips the graph — the tighter axis decides the scale', () => {
    for (const [w, h] of [[1200, 300], [300, 1200], [700, 700], [1000, 840]] as const) {
      const box = meshViewBox(layout, withProviders, w, h);
      expect(box.width).toBeGreaterThanOrEqual(withProviders.halfWidth * 2 - 0.01);
      expect(box.height).toBeGreaterThanOrEqual(withProviders.halfHeight * 2 - 0.01);
    }
    // …and exactly one axis is tight, so there is no slack on both at once.
    const wide = meshViewBox(layout, withProviders, 1200, 300);
    expect(wide.height).toBeCloseTo(withProviders.halfHeight * 2, 1);
  });

  it('falls back to a box hugging the graph when the pane is unmeasurable', () => {
    // First frame, and jsdom, where clientWidth/Height are 0.
    for (const [w, h] of [[0, 0], [0, 400], [400, 0], [Number.NaN, 400], [-10, -10]] as const) {
      const box = meshViewBox(layout, withProviders, w, h);
      expect(box.width).toBeCloseTo(withProviders.halfWidth * 2, 6);
      expect(box.height).toBeCloseTo(withProviders.halfHeight * 2, 6);
    }
  });

  it('grows the window as the level fills up, so a crowded ring still fits', () => {
    const crowded = meshLayout(24);
    const box = meshViewBox(crowded, meshContentExtent(crowded, 2), 800, 600);
    const small = meshViewBox(layout, withProviders, 800, 600);
    expect(box.width).toBeGreaterThan(small.width);
  });
});

describe('hover preview fan', () => {
  const items = (n: number): MeshNode[] => Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, kind: 'session', refId: `s${i}`, label: `chan-${i}`, sublabel: '', glyph: '',
    status: 'idle', color: '#38bdf8', accent: '#38bdf8', live: false, dim: 1, badge: 0, childCount: 0,
  }));

  it('shows nothing when the node has no children', () => {
    expect(satelliteFan({ x: 500, y: 200 }, { x: CX, y: CY }, [])).toEqual({ shown: [], overflow: 0, side: 1 });
  });

  it('caps the fan and reports the overflow rather than piling chips up', () => {
    const fan = satelliteFan({ x: 500, y: 200 }, { x: CX, y: CY }, items(9), { max: 4 });
    expect(fan.shown).toHaveLength(4);
    expect(fan.overflow).toBe(5);
  });

  it('centres a lone chip on the node', () => {
    const fan = satelliteFan({ x: CX + 200, y: CY }, { x: CX, y: CY }, items(1), { distance: 60 });
    expect(fan.shown[0]).toMatchObject({ x: CX + 260, y: CY });
    expect(fan.overflow).toBe(0);
  });

  it('hangs the chips on the side away from the hub', () => {
    expect(satelliteFan({ x: CX + 200, y: CY }, { x: CX, y: CY }, items(2)).side).toBe(1);
    expect(satelliteFan({ x: CX - 200, y: CY }, { x: CX, y: CY }, items(2)).side).toBe(-1);
    const left = satelliteFan({ x: CX - 200, y: CY }, { x: CX, y: CY }, items(1), { distance: 60 });
    expect(left.shown[0].x).toBe(CX - 260);
  });

  // The whole reason this is a vertical stack and not an arc: chips carry names,
  // so they are wide and short. Separating them vertically is the only layout
  // that cannot collide, whatever the node count or its angle on the ring.
  it('separates every chip by at least its own height, at any ring position', () => {
    for (const angle of [0, Math.PI / 3, Math.PI / 2, Math.PI, -Math.PI / 4]) {
      const anchor = { x: CX + Math.cos(angle) * 210, y: CY + Math.sin(angle) * 210 };
      const fan = satelliteFan(anchor, { x: CX, y: CY }, items(4), { gap: 23 });
      const ys = fan.shown.map(c => c.y).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i += 1) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(18);
      // All on one vertical line, so widths can never overlap either.
      expect(new Set(fan.shown.map(c => c.x)).size).toBe(1);
    }
  });

  it('keeps the stack vertically centred on the node', () => {
    const anchor = { x: CX + 200, y: CY };
    const fan = satelliteFan(anchor, { x: CX, y: CY }, items(4), { gap: 20 });
    const mean = fan.shown.reduce((sum, c) => sum + c.y, 0) / fan.shown.length;
    expect(mean).toBeCloseTo(anchor.y, 6);
  });

  it('defaults to the right for a node sitting on the hub', () => {
    expect(satelliteFan({ x: CX, y: CY }, { x: CX, y: CY }, items(1), { distance: 40 }).shown[0].x).toBe(CX + 40);
  });

  it('previews exactly what a drill-in would reveal', () => {
    const coder = meshChildren(SOURCE, []).find(n => n.refId === 'a-coder')!;
    expect(previewChildren(SOURCE, [], coder).map(n => n.id))
      .toEqual(meshChildren(SOURCE, pathTo('agent:a-coder')).map(n => n.id));
  });

  it('previews nothing for a node that cannot be entered', () => {
    const provider = buildMeshView(SOURCE, []).providers[0];
    expect(previewChildren(SOURCE, [], provider)).toEqual([]);
  });
});

describe('message popup target', () => {
  it('stays closed above the leaf level', () => {
    expect(popupTarget(SOURCE, [])).toBeNull();
    expect(popupTarget(SOURCE, pathTo('agent:a-coder'))).toBeNull();
    expect(popupTarget(SOURCE, pathTo('agent:a-coder', 'session:s-build'))).toBeNull();
  });

  it('opens a task\'s comment thread at the leaf', () => {
    expect(popupTarget(SOURCE, pathTo('agent:a-coder', 'session:s-build', 'task:t-1')))
      .toEqual({ kind: 'task', id: 't-1', title: 'Fix the parser' });
  });

  it('opens a split thread\'s own messages at the leaf', () => {
    expect(popupTarget(SOURCE, pathTo('agent:a-coder', 'session:s-build', 'session:s-build-fork')))
      .toEqual({ kind: 'session', id: 's-build-fork', title: 'build (split)' });
  });
});

describe('reduced motion', () => {
  const cfg = motionConfig(true);

  it('zeroes every animated term', () => {
    expect(cfg.reduced).toBe(true);
    expect(cfg.driftRadPerSec).toBe(0);
    expect(cfg.bobRadius).toBe(0);
    expect(cfg.bobAngle).toBe(0);
    expect(cfg.staggerMs).toBe(0);
  });

  it('produces static positions at every time and index', () => {
    for (const t of [0, 0.016, 1, 7.5, 600]) {
      for (const index of [0, 1, 5, 19]) {
        expect(idleOffset(cfg, index, t)).toEqual({ angle: 0, radius: 0 });
      }
    }
  });

  it('snaps a spring straight onto its target instead of easing', () => {
    expect(stepSpring({ value: 0, velocity: 0 }, 210, 1 / 60, cfg.omega)).toEqual({ value: 210, velocity: 0 });
  });

  it('leaves the level fully navigable — the layout is unchanged by motion', () => {
    const view = buildMeshView(SOURCE, pathTo('agent:a-coder'));
    for (const child of view.children) {
      const slot = view.slots.get(child.id)!;
      expect(Math.hypot(slot.x - view.layout.cx, slot.y - view.layout.cy)).toBeCloseTo(view.layout.ring, 6);
    }
  });

  it('still drifts and bobs when motion is allowed', () => {
    const live = motionConfig(false);
    const first = idleOffset(live, 0, 1);
    const later = idleOffset(live, 0, 3);
    expect(first.angle).not.toBe(later.angle);
    // Per-node phase offsets: neighbours must not move as a rigid wheel.
    expect(idleOffset(live, 0, 1).radius).not.toBeCloseTo(idleOffset(live, 1, 1).radius, 4);
  });
});

describe('spring settle', () => {
  it('converges on its target without running away', () => {
    let s = { value: 0, velocity: 0 };
    for (let i = 0; i < 240; i += 1) s = stepSpring(s, 210, 1 / 60, 10);
    expect(s.value).toBeCloseTo(210, 3);
    expect(Math.abs(s.velocity)).toBeLessThan(0.5);
  });

  it('stays bounded when a frame is dropped', () => {
    let s = { value: 0, velocity: 0 };
    for (let i = 0; i < 40; i += 1) s = stepSpring(s, 210, 1.5, 10);
    expect(Number.isFinite(s.value)).toBe(true);
    expect(s.value).toBeGreaterThanOrEqual(0);
    expect(s.value).toBeLessThanOrEqual(211);
  });

  it('holds still when it is already there', () => {
    expect(stepSpring({ value: 210, velocity: 0 }, 210, 1 / 60, 10).value).toBeCloseTo(210, 9);
  });

  it('takes the short way round the ring', () => {
    expect(shortestAngleDelta(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2, 9);
    expect(shortestAngleDelta(Math.PI * 2 - 0.1, 0.1)).toBeCloseTo(0.2, 9);
    expect(Math.abs(shortestAngleDelta(0, Math.PI * 1.9))).toBeLessThanOrEqual(Math.PI);
  });
});

describe('labels', () => {
  it('truncates with an ellipsis and leaves short text alone', () => {
    expect(truncateLabel('Coder', 16)).toBe('Coder');
    expect(truncateLabel('An extremely long agent name', 10)).toBe('An extrem…');
    expect(truncateLabel('  padded  ', 16)).toBe('padded');
  });

  it('marks channels with a hash and DMs without one', () => {
    const children = meshChildren(SOURCE, pathTo('agent:a-coder'));
    expect(children.find(n => n.refId === 's-build')?.label).toBe('#build');
    expect(children.find(n => n.refId === 's-dm')?.sublabel).toBe('DM');
    expect(children.find(n => n.refId === 's-build-fork')?.sublabel).toBe('SPLIT');
  });
});

describe('empty and degenerate workspaces', () => {
  it('survives a workspace with no agents at all', () => {
    const view = buildMeshView(makeSource({ agents: [], sessions: [], tasks: [] }), []);
    expect(view.children).toEqual([]);
    expect(view.providers).toEqual([]);
    expect(view.center.label).toBe('agensis');
  });

  it('falls back to the workspace when the centred row is gone', () => {
    const orphan: MeshPath = [{ id: 'agent:ghost', kind: 'agent', refId: 'ghost', label: 'Ghost' }];
    const view = buildMeshView(SOURCE, orphan);
    expect(view.path).toEqual([]);
    expect(view.center.kind).toBe('workspace');
  });

  it('shows an empty ring for an agent with no sessions', () => {
    const view = buildMeshView(SOURCE, [{ id: 'agent:a-ada', kind: 'agent', refId: 'a-ada', label: 'Ada' }]);
    expect(view.children).toEqual([]);
    expect(view.center.refId).toBe('a-ada');
  });
});
