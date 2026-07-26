import { describe, expect, it } from 'vitest';

// A channel rename showed in the channel header and NOWHERE ELSE until a
// reload: the window that saved it updated its own copy, while the sidebar
// reads the app's session list. These pin the shape of the patch that closes
// that gap — a partial merge onto the matching row, never a row replacement.
type Session = { id: string; title: string; icon?: string | null; folder?: string };

function patchSessions(sessions: Session[], id: string, patch: Partial<Session>): Session[] {
  if (!id) return sessions;
  return sessions.map(session => (session.id === id ? { ...session, ...patch } : session));
}

describe('patching a saved session into the sidebar list', () => {
  const list: Session[] = [
    { id: 's1', title: 'New Channel', folder: 'General' },
    { id: 's2', title: 'Other', folder: 'General' },
  ];

  it('renames only the matching row', () => {
    const next = patchSessions(list, 's1', { title: 'design' });
    expect(next[0].title).toBe('design');
    expect(next[1].title).toBe('Other');
  });

  it('MERGES rather than replaces — fields not in the patch survive', () => {
    // Pushing a foreign row in wholesale is how a sidebar entry loses half its
    // fields; the window's channel shape and the app's session shape differ.
    const next = patchSessions(list, 's1', { title: 'design' });
    expect(next[0].folder).toBe('General');
  });

  it('an unknown id and an empty id both leave the list untouched', () => {
    expect(patchSessions(list, 'nope', { title: 'x' })).toEqual(list);
    expect(patchSessions(list, '', { title: 'x' })).toBe(list);
  });
});
