import { describe, expect, it } from 'vitest';
import { SHORT_PATH_BUDGET, shortenPath, shortenPathsIn } from '../../src/lib/shortPath';

// A shortened path is a LABEL, and a label that points at the wrong file is worse
// than no label. So the cases that matter here are the ones where the function
// must not cut: something already short, something with no separators at all, and
// anything that is not a path in the first place. The tail is the part a person
// scans, so every cut has to come off the head.

describe('shortenPath', () => {
  it('collapses a home directory to ~ and leaves the rest alone', () => {
    expect(shortenPath('/Users/jkneen/Documents/notes.md')).toBe('~/Documents/notes.md');
    expect(shortenPath('/home/jkneen/src/main.rs')).toBe('~/src/main.rs');
    // The home directory itself, with nothing under it.
    expect(shortenPath('/Users/jkneen')).toBe('~');
  });

  it('does not mistake a sibling of the home root for a home directory', () => {
    // /Users and /homes are not /Users/<someone> and /home/<someone>.
    expect(shortenPath('/Users')).toBe('/Users');
    expect(shortenPath('/homes/shared/x.txt')).toBe('/homes/shared/x.txt');
  });

  it('drops leading segments from a long nested path so the file survives', () => {
    const long = '/Users/jkneen/Documents/GitHub/agensis-agent/.worktrees/x/src/App.tsx';
    expect(shortenPath(long)).toBe('…/agensis-agent/.worktrees/x/src/App.tsx');
    expect(shortenPath(long).length).toBeLessThanOrEqual(SHORT_PATH_BUDGET);
    // The distinguishing end is intact, byte for byte.
    expect(shortenPath(long).endsWith('/x/src/App.tsx')).toBe(true);
  });

  it('shortens two sibling paths to something that still tells them apart', () => {
    const base = '/Users/jkneen/Documents/GitHub/agensis-agent/.worktrees';
    expect(shortenPath(`${base}/alpha/src/App.tsx`)).not.toBe(shortenPath(`${base}/beta/src/App.tsx`));
  });

  it('elides a path with no home prefix from the front too', () => {
    expect(shortenPath('/var/folders/xy/T/very/deep/nested/thing/file.txt'))
      .toBe('…/xy/T/very/deep/nested/thing/file.txt');
  });

  it('leaves a short path exactly as given', () => {
    expect(shortenPath('src/App.tsx')).toBe('src/App.tsx');
    expect(shortenPath('/etc/hosts')).toBe('/etc/hosts');
    expect(shortenPath('~/src/App.tsx')).toBe('~/src/App.tsx');
  });

  it('leaves a string with no separators alone however long it is', () => {
    const bare = 'ExtremelyLongSingleWordWithNoSeparatorsWhatsoeverGoesHere.tsx';
    expect(bare.length).toBeGreaterThan(SHORT_PATH_BUDGET);
    expect(shortenPath(bare)).toBe(bare);
    expect(shortenPath('App.tsx')).toBe('App.tsx');
  });

  it('never cuts below the filename and one parent, however long they are', () => {
    const huge = `/Users/jkneen/deep/${'a'.repeat(40)}/${'b'.repeat(40)}`;
    expect(shortenPath(huge)).toBe(`…/${'a'.repeat(40)}/${'b'.repeat(40)}`);
  });

  it('handles Windows paths with backslashes', () => {
    expect(shortenPath('C:\\Users\\jkneen\\Documents\\notes.md')).toBe('~\\Documents\\notes.md');
    expect(shortenPath('C:\\Users\\jkneen\\Documents\\GitHub\\agensis-agent\\.worktrees\\x\\src\\App.tsx'))
      .toBe('…\\agensis-agent\\.worktrees\\x\\src\\App.tsx');
    // A drive root that is not a home directory still elides from the head.
    expect(shortenPath('D:\\builds\\nightly\\2026\\07\\artifacts\\output\\bundle.zip'))
      .toBe('…\\2026\\07\\artifacts\\output\\bundle.zip');
  });

  it('returns an empty string for empty or non-string input', () => {
    expect(shortenPath('')).toBe('');
    expect(shortenPath(undefined as unknown as string)).toBe('');
    expect(shortenPath(null as unknown as string)).toBe('');
    expect(shortenPath(42 as unknown as string)).toBe('');
  });

  it('honours a caller-supplied budget', () => {
    const path = '/Users/jkneen/Documents/GitHub/agensis/src/App.tsx';
    expect(shortenPath(path, { budget: 200 })).toBe('~/Documents/GitHub/agensis/src/App.tsx');
    expect(shortenPath(path, { budget: 20 })).toBe('…/src/App.tsx');
  });
});

describe('shortenPathsIn', () => {
  it('shortens the path inside an agent step line and keeps everything else', () => {
    expect(shortenPathsIn('Coder: Edit · /Users/jkneen/Documents/GitHub/agensis-agent/.worktrees/x/src/App.tsx'))
      .toBe('Coder: Edit · …/agensis-agent/.worktrees/x/src/App.tsx');
  });

  it('shortens every path in a shell line', () => {
    expect(shortenPathsIn('cd /Users/jkneen/Documents/GitHub/agensis-agent/.worktrees/self-update && npm test'))
      .toBe('cd …/agensis-agent/.worktrees/self-update && npm test');
  });

  it('preserves whitespace exactly', () => {
    expect(shortenPathsIn('a  b\tc')).toBe('a  b\tc');
  });

  it('leaves URLs alone', () => {
    const url = 'https://github.com/jasonkneen/agensis-agent/blob/main/src/index.ts';
    expect(shortenPathsIn(`opened ${url}`)).toBe(`opened ${url}`);
  });

  it('leaves prose and short tokens alone', () => {
    expect(shortenPathsIn('Coder: shipped the fix and/or the test')).toBe('Coder: shipped the fix and/or the test');
    expect(shortenPathsIn('@coder connected')).toBe('@coder connected');
  });

  it('keeps quotes and trailing punctuation outside the shortened path', () => {
    expect(shortenPathsIn('wrote "/Users/jkneen/Documents/GitHub/agensis-agent/.worktrees/x/src/App.tsx",'))
      .toBe('wrote "…/agensis-agent/.worktrees/x/src/App.tsx",');
  });

  it('returns an empty string for empty or non-string input', () => {
    expect(shortenPathsIn('')).toBe('');
    expect(shortenPathsIn(undefined as unknown as string)).toBe('');
  });
});
