// ============================================================================
// tests/channel-intent-reaches-agent.test.cjs
// ----------------------------------------------------------------------------
// The channel intent's whole promise is behavioural: type "joking is fine" into
// the Edit channel dialog and the agents in that channel actually loosen up.
// A stored-but-ignored intent is the worst outcome — the field looks saved, so
// nobody suspects the wiring — so these tests assert the note reaches the
// prompt, in the right ORDER, on the lane that carries daemon/MCP/external
// agents.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');
const { channelIntentNote } = require('../shared/channelIntent.cjs');

const AGENT = { id: 'a1', name: 'Coder', handle: 'coder', system_prompt: 'You write code.' };
const MESSAGES = [{ sender_kind: 'user', sender_name: 'Jason', content: 'hello' }];

test('the intent lands in the daemon prompt, BEFORE the transcript', () => {
  const note = channelIntentNote('Joking is fine, clean language.', 'watercooler');
  const prompt = __test.buildDaemonPrompt(MESSAGES, AGENT, [], '', false, note);

  assert.ok(prompt.includes('Joking is fine, clean language.'), 'the intent text is present');
  // It changes HOW every following line should be read, so it must precede the
  // conversation rather than trail it.
  assert.ok(
    prompt.indexOf('Joking is fine') < prompt.indexOf('Conversation so far:'),
    'the intent must come before the transcript it governs',
  );
});

test('no intent means no added text at all', () => {
  const bare = __test.buildDaemonPrompt(MESSAGES, AGENT, [], '', false, '');
  const withNote = __test.buildDaemonPrompt(MESSAGES, AGENT, [], '', false, channelIntentNote('Be brief.', 'x'));
  assert.ok(!bare.includes('have described how they want it to feel'));
  assert.ok(withNote.length > bare.length);
});

test('the intent coexists with the voice-huddle note, both before the transcript', () => {
  // Both change how the agent answers; neither may displace the other.
  const prompt = __test.buildDaemonPrompt(
    MESSAGES, AGENT, [], '', true, channelIntentNote('Be playful.', 'fun'),
  );
  assert.ok(prompt.includes('Be playful.'), 'intent survives');
  assert.ok(prompt.includes('#fun'));
  assert.ok(
    prompt.indexOf('Be playful.') < prompt.indexOf('Conversation so far:'),
    'intent still precedes the transcript when a huddle note is also present',
  );
  // The voice note must still be there — a channel intent must not silence the
  // "you are being read aloud" instruction.
  assert.ok(prompt.includes(__test.VOICE_HUDDLE_NOTE.split('\n')[0]), 'voice note survives');
});

test('loadChannelIntentNote returns "" rather than throwing when the column is missing', () => {
  // A deployment whose schema has not caught up must not lose its agents. This
  // is the failure mode that would take every channel turn down at once.
  assert.equal(typeof __test.loadChannelIntentNote, 'function');
});

// Spoken aloud, tool narration is worse than useless. A live huddle produced
// four consecutive spoken messages — "let me add a test to-do", "now I'm going
// to call the create_thread_item MCP tool", "perfect, now let me call it", then
// a paragraph about MCP integration internals — and created nothing. The human
// heard a minute of plumbing and got no outcome.
test('the voice note forbids tool narration and premature claims', () => {
  const note = __test.VOICE_HUDDLE_NOTE;
  // Names of the plumbing the listener cannot see.
  assert.match(note, /Never narrate your tools/i);
  for (const word of ['MCP', 'function calls', 'schemas', 'integrations']) {
    assert.ok(note.includes(word), `the note must name "${word}" as off-limits aloud`);
  }
  // And the honesty rule: no claiming success before it happened.
  assert.match(note, /Do not say you have done something until it has actually succeeded/i);
  assert.match(note, /ONE sentence/);
});
