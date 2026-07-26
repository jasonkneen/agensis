// ============================================================================
// tests/channel-mention-parity.test.cjs
// ----------------------------------------------------------------------------
// The mention decisions exist TWICE on purpose:
//
//   shared/channelMentions.cjs   the server, deciding who a message dispatches
//   src/lib/channelMentions.ts   the browser, deciding what the composer says
//
// They cannot be one file — shared/*.cjs is CommonJS server code and nothing
// under src/ may pull it into the browser bundle. So both are checked against
// ONE fixture table (PARITY_INPUTS, exported from the shared module): this file
// pins the server's answers, and tests/unit/channelMentions.test.ts imports the
// real TS module and asserts the same table.
//
// The drift this prevents is invisible in use. The composer tells a human "Scout
// isn't in this channel yet — they'll be added when you send"; the dispatcher
// decides whether Scout is woken. If the two disagree about what counts as a
// mention, the message looks addressed and nobody answers, and nothing in the UI
// says why.
//
// This file also owns the decisions that are properties of the FEATURE rather
// than of either parser: which handle is reserved, who @channel expands to, and
// when an un-addressed post is allowed to wake somebody.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../shared/channelMentions.cjs');

test('the fixture covers the cases that actually matter', () => {
  // Not a tautology: it asserts the table still exercises the shapes that
  // distinguish a real mention from a lookalike. A shrunken fixture would make
  // the parity check pass by testing nothing.
  const { PARITY_INPUTS } = shared;
  assert.ok(PARITY_INPUTS.includes(''), 'empty string');
  assert.ok(PARITY_INPUTS.includes(null), 'null');
  assert.ok(PARITY_INPUTS.some((v) => typeof v === 'string' && v.includes('@channel')), 'a bare @channel');
  assert.ok(PARITY_INPUTS.some((v) => typeof v === 'string' && /@CHANNEL/.test(v)), 'case folding');
  assert.ok(PARITY_INPUTS.some((v) => typeof v === 'string' && v.includes('@channels')), 'a longer handle that STARTS with channel');
  assert.ok(PARITY_INPUTS.some((v) => typeof v === 'string' && v.includes('bouncingfish.com')), 'an email address');
  assert.ok(PARITY_INPUTS.some((v) => typeof v === 'string' && v.includes('\n')), 'a newline before a mention');
  assert.ok(PARITY_INPUTS.some((v) => typeof v === 'string' && v.includes('\t')), 'a tab before a mention');
});

test("the SERVER's answers for the fixture are exactly these", () => {
  // Pinned literally so a change to either parser has to be deliberate, and so
  // the TS side has a fixed target to match rather than both drifting together.
  const answers = shared.parityAnswers(shared);
  const at = (input) => answers[shared.PARITY_INPUTS.indexOf(input)];

  assert.deepEqual(at('').handles, []);
  assert.deepEqual(at('no mentions here').handles, []);
  assert.deepEqual(at('@scout').handles, ['scout']);
  assert.deepEqual(at('hey @scout and @coder').handles, ['scout', 'coder']);
  assert.deepEqual(at('hey @scout and @scout again').handles, ['scout'], 'de-duplicated');

  // A mention has to START a word, so an email address contains none. This is
  // the reason the pattern is `(^|\s)@` and not a bare `@`.
  assert.deepEqual(at('mail me at jason@bouncingfish.com').handles, []);
  assert.deepEqual(at('no-space-before@channel').handles, [], 'no leading space, no mention');

  // @channel, in every casing, is ONE handle: `channel`.
  assert.deepEqual(at('@channel').handles, ['channel']);
  assert.deepEqual(at('@CHANNEL please look').handles, ['channel']);
  assert.deepEqual(at('@Channel').handles, ['channel']);
  assert.deepEqual(at('multi\nline @channel here').handles, ['channel']);
  assert.deepEqual(at('\t@channel after a tab').handles, ['channel']);

  // A LONGER handle that merely starts with "channel" is a different agent, and
  // must not be treated as addressing everyone. This is the whole-word rule.
  assert.deepEqual(at('@channels').handles, ['channels']);
  assert.deepEqual(at('@channel-two').handles, ['channel-two']);
  assert.equal(at('@channels').channel, false);
  assert.equal(at('@channel-two').channel, false);

  // `#channel` is a canvas-group reference, not a mention.
  assert.deepEqual(at('the #channel tag').handles, []);

  // Punctuation ends a mention; parentheses do not begin one (the dispatcher
  // needs whitespace, unlike the renderer — see MarkdownContent).
  assert.deepEqual(at('end of line @channel').handles, ['channel']);
  assert.deepEqual(at('(@channel)').handles, [], 'the dispatcher needs whitespace before the @');
});

test('agentMentionHandles removes @channel, mentionsChannel finds it', () => {
  // Two views of the same parse, and the split is load-bearing: every caller of
  // agentMentionHandles looks its results up in a handle->agent map, so leaving
  // `channel` in would resolve a mention of everyone to whichever agent happened
  // to be slugged `channel`.
  assert.deepEqual(shared.agentMentionHandles('cc @channel and @scout'), ['scout']);
  assert.deepEqual(shared.parseMentionHandles('cc @channel and @scout'), ['channel', 'scout']);
  assert.equal(shared.mentionsChannel('cc @channel and @scout'), true);
  assert.equal(shared.mentionsChannel('cc @scout'), false);
  assert.equal(shared.mentionsChannel(''), false);
});

test('slugMentionHandle keeps the historical fallback for tokens that reduce to nothing', () => {
  // `@...` has always resolved to the handle `agent`. It is a quirk, but it is a
  // quirk existing messages were dispatched under, so it is pinned rather than
  // fixed: changing it would change who old bursts wake.
  assert.equal(shared.slugMentionHandle('...'), 'agent');
  assert.equal(shared.slugMentionHandle('-'), 'agent');
  assert.equal(shared.slugMentionHandle(''), 'agent');
  assert.equal(shared.slugMentionHandle('@Scout'), 'scout');
  assert.equal(shared.slugMentionHandle('a.b.c'), 'a-b-c');
  assert.equal(shared.slugMentionHandle('x'.repeat(80)).length, 40, 'capped at 40');
});

// --- the reserved handle ----------------------------------------------------

test('`channel` is reserved, in every spelling a handle could reach it by', () => {
  for (const value of ['channel', 'Channel', 'CHANNEL', '@channel', '  channel  ', '@Channel']) {
    assert.equal(shared.isReservedAgentHandle(value), true, `${JSON.stringify(value)} must be reserved`);
  }
});

test('a handle that merely resembles it is NOT reserved', () => {
  // Over-reserving is its own bug: it refuses names a human is entitled to use.
  for (const value of ['channels', 'channel-two', 'my-channel', 'chan', 'scout', '']) {
    assert.equal(shared.isReservedAgentHandle(value), false, `${JSON.stringify(value)} must be allowed`);
  }
});

test('the reserved-handle message names the handle and says why', () => {
  const message = shared.reservedAgentHandleMessage('Channel');
  assert.match(message, /@channel/);
  assert.match(message, /reserved/);
  assert.match(message, /everyone in a channel/);
});

// --- who @channel reaches ---------------------------------------------------

const AGENTS = [
  { id: 'a1', name: 'Scout', handle: 'scout', enabled: true },
  { id: 'a2', name: 'Coder', handle: 'coder', enabled: true },
  { id: 'a3', name: 'Off', handle: 'off', enabled: false },
  { id: 'a4', name: 'Outsider', handle: 'outsider', enabled: true },
];
const isEnabled = (agent) => agent.enabled !== false;

test('@channel expands to the STORED roster only — never every agent in the workspace', () => {
  // The regression this guards is specific and has already shipped once in a
  // different surface: presence leaking into channel membership, so every agent
  // online anywhere appeared in every channel. Here that would spend a paid
  // model turn per phantom member.
  const expanded = shared.expandChannelMention({
    participantAgentIds: ['a1', 'a2'],
    agents: AGENTS,
    isEnabled,
  });
  assert.deepEqual(expanded.map((a) => a.id), ['a1', 'a2']);
  assert.ok(!expanded.some((a) => a.id === 'a4'), 'an agent not in the roster is not in the channel');
});

test('@channel skips disabled agents and unknown participant ids', () => {
  const expanded = shared.expandChannelMention({
    participantAgentIds: ['a1', 'a3', 'gone'],
    agents: AGENTS,
    isEnabled,
  });
  assert.deepEqual(expanded.map((a) => a.id), ['a1']);
});

test('@channel in a channel with no agents reaches nobody', () => {
  assert.deepEqual(shared.expandChannelMention({ participantAgentIds: [], agents: AGENTS, isEnabled }), []);
  assert.deepEqual(shared.expandChannelMention({ participantAgentIds: null, agents: AGENTS, isEnabled }), []);
});

test('the cost cap bounds one @channel, and truncates in stable roster order', () => {
  // max_agent_turns bounds a BURST, and agent-to-agent replies spend the same
  // budget, so it does not bound how many distinct agents one @channel queues.
  // This does. Stable order matters: a different subset per attempt would make
  // "who answered" depend on nothing the human can see.
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: `A${i}`, handle: `a${i}`, enabled: true }));
  const ids = many.map((a) => a.id);
  const first = shared.expandChannelMention({ participantAgentIds: ids, agents: many, isEnabled });
  assert.equal(first.length, shared.CHANNEL_MENTION_MAX_AGENTS);
  const second = shared.expandChannelMention({ participantAgentIds: ids, agents: many, isEnabled });
  assert.deepEqual(second.map((a) => a.id), first.map((a) => a.id), 'same agents every time');
  assert.deepEqual(first.map((a) => a.id), ids.slice(0, shared.CHANNEL_MENTION_MAX_AGENTS));
  assert.equal(shared.expandChannelMention({ participantAgentIds: ids, agents: many, isEnabled, limit: 0 }).length, 0);
});

// --- reply timing -----------------------------------------------------------

test('conversation_mode normalizes to auto for anything unrecognised', () => {
  // 'auto' is the DB default and what every existing channel already does, so an
  // unreadable value must land there — failing to 'mention' would silence
  // channels nobody asked to silence.
  assert.equal(shared.normalizeConversationMode('auto'), 'auto');
  assert.equal(shared.normalizeConversationMode('mention'), 'mention');
  assert.equal(shared.normalizeConversationMode('MENTION'), 'mention');
  assert.equal(shared.normalizeConversationMode('  auto '), 'auto');
  for (const value of ['', null, undefined, 'nonsense', 'all', 0, {}]) {
    assert.equal(shared.normalizeConversationMode(value), 'auto', `${JSON.stringify(value)} => auto`);
  }
});

test("'auto' may wake someone nobody named; 'mention' may not", () => {
  assert.equal(shared.allowsUnpromptedReply({ conversationMode: 'auto' }), true);
  assert.equal(shared.allowsUnpromptedReply({ conversationMode: 'mention' }), false);
  assert.equal(shared.allowsUnpromptedReply({}), true, 'default is auto');
});

test('a DM always answers a plain message, whatever its stored mode says', () => {
  // A DM's single agent replying without being @mentioned is what makes it a DM
  // rather than a channel of one. A stale 'mention' on a DM row must not make it
  // stop answering — that is the wedged-DM failure mode, and it is silent.
  assert.equal(shared.allowsUnpromptedReply({ conversationMode: 'mention', isDirectMessage: true }), true);
  assert.equal(shared.allowsUnpromptedReply({ conversationMode: 'auto', isDirectMessage: true }), true);
});
