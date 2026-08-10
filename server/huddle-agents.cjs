'use strict';

// Put this channel's agents into the huddle's LiveKit room.
//
// A huddle used to be LiveKit for humans and a browser side-channel for agents:
// a second getUserMedia feeding Deepgram, and TTS played straight to the local
// speakers. The agent's voice never entered the room, so nobody else on the call
// could hear it, LiveKit's echo cancellation could not cancel it, and barge-in
// was impossible because capture had to be muted during playback.
//
// Dispatch makes an agent a real participant. LiveKit spawns the worker
// (voice-worker/) into the room and hands it the metadata below; from there the
// agent publishes microphone audio/data, reads and writes room chat, and
// holds this workspace's MCP tools. The browser roster renders its stored
// identity; the worker does not publish a camera track.
//
// Everything here is best-effort by design: a huddle that cannot reach LiveKit's
// agent service must still be a working human call. A silent agent is a
// degradation; a failed join is an outage.

const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || 'agensis-voice';
const MAX_VOICE_METADATA_ID_CHARS = 128;
const MAX_VOICE_METADATA_PERSONA_CHARS = 2_800;

function boundedVoiceText(value, max = MAX_VOICE_METADATA_PERSONA_CHARS, singleLine = false) {
  let text = String(value ?? '');
  if (singleLine) text = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const marker = singleLine ? ' … [voice metadata truncated]' : '\n… [voice metadata truncated]';
  return text.length > max ? `${text.slice(0, Math.max(0, max - marker.length))}${marker}` : text;
}

function boundedVoiceId(value, fallback = '') {
  const text = boundedVoiceText(value || fallback, MAX_VOICE_METADATA_ID_CHARS, true);
  return text.replace(/[<>]/g, '');
}

function isVoiceCapableRunMode(value) {
  const mode = String(value || '').trim();
  // Empty is the historical/builtin default. Connectors and sandbox
  // provisioners have no local LiveKit worker to impersonate.
  return !mode || mode === 'builtin' || mode === 'daemon';
}

function isVoiceBackendUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/** Lazily required so a deployment without the SDK still serves human huddles. */
function loadAgentDispatchClient() {
  // eslint-disable-next-line global-require
  return require('livekit-server-sdk').AgentDispatchClient;
}

/** The canonical agent id carried by a persisted participant roster entry. */
function participantAgentId(participant) {
  if (typeof participant === 'string') return participant.trim().replace(/^agent:/, '');
  if (!participant || typeof participant !== 'object' || participant.kind !== 'agent') return '';
  return String(participant.agent_id || participant.id || '').trim().replace(/^agent:/, '');
}

/**
 * The agents that belong in this huddle: the channel's own agent participants.
 *
 * `chat_sessions.participants` is the roster the app already shows, so a huddle
 * is attended by exactly the agents the channel is attended by — there is no
 * second, separately-maintained voice roster to fall out of step.
 */
async function agentsForSession({ db, workspaceId, sessionId, parseJsonArray }) {
  const sessions = await db.unsafe(
    'select participants from chat_sessions where id = $1 and workspace_id = $2 and deleted_at is null limit 1',
    [sessionId, workspaceId],
  );
  const ids = (parseJsonArray(sessions[0]?.participants) || [])
    .map(participantAgentId)
    .filter(Boolean);
  if (!ids.length) return [];
  const rows = await db.unsafe(
    `select id, name, handle, accent_color, avatar, soul, instructions, system_prompt, identity, metadata, enabled, run_mode
       from workspace_agents
      where workspace_id = $1 and id = any($2::uuid[])`,
    [workspaceId, ids],
  );
  const order = new Map(ids.map((id, index) => [String(id), index]));
  return rows.filter((row) => row.enabled !== false && isVoiceCapableRunMode(row.run_mode)).sort((a, b) =>
    (order.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER) - (order.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER));
}

/** The per-agent voice settings the app already stores, plus the chosen engine. */
function voiceSettingsFor(agent, parseJsonObject) {
  const identity = parseJsonObject(agent.identity) || {};
  const voice = parseJsonObject(identity.voice) || identity.voice || {};
  return {
    // The LiveKit worker is the agent's media bridge, not a second model. Old
    // `openai-realtime` metadata from the aborted implementation is ignored so
    // it cannot strand an otherwise valid agent on an unavailable engine.
    engine: 'cartesia-deepgram',
    cartesia_voice_id: boundedVoiceId(voice.cartesia_voice_id || voice.voiceId),
    speed: voice.speed,
    emotion: boundedVoiceText(voice.emotion, 128, true),
  };
}

/**
 * Dispatch every agent in the channel into the huddle's room.
 *
 * @returns {Promise<{ dispatched: string[], alreadyDispatched?: string[], failed: Array<{ handle: string, error: string }>, skipped?: string }>}
 */
async function dispatchVoiceAgents({
  db,
  workspaceId,
  sessionId,
  transcriptSessionId = sessionId,
  targetControllerIdentity = '',
  huddleId,
  roomName,
  livekitConfig,
  createVoiceSessionToken,
  parseJsonArray,
  parseJsonObject,
  baseUrl = '',
  agentName = AGENT_NAME,
  dispatchClientFactory = null,
  recoverExisting = false,
  log = console,
} = {}) {
  const { url, apiKey, apiSecret } = livekitConfig();
  if (!url || !apiKey || !apiSecret) return { dispatched: [], failed: [], skipped: 'livekit-not-configured' };
  if (!roomName) return { dispatched: [], failed: [], skipped: 'no-room' };
  // The worker must have a reachable Fly callback origin for both its
  // huddle-scoped MCP token and transcript writer. Do not dispatch a worker
  // with null/Netlify callback URLs; humans can still use the room.
  if (!isVoiceBackendUrl(baseUrl)) {
   return { dispatched: [], failed: [], skipped: 'voice-backend-url-not-configured' };
  }

  let agents;
  try {
    agents = await agentsForSession({ db, workspaceId, sessionId, parseJsonArray });
  } catch (error) {
    log.error?.(`[huddle] could not read the agent roster: ${error?.message || error}`);
    return { dispatched: [], failed: [], skipped: 'roster-unavailable' };
  }
  if (!agents.length) return { dispatched: [], failed: [], skipped: 'no-agents' };

  let client;
  try {
    const Client = dispatchClientFactory || loadAgentDispatchClient();
    // Browser room tokens use wss://, but AgentDispatchClient speaks the
    // HTTPS management API. Keep the original URL in the client response; only
    // the server-side dispatch host is normalized here.
    const dispatchUrl = String(url).replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    client = typeof Client === 'function' && Client.prototype?.createDispatch
      ? new Client(dispatchUrl, apiKey, apiSecret)
      : Client;
  } catch (error) {
    log.error?.(`[huddle] livekit-server-sdk has no agent dispatch: ${error?.message || error}`);
    return { dispatched: [], failed: [], skipped: 'no-dispatch-client' };
  }

  const existingAgentIds = new Set();
  if (recoverExisting) {
    // Rejoining an active huddle is also its repair path. Reconcile with
    // LiveKit's durable dispatch records first: a room whose original dispatch
    // never happened gets its workers, while an already-running room never gets
    // a duplicate copy of each agent.
    if (typeof client.listDispatch !== 'function') {
      return { dispatched: [], failed: [], skipped: 'dispatch-state-unavailable' };
    }
    try {
      const existing = await client.listDispatch(roomName);
      for (const dispatch of existing || []) {
        if (dispatch?.agentName && dispatch.agentName !== agentName) continue;
        const metadata = parseJsonObject(dispatch?.metadata) || {};
        const agentId = String(metadata.agentId || '').trim();
        if (agentId) existingAgentIds.add(agentId);
      }
    } catch (error) {
      // Creating blindly after a failed lookup can put two workers for the same
      // agent into one room. Wait for the next join/retry instead.
      log.error?.(`[huddle] could not reconcile agent dispatches for ${roomName}: ${error?.message || error}`);
      return { dispatched: [], failed: [], skipped: 'dispatch-state-unavailable' };
    }
  }

  const dispatched = [];
  const alreadyDispatched = [];
  const failed = [];
  // Sequential on purpose: LiveKit's agent service is the shared resource here,
  // and a channel with a dozen agents should not open a dozen sockets at once.
  for (const agent of agents) {
    const handle = boundedVoiceId(agent.handle || agent.name || String(agent.id), String(agent.id));
    if (existingAgentIds.has(String(agent.id))) {
      alreadyDispatched.push(handle);
      continue;
    }
    try {
      // Scoped to THIS agent and expiring on its own — see createVoiceSessionToken.
      const mcpToken = await createVoiceSessionToken({
       workspaceId,
       agentId: agent.id,
       huddleId,
       sessionId: transcriptSessionId || sessionId,
      });
      const metadata = JSON.stringify({
        workspaceId,
        // MCP read_channel and transcript writes belong to the huddle's own
        // inherited session. Keep the host separately for roster lookup and
        // authorization/debugging.
        sessionId: transcriptSessionId || sessionId,
        hostSessionId: sessionId,
        transcriptSessionId: transcriptSessionId || sessionId,
        huddleId,
        agentId: agent.id,
        handle,
        name: boundedVoiceId(agent.name || handle, handle),
        accentColor: boundedVoiceId(agent.accent_color),
        soul: boundedVoiceText(agent.soul),
        instructions: boundedVoiceText(agent.instructions || agent.system_prompt),
        voice: voiceSettingsFor(agent, parseJsonObject),
        mcp: baseUrl ? { url: `${baseUrl.replace(/\/$/, '')}/backend/mcp`, token: mcpToken } : null,
        transcript: baseUrl ? { url: `${baseUrl.replace(/\/$/, '')}/backend/huddles/transcript`, token: mcpToken } : null,
        rosterAgentIds: agents.map((rosterAgent) => String(rosterAgent.id)),
        targetControllerIdentity: String(targetControllerIdentity || ''),
        targetAgentId: agents[0]?.id || null,
        targetRevision: 0,
      });
      await client.createDispatch(roomName, agentName, { metadata });
      dispatched.push(handle);
    } catch (error) {
      // One agent failing to join must not stop the rest, and must not fail the
      // huddle — the humans are already in the room.
      const message = error?.message || String(error);
      failed.push({ handle, error: message });
      log.error?.(`[huddle] @${handle} could not join ${roomName}: ${message}`);
    }
  }

  if (dispatched.length) log.log?.(`[huddle] dispatched ${dispatched.map((h) => `@${h}`).join(', ')} into ${roomName}`);
  return { dispatched, alreadyDispatched, failed };
}

module.exports = {
  AGENT_NAME,
  agentsForSession,
  dispatchVoiceAgents,
  isVoiceCapableRunMode,
  participantAgentId,
  voiceSettingsFor,
};
