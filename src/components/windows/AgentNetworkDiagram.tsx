import { lazy, Suspense, useMemo, useState } from 'react';
import type { WorkspaceAgent } from '../../types';
import { agentAccentColor } from '../../lib/agentAccent';
import { cn } from '../../lib/utils';
import { KIND_META, CX, CY, initials, buildNetworkModel, type ConnKind } from './agentNetworkModel';

// three.js scene is heavy — load it only when the user opens the 3D tab so it
// never lands in the agents-window chunk.
const AgentNetworkDiagram3D = lazy(() => import('./AgentNetworkDiagram3D'));

interface AgentNetworkDiagramProps {
  agents: WorkspaceAgent[];
  onSelectAgent?: (id: string) => void;
}

export function AgentNetworkDiagram({ agents, onSelectAgent }: AgentNetworkDiagramProps) {
  const enabled = useMemo(() => agents.filter(a => a.enabled !== false), [agents]);
  const [view, setView] = useState<'2d' | '3d'>('2d');

  const model = useMemo(() => buildNetworkModel(enabled), [enabled]);

  if (enabled.length === 0) {
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
              <radialGradient id="agensis-hub-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Level-2 spokes: agent -> its provider node. */}
            {model.agentNodes.map(node => {
              const provider = model.providerNodes.get(node.provider)!;
              return (
                <line
                  key={`p-${node.agent.id}`}
                  x1={node.x} y1={node.y} x2={provider.x} y2={provider.y}
                  stroke={KIND_META[node.kind].color} strokeOpacity={0.25} strokeWidth={1.5} strokeDasharray="4 4"
                />
              );
            })}

            {/* Level-1 spokes: hub -> each agent. */}
            {model.agentNodes.map(node => (
              <line
                key={`a-${node.agent.id}`}
                x1={CX} y1={CY} x2={node.x} y2={node.y}
                stroke={KIND_META[node.kind].color} strokeOpacity={0.45} strokeWidth={2}
              />
            ))}

            {/* Provider nodes (outer ring). */}
            {[...model.providerNodes.values()].map(provider => (
              <g key={`prov-${provider.label}`} transform={`translate(${provider.x}, ${provider.y})`}>
                <rect x={-70} y={-18} width={140} height={36} rx={18}
                  fill={KIND_META[provider.kind].color} fillOpacity={0.14}
                  stroke={KIND_META[provider.kind].color} strokeOpacity={0.6} strokeWidth={1.5} />
                <text textAnchor="middle" y={5} fontSize={13} fontWeight={600} fill={KIND_META[provider.kind].color}>
                  {provider.label}
                </text>
              </g>
            ))}

            {/* Hub. */}
            <circle cx={CX} cy={CY} r={130} fill="url(#agensis-hub-glow)" />
            <circle cx={CX} cy={CY} r={58} fill="var(--card)" stroke="var(--primary)" strokeWidth={2.5} />
            <text x={CX} y={CY - 2} textAnchor="middle" className="fill-foreground" fontSize={22} fontWeight={700}>agensis</text>
            <text x={CX} y={CY + 20} textAnchor="middle" className="fill-muted-foreground" fontSize={12}>{enabled.length} agent{enabled.length === 1 ? '' : 's'}</text>

            {/* Agent nodes (inner ring). */}
            {model.agentNodes.map(node => {
              const accent = agentAccentColor(node.agent);
              return (
                <g
                  key={node.agent.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className={onSelectAgent ? 'cursor-pointer' : ''}
                  onClick={() => onSelectAgent?.(node.agent.id)}
                >
                  <circle r={34} fill="var(--card)" stroke={accent} strokeWidth={2.5} />
                  <text textAnchor="middle" y={5} fontSize={15} fontWeight={700} fill={accent}>
                    {initials(node.agent.name)}
                  </text>
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

      <div className="flex shrink-0 flex-wrap items-center justify-center gap-4 border-t border-border px-3 py-2 text-xs">
        {(Object.keys(KIND_META) as ConnKind[]).map(kind => (
          <span key={kind} className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: KIND_META[kind].color }} />
            {KIND_META[kind].label}
          </span>
        ))}
      </div>
    </div>
  );
}
