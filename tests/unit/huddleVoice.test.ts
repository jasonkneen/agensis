import { describe, expect, it } from 'vitest';
import {
  ECHO_TAIL_MS,
  pickSpeechVoice,
  MAX_SPEECH_CHARS,
  echoGuardUntil,
  isSpeakableAgentMessage,
  nextSpeechChunk,
  normalizeTranscript,
  speechItemFor,
  speechTextFromMarkdown,
  trailingCaption,
  truncateForSpeech,
  type VoiceMessage,
} from '../../src/lib/huddleVoice';

// Voice in a huddle is text at both ends: speech becomes a chat message on the
// human's machine, and an agent's chat message becomes speech on the same
// machine. The agent never touches audio — so every decision that can be wrong
// is a pure string decision, and all of them live here.
//
// The three that matter:
//   1. WHAT GETS SPOKEN. Reading a "Thinking 0s" placeholder, a tool chip, the
//      human's own transcript coming back, or the channel backlog aloud each
//      break a call in a way silence does not.
//   2. WHAT IT SOUNDS LIKE. A fenced diff read aloud is ninety seconds of
//      punctuation nobody can act on; it is already on screen.
//   3. HOW MUCH IS LEFT. A streaming message is spoken in pieces, so the same
//      sentence must never be read twice.

const JOINED = Date.parse('2026-07-25T12:00:00.000Z');
const AFTER = '2026-07-25T12:00:05.000Z';
const BEFORE = '2026-07-25T11:59:55.000Z';

function agentMessage(over: Partial<VoiceMessage> = {}): VoiceMessage {
  return {
    id: 'm1',
    content: 'All done.',
    sender_kind: 'agent',
    sender_name: 'Coder',
    created_at: AFTER,
    ...over,
  };
}

describe('speechTextFromMarkdown', () => {
  it('flattens inline markdown to what a person would say', () => {
    expect(speechTextFromMarkdown('**Done** — see `src/App.tsx` for the *fix*'))
      .toBe('Done — see src/App.tsx for the fix');
  });

  it('reads a link as its label, and a bare URL as "link"', () => {
    expect(speechTextFromMarkdown('Check [the docs](https://example.com/a/b)')).toBe('Check the docs');
    expect(speechTextFromMarkdown('Deployed: https://agensis.io/x')).toBe('Deployed: link');
  });

  it('drops an image to its alt text without leaving the "!"', () => {
    expect(speechTextFromMarkdown('![a chart](https://example.com/c.png) is attached'))
      .toBe('a chart is attached');
  });

  it('says the handle, not "at handle"', () => {
    expect(speechTextFromMarkdown('@ada can take it from here')).toBe('ada can take it from here');
  });

  it('drops code fences and tables — they are unlistenable and already on screen', () => {
    const withCode = 'Here is the fix.\n\n```ts\nconst x = 1 < 2 && 3 > 2;\n```\n\nShipped.';
    expect(speechTextFromMarkdown(withCode)).toBe('Here is the fix. Shipped.');

    const withTable = 'Results:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nThat is all.';
    expect(speechTextFromMarkdown(withTable)).toBe('Results: That is all.');
  });

  it('returns nothing for a message that is ONLY code', () => {
    expect(speechTextFromMarkdown('```js\nconsole.log(1);\n```')).toBe('');
  });

  it('puts a beat between list items instead of running them together', () => {
    expect(speechTextFromMarkdown('- first\n- second\n- third')).toBe('first. second. third');
  });

  it('drops horizontal rules', () => {
    expect(speechTextFromMarkdown('Before\n\n---\n\nAfter')).toBe('Before. After');
  });

  it('never returns markup, even when the message contains HTML', () => {
    const spoken = speechTextFromMarkdown('<b>bold</b> and <img src=x onerror=alert(1)> text');
    expect(spoken).not.toContain('<');
    expect(spoken).toContain('bold');
  });

  it('is empty for empty, whitespace and non-string content', () => {
    expect(speechTextFromMarkdown('')).toBe('');
    expect(speechTextFromMarkdown('   \n  ')).toBe('');
    expect(speechTextFromMarkdown(null)).toBe('');
    expect(speechTextFromMarkdown({ text: 'hi' })).toBe('');
  });
});

describe('isSpeakableAgentMessage', () => {
  it('speaks an agent message', () => {
    expect(isSpeakableAgentMessage(agentMessage())).toBe(true);
  });

  it('never speaks the human — including their own transcript coming back', () => {
    expect(isSpeakableAgentMessage(agentMessage({ sender_kind: 'user', content: 'hey coder' }))).toBe(false);
  });

  it('never speaks a tool-step chip', () => {
    expect(isSpeakableAgentMessage(agentMessage({ message_kind: 'tool_step', content: 'Read src/App.tsx' })))
      .toBe(false);
  });

  it('never speaks the live activity placeholder', () => {
    // The shape the daemon actually writes, and keeps UPDATEing roughly once a
    // second while the model reasons.
    expect(isSpeakableAgentMessage(agentMessage({ content: 'Thinking 0s' }))).toBe(false);
    expect(isSpeakableAgentMessage(agentMessage({ content: 'Thinking 12s' }))).toBe(false);
    expect(isSpeakableAgentMessage(agentMessage({ content: 'thinking…' }))).toBe(false);
  });

  it('never speaks a deleted message', () => {
    expect(isSpeakableAgentMessage(agentMessage({ deleted_at: AFTER }))).toBe(false);
  });

  it('stays quiet for a code-only reply rather than reading punctuation', () => {
    expect(isSpeakableAgentMessage(agentMessage({ content: '```sh\nnpm run build\n```' }))).toBe(false);
  });

  it('is false for nothing at all', () => {
    expect(isSpeakableAgentMessage(null)).toBe(false);
    expect(isSpeakableAgentMessage(undefined)).toBe(false);
  });
});

describe('speechItemFor', () => {
  it('speaks a message written after we joined', () => {
    expect(speechItemFor(agentMessage(), JOINED)).toEqual({ id: 'm1', text: 'All done.', speaker: 'Coder' });
  });

  it('never reads the backlog aloud on join', () => {
    expect(speechItemFor(agentMessage({ created_at: BEFORE }), JOINED)).toBeNull();
  });

  it('treats an unparseable timestamp as backlog (fail quiet)', () => {
    expect(speechItemFor(agentMessage({ created_at: 'nonsense' }), JOINED)).toBeNull();
    expect(speechItemFor(agentMessage({ created_at: null }), JOINED)).toBeNull();
  });

  it('needs an id', () => {
    expect(speechItemFor(agentMessage({ id: undefined }), JOINED)).toBeNull();
  });

  it('falls back to "Agent" when the row has no sender name', () => {
    expect(speechItemFor(agentMessage({ sender_name: '  ' }), JOINED)?.speaker).toBe('Agent');
  });
});

describe('nextSpeechChunk', () => {
  it('says the whole thing when nothing has been said yet', () => {
    expect(nextSpeechChunk('On it — checking now.', '')).toBe('On it — checking now.');
  });

  it('says only the new tail when a streaming message grows', () => {
    expect(nextSpeechChunk('On it. The build passed.', 'On it.')).toBe('The build passed.');
  });

  it('says nothing when the text has not changed', () => {
    expect(nextSpeechChunk('On it.', 'On it.')).toBe('');
  });

  it('says nothing when the message was rewritten rather than extended', () => {
    // Repeating a paragraph the listener already heard is worse than dropping
    // the tail of a rare rewrite.
    expect(nextSpeechChunk('Actually, no.', 'On it.')).toBe('');
  });

  it('caps one utterance so an agent cannot talk for two minutes', () => {
    const wall = `${'word '.repeat(600)}end.`;
    const chunk = nextSpeechChunk(wall, '');
    expect(chunk.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(chunk.length).toBeGreaterThan(0);
  });

  it('is empty for empty input', () => {
    expect(nextSpeechChunk('', '')).toBe('');
    expect(nextSpeechChunk('', 'said')).toBe('');
  });
});

describe('truncateForSpeech', () => {
  it('leaves a short line alone', () => {
    expect(truncateForSpeech('Short.', 100)).toBe('Short.');
  });

  it('cuts at a sentence when there is one', () => {
    expect(truncateForSpeech('One sentence. Then a very long tail that runs on', 20)).toBe('One sentence.');
  });

  it('never cuts mid-word', () => {
    const cut = truncateForSpeech('supercalifragilistic expialidocious antidisestablishment', 30);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain('expialido…');
  });
});

describe('normalizeTranscript', () => {
  it('trims the leading space every continuous result carries', () => {
    expect(normalizeTranscript(' hello there')).toBe('hello there');
  });

  it('collapses runs of whitespace', () => {
    expect(normalizeTranscript('what  is\n the  status')).toBe('what is the status');
  });

  it('is empty for whitespace, so an empty final never posts a message', () => {
    expect(normalizeTranscript('   ')).toBe('');
    expect(normalizeTranscript('\n\t')).toBe('');
  });

  it('is empty for anything that is not a string', () => {
    expect(normalizeTranscript(undefined)).toBe('');
    expect(normalizeTranscript(42)).toBe('');
  });
});

describe('trailingCaption', () => {
  it('shows a short transcript in full', () => {
    expect(trailingCaption('what is the status')).toBe('what is the status');
  });

  it('keeps the END of a long one — the words being said right now', () => {
    const long = `${'a'.repeat(200)}the newest words`;
    const caption = trailingCaption(long, 20);
    expect(caption.endsWith('the newest words')).toBe(true);
    expect(caption.startsWith('…')).toBe(true);
  });
});

describe('echoGuardUntil', () => {
  it('blocks the whole time the browser is talking', () => {
    expect(echoGuardUntil(true, 1_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps blocking for a moment after, for words already in the buffer', () => {
    expect(echoGuardUntil(false, 1_000)).toBe(1_000 + ECHO_TAIL_MS);
  });
});

describe('pickSpeechVoice', () => {
  const v = (name: string, lang = 'en-US', localService = true) =>
    ({ name, lang, localService, voiceURI: name, default: false }) as SpeechSynthesisVoice;

  it('prefers a Natural neural voice over the default local one', () => {
    const picked = pickSpeechVoice([
      v('Albert'),
      v('Microsoft Ava Online (Natural) - English (United States)', 'en-US', false),
      v('Daniel'),
    ]);
    expect(picked?.name).toContain('Natural');
  });

  it('prefers a remote voice over a local one when no neural voice exists', () => {
    const picked = pickSpeechVoice([v('Albert'), v('Google US English', 'en-US', false)]);
    expect(picked?.name).toBe('Google US English');
  });

  it('returns null when only plain local voices exist, so the platform default wins', () => {
    expect(pickSpeechVoice([v('Albert'), v('Daniel')])).toBeNull();
  });

  it('matches the requested language before quality', () => {
    const picked = pickSpeechVoice(
      [v('Microsoft Ava Online (Natural)', 'en-US', false), v('Microsoft Denise Online (Natural)', 'fr-FR', false)],
      'fr',
    );
    expect(picked?.lang).toBe('fr-FR');
  });

  it('handles an empty voice list', () => {
    expect(pickSpeechVoice([])).toBeNull();
  });
});
