import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CornerLeftUp } from 'lucide-react';
import type { AgentConnection, ChatSession, Task, WorkspaceAgent } from '../../types';
import { Button } from '@/components/ui/button';
import { KIND_META, STATUS_META, type ConnKind, type NodeStatus } from './agentNetworkModel';
import {
  bezierPoint,
  bobOffset,
  buildMeshView,
  crumbPath,
  drillInto,
  drillOut,
  driftAngle,
  motionConfig,
  previewChildren,
  satelliteFan,
  shortestAngleDelta,
  spokeControl,
  spokePath,
  stepSpring,
  truncateLabel,
  type MeshNode,
  type MeshPath,
  type MeshSource,
  type Spring,
} from './agentMeshModel';
import { AgentMeshMessages } from './AgentMeshMessages';

interface AgentNetworkDiagramProps {
  agents: WorkspaceAgent[];
  connections?: AgentConnection[];
  sessions?: ChatSession[];
  tasks?: Task[];
  workspaceName?: string;
  workspaceId?: string | null;
  currentUserId?: string | null;
  onSelectAgent?: (id: string) => void;
}

const REDUCED =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Instrument-label typeface: matches the app's mono usage, falls back cleanly.
const MONO = "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const VIEW_W = 1000;
const VIEW_H = 840;
/** How long a departed node lingers while it fades and retreats. */
const EXIT_MS = 420;
const FLOW_PERIOD_SEC = 1.7;

const LEVEL_HINT: Record<string, string> = {
  workspace: 'AGENTS',
  agent: 'CHANNELS & DMS',
  session: 'TASKS & THREADS',
  task: 'MESSAGES',
};

interface NodeAnim {
  radius: Spring;
  angle: Spring;
  alpha: Spring;
  /** Idle-drift rate, 1 = drifting, 0 = parked. Hovering parks a node. */
  damp: Spring;
  /**
   * Per-node clock, advanced by `dt * damp`. Freezing the CLOCK rather than
   * scaling the offset is what lets a node decelerate to a stop under the
   * cursor without snapping back to its base angle.
   */
  clock: number;
  index: number;
  targetRadius: number;
  targetAngle: number;
  targetAlpha: number;
  targetDamp: number;
  /** Identity of the slot the springs are currently aiming at. */
  slotKey: string;
  /** Stagger gate: springs hold until this timestamp so arrivals fan out. */
  readyAt: number;
  live: boolean;
  spoke: boolean;
}

const spring = (value: number): Spring => ({ value, velocity: 0 });

export function AgentNetworkDiagram({
  agents,
  connections = [],
  sessions = [],
  tasks = [],
  workspaceName = 'agensis',
  workspaceId = null,
  currentUserId = null,
  onSelectAgent,
}: AgentNetworkDiagramProps) {
  const [path, setPath] = useState<MeshPath>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [exiting, setExiting] = useState<MeshNode[]>([]);

  const source: MeshSource = useMemo(
    () => ({ workspaceName, agents, connections, sessions, tasks }),
    [workspaceName, agents, connections, sessions, tasks],
  );
  const view = useMemo(() => buildMeshView(source, path), [source, path]);
  const { layout } = view;

  // A row can disappear under you (task deleted, session archived). buildMeshView
  // trims the path to the deepest prefix that still resolves; mirror that back
  // into state so the breadcrumb and Escape agree with what is on screen.
  useEffect(() => {
    if (view.path.length !== path.length) setPath(view.path);
  }, [view.path, path.length]);

  // ---- rendered set: live nodes + the ones that just left -------------------
  const renderNodes = useMemo(() => {
    const liveIds = new Set(view.nodes.map(n => n.id));
    return [
      ...view.nodes.map(node => ({ node, exiting: false })),
      ...exiting.filter(node => !liveIds.has(node.id)).map(node => ({ node, exiting: true })),
    ];
  }, [view.nodes, exiting]);

  const previousNodesRef = useRef<MeshNode[]>([]);
  useEffect(() => {
    const currentIds = new Set(view.nodes.map(n => n.id));
    const gone = previousNodesRef.current.filter(node => !currentIds.has(node.id));
    previousNodesRef.current = view.nodes;
    // The common case (a realtime row update with the same node set) writes no
    // state at all — only an actual level change costs the two extra renders.
    if (gone.length > 0) setExiting(gone);
  }, [view.nodes]);

  // The clear-down timer belongs to `exiting`, NOT to `view.nodes`: a realtime
  // update landing mid-transition would otherwise tear down the timer and then
  // skip re-arming it, stranding the departed nodes in the render set forever.
  useEffect(() => {
    if (exiting.length === 0) return;
    const timer = setTimeout(() => setExiting([]), EXIT_MS);
    return () => clearTimeout(timer);
  }, [exiting]);

  // ---- navigation ----------------------------------------------------------
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusSelf = useCallback(() => containerRef.current?.focus({ preventScroll: true }), []);

  const goTo = useCallback((next: MeshPath) => {
    setPath(prev => (next === prev ? prev : next));
    setHover(null);
    focusSelf();
  }, [focusSelf]);

  const onNodeActivate = useCallback((node: MeshNode) => {
    if (node.id === view.center.id) {
      goTo(drillOut(path));
      return;
    }
    goTo(drillInto(path, node));
  }, [goTo, path, view.center.id]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || path.length === 0) return;
    // Only swallow Escape when there is actually a level to pop, so the window's
    // own Escape handling still works at the top level.
    event.preventDefault();
    event.stopPropagation();
    goTo(drillOut(path));
  }, [goTo, path]);

  // ---- hover preview fan ---------------------------------------------------
  const hoverNode = hover ? view.nodes.find(n => n.id === hover) ?? null : null;
  const fan = useMemo(() => {
    if (!hoverNode || hoverNode.id === view.center.id || hoverNode.kind === 'provider') return null;
    const slot = view.slots.get(hoverNode.id);
    if (!slot) return null;
    const items = previewChildren(source, path, hoverNode);
    if (items.length === 0) return null;
    const arc = satelliteFan(slot, { x: layout.cx, y: layout.cy }, items, {
      max: 4,
      distance: layout.nodeR + 16,
    });
    // Relative to the node's own group so the chips ride its drift for free.
    return {
      overflow: arc.overflow,
      side: arc.side,
      shown: arc.shown.map(s => ({ ...s, x: s.x - slot.x, y: s.y - slot.y })),
    };
  }, [hoverNode, view.center.id, view.slots, source, path, layout.cx, layout.cy, layout.nodeR]);

  // ---- the single animation loop ------------------------------------------
  // Every frame writes DOM attributes through refs. Nothing here calls setState,
  // so a 60fps orbit costs zero React renders — the component only re-renders on
  // a level change, a hover, or a realtime data update.
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const spokeRefs = useRef(new Map<string, SVGPathElement>());
  const flowRefs = useRef(new Map<string, SVGCircleElement>());
  const animRef = useRef(new Map<string, NodeAnim>());
  const frameRef = useRef(0);
  const startRef = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  /** Shared ring clock — what a node born mid-orbit inherits. */
  const ringClockRef = useRef(0);
  const motion = useMemo(() => motionConfig(REDUCED), []);

  const paint = useCallback((nowMs: number, dt: number) => {
    const tSec = (nowMs - startRef.current) / 1000;
    ringClockRef.current = tSec;
    const drift = driftAngle(motion, tSec);
    const { cx, cy } = layout;
    for (const [id, anim] of animRef.current) {
      if (dt > 0 && nowMs >= anim.readyAt) {
        anim.radius = stepSpring(anim.radius, anim.targetRadius, dt, motion.omega);
        anim.angle = stepSpring(anim.angle, anim.targetAngle, dt, motion.omega);
        anim.alpha = stepSpring(anim.alpha, anim.targetAlpha, dt, motion.omega * 1.6);
        anim.damp = stepSpring(anim.damp, anim.targetDamp, dt, motion.omega * 1.8);
      }
      anim.clock += dt * Math.max(0, Math.min(1, anim.damp.value));
      // Orbit terms fade with the node's CURRENT radius, not its target: the hub
      // must not swim, but switching drift off the instant a node is clicked
      // would snap it sideways by the whole accumulated drift angle. Scaling by
      // radius makes it continuous, and at radius 0 the angle stops mattering.
      const orbitScale = Math.min(1, anim.radius.value / Math.max(1, layout.ring));
      const bob = bobOffset(motion, anim.index, anim.clock);
      const angle = anim.angle.value + (drift + bob.angle) * orbitScale;
      const radius = Math.max(0, anim.radius.value + bob.radius * orbitScale);
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const alpha = Math.max(0, Math.min(1, anim.alpha.value));

      const group = nodeRefs.current.get(id);
      if (group) {
        group.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
        group.setAttribute('opacity', alpha.toFixed(3));
      }
      const spokeEl = anim.spoke ? spokeRefs.current.get(id) : null;
      if (spokeEl) {
        spokeEl.setAttribute('d', spokePath(cx, cy, x, y));
        spokeEl.setAttribute('opacity', (alpha * 0.5).toFixed(3));
      }
      const flowEl = anim.live ? flowRefs.current.get(id) : null;
      if (flowEl) {
        const u = motion.reduced ? 0.5 : ((tSec + anim.index * 0.31) % FLOW_PERIOD_SEC) / FLOW_PERIOD_SEC;
        const point = bezierPoint({ x: cx, y: cy }, spokeControl(cx, cy, x, y), { x, y }, u);
        flowEl.setAttribute('cx', point.x.toFixed(2));
        flowEl.setAttribute('cy', point.y.toFixed(2));
        flowEl.setAttribute('opacity', (alpha * (motion.reduced ? 0.9 : Math.sin(u * Math.PI))).toFixed(3));
      }
    }
  }, [layout, motion]);

  // Targets are synced in a LAYOUT effect and painted once before the browser
  // paints, so a newly-mounted node is never visible at its JSX position for a
  // frame before the animator seeds it.
  useLayoutEffect(() => {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const map = animRef.current;
    const seen = new Set<string>();
    renderNodes.forEach(({ node, exiting: isExiting }, index) => {
      seen.add(node.id);
      const slot = view.slots.get(node.id);
      const isCenter = node.id === view.center.id;
      const targetRadius = isExiting ? layout.ring + 110 : slot?.radius ?? layout.ring;
      const targetAngle = slot?.angle ?? -Math.PI / 2;
      const faded = hover && hover !== node.id && !isCenter ? 0.32 : 1;
      const targetAlpha = isExiting ? 0 : node.dim * faded;
      const slotKey = `${targetRadius.toFixed(2)}|${targetAngle.toFixed(4)}`;

      let anim = map.get(node.id);
      if (!anim) {
        // A brand-new node is born at the hub and springs outward — that is what
        // makes a level change read as an expansion rather than a hard cut.
        const born = motion.reduced
          ? { radius: spring(targetRadius), angle: spring(targetAngle), alpha: spring(targetAlpha) }
          : { radius: spring(0), angle: spring(targetAngle), alpha: spring(0) };
        anim = {
          ...born,
          // A node born into an already-drifting ring inherits the ring's clock,
          // so it does not appear one full drift-phase behind its neighbours.
          damp: spring(1),
          clock: ringClockRef.current,
          index,
          targetRadius,
          targetAngle,
          targetAlpha,
          targetDamp: 1,
          slotKey,
          readyAt: now + Math.min(index, 14) * motion.staggerMs,
          live: node.live,
          spoke: !isCenter && node.kind !== 'provider',
        };
        map.set(node.id, anim);
      } else {
        if (anim.slotKey !== slotKey) {
          anim.slotKey = slotKey;
          anim.targetRadius = targetRadius;
          // Into the hub: keep the angle, so the clicked node travels straight
          // in rather than spiralling. Onto a ring: unwrap to the nearest
          // equivalent angle so it never takes the long way round.
          anim.targetAngle = targetRadius === 0
            ? anim.angle.value
            : anim.angle.value + shortestAngleDelta(anim.angle.value, targetAngle);
          anim.readyAt = now + Math.min(index, 14) * motion.staggerMs;
          if (motion.reduced) {
            anim.radius = spring(targetRadius);
            anim.angle = spring(anim.targetAngle);
          }
        }
        anim.index = index;
        anim.targetAlpha = targetAlpha;
        anim.live = node.live;
        anim.spoke = !isCenter && node.kind !== 'provider';
        if (motion.reduced) anim.alpha = spring(targetAlpha);
      }
      // Park the node under the cursor so it is a still target and its preview
      // fan is readable; everything else keeps breathing.
      anim.targetDamp = hover === node.id ? 0 : 1;
      if (motion.reduced) {
        anim.damp = spring(anim.targetDamp);
      }
    });
    for (const id of [...map.keys()]) {
      if (!seen.has(id)) map.delete(id);
    }
    paint(now, 0);
  }, [renderNodes, view.slots, view.center.id, layout.ring, hover, motion, paint]);

  useEffect(() => {
    if (motion.reduced) return;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      paint(now, dt);
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameRef.current);
  }, [motion.reduced, paint]);

  if (agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No agents to visualize yet.
      </div>
    );
  }

  const centerAgentId = view.center.kind === 'agent' ? view.center.refId : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative flex h-full flex-col outline-none"
    >
      {/* Breadcrumb — the path, and the way back out of it. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-[10px]"
        style={{ fontFamily: MONO }}>
        {path.length > 0 && (
          <Button type="button" size="icon-sm" variant="ghost" onClick={() => goTo(drillOut(path))}
            aria-label="Back one level" title="Back one level (Esc)">
            <CornerLeftUp size={13} />
          </Button>
        )}
        <nav aria-label="Network path" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
          {view.breadcrumb.map((crumb, index) => (
            <span key={crumb.id} className="flex items-center gap-0.5">
              {index > 0 && <ChevronRight size={11} className="shrink-0 text-muted-foreground/40" />}
              <button
                type="button"
                onClick={() => goTo(crumbPath(path, crumb.depth))}
                disabled={crumb.depth === path.length}
                className="max-w-[160px] truncate rounded px-1 py-0.5 tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:font-semibold disabled:text-foreground disabled:hover:bg-transparent"
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <span className="shrink-0 tracking-widest text-muted-foreground/50">{LEVEL_HINT[view.level]}</span>
        {centerAgentId && onSelectAgent && (
          <Button type="button" size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-[10px]"
            onClick={() => onSelectAgent(centerAgentId)}>
            Open agent
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="size-full" role="img"
          aria-label={`Agent network, ${view.breadcrumb.map(c => c.label).join(' / ')}`}>
          <defs>
            <radialGradient id="hub-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
              <stop offset="65%" stopColor="var(--primary)" stopOpacity="0.05" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </radialGradient>
            {(Object.keys(STATUS_META) as NodeStatus[]).map(s => (
              <radialGradient key={s} id={`focus-${s}`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={STATUS_META[s].color} stopOpacity="0.4" />
                <stop offset="100%" stopColor={STATUS_META[s].color} stopOpacity="0" />
              </radialGradient>
            ))}
          </defs>

          {/* Range rings — hairline orbits that make the tiers legible. */}
          <circle cx={layout.cx} cy={layout.cy} r={layout.ring} fill="none" stroke="var(--border)"
            strokeOpacity={0.6} strokeWidth={1} />
          {view.providers.length > 0 && (
            <circle cx={layout.cx} cy={layout.cy} r={Math.min(layout.ring + 128, 352)} fill="none"
              stroke="var(--border)" strokeOpacity={0.35} strokeWidth={1} strokeDasharray="2 7" />
          )}

          {/* Spokes, behind everything. One path per node, moved by the animator. */}
          <g>
            {renderNodes.map(({ node }) => (node.id === view.center.id || node.kind === 'provider' ? null : (
              <path
                key={`spoke-${node.id}`}
                ref={el => { if (el) spokeRefs.current.set(node.id, el); else spokeRefs.current.delete(node.id); }}
                fill="none"
                stroke={node.color}
                strokeWidth={hover === node.id ? 2.5 : 1.5}
                strokeLinecap="round"
                opacity={0}
              />
            )))}
            {/* Provider spokes are hairline and static-ish: agent -> its endpoint. */}
            {view.providers.map(provider => {
              const slot = view.slots.get(provider.id);
              if (!slot) return null;
              return (
                <path
                  key={`pspoke-${provider.id}`}
                  d={spokePath(layout.cx, layout.cy, slot.x, slot.y, 0.05)}
                  fill="none"
                  stroke="var(--muted-foreground)"
                  strokeOpacity={0.18}
                  strokeWidth={1}
                  strokeDasharray="1 6"
                  strokeLinecap="round"
                />
              );
            })}
          </g>

          {/* Travelling "work in flight" dots. */}
          <g>
            {renderNodes.map(({ node }) => (node.live && node.id !== view.center.id && !motion.reduced ? (
              <circle
                key={`flow-${node.id}`}
                ref={el => { if (el) flowRefs.current.set(node.id, el); else flowRefs.current.delete(node.id); }}
                r={3}
                fill={node.color}
                opacity={0}
              />
            ) : null))}
          </g>

          {/* Hub glow sits under the centre node. */}
          <circle cx={layout.cx} cy={layout.cy} r={150} fill="url(#hub-glow)" />

          {/* Every node — centre, ring and providers — in one uniform layer. */}
          {renderNodes.map(({ node, exiting: isExiting }) => (
            <g
              key={node.id}
              ref={el => { if (el) nodeRefs.current.set(node.id, el); else nodeRefs.current.delete(node.id); }}
              opacity={0}
              style={{ pointerEvents: isExiting || node.kind === 'provider' ? 'none' : 'auto' }}
            >
              <MeshNodeShape
                node={node}
                isCenter={node.id === view.center.id}
                focused={hover === node.id}
                layout={layout}
                canPop={path.length > 0}
                fan={hover === node.id ? fan : null}
                onActivate={() => onNodeActivate(node)}
                onHover={setHover}
              />
            </g>
          ))}

          {/* Empty level: say so rather than showing a bare centre node. */}
          {view.children.length === 0 && view.level !== 'task' && (
            <text x={layout.cx} y={layout.cy + layout.ring} textAnchor="middle" fontSize={11}
              letterSpacing="0.12em" className="fill-muted-foreground" style={{ fontFamily: MONO }}>
              NOTHING HERE YET
            </text>
          )}
        </svg>
      </div>

      {/* Legend: live STATUS + CONNECTION kind (level 1 only, where endpoints show). */}
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-border px-3 py-2 text-[10px]"
        style={{ fontFamily: MONO }}>
        <span className="mr-0.5 tracking-widest text-muted-foreground/60">STATUS</span>
        {(Object.keys(STATUS_META) as NodeStatus[]).map(s => (
          <span key={s} className="inline-flex items-center gap-1.5 tracking-wide text-muted-foreground">
            <span className="size-2 rounded-full" style={{ backgroundColor: STATUS_META[s].color }} />
            {STATUS_META[s].label.toUpperCase()}
          </span>
        ))}
        {view.providers.length > 0 && (
          <>
            <span className="mx-1 h-3 w-px bg-border" />
            <span className="mr-0.5 tracking-widest text-muted-foreground/60">LINK</span>
            {(Object.keys(KIND_META) as ConnKind[]).map(k => (
              <span key={k} className="inline-flex items-center gap-1.5 tracking-wide text-muted-foreground">
                <span className="size-2 rounded-[2px]" style={{ backgroundColor: KIND_META[k].color }} />
                {KIND_META[k].label.toUpperCase()}
              </span>
            ))}
          </>
        )}
      </div>

      {view.popup && (
        <AgentMeshMessages
          target={view.popup}
          workspaceId={workspaceId}
          userId={currentUserId}
          agents={agents}
          onClose={() => goTo(drillOut(path))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node shapes. Pure presentation: positions come from the animator, never here.
// ---------------------------------------------------------------------------

const CENTER_MIN_PX = 10;

/** Largest size (18 → 10) at which `label` still fits inside a disc of radius r. */
function centerFontSize(label: string, r: number): number {
  const chars = Math.max(1, label.length);
  return Math.max(CENTER_MIN_PX, Math.min(18, Math.floor((r * 1.78) / (chars * 0.56))));
}

/** Clip a centre label to what fits at the smallest size we are willing to use. */
function centerLabel(label: string, r: number): string {
  return truncateLabel(label, Math.max(4, Math.floor((r * 1.78) / (CENTER_MIN_PX * 0.56))));
}

function MeshNodeShape({ node, isCenter, focused, layout, canPop, fan, onActivate, onHover }: {
  node: MeshNode;
  isCenter: boolean;
  focused: boolean;
  layout: { nodeR: number; centerR: number };
  canPop: boolean;
  fan: { shown: Array<{ id: string; label: string; color: string; x: number; y: number }>; overflow: number; side: 1 | -1 } | null;
  onActivate: () => void;
  onHover: (id: string | null) => void;
}) {
  const r = isCenter ? layout.centerR : layout.nodeR;
  const interactive = node.kind !== 'provider' && (!isCenter || canPop);
  const handlers = {
    onClick: interactive ? onActivate : undefined,
    onMouseEnter: () => onHover(node.id),
    onMouseLeave: () => onHover(null),
    onKeyDown: interactive
      ? (event: React.KeyboardEvent<SVGGElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onActivate();
      }
      : undefined,
    tabIndex: interactive ? 0 : undefined,
    role: interactive ? 'button' : undefined,
    'aria-label': interactive
      ? `${node.label}${node.sublabel ? `, ${node.sublabel}` : ''}${isCenter ? ', back one level' : ''}`
      : undefined,
    className: interactive ? 'cursor-pointer outline-none' : undefined,
  };

  if (node.kind === 'provider') {
    const w = Math.max(104, Math.min(190, node.label.length * 8.2 + 40));
    return (
      <g>
        <rect x={-w / 2} y={-15} width={w} height={30} rx={7} fill="var(--card)" stroke="var(--border)" strokeWidth={1} />
        <rect x={-w / 2 + 12} y={-4} width={8} height={8} rx={1.5} fill={node.color} />
        <text x={-w / 2 + 28} y={4.5} textAnchor="start" fontSize={11} fontWeight={500} letterSpacing="0.04em"
          fill="var(--foreground)" style={{ fontFamily: MONO }}>
          {node.label.toUpperCase()}
        </text>
      </g>
    );
  }

  if (node.kind === 'task' && !isCenter) {
    const w = Math.max(96, Math.min(210, node.label.length * 6.6 + 34));
    return (
      <g {...handlers}>
        <rect x={-w / 2} y={-16} width={w} height={32} rx={8} fill="var(--card)" stroke={node.color}
          strokeOpacity={0.9} strokeWidth={focused ? 2.25 : 1.4} />
        <circle cx={-w / 2 + 13} cy={0} r={4} fill={node.color} />
        <text x={-w / 2 + 24} y={-1} textAnchor="start" fontSize={10.5} fontWeight={500} fill="var(--foreground)">
          {node.label}
        </text>
        <text x={-w / 2 + 24} y={10} textAnchor="start" fontSize={8} letterSpacing="0.1em"
          className="fill-muted-foreground" style={{ fontFamily: MONO }}>
          {node.sublabel}
        </text>
      </g>
    );
  }

  return (
    <g {...handlers}>
      {focused && <circle r={r + 20} fill={`url(#focus-${node.status})`} />}
      {node.live && !REDUCED && (
        <circle r={r} fill="none" stroke={node.color} strokeWidth={1}>
          <animate attributeName="r" values={`${r};${r + 14};${r}`} dur="2.2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.6;0;0.6" dur="2.2s" repeatCount="indefinite" />
        </circle>
      )}
      <circle r={r} fill="var(--card)" stroke={node.color} strokeOpacity={0.9}
        strokeWidth={focused ? 2.5 : 1.75} style={{ transition: 'stroke-width .15s' }} />
      <circle r={r - 5} fill="none" stroke={node.accent} strokeOpacity={0.7} strokeWidth={1.25} />

      {isCenter ? (
        <>
          {/* Size to the disc: a task title is far longer than an agent name and
              would otherwise run out of the circle on both sides. */}
          <text y={-3} textAnchor="middle" className="fill-foreground" fontSize={centerFontSize(centerLabel(node.label, r), r)}
            fontWeight={600} letterSpacing="0.02em">
            {centerLabel(node.label, r)}
          </text>
          <text y={15} textAnchor="middle" className="fill-muted-foreground" fontSize={9.5} letterSpacing="0.14em"
            style={{ fontFamily: MONO }}>
            {node.sublabel.toUpperCase()}
          </text>
          {canPop && (
            <text y={r + 17} textAnchor="middle" fontSize={8.5} letterSpacing="0.16em"
              className="fill-muted-foreground/70" style={{ fontFamily: MONO }}>
              ESC · BACK
            </text>
          )}
        </>
      ) : (
        <>
          <text textAnchor="middle" y={r > 26 ? 5 : 4} fontSize={r > 26 ? 15 : 12} fontWeight={600}
            fill="var(--foreground)" style={{ fontFamily: MONO }}>
            {node.glyph}
          </text>
          <circle cx={r * 0.68} cy={-r * 0.68} r={6} fill="var(--card)" stroke="var(--border)" strokeWidth={1} />
          <circle cx={r * 0.68} cy={-r * 0.68} r={3.5} fill={node.color}>
            {node.live && !REDUCED && (
              <animate attributeName="opacity" values="1;0.25;1" dur="1.1s" repeatCount="indefinite" />
            )}
          </circle>
          {/* Open-work count. Absent, not zero, when there is nothing open. */}
          {node.badge > 0 && (
            <g transform={`translate(${-r * 0.72} ${-r * 0.72})`}>
              <circle r={9} fill="var(--primary)" />
              <text textAnchor="middle" y={3.2} fontSize={10} fontWeight={700} fill="var(--primary-foreground)"
                style={{ fontFamily: MONO }}>
                {node.badge > 99 ? '99+' : node.badge}
              </text>
            </g>
          )}
          <text textAnchor="middle" y={r + 17} className="fill-foreground" fontSize={12} fontWeight={500}>
            {node.label}
          </text>
        </>
      )}

      {/* Hover preview: what drilling in would reveal, stacked on the outward side. */}
      {fan && (
        <g style={{ pointerEvents: 'none' }}>
          {fan.shown.map(item => {
            const w = Math.max(58, Math.min(140, item.label.length * 6.1 + 22));
            return (
              <g key={item.id} transform={`translate(${item.x} ${item.y})`}>
                <line x1={-fan.side * 6} y1={0} x2={-item.x + fan.side * r * 0.8} y2={-item.y * 0.6}
                  stroke={item.color} strokeOpacity={0.3} strokeWidth={1} />
                <rect x={fan.side > 0 ? 0 : -w} y={-9} width={w} height={18} rx={9} fill="var(--card)"
                  stroke={item.color} strokeOpacity={0.6} strokeWidth={1} />
                <circle cx={fan.side > 0 ? 9 : -w + 9} cy={0} r={2.5} fill={item.color} />
                <text x={fan.side > 0 ? 17 : -w + 17} textAnchor="start" y={3.2} fontSize={8.5}
                  letterSpacing="0.02em" fill="var(--foreground)" style={{ fontFamily: MONO }}>
                  {item.label}
                </text>
              </g>
            );
          })}
          {fan.overflow > 0 && (
            <text x={fan.side * (r + 22)} y={fan.shown.length * 12 + 12} textAnchor={fan.side > 0 ? 'start' : 'end'}
              fontSize={8.5} letterSpacing="0.1em" className="fill-muted-foreground" style={{ fontFamily: MONO }}>
              +{fan.overflow} MORE
            </text>
          )}
        </g>
      )}
    </g>
  );
}
