import { parseParticipants } from '../../lib/sessionParticipants';
import type { AgentConnection, ChatSession, Task, WorkspaceAgent } from '../../types';
import { agentAccentColor } from '../../lib/agentAccent';
import { CX, CY, KIND_META, STATUS_META, agentKind, agentStatus, initials, providerLabel, type NodeStatus } from './agentNetworkModel';

// The drillable half of the agent network view. Everything here is pure: no
// React, no DOM, no clock. The component is a renderer over these values, and
// the per-frame animator only ever reads them — so every navigation decision,
// every position and every count is testable without an SVG.
//
// Four levels, one path:
//   []                         workspace hub, agents on the ring
//   [agent]                    that agent centred, its sessions on the ring
//   [agent, session]           that session centred, its tasks/threads on the ring
//   [agent, session, task]     that leaf centred, messages in a popup
//
// Node ids are STABLE ACROSS LEVELS (`agent:<id>` is the same string whether it
// sits on the ring or in the middle). That is what lets the animator carry a
// clicked node from its ring slot into the centre instead of cutting to a new
// screen — the continuity the whole interaction rests on.

export type MeshLevel = 'workspace' | 'agent' | 'session' | 'task';
export type MeshNodeKind = 'workspace' | 'agent' | 'session' | 'thread' | 'task' | 'provider';

export interface MeshNode {
  /** Stable identity used for React keys AND animator continuity. */
  id: string;
  kind: MeshNodeKind;
  /** Domain row id (agent / session / task). Empty for the workspace root. */
  refId: string;
  label: string;
  sublabel: string;
  /** Two-character glyph drawn inside a disc node. */
  glyph: string;
  /** Closest live-status bucket — drives the focus-halo gradient only. */
  status: NodeStatus;
  /** Ring + pip colour actually painted. */
  color: string;
  /** Identity accent (inner hairline). */
  accent: string;
  /** Whether this node animates (flow dot along its spoke + ping ring). */
  live: boolean;
  /** Opacity multiplier for ghosted things (disabled agents, done tasks). */
  dim: number;
  /** Count chip. 0 means render NOTHING — never a `0` pill. */
  badge: number;
  /** How many children a drill-in would reveal. 0 = leaf. */
  childCount: number;
}

export interface MeshSource {
  workspaceName: string;
  agents: WorkspaceAgent[];
  connections: AgentConnection[];
  sessions: ChatSession[];
  tasks: Task[];
}

export interface MeshPathEntry {
  id: string;
  kind: MeshNodeKind;
  refId: string;
  label: string;
}

export type MeshPath = MeshPathEntry[];

export interface MeshCrumb {
  id: string;
  label: string;
  /** Path length this crumb navigates to: 0 = workspace root. */
  depth: number;
}

/** What the level-4 popup should load. `null` when nothing is open. */
export interface MeshPopupTarget {
  kind: 'session' | 'task';
  id: string;
  title: string;
}

export const MESH_LEVELS: MeshLevel[] = ['workspace', 'agent', 'session', 'task'];

export function meshLevel(path: MeshPath): MeshLevel {
  return MESH_LEVELS[Math.min(path.length, MESH_LEVELS.length - 1)];
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function lookupKey(value: unknown): string {
  return String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Does `session` have `agent` as a participant? Mirrors the composer's matcher
 * (id, then handle, then name) because participant rows are denormalised and an
 * older row may carry only a handle.
 */
type ParticipantRow = { kind?: string; agent_id?: string; handle?: string; name?: string } | null;

export function sessionHasAgent(session: ChatSession, agent: WorkspaceAgent): boolean {
  const participants = parseParticipants(session.participants) as ParticipantRow[];
  const keys = new Set([agent.id, agent.handle, agent.name].map(lookupKey).filter(Boolean));
  if (keys.size === 0) return false;
  return participants.some(participant => {
    if (participant?.kind !== 'agent') return false;
    return [participant.agent_id, participant.handle, participant.name]
      .map(lookupKey)
      .some(key => Boolean(key) && keys.has(key));
  });
}

/** A DM is a session with exactly one agent and at most one human. */
export function isDirectSession(session: ChatSession): boolean {
  if (session.folder === 'Direct messages') return true;
  const participants = parseParticipants(session.participants) as ParticipantRow[];
  const agents = participants.filter(p => p?.kind === 'agent');
  if (agents.length !== 1) return false;
  return participants.filter(p => p?.kind === 'user').length <= 1;
}

/**
 * A split fork. It inherits its source's participants, so `isDirectSession` alone
 * would read a fork of a one-agent channel as a DM and file it under the wrong
 * heading — lineage wins over shape.
 */
export function isForkSession(session: ChatSession): boolean {
  return Boolean(session.split_parent_id);
}

/** Is this a DM, or a fork of one? Walks lineage so a fork inherits its source. */
export function isDirectLineage(sessions: ChatSession[], session: ChatSession, depth = 0): boolean {
  const parentId = session.split_parent_id;
  if (!parentId || depth > 8) return isDirectSession(session);
  const parent = sessions.find(s => s.id === parentId);
  return parent ? isDirectLineage(sessions, parent, depth + 1) : isDirectSession(session);
}

function liveSession(session: ChatSession): boolean {
  return !session.deleted_at && !session.archived_at;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Open tasks assigned to an agent. Deliberately NOT all-time: a badge that only
 * goes up is noise, so `done` and `cancelled` never count.
 */
export function openTaskCount(tasks: Task[], assigneeId: string): number {
  if (!assigneeId) return 0;
  return tasks.filter(t => t.assignee_id === assigneeId && t.status !== 'done' && t.status !== 'cancelled').length;
}

/**
 * Tasks being worked in a session. The server stamps `source_type='chat'` +
 * `source_id=<session id>` when it dispatches a task to an agent, so this is the
 * real link, not a guess.
 */
export function tasksForSession(tasks: Task[], sessionId: string): Task[] {
  const open: Task[] = [];
  const closed: Task[] = [];
  for (const task of tasks) {
    if (task.source_type !== 'chat' || task.source_id !== sessionId) continue;
    if (task.status === 'cancelled') continue;
    (task.status === 'done' ? closed : open).push(task);
  }
  return [...open, ...closed];
}

/** Split forks of a session — its threads, in the sidebar's sense. */
export function threadsForSession(sessions: ChatSession[], sessionId: string): ChatSession[] {
  return sessions.filter(s => s.split_parent_id === sessionId && !s.deleted_at);
}

/** Sessions an agent is in, DMs first then most-recently-updated. */
export function sessionsForAgent(sessions: ChatSession[], agent: WorkspaceAgent): ChatSession[] {
  return sessions
    .filter(session => liveSession(session) && sessionHasAgent(session, agent))
    .sort((a, b) => {
      const rank = (s: ChatSession) => Number(isDirectSession(s) && !isForkSession(s));
      const direct = rank(b) - rank(a);
      if (direct !== 0) return direct;
      return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
    });
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

export function truncateLabel(text: string, max: number): string {
  const value = String(text ?? '').trim();
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Tasks get their own palette: reusing STATUS_META would paint a finished task
// in the "inactive agent" red, which reads as broken rather than done.
const TASK_TONE: Record<string, { color: string; live: boolean; dim: number; status: NodeStatus }> = {
  todo: { color: '#38bdf8', live: false, dim: 1, status: 'idle' },
  in_progress: { color: '#f59e0b', live: true, dim: 1, status: 'busy' },
  done: { color: '#71717a', live: false, dim: 0.45, status: 'disconnected' },
  cancelled: { color: '#71717a', live: false, dim: 0.35, status: 'disconnected' },
};

export function agentNode(source: MeshSource, agent: WorkspaceAgent): MeshNode {
  const status = agentStatus(agent, source.connections);
  const meta = STATUS_META[status];
  return {
    id: `agent:${agent.id}`,
    kind: 'agent',
    refId: agent.id,
    label: truncateLabel(agent.name, 16),
    sublabel: agent.handle ? `@${String(agent.handle).replace(/^@+/, '')}` : meta.label,
    glyph: initials(agent.name),
    status,
    color: meta.color,
    accent: agentAccentColor(agent),
    live: meta.flow,
    dim: meta.dim,
    badge: openTaskCount(source.tasks, agent.id),
    childCount: sessionsForAgent(source.sessions, agent).length,
  };
}

export function sessionNode(source: MeshSource, session: ChatSession, kind: 'session' | 'thread' = 'session'): MeshNode {
  // A session is as live as the agents in it: any busy agent makes it busy.
  const agents = source.agents.filter(agent => sessionHasAgent(session, agent));
  const statuses = agents.map(agent => agentStatus(agent, source.connections));
  const status: NodeStatus = statuses.includes('busy')
    ? 'busy'
    : statuses.includes('idle')
      ? 'idle'
      : statuses.length > 0 ? 'disconnected' : 'idle';
  const meta = STATUS_META[status];
  const direct = isDirectLineage(source.sessions, session);
  const title = session.title || (direct ? 'Direct message' : 'Channel');
  const childCount = tasksForSession(source.tasks, session.id).length + threadsForSession(source.sessions, session.id).length;
  return {
    id: `session:${session.id}`,
    kind,
    refId: session.id,
    label: truncateLabel(direct ? title : `#${title.replace(/^#/, '')}`, 18),
    sublabel: kind === 'thread' ? 'SPLIT' : direct ? 'DM' : 'CHANNEL',
    glyph: kind === 'thread' ? '↳' : direct ? 'DM' : '#',
    status,
    color: meta.color,
    accent: agents[0] ? agentAccentColor(agents[0]) : meta.color,
    live: meta.flow,
    dim: 1,
    badge: childCount,
    childCount,
  };
}

export function taskNode(task: Task): MeshNode {
  const tone = TASK_TONE[task.status] ?? TASK_TONE.todo;
  return {
    id: `task:${task.id}`,
    kind: 'task',
    refId: task.id,
    label: truncateLabel(task.title || 'Untitled task', 22),
    sublabel: String(task.status || 'todo').replace('_', ' ').toUpperCase(),
    glyph: '',
    status: tone.status,
    color: tone.color,
    accent: tone.color,
    live: tone.live,
    dim: tone.dim,
    badge: 0,
    childCount: 0,
  };
}

export function workspaceNode(source: MeshSource): MeshNode {
  const enabled = source.agents.filter(a => a.enabled !== false);
  const busy = enabled.filter(a => agentStatus(a, source.connections) === 'busy').length;
  return {
    id: 'workspace:root',
    kind: 'workspace',
    refId: '',
    label: truncateLabel(source.workspaceName || 'workspace', 18),
    sublabel: `${enabled.length} AGENT${enabled.length === 1 ? '' : 'S'}`,
    glyph: '',
    status: busy > 0 ? 'busy' : 'idle',
    color: STATUS_META[busy > 0 ? 'busy' : 'idle'].color,
    accent: STATUS_META.idle.color,
    live: false,
    dim: 1,
    badge: busy,
    childCount: source.agents.length,
  };
}

// ---------------------------------------------------------------------------
// Level resolution
// ---------------------------------------------------------------------------

function findAgent(source: MeshSource, refId: string): WorkspaceAgent | null {
  return source.agents.find(a => a.id === refId) ?? null;
}

function findSession(source: MeshSource, refId: string): ChatSession | null {
  return source.sessions.find(s => s.id === refId) ?? null;
}

function findTask(source: MeshSource, refId: string): Task | null {
  return source.tasks.find(t => t.id === refId) ?? null;
}

/**
 * Trim a path back to the deepest prefix that still resolves. A row can vanish
 * under you (task deleted, session archived, agent removed) while you are drilled
 * into it; without this the view would strand on a node that no longer exists.
 */
export function resolvePath(source: MeshSource, path: MeshPath): MeshPath {
  const out: MeshPath = [];
  for (const entry of path) {
    if (entry.kind === 'agent' && !findAgent(source, entry.refId)) break;
    if ((entry.kind === 'session' || entry.kind === 'thread') && !findSession(source, entry.refId)) break;
    if (entry.kind === 'task' && !findTask(source, entry.refId)) break;
    out.push(entry);
  }
  return out;
}

/** The ring at the given path. */
export function meshChildren(source: MeshSource, path: MeshPath): MeshNode[] {
  if (path.length === 0) {
    return source.agents.map(agent => agentNode(source, agent));
  }
  if (path.length === 1) {
    const agent = findAgent(source, path[0].refId);
    if (!agent) return [];
    return sessionsForAgent(source.sessions, agent)
      .map(session => sessionNode(source, session, isForkSession(session) ? 'thread' : 'session'));
  }
  if (path.length === 2) {
    const session = findSession(source, path[1].refId);
    if (!session) return [];
    return [
      ...threadsForSession(source.sessions, session.id).map(thread => sessionNode(source, thread, 'thread')),
      ...tasksForSession(source.tasks, session.id).map(taskNode),
    ];
  }
  return [];
}

/** The node in the middle at the given path. */
export function meshCenter(source: MeshSource, path: MeshPath): MeshNode {
  const last = path[path.length - 1];
  if (!last) return workspaceNode(source);
  if (last.kind === 'agent') {
    const agent = findAgent(source, last.refId);
    return agent ? agentNode(source, agent) : workspaceNode(source);
  }
  if (last.kind === 'session' || last.kind === 'thread') {
    const session = findSession(source, last.refId);
    return session ? sessionNode(source, session, last.kind) : workspaceNode(source);
  }
  const task = findTask(source, last.refId);
  return task ? taskNode(task) : workspaceNode(source);
}

export function breadcrumb(source: MeshSource, path: MeshPath): MeshCrumb[] {
  const root: MeshCrumb = { id: 'workspace:root', label: source.workspaceName || 'workspace', depth: 0 };
  return [root, ...path.map((entry, index) => ({ id: entry.id, label: entry.label, depth: index + 1 }))];
}

export function pathEntry(node: MeshNode): MeshPathEntry {
  return { id: node.id, kind: node.kind, refId: node.refId, label: node.label };
}

/**
 * Drill into a node. Returns the SAME path (referentially) when the node cannot
 * be entered — the centre, a provider endpoint, or an already-deepest level.
 */
export function drillInto(path: MeshPath, node: MeshNode): MeshPath {
  if (node.kind === 'workspace' || node.kind === 'provider') return path;
  if (path.length >= MESH_LEVELS.length - 1) return path;
  return [...path, pathEntry(node)];
}

/** Pop one level. Already at the root → unchanged. */
export function drillOut(path: MeshPath): MeshPath {
  return path.length === 0 ? path : path.slice(0, -1);
}

/** Jump to a breadcrumb depth (0 = workspace root). */
export function crumbPath(path: MeshPath, depth: number): MeshPath {
  return path.slice(0, Math.max(0, Math.min(depth, path.length)));
}

/**
 * What the popup should show for the current path — the leaf level only.
 * A task shows its comment thread (the mirror of the agent's sub-thread replies);
 * a split thread shows its own messages.
 */
export function popupTarget(source: MeshSource, path: MeshPath): MeshPopupTarget | null {
  if (path.length < MESH_LEVELS.length - 1) return null;
  const last = path[path.length - 1];
  if (!last) return null;
  if (last.kind === 'task') {
    const task = findTask(source, last.refId);
    return task ? { kind: 'task', id: task.id, title: task.title || 'Untitled task' } : null;
  }
  const session = findSession(source, last.refId);
  return session ? { kind: 'session', id: session.id, title: session.title || 'Thread' } : null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface MeshLayout {
  cx: number;
  cy: number;
  /** Radius the children sit at. */
  ring: number;
  /** Radius of a child node. */
  nodeR: number;
  /** Radius of the centre node. */
  centerR: number;
}

export interface RingSlot {
  index: number;
  angle: number;
  radius: number;
  x: number;
  y: number;
}

export function polarPoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

/**
 * Ring radius and node size derived from the child count so the graph never
 * overlaps: nodes shrink and the ring breathes outward as the level fills up.
 */
export function meshLayout(childCount: number): MeshLayout {
  const n = Math.max(childCount, 1);
  const nodeR = n <= 8 ? 34 : Math.max(17, Math.round(34 - (n - 8) * 1.4));
  const ring = Math.min(300, 210 + Math.max(0, n - 8) * 6);
  return { cx: CX, cy: CY, ring, nodeR, centerR: 58 };
}

/**
 * Radius the connection endpoints sit at — outside the child ring, capped so a
 * crowded level does not push them past the frame. ONE definition: the layout,
 * the extent below and the dashed guide circle in the diagram all read it, and
 * a fourth copy of `ring + 128` is how the endpoints end up clipped.
 */
export function providerRingRadius(layout: MeshLayout): number {
  return Math.min(layout.ring + 128, 352);
}

/**
 * How far the drawn graph actually reaches from the centre, per axis.
 *
 * A ring node's label sits at `r + 17` in 12px type, so it finishes around
 * `r + 26`. A provider is a PILL, not a disc — up to 190 wide and 30 tall — so
 * it reaches much further sideways than down, and a single bounding circle
 * would reserve that sideways room in every direction and leave the graph
 * looking small in its own box. Hence two half-extents.
 */
export const MESH_LABEL_ALLOWANCE = 26;
const PROVIDER_HALF_W = 95;
const PROVIDER_HALF_H = 15;

export interface MeshExtent {
  halfWidth: number;
  halfHeight: number;
}

export function meshContentExtent(layout: MeshLayout, providerCount: number): MeshExtent {
  const child = layout.ring + layout.nodeR + MESH_LABEL_ALLOWANCE;
  if (providerCount <= 0) return { halfWidth: child, halfHeight: child };
  const providers = providerRingRadius(layout);
  return {
    halfWidth: Math.max(child, providers + PROVIDER_HALF_W),
    halfHeight: Math.max(child, providers + PROVIDER_HALF_H),
  };
}

export interface MeshViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The window onto the diagram, so the graph FILLS the box it was given.
 *
 * The svg used to carry a fixed `0 0 1000 840`. With the default
 * `preserveAspectRatio` that letterboxes: in a wide, short pane — which is what
 * the split view hands it — the whole diagram scales down to the height and
 * floats in the middle of two large empty margins. The space was already
 * allocated; nothing was using it.
 *
 * The fix is to size the WINDOW to the container's aspect ratio instead of the
 * drawing to a fixed one. Node coordinates never move: this only decides how
 * much of the plane is on screen and therefore how big the graph is drawn.
 *
 * An unmeasurable container (first frame, jsdom) falls back to the content's
 * own aspect — a box tight around the graph, which is still an improvement on
 * a fixed one and is deterministic for tests.
 */
export function meshViewBox(
  layout: MeshLayout,
  extent: MeshExtent,
  containerWidth: number,
  containerHeight: number,
): MeshViewBox {
  const contentW = Math.max(1, extent.halfWidth * 2);
  const contentH = Math.max(1, extent.halfHeight * 2);
  const measured = Number.isFinite(containerWidth) && Number.isFinite(containerHeight)
    && containerWidth > 0 && containerHeight > 0;
  const aspect = measured ? containerWidth / containerHeight : contentW / contentH;
  // The smallest box with the container's aspect that still contains the graph:
  // whichever axis is the tighter fit decides the scale, and the other one gains
  // the slack. That is the same rule `meet` uses — applied to a box that hugs
  // the drawing rather than to a fixed 1000x840 frame.
  const width = Math.max(contentW, contentH * aspect);
  const height = width / aspect;
  return {
    x: round2(layout.cx - width / 2),
    y: round2(layout.cy - height / 2),
    width: round2(width),
    height: round2(height),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Evenly-spaced slots, first at 12 o'clock. `count <= 0` yields nothing. */
export function ringLayout(count: number, radius: number, cx = CX, cy = CY, startAngle = -Math.PI / 2): RingSlot[] {
  if (count <= 0) return [];
  const slots: RingSlot[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = startAngle + (index / count) * Math.PI * 2;
    const { x, y } = polarPoint(cx, cy, radius, angle);
    slots.push({ index, angle, radius, x, y });
  }
  return slots;
}

export interface MeshView {
  level: MeshLevel;
  path: MeshPath;
  center: MeshNode;
  children: MeshNode[];
  /**
   * Outer-ring connection endpoints. Level 1 only — this is the tier the poster
   * always had, kept so drilling ADDS a dimension instead of removing one.
   */
  providers: MeshNode[];
  /** Every rendered node — the centre first, then the ring, then providers. */
  nodes: MeshNode[];
  /** Target slot per node id. The centre's slot has radius 0. */
  slots: Map<string, RingSlot>;
  breadcrumb: MeshCrumb[];
  layout: MeshLayout;
  popup: MeshPopupTarget | null;
}

/**
 * Outer endpoints for the workspace level: agents sharing a provider spoke to the
 * same node, placed at the circular mean of their angles.
 */
function buildProviders(
  source: MeshSource,
  path: MeshPath,
  children: MeshNode[],
  slots: Map<string, RingSlot>,
  layout: MeshLayout,
): Array<{ node: MeshNode; slot: RingSlot }> {
  if (path.length !== 0) return [];
  const grouped = new Map<string, { kind: ReturnType<typeof agentKind>; angles: number[] }>();
  for (const agent of source.agents) {
    const slot = slots.get(`agent:${agent.id}`);
    if (!slot) continue;
    const label = providerLabel(agent);
    const entry = grouped.get(label) ?? { kind: agentKind(agent), angles: [] };
    entry.angles.push(slot.angle);
    grouped.set(label, entry);
  }
  const radius = providerRingRadius(layout);
  const out: Array<{ node: MeshNode; slot: RingSlot }> = [];
  let index = children.length;
  for (const [label, { kind, angles }] of grouped) {
    const sx = angles.reduce((sum, a) => sum + Math.cos(a), 0);
    const sy = angles.reduce((sum, a) => sum + Math.sin(a), 0);
    const angle = Math.atan2(sy, sx);
    const point = polarPoint(layout.cx, layout.cy, radius, angle);
    out.push({
      node: {
        id: `provider:${label}`,
        kind: 'provider',
        refId: label,
        label,
        sublabel: KIND_META[kind].label,
        glyph: '',
        status: 'idle',
        color: KIND_META[kind].color,
        accent: KIND_META[kind].color,
        live: false,
        dim: 1,
        badge: 0,
        childCount: 0,
      },
      slot: { index: index++, angle, radius, x: point.x, y: point.y },
    });
  }
  return out;
}

export function buildMeshView(source: MeshSource, rawPath: MeshPath): MeshView {
  const path = resolvePath(source, rawPath);
  const center = meshCenter(source, path);
  const children = meshChildren(source, path);
  const layout = meshLayout(children.length);
  const slots = new Map<string, RingSlot>();
  slots.set(center.id, { index: -1, angle: -Math.PI / 2, radius: 0, x: layout.cx, y: layout.cy });
  ringLayout(children.length, layout.ring, layout.cx, layout.cy).forEach((slot, index) => {
    slots.set(children[index].id, slot);
  });
  const providerPairs = buildProviders(source, path, children, slots, layout);
  const providers = providerPairs.map(pair => pair.node);
  for (const pair of providerPairs) slots.set(pair.node.id, pair.slot);
  return {
    level: meshLevel(path),
    path,
    center,
    children,
    providers,
    nodes: [center, ...children, ...providers],
    slots,
    breadcrumb: breadcrumb(source, path),
    layout,
    popup: popupTarget(source, path),
  };
}

/** The ring a drill-in on `node` would produce — used for the hover preview fan. */
export function previewChildren(source: MeshSource, path: MeshPath, node: MeshNode): MeshNode[] {
  const next = drillInto(path, node);
  return next === path ? [] : meshChildren(source, next);
}

// ---------------------------------------------------------------------------
// Hover satellites
// ---------------------------------------------------------------------------

export interface Satellite {
  id: string;
  label: string;
  color: string;
  x: number;
  y: number;
}

export interface SatelliteFan {
  shown: Satellite[];
  /** How many children did not fit. 0 = all shown. */
  overflow: number;
  /** +1 = chips extend to the RIGHT of the node, -1 = to the left. */
  side: 1 | -1;
}

export interface SatelliteOptions {
  /** Hard cap. Beyond this the fan stops being readable at any geometry. */
  max?: number;
  /** Horizontal gap from the anchor node's centre to the near edge of a chip. */
  distance?: number;
  /** Vertical pitch between chips. Must exceed the chip height. */
  gap?: number;
}

/**
 * Preview callout for a hovered node: the children a drill-in would reveal.
 *
 * This started as a true arc and was changed after looking at it. Chips carry
 * channel and task NAMES, so they are ~60-130px wide and ~18px tall; on any arc
 * small enough to read as "belonging to" the node they overlap each other
 * completely, and the fan is worse than useless — see the arc/ladder maths in
 * the review notes. Stacking them vertically on the OUTWARD side separates them
 * along the axis where a pill is thin, so the layout is collision-free by
 * construction at any node count and any position on the ring. Still capped, so
 * a busy agent degrades to "4 shown + N more" rather than a wall of pills.
 */
export function satelliteFan(
  anchor: { x: number; y: number },
  center: { x: number; y: number },
  items: MeshNode[],
  options: SatelliteOptions = {},
): SatelliteFan {
  const max = options.max ?? 4;
  const distance = options.distance ?? 54;
  const gap = options.gap ?? 23;
  // Outward = the side away from the hub, so chips never lie across the middle.
  const side: 1 | -1 = anchor.x >= center.x ? 1 : -1;
  if (items.length === 0 || max <= 0) return { shown: [], overflow: Math.max(0, items.length), side };
  const shownItems = items.slice(0, max);
  const top = -((shownItems.length - 1) / 2) * gap;
  const shown = shownItems.map((item, index) => ({
    id: item.id,
    label: item.label,
    color: item.color,
    x: anchor.x + side * distance,
    y: anchor.y + top + index * gap,
  }));
  return { shown, overflow: items.length - shownItems.length, side };
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

export interface MotionConfig {
  reduced: boolean;
  /** Whole-ring orbital drift. */
  driftRadPerSec: number;
  /** Per-node radial bob amplitude, in px. */
  bobRadius: number;
  /** Per-node angular bob amplitude, in radians. */
  bobAngle: number;
  bobPeriodSec: number;
  /** Per-node arrival stagger when a level changes. */
  staggerMs: number;
  /** Spring frequency for the settle. */
  omega: number;
}

export const DEFAULT_MOTION: MotionConfig = {
  reduced: false,
  driftRadPerSec: 0.028,
  bobRadius: 4.5,
  bobAngle: 0.012,
  bobPeriodSec: 6.5,
  staggerMs: 38,
  omega: 10,
};

const STATIC_MOTION: MotionConfig = {
  reduced: true,
  driftRadPerSec: 0,
  bobRadius: 0,
  bobAngle: 0,
  bobPeriodSec: 0,
  staggerMs: 0,
  omega: 0,
};

/** Reduced motion collapses every animated term to zero — positions go static. */
export function motionConfig(reduced: boolean): MotionConfig {
  return reduced ? STATIC_MOTION : DEFAULT_MOTION;
}

/**
 * Whole-ring orbital drift: cumulative, shared by every node, never damped.
 * Unbounded by construction, so it must never be scaled or reset mid-flight —
 * that would teleport the ring.
 */
export function driftAngle(config: MotionConfig, tSec: number): number {
  return config.reduced ? 0 : config.driftRadPerSec * tSec;
}

/**
 * Per-node bob. Bounded and phase-offset by index so nodes breathe
 * independently instead of turning as a rigid wheel — and, being bounded, safe
 * to freeze under the cursor.
 */
export function bobOffset(config: MotionConfig, index: number, tSec: number): { angle: number; radius: number } {
  if (config.reduced) return { angle: 0, radius: 0 };
  const phase = index * 1.7;
  const w = config.bobPeriodSec > 0 ? (Math.PI * 2) / config.bobPeriodSec : 0;
  return {
    angle: Math.sin(tSec * w * 0.83 + phase) * config.bobAngle,
    radius: Math.sin(tSec * w + phase) * config.bobRadius,
  };
}

/** Drift + bob. Zero on every term under reduced motion. */
export function idleOffset(config: MotionConfig, index: number, tSec: number): { angle: number; radius: number } {
  const bob = bobOffset(config, index, tSec);
  return { angle: driftAngle(config, tSec) + bob.angle, radius: bob.radius };
}

export interface Spring {
  value: number;
  velocity: number;
}

/** Signed shortest way from `from` to `to`, in (-π, π]. */
export function shortestAngleDelta(from: number, to: number): number {
  const tau = Math.PI * 2;
  let delta = (to - from) % tau;
  if (delta > Math.PI) delta -= tau;
  if (delta <= -Math.PI) delta += tau;
  return delta;
}

/**
 * One implicit critically-damped spring step. Implicit so a dropped frame can
 * never blow it up — `dt` is clamped and the integrator is unconditionally
 * stable, unlike the explicit form.
 */
export function stepSpring(spring: Spring, target: number, dt: number, omega: number): Spring {
  if (omega <= 0 || dt <= 0) return { value: target, velocity: 0 };
  const h = Math.min(dt, 1 / 30);
  const f = 1 + 2 * h * omega;
  const oo = omega * omega;
  const hoo = h * oo;
  const hhoo = h * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * spring.value + h * spring.velocity + hhoo * target;
  const detV = spring.velocity + hoo * (target - spring.value);
  return { value: detX * detInv, velocity: detV * detInv };
}

/** Control point of the quadratic spoke from (x1,y1) to (x2,y2). */
export function spokeControl(x1: number, y1: number, x2: number, y2: number, bow = 0.1): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return { x: (x1 + x2) / 2 - dy * bow, y: (y1 + y2) / 2 + dx * bow };
}

/** Curved hub→node spoke, bowed perpendicular so the graph reads as routing. */
export function spokePath(x1: number, y1: number, x2: number, y2: number, bow = 0.1): string {
  const c = spokeControl(x1, y1, x2, y2, bow);
  return `M ${x1} ${y1} Q ${c.x} ${c.y} ${x2} ${y2}`;
}

/**
 * Point at `u` along a quadratic Bézier. The travelling "work in flight" dot
 * rides this instead of SMIL `animateMotion`: the spoke now moves every frame,
 * and animateMotion samples its path once at start, so the dot would drift off
 * the wire it is meant to be on.
 */
export function bezierPoint(
  p0: { x: number; y: number },
  c: { x: number; y: number },
  p1: { x: number; y: number },
  u: number,
): { x: number; y: number } {
  const t = Math.min(1, Math.max(0, u));
  const inv = 1 - t;
  return {
    x: inv * inv * p0.x + 2 * inv * t * c.x + t * t * p1.x,
    y: inv * inv * p0.y + 2 * inv * t * c.y + t * t * p1.y,
  };
}
