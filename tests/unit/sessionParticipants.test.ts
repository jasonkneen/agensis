import { describe, expect, it } from 'vitest';
import { buildChannelRoster, dedupeSessionParticipants, parseParticipants } from '../../src/lib/sessionParticipants';

// Two server write sites bound JSON.stringify(...) into a `$n::jsonb`
// placeholder, which stores a jsonb STRING SCALAR instead of an array. 88 live
// sessions were written that way. The row reached the browser as a JSON string,
// every consumer did Array.isArray(...) and saw nobody, and the agent mesh
// reported "nothing here yet" for an agent with 33 live sessions.
describe('parseParticipants', () => {
  const rows = [{ id: 'agent:1', kind: 'agent', handle: 'coder', name: 'Coder' }];

  it('passes a real array straight through', () => {
    expect(parseParticipants(rows)).toEqual(rows);
  });

  it('recovers the double-encoded string form', () => {
    expect(parseParticipants(JSON.stringify(rows))).toEqual(rows);
  });

  it('treats an empty or blank value as no participants', () => {
    expect(parseParticipants('')).toEqual([]);
    expect(parseParticipants('   ')).toEqual([]);
    expect(parseParticipants(null)).toEqual([]);
    expect(parseParticipants(undefined)).toEqual([]);
  });

  it('never throws on a malformed value', () => {
    // One unreadable row must not take down the surface rendering it.
    expect(parseParticipants('{not json')).toEqual([]);
    expect(parseParticipants('"a string"')).toEqual([]);
    expect(parseParticipants('{"kind":"agent"}')).toEqual([]);
    expect(parseParticipants(42)).toEqual([]);
  });
});

// The double voice's last root. Two writers produced two id shapes for the
// SAME agent — `agent:<uuid>` (people dialog, mention path) and bare `<uuid>`
// (sub-thread creation) — and nothing deduped across them.
// continueConversation dispatches per agent row, so the duplicate answered
// every turn twice and a huddle read both replies aloud.
describe('dedupeSessionParticipants', () => {
  const prefixed = { id: 'agent:u1', kind: 'agent', name: 'Coder', handle: 'coder', agent_id: 'u1' };
  const bare = { id: 'u1', kind: 'agent', name: 'Coder', handle: null, agent_id: 'u1' };

  it('collapses the two shapes of one agent into a single row', () => {
    expect(dedupeSessionParticipants([prefixed, bare])).toHaveLength(1);
    expect(dedupeSessionParticipants([bare, prefixed])).toHaveLength(1);
  });

  it('backfills fields the kept row was missing instead of dropping them', () => {
    // The shapes disagree about which fields they populate; dropping the later
    // row wholesale can drop the only copy of `handle`.
    const [kept] = dedupeSessionParticipants([bare, prefixed]) as Array<Record<string, unknown>>;
    expect(kept.handle).toBe('coder');
    expect(kept.id).toBe('u1'); // first row wins identity fields it already had
  });

  it('keeps different agents apart and leaves humans untouched', () => {
    const other = { id: 'agent:u2', kind: 'agent', name: 'Scout', agent_id: 'u2' };
    const human = { id: 'user:h1', kind: 'user', name: 'Jason', user_id: 'h1' };
    expect(dedupeSessionParticipants([prefixed, other, human, bare])).toHaveLength(3);
  });

  it('falls back to the handle when no uuid exists in any field', () => {
    const a = { id: 'agent:coder', kind: 'agent', name: 'Coder', handle: 'coder', agent_id: null };
    const b = { id: 'coder', kind: 'agent', name: 'Coder', handle: 'Coder', agent_id: null };
    expect(dedupeSessionParticipants([a, b])).toHaveLength(1);
  });
});

// "4 in the room, no one there because they are not really there" — the header
// counted every agent online ANYWHERE in the workspace as a member of this
// channel, while the huddle (reading the stored roster) correctly said one.
describe('buildChannelRoster', () => {
  const decorate = (p: { id: string }) => ({ ...p, decorated: true });

  it('an online agent that was never added is NOT in the channel', () => {
    const roster = buildChannelRoster({
      stored: [],
      present: [{ id: 'a1', kind: 'agent', name: 'Coder', status: 'online' }],
      decorate,
    });
    expect(roster).toEqual([]);
  });

  it('a live HUMAN is in the channel — being here is how people join', () => {
    const roster = buildChannelRoster({
      stored: [],
      present: [{ id: 'h1', kind: 'user', name: 'Jason', status: 'online', isCurrentUser: true }],
      decorate,
    }) as Array<Record<string, unknown>>;
    expect(roster).toHaveLength(1);
    expect(roster[0].name).toBe('You');
    expect(roster[0].connected).toBe(true);
  });

  it('a STORED agent stays, and presence only decorates it', () => {
    const roster = buildChannelRoster({
      stored: [{ id: 'agent:a1' }],
      present: [{ id: 'a1', kind: 'agent', name: 'Coder', status: 'online' }],
      decorate,
    }) as Array<Record<string, unknown>>;
    expect(roster).toHaveLength(1);
    expect(roster[0].decorated).toBe(true);
  });

  it('caps the list so a busy workspace cannot flood the chip', () => {
    const present = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, kind: 'user', name: `P${i}` }));
    expect(buildChannelRoster({ stored: [], present, decorate })).toHaveLength(6);
  });
});
