// The parts of the voice worker that can be proven without a LiveKit room:
// which vendor gets chosen, what the held video frame actually contains, and
// how the MCP bridge behaves when the workspace is unreachable.

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSessionEventTypes } from '@livekit/agents';

import { availableEngines, resolveEngine, VOICE_ENGINES } from '../src/providers.mjs';
import { initialsFor, parseColor, renderAvatarFrame } from '../src/avatarVideo.mjs';
import { flattenToolResult, loadMcpTools, rpc, EXCLUDED, VOICE_LAZY_TOOL_ALLOWLIST } from '../src/mcpTools.mjs';
import { acceptsTargetPacket, decodeVoiceTarget, encodeVoiceTarget, encodeVoiceTargetRequest, isVoiceTargetRequest, makeVoiceTarget } from '../src/voiceTarget.mjs';
import { boundChatContext, MAX_VOICE_CONTEXT_BYTES, MAX_VOICE_RESULT_CHARS, VOICE_RESULT_TRUNCATION_MARKER } from '../src/voiceBounds.mjs';
import { mirrorTranscript, transcriptEventId } from '../src/transcript.mjs';

const FULL_ENV = { OPENAI_API_KEY: 'k', CARTESIA_API_KEY: 'k', DEEPGRAM_API_KEY: 'k' };

test('an engine is only offered when this host holds its keys', () => {
  assert.deepEqual(availableEngines({}), [], 'no keys means no voice, stated plainly');
  assert.deepEqual(availableEngines({ OPENAI_API_KEY: 'k' }), ['openai-realtime', 'openai-pipeline']);
  assert.ok(availableEngines(FULL_ENV).includes('cartesia-deepgram'));
});

test('a requested engine wins, but only if its keys are present', () => {
  const ok = resolveEngine('cartesia-deepgram', FULL_ENV);
  assert.equal(ok.engine, 'cartesia-deepgram');
  assert.equal(ok.fellBack, false);

  // Asking for Cartesia on a host with only an OpenAI key must not silently run
  // a different vendor without saying which key is missing.
  const fallback = resolveEngine('cartesia-deepgram', { OPENAI_API_KEY: 'k' });
  assert.equal(fallback.fellBack, true);
  assert.equal(fallback.requested, 'cartesia-deepgram');
  assert.deepEqual(fallback.missing, ['CARTESIA_API_KEY', 'DEEPGRAM_API_KEY']);
  assert.ok(fallback.engine, 'a working fallback beats a silent huddle');

  // Nothing configured at all: report it rather than pretending.
  assert.equal(resolveEngine('openai-realtime', {}).engine, '');
});

test('realtime and pipeline are different SHAPES, not two configs of one thing', () => {
  assert.equal(VOICE_ENGINES['openai-realtime'].kind, 'realtime');
  assert.equal(VOICE_ENGINES['cartesia-deepgram'].kind, 'pipeline');
});

test('the held video frame is a real image with the agent\'s initials on its colour', () => {
  const width = 64;
  const height = 48;
  const frame = renderAvatarFrame({ name: 'Claude', handle: 'claude', color: '#4f46e5', width, height });

  assert.equal(frame.data.length, width * height * 4, 'RGBA, one byte per channel');
  // Corner is background; something in the middle must be foreground, or the
  // "held image" is a blank rectangle and nobody can tell who is on the call.
  assert.deepEqual([...frame.data.slice(0, 3)], [79, 70, 229], 'the agent accent colour');
  const pixels = [];
  for (let i = 0; i < width * height; i += 1) {
    pixels.push(`${frame.data[i * 4]},${frame.data[i * 4 + 1]},${frame.data[i * 4 + 2]}`);
  }
  assert.ok(new Set(pixels).size >= 2, 'the initials must actually be drawn');
  assert.ok(frame.data.every((_, i) => i % 4 !== 3 || frame.data[i] === 255), 'fully opaque');
});

test('initials follow the app\'s avatar convention', () => {
  assert.equal(initialsFor('God Emperor Jason'), 'GE');
  assert.equal(initialsFor('Claude'), 'CL');
  assert.equal(initialsFor('', 'grok'), 'GR');
  assert.equal(initialsFor(''), '?', 'never render an empty tile');
});

test('text stays readable on both light and dark accent colours', () => {
  const dark = renderAvatarFrame({ name: 'AA', color: '#111827', width: 32, height: 32 });
  const light = renderAvatarFrame({ name: 'AA', color: '#fde68a', width: 32, height: 32 });
  const has = (frame, rgb) => {
    for (let i = 0; i < frame.width * frame.height; i += 1) {
      if (frame.data[i * 4] === rgb[0] && frame.data[i * 4 + 1] === rgb[1] && frame.data[i * 4 + 2] === rgb[2]) return true;
    }
    return false;
  };
  assert.ok(has(dark, [255, 255, 255]), 'white initials on a dark tile');
  assert.ok(has(light, [17, 24, 39]), 'near-black initials on a light tile');
  assert.deepEqual(parseColor('not-a-colour'), [71, 85, 105], 'an unusable colour falls back, never throws');
});

test('MCP catalog is deferred: an unreachable endpoint does not delay the bootstrap', async () => {
  const tools = loadMcpTools({
    url: 'https://example.invalid/backend/mcp',
    token: 'agv_x',
    sessionId: 'huddle-session',
    log: { error: () => {}, log: () => {} },
  });
  assert.deepEqual(Object.keys(tools).sort(), ['load_context', 'load_skill', 'load_tools']);
  const result = await tools.load_context.execute({});
  assert.match(result, /voice result unavailable/);
  assert.deepEqual(loadMcpTools({ url: '' }), {}, 'no endpoint configured is not an error');
});

test('progressive MCP rejects non-string tool names before network access', async () => {
  let calls = 0;
  const tools = loadMcpTools({
    url: 'https://agensis.test/backend/mcp',
    sessionId: 'session-1',
    fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); },
    log: { log: () => {}, error: () => {} },
  });
  for (const names of [[null], [true], [42]]) {
    const result = await tools.load_tools.execute({ names });
    assert.match(result, /voice result unavailable/);
  }
  assert.equal(calls, 0);
});

test('an already-aborted MCP caller signal aborts before fetch', async () => {
  const signal = AbortSignal.abort();
  let observed;
  await assert.rejects(
    () => rpc({
      url: 'https://agensis.test/backend/mcp',
      method: 'ping',
      signal,
      fetchImpl: async (_url, options) => {
        observed = options.signal.aborted;
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    }),
    /aborted/i,
  );
  assert.equal(observed, true);
});

test('progressive MCP loads are authorized, named, and deferred', async () => {
  const calls = [];
  const tools = loadMcpTools({
    url: 'https://agensis.test/backend/mcp', token: 'agv_secret', sessionId: 'session-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const request = JSON.parse(options.body);
      const result = request.method === 'tools/list'
        ? { tools: [{ name: 'read_channel', description: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, { name: 'claim_job' }] }
        : request.params?.name === 'read_channel'
          ? { content: [{ type: 'text', text: JSON.stringify({ messages: [{ content: 'needle task' }, { content: 'other task' }] }) }, { type: 'text', text: 'unrelated footer' }] }
          : request.params?.name === 'list_skills'
            ? { content: [{ type: 'text', text: JSON.stringify({ skills: [{ name: 'voice-help' }] }) }] }
            : request.params?.name === 'read_skill'
              ? { content: [{ type: 'text', text: JSON.stringify({ content: 'skill body' }) }] }
              : { content: [{ type: 'text', text: 'safe data' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
    },
    log: { log: () => {}, error: () => {} },
  });
  assert.equal(calls.length, 0, 'tools/list is not a startup dependency');
  const loaded = await tools.load_tools.execute({ names: ['read_channel'] });
  assert.match(loaded, /Loaded tools/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, 'Bearer agv_secret');
  const context = await tools.load_context.execute({ query: 'needle' });
  assert.match(context, /needle task/);
  assert.doesNotMatch(context, /other task/);
  const skill = await tools.load_skill.execute({ name: 'voice-help' });
  assert.match(skill, /skill body/);
  const tool = tools.read_channel;
  assert.equal(tool, undefined, 'the caller installs returned tools through updateTools');
});


test('fenced MCP results remain bounded after the safety header', async () => {
  const tools = loadMcpTools({
    url: 'https://agensis.test/backend/mcp', token: 'agv_secret', sessionId: 'session-1',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const result = { content: [{ type: 'text', text: JSON.stringify({ messages: [{ content: '😀'.repeat(10_000) }] }) }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
    },
    log: { log: () => {}, error: () => {} },
  });
  const output = await tools.load_context.execute({});
  assert.ok(output.length <= MAX_VOICE_RESULT_CHARS);
  assert.match(output, /Untrusted MCP/);
});

test('MCP catalog caps only after filtering the authorized voice surface', async () => {
  const noisy = Array.from({ length: 64 }, (_, index) => ({ name: `unrelated_${index}` }));
  noisy.push({ name: 'read_channel', description: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
  const tools = loadMcpTools({
    url: 'https://agensis.test/backend/mcp', token: 'agv_secret', sessionId: 'session-1',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const result = request.method === 'tools/list'
        ? { tools: noisy }
        : { content: [{ type: 'text', text: 'authorized read' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
    },
    log: { log: () => {}, error: () => {} },
  });
  assert.match(await tools.load_tools.execute({ names: ['read_channel'] }), /Loaded tools/);
});

test('MCP results flatten to something a model can say out loud', () => {
  assert.equal(flattenToolResult({ content: [{ type: 'text', text: 'two open tasks' }] }), 'two open tasks');
  assert.equal(flattenToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(flattenToolResult(null), '');
  assert.equal(flattenToolResult('plain'), 'plain');
});


test('transcript IDs include speaker attribution and unambiguous fields', () => {
  assert.notEqual(
    transcriptEventId({ huddleId: 'h1', itemId: 'item-0', role: 'user', speakerId: 'user:a', content: 'hi' }),
    transcriptEventId({ huddleId: 'h1', itemId: 'item-0', role: 'user', speakerId: 'user:b', content: 'hi' }),
  );
  assert.notEqual(
    transcriptEventId({ huddleId: 'h1|x', role: 'user', speakerId: 'a|b', content: 'c' }),
    transcriptEventId({ huddleId: 'h1', role: 'user', speakerId: 'x', content: 'a|b|c' }),
  );
});

test('assistant transcript IDs are scoped to their worker agent', () => {
  assert.notEqual(
    transcriptEventId({ huddleId: 'h1', itemId: 'item-0', role: 'assistant', agentId: 'a1', content: 'hi' }),
    transcriptEventId({ huddleId: 'h1', itemId: 'item-0', role: 'assistant', agentId: 'a2', content: 'hi' }),
  );
});

test('transcript mirroring is off, not broken, when there is nowhere to write', () => {
  const handlers = [];
  const session = { on: (e, h) => handlers.push([e, h]), off: () => {} };
  const disabled = mirrorTranscript({ session, meta: {}, log: { log: () => {}, error: () => {} } });
  assert.equal(handlers.length, 0, 'nothing subscribed');
  disabled.stop();
});

test('a failed transcript write never breaks the call', async () => {
  const handlers = new Map();
  const session = { on: (e, h) => handlers.set(e, h), off: () => handlers.clear() };
  const errors = [];
  mirrorTranscript({
    session,
    meta: { sessionId: 's1', transcript: { url: 'https://x/t', token: 't' } },
    log: { log: () => {}, error: (m) => errors.push(String(m)) },
    fetchImpl: async () => { throw new Error('network down'); },
  });

  const onUser = handlers.get('user_input_transcribed');
  assert.ok(onUser, 'the user transcript is mirrored');
  // Must not reject: the human is still mid-sentence.
  await assert.doesNotReject(async () => {
    onUser({ transcript: 'hello there', isFinal: true });
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.ok(errors.some((e) => /transcript write failed/.test(e)));
});




test('inactive workers do not mirror room speech', async () => {
  const handlers = new Map();
  const bodies = [];
  let active = false;
  const session = { on: (event, handler) => handlers.set(event, handler), off: () => handlers.clear() };
  mirrorTranscript({
    session,
    meta: { huddleId: 'h1', sessionId: 's1', transcript: { url: 'https://x/t', token: 't' } },
    shouldMirror: () => active,
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response('{}', { status: 200 }); },
    log: { log: () => {}, error: () => {} },
  });
  const onUser = handlers.get(AgentSessionEventTypes.UserInputTranscribed);
  onUser({ transcript: 'inactive', isFinal: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bodies.length, 0);
  active = true;
  onUser({ transcript: 'active', isFinal: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].content, 'active');
});

test('a queued transcript is dropped when the worker loses the target before POST', async () => {
  const handlers = new Map();
  const bodies = [];
  let checks = 0;
  const session = { on: (event, handler) => handlers.set(event, handler), off: () => handlers.clear() };
  mirrorTranscript({
    session,
    meta: { huddleId: 'h1', sessionId: 's1', transcript: { url: 'https://x/t', token: 't' } },
    shouldMirror: () => checks++ === 0,
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response('{}', { status: 200 }); },
    log: { log: () => {}, error: () => {} },
  });
  handlers.get(AgentSessionEventTypes.UserInputTranscribed)({ transcript: 'stale', isFinal: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bodies.length, 0);
});

test('interrupted assistant items do not become durable speech', async () => {
  const handlers = new Map();
  const bodies = [];
  const session = { on: (event, handler) => handlers.set(event, handler), off: () => handlers.clear() };
  mirrorTranscript({
    session,
    meta: { huddleId: 'h1', sessionId: 's1', transcript: { url: 'https://x/t' } },
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response('{}', { status: 200 }); },
    log: { log: () => {}, error: () => {} },
  });
  const onItem = handlers.get(AgentSessionEventTypes.ConversationItemAdded);
  onItem({ interrupted: true, item: { role: 'assistant', content: 'stale partial' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bodies.length, 0);
});

test('repeated no-id utterances get distinct stable transcript events', async () => {
  const handlers = new Map();
  const bodies = [];
  const session = { on: (event, handler) => handlers.set(event, handler), off: () => handlers.clear() };
  mirrorTranscript({
    session,
    meta: { huddleId: 'h1', sessionId: 's1', transcript: { url: 'https://x/t', token: 't' } },
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response('{}', { status: 200 }); },
    log: { log: () => {}, error: () => {} },
  });
  const onUser = handlers.get('user_input_transcribed');
  const first = { transcript: 'yes', isFinal: true };
  onUser(first);
  onUser({ transcript: 'yes', isFinal: true });
  onUser(first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0].eventId, bodies[1].eventId);
});

test('voice target packets are closed, revisioned, and human-sender authenticated', () => {
  const packet = makeVoiceTarget({ huddleId: 'h1', targetAgentId: 'a2', revision: 1 });
  const sender = { identity: 'user:human-1', kind: 'standard' };
  assert.deepEqual(decodeVoiceTarget(encodeVoiceTarget(packet)), packet);
  assert.equal(acceptsTargetPacket({ packet, sender, huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).accepted, true);
  assert.equal(acceptsTargetPacket({ packet, sender: { identity: 'user:human-2', kind: 'standard' }, controllerIdentity: 'user:human-1', huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).reason, 'controller');
  const request = decodeVoiceTarget(encodeVoiceTargetRequest('h1'));
  assert.equal(isVoiceTargetRequest(request, 'h1'), true);
  assert.equal(isVoiceTargetRequest(request, 'other'), false);
  assert.equal(acceptsTargetPacket({ packet, sender, huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 1 }).reason, 'stale');
  assert.equal(acceptsTargetPacket({ packet, sender: { identity: 'agent', kind: 'agent' }, huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).reason, 'sender');
  assert.equal(acceptsTargetPacket({ packet, sender: { identity: 'AG_xyz', kind: 4 }, huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).reason, 'sender');
  assert.equal(acceptsTargetPacket({ packet, sender: { identity: 'unknown-participant', kind: 99 }, huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).reason, 'sender');
  assert.equal(acceptsTargetPacket({ packet, sender: { identity: 'human-1', kind: 'standard' }, huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).reason, 'sender');
  assert.equal(acceptsTargetPacket({ packet: { ...packet, extra: true }, sender, huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).reason, 'keys');
  assert.equal(acceptsTargetPacket({ packet: { ...packet, revision: 0x80000000 }, sender, huddleId: 'h1', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).reason, 'revision');
  assert.equal(acceptsTargetPacket({ packet, sender, huddleId: 'other', rosterAgentIds: ['a1', 'a2'], currentRevision: 0 }).reason, 'huddle');
});

test('voice MCP surface excludes job/control tools and caps results', () => {
  for (const name of ['claim_job', 'submit_job_result', 'fail_job', 'register_agent']) assert.ok(EXCLUDED.has(name));
  assert.deepEqual([...VOICE_LAZY_TOOL_ALLOWLIST].sort(), ['list_docs', 'list_skills', 'read_channel', 'read_doc', 'read_skill', 'search_docs']);
  const value = flattenToolResult('x'.repeat(MAX_VOICE_RESULT_CHARS + 100));
  assert.equal(value.length, MAX_VOICE_RESULT_CHARS);
  assert.ok(value.endsWith(VOICE_RESULT_TRUNCATION_MARKER));
});

test('context bounds preserve item count and cap one oversized message', () => {
  const context = {
    items: [
      { type: 'message', role: 'system', content: 'old system' },
      ...Array.from({ length: 30 }, (_, i) => ({ type: 'message', role: 'user', content: `${i}:${'x'.repeat(100)}` })),
    ],
    toJSON() { return this.items; },
  };
  boundChatContext(context);
  assert.ok(context.items.length <= 24);
  assert.ok(Buffer.byteLength(JSON.stringify(context.toJSON()), 'utf8') <= MAX_VOICE_CONTEXT_BYTES);

  const oversized = {
    items: [{ type: 'message', role: 'system', content: 'sys' }, { type: 'message', role: 'user', content: 'y'.repeat(20_000) }],
    toJSON() { return this.items; },
  };
  boundChatContext(oversized);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.toJSON()), 'utf8') <= MAX_VOICE_CONTEXT_BYTES);
});


test('context bounds document the protected system plus active-call exception', () => {
  const context = {
    items: [
      { type: 'message', role: 'system', content: 'system instructions' },
      { type: 'function_call', callId: 'active', name: 'lookup', args: '{}' },
    ],
    toJSON() { return this.items; },
  };
  boundChatContext(context, { maxItems: 1, maxBytes: MAX_VOICE_CONTEXT_BYTES });
  // The provider must receive the live call until its output arrives. Keeping
  // the system item plus that call is the explicit, structural exception to
  // maxItems; both halves remain normalized and bounded.
  assert.deepEqual(context.items.map((item) => item.type), ['message', 'function_call']);
  assert.equal(context.items[1].callId, 'active');
});

test('context serialization failures are replaced instead of counted as zero bytes', () => {
  const circular = {};
  circular.self = circular;
  const context = { items: [{ type: 'message', role: 'user', content: circular }] };
  boundChatContext(context);
  assert.doesNotThrow(() => JSON.stringify(context.items));
  assert.ok(Buffer.byteLength(JSON.stringify(context.items), 'utf8') <= MAX_VOICE_CONTEXT_BYTES);

  const bigintContext = { items: [{ type: 'message', role: 'user', content: 1n }] };
  boundChatContext(bigintContext);
  assert.doesNotThrow(() => JSON.stringify(bigintContext.items));
});


test('object-valued tool arguments and results are normalized before bounding', () => {
  const context = {
    items: [
      { type: 'function_call', callId: 'object-call', name: 'lookup', args: { nested: { value: 'x'.repeat(10_000) } } },
      { type: 'function_call_output', callId: 'object-call', output: { nested: { value: 'x'.repeat(10_000) } } },
    ],
  };
  boundChatContext(context);
  assert.equal(context.items[0].args, '{}');
  assert.equal(typeof context.items[1].output, 'string');
  assert.ok(context.items[1].output.length <= 4_000);
});

test('context tail repair keeps a tool call paired with its output', () => {
  const context = {
    items: [
      { type: 'message', role: 'system', content: 'sys' },
      { type: 'function_call', callId: 'split', name: 'lookup', args: '{}' },
      { type: 'function_call_output', callId: 'split', output: 'result' },
      { type: 'message', role: 'user', content: 'older' },
      { type: 'message', role: 'user', content: 'newer' },
    ],
    toJSON() { return this.items; },
  };
  boundChatContext(context, { maxItems: 3, maxBytes: 10_000 });
  assert.equal(context.items.filter((item) => item.callId === 'split').length, 2);
  assert.equal(context.items[1].type, 'function_call');
  assert.equal(context.items[2].type, 'function_call_output');
});

test('context trimming preserves an in-flight call and drops orphan output', () => {
  const context = {
    items: [
      { type: 'message', role: 'system', content: 'sys' },
      { type: 'function_call_output', callId: 'ordered', output: 'before call' },
      { type: 'function_call', callId: 'ordered', name: 'lookup', args: '{}' },
      { type: 'function_call_output', callId: 'ordered', output: 'first' },
      { type: 'function_call_output', callId: 'ordered', output: 'duplicate' },
      { type: 'function_call_output', callId: 'orphan', output: 'bad' },
      { type: 'function_call', callId: 'active', name: 'lookup', args: '{}' },
      { type: 'function_call', name: 'malformed', args: '{}' },
      { type: 'function_call_output', output: 'malformed' },
    ],
    toJSON() { return this.items; },
  };
  boundChatContext(context);
  assert.equal(context.items.some((item) => item.type === 'function_call' && item.callId === 'active'), true);
  assert.equal(context.items.some((item) => item.type === 'function_call_output' && item.callId === 'orphan'), false);
  assert.equal(context.items.some((item) => item.type === 'function_call' && !item.callId), false);
  assert.equal(context.items.some((item) => item.type === 'function_call_output' && !item.callId), false);
  assert.equal(context.items.filter((item) => item.type === 'function_call' && item.callId === 'ordered').length, 1);
  assert.equal(context.items.filter((item) => item.type === 'function_call_output' && item.callId === 'ordered').length, 1);
});


test('byte trimming evicts completed call pairs before preserving active calls', () => {
  const context = {
    items: [
      { type: 'message', role: 'system', content: 'sys' },
      { type: 'function_call', callId: 'done-1', name: 'lookup', args: '{}' },
      { type: 'function_call_output', callId: 'done-1', output: 'x'.repeat(2_000) },
      { type: 'function_call', callId: 'done-2', name: 'lookup', args: '{}' },
      { type: 'function_call_output', callId: 'done-2', output: 'x'.repeat(2_000) },
      { type: 'function_call', callId: 'active', name: 'lookup', args: '{}' },
    ],
    toJSON() { return this.items; },
  };
  boundChatContext(context, { maxItems: 24, maxBytes: 512 });
  assert.equal(context.items.some((item) => item.callId === 'active'), true);
  assert.equal(context.items.some((item) => item.callId === 'done-1'), false);
  assert.equal(context.items.some((item) => item.callId === 'done-2'), true, 'newest completed pair is the protected history anchor');
  assert.ok(Buffer.byteLength(JSON.stringify(context.toJSON()), 'utf8') <= 512);
});

test('an oversized tool result is reduced without deleting its call pair', () => {
  const context = {
    items: [
      { type: 'message', role: 'system', content: 's'.repeat(7_000) },
      { type: 'function_call', callId: 'active', name: 'read_channel', args: '{}' },
      { type: 'function_call_output', callId: 'active', output: 'x'.repeat(20_000) },
    ],
    toJSON() { return { items: this.items }; },
  };
  boundChatContext(context);
  assert.equal(context.items.some((item) => item.type === 'function_call' && item.callId === 'active'), true);
  assert.equal(context.items.some((item) => item.type === 'function_call_output' && item.callId === 'active'), true);
  assert.ok(context.items.find((item) => item.type === 'function_call_output').output.length <= 512);
});

test('live chat context is trimmed by whole items and stays under the byte bound', () => {
  const context = {
    items: [
      { type: 'message', role: 'system', content: 'system' },
      ...Array.from({ length: 40 }, (_, i) => ({ type: 'message', role: 'user', content: `${i}:${'z'.repeat(700)}` })),
    ],
    truncate(maxItems) {
      const system = this.items.find((item) => item.role === 'system');
      this.items = [system, ...this.items.slice(-maxItems)].filter(Boolean);
      return this;
    },
    toJSON() { return this.items; },
  };
  boundChatContext(context);
  assert.ok(context.items.length <= 24);
  assert.ok(Buffer.byteLength(JSON.stringify(context.toJSON()), 'utf8') <= MAX_VOICE_CONTEXT_BYTES || context.items.length <= 2);
  assert.ok(context.items.every((item) => item.type === 'message'));
});
