import { describe, expect, it } from 'vitest';
import {
  EMPTY_STREAM_RESPONSE,
  extractSseDataLines,
  finalAssistantStreamContent,
  messageText,
  parseAiStreamPayload,
} from '../../src/lib/chatStream';

describe('chat stream parsing', () => {
  it('extracts Anthropic text deltas forwarded by the backend', () => {
    expect(parseAiStreamPayload({ delta: { text: 'hello' } })).toEqual({ text: 'hello', error: '' });
  });

  it('extracts OpenAI-compatible content deltas forwarded by the backend', () => {
    expect(parseAiStreamPayload({ choices: [{ delta: { content: 'hello' } }] })).toEqual({
      text: 'hello',
      error: '',
    });
  });

  it('extracts stream error events as displayable assistant content', () => {
    expect(parseAiStreamPayload({ error: { message: 'AI stream failed' } })).toEqual({
      text: '',
      error: 'AI stream failed',
    });
  });

  it('never finalizes an empty assistant placeholder', () => {
    expect(finalAssistantStreamContent('', 'AI stream failed')).toBe('AI stream failed');
    expect(finalAssistantStreamContent('', '')).toBe(EMPTY_STREAM_RESPONSE);
  });

  it('renders nested response content as text', () => {
    expect(messageText({ content: [{ text: 'part one' }, { text: 'part two' }] })).toBe('part one\npart two');
  });

  it('buffers incomplete SSE data lines across reads', () => {
    const first = extractSseDataLines('data: {"delta":{"text"');
    expect(first).toEqual({ data: [], remainder: 'data: {"delta":{"text"' });

    const second = extractSseDataLines(`${first.remainder}: "hello"}}\n\n`);
    expect(second).toEqual({ data: ['{"delta":{"text": "hello"}}'], remainder: '' });
  });

  it('can flush a final SSE data line without a trailing newline', () => {
    expect(extractSseDataLines('data: {"error":"failed"}', true)).toEqual({
      data: ['{"error":"failed"}'],
      remainder: '',
    });
  });
});
