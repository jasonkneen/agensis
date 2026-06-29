export const EMPTY_STREAM_RESPONSE = 'AI response finished without content.';

export function messageText(value: unknown): string {
  if (typeof value === 'string') {
    return value === '[object Object]' ? 'Response could not be rendered as text.' : value;
  }
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const record = value as {
      text?: unknown;
      content?: unknown;
      message?: unknown;
      error?: unknown;
      delta?: unknown;
      output?: unknown;
      response?: unknown;
    };
    for (const key of ['text', 'content', 'message', 'error', 'delta', 'output', 'response'] as const) {
      const text = messageText(record[key]);
      if (text) return text;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return 'Response could not be rendered as text.';
    }
  }
  return String(value);
}

export function parseAiStreamPayload(payload: unknown): { text: string; error: string } {
  if (!payload || typeof payload !== 'object') {
    return { text: messageText(payload), error: '' };
  }

  const record = payload as {
    delta?: { text?: unknown; content?: unknown };
    choices?: Array<{ delta?: { content?: unknown } }>;
    text?: unknown;
    content?: unknown;
    message?: unknown;
    error?: unknown;
  };

  const error = messageText(record.error);
  if (error) return { text: '', error };

  return {
    text: messageText(
      record.delta?.text ??
      record.delta?.content ??
      record.choices?.[0]?.delta?.content ??
      record.text ??
      record.content ??
      record.message,
    ),
    error: '',
  };
}

export function finalAssistantStreamContent(fullContent: string, streamError: string): string {
  return fullContent || streamError || EMPTY_STREAM_RESPONSE;
}

export function extractSseDataLines(buffer: string, flush = false): { data: string[]; remainder: string } {
  const lines = buffer.split('\n');
  const remainder = !flush && !buffer.endsWith('\n') ? lines.pop() ?? '' : '';
  const data = lines
    .map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice(6));

  return { data, remainder };
}
