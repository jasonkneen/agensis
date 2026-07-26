import { describe, expect, it } from 'vitest';
import {
  COMPOSER_NAME_MAX_CHARS,
  SUB_THREAD_COMPOSER_PLACEHOLDER,
  THREAD_COMPOSER_PLACEHOLDER,
  channelComposerPlaceholder,
  directMessageComposerPlaceholder,
  truncateComposerName,
} from '../../src/lib/composerPlaceholder';

// Placeholder length is a layout constraint here, not a style preference: the
// composer textareas are field-sizing boxes, so an empty one is as tall as its
// placeholder needs. A channel placeholder that wraps makes the channel
// composer taller than the thread composer sitting next to it. Every case below
// is really asserting "this still fits on one line".

// The channel that triggered the bug — a title someone used as a scratch note.
const LONG_TITLE = 'agensis-agent: state-dir --add-dir fix + self-reload/rollback';

describe('truncateComposerName', () => {
  it('leaves a short name alone', () => {
    expect(truncateComposerName('general')).toBe('general');
    expect(truncateComposerName('code-review')).toBe('code-review');
  });

  it('keeps every result within the budget', () => {
    for (const name of [LONG_TITLE, 'a'.repeat(200), 'one two three four five six seven eight']) {
      // +1 for the ellipsis the clip appends.
      expect(truncateComposerName(name).length).toBeLessThanOrEqual(COMPOSER_NAME_MAX_CHARS + 1);
    }
  });

  it('clips a long title on a word boundary and marks the clip', () => {
    expect(truncateComposerName(LONG_TITLE)).toBe('agensis-agent…');
  });

  it('hard-clips when there is no usable word boundary', () => {
    // A single long slug: no space to break on, so cut at the budget.
    expect(truncateComposerName('supercalifragilistic-expialidocious-channel')).toBe(
      'supercalifragilistic-exp…',
    );
  });

  it('does not leave dangling punctuation before the ellipsis', () => {
    expect(truncateComposerName('Release notes: aVeryLongUnbrokenWord')).toBe('Release notes…');
  });

  it('collapses newlines and runs of whitespace', () => {
    expect(truncateComposerName('  design\n  review  ')).toBe('design review');
  });

  it('honours an explicit budget', () => {
    expect(truncateComposerName('one two three', 7)).toBe('one two…');
  });
});

describe('channelComposerPlaceholder', () => {
  it('names the channel and nothing else', () => {
    expect(channelComposerPlaceholder('general')).toBe('Message #general');
  });

  it('falls back to #general when the title is missing', () => {
    expect(channelComposerPlaceholder('')).toBe('Message #general');
    expect(channelComposerPlaceholder(null)).toBe('Message #general');
    expect(channelComposerPlaceholder(undefined)).toBe('Message #general');
  });

  it('does not double up the hash', () => {
    expect(channelComposerPlaceholder('#design')).toBe('Message #design');
  });

  it('shortens a paragraph-length title instead of wrapping', () => {
    expect(channelComposerPlaceholder(LONG_TITLE)).toBe('Message #agensis-agent…');
  });

  it('drops the affordance list the old placeholder carried', () => {
    const text = channelComposerPlaceholder(LONG_TITLE);
    expect(text).not.toContain('@agent');
    expect(text).not.toContain('documents');
    expect(text).not.toContain('canvas groups');
  });
});

describe('directMessageComposerPlaceholder', () => {
  it('names the agent', () => {
    expect(directMessageComposerPlaceholder('Coder')).toBe('Message Coder');
  });

  it('falls back when the agent has no name yet', () => {
    expect(directMessageComposerPlaceholder('')).toBe('Message agent');
    expect(directMessageComposerPlaceholder(null)).toBe('Message agent');
  });

  it('shortens an over-long agent name', () => {
    expect(directMessageComposerPlaceholder('The Extremely Verbose Research Assistant')).toBe(
      'Message The Extremely Verbose…',
    );
  });
});

describe('panel placeholders', () => {
  it('stay one short line, like the channel one', () => {
    for (const text of [THREAD_COMPOSER_PLACEHOLDER, SUB_THREAD_COMPOSER_PLACEHOLDER]) {
      expect(text.length).toBeLessThanOrEqual('Message #'.length + COMPOSER_NAME_MAX_CHARS + 1);
      expect(text).not.toContain('@');
      expect(text).not.toContain('/ commands');
    }
  });
});
