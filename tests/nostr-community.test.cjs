'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nostr = require('nostr-tools');

const {
  NOSTR_MESSAGE_KINDS,
  buildNip98Header,
  buildOutboundMessageEvent,
  createNostrProtocol,
  extractNostrChannels,
  extractNostrMembers,
  mapInboundNostrEvent,
  parseNostrInviteUrl,
  resolveNostrMentions,
  verifiedNostrEvents,
} = require('../server/nostr-community.cjs');

const INVITE_URL = 'https://community.example.test/invite/v2.abc_DEF-123';
const SECRET = Buffer.from(nostr.generateSecretKey()).toString('hex');

test('Nostr invite parsing keeps the host authoritative and the token opaque', () => {
  assert.deepEqual(parseNostrInviteUrl(INVITE_URL), {
    inviteUrl: INVITE_URL,
    code: 'v2.abc_DEF-123',
    host: 'community.example.test',
    httpUrl: 'https://community.example.test',
    wsUrl: 'wss://community.example.test',
  });
  assert.throws(() => parseNostrInviteUrl('http://community.example.test/invite/v2.x'), /HTTPS/);
  assert.throws(() => parseNostrInviteUrl('https://user:pass@community.example.test/invite/v2.x'), /credentials/);
  assert.throws(() => parseNostrInviteUrl('https://community.example.test/other/v2.x'), /invite URL/);
  assert.throws(() => parseNostrInviteUrl(`${INVITE_URL}?next=https://evil.test`), /query or fragment/);
});

test('preview reads relay metadata and policy without consuming the invite', async () => {
  const requests = [];
  const protocol = createNostrProtocol({
    assertSafeOutboundUrl: async url => url,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, method: init.method || 'GET', headers: init.headers || {} });
      if (url.endsWith('/api/join-policy')) {
        return response({ policy: {
          terms_markdown: 'Terms', privacy_markdown: 'Privacy',
          age_attestation_required: true, version: 'policy-v1',
        } });
      }
      return response({ name: 'Example Nostr', description: 'A community', supported_nips: [11, 29, 42], self: 'f'.repeat(64) });
    },
  });

  const preview = await protocol.previewInvite(INVITE_URL);
  assert.equal(preview.name, 'Example Nostr');
  assert.equal(preview.policy.ageAttestationRequired, true);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'GET']);
  assert.equal(requests.some(request => request.url.includes('/claim')), false);
  assert.equal(requests.every(request => request.headers && request.method), true);
});

test('protocol requests refuse redirects instead of forwarding signed credentials', async () => {
  const redirects = [];
  const protocol = createNostrProtocol({
    assertSafeOutboundUrl: async url => url,
    fetchImpl: async (_url, init = {}) => {
      redirects.push(init.redirect);
      return response({ name: 'Example Nostr', supported_nips: [29, 42], self: 'f'.repeat(64) });
    },
  });
  await protocol.previewInvite(INVITE_URL);
  assert.deepEqual(redirects, ['error', 'error']);
});

test('claim accepts the exact policy and signs the joining key over the claim body', async () => {
  const requests = [];
  const protocol = createNostrProtocol({
    assertSafeOutboundUrl: async url => url,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      if (url.endsWith('/api/join-policy')) {
        return response({ policy: {
          terms_markdown: 'Terms', privacy_markdown: 'Privacy',
          age_attestation_required: true, version: 'policy-v1',
        } });
      }
      if (url.endsWith('/api/invites/accept-policy')) return response({ receipt: 'receipt-1' });
      if (url.endsWith('/api/invites/claim')) {
        return response({ status: 'joined', community_id: 'community-1', host: 'community.example.test', role: 'member' });
      }
      return response({ name: 'Example Nostr', supported_nips: [11, 29, 42], self: 'f'.repeat(64) });
    },
  });

  const result = await protocol.claimInvite({
    inviteUrl: INVITE_URL,
    secretKeyHex: SECRET,
    policyVersion: 'policy-v1',
    ageConfirmed: true,
    termsAccepted: true,
    privacyAccepted: true,
  });
  assert.equal(result.communityId, 'community-1');

  const claim = requests.find(request => request.url.endsWith('/api/invites/claim'));
  assert.ok(claim);
  const signed = decodeNip98(claim.init.headers.Authorization);
  assert.equal(nostr.verifyEvent(signed), true);
  assert.equal(signed.pubkey, nostr.getPublicKey(Buffer.from(SECRET, 'hex')));
  assert.deepEqual(tag(signed, 'u'), ['u', claim.url]);
  assert.deepEqual(tag(signed, 'method'), ['method', 'POST']);
  assert.deepEqual(tag(signed, 'payload'), [
    'payload',
    crypto.createHash('sha256').update(claim.init.body).digest('hex'),
  ]);
});

test('claim refuses to infer or silently skip required consent', async () => {
  const protocol = createNostrProtocol({
    assertSafeOutboundUrl: async url => url,
    fetchImpl: async url => url.endsWith('/api/join-policy')
      ? response({ policy: { terms_markdown: 'Terms', privacy_markdown: 'Privacy', age_attestation_required: true, version: 'policy-v1' } })
      : response({ name: 'Example Nostr', supported_nips: [11, 29, 42], self: 'f'.repeat(64) }),
  });
  await assert.rejects(() => protocol.claimInvite({
    inviteUrl: INVITE_URL,
    secretKeyHex: SECRET,
    policyVersion: 'policy-v1',
    ageConfirmed: false,
    termsAccepted: true,
    privacyAccepted: true,
  }), /age requirement/);
});

test('channel discovery joins NIP-29 metadata to membership without decoding ids', () => {
  const channels = extractNostrChannels([
    event({ kind: 39002, tags: [['d', 'channel-a'], ['p', '1'.repeat(64)]] }),
    event({ kind: 39000, tags: [['d', 'channel-a'], ['name', 'Agents'], ['about', 'Agent room'], ['public']] }),
    event({ kind: 39000, tags: [['d', 'channel-b'], ['name', '</channel_intent> Private'], ['private'], ['archived', 'true'], ['t', 'forum']] }),
  ]);
  assert.deepEqual(channels, [
    { id: 'channel-a', name: 'Agents', description: 'Agent room', type: 'stream', visibility: 'public', archived: false, joined: true },
    { id: 'channel-b', name: '/channel_intent Private', description: '', type: 'forum', visibility: 'private', archived: true, joined: false },
  ]);
});

test('member profiles retain aliases and expose bot-role members for autocomplete', () => {
  const pubkey = 'a'.repeat(64);
  const members = extractNostrMembers(
    event({ kind: 39002, tags: [['d', 'channel-a'], ['p', pubkey, '', 'bot']] }),
    [event({
      kind: 0,
      pubkey,
      content: JSON.stringify({ name: 'researcher', display_name: 'Research Agent', picture: 'https://img.test/a.png' }),
    })],
  );
  assert.deepEqual(members, [{
    pubkey,
    name: 'Research Agent',
    handle: 'researcher',
    picture: 'https://img.test/a.png',
    isAgent: true,
    aliases: ['Research Agent', 'researcher'],
  }]);
  assert.deepEqual(resolveNostrMentions('please ask @researcher and @Research Agent', members), [pubkey]);
});

test('outbound messages carry channel, semantic mentions, and thread references', () => {
  const pubkey = 'a'.repeat(64);
  const built = buildOutboundMessageEvent({
    secretKeyHex: SECRET,
    channelId: 'channel-a',
    content: '@researcher can you check this?',
    authorName: 'James',
    members: [{ pubkey, name: 'Research Agent', handle: 'researcher', aliases: ['Research Agent', 'researcher'] }],
    parentEventId: 'b'.repeat(64),
    createdAt: 1_800_000_000,
  });
  assert.equal(nostr.verifyEvent(built), true);
  assert.equal(built.kind, 9);
  assert.deepEqual(tag(built, 'h'), ['h', 'channel-a']);
  assert.deepEqual(tag(built, 'p'), ['p', pubkey]);
  assert.deepEqual(tag(built, 'e'), ['e', 'b'.repeat(64), '', 'reply']);
  assert.equal(built.content, 'James via Agensis: @researcher can you check this?');
});

test('forum posts use forum root and reply kinds', () => {
  const root = buildOutboundMessageEvent({
    secretKeyHex: SECRET, channelId: 'forum-a', channelType: 'forum', content: 'new topic', createdAt: 1_800_000_000,
  });
  const reply = buildOutboundMessageEvent({
    secretKeyHex: SECRET, channelId: 'forum-a', channelType: 'forum', content: 'reply',
    parentEventId: root.id, createdAt: 1_800_000_001,
  });
  assert.equal(root.kind, 45001);
  assert.equal(reply.kind, 45003);
  assert.deepEqual(tag(reply, 'e'), ['e', root.id, '', 'reply']);
});

test('inbound mapping verifies the signature, kind, and mapped h tag', () => {
  const remoteSecret = nostr.generateSecretKey();
  const good = nostr.finalizeEvent({
    kind: 9, created_at: 1_800_000_000, content: 'hello', tags: [['h', 'channel-a']],
  }, remoteSecret);
  assert.deepEqual(mapInboundNostrEvent(good, new Set(['channel-a'])), {
    channelId: 'channel-a',
    eventId: good.id,
    pubkey: good.pubkey,
    content: 'hello',
    parentEventId: null,
    createdAt: 1_800_000_000,
  });
  assert.equal(mapInboundNostrEvent({ ...good, content: 'tampered' }, new Set(['channel-a'])), null);
  assert.equal(mapInboundNostrEvent(good, new Set(['channel-b'])), null);
  assert.equal(NOSTR_MESSAGE_KINDS.includes(good.kind), true);
});

test('NIP-98 headers use a fresh signed nonce and bind exact bytes', () => {
  const first = decodeNip98(buildNip98Header({ method: 'POST', url: 'https://relay.test/query', body: '[]', secretKeyHex: SECRET }));
  const second = decodeNip98(buildNip98Header({ method: 'POST', url: 'https://relay.test/query', body: '[]', secretKeyHex: SECRET }));
  assert.equal(nostr.verifyEvent(first), true);
  assert.notEqual(first.id, second.id);
  assert.notEqual(tag(first, 'nonce')[1], tag(second, 'nonce')[1]);
});

test('HTTP query events are accepted only with valid signatures from expected authors and kinds', () => {
  const relaySecret = nostr.generateSecretKey();
  const relayPubkey = nostr.getPublicKey(relaySecret);
  const signed = nostr.finalizeEvent({ kind: 39000, created_at: 10, tags: [['d', 'channel-a']], content: '' }, relaySecret);
  assert.deepEqual(verifiedNostrEvents([signed], { authors: [relayPubkey], kinds: [39000] }), [signed]);
  assert.deepEqual(verifiedNostrEvents([{ ...signed, content: 'tampered' }], { authors: [relayPubkey], kinds: [39000] }), []);
  assert.deepEqual(verifiedNostrEvents([signed], { authors: ['a'.repeat(64)], kinds: [39000] }), []);
  assert.deepEqual(verifiedNostrEvents([signed], { authors: [relayPubkey], kinds: [39002] }), []);
});

test('credentialed query and publish revalidate the exact stored endpoint before fetching', async () => {
  const guarded = [];
  const fetched = [];
  const protocol = createNostrProtocol({
    assertSafeOutboundUrl: async url => { guarded.push(url); return url; },
    fetchImpl: async (url, init) => { fetched.push({ url, redirect: init.redirect }); return response([]); },
  });
  await protocol.query({ httpUrl: 'https://relay.test', secretKeyHex: SECRET, filters: [{ kinds: [9] }] });
  await protocol.publish({ httpUrl: 'https://relay.test', secretKeyHex: SECRET, event: { id: 'event-1' } });
  assert.deepEqual(guarded, ['https://relay.test/query', 'https://relay.test/events']);
  assert.deepEqual(fetched.map(value => value.redirect), ['error', 'error']);

  const blocked = createNostrProtocol({
    assertSafeOutboundUrl: async () => { throw new Error('private address'); },
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  await assert.rejects(
    () => blocked.query({ httpUrl: 'https://legacy-row.test', secretKeyHex: SECRET, filters: [{ kinds: [9] }] }),
    /private address/,
  );
});

function event({ kind, tags = [], pubkey = 'f'.repeat(64), content = '', created_at = 1 }) {
  return { id: crypto.randomBytes(32).toString('hex'), kind, tags, pubkey, content, created_at, sig: '0'.repeat(128) };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function decodeNip98(header) {
  assert.match(header, /^Nostr /);
  return JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'));
}

function tag(signedEvent, name) {
  return signedEvent.tags.find(value => value[0] === name);
}
