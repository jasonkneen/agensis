import { describe, expect, it } from 'vitest';
import { splitNostrChannelGroups } from '../../src/lib/nostrChannelGroups';
import type { ChatSession } from '../../src/types';
import type { NostrConnection } from '../../src/lib/nostrCommunities';

function session(id: string, title: string): ChatSession {
  return {
    id,
    workspace_id: 'workspace-1',
    title,
    model: 'default',
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z',
  };
}

function connection(overrides: Partial<NostrConnection> = {}): NostrConnection {
  return {
    id: 'connection-1',
    workspaceId: 'workspace-1',
    relayHttpUrl: 'https://community.test',
    relayWsUrl: 'wss://community.test',
    communityId: 'community-1',
    host: 'community.test',
    name: 'Hermes Agents',
    description: '',
    relayPubkey: 'a'.repeat(64),
    memberPubkey: 'b'.repeat(64),
    policyVersion: '',
    status: 'connected',
    lastError: '',
    subscriptions: [],
    ...overrides,
  };
}

describe('Nostr channel sidebar groups', () => {
  it('removes imported sessions from ordinary channels and groups them by community', () => {
    const local = session('local', 'Product');
    const imported = session('remote', 'agents');
    const result = splitNostrChannelGroups([local, imported], [connection({
      subscriptions: [{
        bridgeId: 'bridge-1', channelId: 'remote-agents', sessionId: imported.id,
        enabled: true, status: 'connected', lastError: '',
      }],
    })]);

    expect(result.localSessions.map(item => item.id)).toEqual(['local']);
    expect(result.communities).toHaveLength(1);
    expect(result.communities[0].connection.name).toBe('Hermes Agents');
    expect(result.communities[0].channels[0]).toMatchObject({ session: imported, enabled: true });
  });

  it('keeps paused subscriptions visible and keeps an empty connected community manageable', () => {
    const paused = session('paused', 'support');
    const result = splitNostrChannelGroups([paused], [
      connection({
        subscriptions: [{
          bridgeId: 'bridge-2', channelId: 'remote-support', sessionId: paused.id,
          enabled: false, status: 'disconnected', lastError: '',
        }],
      }),
      connection({ id: 'connection-2', name: 'Empty community', subscriptions: [] }),
    ]);

    expect(result.localSessions).toEqual([]);
    expect(result.communities[0].channels[0].enabled).toBe(false);
    expect(result.communities[1]).toMatchObject({ channels: [] });
  });
});
