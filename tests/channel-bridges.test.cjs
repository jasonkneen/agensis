// ============================================================================
// tests/channel-bridges.test.cjs
// ----------------------------------------------------------------------------
// A bridge carries messages between an agensis channel and an outside network.
// Two things here will ruin somebody's day if they are wrong, and both are
// tested against behaviour rather than against the implementation:
//
//   1. THE ECHO LOOP. Ingest writes a `messages` row; that insert fires the
//      outbound hook; if outbound does not recognise its own inbound message it
//      sends it straight back, the remote network delivers it again, and the
//      channel fills up in a few seconds. sender_kind='bridge' is the guard.
//
//   2. DUPLICATE DELIVERY. Telegram retries any webhook it thinks failed,
//      Baileys replays on reconnect, signal-cli re-delivers on restart. Without
//      an idempotent claim, one flaky delivery becomes a duplicated message AND
//      a second agent turn — which costs money and posts twice.
//
// Plus the Slack signature, which is security-relevant and easy to get subtly
// wrong (re-serialized body, missing replay window, throwing on length mismatch).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChannelBridges } = require('../server/channel-bridges.cjs');
const { verifySlackSignature } = require('../server/bridge-routes.cjs');
const crypto = require('node:crypto');

const WS = 'w1';
const SESSION = 's1';
const BRIDGE = {
  id: 'b1',
  workspace_id: WS,
  session_id: SESSION,
  provider: 'telegram',
  lane: 'hub',
  external_id: '-100123',
  config: { botToken: 'tok', secretToken: 'sec' },
  enabled: true,
  status: 'connected',
};

// In-memory stand-in. Models the ONE thing that matters: the unique index on
// (bridge_id, external_message_id), because that is what makes ingest idempotent.
function makeWorld({ bridge = BRIDGE } = {}) {
  const state = { bridges: [ { ...bridge } ], claims: [], messages: [], turns: [], sent: [] };
  let seq = 0;
  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();

      if (n.startsWith('select * from channel_bridges where session_id')) {
        return state.bridges.filter(b => b.session_id === params[0] && b.enabled !== false).map(b => ({ ...b }));
      }
      if (n.startsWith('select * from channel_bridges where id')) {
        return state.bridges.filter(b => b.id === params[0]).map(b => ({ ...b }));
      }
      if (n.startsWith('insert into bridge_messages')) {
        const [bridgeId, externalId, direction] = params;
        // The unique index, modelled.
        if (state.claims.some(c => c.bridgeId === bridgeId && c.externalId === externalId)) return [];
        state.claims.push({ bridgeId, externalId, direction });
        return [{ id: `claim-${state.claims.length}` }];
      }
      if (n.startsWith('insert into messages')) {
        seq += 1;
        const row = {
          id: `m-${seq}`, session_id: params[0], content: params[1],
          sender_kind: 'bridge', sender_name: params[2],
        };
        state.messages.push(row);
        return [{ ...row }];
      }
      if (n.startsWith('update bridge_messages set message_id')) return [];
      if (n.startsWith('update channel_bridges set last_inbound_at')
        || n.startsWith('update channel_bridges set last_outbound_at')
        || n.startsWith('update channel_bridges set status')) {
        const b = state.bridges.find(x => x.id === params[0] || x.session_id === params[0]);
        if (b && params[1]) b.status = params[1];
        return b ? [{ ...b }] : [];
      }
      return [];
    },
  };

  const bridges = createChannelBridges({
    getDb: () => db,
    notifyDbSubscribers: () => {},
    continueConversation: async (args) => { state.turns.push(args); return { started: true }; },
    sendToConnection: (connectionId, payload) => { state.sent.push({ connectionId, payload }); return true; },
    isConnectionSocketOpen: () => true,
  });
  bridges.registerHubAdapter({
    provider: 'telegram',
    async send(b, text, meta) { state.sent.push({ text, meta, externalId: b.external_id }); return `out-${state.sent.length}`; },
  });
  return { state, bridges };
}

// --- (1) the echo loop -------------------------------------------------------

test('a message ingested FROM the network is never sent back to it', async () => {
  const { state, bridges } = makeWorld();

  const inbound = await bridges.ingestBridgeMessage({
    bridgeId: 'b1', externalMessageId: '-100123:7', authorName: 'Ana', text: 'hello from telegram',
  });
  assert.equal(inbound.ingested, true);
  assert.equal(state.messages.length, 1);

  // This is the insert hook firing on the row ingest just wrote — the exact
  // sequence that loops if sender_kind is not checked.
  const out = await bridges.emitBridgeOutbound(state.messages[0]);
  assert.equal(out.sent, false);
  assert.equal(out.reason, 'inbound_echo');
  assert.equal(state.sent.length, 0, 'nothing went back out to Telegram');
});

test('an agent reply in a bridged channel DOES go out', async () => {
  const { state, bridges } = makeWorld();
  const out = await bridges.emitBridgeOutbound({
    id: 'm-x', session_id: SESSION, content: 'on it', sender_kind: 'agent', sender_name: 'Coder',
  });
  assert.equal(out.sent, true);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].text, 'on it');
  assert.equal(state.sent[0].meta.authorName, 'Coder', 'the author survives the hop');
});

test('a message in an UNBRIDGED channel is left alone', async () => {
  const { state, bridges } = makeWorld();
  const out = await bridges.emitBridgeOutbound({
    id: 'm-x', session_id: 'some-other-session', content: 'hi', sender_kind: 'user',
  });
  assert.equal(out.sent, false);
  assert.equal(out.reason, 'not_bridged');
  assert.equal(state.sent.length, 0);
});

// --- (2) duplicate delivery --------------------------------------------------

test('the same remote message delivered twice is ingested ONCE', async () => {
  const { state, bridges } = makeWorld();
  const delivery = { bridgeId: 'b1', externalMessageId: '-100123:9', authorName: 'Ana', text: 'ping' };

  const first = await bridges.ingestBridgeMessage(delivery);
  const retry = await bridges.ingestBridgeMessage(delivery);

  assert.equal(first.ingested, true);
  assert.equal(retry.ingested, false);
  assert.equal(retry.reason, 'duplicate');
  assert.equal(state.messages.length, 1, 'one message, not two');
  assert.equal(state.turns.length, 1, 'and ONE agent turn — a retry must not cost a second run');
});

test('concurrent deliveries of the same message still produce one', async () => {
  const { state, bridges } = makeWorld();
  const delivery = { bridgeId: 'b1', externalMessageId: '-100123:11', authorName: 'Ana', text: 'race' };
  await Promise.all([
    bridges.ingestBridgeMessage(delivery),
    bridges.ingestBridgeMessage(delivery),
    bridges.ingestBridgeMessage(delivery),
  ]);
  assert.equal(state.messages.length, 1);
});

test('our own outbound is recorded, so a provider that echoes sends does not re-ingest them', async () => {
  const { state, bridges } = makeWorld();
  await bridges.emitBridgeOutbound({
    id: 'm-x', session_id: SESSION, content: 'sent from agensis', sender_kind: 'agent', sender_name: 'Coder',
  });
  // WhatsApp and Signal both show a linked device its own traffic. That echo
  // arrives carrying the id we already claimed on the way out.
  const echoed = await bridges.ingestBridgeMessage({
    bridgeId: 'b1', externalMessageId: 'out-1', authorName: 'me', text: 'sent from agensis',
  });
  assert.equal(echoed.ingested, false);
  assert.equal(echoed.reason, 'duplicate');
  assert.equal(state.messages.length, 0, 'the agent never sees its own words come back');
});

// --- (3) ingest feeds the NORMAL conversation path ---------------------------

test('an ingested message runs the ordinary turn, not a bridge-specific one', async () => {
  const { state, bridges } = makeWorld();
  await bridges.ingestBridgeMessage({
    bridgeId: 'b1', externalMessageId: '-100123:21', authorName: 'Ana', text: 'anyone about?',
  });
  assert.deepEqual(state.turns, [{ workspaceId: WS, sessionId: SESSION }]);
});

test('an empty or whitespace-only remote message is dropped before it costs a turn', async () => {
  const { state, bridges } = makeWorld();
  const out = await bridges.ingestBridgeMessage({ bridgeId: 'b1', externalMessageId: 'x', text: '   ' });
  assert.equal(out.ingested, false);
  assert.equal(state.turns.length, 0);
});

test('a disabled bridge ingests nothing', async () => {
  const { state, bridges } = makeWorld({ bridge: { ...BRIDGE, enabled: false } });
  const out = await bridges.ingestBridgeMessage({ bridgeId: 'b1', externalMessageId: 'x', text: 'hi' });
  assert.equal(out.ingested, false);
  assert.equal(state.messages.length, 0);
});

// --- (4) the daemon lane -----------------------------------------------------

test('a daemon-lane bridge relays outbound over the socket, not over HTTP', async () => {
  const { state, bridges } = makeWorld({
    bridge: { ...BRIDGE, provider: 'whatsapp', lane: 'daemon', connection_id: 'conn-1', external_id: '4477@s.whatsapp.net' },
  });
  const out = await bridges.emitBridgeOutbound({
    id: 'm-x', session_id: SESSION, content: 'hi', sender_kind: 'agent', sender_name: 'Coder',
  });
  assert.equal(out.sent, true);
  assert.equal(out.reason, 'relayed');
  assert.equal(state.sent[0].connectionId, 'conn-1');
  // hub -> daemon frames are keyed on `type`; only daemon -> hub uses `action`.
  // Getting this backwards means the daemon silently ignores the frame, which
  // looks exactly like a bridge that is connected but never delivers.
  assert.equal(state.sent[0].payload.type, 'bridge_send');
  assert.equal(state.sent[0].payload.action, undefined, 'must not be sent as an `action` frame');
  assert.equal(state.sent[0].payload.externalId, '4477@s.whatsapp.net');
});

test('a daemon-lane bridge with no daemon attached fails loudly rather than silently', async () => {
  const { bridges } = makeWorld({
    bridge: { ...BRIDGE, provider: 'signal', lane: 'daemon', connection_id: null },
  });
  const out = await bridges.emitBridgeOutbound({
    id: 'm-x', session_id: SESSION, content: 'hi', sender_kind: 'agent',
  });
  assert.equal(out.sent, false);
  assert.equal(out.reason, 'no_daemon');
});

test('a daemon frame for a bridge pinned to a DIFFERENT connection is refused', async () => {
  const { state, bridges } = makeWorld({
    bridge: { ...BRIDGE, provider: 'whatsapp', lane: 'daemon', connection_id: 'conn-1' },
  });
  await bridges.handleBridgeMessage(
    { agentConnectionId: 'conn-2' },
    { action: 'bridge_inbound', bridgeId: 'b1', text: 'i should not get through', externalMessageId: 'z' },
  );
  assert.equal(state.messages.length, 0, 'another workspace\'s daemon cannot post here');
});

test('a daemon frame from the OWNING connection is ingested', async () => {
  const { state, bridges } = makeWorld({
    bridge: { ...BRIDGE, provider: 'whatsapp', lane: 'daemon', connection_id: 'conn-1' },
  });
  await bridges.handleBridgeMessage(
    { agentConnectionId: 'conn-1' },
    { action: 'bridge_inbound', bridgeId: 'b1', text: 'real message', author: 'Ana', externalMessageId: 'z' },
  );
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].content, 'real message');
});

// --- (5) lane assignment is not a preference ---------------------------------

test('every provider maps to exactly one lane, and an unknown one to none', () => {
  const { bridges } = makeWorld();
  assert.equal(bridges.laneForProvider('telegram'), 'hub');
  assert.equal(bridges.laneForProvider('slack'), 'hub');
  assert.equal(bridges.laneForProvider('whatsapp'), 'daemon');
  assert.equal(bridges.laneForProvider('signal'), 'daemon');
  assert.equal(bridges.laneForProvider('openclaw'), 'daemon');
  assert.equal(bridges.laneForProvider('nonsense'), null);
});

// --- (6) Slack request signing ----------------------------------------------

const SECRET = 'shhh';
function signed(body, ts) {
  return `v0=${crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

test('a correctly signed Slack delivery verifies', () => {
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = '{"type":"event_callback"}';
  assert.equal(verifySlackSignature({
    signingSecret: SECRET, timestamp: ts, rawBody: body, signature: signed(body, ts), now,
  }), true);
});

test('a tampered body fails even with a valid-looking signature', () => {
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  assert.equal(verifySlackSignature({
    signingSecret: SECRET, timestamp: ts, rawBody: '{"type":"evil"}',
    signature: signed('{"type":"event_callback"}', ts), now,
  }), false);
});

test('a captured delivery replayed later is refused', () => {
  const signedAt = 1_800_000_000_000;
  const ts = String(Math.floor(signedAt / 1000));
  const body = '{"type":"event_callback"}';
  const sig = signed(body, ts);
  // Valid when fresh...
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: body, signature: sig, now: signedAt }), true);
  // ...and refused six minutes later, outside Slack's own five-minute window.
  assert.equal(verifySlackSignature({
    signingSecret: SECRET, timestamp: ts, rawBody: body, signature: sig, now: signedAt + 6 * 60 * 1000,
  }), false);
});

test('a short or malformed signature returns false instead of throwing', () => {
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  // timingSafeEqual THROWS on a length mismatch; unguarded, this is a 500 on
  // every malformed request rather than a clean 401.
  assert.doesNotThrow(() => verifySlackSignature({
    signingSecret: SECRET, timestamp: ts, rawBody: '{}', signature: 'v0=short', now,
  }));
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: '{}', signature: 'v0=short', now }), false);
});

test('a missing secret or signature never verifies', () => {
  assert.equal(verifySlackSignature({ signingSecret: '', timestamp: '1', rawBody: '{}', signature: 'v0=x' }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: '1', rawBody: '{}', signature: '' }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: 'not-a-number', rawBody: '{}', signature: 'v0=x' }), false);
});
