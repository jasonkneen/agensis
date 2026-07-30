// Guards the channel/thread split in src/components/chat/channelView.ts.
//
// "Send to channel": an agent works inside a thread and only its final answer is
// flagged broadcast_to_channel. The channel view is therefore no longer "messages
// with no thread parent" — that filter would leave a channel showing only the
// human's own messages while every answer sat invisibly in a thread. It is "top
// level OR broadcast", and a broadcast reply KEEPS its thread_parent_id so it shows
// in BOTH views.
//
// The thread view is deliberately NOT re-implemented here: it is
// `m.thread_parent_id === activeThreadId || m.id === activeThreadId` in useChat, so
// these tests assert the same predicate over the same fixtures to pin the
// both-views claim end to end.

import { describe, it, expect } from 'vitest';
import { channelMessages, isChannelMessage, isBroadcastFromThread } from '../../src/components/chat/channelView';
import type { Message } from '../../src/types';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm',
    session_id: 's1',
    role: 'assistant',
    content: '',
    created_at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  };
}

/** The thread panel's own predicate (useChat.threadMessages), for the both-views test. */
function threadMessages(messages: Message[], rootId: string) {
  return messages.filter(m => m.thread_parent_id === rootId || m.id === rootId);
}

const human = message({ id: 'msg-human', role: 'user', content: '@coder what does channelView do?' });
const placeholder = message({ id: 'msg-placeholder', content: 'Thinking 4s', thread_parent_id: 'msg-human', sender_kind: 'agent' });
const toolStep = message({ id: 'msg-step', content: 'Read · src/App.tsx', thread_parent_id: 'msg-human', message_kind: 'tool_step', sender_kind: 'agent' });
const block = message({ id: 'msg-block', content: 'Reading the filter first.', thread_parent_id: 'msg-human', sender_kind: 'agent' });
const answer = message({
  id: 'msg-answer',
  content: 'It filters the channel transcript.',
  thread_parent_id: 'msg-human',
  sender_kind: 'agent',
  broadcast_to_channel: true,
});

describe('isChannelMessage', () => {
  it('keeps top-level messages', () => {
    expect(isChannelMessage(human)).toBe(true);
  });

  it('drops the working conversation — placeholder, tool chips, intermediate blocks', () => {
    expect(isChannelMessage(placeholder)).toBe(false);
    expect(isChannelMessage(toolStep)).toBe(false);
    expect(isChannelMessage(block)).toBe(false);
  });

  it('keeps a thread reply that was broadcast', () => {
    expect(isChannelMessage(answer)).toBe(true);
  });

  it('treats a missing or null flag as not broadcast', () => {
    expect(isChannelMessage(message({ thread_parent_id: 'msg-human' }))).toBe(false);
    expect(isChannelMessage(message({ thread_parent_id: 'msg-human', broadcast_to_channel: null }))).toBe(false);
    expect(isChannelMessage(message({ thread_parent_id: 'msg-human', broadcast_to_channel: false }))).toBe(false);
  });
});

describe('channelMessages', () => {
  it('shows the human message and the broadcast answer, and nothing else', () => {
    const all = [human, placeholder, toolStep, block, answer];
    expect(channelMessages(all).map(m => m.id)).toEqual(['msg-human', 'msg-answer']);
  });

  it('preserves order (it is a filter, not a re-sort)', () => {
    const all = [human, answer, message({ id: 'msg-later', role: 'user', content: 'thanks' })];
    expect(channelMessages(all).map(m => m.id)).toEqual(['msg-human', 'msg-answer', 'msg-later']);
  });

  it('leaves a channel with no threads completely untouched', () => {
    const all = [human, message({ id: 'msg-plain', content: 'top level reply' })];
    expect(channelMessages(all)).toEqual(all);
  });

  it('mid-turn the channel is just the human message and a reply count', () => {
    // Exactly the accepted tradeoff: while the agent works there is no
    // channel-level "working…" row at all.
    const all = [human, placeholder, toolStep];
    expect(channelMessages(all).map(m => m.id)).toEqual(['msg-human']);
  });
});

describe('a broadcast reply appears in BOTH views', () => {
  const all = [human, placeholder, toolStep, block, answer];

  it('is in the channel view', () => {
    expect(channelMessages(all).map(m => m.id)).toContain('msg-answer');
  });

  it('is still in the thread view, alongside the working conversation', () => {
    expect(threadMessages(all, 'msg-human').map(m => m.id)).toEqual([
      'msg-human',
      'msg-placeholder',
      'msg-step',
      'msg-block',
      'msg-answer',
    ]);
  });

  it('is the same object in both — broadcasting never moves or copies the row', () => {
    const inChannel = channelMessages(all).find(m => m.id === 'msg-answer');
    const inThread = threadMessages(all, 'msg-human').find(m => m.id === 'msg-answer');
    expect(inChannel).toBe(inThread);
    expect(inChannel?.thread_parent_id).toBe('msg-human');
  });
});

describe('isBroadcastFromThread (the "from a thread" affordance)', () => {
  it('is true only for a broadcast reply that really came from a thread', () => {
    expect(isBroadcastFromThread(answer)).toBe(true);
  });

  it('is false for a top-level message, however it is flagged', () => {
    expect(isBroadcastFromThread(human)).toBe(false);
    expect(isBroadcastFromThread(message({ broadcast_to_channel: true }))).toBe(false);
  });

  it('is false for an unbroadcast thread reply (it is not in the channel to label)', () => {
    expect(isBroadcastFromThread(block)).toBe(false);
  });
});

describe('tool steps are never channel content', () => {
  // The server threads tool steps, but agent-jobs.cjs has a fallback path: when
  // the placeholder row is gone AND neither recorded parent verifies, the step is
  // written with a null thread_parent_id — which the "top level OR broadcast"
  // rule reads as an ordinary channel message. One live DM accumulated 119 of
  // them, burying the conversation under context-free `Bash · …` / `Read · …`
  // chips and pushing real messages off the page.
  it('a tool step with NO thread parent is still kept out of the channel', () => {
    const orphan = message({ id: 'step-orphan', message_kind: 'tool_step', thread_parent_id: null });
    expect(isChannelMessage(orphan)).toBe(false);
  });

  it('a tool step is excluded even if something flagged it broadcast', () => {
    const flagged = message({ id: 'step-flagged', message_kind: 'tool_step', broadcast_to_channel: true });
    expect(isChannelMessage(flagged)).toBe(false);
  });

  it('CONTROL: an ordinary top-level message is untouched by the kind filter', () => {
    // Without this, "return false" would pass both tests above and empty the
    // channel entirely.
    expect(isChannelMessage(message({ id: 'plain' }))).toBe(true);
    expect(isChannelMessage(message({ id: 'bcast', thread_parent_id: 'x', broadcast_to_channel: true }))).toBe(true);
  });

  it('filters orphaned steps out of a real transcript, keeping everything else', () => {
    const all = [
      message({ id: 'human', role: 'user' }),
      message({ id: 'step-1', message_kind: 'tool_step', thread_parent_id: null }),
      message({ id: 'step-2', message_kind: 'tool_step', thread_parent_id: 'human' }),
      message({ id: 'answer', thread_parent_id: 'human', broadcast_to_channel: true }),
    ];
    expect(channelMessages(all).map(m => m.id)).toEqual(['human', 'answer']);
  });
});
