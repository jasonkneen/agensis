import { useMemo } from 'react';
import type { WorkspaceAgent } from '../../types';
import { agentAccentColor } from '../../lib/agentAccent';

type ConnKind = 'builtin' | 'remote' | 'sandbox';

interface AgentNetworkDiagramProps {
  agents: WorkspaceAgent[];
  onSelectAgent?: (id: string) => void;
}

const KIND_META: Record<ConnKind, { label: string; color: string }> = {
  builtin: { label: 'Built-in', color: '#00a95c' },
  remote: { label: 'Remote', color: '#38bdf8' },
  sandbox: { label: 'Sandbox', color: '#a78bfa' },
};

function agentKind(agent: WorkspaceAgent): ConnKind {
  if (agent.run_mode === 'sandbox') return 'sandbox';
  if (agent.run_mode === 'daemon') return 'remote';
  return 'builtin';
}

// The concrete provider node label an agent spokes out to (level 2).
function providerLabel(agent: WorkspaceAgent): string {
  const kind = agentKind(agent);
  if (kind === 'sandbox') return (agent.sandbox_provider || 'e2b').toUpperCase();
  if (kind === 'remote') return 'Remote daemon';
  return 'Built-in Claude';
}

const CX = 500;
const CY = 420;
const AGENT_RING = 210;
const PROVIDER_RING = 380;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Three-tier radial graph: Agensis hub (center) -> each agent (inner ring) ->
// the provider node behind that agent's connection (outer ring). Agents that
// share a provider all spoke to the same outer node, so the graph reads as
// "agensis fans out to its agents, which each connect through Built-in Claude /
// Remote daemon / E2B".
export function AgentNetworkDiagram({ agents, onSelectAgent }: AgentNetworkDiagramProps) {
  const enabled = useMemo(() => agents.filter(a => a.enabled !== false), [agents]);

  const model = useMemo(() => {
    const n = Math.max(enabled.length, 1);
    const agentNodes = enabled.map((agent, i) => {
      const angle = (-Math.PI / 2) + (i / n) * Math.PI * 2;
      return {
        agent,
        kind: agentKind(agent),
        provider: providerLabel(agent),
        x: CX + Math.cos(angle) * AGENT_RING,
        y: CY + Math.sin(angle) * AGENT_RING,
        angle,
      };
    });

    // One provider node per distinct provider label, placed on the outer ring at
    // the mean angle of the agents that use it (so its spokes stay short/clean).
    const byProvider = new Map<string, { kind: ConnKind; angles: number[] }>();
    for (const node of agentNodes) {
      const entry = byProvider.get(node.provider) || { kind: node.kind, angles: [] };
      entry.angles.push(node.angle);
      byProvider.set(node.provider, entry);
    }
    const providerNodes = new Map<string, { label: string; kind: ConnKind; x: number; y: number }>();
    for (const [label, { kind, angles }] of byProvider) {
      // Circular mean of the angles.
      const sx = angles.reduce((s, a) => s + Math.cos(a), 0);
      const sy = angles.reduce((s, a) => s + Math.sin(a), 0);
      const mean = Math.atan2(sy, sx);
      providerNodes.set(label, {
        label,
        kind,
        x: CX + Math.cos(mean) * PROVIDER_RING,
        y: CY + Math.sin(mean) * PROVIDER_RING,
      });
    }
    return { agentNodes, providerNodes };
  }, [enabled]);

  if (enabled.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No agents to visualize yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <svg viewBox="0 0 1000 840" className="size-full" role="img" aria-label="Agent network diagram">
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
