import type { AgentConnection, WorkspaceAgent } from '../types';

// The public workspace wire shapes (shared/public-workspace.cjs builds them),
// and the adapter that lets the EXISTING network map draw them. The map takes
// WorkspaceAgent rows plus AgentConnection rows and derives each node's status
// itself (agentStatus in agentNetworkModel.ts); a public Agent carries only the
// status, so the adapter synthesizes the one connection set that produces it.
// tests/unit/publicWorkspaceStatus.test.ts pins the round trip.

export type PublicAgentStatus = 'busy' | 'idle' | 'disconnected' | 'inactive';
export type PublicRunMode = 'builtin' | 'daemon' | 'sandbox' | 'external';

export interface PublicAgent {
  id: string;
  name: string;
  avatar: string;
  accentColor: string;
  runMode: PublicRunMode;
  status: PublicAgentStatus;
  activity?: string;
}

export interface PublicWorkspaceSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** False when the owner has not published the agent roster: agents is [] and counts are 0. */
  roster: boolean;
  agents: PublicAgent[];
  counts: { agents: number; busy: number; idle: number; disconnected: number };
}

export interface PublicEvent {
  id: string;
  at: string;
  type: string;
  category: string;
  actor?: { kind: 'agent' | 'human'; id: string; name: string };
  entity?: { kind: string; id: string };
  title?: string;
  detail?: string;
}

export interface PublicEventsPage {
  events: PublicEvent[];
  next: string;
}

/** `/p/<uuid>` -> the uuid, or null for anything else. */
export function publicWorkspaceIdFromPath(pathname: string): string | null {
  const match = pathname.replace(/\/+$/, '').match(/^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1].toLowerCase() : null;
}

/** A WorkspaceAgent with nothing in it but what the public Agent carries. */
export function publicAgentToWorkspaceAgent(agent: PublicAgent, workspaceId: string): WorkspaceAgent {
  return {
    id: agent.id,
    workspace_id: workspaceId,
    name: agent.name,
    avatar: agent.avatar,
    accent_color: agent.accentColor || null,
    description: '',
    system_prompt: '',
    model: 'auto',
    run_mode: agent.runMode,
    enabled: agent.status !== 'inactive',
    created_by: null,
    created_at: '',
    updated_at: '',
  };
}

/**
 * The connection rows that make agentStatus() answer the agent's public status.
 * busy -> one busy connection; idle on a non-builtin -> one online connection;
 * idle on a builtin, disconnected and inactive -> none.
 */
export function publicAgentConnections(agents: PublicAgent[], workspaceId: string): AgentConnection[] {
  const out: AgentConnection[] = [];
  for (const agent of agents) {
    const status = agent.status === 'busy'
      ? 'busy'
      : agent.status === 'idle' && agent.runMode !== 'builtin'
        ? 'online'
        : null;
    if (!status) continue;
    out.push({
      id: `public-${agent.id}`,
      workspace_id: workspaceId,
      agent_id: agent.id,
      name: agent.name,
      handle: '',
      host: '',
      cwd: '',
      status,
      metadata: {},
      connected_at: '',
      last_seen_at: '',
      updated_at: '',
    });
  }
  return out;
}

/** Replace one agent in a summary (an SSE `agent` frame) and recount. */
export function applyPublicAgent(summary: PublicWorkspaceSummary, agent: PublicAgent): PublicWorkspaceSummary {
  const exists = summary.agents.some(item => item.id === agent.id);
  const agents = exists
    ? summary.agents.map(item => (item.id === agent.id ? agent : item))
    : [...summary.agents, agent];
  const counts = { agents: agents.length, busy: 0, idle: 0, disconnected: 0 };
  for (const item of agents) {
    if (item.status === 'busy') counts.busy += 1;
    else if (item.status === 'idle') counts.idle += 1;
    else if (item.status === 'disconnected') counts.disconnected += 1;
  }
  return { ...summary, agents, counts };
}

/** Newest last, de-duplicated by id, capped. */
export function mergePublicEvents(current: PublicEvent[], incoming: PublicEvent[], cap = 100): PublicEvent[] {
  const seen = new Set(current.map(event => event.id));
  const merged = [...current];
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged.slice(-cap);
}

export class PublicWorkspaceNotFound extends Error {}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit' });
  if (response.status === 404) throw new PublicWorkspaceNotFound('Not found');
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

/** `resolve` turns a backend path into a URL (apiUrl in the app). */
export function publicWorkspaceUrls(resolve: (path: string) => string, workspaceId: string) {
  const root = `/backend/public/workspaces/${encodeURIComponent(workspaceId)}`;
  return {
    summary: resolve(root),
    events: (since?: string) => resolve(`${root}/events${since ? `?since=${encodeURIComponent(since)}` : ''}`),
    stream: resolve(`${root}/stream`),
  };
}

export function fetchPublicSummary(resolve: (path: string) => string, workspaceId: string) {
  return getJson<PublicWorkspaceSummary>(publicWorkspaceUrls(resolve, workspaceId).summary);
}

export function fetchPublicEvents(resolve: (path: string) => string, workspaceId: string, since?: string) {
  return getJson<PublicEventsPage>(publicWorkspaceUrls(resolve, workspaceId).events(since));
}
