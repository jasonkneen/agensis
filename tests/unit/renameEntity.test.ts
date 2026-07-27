import { describe, expect, it } from 'vitest';
import { RENAME_MAX_CHARS, resolveRename, shouldCommitOnBlur } from '../../src/lib/renameEntity';

describe('resolveRename', () => {
  it('commits a genuinely new name', () => {
    expect(resolveRename('Client A', 'Work')).toEqual({ action: 'commit', name: 'Client A' });
  });

  it('trims and collapses whitespace before committing', () => {
    expect(resolveRename('  Client   A  ', 'Work')).toEqual({ action: 'commit', name: 'Client A' });
  });

  it('rejects an empty or whitespace-only name rather than blanking the tile', () => {
    // The rail is icons-only when collapsed, so a blank name leaves nothing to click.
    for (const bad of ['', '   ', '\t\n ']) {
      expect(resolveRename(bad, 'Work').action).toBe('reject');
    }
  });

  it('treats an unchanged name as a no-op, not a write', () => {
    // updated_at ordering decides which workspace you land in, so a pointless
    // write here would silently move the user.
    expect(resolveRename('Work', 'Work')).toEqual({ action: 'noop' });
    expect(resolveRename('  Work  ', 'Work')).toEqual({ action: 'noop' });
  });

  it('a case-only change IS a change', () => {
    expect(resolveRename('WORK', 'Work')).toEqual({ action: 'commit', name: 'WORK' });
  });

  it('caps an over-long paste instead of breaking the layout', () => {
    const out = resolveRename('x'.repeat(400), 'Work');
    expect(out.action).toBe('commit');
    expect(out.action === 'commit' && out.name.length).toBe(RENAME_MAX_CHARS);
  });

  it('allows duplicate names — two workspaces called Client are the user\'s business', () => {
    expect(resolveRename('Client', 'Work')).toEqual({ action: 'commit', name: 'Client' });
  });
});

describe('shouldCommitOnBlur', () => {
  // Escape sets cancelled, then blur fires because closing the editor moves
  // focus. A blur that committed unconditionally would SAVE the edit Escape
  // just discarded — the cancel-before-read bug this codebase already hit once.
  it('does not commit once cancelled', () => {
    expect(shouldCommitOnBlur(true)).toBe(false);
  });

  it('commits an ordinary blur', () => {
    expect(shouldCommitOnBlur(false)).toBe(true);
  });
});
