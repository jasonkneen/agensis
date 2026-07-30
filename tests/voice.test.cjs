'use strict';

// ============================================================================
// tests/voice.test.cjs
// ----------------------------------------------------------------------------
// Deepgram speech-to-text and Cartesia text-to-speech for huddles. The whole
// feature exists behind one rule, and it is the rule these tests are mostly
// about:
//
//   NEITHER API KEY MAY REACH THE BROWSER.
//
// A sibling project ships VITE_DEEPGRAM_API_KEY to every visitor. Here the
// Cartesia key is exchanged for a 120-second, tts-only token before anything
// crosses the wire, and the Deepgram key never crosses it at all — the audio
// comes to us instead. So:
//
//   1. NO KEY IN ANY RESPONSE. Asserted against the serialised body of every
//      route, on the success path AND on each failure path, because an error
//      that echoes its own request is the classic way a secret escapes.
//   2. AUTH AND MEMBERSHIP FIRST. An unauthenticated token route is somebody
//      else's API bill. The 401/403 must land before the minter is reached.
//   3. RATE LIMITED. Same reason.
//   4. THE RELAY IS BOUNDED AND CLEANS UP. An orphaned Deepgram stream bills by
//      the minute for a browser that has closed; a stream that outlives its
//      socket is a leak with a running meter.
//   5. GRACEFUL, LOUD FAILURE. A missing key is a 503 with a sentence, never a
//      silent dead microphone.
//
// No live Postgres, no Deepgram, no Cartesia: the DB is the same recording fake
// the other route tests use, the Cartesia minter is injected, and the Deepgram
// socket is a fake emitter.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');

const { __test } = require('../server/index.cjs');
const voice = require('../server/voice.cjs');
const core = require('../shared/backend-core.cjs');
const voiceCore = require('../shared/voice-core.cjs');

const WS = '11111111-1111-4111-8111-111111111111';
const MEMBER = 'user-member';
const STRANGER = 'user-stranger';

// Distinctive enough that a substring search for them in a response body is
// meaningful, and shaped like the real thing.
const DEEPGRAM_KEY = 'dg-secret-key-must-never-ship-abcdef0123456789';
const CARTESIA_KEY = 'testkey_car_secret-must-never-ship-abcdef0123456789';
const MINTED_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.minted-short-lived-token.signature';

// --- fakes ------------------------------------------------------------------

function jsonError(res, status, error) {
  res.status(status).json({ data: null, error: { message: error?.message || 'Error', code: error?.code || null } });
}

async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = await __test.verifyToken(token);
  if (!userId) return jsonError(res, 401, new Error('Authentication required'));
  req.userId = userId;
  next();
}

function makeDb({ roles = {}, owners = {} } = {}) {
  return {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (n.startsWith('alter table') || n.startsWith('create')) return [];
      if (n.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'voice-secret' }] : [];
      }
      if (n.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }
      if (n.startsWith('select role from workspace_members')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }
      if (n.startsWith('select id, parent_workspace_id from workspaces')) return [];
      return [];
    },
  };
}

function makeApp(overrides = {}) {
  const minted = [];
  const app = express();
  app.use(express.json());
  voice.mountVoiceRoutes(app, {
    requireAuth,
    enforceWorkspaceRole: __test.enforceWorkspaceRole,
    jsonError,
    rateLimitBlocked: (res, limiter, key) => {
      const result = limiter.check(String(key));
      if (result.allowed) return false;
      res.status(429).json({ data: null, error: { message: 'Rate limit exceeded.', code: 'rate_limited' } });
      return true;
    },
    voiceTokenRateLimiter: core.createRateLimiter({ windowMs: 60_000, max: 3 }),
    env: { DEEPGRAM_API_KEY: DEEPGRAM_KEY, CARTESIA_API_KEY: CARTESIA_KEY },
    mintToken: async (args) => {
      minted.push(args);
      return { token: MINTED_TOKEN, expiresInSeconds: 120 };
    },
    ...overrides,
  });
  return { app, minted };
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

/** Assert neither key appears anywhere in a response, however it is shaped. */
function assertNoKeys(body, where) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  assert.ok(!text.includes(DEEPGRAM_KEY), `DEEPGRAM_API_KEY leaked in ${where}`);
  assert.ok(!text.includes(CARTESIA_KEY), `CARTESIA_API_KEY leaked in ${where}`);
  assert.ok(!text.includes('testkey_car_'), `a Cartesia key prefix leaked in ${where}`);
}

/** A stand-in for the ws client the relay opens to Deepgram. */
class FakeUpstream extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

/** A stand-in for the browser's realtime socket. */
function makeSocket() {
  const sent = [];
  return { sent, ws: { userId: MEMBER, voiceStt: null }, send: (payload) => sent.push(payload) };
}

test.beforeEach(() => {
  __test.resetTestState();
});

// --- 1. the key never leaves the server -------------------------------------

test('the tts-token route returns a short-lived token and NEITHER api key', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'viewer' } });
  __test.setTestDb(db);
  const { app, minted } = makeApp();
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/voice/tts-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assertNoKeys(raw, 'tts-token success body');

    const body = JSON.parse(raw);
    assert.equal(body.data.token, MINTED_TOKEN);
    assert.equal(body.data.expiresInSeconds, 120);
    assert.equal(body.data.model, 'sonic-3.5');
    // The minter got the real key; the client did not.
    assert.equal(minted.length, 1);
    assert.equal(minted[0].apiKey, CARTESIA_KEY);
  });
});

test('the capabilities route reports what is configured without naming a key', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'viewer' } });
  __test.setTestDb(db);
  const { app } = makeApp();
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/voice/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assertNoKeys(raw, 'capabilities body');
    const { data } = JSON.parse(raw);
    assert.equal(data.stt.provider, 'deepgram');
    assert.equal(data.stt.model, 'flux-general-en');
    assert.equal(data.tts.provider, 'cartesia');
    assert.equal(data.tts.model, 'sonic-3.5');
  });
});

test('a provider failure does not echo the key back in the error', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'viewer' } });
  __test.setTestDb(db);
  // The realistic shape of the leak: an error message built from the request.
  const { app } = makeApp({
    mintToken: async ({ apiKey }) => {
      throw Object.assign(new Error(`upstream rejected credentials for ${apiKey}`), { status: 502 });
    },
  });
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/voice/tts-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 502);
    const raw = await res.text();
    // The error still says something useful…
    assert.ok(raw.includes('upstream rejected credentials'), 'the error should still say something useful');
    // …and the key is redacted out of it on the way. This assertion caught a
    // real hole: jsonError forwards `error.message` verbatim, so before
    // scrubError existed, any upstream that echoed its own credential
    // published ours. Do not "fix" a failure here by weakening the check.
    assert.ok(raw.includes('[redacted]'), 'the key should be replaced, not just absent');
    assertNoKeys(raw, 'tts-token failure body');
  });
});

test('scrubKeys removes a configured key wherever it appears', () => {
  const env = { DEEPGRAM_API_KEY: DEEPGRAM_KEY, CARTESIA_API_KEY: CARTESIA_KEY };
  assert.equal(
    voiceCore.scrubKeys(`fetch to https://x?key=${CARTESIA_KEY} failed, retried with ${DEEPGRAM_KEY}`, env),
    'fetch to https://x?key=[redacted] failed, retried with [redacted]',
  );
  // An unset or implausibly short value must not become a global replace.
  assert.equal(voiceCore.scrubKeys('nothing to hide', {}), 'nothing to hide');
  assert.equal(voiceCore.scrubKeys('a b a b', { DEEPGRAM_API_KEY: 'a' }), 'a b a b');
  assert.equal(voiceCore.scrubKeys(undefined, env), '');

  const scrubbed = voiceCore.scrubError(Object.assign(new Error(`bad ${DEEPGRAM_KEY}`), { status: 502 }), env);
  assert.equal(scrubbed.message, 'bad [redacted]');
  assert.equal(scrubbed.status, 502);
});

test('mintCartesiaToken sends the key in the Authorization header and nowhere else', async () => {
  let seen = null;
  const result = await voiceCore.mintCartesiaToken({
    apiKey: CARTESIA_KEY,
    expiresIn: 120,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ token: MINTED_TOKEN }) };
    },
  });
  assert.equal(result.token, MINTED_TOKEN);
  assert.equal(seen.url, 'https://api.cartesia.ai/access-token');
  assert.equal(seen.init.headers.Authorization, `Bearer ${CARTESIA_KEY}`);
  assert.ok(!seen.url.includes(CARTESIA_KEY), 'the key must never be a query parameter — URLs land in logs');
  // The grant is narrow: a leaked token can synthesise speech and nothing else.
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.grants, { tts: true });
  assert.equal(body.expires_in, 120);
});

test('mintCartesiaToken refuses to build a token out of a provider error body', async () => {
  await assert.rejects(
    voiceCore.mintCartesiaToken({
      apiKey: CARTESIA_KEY,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
    }),
    (error) => {
      assert.equal(error.status, 502);
      assert.ok(!String(error.message).includes(CARTESIA_KEY));
      return true;
    },
  );
});

test('mintCartesiaToken turns a hung provider into a clean 504, not a request that never returns', async () => {
  // The exchange runs inside /voice/tts-token; a Cartesia that stops answering
  // must produce a sentence for the client, not hold the route open forever.
  await assert.rejects(
    voiceCore.mintCartesiaToken({
      apiKey: CARTESIA_KEY,
      fetchImpl: async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      },
    }),
    (error) => {
      assert.equal(error.status, 504);
      assert.match(error.message, /did not respond/);
      assert.ok(!String(error.message).includes(CARTESIA_KEY));
      return true;
    },
  );
});

// --- 2. auth and membership -------------------------------------------------

test('minting a voice token requires auth, and never reaches the minter', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  const { app, minted } = makeApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/voice/tts-token`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(minted.length, 0);
  });
});

test('a NON-MEMBER cannot mint a voice token (403, minter never reached)', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  const { app, minted } = makeApp();
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(STRANGER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/voice/tts-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    assert.equal(minted.length, 0);
    const capabilities = await fetch(`${baseUrl}/backend/workspaces/${WS}/voice/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(capabilities.status, 403);
  });
});

// --- 3. rate limiting -------------------------------------------------------

test('token minting is rate limited per user and workspace', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'viewer' } });
  __test.setTestDb(db);
  const { app, minted } = makeApp();
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const headers = { Authorization: `Bearer ${token}` };
    const url = `${baseUrl}/backend/workspaces/${WS}/voice/tts-token`;
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await fetch(url, { method: 'POST', headers })).status);
    }
    // The limiter in this harness is set to 3/min.
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.equal(minted.length, 3, 'a blocked request must not reach the provider');
  });
});

// --- 4. missing configuration is loud, not silent ---------------------------

test('an unset Cartesia key is a 503 with a sentence, not an empty 200', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'viewer' } });
  __test.setTestDb(db);
  const { app, minted } = makeApp({ env: { DEEPGRAM_API_KEY: DEEPGRAM_KEY, CARTESIA_API_KEY: '' } });
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/voice/tts-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /Cartesia is not configured/);
    assert.equal(minted.length, 0);
  });
});

test('capabilities reports null for whichever engine is unset', () => {
  assert.deepEqual(voiceCore.voiceCapabilities({}), { stt: null, tts: null });
  const sttOnly = voiceCore.voiceCapabilities({ DEEPGRAM_API_KEY: DEEPGRAM_KEY });
  assert.equal(sttOnly.tts, null);
  assert.equal(sttOnly.stt.provider, 'deepgram');
  // Whitespace is not configuration.
  assert.deepEqual(voiceCore.voiceCapabilities({ DEEPGRAM_API_KEY: '   ' }), { stt: null, tts: null });
});

// --- 5. the Deepgram listen URL --------------------------------------------

test('the listen url asks for Flux and clamps a client-supplied sample rate', () => {
  const url = new URL(voiceCore.deepgramListenUrl({ sampleRate: 16000 }));
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, 'wss://api.deepgram.com/v2/listen');
  assert.equal(url.searchParams.get('model'), 'flux-general-en');
  assert.equal(url.searchParams.get('encoding'), 'linear16');
  assert.equal(url.searchParams.get('sample_rate'), '16000');

  // The sample rate is the only value that crosses from a browser into a URL we
  // then connect to, so it is clamped rather than interpolated.
  for (const bad of [undefined, null, 'nonsense', -1, 0, 1e9, NaN, '48000; drop']) {
    const rate = new URL(voiceCore.deepgramListenUrl({ sampleRate: bad })).searchParams.get('sample_rate');
    assert.equal(rate, '16000', `sample rate ${String(bad)} should clamp to the default`);
  }
  assert.equal(voiceCore.clampSampleRate(48000), 48000);
  assert.equal(voiceCore.clampSampleRate(44100), 44100);
  assert.equal(voiceCore.clampSampleRate(7999), 16000);
});

// --- 6. the relay is bounded and cleans up ----------------------------------

function relayWith(env = { DEEPGRAM_API_KEY: DEEPGRAM_KEY }) {
  const upstreams = [];
  const relay = voice.createVoiceRelay({
    env,
    connect: (url, apiKey) => {
      const upstream = new FakeUpstream();
      upstream.url = url;
      upstream.apiKey = apiKey;
      upstreams.push(upstream);
      return upstream;
    },
    logger: { warn: () => {} },
  });
  return { relay, upstreams };
}

test('a start opens one upstream with the server-held key and acknowledges', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  const handled = await relay.handleControl(socket.ws, { action: 'voice_stt_start', sampleRate: 16000 }, {
    send: socket.send,
    rateLimited: () => false,
  });
  assert.equal(handled, true);
  assert.equal(upstreams.length, 1);
  assert.equal(upstreams[0].apiKey, DEEPGRAM_KEY);
  assert.match(upstreams[0].url, /model=flux-general-en/);
  // Nothing is acknowledged until Deepgram actually opens.
  assert.deepEqual(socket.sent, []);
  upstreams[0].emit('open');
  assert.deepEqual(socket.sent, [{ event: 'ready', sampleRate: 16000 }]);
  relay.teardown(socket.ws);
});

test('audio only flows once the upstream is open, and stops when it is torn down', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  // Only the binary frames: teardown also sends a JSON CloseStream, which is
  // Deepgram's flush and not audio.
  const audioFrames = () => upstreams[0].sent.filter(Buffer.isBuffer).length;
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, { send: socket.send, rateLimited: () => false });

  // A frame that arrives before the handshake completes is dropped, not queued:
  // replaying stale audio into a live transcription garbles the utterance.
  relay.handleAudio(socket.ws, Buffer.from([1, 2, 3]));
  assert.equal(audioFrames(), 0);

  upstreams[0].emit('open');
  relay.handleAudio(socket.ws, Buffer.from([1, 2, 3]));
  assert.equal(audioFrames(), 1);

  relay.teardown(socket.ws);
  relay.handleAudio(socket.ws, Buffer.from([4, 5, 6]));
  assert.equal(audioFrames(), 1, 'audio after teardown must not reach a closed upstream');
});

test('a second start replaces the first rather than leaking a billable stream', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  const open = { send: socket.send, rateLimited: () => false };
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, open);
  upstreams[0].emit('open');
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, open);
  assert.equal(upstreams.length, 2);
  assert.equal(upstreams[0].closed, true, 'the first upstream must be closed, not orphaned');
  relay.teardown(socket.ws);
});

test('teardown closes the upstream and is safe to repeat or call on a fresh socket', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, { send: socket.send, rateLimited: () => false });
  upstreams[0].emit('open');

  relay.teardown(socket.ws);
  assert.equal(upstreams[0].closed, true);
  assert.equal(socket.ws.voiceStt, null);
  // Idempotent — this runs on every socket close, most of which never had one.
  relay.teardown(socket.ws);
  relay.teardown({});
  relay.teardown(null);
});

test('flux frames are forwarded verbatim and junk is dropped', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, { send: socket.send, rateLimited: () => false });
  upstreams[0].emit('open');
  socket.sent.length = 0;

  const turn = { type: 'TurnInfo', event: 'EndOfTurn', transcript: 'ship it', end_of_turn_confidence: 0.9 };
  upstreams[0].emit('message', Buffer.from(JSON.stringify(turn)));
  upstreams[0].emit('message', Buffer.from('not json at all'));

  assert.deepEqual(socket.sent, [{ event: 'flux', message: turn }]);
  relay.teardown(socket.ws);
});

test('a stop frame closes the upstream', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, { send: socket.send, rateLimited: () => false });
  upstreams[0].emit('open');
  const handled = await relay.handleControl(socket.ws, { action: 'voice_stt_stop' }, { send: socket.send, rateLimited: () => false });
  assert.equal(handled, true);
  assert.equal(upstreams[0].closed, true);
});

test('the relay ignores messages that are not its own', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  const handled = await relay.handleControl(socket.ws, { action: 'subscribe', channel: 'x' }, {
    send: socket.send,
    rateLimited: () => false,
  });
  assert.equal(handled, false);
  assert.equal(upstreams.length, 0);
});

test('an unset Deepgram key says so instead of opening a dead microphone', async () => {
  const { relay, upstreams } = relayWith({ DEEPGRAM_API_KEY: '' });
  const socket = makeSocket();
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, { send: socket.send, rateLimited: () => false });
  assert.equal(upstreams.length, 0);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].event, 'unavailable');
  assert.match(socket.sent[0].reason, /Deepgram is not configured/);
});

test('a rate-limited start opens nothing and says why', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, { send: socket.send, rateLimited: () => true });
  assert.equal(upstreams.length, 0);
  assert.equal(socket.sent[0].event, 'unavailable');
  assert.match(socket.sent[0].reason, /Too many voice sessions/);
});

test('an upstream error is reported and the stream released, not left wedged', async () => {
  const { relay, upstreams } = relayWith();
  const socket = makeSocket();
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, { send: socket.send, rateLimited: () => false });
  upstreams[0].emit('open');
  socket.sent.length = 0;
  upstreams[0].emit('error', new Error('connection reset'));
  assert.equal(socket.sent[0].event, 'unavailable');
  assert.equal(socket.ws.voiceStt, null, 'a failed stream must not latch the mic off forever');
});

test('an idle stream is closed rather than billed for a browser that has gone', async () => {
  let clock = 1_000_000;
  const upstreams = [];
  const relay = voice.createVoiceRelay({
    env: { DEEPGRAM_API_KEY: DEEPGRAM_KEY },
    connect: () => { const u = new FakeUpstream(); upstreams.push(u); return u; },
    now: () => clock,
    logger: { warn: () => {} },
  });
  const socket = makeSocket();
  await relay.handleControl(socket.ws, { action: 'voice_stt_start' }, { send: socket.send, rateLimited: () => false });
  upstreams[0].emit('open');
  assert.equal(socket.ws.voiceStt.lastAudioAt, clock);

  // Audio keeps it alive…
  clock += voice.IDLE_TIMEOUT_MS - 1;
  relay.handleAudio(socket.ws, Buffer.from([0]));
  assert.equal(socket.ws.voiceStt.lastAudioAt, clock);

  // …and silence past the timeout does not. The watchdog runs on an interval in
  // production; here the state it reads is what matters.
  clock += voice.IDLE_TIMEOUT_MS + 1;
  assert.ok(clock - socket.ws.voiceStt.lastAudioAt > voice.IDLE_TIMEOUT_MS);
  assert.ok(voice.MAX_STREAM_MS > voice.IDLE_TIMEOUT_MS, 'the ceiling must be looser than the idle timeout');
  relay.teardown(socket.ws);
});
