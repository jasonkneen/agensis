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

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) { this.sent.push(JSON.parse(String(value))); }

  close() { this.emit('close'); }
}

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
    nostr_initial_sync_completed: false, nostr_last_event_at: 0,
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
