// The parts of the voice worker that can be proven without a LiveKit room:
// which vendor gets chosen, what the held video frame actually contains, and
// how the MCP bridge behaves when the workspace is unreachable.

import assert from 'node:assert/strict';
import test from 'node:test';

import { availableEngines, resolveEngine, VOICE_ENGINES } from '../src/providers.mjs';
import { initialsFor, parseColor, renderAvatarFrame } from '../src/avatarVideo.mjs';
import { flattenToolResult, loadMcpTools } from '../src/mcpTools.mjs';
import { mirrorTranscript } from '../src/transcript.mjs';

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

test('an unreachable MCP endpoint degrades the agent, it does not kill the call', async () => {
  const errors = [];
  const tools = await loadMcpTools({
    url: 'https://example.invalid/backend/mcp',
    token: 'agv_x',
    log: { error: (m) => errors.push(String(m)), log: () => {} },
  });
  assert.deepEqual(tools, {}, 'no tools rather than a thrown job');
  assert.ok(errors.some((e) => /MCP tools unavailable/.test(e)), 'and it says so');

  assert.deepEqual(await loadMcpTools({ url: '' }), {}, 'no endpoint configured is not an error');
});

test('MCP results flatten to something a model can say out loud', () => {
  assert.equal(flattenToolResult({ content: [{ type: 'text', text: 'two open tasks' }] }), 'two open tasks');
  assert.equal(flattenToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(flattenToolResult(null), '');
  assert.equal(flattenToolResult('plain'), 'plain');
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
