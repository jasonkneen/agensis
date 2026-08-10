// The LiveKit worker is a MEDIA BRIDGE for a selected Agensis agent:
//
//   microphone -> Deepgram STT -> @selected-handle durable chat turn
//   real Agensis reply -> LiveKit data -> Cartesia TTS -> room audio
//
// It deliberately has no LLM. Claude, Codex, Grok, or whichever persisted
// workspace agent was selected owns reasoning and tools through the ordinary
// Agensis dispatcher. Adding an LLM here creates a second unrelated agent and
// bypasses the selected handle.

import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as silero from '@livekit/agents-plugin-silero';

export const DEFAULT_CARTESIA_MODEL = 'sonic-3.5';
export const DEFAULT_DEEPGRAM_MODEL = 'flux-general-en';
export const DEFAULT_VOICE_ENGINE = 'cartesia-deepgram';
export const VOICE_OUTPUT_QUEUE_SIZE_MS = 2_000;

/** Flux uses Deepgram's turn-aware /v2/listen websocket; Nova stays on V1. */
export function createDeepgramStt(model = DEFAULT_DEEPGRAM_MODEL, env = process.env) {
  const name = String(model || '').trim() || DEFAULT_DEEPGRAM_MODEL;
  const apiKey = String(env.DEEPGRAM_API_KEY || '').trim();
  const options = { model: name, ...(apiKey ? { apiKey } : {}) };
  return name.startsWith('flux-')
    ? new deepgram.STTv2(options)
    : new deepgram.STT(options);
}

export const VOICE_ENGINES = Object.freeze({
  'cartesia-deepgram': {
    kind: 'media-bridge',
    label: 'Cartesia + Deepgram',
    needs: ['CARTESIA_API_KEY', 'DEEPGRAM_API_KEY'],
  },
});

export function availableEngines(env = process.env) {
  return Object.entries(VOICE_ENGINES)
    .filter(([, spec]) => spec.needs.every((key) => String(env[key] || '').trim()))
    .map(([id]) => id);
}

/** No cross-vendor fallback: unavailable speech credentials fail closed. */
export function resolveEngine(requested, env = process.env) {
  const available = availableEngines(env);
  const configured = String(requested || '').trim();
  const want = configured || DEFAULT_VOICE_ENGINE;
  const usedDefault = !configured;
  if (available.includes(want)) {
    return { engine: want, fellBack: false, requested: want, usedDefault, available };
  }
  if (VOICE_ENGINES[want]) {
    const missing = VOICE_ENGINES[want].needs.filter((key) => !String(env[key] || '').trim());
    return { engine: '', fellBack: false, missing, requested: want, usedDefault, available };
  }
  return { engine: '', fellBack: false, requested: want, usedDefault, unknown: true, available };
}

let vadPromise = null;
export function loadVad(prewarmed = null) {
  if (prewarmed) return Promise.resolve(prewarmed);
  if (!vadPromise) vadPromise = silero.VAD.load();
  return vadPromise;
}

/** Build speech input/output only. There is intentionally no `llm` field. */
export async function buildEngine({ engine, voice = {}, vad = null, env = process.env } = {}) {
  if (!VOICE_ENGINES[engine]) throw new Error(`Unknown voice engine "${engine}"`);

  const deepgramModel = String(voice.sttModel || '').trim() || DEFAULT_DEEPGRAM_MODEL;
  const usingDeepgramFlux = deepgramModel.startsWith('flux-');
  return {
    kind: 'media-bridge',
    engine,
    stt: createDeepgramStt(deepgramModel, env),
    tts: new cartesia.TTS({
      ...(env.CARTESIA_API_KEY ? { apiKey: String(env.CARTESIA_API_KEY) } : {}),
      model: String(voice.ttsModel || DEFAULT_CARTESIA_MODEL),
      ...(voice.cartesia_voice_id || voice.voiceId
        ? { voice: String(voice.cartesia_voice_id || voice.voiceId) }
        : {}),
      ...(Number.isFinite(Number(voice.speed)) ? { speed: Number(voice.speed) } : {}),
      ...(voice.emotion ? { emotion: voice.emotion } : {}),
    }),
    ...(usingDeepgramFlux ? { turnDetection: 'stt' } : {}),
    vad: await loadVad(vad),
  };
}
