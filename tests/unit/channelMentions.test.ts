import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  CHANNEL_MENTION_HANDLE,
  CHANNEL_MENTION_MAX_AGENTS,
  CONVERSATION_MODES,
  DEFAULT_CONVERSATION_MODE,
  MENTION_PATTERN_SOURCE,
  RESERVED_AGENT_HANDLES,
  agentMentionHandles,
  allowsUnpromptedReply,
  isReservedAgentHandle,
  mentionsChannel,
  normalizeConversationMode,
  parseMentionHandles,
  reservedAgentHandleMessage,
  slugMentionHandle,
} from '../../src/lib/channelMentions';

const require_ = createRequire(import.meta.url);
const shared = require_('../../shared/channelMentions.cjs');

// PARITY. These decisions exist twice — here (browser) and in
// shared/channelMentions.cjs (server, which dispatches on them). They cannot be
// one file: shared/*.cjs must never enter the browser bundle. So both run the
// SAME fixture table and the answers must be identical.
//
// Without this, the composer's idea of who a message addresses and the
// dispatcher's could drift apart, and the symptom would be a message that reads
// as addressed to someone and wakes nobody — with nothing in the UI to say so.
describe('parity with the server implementation', () => {
  it('agrees on every fixture input', () => {
    const mine = shared.parityAnswers({
      parseMentionHandles,
      agentMentionHandles,
      mentionsChannel,
      isReservedAgentHandle,
      slugMentionHandle,
    });
    expect(mine).toEqual(shared.parityAnswers(shared));
  });

  it('shares the pattern source verbatim', () => {
    // Compared as a STRING, not as behaviour: two regexes that happen to agree
    // on the fixture but differ in source are one edge case from disagreeing.
    expect(MENTION_PATTERN_SOURCE).toBe(shared.MENTION_PATTERN_SOURCE);
  });

  it('shares the reserved handle, the cap and the modes', () => {
    expect(CHANNEL_MENTION_HANDLE).toBe(shared.CHANNEL_MENTION_HANDLE);
    expect([...RESERVED_AGENT_HANDLES]).toEqual([...shared.RESERVED_AGENT_HANDLES]);
    expect(CHANNEL_MENTION_MAX_AGENTS).toBe(shared.CHANNEL_MENTION_MAX_AGENTS);
    expect([...CONVERSATION_MODES]).toEqual([...shared.CONVERSATION_MODES]);
    expect(DEFAULT_CONVERSATION_MODE).toBe(shared.DEFAULT_CONVERSATION_MODE);
  });

  it('words the reserved-handle refusal identically', () => {
    // The browser shows this string in a form; the server returns it as a 400.
    // A human hitting the same wall twice should not read two explanations.
    for (const value of ['channel', 'Channel', '@CHANNEL']) {
      expect(reservedAgentHandleMessage(value)).toBe(shared.reservedAgentHandleMessage(value));
    }
  });
});

describe('what the composer reads out of a draft', () => {
  it('separates addressing one agent from addressing the room', () => {
    expect(agentMentionHandles('hey @scout')).toEqual(['scout']);
    expect(agentMentionHandles('hey @channel')).toEqual([]);
    expect(agentMentionHandles('@channel and @scout')).toEqual(['scout']);
    expect(mentionsChannel('@channel and @scout')).toBe(true);
    expect(mentionsChannel('@scout')).toBe(false);
  });

  it('does not see a mention inside an email address', () => {
    expect(parseMentionHandles('write to jason@bouncingfish.com')).toEqual([]);
  });

  it('treats a longer handle starting with "channel" as its own agent', () => {
    expect(mentionsChannel('@channels')).toBe(false);
    expect(parseMentionHandles('@channels')).toEqual(['channels']);
  });
});

describe('reply timing', () => {
  it('defaults to auto, so no existing channel changes behaviour', () => {
    expect(normalizeConversationMode(undefined)).toBe('auto');
    expect(normalizeConversationMode(null)).toBe('auto');
    expect(normalizeConversationMode('')).toBe('auto');
    expect(normalizeConversationMode('nonsense')).toBe('auto');
  });

  it("only 'mention' stops an un-addressed post from waking anyone", () => {
    expect(allowsUnpromptedReply({ conversationMode: 'auto' })).toBe(true);
    expect(allowsUnpromptedReply({ conversationMode: 'mention' })).toBe(false);
    expect(allowsUnpromptedReply()).toBe(true);
  });

  it('never silences a DM', () => {
    expect(allowsUnpromptedReply({ conversationMode: 'mention', isDirectMessage: true })).toBe(true);
  });
});
