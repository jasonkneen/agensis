'use strict';

// ============================================================================
// tests/realtime-socket-lifecycle.test.cjs
// ----------------------------------------------------------------------------
// The socket-level defences on /backend/ws, driven through a REAL WebSocket
// server rather than a fake client.
//
// Why a real server here when tests/realtime-revocation.test.cjs gets away with
// a plain object: every behaviour in this file lives in the `connection` handler
// itself — the auth race, the subscribe cap, the frame-size ceiling — and none
// of it is reachable through the exported functions a fake client can call. The
// bugs these pin were all invisible from outside for the same reason, so a test
// that could not open a socket could not have caught any of them.
//
// The unifying theme: the WS handshake needs NO credentials (auth is a first
// message frame), so between `connection` and that frame the server is talking
// to an anonymous stranger, and everything it allocates on their behalf must be
// bounded and must survive them vanishing mid-handshake.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createRealtime } = require('../server/realtime.cjs');

// The smallest dependency set the connection + auth + subscribe path touches.
// Everything else is only reached by an action frame these tests never send.
//
// NOTE for anyone adding a case here: verifyToken must reject the EMPTY token.
// There are two auth paths, and path (1) tries query-param credentials the
// instant the socket opens — with no token in the URL that is `verifyToken('')`.
// A stub that authenticates anything (`async () => 'user-1'`) therefore settles
// auth via path (1), which deliberately sends no `authenticated` frame, and any
// test waiting for one hangs forever against perfectly correct code.
function buildRealtime({ verifyToken, authorizeBinding = async () => {} } = {}) {
  return createRealtime({
    verifyToken,
    verifyAgentConnectToken: async () => null,
    agentTokenFromWsRequest: () => '',
    enforceDbOperationAccess: authorizeBinding,
    enforceWorkspaceRole: async () => {},
    ensureTable: () => {},
    forbidden: (message) => Object.assign(new Error(message), { status: 403 }),
    enqueueFlowWebhookEvents: async () => {},
    logMessageActivity: async () => {},
    markAgentConnectionOffline: async () => {},
    refreshConnectedAgentConfigs: () => {},
    resolveWorkspaceIdForSession: async () => null,
    VAULT_SECRET_COLUMNS: [],
    voiceRelay: { handleControl: async () => false, handleAudio: () => {}, teardown: () => {} },
    voiceStreamRateLimiter: { check: () => ({ allowed: true }) },
    inferenceBroker: { handleAgentEvent: () => {} },
  });
}

async function listen(realtime) {
  const server = http.createServer();
  const wss = realtime.attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/backend/ws`;
  return {
    url,
    wss,
    async close() {
      // Terminate surviving sockets FIRST. `http.Server.close()` stops new
      // connections and then waits for the existing ones to end on their own —
      // and a WebSocket never does, so a test that leaves its client open hangs
      // here forever rather than failing.
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* already gone */ }
      }
      await new Promise((resolve) => { server.close(resolve); wss.close(); });
    },
  };
}

// Deadlined on purpose: a socket test that waits forever for a frame reports as
// a hung suite with no failing assertion, which is the least useful outcome
// available. Fail loudly instead.
function nextMessage(ws, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no frame within ${timeoutMs}ms`)), timeoutMs);
    ws.once('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(String(raw))); });
  });
}

test('a socket that dies mid-authentication is never added to the fanout set', async () => {
  // THE LEAK. Both auth paths `await` a token verification — a DB round trip —
  // and only afterwards add the socket to the set that every broadcast walks.
  // A socket that drops during that await has ALREADY fired 'close', and 'close'
  // is the only thing that removes a socket from the set. So the entry added a
  // moment later is permanent: nothing will ever take it out again.
  //
  // It is silent, which is why it needed a test rather than a report — sendWs
  // checks readyState and skips the corpse, so the only symptom is that a server
  // which has been up for a week walks thousands of dead sockets on every single
  // row it broadcasts.
  //
  // MUTATION: drop the readyState guard in finalizeAuthenticated -> this fails.
  let releaseVerify;
  const verifyGate = new Promise((resolve) => { releaseVerify = resolve; });
  let verifyStarted;
  const started = new Promise((resolve) => { verifyStarted = resolve; });

  const realtime = buildRealtime({
    verifyToken: async (token) => {
      if (token !== 'tok') return null; // let path (1) fail; we are testing path (2)
      verifyStarted();
      await verifyGate; // hold auth open so we can close the socket underneath it
      return 'user-1';
    },
  });
  const server = await listen(realtime);
  try {
    const client = new WebSocket(server.url);
    await new Promise((resolve) => client.once('open', resolve));
    client.send(JSON.stringify({ type: 'auth', token: 'tok' }));

    await started;                       // server is inside verifyToken
    client.terminate();                  // the drop, mid-verification
    // Wait for the server to actually observe the close before releasing auth,
    // so the ordering under test (close THEN finalize) is the one that runs.
    while (server.wss.clients.size > 0) await new Promise((r) => setTimeout(r, 10));
    releaseVerify();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      realtime.websocketClientCount(),
      0,
      'a socket that closed during authentication must not be left in the fanout set',
    );
  } finally {
    await server.close();
  }
});

test('subscriptions are capped per socket', async () => {
  // Every entry is walked for EVERY row of EVERY broadcast on this socket, so an
  // uncapped list is a multiplier on the hottest loop in the server. Nothing
  // else bounded it: the dedup only skips EXACT repeats, so a client subscribing
  // with a slightly different filter each time grows it without ever repeating.
  //
  // MUTATION: remove the cap -> this fails.
  const realtime = buildRealtime({ verifyToken: async (token) => (token === 'tok' ? 'user-1' : null) });
  const server = await listen(realtime);
  try {
    const client = new WebSocket(server.url);
    await new Promise((resolve) => client.once('open', resolve));
    client.send(JSON.stringify({ type: 'auth', token: 'tok' }));
    const authed = await nextMessage(client);
    assert.equal(authed.event, 'authenticated');

    const cap = realtime.MAX_SUBSCRIPTIONS_PER_SOCKET;
    let rejection = null;
    for (let i = 0; i <= cap; i += 1) {
      // Distinct filters, so the exact-match dedup never collapses them.
      client.send(JSON.stringify({
        action: 'subscribe',
        channel: `tasks:ws-${i}`,
        binding: { type: 'db_changes', table: 'tasks', filter: `workspace_id=eq.ws-${i}` },
      }));
      const reply = await nextMessage(client);
      if (reply.type === 'error') { rejection = reply; break; }
    }

    assert.ok(rejection, `the ${cap + 1}th distinct subscription must be refused`);
    assert.equal(rejection.code, 'subscription_limit');
  } finally {
    await server.close();
  }
});

test('an oversized frame is refused instead of buffered', async () => {
  // ws defaults maxPayload to 100MB and buffers a message until its final frame
  // before any of our code runs — so on a socket that needs no credentials to
  // open, a few anonymous clients dribbling large messages is hundreds of MB
  // that no auth check or rate limiter ever gets the chance to refuse.
  //
  // MUTATION: drop maxPayload from the WebSocketServer options -> this fails
  // (the frame is accepted and silently ignored as unparseable JSON instead of
  // closing the socket with 1009 Message Too Big).
  const realtime = buildRealtime({ verifyToken: async (token) => (token === 'tok' ? 'user-1' : null) });
  const server = await listen(realtime);
  try {
    const client = new WebSocket(server.url);
    await new Promise((resolve) => client.once('open', resolve));
    const closed = new Promise((resolve) => client.once('close', (code) => resolve(code)));
    // Unauthenticated, deliberately: this is the budget an anonymous client has.
    client.send('x'.repeat(9 * 1024 * 1024));
    assert.equal(await closed, 1009, 'oversized frame must close the socket with 1009');
  } finally {
    await server.close();
  }
});
