import { describe, expect, it } from 'vitest';
import {
  buildReaderFaces,
  describeFaces,
  faceStack,
  readerInitials,
  readerNameResolver,
} from '../../src/lib/readerFaces';
import type { WorkspaceAgent } from '../../src/types';

// The chips show WHO, not how many. These are the claims that makes:
// an agent id resolves as well as a human one, an unresolvable id still draws,
// and the chip never puts a uuid on screen.

const agent = (over: Partial<WorkspaceAgent>): WorkspaceAgent => ({
  id: 'a1',
  workspace_id: 'w1',
  name: 'Coder',
  avatar: '',
  description: '',
  system_prompt: '',
  ...over,
} as WorkspaceAgent);

const DIRECTORY = {
  members: [
    { user_id: 'u1', email: 'ada.lovelace@example.com' },
    { user_id: 'u2', email: null, name: 'Ben' },
  ],
  agents: [
    agent({ id: 'a1', name: 'Coder', avatar: 'pet:cat', accent_color: '#38bdf8' }),
    agent({ id: 'a2', name: 'Grok', avatar: '' }),
  ],
};

describe('readerInitials', () => {
  it('takes the first and last word, never the first two characters', () => {
    // "AD" says nothing; "AL" says which person.
    expect(readerInitials('ada lovelace')).toBe('AL');
    expect(readerInitials('ada.lovelace')).toBe('AL');
    expect(readerInitials('Coder')).toBe('C');
  });

  it('never returns empty, so a face is never a blank circle', () => {
    expect(readerInitials('')).toBe('?');
    expect(readerInitials(null)).toBe('?');
    expect(readerInitials('   ')).toBe('?');
  });

  it('stops at two letters — a third turns a 16px face into a smear', () => {
    expect(readerInitials('ada b lovelace')).toHaveLength(2);
  });
});

describe('buildReaderFaces', () => {
  const resolve = buildReaderFaces(DIRECTORY);

  it('resolves a human by the local part of the email, never the domain', () => {
    const face = resolve('u1');
    expect(face.name).toBe('ada.lovelace');
    expect(face.isAgent).toBe(false);
    expect(face.accent).toBe('');
  });

  it('resolves an agent, because a reader id is not always a person', () => {
    // An agent has a row in workspace_agents, not app_users. Read markers and
    // reactions both cover agents, so a lookup that only knew about members
    // would draw "Someone" for the commonest reader in this product.
    const face = resolve('a1');
    expect(face.name).toBe('Coder');
    expect(face.isAgent).toBe(true);
    expect(face.avatar).toBe('pet:cat');
    expect(face.accent).toBe('#38bdf8');
  });

  it('gives an agent without an explicit accent a stable derived one', () => {
    const first = resolve('a2').accent;
    expect(first).toMatch(/^#[0-9a-f]{6}$/i);
    expect(buildReaderFaces(DIRECTORY)('a2').accent).toBe(first);
  });

  it('still returns a face for an id it cannot resolve', () => {
    // A reader who genuinely read your message does not stop existing because
    // the roster has not loaded yet.
    const face = resolve('3f7c1a52-0000-4000-8000-000000000000');
    expect(face.name).toBeNull();
    expect(face.initials).toBe('?');
  });

  it('prefers an explicit member name over the email', () => {
    expect(resolve('u2').name).toBe('Ben');
  });
});

describe('readerNameResolver', () => {
  it('is the name-only view of the same lookup, so the two cannot drift', () => {
    const name = readerNameResolver(buildReaderFaces(DIRECTORY));
    expect(name('a1')).toBe('Coder');
    expect(name('nobody')).toBeNull();
  });
});

describe('faceStack', () => {
  const resolve = buildReaderFaces(DIRECTORY);

  it('draws up to three and counts the rest', () => {
    const { shown, overflow } = faceStack(['u1', 'u2', 'a1', 'a2'], resolve);
    expect(shown.map(f => f.id)).toEqual(['u1', 'u2', 'a1']);
    expect(overflow).toBe(1);
  });

  it('has no overflow when everybody fits', () => {
    expect(faceStack(['u1', 'a1'], resolve).overflow).toBe(0);
  });

  it('collapses a duplicated reader, which would otherwise look like two people', () => {
    const { shown, overflow } = faceStack(['a1', 'a1', 'a1'], resolve);
    expect(shown).toHaveLength(1);
    expect(overflow).toBe(0);
  });

  it('keeps the given order — the marker order is the reading order', () => {
    expect(faceStack(['a2', 'u1'], resolve).shown.map(f => f.name)).toEqual(['Grok', 'ada.lovelace']);
  });

  it('never draws zero faces with a positive overflow', () => {
    // max is clamped to at least 1: a chip showing only "+4" is a count that
    // took the long way round.
    const { shown, overflow } = faceStack(['u1', 'u2'], resolve, 0);
    expect(shown).toHaveLength(1);
    expect(overflow).toBe(1);
  });
});

describe('describeFaces', () => {
  const resolve = buildReaderFaces(DIRECTORY);

  it('names who is on screen and admits to the rest', () => {
    const { shown, overflow } = faceStack(['a1', 'a2', 'u1', 'u2'], resolve);
    expect(describeFaces(shown, overflow)).toBe('Coder, Grok, ada.lovelace and 1 other');
  });

  it('says "Someone" rather than a uuid', () => {
    const uuid = '3f7c1a52-0000-4000-8000-000000000000';
    const { shown } = faceStack([uuid], resolve);
    const text = describeFaces(shown, 0);
    expect(text).toBe('Someone');
    expect(text).not.toContain('3f7c1a52');
  });

  it('reads as a sentence at one, two and many', () => {
    expect(describeFaces(faceStack(['a1'], resolve).shown)).toBe('Coder');
    expect(describeFaces(faceStack(['a1', 'a2'], resolve).shown)).toBe('Coder and Grok');
    expect(describeFaces(faceStack(['a1', 'a2', 'u2'], resolve).shown)).toBe('Coder, Grok and Ben');
  });

  it('pluralises the overflow', () => {
    const { shown } = faceStack(['a1'], resolve);
    expect(describeFaces(shown, 1)).toBe('Coder and 1 other');
    expect(describeFaces(shown, 2)).toBe('Coder and 2 others');
  });
});
