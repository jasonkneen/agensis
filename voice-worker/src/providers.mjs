// Voice provider seam for the LiveKit agent worker.
//
// Everything about WHICH vendor speaks, listens or thinks lives here and nowhere
// else. The old browser pipeline hard-coded the provider name in five separate
// layers — capability probe, engine chooser, two closed TypeScript unions, and a
// hook-per-engine if-ladder — so adding a vendor meant touching all five. Here a
// vendor is one entry in one table.
//
// Two shapes of session exist, and they are genuinely different, not two configs
// of one thing:
//
//   REALTIME  — one speech-to-speech model owns hearing, thinking and speaking
//               (gpt-realtime-2.1-mini). Lowest latency, server-side VAD, and it
//               can call tools mid-conversation. This is the "fast voice that
//               hands real work to another agent" shape.
//
//   PIPELINE  — STT -> LLM -> TTS as three independent vendors, with Silero VAD
//               and turn detection in front. Slower, but every stage is swappable
//               and the transcript is exact.
//
// Both get the same tools and the same interruption behaviour; the caller does
// not branch on which one it built.

import * as openai from '@livekit/agents-plugin-openai';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as silero from '@livekit/agents-plugin-silero';

/** Default speech-to-speech model. Fast enough to hold a turn without filler. */
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1-mini';
/** Cartesia's current low-latency voice model. */
export const DEFAULT_CARTESIA_MODEL = 'sonic-3.5';
/** Deepgram's streaming turn-aware model, matching the previous browser pipeline. */
export const DEFAULT_DEEPGRAM_MODEL = 'flux-general-en';
/** Text model for pipeline mode, when the turn is not owned by a realtime model. */
export const DEFAULT_PIPELINE_LLM = 'gpt-5.4-mini';
/**
 * Baseline voice transport for every agent that has not explicitly selected an
 * engine. Deepgram owns STT and Cartesia owns TTS inside the LiveKit worker.
 */
export const DEFAULT_VOICE_ENGINE = 'cartesia-deepgram';
/**
 * A short jitter cushion prevents bursty provider frames from overrunning the
 * LiveKit AudioSource's ring buffer. Interruptions clear this queue, so it does
 * not make a handoff or barge-in wait longer.
 */
export const VOICE_OUTPUT_QUEUE_SIZE_MS = 2_000;

/**
 * Deepgram Flux is not a V1 model. It requires Deepgram's turn-aware
 * `/v2/listen` websocket, exposed by LiveKit as `STTv2`. Nova and the older
 * models remain on the ordinary `/v1/listen` `STT` class.
 */
export function createDeepgramStt(model = DEFAULT_DEEPGRAM_MODEL, env = process.env) {
  const name = String(model || '').trim() || DEFAULT_DEEPGRAM_MODEL;
  const apiKey = String(env.DEEPGRAM_API_KEY || '').trim();
  const options = {
    model: name,
    ...(apiKey ? { apiKey } : {}),
  };
  return name.startsWith('flux-')
    ? new deepgram.STTv2(options)
    : new deepgram.STT(options);
}

/** Realtime reasoning has no `none` level; minimal is its lowest supported effort. */
export function realtimeReasoningFor(model) {
  // The plugin's wire gate is case-sensitive too. Keep this canonical rather
  // than claiming a reasoning option for an alias the SDK will silently omit.
  return /^gpt-realtime-2(?:[.-]|$)/.test(String(model || '').trim())
    ? { effort: 'minimal' }
    : undefined;
}

/**
 * OpenAI's pipeline helper owns the model matrix. In particular, gpt-5 and
 * gpt-5-mini default to `minimal`, while gpt-5.1+ models may default to `none`.
 * Repeating that list here would drift from the SDK and can send an invalid
 * value when AGENSIS_VOICE_LLM overrides the default.
 */
export function pipelineReasoningEffortFor(model) {
  const name = String(model || '').trim();
  if (!name || !openai.supportsReasoningEffort(name)) return undefined;
  return typeof openai.defaultReasoningEffort === 'function'
    ? openai.defaultReasoningEffort(name)
    : undefined;
}

/**
 * Engines a workspace can ask for. The id is what a human picks in the app and
 * what is stored on the agent row, so it is a stable wire value, not a label.
 */
export const VOICE_ENGINES = Object.freeze({
  'openai-realtime': { kind: 'realtime', label: 'OpenAI Realtime', needs: ['OPENAI_API_KEY'] },
  'cartesia-deepgram': { kind: 'pipeline', label: 'Cartesia + Deepgram', needs: ['CARTESIA_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_API_KEY'] },
  'openai-pipeline': { kind: 'pipeline', label: 'OpenAI (STT/TTS)', needs: ['OPENAI_API_KEY'] },
});

/** Which engines this host can actually run, given the keys it holds. */
export function availableEngines(env = process.env) {
  return Object.entries(VOICE_ENGINES)
    .filter(([, spec]) => spec.needs.every((key) => String(env[key] || '').trim()))
    .map(([id]) => id);
}

/**
 * Pick the engine for a job.
 *
 * An explicit request wins, but only if this host holds its keys. Empty agent
 * configuration means the baseline Cartesia/Deepgram pipeline. An unavailable
 * or unknown engine fails closed: selecting another vendor by insertion order
 * can silently turn the baseline pipeline into OpenAI Realtime.
 */
export function resolveEngine(requested, env = process.env) {
  const available = availableEngines(env);
  const configured = String(requested || '').trim();
  const want = configured || DEFAULT_VOICE_ENGINE;
  const usedDefault = !configured;
  if (available.includes(want)) {
    return { engine: want, fellBack: false, requested: want, usedDefault, available };
  }
  if (VOICE_ENGINES[want]) {
    const missing = VOICE_ENGINES[want].needs.filter((k) => !String(env[k] || '').trim());
    return { engine: '', fellBack: false, missing, requested: want, usedDefault, available };
  }
  return { engine: '', fellBack: false, requested: want, usedDefault, unknown: true, available };
}

/**
 * Silero VAD. Loaded once per worker process and shared by every job, because
 * the model load is the expensive part and it holds no per-session state.
 *
 * This is the VAD the pipeline path uses for barge-in. Realtime mode does its own
 * server-side detection and does not take this.
 */
let vadPromise = null;
export function loadVad(prewarmed = null) {
  if (prewarmed) return Promise.resolve(prewarmed);
  if (!vadPromise) vadPromise = silero.VAD.load();
  return vadPromise;
}

/**
 * Build the pieces an AgentSession needs for `engine`.
 *
 * Returns { llm, stt, tts, vad, turnDetection } with only the fields that engine
 * uses — a realtime model owns the whole turn, so passing an stt/tts alongside it
 * would silently fight it.
 *
 * @param {object} opts
 * @param {string} opts.engine
 * @param {object} [opts.voice]  per-agent voice settings from the agent row
 * @param {object} [opts.vad]    a prewarmed Silero VAD
 */
export async function buildEngine({ engine, voice = {}, vad = null, env = process.env } = {}) {
  const spec = VOICE_ENGINES[engine];
  if (!spec) throw new Error(`Unknown voice engine "${engine}"`);

  if (spec.kind === 'realtime') {
    // One model hears, thinks and speaks. `turnDetection` is server-side, so no
    // Silero and no separate endpointing — asking for both is how you get an
    // agent that interrupts itself.
    const model = String(voice.realtimeModel || env.AGENSIS_REALTIME_MODEL || DEFAULT_REALTIME_MODEL);
    const reasoning = realtimeReasoningFor(model);
    return {
      kind: 'realtime',
      engine,
      llm: new openai.realtime.RealtimeModel({
        model,
        ...(reasoning ? { reasoning } : {}),
        ...(voice.realtimeVoice ? { voice: String(voice.realtimeVoice) } : {}),
        ...(Number.isFinite(Number(voice.temperature)) ? { temperature: Number(voice.temperature) } : {}),
      }),
    };
  }

  // Pipeline: three vendors plus VAD. Each is independently swappable.
  const deepgramModel = String(voice.sttModel || '').trim() || DEFAULT_DEEPGRAM_MODEL;
  const usingDeepgramFlux = engine === 'cartesia-deepgram' && deepgramModel.startsWith('flux-');
  const stt = engine === 'cartesia-deepgram'
    ? createDeepgramStt(deepgramModel, env)
    : new openai.STT();

  const tts = engine === 'cartesia-deepgram'
    ? new cartesia.TTS({
      ...(env.CARTESIA_API_KEY ? { apiKey: String(env.CARTESIA_API_KEY) } : {}),
      model: String(voice.ttsModel || DEFAULT_CARTESIA_MODEL),
      // The per-agent voice the app already stores. Keeping the same field names
      // means an agent that had a voice keeps it across this migration.
      ...(voice.cartesia_voice_id || voice.voiceId ? { voice: String(voice.cartesia_voice_id || voice.voiceId) } : {}),
      ...(Number.isFinite(Number(voice.speed)) ? { speed: Number(voice.speed) } : {}),
      ...(voice.emotion ? { emotion: voice.emotion } : {}),
    })
    : new openai.TTS({ ...(voice.voiceId ? { voice: String(voice.voiceId) } : {}) });

  const llmModel = String(voice.llmModel || env.AGENSIS_VOICE_LLM || DEFAULT_PIPELINE_LLM);
  const reasoningEffort = pipelineReasoningEffortFor(llmModel);
  return {
    kind: 'pipeline',
    engine,
    stt,
    tts,
    ...(usingDeepgramFlux ? { turnDetection: 'stt' } : {}),
    llm: new openai.LLM({
      ...(env.OPENAI_API_KEY ? { apiKey: String(env.OPENAI_API_KEY) } : {}),
      model: llmModel,
      // Use the plugin's model-specific default: it is `none` where supported,
      // but `minimal` for gpt-5/gpt-5-mini. Older/custom chat models omit the
      // field entirely because their API may reject reasoning_effort.
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }),
    vad: await loadVad(vad),
  };
}
