// The agensis voice worker: an agent that joins a huddle as a real LiveKit
// participant.
//
// Before this, a huddle was LiveKit for humans and a browser side-channel for
// agents — a SECOND getUserMedia feeding Deepgram, and Cartesia audio played
// straight to the local speakers. That meant the agent's voice never entered the
// room (so other humans could not hear it), LiveKit's echo cancellation could not
// cancel it (so capture had to be muted during playback, making barge-in
// impossible), and the VAD LiveKit already runs was listening to the wrong
// stream.
//
// Here the agent is a participant: it subscribes to room audio, publishes its own
// audio track, publishes a held identity image as video, sends and receives chat
// on the room's text stream, and holds the workspace's MCP tools. Humans and
// agents are the same kind of thing on the same transport.

import { Agent, AgentSession, JobContext, ServerOptions, cli, defineAgent } from '@livekit/agents';
import { buildEngine, loadVad, resolveEngine } from './providers.mjs';
import { loadMcpTools } from './mcpTools.mjs';
import { publishAvatarVideo } from './avatarVideo.mjs';
import { mirrorTranscript } from './transcript.mjs';

/**
 * Everything the server tells us about the agent we are being asked to be.
 * Sent as the dispatch metadata JSON (server/huddles.cjs dispatchVoiceAgent).
 */
function readJobMetadata(ctx) {
  const raw = String(ctx.job?.metadata || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** The system prompt the agent speaks under. */
function buildInstructions(meta, engine) {
  const name = meta.name || meta.handle || 'Agent';
  const lines = [
    `You are ${name} (@${meta.handle || 'agent'}), a member of this agensis workspace, speaking in a live huddle.`,
    'You are on a voice call. Keep replies short and speakable — a sentence or two unless asked for detail. Never read out markdown, code fences, URLs or long lists; say what they mean instead and put detail in the channel with post_message.',
    'You can be interrupted. If someone starts talking, stop immediately and listen.',
  ];
  if (meta.instructions) lines.push(String(meta.instructions));
  if (meta.soul) lines.push(`How you carry yourself:\n${meta.soul}`);
  // The whole point of the fast voice model: answer now, delegate the real work.
  lines.push(
    'You hold this workspace\'s tools. Use them rather than guessing: read_doc / search_docs to look things up, post_message to write to a channel, create_task to capture work.',
    'For anything that needs real work — writing code, long research, editing files — say briefly that you are handing it over and call dispatch_agent to give it to the agent that should do it. Do not try to do that work out loud yourself.',
  );
  if (engine) lines.push(`(Voice engine: ${engine}.)`);
  return lines.join('\n\n');
}

export default defineAgent({
  // Loading Silero once per PROCESS rather than per job — the model load is the
  // slow part and it carries no per-session state, so a warm worker answers its
  // first turn without paying for it.
  prewarm: async (proc) => {
    try {
      proc.userData.vad = await loadVad();
    } catch (error) {
      // A worker with no VAD can still run realtime engines, which detect turns
      // server-side. Fail the job later, not the whole worker now.
      console.error(`[voice] Silero prewarm failed: ${error?.message || error}`);
    }
  },

  entry: async (ctx) => {
    const meta = readJobMetadata(ctx);
    const log = console;

    const { engine, fellBack, missing, requested, available } = resolveEngine(meta.voice?.engine || meta.engine);
    if (!engine) {
      // No usable engine is a configuration fault, and a silent no-show is the
      // worst possible symptom. Say it where an operator will see it and stop.
      log.error(`[voice] no voice engine available on this worker (needs one of: ${Object.keys(available || {}).length ? available.join(', ') : 'OPENAI_API_KEY, or CARTESIA_API_KEY + DEEPGRAM_API_KEY'})`);
      throw new Error('No voice engine configured');
    }
    if (fellBack) {
      log.error(`[voice] engine "${requested}" unavailable${missing?.length ? ` (missing ${missing.join(', ')})` : ''}; using "${engine}"`);
    }

    const [built, tools] = await Promise.all([
      buildEngine({ engine, voice: meta.voice || {}, vad: ctx.proc?.userData?.vad || null }),
      loadMcpTools({ url: meta.mcp?.url, token: meta.mcp?.token, log }),
    ]);

    const agent = new Agent({
      instructions: buildInstructions(meta, engine),
      tools,
    });

    const session = new AgentSession({
      ...(built.llm ? { llm: built.llm } : {}),
      ...(built.stt ? { stt: built.stt } : {}),
      ...(built.tts ? { tts: built.tts } : {}),
      ...(built.vad ? { vad: built.vad } : {}),
    });

    // Connect BEFORE publishing anything: the local participant does not exist
    // until the room is joined.
    await ctx.connect();

    // Say WHO this participant is. LiveKit assigns the worker an opaque identity,
    // so without this the app sees an anonymous participant and cannot match it
    // to the agent — which is the whole difference between "an agent is in the
    // call" and "someone unknown is in the call".
    await ctx.room.localParticipant.setAttributes({
      'agensis.kind': 'agent',
      'agensis.agentId': String(meta.agentId || ''),
      'agensis.handle': String(meta.handle || ''),
      'agensis.name': String(meta.name || meta.handle || 'Agent'),
      'agensis.accentColor': String(meta.accentColor || ''),
      'agensis.engine': engine,
    }).catch((error) => {
      log.error(`[voice] could not publish agent attributes: ${error?.message || error}`);
    });

    // The held identity image. Published as a real camera-source track so the
    // agent occupies a tile in the grid like any other participant.
    const avatar = await publishAvatarVideo(ctx.room, {
      name: meta.name,
      handle: meta.handle,
      color: meta.accentColor || meta.accent_color,
      log,
    }).catch((error) => {
      // A missing tile is cosmetic; losing the voice over it would not be.
      log.error(`[voice] avatar video failed: ${error?.message || error}`);
      return null;
    });

    // Everything the agent hears and says also belongs in the channel transcript,
    // so the huddle and the written channel remain one conversation rather than
    // two records of the same meeting.
    const transcript = mirrorTranscript({ session, meta, log });

    ctx.addShutdownCallback(async () => {
      transcript.stop();
      await avatar?.stop();
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        // Chat in the huddle reaches the agent as text on the room's stream —
        // the same conversation, typed instead of spoken.
        textEnabled: true,
        audioEnabled: true,
        // Humans publish a camera; let the agent actually see it.
        videoEnabled: true,
        closeOnDisconnect: false,
      },
      outputOptions: {
        audioEnabled: true,
        // Publishing transcription means every client renders what the agent
        // said, in sync with the audio, without us shipping our own captions.
        transcriptionEnabled: true,
        syncTranscription: true,
      },
    });

    log.log(`[voice] @${meta.handle || 'agent'} joined ${ctx.room.name} on ${engine} with ${Object.keys(tools).length} tools`);

    if (meta.greeting !== false) {
      session.generateReply({ instructions: 'Greet the room in one short sentence and stop. Do not list your capabilities.' });
    }
  },
});

// `cli.runApp` is the worker's own process entry: it registers with LiveKit and
// waits to be dispatched into rooms. agentName makes dispatch EXPLICIT — without
// it LiveKit would push this worker into every room in the project, including
// huddles that never asked for an agent.
if (import.meta.url === `file://${process.argv[1]}`) {
  cli.runApp(new ServerOptions({
    agent: import.meta.filename,
    agentName: process.env.LIVEKIT_AGENT_NAME || 'agensis-voice',
  }));
}

export { JobContext };
