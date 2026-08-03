import { describe, expect, it } from 'vitest';
import { DIFF_MAX_CELLS, describeDiff, diffHunks, diffLines } from '../../src/lib/textDiff';

// The library's compare view rests entirely on this. The failures that matter
// are the quiet ones: line numbers that are off by the size of the trimmed
// prefix, a CRLF checkout reported as differing on every line, and a diff that
// gives up on a big file without saying so.

describe('diffLines', () => {
  it('reports identical text as identical', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc');
    expect(result.identical).toBe(true);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.lines.every(line => line.op === 'equal')).toBe(true);
  });

  it('normalizes line endings before comparing', () => {
    // MUTATION: drop the \r normalization. The same file checked out on Windows
    // and on a Mac then differs on EVERY line — a diff that tells the reader
    // nothing at all about what changed.
    expect(diffLines('a\r\nb\r\nc', 'a\nb\nc').identical).toBe(true);
  });

  it('finds a single changed line in the middle', () => {
    const result = diffLines('a\nb\nc', 'a\nB\nc');
    expect(result.identical).toBe(false);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.lines.map(line => line.op)).toEqual(['equal', 'removed', 'added', 'equal']);
  });

  it('numbers lines in the ORIGINAL documents, not in the trimmed middle', () => {
    // MUTATION: drop `offset` in lcsDiff. Every number in the panel is then
    // wrong by exactly the length of the common prefix, which is the amount
    // hardest to notice.
    const result = diffLines('1\n2\n3\nOLD\n5\n6', '1\n2\n3\nNEW\n5\n6');
    const removed = result.lines.find(line => line.op === 'removed');
    const added = result.lines.find(line => line.op === 'added');
    expect(removed?.leftNumber).toBe(4);
    expect(removed?.rightNumber).toBeNull();
    expect(added?.rightNumber).toBe(4);
    expect(added?.leftNumber).toBeNull();
  });

  it('handles pure insertion and pure deletion', () => {
    const inserted = diffLines('a\nc', 'a\nb\nc');
    expect(inserted.added).toBe(1);
    expect(inserted.removed).toBe(0);

    const deleted = diffLines('a\nb\nc', 'a\nc');
    expect(deleted.added).toBe(0);
    expect(deleted.removed).toBe(1);
  });

  it('handles an empty side without inventing lines', () => {
    expect(diffLines('', '').identical).toBe(true);
    const added = diffLines('', 'a\nb');
    expect(added.added).toBe(2);
    expect(added.removed).toBe(0);
    const removed = diffLines('a\nb', '');
    expect(removed.added).toBe(0);
    expect(removed.removed).toBe(2);
  });

  it('says so rather than lying when the comparison is too large', () => {
    // Beyond DIFF_MAX_CELLS the LCS is abandoned. What must NOT happen is a
    // whole-file replacement presented as if it were a real diff.
    const size = Math.ceil(Math.sqrt(DIFF_MAX_CELLS)) + 10;
    const left = Array.from({ length: size }, (_, index) => `L${index}`).join('\n');
    const right = Array.from({ length: size }, (_, index) => `R${index}`).join('\n');
    const result = diffLines(left, right);
    expect(result.truncated).toBe(true);
    expect(result.identical).toBe(false);
  });

  it('stays exact on a one-line edit in a long document', () => {
    // The prefix/suffix trim is what keeps the cap generous rather than
    // binding: this is far beyond DIFF_MAX_CELLS unsliced, and must still
    // produce a real two-line diff.
    const size = 5000;
    const lines = Array.from({ length: size }, (_, index) => `line ${index}`);
    const edited = [...lines];
    edited[2500] = 'line 2500 CHANGED';
    const result = diffLines(lines.join('\n'), edited.join('\n'));
    expect(result.truncated).toBe(false);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });
});

describe('diffHunks', () => {
  it('returns nothing when there is nothing to show', () => {
    expect(diffHunks(diffLines('a\nb', 'a\nb'))).toEqual([]);
  });

  it('collapses long unchanged runs and says how many it dropped', () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const edited = [...lines];
    edited[5] = 'FIRST';
    edited[50] = 'SECOND';
    const hunks = diffHunks(diffLines(lines.join('\n'), edited.join('\n')));
    expect(hunks).toHaveLength(2);
    // MUTATION: discard `skipped`. The panel then implies the two changed
    // regions are adjacent, which is a claim about the document that is false.
    expect(hunks[1].skipped).toBeGreaterThan(0);
    expect(hunks.every(hunk => hunk.lines.length < 20)).toBe(true);
  });

  it('merges changes that are close enough to share context', () => {
    const result = diffLines('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne');
    expect(diffHunks(result, 3)).toHaveLength(1);
  });
});

describe('describeDiff', () => {
  it('summarises in the words the badge uses', () => {
    expect(describeDiff(diffLines('a', 'a'))).toBe('No differences');
    expect(describeDiff(diffLines('a\nb', 'a'))).toBe('−1');
    expect(describeDiff(diffLines('a', 'a\nb'))).toBe('+1');
    expect(describeDiff(diffLines('a\nb', 'a\nB'))).toBe('+1 −1');
  });
});
