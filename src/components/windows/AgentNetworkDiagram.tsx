import { lazy, Suspense, useMemo, useState } from 'react';
import type { WorkspaceAgent, AgentConnection } from '../../types';
import { agentAccentColor } from '../../lib/agentAccent';
import { cn } from '../../lib/utils';
import { KIND_META, STATUS_META, CX, CY, initials, buildNetworkModel, type NodeStatus } from './agentNetworkModel';

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

// Quadratic Bézier from hub to a node, bowed perpendicular to the spoke so the
// graph reads as an organic mesh rather than a compass rose.
function curve(x1: number, y1: number, x2: number, y2: number, bow = 0.12) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cx = mx - dy * bow;
  const cy = my + dx * bow;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

export function AgentNetworkDiagram({ agents, connections = [], onSelectAgent }: AgentNetworkDiagramProps) {
  const enabled = useMemo(() => agents.filter(a => a.enabled !== false), [agents]);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [hover, setHover] = useState<string | null>(null);

  // Include disabled agents so "inactive" nodes still appear (ghosted).
  const model = useMemo(() => buildNetworkModel(agents, connections), [agents, connections]);

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
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card/40 p-0.5 text-xs font-medium">
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
                <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.30" />
                <stop offset="70%" stopColor="var(--primary)" stopOpacity="0.06" />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
              </radialGradient>
              {(Object.keys(STATUS_META) as NodeStatus[]).map(s => (
                <radialGradient key={s} id={`node-glow-${s}`} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={STATUS_META[s].color} stopOpacity="0.45" />
                  <stop offset="100%" stopColor={STATUS_META[s].color} stopOpacity="0" />
                </radialGradient>
              ))}
            </defs>

            {/* Level-2 spokes: agent -> its provider node (dashed, behind). */}
            {model.agentNodes.map(node => {
              const provider = model.providerNodes.get(node.provider)!;
              const dim = STATUS_META[node.status].dim * (hover && hover !== node.agent.id ? 0.3 : 1);
              return (
                <path
                  key={`p-${node.agent.id}`}
                  d={curve(node.x, node.y, provider.x, provider.y, 0.06)}
                  fill="none"
                  stroke={KIND_META[node.kind].color}
                  strokeOpacity={0.22 * dim}
                  strokeWidth={1.5}
                  strokeDasharray="4 5"
                />
              );
            })}

            {/* Level-1 spokes: hub -> each agent (curved, status-colored). */}
            {model.agentNodes.map(node => {
              const meta = STATUS_META[node.status];
              const focused = hover === node.agent.id;
              const dim = meta.dim * (hover && !focused ? 0.28 : 1);
              const d = curve(CX, CY, node.x, node.y);
              return (
                <g key={`a-${node.agent.id}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke={meta.color}
                    strokeOpacity={(focused ? 0.9 : 0.5) * dim}
                    strokeWidth={focused ? 3 : 2}
                    strokeLinecap="round"
                  />
                  {/* Traveling flow dot for busy agents. */}
                  {meta.flow && !REDUCED && (
                    <circle r={4} fill={meta.color}>
                      <animateMotion dur="1.4s" repeatCount="indefinite" path={d} />
                      <animate attributeName="opacity" values="0;1;1;0" dur="1.4s" repeatCount="indefinite" />
                    </circle>
                  )}
                </g>
              );
            })}

            {/* Provider nodes (outer ring). */}
            {[...model.providerNodes.values()].map(provider => (
              <g key={`prov-${provider.label}`} transform={`translate(${provider.x}, ${provider.y})`}>
                <rect x={-72} y={-18} width={144} height={36} rx={18}
                  fill={KIND_META[provider.kind].color} fillOpacity={0.12}
                  stroke={KIND_META[provider.kind].color} strokeOpacity={0.55} strokeWidth={1.5} />
                <text textAnchor="middle" y={5} fontSize={13} fontWeight={600} fill={KIND_META[provider.kind].color}>
                  {provider.label}
                </text>
              </g>
            ))}

            {/* Hub. */}
            <circle cx={CX} cy={CY} r={150} fill="url(#hub-glow)" />
            {!REDUCED && (
              <circle cx={CX} cy={CY} r={72} fill="none" stroke="var(--primary)" strokeOpacity={0.25}
                strokeWidth={1.5} strokeDasharray="3 7">
                <animateTransform attributeName="transform" type="rotate" from={`0 ${CX} ${CY}`}
                  to={`360 ${CX} ${CY}`} dur="24s" repeatCount="indefinite" />
              </circle>
            )}
            <circle cx={CX} cy={CY} r={58} fill="var(--card)" stroke="var(--primary)" strokeWidth={2.5} />
            <text x={CX} y={CY - 4} textAnchor="middle" className="fill-foreground" fontSize={22} fontWeight={700}>agensis</text>
            <text x={CX} y={CY + 16} textAnchor="middle" className="fill-muted-foreground" fontSize={11}>
              {enabled.length} agent{enabled.length === 1 ? '' : 's'}
            </text>
            {model.busyCount > 0 && (
              <text x={CX} y={CY + 32} textAnchor="middle" fontSize={10} fontWeight={600} fill={STATUS_META.busy.color}>
                {model.busyCount} working
              </text>
            )}

            {/* Agent nodes (inner ring). */}
            {model.agentNodes.map(node => {
              const accent = agentAccentColor(node.agent);
              const meta = STATUS_META[node.status];
              const focused = hover === node.agent.id;
              const faded = hover && !focused;
              return (
                <g
                  key={node.agent.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className={onSelectAgent ? 'cursor-pointer' : ''}
                  style={{ opacity: (faded ? 0.4 : 1) * (node.status === 'inactive' ? 0.55 : 1), transition: 'opacity .2s' }}
                  onClick={() => onSelectAgent?.(node.agent.id)}
                  onMouseEnter={() => setHover(node.agent.id)}
                  onMouseLeave={() => setHover(null)}
                >
                  <circle r={54} fill={`url(#node-glow-${node.status})`} />
                  {/* Breathing pulse ring for busy agents. */}
                  {meta.flow && !REDUCED && (
                    <circle r={34} fill="none" stroke={meta.color} strokeWidth={2}>
                      <animate attributeName="r" values="34;46;34" dur="1.8s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.7;0;0.7" dur="1.8s" repeatCount="indefinite" />
                    </circle>
                  )}
                  <circle r={focused ? 37 : 34} fill="var(--card)" stroke={accent} strokeWidth={focused ? 3 : 2.5}
                    style={{ transition: 'stroke-width .15s' }} />
                  <text textAnchor="middle" y={5} fontSize={15} fontWeight={700} fill={accent}>
                    {initials(node.agent.name)}
                  </text>
                  {/* Status pip. */}
                  <circle cx={24} cy={-24} r={7} fill="var(--card)" />
                  <circle cx={24} cy={-24} r={4.5} fill={meta.color}>
                    {meta.flow && !REDUCED && (
                      <animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />
                    )}
                  </circle>
                  <text textAnchor="middle" y={52} className="fill-foreground" fontSize={13} fontWeight={600}>
                    {node.agent.name.length > 16 ? `${node.agent.name.slice(0, 15)}…` : node.agent.name}
                  </text>
                </g>
              );
            })}
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

      {/* Legend now reflects live STATUS, matching the top status bar. */}
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-4 border-t border-border px-3 py-2 text-xs">
        {(Object.keys(STATUS_META) as NodeStatus[]).map(s => (
          <span key={s} className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: STATUS_META[s].color }} />
            {STATUS_META[s].label}
          </span>
        ))}
      </div>
    </div>
  );
}
