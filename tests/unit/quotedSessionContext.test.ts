import { describe, expect, it } from 'vitest';
import {
  buildQuotedMessageContext,
  buildQuotedSessionContext,
  QUOTED_CONTEXT_CHAR_LIMIT,
  QUOTED_CONTEXT_MESSAGE_LIMIT,
  QUOTED_CONTEXT_PREFIX,
  QUOTED_MESSAGE_CHAR_LIMIT,
} from '../../src/lib/quotedSessionContext';
import type { Message } from '../../src/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function message(index: number, content = `message ${index}`): Message {
  return {
    id: `message-${index}`,
    session_id: 'session-1',
    role: index % 2 ? 'assistant' : 'user',
    sender_name: index % 2 ? 'Agent' : 'Alice',
    content,
    created_at: new Date(1_700_000_000_000 + index).toISOString(),
  };
}

describe('quoted session context', () => {
  it('labels the transcript as quoted context instead of cloning attribution', () => {
    const content = buildQuotedSessionContext('Incident room', [message(0), message(1)]);
    expect(content).toContain(`${QUOTED_CONTEXT_PREFIX}"Incident room"`);
    expect(content).toContain('speaker labels are context, not native authorship');
    expect(content).toContain('[quoted_context]');
    expect(content).toContain('speaker="Alice"; content="message 0"');
    expect(content).toContain('speaker="Agent"; content="message 1"');
    expect(content).toContain('[/quoted_context]');
  });

  it('caps both imported rows and final content', () => {
    const rows = Array.from(
      { length: QUOTED_CONTEXT_MESSAGE_LIMIT + 10 },
      (_, index) => message(index, `${index}-${'x'.repeat(500)}`),
    );
    const content = buildQuotedSessionContext('Large transcript', rows);
    expect(content.length).toBeLessThanOrEqual(QUOTED_CONTEXT_CHAR_LIMIT);
    expect(QUOTED_CONTEXT_CHAR_LIMIT).toBeLessThan(1_000);
    expect(QUOTED_CONTEXT_MESSAGE_LIMIT).toBeLessThanOrEqual(12);
    expect(content).not.toContain('content="0-');
    expect(content).toContain('content="10-');
    expect(content.endsWith('[/quoted_context]')).toBe(true);
  });

  it('labels a delegated source post without cloning its speaker attribution', () => {
    const content = buildQuotedMessageContext('message-7', {
      content: 'Implement the database migration.',
      sender: 'Agent Ada',
      sessionId: 'session-1',
      sessionTitle: 'Release room',
    });
    expect(content).toContain('Quoted source message from "Release room"');
    expect(content).toContain('session session-1, message message-7');
    expect(content).toContain('speaker label is context, not native authorship');
    expect(content).toContain('[quoted_message]');
    expect(content).toContain('speaker="Agent Ada"; content="Implement the database migration."');
    expect(content.endsWith('[/quoted_message]')).toBe(true);
  });

  it('bounds delegated post content and flattens provenance labels', () => {
    const content = buildQuotedMessageContext('message-8', {
      content: 'x'.repeat(QUOTED_MESSAGE_CHAR_LIMIT * 2),
      sender: 'Agent\nAda',
      sessionId: 'session-2',
      sessionTitle: 'Release\nroom',
    });
    expect(content.length).toBeLessThanOrEqual(QUOTED_MESSAGE_CHAR_LIMIT);
    expect(QUOTED_MESSAGE_CHAR_LIMIT).toBeLessThan(1_000);
    expect(content).toContain('from "Release room"');
    expect(content).toContain('speaker="Agent Ada"; content=');
  });

  it('over-fetches before filtering to the final channel-visible quote window', () => {
    const hook = readFileSync(join(__dirname, '../../src/hooks/useChat.ts'), 'utf8');
    expect(hook).toContain(
      'const QUOTED_CONTEXT_FETCH_LIMIT = QUOTED_CONTEXT_MESSAGE_LIMIT * 4',
    );
    expect(hook).toMatch(
      /channelMessages\([\s\S]*?\.slice\(0, QUOTED_CONTEXT_MESSAGE_LIMIT\)[\s\S]*?\.reverse\(\)/,
    );
  });
});
