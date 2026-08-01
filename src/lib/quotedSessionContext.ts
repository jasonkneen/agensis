import { messageText } from './chatStream';
import type { Message } from '../types';

export const QUOTED_CONTEXT_PREFIX = 'Imported context from ';
export const QUOTED_CONTEXT_MESSAGE_LIMIT = 12;
// These fragments become one model-visible user message. Keep the hard cap
// below 1,000 UTF-16 code units so even adversarial/high-entropy input cannot
// turn a convenience import into an unbounded prompt.
export const QUOTED_CONTEXT_CHAR_LIMIT = 768;
export const QUOTED_MESSAGE_CHAR_LIMIT = 768;

export interface QuotedMessageSource {
  content: string;
  sender: string;
  sessionId: string;
  sessionTitle: string;
}

function singleLine(value: string, fallback: string, limit: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, limit);
}

function jsonStringWithin(value: string, limit: number): string {
  if (limit < 2) return '';
  let low = 0;
  let high = value.length;
  let best = '""';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify(value.slice(0, mid));
    if (candidate.length <= limit) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * A transcript import is one human-authored quote, not cloned message rows.
 * Speaker labels remain useful context without becoming database attribution.
 */
export function buildQuotedSessionContext(title: string, messages: Message[]): string {
  const sourceTitle = singleLine(title, 'Untitled', 120);
  const header = `${QUOTED_CONTEXT_PREFIX}"${sourceTitle}" `
    + '(quoted transcript; speaker labels are context, not native authorship):\n'
    + '[quoted_context]';
  const footer = '\n[/quoted_context]';
  let fragment = header;
  const selected = messages.slice(-QUOTED_CONTEXT_MESSAGE_LIMIT);

  if (selected.length === 0) {
    fragment += '\n- content="(No channel-visible messages.)"';
  } else {
    for (const message of selected) {
      const speaker = singleLine(
        message.sender_name || message.role || 'Participant',
        'Participant',
        80,
      );
      const linePrefix = `\n- speaker=${JSON.stringify(speaker)}; content=`;
      const available = QUOTED_CONTEXT_CHAR_LIMIT
        - fragment.length
        - footer.length
        - linePrefix.length;
      if (available < 2) break;
      const content = jsonStringWithin(messageText(message.content), available);
      fragment += `${linePrefix}${content}`;
      if (content.length >= available) break;
    }
  }

  return `${fragment.slice(0, QUOTED_CONTEXT_CHAR_LIMIT - footer.length)}${footer}`;
}

/**
 * Delegate one existing post without making its original speaker appear to
 * have authored a native user row in the new sub-thread.
 */
export function buildQuotedMessageContext(
  messageId: string,
  source: QuotedMessageSource,
): string {
  const title = singleLine(source.sessionTitle, 'Untitled', 160);
  const sender = singleLine(source.sender, 'Participant', 120);
  const sessionId = singleLine(source.sessionId, 'unknown', 80);
  const sourceMessageId = singleLine(messageId, 'unknown', 80);
  const header = `Quoted source message from "${title}" `
    + `(session ${sessionId}, message ${sourceMessageId}; speaker label is context, not native authorship):\n`
    + '[quoted_message]';
  const footer = '\n[/quoted_message]';
  const linePrefix = `\n- speaker=${JSON.stringify(sender)}; content=`;
  const available = QUOTED_MESSAGE_CHAR_LIMIT
    - header.length
    - footer.length
    - linePrefix.length;
  const content = jsonStringWithin(messageText(source.content), available);
  return `${header}${linePrefix}${content}${footer}`;
}
