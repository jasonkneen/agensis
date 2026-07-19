import type { WorkspaceAgent, AgentConnection } from '../../types';

export type ConnKind = 'builtin' | 'remote' | 'sandbox';

export const KIND_META: Record<ConnKind, { label: string; color: string }> = {
  builtin: { label: 'Built-in', color: '#00a95c' },
  remote: { label: 'Remote', color: '#38bdf8' },
  sandbox: { label: 'Sandbox', color: '#a78bfa' },
};

export type NodeStatus = 'busy' | 'idle' | 'disconnected' | 'inactive';

// Visual treatment per live status. `flow` drives whether a spoke animates.
export const STATUS_META: Record<NodeStatus, { label: string; color: string; flow: boolean; dim: number }> = {
  busy: { label: 'Busy', color: '#f59e0b', flow: true, dim: 1 },
  idle: { label: 'Idle', color: '#10b981', flow: false, dim: 1 },
  disconnected: { label: 'Disconnected', color: '#71717a', flow: false, dim: 0.5 },
  inactive: { label: 'Inactive', color: '#f43f5e', flow: false, dim: 0.32 },
};

export const CX = 500;
export const CY = 420;
export const AGENT_RING = 210;
export const PROVIDER_RING = 380;

export interface AgentNode {
  agent: WorkspaceAgent;
  kind: ConnKind;
  status: NodeStatus;
  provider: string;
  x: number;
  y: number;
  angle: number;
}

export interface ProviderNode {
  label: string;
  kind: ConnKind;
  x: number;
  y: number;
}

export interface NetworkModel {
  agentNodes: AgentNode[];
  providerNodes: Map<string, ProviderNode>;
  busyCount: number;
}

export function agentKind(agent: WorkspaceAgent): ConnKind {
  if (agent.run_mode === 'sandbox') return 'sandbox';
  if (agent.run_mode === 'daemon') return 'remote';
  return 'builtin';
}

// Mirror of AgentsWindowContent.agentPresenceStatus so the diagram matches the
// top status bar exactly. `inactive` = disabled; else keyed on live connections.
// Built-in agents have no daemon socket but are always reachable via the platform
// runner, so they read as idle (available), never disconnected.
export function agentStatus(agent: WorkspaceAgent, connections: AgentConnection[]): NodeStatus {
  if (agent.enabled === false) return 'inactive';
  const mine = connections.filter(c => c.agent_id === agent.id && c.status !== 'offline');
  if (mine.length === 0) return agentKind(agent) === 'builtin' ? 'idle' : 'disconnected';
  return mine.some(c => c.status === 'busy') ? 'busy' : 'idle';
}

// The concrete provider node label an agent spokes out to (level 2).
export function providerLabel(agent: WorkspaceAgent): string {
  const kind = agentKind(agent);
  if (kind === 'sandbox') return (agent.sandbox_provider || 'e2b').toUpperCase();
  if (kind === 'remote') return 'Remote daemon';
  return 'Built-in Claude';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Three-tier radial layout: Agensis hub (center) -> each agent (inner ring) ->
// the provider node behind that agent's connection (outer ring). Agents that
// share a provider all spoke to the same outer node. `connections` drives each
// node's live status so the graph reflects busy/idle/disconnected/inactive.
export function buildNetworkModel(enabled: WorkspaceAgent[], connections: AgentConnection[] = []): NetworkModel {
  const n = Math.max(enabled.length, 1);
  const agentNodes: AgentNode[] = enabled.map((agent, i) => {
    const angle = (-Math.PI / 2) + (i / n) * Math.PI * 2;
    return {
      agent,
      kind: agentKind(agent),
      status: agentStatus(agent, connections),
      provider: providerLabel(agent),
      x: CX + Math.cos(angle) * AGENT_RING,
      y: CY + Math.sin(angle) * AGENT_RING,
      angle,
    };
  });

  const byProvider = new Map<string, { kind: ConnKind; angles: number[] }>();
  for (const node of agentNodes) {
    const entry = byProvider.get(node.provider) || { kind: node.kind, angles: [] };
    entry.angles.push(node.angle);
    byProvider.set(node.provider, entry);
  }

  const providerNodes = new Map<string, ProviderNode>();
  for (const [label, { kind, angles }] of byProvider) {
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

  return { agentNodes, providerNodes, busyCount: agentNodes.filter(node => node.status === 'busy').length };
}
