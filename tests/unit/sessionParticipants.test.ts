import { describe, expect, it } from 'vitest';
import { parseParticipants } from '../../src/lib/sessionParticipants';

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
