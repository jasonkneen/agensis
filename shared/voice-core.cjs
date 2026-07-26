'use strict';

// Voice engine configuration and credential minting, shared by both backends.
//
// THE ONE RULE IN THIS FILE: neither DEEPGRAM_API_KEY nor CARTESIA_API_KEY may
// ever appear in anything returned to a browser. A sibling project ships
// VITE_DEEPGRAM_API_KEY to every visitor; that is the mistake this module
// exists to make impossible. Everything here either stays server-side
// (Deepgram — see below) or is exchanged for a short-lived, narrowly-scoped
// token before it leaves the process (Cartesia).
//
// The two providers get different treatment because their accounts differ:
//
//   Cartesia HAS a token mechanism. POST /access-token exchanges the secret key
//   for a JWT carrying only the grants we ask for and expiring in minutes. The
//   browser gets that, opens its own socket to Cartesia, and our machine is not
//   in the audio path at all.
//
//   Deepgram HAS one too (POST /v1/auth/grant), but the key currently staged as
//   a Fly secret holds only the `account:write` scope, and grant minting needs
//   Member or higher — it answers 403 FORBIDDEN / "Insufficient permissions".
//   Verified live 2026-07-26, along with POST /projects/:id/keys (403,
//   "keys:write"). So there is nothing short-lived to hand out, and the ONLY
//   remaining way to keep the key off the client is to relay the audio
//   ourselves. server/voice.cjs does that over the already-authenticated
//   realtime socket. `deepgramGrantSupported` below is the switch that flips
//   this to the direct-token path the moment the account can mint one; nothing
//   else has to change on the client.

const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
const CARTESIA_TOKEN_URL = 'https://api.cartesia.ai/access-token';

// sonic-3.5 is GA and the fastest model Cartesia ships. Measured from this repo
// on 2026-07-26: 107-127ms from sending a transcript to the first audio chunk
// on a warm socket.
const CARTESIA_MODEL = 'sonic-3.5';
// Cartesia dates its API. Pinned rather than floating: a new default could
// change the websocket message shape under a deployed frontend.
const CARTESIA_VERSION = '2026-03-01';
// Sarah. A placeholder until agent-identity lands per-agent voice ids — every
// agent sounds the same until then, which is still better than every MACHINE
// sounding different, which is what speechSynthesis gave us.
const CARTESIA_DEFAULT_VOICE_ID = '794f9389-aac1-45b6-b726-9d9369183238';
// 16-bit at 24kHz. Half the bytes of f32/44.1k for speech nobody can tell
// apart, and the browser resamples to the output device for free.
const CARTESIA_OUTPUT = Object.freeze({ container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 });
// The token only has to be valid for the handshake, so this is "long enough to
// survive a slow connect", not "long enough for a call".
const CARTESIA_TOKEN_TTL_SECONDS = 120;
// The exchange itself is bounded too. A hung provider must become a clean 504,
// not a /voice/tts-token request that never answers the panel.
const CARTESIA_TOKEN_TIMEOUT_MS = 10_000;

// flux-general-en, not nova-3. Flux is Deepgram's conversational model: it
// decides when a turn has ENDED and says so (EndOfTurn), where nova-3 only
// reports speech-final and leaves endpointing to the caller. Endpointing is
// precisely what the browser recogniser was guessing at and getting wrong —
// cutting people off mid-sentence, or sitting on a finished one — so moving to
// a model that answers the question directly is most of the reason to do this
// at all.
const DEEPGRAM_MODEL = 'flux-general-en';
const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v2/listen';
// Deepgram's defaults. eot_threshold 0.7 is their recommendation for a balanced
// agent; lower is snappier and interrupts more.
const DEEPGRAM_EOT_THRESHOLD = 0.7;
const DEEPGRAM_EOT_TIMEOUT_MS = 5000;

function readKey(env, name) {
  const value = env && typeof env[name] === 'string' ? env[name].trim() : '';
  return value;
}

/**
 * Strip any configured key out of a message before it is sent to a client.
 *
 * The last line of defence, and it exists because a test caught the leak rather
 * than because anyone planned it: the error path forwards a provider's message
 * verbatim, so an upstream that echoes its own Authorization header — or one
 * careless edit that interpolates the key into an error — publishes the secret
 * to whoever made the request. Nothing in this file puts a key in a message
 * today; this makes sure nothing ever can.
 */
function scrubKeys(message, env = process.env) {
  let text = typeof message === 'string' ? message : String(message ?? '');
  for (const name of ['DEEPGRAM_API_KEY', 'CARTESIA_API_KEY']) {
    const key = readKey(env, name);
    // A short or absent value would turn this into a global replace of
    // something common; only a plausible secret is worth substituting.
    if (key.length >= 8) text = text.split(key).join('[redacted]');
  }
  return text;
}

/**
 * The error a client may see: the same class and status, with any key removed.
 * Errors returned to callers of this module always pass through here.
 */
function scrubError(error, env = process.env) {
  const scrubbed = new Error(scrubKeys(error?.message, env));
  scrubbed.status = error?.status || 500;
  if (error?.code) scrubbed.code = error.code;
  return scrubbed;
}

/**
 * What this deployment can actually do, from the environment alone.
 *
 * Returns only booleans and public constants — never a key. The client asks for
 * this before it opens a microphone so that "Deepgram is not configured" is a
 * sentence on screen and a fallback to the browser engine, rather than a mic
 * that lights up and transcribes nothing.
 */
function voiceCapabilities(env = process.env) {
  const deepgramKey = readKey(env, 'DEEPGRAM_API_KEY');
  const cartesiaKey = readKey(env, 'CARTESIA_API_KEY');
  return {
    stt: deepgramKey
      ? {
        provider: 'deepgram',
        model: DEEPGRAM_MODEL,
        // linear16 mono. The browser captures at whatever rate its AudioContext
        // grants and reports it on start, so no resampling happens anywhere.
        encoding: 'linear16',
        eotThreshold: DEEPGRAM_EOT_THRESHOLD,
        eotTimeoutMs: DEEPGRAM_EOT_TIMEOUT_MS,
      }
      : null,
    tts: cartesiaKey
      ? {
        provider: 'cartesia',
        model: CARTESIA_MODEL,
        version: CARTESIA_VERSION,
        defaultVoiceId: CARTESIA_DEFAULT_VOICE_ID,
        output: CARTESIA_OUTPUT,
      }
      : null,
  };
}

/**
 * Why a provider is unavailable, as a sentence for the user, or '' when it is.
 * Every failure in this feature has to say something — a silent dead mic is the
 * bug class this work exists to remove.
 */
function unavailableReason(kind, env = process.env) {
  if (kind === 'stt') {
    return readKey(env, 'DEEPGRAM_API_KEY') ? '' : 'Deepgram is not configured on this server.';
  }
  return readKey(env, 'CARTESIA_API_KEY') ? '' : 'Cartesia is not configured on this server.';
}

/**
 * The Deepgram Flux websocket URL for a capture at `sampleRate`.
 *
 * Never called with a client-supplied model or key — only the sample rate
 * crosses from the browser, and it is clamped, because it lands in a URL we
 * then connect to.
 */
function deepgramListenUrl({ sampleRate, model = DEEPGRAM_MODEL, eotThreshold = DEEPGRAM_EOT_THRESHOLD, eotTimeoutMs = DEEPGRAM_EOT_TIMEOUT_MS } = {}) {
  const params = new URLSearchParams({
    model,
    encoding: 'linear16',
    sample_rate: String(clampSampleRate(sampleRate)),
    eot_threshold: String(eotThreshold),
    eot_timeout_ms: String(eotTimeoutMs),
  });
  return `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;
}

/**
 * A sane capture rate, whatever the browser claimed.
 *
 * 8k-48k covers every rate an AudioContext will hand out. A non-number, a
 * negative, or 10^9 becomes 16000 rather than being interpolated into the URL
 * we are about to open a socket to.
 */
function clampSampleRate(value, fallback = 16000) {
  const rate = Math.round(Number(value));
  if (!Number.isFinite(rate) || rate < 8000 || rate > 48000) return fallback;
  return rate;
}

/**
 * Exchange the Cartesia secret key for a short-lived, TTS-only access token.
 *
 * `grants: { tts: true }` and nothing else: the token cannot reach the STT or
 * Agent endpoints even though the key behind it can. If Cartesia answers
 * anything but a token, this throws with the provider's own status attached, so
 * the route can tell "not configured" from "Cartesia is down" — the client
 * shows a different sentence for each.
 */
async function mintCartesiaToken({ apiKey, expiresIn = CARTESIA_TOKEN_TTL_SECONDS, fetchImpl = globalThis.fetch } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw Object.assign(new Error('Cartesia is not configured on this server.'), { status: 503 });
  if (typeof fetchImpl !== 'function') throw new Error('mintCartesiaToken requires fetch');

  let response;
  try {
    response = await fetchImpl(CARTESIA_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grants: { tts: true }, expires_in: expiresIn }),
      signal: AbortSignal.timeout(CARTESIA_TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw Object.assign(new Error('Cartesia did not respond to the token exchange in time.'), { status: 504 });
    }
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // The key is in the request, never in the reply — but truncate anyway so a
    // verbose provider error cannot become an unbounded log line.
    throw Object.assign(new Error(`Cartesia refused a voice token (${response.status}).`), {
      status: response.status === 401 || response.status === 403 ? 502 : 502,
      detail: detail.slice(0, 200),
    });
  }

  const payload = await response.json();
  const token = payload && typeof payload.token === 'string' ? payload.token : '';
  if (!token) throw Object.assign(new Error('Cartesia returned no voice token.'), { status: 502 });
  return { token, expiresInSeconds: expiresIn };
}

/**
 * Mint a Deepgram temporary token — the path this feature WANTS, unreachable on
 * the current account (see the file header). Kept because it is the whole fix
 * for the audio relay: once the key has Member scope, the client can be pointed
 * straight at Deepgram and the relay deleted.
 */
async function mintDeepgramToken({ apiKey, ttlSeconds = 60, fetchImpl = globalThis.fetch } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw Object.assign(new Error('Deepgram is not configured on this server.'), { status: 503 });
  const response = await fetchImpl(DEEPGRAM_GRANT_URL, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Deepgram refused a temporary token (${response.status}).`), { status: 502 });
  }
  const payload = await response.json();
  const token = payload && typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!token) throw Object.assign(new Error('Deepgram returned no temporary token.'), { status: 502 });
  return { token, expiresInSeconds: Number(payload.expires_in) || ttlSeconds };
}

module.exports = {
  voiceCapabilities,
  unavailableReason,
  scrubKeys,
  scrubError,
  deepgramListenUrl,
  clampSampleRate,
  mintCartesiaToken,
  mintDeepgramToken,
  CARTESIA_MODEL,
  CARTESIA_VERSION,
  CARTESIA_DEFAULT_VOICE_ID,
  CARTESIA_OUTPUT,
  CARTESIA_TOKEN_TTL_SECONDS,
  DEEPGRAM_MODEL,
  DEEPGRAM_LISTEN_URL,
};
