'use strict';

// The server half of huddle voice: a Cartesia token route, and a Deepgram audio
// relay that rides the realtime websocket.
//
// WHY THE RELAY EXISTS. Cartesia will exchange our secret key for a 120-second,
// TTS-only JWT, so the browser talks to Cartesia directly and this machine is
// not in the audio path. Deepgram would do the same — POST /v1/auth/grant — but
// the key staged as a Fly secret carries only `account:write`, and grants need
// Member or higher. Verified live on 2026-07-26: 403 FORBIDDEN, "Insufficient
// permissions", and the same for creating a scoped key. With no short-lived
// credential to hand out, the only way to keep DEEPGRAM_API_KEY off the client
// is for the key to stay here and the audio to come to us.
//
// WHY IT RIDES /backend/ws RATHER THAN A NEW ENDPOINT. A second
// WebSocketServer bound to the same http server aborts every upgrade that is
// not its own `path` (ws calls abortHandshake before the other server sees it),
// so adding one means restructuring upgrade routing for the app's realtime
// backbone. The existing socket is already authenticated, already open for the
// whole huddle, already pinged for liveness and already torn down on close —
// all four of which this needs. Audio is 32 KB/s of binary frames on a link
// that otherwise carries a few hundred bytes a second, and only while a mic is
// live in a call.
//
// Every stream is bounded. An abandoned relay bills Deepgram by the minute, so
// there is an idle timeout AND a hard ceiling, and both close the upstream.

const { WebSocket } = require('ws');
const {
  voiceCapabilities,
  unavailableReason,
  deepgramListenUrl,
  clampSampleRate,
  mintCartesiaToken,
  scrubError,
} = require('../shared/voice-core.cjs');

// No audio for this long means the tab was closed, backgrounded or the mic was
// cut without a stop frame. Deepgram keeps billing a silent stream.
const IDLE_TIMEOUT_MS = 30_000;
// Nothing legitimate holds one continuous transcription open for half an hour;
// a wedged client would. The browser reopens on the next utterance.
const MAX_STREAM_MS = 30 * 60_000;
// Deepgram's handshake is fast. If it has not answered by now it is not going to.
const UPSTREAM_OPEN_TIMEOUT_MS = 8000;

/**
 * The Deepgram relay for one realtime socket.
 *
 * Returned as an object of handlers rather than wired to the socket itself, so
 * server/index.cjs keeps one place where realtime message handling lives and
 * this file never learns how that socket authenticates.
 */
function createVoiceRelay({
  env = process.env,
  connect = defaultConnect,
  now = Date.now,
  logger = console,
} = {}) {
  /**
   * Client -> server control frame. Returns true when it was a voice frame, so
   * the caller can stop dispatching.
   */
  async function handleControl(ws, message, { send, rateLimited }) {
    const action = message && typeof message.action === 'string' ? message.action : '';
    if (action !== 'voice_stt_start' && action !== 'voice_stt_stop') return false;

    if (action === 'voice_stt_stop') {
      teardown(ws);
      return true;
    }

    // Rate limit the OPEN, not the audio: an open is a billable upstream
    // connection, and the audio that follows it is already bounded by the
    // timeouts below.
    if (typeof rateLimited === 'function' && rateLimited()) {
      send({ event: 'unavailable', reason: 'Too many voice sessions started. Please wait a moment.' });
      return true;
    }

    const reason = unavailableReason('stt', env);
    if (reason) {
      send({ event: 'unavailable', reason });
      return true;
    }

    // One upstream per socket. A second start replaces the first rather than
    // leaking it — a client that reconnects its mic must not double-bill.
    teardown(ws);

    const sampleRate = clampSampleRate(message.sampleRate);
    let upstream;
    try {
      upstream = connect(deepgramListenUrl({ sampleRate }), String(env.DEEPGRAM_API_KEY || '').trim());
    } catch (error) {
      logger.warn('[voice] deepgram connect failed:', error?.message || error);
      send({ event: 'unavailable', reason: 'Could not reach the transcription service.' });
      return true;
    }

    const state = {
      upstream,
      open: false,
      lastAudioAt: now(),
      startedAt: now(),
      timer: null,
    };
    ws.voiceStt = state;

    const openTimer = setTimeout(() => {
      if (state.open || ws.voiceStt !== state) return;
      logger.warn('[voice] deepgram did not open in time');
      send({ event: 'unavailable', reason: 'The transcription service did not answer.' });
      teardown(ws);
    }, UPSTREAM_OPEN_TIMEOUT_MS);
    openTimer.unref?.();

    // Idle/ceiling watchdog. One interval per stream, cleared by teardown.
    state.timer = setInterval(() => {
      if (ws.voiceStt !== state) return;
      const idleFor = now() - state.lastAudioAt;
      const ranFor = now() - state.startedAt;
      if (idleFor < IDLE_TIMEOUT_MS && ranFor < MAX_STREAM_MS) return;
      send({ event: 'closed', reason: ranFor >= MAX_STREAM_MS ? 'Voice session reached its time limit.' : '' });
      teardown(ws);
    }, 5000);
    state.timer.unref?.();

    upstream.on('open', () => {
      clearTimeout(openTimer);
      if (ws.voiceStt !== state) {
        try { upstream.close(); } catch { /* already gone */ }
        return;
      }
      state.open = true;
      send({ event: 'ready', sampleRate });
    });

    upstream.on('message', (raw) => {
      if (ws.voiceStt !== state) return;
      // Deepgram speaks JSON on this socket. Forward the event verbatim: the
      // turn-taking logic lives in the browser (src/lib/voiceStream.ts), where
      // it is a pure function with tests, rather than half here and half there.
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        return;
      }
      send({ event: 'flux', message: payload });
    });

    upstream.on('error', (error) => {
      if (ws.voiceStt !== state) return;
      clearTimeout(openTimer);
      logger.warn('[voice] deepgram stream error:', error?.message || error);
      send({ event: 'unavailable', reason: 'The transcription service dropped the connection.' });
      teardown(ws);
    });

    upstream.on('close', () => {
      clearTimeout(openTimer);
      if (ws.voiceStt !== state) return;
      send({ event: 'closed', reason: '' });
      teardown(ws);
    });

    return true;
  }

  /**
   * Client -> server binary audio. Dropped silently when no stream is open:
   * frames in flight when a stop is processed are normal, not an error.
   */
  function handleAudio(ws, data) {
    const state = ws.voiceStt;
    if (!state || !state.open) return;
    state.lastAudioAt = now();
    try {
      state.upstream.send(data);
    } catch (error) {
      logger.warn('[voice] dropping audio frame:', error?.message || error);
    }
  }

  /** Close the upstream and forget it. Safe to call repeatedly and on a socket that never had one. */
  function teardown(ws) {
    const state = ws && ws.voiceStt;
    if (!state) return;
    ws.voiceStt = null;
    if (state.timer) clearInterval(state.timer);
    // Detach first: close() can synchronously emit 'close', and a live handler
    // would send a `closed` frame down a socket that is itself going away.
    try { state.upstream.removeAllListeners(); } catch { /* not an emitter in tests */ }
    try {
      // CloseStream flushes whatever Deepgram is still holding; if the socket is
      // already dead this throws and the close() below is what matters.
      if (state.open) state.upstream.send(JSON.stringify({ type: 'CloseStream' }));
    } catch { /* already gone */ }
    try { state.upstream.close(); } catch { /* already gone */ }
  }

  return { handleControl, handleAudio, teardown };
}

function defaultConnect(url, apiKey) {
  return new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });
}

/**
 * HTTP routes. Only one: the Cartesia token exchange, plus the capability
 * report the client reads before it opens a microphone.
 *
 * Both are workspace-scoped and require the `read` role, so a token cannot be
 * minted by someone who is merely signed in — an unauthenticated TTS credential
 * is somebody else's API bill.
 */
function mountVoiceRoutes(app, deps = {}) {
  const {
    requireAuth,
    enforceWorkspaceRole,
    jsonError,
    rateLimitBlocked,
    voiceTokenRateLimiter,
    env = process.env,
    mintToken = mintCartesiaToken,
  } = deps;

  if (!app) throw new Error('mountVoiceRoutes requires an express app');
  for (const [name, value] of Object.entries({ requireAuth, enforceWorkspaceRole, jsonError })) {
    if (typeof value !== 'function') throw new Error(`mountVoiceRoutes requires deps.${name}`);
  }

  // Every error out of these two routes goes through scrubError. jsonError
  // forwards `error.message` verbatim, and these are the only routes in the app
  // whose upstream is authenticated with a raw secret — so an error built from
  // a request is one careless edit away from publishing the key.
  const fail = (res, error) => jsonError(res, error?.status || 500, scrubError(error, env));

  app.get('/backend/workspaces/:id/voice/capabilities', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'read');
      res.json({ data: voiceCapabilities(env), error: null });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/backend/workspaces/:id/voice/tts-token', requireAuth, async (req, res) => {
    try {
      const workspaceId = String(req.params.id || '').trim();
      if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
      await enforceWorkspaceRole(req.userId, workspaceId, 'read');
      if (voiceTokenRateLimiter && typeof rateLimitBlocked === 'function') {
        if (rateLimitBlocked(res, voiceTokenRateLimiter, `${req.userId}:${workspaceId}`)) return;
      }
      const reason = unavailableReason('tts', env);
      if (reason) return jsonError(res, 503, Object.assign(new Error(reason), { status: 503 }));

      const { token, expiresInSeconds } = await mintToken({ apiKey: String(env.CARTESIA_API_KEY || '').trim() });
      const capabilities = voiceCapabilities(env);
      res.json({
        data: { token, expiresInSeconds, ...(capabilities.tts || {}) },
        error: null,
      });
    } catch (error) {
      fail(res, error);
    }
  });
}

module.exports = { createVoiceRelay, mountVoiceRoutes, IDLE_TIMEOUT_MS, MAX_STREAM_MS };
