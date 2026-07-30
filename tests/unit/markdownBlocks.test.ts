// Guards src/lib/markdownBlocks.ts.
//
// The headline tests are the TERMINATION ones. parseBlocks used to infinite-loop
// on any line that is a list/heading marker with no text after it ("- ", "## ",
// "1. ", "* "): the outer branches all require content via `(.+)$` so none of them
// matched, but the paragraph branch's break test matched on the marker prefix and
// fired before consuming a line — so `i` never advanced and the loop pushed empty
// paragraphs until the array length overflowed. A hard browser freeze, reachable
// two ways:
//
//   - streaming: a token boundary right after "- " is routine in any bulleted reply
//   - persisted: a stored message with such a line froze the tab EVERY time that
//     conversation was opened
//
// Note on failure mode: a reintroduced hang blocks the event loop, so vitest cannot
// time it out — the run will wedge until the array overflows and throws RangeError.
// Ugly, but it does fail loudly. Don't "fix" a hang here by loosening these tests.

import { describe, it, expect } from 'vitest';
import { parseBlocks, closeOpenMarkers, parseFrontmatter } from '../../src/lib/markdownBlocks';

describe('parseBlocks terminates on degenerate marker lines', () => {
  const degenerate: Array<[string, string]> = [
    ['bullet marker, no text', 'intro\n- '],
    ['star bullet, no text', 'intro\n* '],
    ['numbered marker, no text', 'intro\n1. '],
    ['h1 marker, no text', 'intro\n# '],
    ['h2 marker, no text', 'intro\n## '],
    ['h3 marker, no text', 'intro\n### '],
    ['marker as the only content', '- '],
    ['marker mid-message', '## \nmore text after'],
    ['marker with trailing spaces', 'intro\n-   '],
    ['indented bullet, no text', 'intro\n  - '],
    ['consecutive degenerate markers', '- \n## \n1. '],
    ['fence-ish line that is not a valid fence', 'intro\n```ts extra stuff'],
  ];

  for (const [name, input] of degenerate) {
    it(`terminates: ${name}`, () => {
      const blocks = parseBlocks(input);
      expect(Array.isArray(blocks)).toBe(true);
      // A non-advancing loop would emit far more blocks than there are lines.
      expect(blocks.length).toBeLessThanOrEqual(input.split('\n').length);
    });
  }
});

describe('parseBlocks terminates on every prefix of a streamed message', () => {
  // Exactly what streaming does: content grows a character at a time and the
  // whole message is re-parsed on each token. Every intermediate state must parse.
  const message = [
    '## Plan',
    '',
    'Here is the approach.',
    '',
    '- first step',
    '- second step',
    '',
    '1. ordered one',
    '2. ordered two',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '> a quote',
  ].join('\n');

  it('every prefix parses and terminates', () => {
    for (let end = 0; end <= message.length; end++) {
      const prefix = message.slice(0, end);
      const blocks = parseBlocks(prefix);
      expect(blocks.length).toBeLessThanOrEqual(prefix.split('\n').length + 1);
    }
  });

  it('every prefix parses after closeOpenMarkers (the real streaming path)', () => {
    for (let end = 0; end <= message.length; end++) {
      const prefix = closeOpenMarkers(message.slice(0, end));
      const blocks = parseBlocks(prefix);
      expect(Array.isArray(blocks)).toBe(true);
    }
  });
});

describe('parseBlocks still parses correctly (no behaviour regression)', () => {
  it('parses a heading', () => {
    expect(parseBlocks('## Title')).toEqual([{ type: 'heading', level: 2, content: 'Title' }]);
  });

  it('parses an unordered list', () => {
    expect(parseBlocks('- one\n- two')).toEqual([
      { type: 'list', ordered: false, items: ['one', 'two'] },
    ]);
  });

  it('parses an ordered list', () => {
    expect(parseBlocks('1. one\n2. two')).toEqual([
      { type: 'list', ordered: true, items: ['one', 'two'] },
    ]);
  });

  it('parses a fenced code block with a language', () => {
    expect(parseBlocks('```ts\nconst x = 1;\n```')).toEqual([
      { type: 'code', language: 'ts', content: 'const x = 1;' },
    ]);
  });

  it('parses a table', () => {
    expect(parseBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual([
      { type: 'table', rows: [['a', 'b'], ['1', '2']] },
    ]);
  });

  it('parses a blockquote', () => {
    expect(parseBlocks('> quoted')).toEqual([{ type: 'blockquote', content: 'quoted' }]);
  });

  // The reason the paragraph break test exists at all: a heading that follows a
  // paragraph with no blank line between them must still become its own block.
  // The termination guard must not break this.
  it('breaks a paragraph when a heading follows with no blank line', () => {
    expect(parseBlocks('some text\n## Heading')).toEqual([
      { type: 'paragraph', content: 'some text' },
      { type: 'heading', level: 2, content: 'Heading' },
    ]);
  });

  it('breaks a paragraph when a list follows with no blank line', () => {
    expect(parseBlocks('some text\n- item')).toEqual([
      { type: 'paragraph', content: 'some text' },
      { type: 'list', ordered: false, items: ['item'] },
    ]);
  });

  it('breaks a paragraph when a fence follows with no blank line', () => {
    expect(parseBlocks('some text\n```\ncode\n```')).toEqual([
      { type: 'paragraph', content: 'some text' },
      { type: 'code', language: '', content: 'code' },
    ]);
  });

  it('keeps soft-wrapped lines in one paragraph', () => {
    expect(parseBlocks('line one\nline two')).toEqual([
      { type: 'paragraph', content: 'line one\nline two' },
    ]);
  });
});

describe('frontmatter', () => {
  it('reads a name/description block', () => {
    const fm = parseFrontmatter('---\nname: thing\ndescription: does stuff\n---\nbody text');
    expect(fm?.meta.name).toBe('thing');
    expect(fm?.body).toBe('body text');
  });

  it('returns null when there is no frontmatter', () => {
    expect(parseFrontmatter('just text')).toBeNull();
  });
});
