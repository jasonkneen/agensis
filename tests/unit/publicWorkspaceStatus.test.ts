import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { agentStatus } from '../../src/components/windows/agentNetworkModel';
import {
  applyPublicAgent,
  mergePublicEvents,
  publicAgentConnections,
  publicAgentToWorkspaceAgent,
  publicWorkspaceIdFromPath,
  type PublicAgent,
  type PublicRunMode,
} from '../../src/lib/publicWorkspace';
import type { AgentConnection, WorkspaceAgent } from '../../src/types';

// The server computes a public agent's status with publicAgentStatus
// (shared/public-workspace.cjs); the public page draws it with the network map,
// which computes status itself from agent + connection rows (agentStatus). The
// two must agree for every run mode and connection set, and the page's adapter
// must make the map reproduce exactly the status the server sent.

const require = createRequire(import.meta.url);
const server = require('../../shared/public-workspace.cjs');

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const RUN_MODES: PublicRunMode[] = ['builtin', 'daemon', 'sandbox', 'external'];
const CONNECTION_SETS: Array<Array<{ agent_id: string; status: AgentConnection['status'] }>> = [
  [],
  [{ agent_id: AGENT, status: 'offline' }],
  [{ agent_id: AGENT, status: 'online' }],
  [{ agent_id: AGENT, status: 'busy' }],
  [{ agent_id: AGENT, status: 'online' }, { agent_id: AGENT, status: 'busy' }],
  [{ agent_id: AGENT, status: 'offline' }, { agent_id: AGENT, status: 'online' }],
  [{ agent_id: OTHER, status: 'busy' }],
];

function connection(row: { agent_id: string; status: AgentConnection['status'] }, index: number): AgentConnection {
  return {
    id: `c${index}`, workspace_id: WS, agent_id: row.agent_id, name: '', handle: '', host: '', cwd: '',
    status: row.status, metadata: {}, connected_at: '', last_seen_at: '', updated_at: '',
  };
}

function agentRow(runMode: PublicRunMode, enabled: boolean): WorkspaceAgent {
  return {
    id: AGENT, workspace_id: WS, name: 'Scout', avatar: 'SC', description: '', system_prompt: '', model: 'auto',
    run_mode: runMode, enabled, created_by: null, created_at: '', updated_at: '',
  };
}

describe('public agent status', () => {
  it('the server rule matches the network map for every run mode and connection set', () => {
    for (const runMode of RUN_MODES) {
      for (const enabled of [true, false]) {
        for (const set of CONNECTION_SETS) {
          const connections = set.map(connection);
          const row = agentRow(runMode, enabled);
          expect(server.publicAgentStatus(row, connections), JSON.stringify({ runMode, enabled, set }))
            .toBe(agentStatus(row, connections));
        }
      }
    }
  });

  it('the page adapter makes the map reproduce every status the server can send', () => {
    for (const runMode of RUN_MODES) {
      for (const enabled of [true, false]) {
        for (const set of CONNECTION_SETS) {
          const status = server.publicAgentStatus(agentRow(runMode, enabled), set.map(connection));
          const publicAgent: PublicAgent = { id: AGENT, name: 'Scout', avatar: 'SC', accentColor: '', runMode, status };
          const drawn = agentStatus(
            publicAgentToWorkspaceAgent(publicAgent, WS),
            publicAgentConnections([publicAgent], WS),
          );
          expect(drawn, JSON.stringify({ runMode, status })).toBe(status);
        }
      }
    }
  });

  it('the adapter carries no prose into the map', () => {
    const agent = publicAgentToWorkspaceAgent(
      { id: AGENT, name: 'Scout', avatar: 'SC', accentColor: '#ff7a59', runMode: 'daemon', status: 'busy' },
      WS,
    );
    expect(agent.system_prompt).toBe('');
    expect(agent.soul).toBeUndefined();
    expect(agent.instructions).toBeUndefined();
    expect(agent.metadata).toBeUndefined();
  });
});

describe('public page helpers', () => {
  it('only /p/<uuid> opens the public page', () => {
    expect(publicWorkspaceIdFromPath(`/p/${WS}`)).toBe(WS);
    expect(publicWorkspaceIdFromPath(`/p/${WS}/`)).toBe(WS);
    expect(publicWorkspaceIdFromPath('/p/not-a-uuid')).toBeNull();
    expect(publicWorkspaceIdFromPath(`/p/${WS}/sessions`)).toBeNull();
    expect(publicWorkspaceIdFromPath('/app')).toBeNull();
  });

  it('an agent frame replaces the agent and recounts', () => {
    const summary = {
      id: WS, name: 'Hall', description: '', icon: '',
      agents: [{ id: AGENT, name: 'Scout', avatar: 'SC', accentColor: '', runMode: 'daemon' as const, status: 'idle' as const }],
      counts: { agents: 1, busy: 0, idle: 1, disconnected: 0 },
    };
    const next = applyPublicAgent(summary, { ...summary.agents[0], status: 'busy', activity: 'edit' });
    expect(next.counts).toEqual({ agents: 1, busy: 1, idle: 0, disconnected: 0 });
    expect(next.agents[0].activity).toBe('edit');
  });

  it('events merge without duplicates and keep the newest', () => {
    const a = { id: 'a', at: '1', type: 't', category: 'c' };
    const b = { id: 'b', at: '2', type: 't', category: 'c' };
    expect(mergePublicEvents([a], [a, b]).map(e => e.id)).toEqual(['a', 'b']);
    expect(mergePublicEvents([a], [b], 1).map(e => e.id)).toEqual(['b']);
  });
});
