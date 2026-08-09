'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sentenceChunks,
  speakableProgress,
  huddleVoiceChannel,
  HUDDLE_VOICE_CHANNEL_PREFIX,
  SENTENCE_SOFT_LIMIT,
} = require('../shared/voice-speakable.cjs');

const { createVoicePublish } = require('../server/voice-publish.cjs');

// Keep the soft limit aligned with the browser (src/lib/voiceStream.ts).
test('SENTENCE_SOFT_LIMIT matches the client constant', () => {
  // Importing TS from cjs is awkward; pin the known value and document the pair.
  assert.equal(SENTENCE_SOFT_LIMIT, 220);
});

test('sentenceChunks speaks at the first full stop', () => {
  const { speak, spoken } = sentenceChunks('On it. Checking the logs now', '');
  assert.deepEqual(speak, ['On it.']);
  assert.equal(spoken, 'On it.');
});

test('sentenceChunks advances from an existing prefix', () => {
  const { speak, spoken } = sentenceChunks('On it. Checking now.', 'On it.');
  assert.deepEqual(speak, ['Checking now.']);
  assert.equal(spoken, 'On it. Checking now.');
});

test('sentenceChunks returns nothing on a rewrite (non-prefix)', () => {
  const { speak, spoken } = sentenceChunks('Actually no.', 'On it.');
  assert.deepEqual(speak, []);
  assert.equal(spoken, 'On it.');
});

test('speakableProgress yields ordered pieces with offsets', () => {
  const pieces = speakableProgress('One. Two. Three unfinished', '');
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].sentence, 'One.');
  assert.equal(pieces[0].offset, 0);
  assert.equal(pieces[1].sentence, 'Two.');
  assert.ok(pieces[1].spokenAfter.startsWith(pieces[0].spokenAfter.slice(0, pieces[0].spokenAfter.length - 0)));
});

test('huddleVoiceChannel is workspace-scoped with one colon', () => {
  assert.equal(huddleVoiceChannel('ws-abc'), `${HUDDLE_VOICE_CHANNEL_PREFIX}:ws-abc`);
  assert.equal(huddleVoiceChannel(''), '');
});

test('publishHuddleVoiceText fans out with session audience and advances spoken', async () => {
  const sent = [];
  const { publishHuddleVoiceText } = createVoicePublish({
    sessionRealtimeAudience: async (sessionId) => {
      assert.equal(sessionId, 'sess-1');
      return { memberUserIds: null }; // workspace-visible
    },
    relayBroadcastToUserIds: (channel, event, payload, allowed) => {
      sent.push({ channel, event, payload, allowed });
    },
  });

  const next = await publishHuddleVoiceText({
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    messageId: 'msg-1',
    agentId: 'ag-1',
    agentName: 'Ada',
    fullText: 'On it. Checking logs.',
    previousSpoken: '',
  });

  assert.ok(next.includes('On it.'));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].channel, 'huddle-voice:ws-1');
  assert.equal(sent[0].event, 'sentence');
  assert.equal(sent[0].payload.sentence, 'On it.');
  assert.equal(sent[0].payload.sessionId, 'sess-1');
  assert.equal(sent[1].payload.sentence, 'Checking logs.');
});

test('publishHuddleVoiceText fails closed when audience is unknown', async () => {
  const sent = [];
  const { publishHuddleVoiceText } = createVoicePublish({
    sessionRealtimeAudience: async () => null,
    relayBroadcastToUserIds: (...args) => sent.push(args),
  });
  const next = await publishHuddleVoiceText({
    workspaceId: 'ws-1',
    sessionId: 'sess-missing',
    messageId: 'msg-1',
    agentId: 'ag-1',
    fullText: 'Hello.',
    previousSpoken: '',
  });
  assert.equal(next, '');
  assert.equal(sent.length, 0);
});

test('publishHuddleVoiceText passes private member set to fanout', async () => {
  const members = new Set(['user-a', 'user-b']);
  let allowedSeen = null;
  const { publishHuddleVoiceText } = createVoicePublish({
    sessionRealtimeAudience: async () => ({ memberUserIds: members }),
    relayBroadcastToUserIds: (_c, _e, _p, allowed) => {
      allowedSeen = allowed;
    },
  });
  await publishHuddleVoiceText({
    workspaceId: 'ws-1',
    sessionId: 'sess-dm',
    messageId: 'msg-1',
    agentId: 'ag-1',
    fullText: 'Private reply.',
    previousSpoken: '',
  });
  assert.equal(allowedSeen, members);
});

test('workspaceIdFromRealtimeChannel accepts huddle-voice prefix', () => {
  // Light source pin so the allowlist cannot drop silently.
  const body = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../server/realtime.cjs'),
    'utf8',
  );
  assert.match(body, /huddle-voice/);
  assert.match(body, /relayBroadcastToUserIds/);
});
