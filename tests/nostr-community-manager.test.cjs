'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const nostr = require('nostr-tools');

const { createNostrCommunityManager, publicMember } = require('../server/nostr-community-manager.cjs');

test('member projection preserves refreshed camelCase agent data', () => {
  assert.deepEqual(publicMember({
    pubkey: 'a'.repeat(64), channelId: 'channel-a', name: 'Ada', handle: 'ada', picture: '', isAgent: true, aliases: ['Ada'],
  }), {
    pubkey: 'a'.repeat(64), channelId: 'channel-a', name: 'Ada', handle: 'ada', picture: '', isAgent: true, aliases: ['Ada'],
  });
});

test('manager preview never returns the opaque invite credential', async () => {
  const manager = createNostrCommunityManager({
    getDb: () => ({ unsafe: async () => [] }),
    getWorkspaceSecretValue: async () => '',
    setWorkspaceSecretValue: async () => {},
    bridges: {},
    protocol: { previewInvite: async () => ({ inviteUrl: 'https://community.test/invite/secret', code: 'secret', host: 'community.test' }) },
  });
  assert.deepEqual(await manager.previewInvite('https://community.test/invite/secret'), { host: 'community.test' });
});

test('connection listings include local channel subscriptions for sidebar grouping', async () => {
  const db = {
    async unsafe(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('select * from nostr_community_connections')) {
        return [{
          id: 'connection-1', workspace_id: 'workspace-1', relay_http_url: 'https://community.test',
          relay_ws_url: 'wss://community.test', name: 'Hermes Agents', status: 'connected',
        }];
      }
      if (normalized.includes('from channel_bridges b') && normalized.includes('join nostr_community_connections')) {
        return [{
          id: 'bridge-1', nostr_connection_id: 'connection-1', external_id: 'channel-a',
          session_id: 'session-1', enabled: false, status: 'disconnected', last_error: null,
        }];
      }
      return [];
    },
  };
  const manager = createNostrCommunityManager({
    getDb: () => db,
    getWorkspaceSecretValue: async () => '',
    setWorkspaceSecretValue: async () => {},
    bridges: {},
    protocol: {},
  });

  const connections = await manager.listConnections('workspace-1');
  assert.deepEqual(connections[0].subscriptions, [{
    bridgeId: 'bridge-1', channelId: 'channel-a', sessionId: 'session-1',
    enabled: false, status: 'disconnected', lastError: '',
  }]);
});

test('removing an imported channel deletes only its Nostr bridge and restarts the remaining relay work', async () => {
  const connection = {
    id: 'connection-remove', workspace_id: 'workspace-1', relay_http_url: 'https://community.test',
    relay_ws_url: 'wss://community.test', status: 'connected',
  };
  const bridge = {
    id: 'bridge-remove', nostr_connection_id: connection.id, external_id: 'channel-remove',
    session_id: 'session-remove', provider: 'nostr', enabled: true,
  };
  const notices = [];
  const db = {
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('select * from nostr_community_connections where id')) return [connection];
      if (normalized.startsWith('delete from channel_bridges')) return [{ ...bridge }];
      if (normalized.startsWith('delete from nostr_community_members')) return [];
      if (normalized.startsWith('select * from channel_bridges')) return [];
      return [];
    },
  };
  const manager = createNostrCommunityManager({
    getDb: () => db,
    getWorkspaceSecretValue: async () => '',
    setWorkspaceSecretValue: async () => {},
    bridges: {},
    protocol: {},
    notifyDbSubscribers: (...args) => notices.push(args),
  });

  assert.deepEqual(await manager.removeChannelSubscription(connection.id, 'channel-remove'), {
    removed: true, channelId: 'channel-remove', sessionId: 'session-remove',
  });
  assert.deepEqual(notices, [['channel_bridges', 'DELETE', [{ ...bridge }]]]);
});

test('deleting a Nostr connection removes its secret and bridge mappings but keeps local sessions', async () => {
  const connection = {
    id: 'connection-delete', workspace_id: 'workspace-1', relay_http_url: 'https://community.test',
    relay_ws_url: 'wss://community.test', name: 'Delete me', status: 'connected',
  };
  const bridge = {
    id: 'bridge-delete', nostr_connection_id: connection.id, external_id: 'channel-delete',
    session_id: 'session-delete', provider: 'nostr', enabled: true,
  };
  const notices = [];
  const secretWrites = [];
  const db = {
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('select * from nostr_community_connections where id')) return [connection];
      if (normalized.startsWith('select * from channel_bridges')) return [bridge];
      if (normalized.startsWith('delete from nostr_community_connections')) return [connection];
      if (normalized.startsWith('delete from workspace_secrets')) return [];
      return [];
    },
  };
  const manager = createNostrCommunityManager({
    getDb: () => db,
    getWorkspaceSecretValue: async () => 'a'.repeat(64),
    setWorkspaceSecretValue: async (...args) => secretWrites.push(args),
    bridges: {},
    protocol: {},
    notifyDbSubscribers: (...args) => notices.push(args),
  });

  const deleted = await manager.deleteCommunity(connection.id, 'user-1');
  assert.equal(deleted.name, 'Delete me');
  assert.deepEqual(secretWrites, [[
    'workspace-1', 'bridge:nostr:connection-delete:nsec', '', 'user-1', 'Deleted Nostr community identity',
  ]]);
  assert.deepEqual(notices, [['channel_bridges', 'DELETE', [bridge]]]);
});

test('offline discovery keeps existing imports visible and pausable without a relay secret', async () => {
  const connection = {
    id: 'offline-connection', workspace_id: 'workspace-1', relay_http_url: 'https://community.test',
    relay_ws_url: 'wss://community.test', status: 'disconnected',
  };
  const mapping = {
    id: 'offline-bridge', nostr_connection_id: connection.id, external_id: 'channel-offline',
    session_id: 'session-offline', enabled: true, status: 'connected', provider: 'nostr',
    config: { channelType: 'stream' }, session_title: 'Offline support', session_description: 'Still local',
  };
  const db = {
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('select * from nostr_community_connections where id')) return [connection];
      if (normalized.startsWith('select b.*') && normalized.includes('join chat_sessions')) return [{ ...mapping }];
      if (normalized.startsWith('update channel_bridges set enabled')) {
        mapping.enabled = params[2];
        mapping.status = 'disconnected';
        return [{ ...mapping }];
      }
      return [];
    },
  };
  const manager = createNostrCommunityManager({
    getDb: () => db,
    getWorkspaceSecretValue: async () => '',
    setWorkspaceSecretValue: async () => {},
    bridges: {},
    protocol: { query: async () => { throw new Error('relay offline'); } },
  });

  const channels = await manager.discoverChannels(connection.id, { allowLocalFallback: true });
  assert.deepEqual(channels[0], {
    id: 'channel-offline', name: 'Offline support', description: 'Still local', type: 'stream',
    visibility: 'public', archived: false, joined: true,
    subscription: {
      bridgeId: 'offline-bridge', channelId: 'channel-offline', sessionId: 'session-offline',
      enabled: true, status: 'connected', lastError: '',
    },
  });
  assert.equal((await manager.setChannelSubscription(connection.id, 'channel-offline', false)).enabled, false);
});

test('pausing and resuming a channel restarts one socket with accurate filters and catch-up suppression', async () => {
  FakeWebSocket.instances = [];
  const bridgeSecret = Buffer.from(nostr.generateSecretKey()).toString('hex');
  const relaySecret = nostr.generateSecretKey();
  const connection = {
    id: 'connection-1', workspace_id: 'workspace-1', relay_http_url: 'https://community.test',
    relay_ws_url: 'wss://community.test', status: 'connected',
    relay_pubkey: nostr.getPublicKey(relaySecret), member_pubkey: nostr.getPublicKey(Buffer.from(bridgeSecret, 'hex')),
  };
  const mappings = [
    {
      id: 'bridge-a', nostr_connection_id: connection.id, external_id: 'channel-a',
      session_id: 'session-a', enabled: true, status: 'connected', provider: 'nostr',
      nostr_initial_sync_completed: true, nostr_last_event_at: 50, config: { channelType: 'stream' },
      session_title: 'Channel A', session_description: '',
    },
    {
      id: 'bridge-b', nostr_connection_id: connection.id, external_id: 'channel-b',
      session_id: 'session-b', enabled: true, status: 'connected', provider: 'nostr',
      nostr_initial_sync_completed: true, nostr_last_event_at: 75, config: { channelType: 'stream' },
      session_title: 'Channel B', session_description: '',
    },
  ];
  const notices = [];
  const db = {
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('select * from nostr_community_connections where id')) return [connection];
      if (normalized.startsWith('update channel_bridges set enabled')) {
        const mapping = mappings.find(value => value.external_id === params[1]);
        mapping.enabled = params[2];
        mapping.status = params[2] ? 'connected' : 'disconnected';
        if (!params[2]) mapping.nostr_initial_sync_completed = false;
        return [{ ...mapping }];
      }
      if (normalized.startsWith('select * from channel_bridges')) return mappings.filter(value => value.enabled);
      if (normalized.startsWith('select b.*') && normalized.includes('join chat_sessions')) return mappings.map(value => ({ ...value }));
      if (normalized.startsWith('update nostr_community_connections')) return [];
      return [];
    },
  };
  const channelMetadata = nostr.finalizeEvent({
    kind: 39000, created_at: 1, tags: [['d', 'channel-a'], ['name', 'Channel A'], ['type', 'stream']], content: '',
  }, relaySecret);
  const manager = createNostrCommunityManager({
    getDb: () => db,
    getWorkspaceSecretValue: async () => bridgeSecret,
    setWorkspaceSecretValue: async () => {},
    bridges: {},
    protocol: { query: async () => [channelMetadata] },
    WebSocketClass: FakeWebSocket,
    notifyDbSubscribers: (...args) => notices.push(args),
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
  });

  assert.equal(await manager.startConnection(connection.id), true);
  const original = FakeWebSocket.instances[0];

  const paused = await manager.setChannelSubscription(connection.id, 'channel-a', false);
  assert.equal(paused.enabled, false);
  assert.equal(mappings[0].nostr_initial_sync_completed, false, 'resume must enter a non-dispatching catch-up phase');
  assert.equal(original.closed, true);
  const afterPause = FakeWebSocket.instances[1];
  authenticate(afterPause);
  const pauseFilters = afterPause.sent.filter(frame => frame[0] === 'REQ').flatMap(frame => frame.slice(2));
  assert.deepEqual(pauseFilters.map(filter => filter['#h'][0]), ['channel-b']);

  const resumed = await manager.setChannelSubscription(connection.id, 'channel-a', true);
  assert.equal(resumed.enabled, true);
  assert.equal(afterPause.closed, true);
  const afterResume = FakeWebSocket.instances[2];
  authenticate(afterResume);
  const resumeFilters = afterResume.sent.filter(frame => frame[0] === 'REQ').flatMap(frame => frame.slice(2));
  const resumedFilter = resumeFilters.find(filter => filter['#h'][0] === 'channel-a');
  assert.equal(resumedFilter.since, 45, 'resume catches up from the retained per-channel cursor');
  assert.equal(notices.filter(([, event]) => event === 'UPDATE').length, 2);
  manager.stopAll();
});

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  send(value) { this.sent.push(JSON.parse(String(value))); }

  close() { this.closed = true; this.emit('close'); }
}

function authenticate(socket) {
  socket.emit('message', JSON.stringify(['AUTH', 'challenge-test']));
  const authFrame = socket.sent.find(frame => frame[0] === 'AUTH');
  socket.emit('message', JSON.stringify(['OK', authFrame[1].id, true, '']));
}

class FailSecondWebSocket extends FakeWebSocket {
  static constructions = 0;

  constructor(url) {
    FailSecondWebSocket.constructions += 1;
    if (FailSecondWebSocket.constructions === 2) throw new Error('replacement socket failed');
    super(url);
  }
}

test('a synchronous replacement failure keeps the working socket and rolls the resumed channel to error', async () => {
  FakeWebSocket.instances = [];
  FailSecondWebSocket.constructions = 0;
  const bridgeSecret = Buffer.from(nostr.generateSecretKey()).toString('hex');
  const relaySecret = nostr.generateSecretKey();
  const connection = {
    id: 'restart-connection', workspace_id: 'workspace-1', relay_http_url: 'https://community.test',
    relay_ws_url: 'wss://community.test', status: 'connected', relay_pubkey: nostr.getPublicKey(relaySecret),
    member_pubkey: nostr.getPublicKey(Buffer.from(bridgeSecret, 'hex')),
  };
  const mappings = [
    {
      id: 'bridge-live', nostr_connection_id: connection.id, external_id: 'live', session_id: 'session-live',
      enabled: true, status: 'connected', provider: 'nostr', nostr_initial_sync_completed: true,
      nostr_last_event_at: 10, config: { channelType: 'stream' }, session_title: 'Live', session_description: '',
    },
    {
      id: 'bridge-paused', nostr_connection_id: connection.id, external_id: 'paused', session_id: 'session-paused',
      enabled: false, status: 'disconnected', provider: 'nostr', nostr_initial_sync_completed: false,
      nostr_last_event_at: 20, config: { channelType: 'stream' }, session_title: 'Paused', session_description: '',
    },
  ];
  const notices = [];
  const db = {
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('select * from nostr_community_connections where id')) return [connection];
      if (normalized.startsWith('select * from channel_bridges')) return mappings.filter(value => value.enabled);
      if (normalized.startsWith('select b.*') && normalized.includes('join chat_sessions')) return mappings.map(value => ({ ...value }));
      if (normalized.startsWith('update channel_bridges set enabled = false') && normalized.includes("status = 'error'")) {
        const mapping = mappings.find(value => value.external_id === params[1]);
        mapping.enabled = false;
        mapping.status = 'error';
        mapping.last_error = params[2];
        return [{ ...mapping }];
      }
      if (normalized.startsWith('update channel_bridges set enabled')) {
        const mapping = mappings.find(value => value.external_id === params[1]);
        mapping.enabled = params[2];
        mapping.status = params[2] ? 'connected' : 'disconnected';
        return [{ ...mapping }];
      }
      if (normalized.startsWith('update nostr_community_connections')) return [];
      return [];
    },
  };
  const metadata = nostr.finalizeEvent({
    kind: 39000, created_at: 1, tags: [['d', 'paused'], ['name', 'Paused']], content: '',
  }, relaySecret);
  const manager = createNostrCommunityManager({
    getDb: () => db,
    getWorkspaceSecretValue: async () => bridgeSecret,
    setWorkspaceSecretValue: async () => {},
    bridges: {},
    protocol: { query: async () => [metadata] },
    WebSocketClass: FailSecondWebSocket,
    notifyDbSubscribers: (...args) => notices.push(args),
  });

  assert.equal(await manager.startConnection(connection.id), true);
  const workingSocket = manager.__test.runtimes.get(connection.id).socket;
  await assert.rejects(
    manager.setChannelSubscription(connection.id, 'paused', true),
    /replacement socket failed/,
  );
  assert.equal(workingSocket.closed, false, 'the old runtime stays alive when its replacement cannot be constructed');
  assert.equal(manager.__test.runtimes.get(connection.id).socket, workingSocket);
  assert.equal(mappings[1].enabled, false);
  assert.equal(mappings[1].status, 'error');
  assert.equal(notices.at(-1)[2][0].status, 'error', 'only the final accurate state is broadcast');
  manager.stopAll();
});

test('one Nostr socket authenticates, subscribes mapped channels, suppresses history turns, then dispatches live mentions', async () => {
  FakeWebSocket.instances = [];
  const bridgeSecret = Buffer.from(nostr.generateSecretKey()).toString('hex');
  const bridgePubkey = nostr.getPublicKey(Buffer.from(bridgeSecret, 'hex'));
  const connection = {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: 'workspace-1',
    relay_http_url: 'https://nostr.example.test',
    relay_ws_url: 'wss://nostr.example.test',
    member_pubkey: bridgePubkey,
    status: 'connected',
  };
  const mappings = Array.from({ length: 11 }, (_, index) => ({
    id: `bridge-${index + 1}`, workspace_id: 'workspace-1', session_id: `session-${index + 1}`,
    external_id: index === 0 ? 'channel-a' : `channel-${index + 1}`, provider: 'nostr', enabled: true,
    nostr_initial_sync_completed: false, nostr_last_event_at: index === 0 ? 25 : 0,
  }));
  const ingested = [];
  const updates = [];
  const db = {
    async unsafe(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('select * from nostr_community_connections where id')) return [connection];
      if (normalized.startsWith('select * from channel_bridges')) return mappings;
      if (normalized.startsWith('select name, handle from nostr_community_members')) return [{ name: 'Ada', handle: 'ada' }];
      if (normalized.startsWith('update nostr_community_connections')) { updates.push(normalized); return []; }
      if (normalized.startsWith('update channel_bridges')) { updates.push(normalized); return []; }
      return [];
    },
  };
  const bridges = {
    async ingestBridgeMessage(value) { ingested.push(value); return { ingested: true }; },
  };
  const manager = createNostrCommunityManager({
    getDb: () => db,
    getWorkspaceSecretValue: async () => bridgeSecret,
    setWorkspaceSecretValue: async () => {},
    assertSafeOutboundUrl: async value => value,
    bridges,
    WebSocketClass: FakeWebSocket,
    protocol: {},
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
  });

  assert.equal(await manager.startConnection(connection.id), true);
  const socket = FakeWebSocket.instances[0];
  socket.emit('message', JSON.stringify(['AUTH', 'challenge-1']));
  const authFrame = socket.sent[0];
  assert.equal(authFrame[0], 'AUTH');
  assert.equal(nostr.verifyEvent(authFrame[1]), true);
  assert.deepEqual(authFrame[1].tags, [
    ['relay', connection.relay_ws_url],
    ['challenge', 'challenge-1'],
  ]);

  socket.emit('message', JSON.stringify(['OK', authFrame[1].id, true, '']));
  const request = socket.sent[1];
  assert.equal(request[0], 'REQ');
  assert.deepEqual(request[2]['#h'], ['channel-a']);
  assert.equal(request[2].since, 20, 'a paused channel resumes from its cursor without treating catch-up as live');
  assert.equal(request.length, 12, 'the relay receives at most ten filters in one subscription');
  const secondRequest = socket.sent[2];
  assert.equal(secondRequest[0], 'REQ');
  assert.equal(secondRequest.length, 3);

  const remoteSecret = nostr.generateSecretKey();
  const history = nostr.finalizeEvent({ kind: 9, created_at: 10, tags: [['h', 'channel-a']], content: '@agensis old message' }, remoteSecret);
  socket.emit('message', JSON.stringify(['EVENT', request[1], history]));
  await tick();
  assert.equal(ingested.length, 0, 'history waits for EOSE so it can be persisted oldest first');

  socket.emit('message', JSON.stringify(['EOSE', request[1]]));
  await waitFor(() => ingested.length === 1);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].dispatch, false, 'first subscription is history, so it must not wake an agent');
  assert.equal(ingested[0].sourceCreatedAt, 10);

  socket.emit('message', JSON.stringify(['EOSE', secondRequest[1]]));
  const live = nostr.finalizeEvent({ kind: 9, created_at: 11, tags: [['h', 'channel-a']], content: '@agensis live message' }, remoteSecret);
  socket.emit('message', JSON.stringify(['EVENT', request[1], live]));
  await waitFor(() => ingested.length === 2);
  assert.equal(ingested.length, 2);
  assert.equal(ingested[1].dispatch, true);
  assert.equal(ingested[1].authorName, 'Ada');
  assert.ok(updates.some(sql => sql.includes('nostr_initial_sync_completed = true')));

  manager.stopAll();
});

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('condition was not reached');
}
