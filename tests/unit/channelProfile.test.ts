import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  CHANNEL_ICONS, channelIconChoices, channelIconGlyph, channelProfileDiff,
  MAX_INTENT_CHARS, normalizeChannelIcon, normalizeChannelIntent,
  type ChannelProfileDraft,
  normalizeChannelDescription,
} from '../../src/lib/channelProfile';

const require_ = createRequire(import.meta.url);
const shared = require_('../../shared/channelIntent.cjs');

// PARITY. The normalizers exist twice — here (browser) and in
// shared/channelIntent.cjs (server, which injects the intent into agent turns).
// They cannot be one file: shared/*.cjs must never enter the browser bundle. So
// both run the SAME fixture table, and the answers must be identical. Without
// this, the field a human edits and the text an agent reads could drift apart,
// and the symptom would be an intent that looks saved but changes nothing.
describe('parity with the server implementation', () => {
  it('agrees on every fixture input', () => {
    const mine = shared.parityAnswers({
      normalizeChannelIcon,
      normalizeChannelIntent,
      normalizeChannelDescription,
    });
    expect(mine).toEqual(shared.parityAnswers(shared));
  });

  it('shares the icon set and the character limits', () => {
    expect([...CHANNEL_ICONS]).toEqual(shared.CHANNEL_ICONS);
    expect(MAX_INTENT_CHARS).toBe(shared.MAX_INTENT_CHARS);
  });
});

const base: ChannelProfileDraft = { title: 'general', description: 'Chat', icon: 'hash', intent: 'Be brief.' };

describe('channelProfileDiff', () => {
  it('returns null when nothing changed', () => {
    expect(channelProfileDiff({ ...base }, base)).toBeNull();
  });

  it('sends ONLY the changed field', () => {
    // A full-object save would rewrite the intent every time someone renames
    // the channel, and two people editing different fields would clobber
    // each other — the same bug the agent detail form had.
    expect(channelProfileDiff({ ...base, title: 'random' }, base)).toEqual({ title: 'random' });
    expect(channelProfileDiff({ ...base, intent: 'Be playful.' }, base)).toEqual({ intent: 'Be playful.' });
  });

  it('refuses an empty title rather than saving an unreachable channel', () => {
    expect(channelProfileDiff({ ...base, title: '   ' }, base)).toBeNull();
    // ...but still saves other fields edited in the same pass.
    expect(channelProfileDiff({ ...base, title: '', icon: 'coffee' }, base)).toEqual({ icon: 'coffee' });
  });

  it('treats clearing a field as a real change', () => {
    expect(channelProfileDiff({ ...base, intent: '' }, base)).toEqual({ intent: '' });
    expect(channelProfileDiff({ ...base, icon: '' }, base)).toEqual({ icon: '' });
  });

  it('normalizes before comparing, so cosmetic whitespace is not a change', () => {
    expect(channelProfileDiff({ ...base, intent: '  Be brief.  ' }, base)).toBeNull();
    expect(channelProfileDiff({ ...base, icon: 'HASH' }, base)).toBeNull();
  });
});

describe('icons', () => {
  it('every listed key resolves to a distinct glyph', () => {
    const glyphs = new Set(CHANNEL_ICONS.map(key => channelIconGlyph(key)));
    expect(glyphs.size).toBe(CHANNEL_ICONS.length);
    expect(channelIconChoices()).toHaveLength(CHANNEL_ICONS.length);
  });

  it('an unknown key falls back instead of throwing — a newer client may have saved it', () => {
    expect(normalizeChannelIcon('not-a-real-icon')).toBe('');
    expect(() => channelIconGlyph('not-a-real-icon')).not.toThrow();
    expect(channelIconGlyph('not-a-real-icon')).toBe(channelIconGlyph('hash'));
    expect(channelIconGlyph(null)).toBe(channelIconGlyph('hash'));
  });
});

describe('normalizeChannelIntent', () => {
  it('keeps single newlines (an intent is often a short list)', () => {
    expect(normalizeChannelIntent('one\ntwo')).toBe('one\ntwo');
  });

  it('collapses paste artefacts and caps runaway length', () => {
    expect(normalizeChannelIntent('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeChannelIntent('x'.repeat(MAX_INTENT_CHARS + 500))).toHaveLength(MAX_INTENT_CHARS);
  });
});
