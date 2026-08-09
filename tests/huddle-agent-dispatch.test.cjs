'use strict';

// Putting a channel's agents into the huddle's LiveKit room.
//
// The properties that matter are about FAILURE, because this runs while humans
// are already on a call: a huddle whose agent cannot join must still be a working
// human huddle, and one agent failing must not take the others with it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { dispatchVoiceAgents, voiceSettingsFor } = require('../server/huddle-agents.cjs');

const parseJsonArray = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());
const parseJsonObject = (v) => (v && typeof v === 'object' ? v : (() => { try { return JSON.parse(v || '{}'); } catch { return {}; } })());
const livekitConfig = () => ({ url: 'wss://lk.test', apiKey: 'key', apiSecret: 'secret' });
const createVoiceSessionToken = async ({ agentId }) => `agv_token_for_${agentId}`;
const silent = { log: () => {}, error: () => {} };

function fakeDb({ participants = [], agents = [] } = {}) {
  return {
    unsafe: async (sql, params = []) => {
      if (/from chat_sessions/.test(sql)) return [{ participants: JSON.stringify(participants) }];
      if (/from workspace_agents/.test(sql)) {
        const requestedIds = new Set((params[1] || []).map(String));
        return agents.filter((agent) => requestedIds.has(String(agent.id)));
      }
      return [];
    },
  };
}

const base = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  transcriptSessionId: 'transcript-1',
  targetControllerIdentity: 'user:starter',
  huddleId: 'hud-1',
  roomName: 'agensis-hud-1',
  livekitConfig,
  createVoiceSessionToken,
  parseJsonArray,
  parseJsonObject,
  baseUrl: 'https://agensis-backend.fly.dev',
  log: silent,
};

test('every agent in the channel roster is dispatched into the room', async () => {
  const calls = [];
  const result = await dispatchVoiceAgents({
    ...base,
    db: fakeDb({
      participants: ['a1', 'a2'],
      agents: [
        { id: 'a1', name: 'Claude', handle: 'claude', accent_color: '#4f46e5', enabled: true },
        { id: 'a2', name: 'Grok', handle: 'grok', enabled: true },
      ],
    }),
    dispatchClientFactory: { createDispatch: async (room, agentName, opts) => { calls.push({ room, agentName, opts }); } },
  });

  assert.deepEqual(result.dispatched, ['claude', 'grok']);
  assert.deepEqual(result.failed, []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].room, 'agensis-hud-1');

  const metadata = JSON.parse(calls[0].opts.metadata);
  assert.equal(metadata.handle, 'claude');
  assert.equal(metadata.agentId, 'a1');
  assert.equal(metadata.accentColor, '#4f46e5');
  // The worker cannot reach the workspace's tools without these, and a voice
  // agent with no tools is a talking head.
  assert.equal(metadata.mcp.url, 'https://agensis-backend.fly.dev/backend/mcp');
  assert.equal(metadata.mcp.token, 'agv_token_for_a1');
  assert.equal(metadata.transcript.url, 'https://agensis-backend.fly.dev/backend/huddles/transcript');
  assert.deepEqual(metadata.rosterAgentIds, ['a1', 'a2']);
  assert.equal(metadata.targetAgentId, 'a1');
  assert.equal(metadata.targetRevision, 0);
  assert.equal(metadata.sessionId, 'transcript-1');
  assert.equal(metadata.hostSessionId, 'sess-1');
  assert.equal(metadata.transcriptSessionId, 'transcript-1');
  assert.equal(metadata.targetControllerIdentity, 'user:starter');
  // Each agent gets its OWN credential — one leaking must not speak for another.
  assert.equal(JSON.parse(calls[1].opts.metadata).mcp.token, 'agv_token_for_a2');
});

test('the persisted object roster dispatches its agent_id into the room', async () => {
  const calls = [];
  const result = await dispatchVoiceAgents({
    ...base,
    db: fakeDb({
      participants: [{
        id: 'agent:a1', kind: 'agent', agent_id: 'a1', name: 'Claude', handle: 'claude', direct: true,
      }],
      agents: [{ id: 'a1', name: 'Claude', handle: 'claude', enabled: true }],
    }),
    dispatchClientFactory: {
      createDispatch: async (_room, _agentName, opts) => calls.push(JSON.parse(opts.metadata)),
    },
  });

  assert.deepEqual(result.dispatched, ['claude']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, 'a1');
});

test('recovery dispatches only agents missing from an existing LiveKit room dispatch', async () => {
  const calls = [];
  const result = await dispatchVoiceAgents({
    ...base,
    recoverExisting: true,
    db: fakeDb({
      participants: ['a1', 'a2'],
      agents: [
        { id: 'a1', name: 'Claude', handle: 'claude', enabled: true },
        { id: 'a2', name: 'Grok', handle: 'grok', enabled: true },
      ],
    }),
    dispatchClientFactory: {
      listDispatch: async () => [{ metadata: JSON.stringify({ agentId: 'a1' }) }],
      createDispatch: async (_room, _name, opts) => calls.push(JSON.parse(opts.metadata)),
    },
  });

  assert.deepEqual(result.alreadyDispatched, ['claude']);
  assert.deepEqual(result.dispatched, ['grok']);
  assert.deepEqual(calls.map((call) => call.agentId), ['a2']);
});

test('recovery never guesses and duplicates workers when LiveKit dispatch state is unavailable', async () => {
  const calls = [];
  const result = await dispatchVoiceAgents({
    ...base,
    recoverExisting: true,
    db: fakeDb({
      participants: ['a1'],
      agents: [{ id: 'a1', name: 'Claude', handle: 'claude', enabled: true }],
    }),
    dispatchClientFactory: {
      listDispatch: async () => { throw new Error('dispatch lookup unavailable'); },
      createDispatch: async (...args) => calls.push(args),
    },
  });

  assert.equal(result.skipped, 'dispatch-state-unavailable');
  assert.equal(calls.length, 0);
});


test('dispatch metadata bounds persona text before it crosses LiveKit', async () => {
  const calls = [];
  await dispatchVoiceAgents({
    ...base,
    db: fakeDb({
      participants: ['a1'],
      agents: [{
        id: 'a1', name: `Name\n${'x'.repeat(500)}`, handle: `handle\n${'y'.repeat(500)}`,
        soul: 's'.repeat(20_000), instructions: 'i'.repeat(20_000), enabled: true,
      }],
    }),
    dispatchClientFactory: { createDispatch: async (_room, _name, opts) => calls.push(JSON.parse(opts.metadata)) },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].name.length <= 128);
  assert.ok(calls[0].handle.length <= 128);
  assert.ok(calls[0].soul.length <= 2_800);
  assert.ok(calls[0].instructions.length <= 2_800);
  assert.doesNotMatch(calls[0].name, /[\r\n]/);
  assert.doesNotMatch(calls[0].handle, /[\r\n]/);
});

test('agent dispatch fails closed when the Fly callback URL is missing or malformed', async () => {
  for (const baseUrl of ['', 'https://', 'https://\n']) {
    const calls = [];
    const result = await dispatchVoiceAgents({
      ...base,
      baseUrl,
      db: fakeDb({
        participants: ['a1'],
        agents: [{ id: 'a1', handle: 'claude', enabled: true }],
      }),
      dispatchClientFactory: { createDispatch: async (...args) => calls.push(args) },
    });
    assert.equal(result.skipped, 'voice-backend-url-not-configured');
    assert.equal(calls.length, 0);
  }
});

test('one agent failing does not stop the others, and never throws', async () => {
  const result = await dispatchVoiceAgents({
    ...base,
    db: fakeDb({
      participants: ['a1', 'a2', 'a3'],
      agents: [
        { id: 'a1', handle: 'claude', enabled: true },
        { id: 'a2', handle: 'grok', enabled: true },
        { id: 'a3', handle: 'hermes', enabled: true },
      ],
    }),
    dispatchClientFactory: {
      createDispatch: async (_room, _name, opts) => {
        if (JSON.parse(opts.metadata).handle === 'grok') throw new Error('agent service unreachable');
      },
    },
  });

  assert.deepEqual(result.dispatched, ['claude', 'hermes'], 'the healthy agents still joined');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].handle, 'grok');
});

test('a huddle with no LiveKit, no room or no agents is skipped, not failed', async () => {
  const db = fakeDb({ participants: [], agents: [] });
  const noop = { createDispatch: async () => { throw new Error('must not be called'); } };

  assert.equal((await dispatchVoiceAgents({ ...base, db, dispatchClientFactory: noop })).skipped, 'no-agents');
  assert.equal((await dispatchVoiceAgents({ ...base, db, roomName: '', dispatchClientFactory: noop })).skipped, 'no-room');
  assert.equal(
    (await dispatchVoiceAgents({ ...base, db, livekitConfig: () => ({}), dispatchClientFactory: noop })).skipped,
    'livekit-not-configured',
    'a deployment without LiveKit still has to serve human huddles',
  );
});

test('a disabled agent is never given a voice', async () => {
  const calls = [];
  const result = await dispatchVoiceAgents({
    ...base,
    db: fakeDb({
      participants: ['a1', 'a2'],
      agents: [
        { id: 'a1', handle: 'claude', enabled: true },
        { id: 'a2', handle: 'retired', enabled: false },
      ],
    }),
    dispatchClientFactory: { createDispatch: async (r, n, o) => calls.push(JSON.parse(o.metadata).handle) },
  });
  assert.deepEqual(result.dispatched, ['claude']);
  assert.deepEqual(calls, ['claude']);
});


test('external connector agents are not impersonated by the voice worker', async () => {
  const calls = [];
  const result = await dispatchVoiceAgents({
    ...base,
    db: fakeDb({
      participants: ['a1', 'a2'],
      agents: [
        { id: 'a1', handle: 'relay', run_mode: 'daemon', enabled: true },
        { id: 'a2', handle: 'connector', run_mode: 'external', enabled: true },
      ],
    }),
    dispatchClientFactory: { createDispatch: async (_room, _name, opts) => calls.push(JSON.parse(opts.metadata).handle) },
  });
  assert.deepEqual(result.dispatched, ['relay']);
  assert.deepEqual(calls, ['relay']);
});

test('per-agent voice settings survive into the dispatch metadata', () => {
  const settings = voiceSettingsFor({
    identity: JSON.stringify({ voice: { cartesia_voice_id: 'v-123', speed: 1.1, emotion: 'calm' } }),
    metadata: JSON.stringify({ voice_engine: 'openai-realtime' }),
  }, parseJsonObject);

  assert.equal(settings.engine, 'openai-realtime');
  assert.equal(settings.cartesia_voice_id, 'v-123', 'an agent that had a voice keeps it across this migration');
  assert.equal(settings.speed, 1.1);
  assert.equal(settings.emotion, 'calm');
});

test('agents without an engine use the Cartesia and Deepgram LiveKit pipeline', () => {
  const settings = voiceSettingsFor({ identity: '{}', metadata: '{}' }, parseJsonObject);
  assert.equal(settings.engine, 'cartesia-deepgram');
});
