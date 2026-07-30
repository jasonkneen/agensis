import { describe, it, expect } from 'vitest';
import { parseReleaseNotes, fetchReleaseNotes } from '../../src/lib/releaseNotes';

function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const valid = {
  version: '2026.07.04',
  date: '2026-07-04',
  title: 'A change',
  summary: 'It changed.',
  highlights: ['one', 'two'],
};

describe('parseReleaseNotes', () => {
  it('keeps well-formed notes, in order', () => {
    const out = parseReleaseNotes([valid, { ...valid, version: 'b' }]);
    expect(out).toHaveLength(2);
    expect(out[0].version).toBe('2026.07.04');
  });

  it('accepts a note without highlights', () => {
    const { highlights, ...noHighlights } = valid;
    void highlights;
    expect(parseReleaseNotes([noHighlights])).toHaveLength(1);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const out = parseReleaseNotes([
      valid,
      { version: 'x' }, // missing fields
      { ...valid, highlights: [1, 2] }, // non-string highlights
      'nonsense',
    ]);
    expect(out).toHaveLength(1);
  });

  it('returns [] for a non-array body', () => {
    expect(parseReleaseNotes(null)).toEqual([]);
    expect(parseReleaseNotes({})).toEqual([]);
  });
});

describe('fetchReleaseNotes', () => {
  it('parses a well-formed notes file', async () => {
    const out = await fetchReleaseNotes(stubFetch(200, [valid]));
    expect(out).toHaveLength(1);
  });

  it('returns [] on a non-2xx response', async () => {
    expect(await fetchReleaseNotes(stubFetch(500, []))).toEqual([]);
  });

  it('returns [] when the fetch throws', async () => {
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchReleaseNotes(throwing)).toEqual([]);
  });
});
