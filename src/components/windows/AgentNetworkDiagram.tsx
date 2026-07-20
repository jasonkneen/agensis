import { lazy, Suspense, useMemo, useState } from 'react';
import type { WorkspaceAgent, AgentConnection } from '../../types';
import { agentAccentColor } from '../../lib/agentAccent';
import { cn } from '../../lib/utils';
import { KIND_META, STATUS_META, CX, CY, initials, buildNetworkModel, type ConnKind, type NodeStatus } from './agentNetworkModel';

// three.js scene is heavy — load it only when the user opens the 3D tab so it
// never lands in the agents-window chunk.
const AgentNetworkDiagram3D = lazy(() => import('./AgentNetworkDiagram3D'));

interface AgentNetworkDiagramProps {
  agents: WorkspaceAgent[];
  connections?: AgentConnection[];
  onSelectAgent?: (id: string) => void;
}

const REDUCED =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Instrument-label typeface: matches the app's mono usage, falls back cleanly.
const MONO = "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

// Quadratic Bézier from hub to a node, bowed perpendicular to the spoke so the
// graph reads as a routed network rather than a compass rose.
function curve(x1: number, y1: number, x2: number, y2: number, bow = 0.1) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cx = mx - dy * bow;
  const cy = my + dx * bow;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function AgentNetworkDiagram({ agents, connections = [], onSelectAgent }: AgentNetworkDiagramProps) {
  const enabled = useMemo(() => agents.filter(a => a.enabled !== false), [agents]);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [hover, setHover] = useState<string | null>(null);

  // Include disabled agents so "inactive" nodes still appear (ghosted).
  const model = useMemo(() => buildNetworkModel(agents, connections), [agents, connections]);
  const { agentRing, providerRing, nodeR } = model.layout;
  const hovered = hover ? model.agentNodes.find(n => n.agent.id === hover) : null;

  if (agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No agents to visualize yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 2D / 3D view toggle — keep both. */}
      <div className="flex shrink-0 items-center justify-center gap-0.5 border-b border-border bg-card/40 p-1.5">
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card/40 p-0.5 text-[11px] font-medium tracking-wide"
          style={{ fontFamily: MONO }}>
          {(['2d', '3d'] as const).map(v => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn(
                'rounded-md px-3 py-1 transition',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === '2d' ? (
          <svg viewBox="0 0 1000 840" className="size-full" role="img" aria-label="Agent network diagram (2D)">
            <defs>
              <radialGradient id="hub-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
                <stop offset="65%" stopColor="var(--primary)" stopOpacity="0.05" />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
              </radialGradient>
              {/* Focus halo shown only on hover/selection — not an always-on glow. */}
              {(Object.keys(STATUS_META) as NodeStatus[]).map(s => (
                <radialGradient key={s} id={`focus-${s}`} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={STATUS_META[s].color} stopOpacity="0.4" />
                  <stop offset="100%" stopColor={STATUS_META[s].color} stopOpacity="0" />
                </radialGradient>
              ))}
            </defs>

            {/* Range rings — hairline orbits that make the two tiers legible. */}
            <circle cx={CX} cy={CY} r={agentRing} fill="none" stroke="var(--border)" strokeOpacity={0.6} strokeWidth={1} />
            <circle cx={CX} cy={CY} r={providerRing} fill="none" stroke="var(--border)" strokeOpacity={0.35} strokeWidth={1} strokeDasharray="2 7" />

            {/* Level-2 spokes: agent -> its provider node (hairline, behind). */}
            {model.agentNodes.map(node => {
              const provider = model.providerNodes.get(node.provider)!;
              const dim = STATUS_META[node.status].dim * (hover && hover !== node.agent.id ? 0.25 : 1);
              return (
                <path
                  key={`p-${node.agent.id}`}
                  d={curve(node.x, node.y, provider.x, provider.y, 0.05)}
                  fill="none"
                  stroke="var(--muted-foreground)"
                  strokeOpacity={0.28 * dim}
                  strokeWidth={1}
                  strokeDasharray="1 6"
                  strokeLinecap="round"
                />
              );
            })}

            {/* Level-1 spokes: hub -> each agent (curved, status-colored). */}
            {model.agentNodes.map(node => {
              const meta = STATUS_META[node.status];
              const focused = hover === node.agent.id;
              const dim = meta.dim * (hover && !focused ? 0.22 : 1);
              const d = curve(CX, CY, node.x, node.y);
              return (
                <g key={`a-${node.agent.id}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke={meta.color}
                    strokeOpacity={(focused ? 0.85 : 0.42) * dim}
                    strokeWidth={focused ? 2.5 : 1.5}
                    strokeLinecap="round"
                  />
                  {/* Traveling flow dot for busy agents — motion only where it means something. */}
                  {meta.flow && !REDUCED && (
                    <circle r={3} fill={meta.color}>
                      <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
                      <animate attributeName="opacity" values="0;1;1;0" dur="1.6s" repeatCount="indefinite" />
                    </circle>
                  )}
                </g>
              );
            })}

            {/* Provider nodes (outer ring) — instrument endpoints, not candy pills. */}
            {[...model.providerNodes.values()].map(provider => {
              const w = clamp(provider.label.length * 8.2 + 40, 104, 190);
              return (
                <g key={`prov-${provider.label}`} transform={`translate(${provider.x}, ${provider.y})`}>
                  <rect x={-w / 2} y={-15} width={w} height={30} rx={7}
                    fill="var(--card)" stroke="var(--border)" strokeWidth={1} />
                  {/* Kind marker — the square explains the connection color in the legend. */}
                  <rect x={-w / 2 + 12} y={-4} width={8} height={8} rx={1.5} fill={KIND_META[provider.kind].color} />
                  <text x={-w / 2 + 28} y={4.5} textAnchor="start" fontSize={11} fontWeight={500}
                    letterSpacing="0.04em" fill="var(--foreground)" style={{ fontFamily: MONO }}>
                    {provider.label.toUpperCase()}
                  </text>
                </g>
              );
            })}

            {/* Hub. */}
            <circle cx={CX} cy={CY} r={150} fill="url(#hub-glow)" />
            <circle cx={CX} cy={CY} r={58} fill="var(--card)" stroke="var(--border)" strokeWidth={1} />
            <circle cx={CX} cy={CY} r={58} fill="none" stroke="var(--primary)" strokeOpacity={0.5} strokeWidth={1.5} />
            <text x={CX} y={CY - 3} textAnchor="middle" className="fill-foreground" fontSize={19} fontWeight={600}
              letterSpacing="0.02em">agensis</text>
            <text x={CX} y={CY + 15} textAnchor="middle" className="fill-muted-foreground" fontSize={10}
              letterSpacing="0.14em" style={{ fontFamily: MONO }}>
              {enabled.length} AGENT{enabled.length === 1 ? '' : 'S'}
            </text>
            {model.busyCount > 0 && (
              <text x={CX} y={CY + 31} textAnchor="middle" fontSize={9.5} fontWeight={600} letterSpacing="0.12em"
                fill={STATUS_META.busy.color} style={{ fontFamily: MONO }}>
                {model.busyCount} WORKING
              </text>
            )}

            {/* Agent nodes (inner ring). */}
            {model.agentNodes.map(node => {
              const accent = agentAccentColor(node.agent);
              const meta = STATUS_META[node.status];
              const focused = hover === node.agent.id;
              const faded = hover && !focused;
              const label = node.agent.name.length > 16 ? `${node.agent.name.slice(0, 15)}…` : node.agent.name;
              return (
                <g
                  key={node.agent.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className={onSelectAgent ? 'cursor-pointer' : ''}
                  style={{ opacity: (faded ? 0.35 : 1) * (node.status === 'inactive' ? 0.5 : 1), transition: 'opacity .2s' }}
                  onClick={() => onSelectAgent?.(node.agent.id)}
                  onMouseEnter={() => setHover(node.agent.id)}
                  onMouseLeave={() => setHover(null)}
                >
                  {/* Focus halo only when hovered/selected. */}
                  {focused && <circle r={nodeR + 20} fill={`url(#focus-${node.status})`} />}
                  {/* Busy ping — a single expanding hairline, not a fat pulse. */}
                  {meta.flow && !REDUCED && (
                    <circle r={nodeR} fill="none" stroke={meta.color} strokeWidth={1}>
                      <animate attributeName="r" values={`${nodeR};${nodeR + 14};${nodeR}`} dur="2.2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.6;0;0.6" dur="2.2s" repeatCount="indefinite" />
                    </circle>
                  )}
                  {/* Disc + status ring (thin outer) + accent identity ring (inner hairline). */}
                  <circle r={nodeR} fill="var(--card)" stroke={meta.color} strokeOpacity={0.9}
                    strokeWidth={focused ? 2.5 : 1.75} style={{ transition: 'stroke-width .15s' }} />
                  <circle r={nodeR - 5} fill="none" stroke={accent} strokeOpacity={0.7} strokeWidth={1.25} />
                  <text textAnchor="middle" y={nodeR > 26 ? 5 : 4} fontSize={nodeR > 26 ? 15 : 12} fontWeight={600}
                    fill="var(--foreground)" style={{ fontFamily: MONO }}>
                    {initials(node.agent.name)}
                  </text>
                  {/* Status pip. */}
                  <circle cx={nodeR * 0.68} cy={-nodeR * 0.68} r={6} fill="var(--card)" stroke="var(--border)" strokeWidth={1} />
                  <circle cx={nodeR * 0.68} cy={-nodeR * 0.68} r={3.5} fill={meta.color}>
                    {meta.flow && !REDUCED && (
                      <animate attributeName="opacity" values="1;0.25;1" dur="1.1s" repeatCount="indefinite" />
                    )}
                  </circle>
                  <text textAnchor="middle" y={nodeR + 17} className="fill-foreground" fontSize={12} fontWeight={500}>
                    {label}
                  </text>
                </g>
              );
            })}

            {/* Hover readout — real detail, positioned toward the hub to avoid clipping. */}
            {hovered && (() => {
              const cardW = 196, cardH = 78;
              const tx = clamp(hovered.x + (hovered.x <= CX ? 46 : -46 - cardW), 8, 1000 - cardW - 8);
              const ty = clamp(hovered.y - cardH / 2, 8, 840 - cardH - 8);
              const meta = STATUS_META[hovered.status];
              const handle = hovered.agent.handle ? `@${String(hovered.agent.handle).replace(/^@+/, '')}` : hovered.provider;
              return (
                <foreignObject x={tx} y={ty} width={cardW} height={cardH} style={{ pointerEvents: 'none' }}>
                  <div className="rounded-lg border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur-sm"
                    style={{ fontFamily: MONO }}>
                    <div className="truncate text-[12px] font-semibold text-foreground" style={{ fontFamily: 'inherit' }}>
                      {hovered.agent.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
                      <span style={{ color: meta.color }}>{meta.label.toUpperCase()}</span>
                      <span className="opacity-40">·</span>
                      <span className="truncate">{handle}</span>
                    </div>
                    <div className="mt-1 truncate text-[10px] text-muted-foreground/80">
                      {hovered.provider} · {hovered.agent.model || 'default'}
                    </div>
                  </div>
                </foreignObject>
              );
            })()}
          </svg>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading 3D view…
              </div>
            }
          >
            <AgentNetworkDiagram3D model={model} enabledCount={enabled.length} onSelectAgent={onSelectAgent} />
          </Suspense>
        )}
      </div>

      {/* Legend: live STATUS (inner nodes) + CONNECTION kind (outer endpoints). */}
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-border px-3 py-2 text-[10px]"
        style={{ fontFamily: MONO }}>
        <span className="mr-0.5 tracking-widest text-muted-foreground/60">STATUS</span>
        {(Object.keys(STATUS_META) as NodeStatus[]).map(s => (
          <span key={s} className="inline-flex items-center gap-1.5 tracking-wide text-muted-foreground">
            <span className="size-2 rounded-full" style={{ backgroundColor: STATUS_META[s].color }} />
            {STATUS_META[s].label.toUpperCase()}
          </span>
        ))}
        <span className="mx-1 h-3 w-px bg-border" />
        <span className="mr-0.5 tracking-widest text-muted-foreground/60">LINK</span>
        {(Object.keys(KIND_META) as ConnKind[]).map(k => (
          <span key={k} className="inline-flex items-center gap-1.5 tracking-wide text-muted-foreground">
            <span className="size-2 rounded-[2px]" style={{ backgroundColor: KIND_META[k].color }} />
            {KIND_META[k].label.toUpperCase()}
          </span>
        ))}
      </div>
    </div>
  );
}
