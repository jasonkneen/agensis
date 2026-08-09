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
 * A short jitter cushion prevents bursty provider frames from overrunning the
 * LiveKit AudioSource's ring buffer. Interruptions clear this queue, so it does
 * not make a handoff or barge-in wait longer.
 */
export const VOICE_OUTPUT_QUEUE_SIZE_MS = 2_000;

/** Realtime reasoning has no `none` level; minimal is its lowest supported effort. */
export function realtimeReasoningFor(model) {
  return /^gpt-realtime-2(?:[.-]|$)/i.test(String(model || '').trim())
    ? { effort: 'minimal' }
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
 * An explicit request wins, but only if this host holds its keys — silently
 * running a different vendor than the one an agent is configured for is worse
 * than saying so, and a huddle with no voice at all is worse than both.
 */
export function resolveEngine(requested, env = process.env) {
  const available = availableEngines(env);
  const want = String(requested || '').trim();
  if (want && available.includes(want)) return { engine: want, fellBack: false, available };
  if (want && VOICE_ENGINES[want]) {
    const missing = VOICE_ENGINES[want].needs.filter((k) => !String(env[k] || '').trim());
    return { engine: available[0] || '', fellBack: true, missing, requested: want, available };
  }
  return { engine: available[0] || '', fellBack: Boolean(want), requested: want, available };
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
  const stt = engine === 'cartesia-deepgram'
    ? new deepgram.STT({ model: String(voice.sttModel || DEFAULT_DEEPGRAM_MODEL) })
    : new openai.STT();

  const tts = engine === 'cartesia-deepgram'
    ? new cartesia.TTS({
      model: String(voice.ttsModel || DEFAULT_CARTESIA_MODEL),
      // The per-agent voice the app already stores. Keeping the same field names
      // means an agent that had a voice keeps it across this migration.
      ...(voice.cartesia_voice_id || voice.voiceId ? { voice: String(voice.cartesia_voice_id || voice.voiceId) } : {}),
      ...(Number.isFinite(Number(voice.speed)) ? { speed: Number(voice.speed) } : {}),
      ...(voice.emotion ? { emotion: voice.emotion } : {}),
    })
    : new openai.TTS({ ...(voice.voiceId ? { voice: String(voice.voiceId) } : {}) });

  const llmModel = String(voice.llmModel || env.AGENSIS_VOICE_LLM || DEFAULT_PIPELINE_LLM);
  return {
    kind: 'pipeline',
    engine,
    stt,
    tts,
    llm: new openai.LLM({
      model: llmModel,
      // Pipeline voice has no useful reason to spend a hidden reasoning pass.
      // Only send this field to models whose API advertises it; older/custom
      // chat models may reject reasoning_effort altogether.
      ...(openai.supportsReasoningEffort(llmModel) ? { reasoningEffort: 'none' } : {}),
    }),
    vad: await loadVad(vad),
  };
}
