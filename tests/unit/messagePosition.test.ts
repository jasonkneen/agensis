import { describe, expect, it } from 'vitest';
import { compareMessagePosition } from '../../src/lib/messagePosition';

describe('message timestamp precision', () => {
  it('orders microseconds ahead of the ID tie-break used by history cursors', () => {
    expect(compareMessagePosition(
      { id: 'z', created_at: '2026-09-22 06:44:42.457123+00' },
      { id: 'a', created_at: '2026-09-22 06:44:42.457456+00' },
    )).toBeLessThan(0);
  });

  it('normalizes fractional precision and timezone offsets before comparing IDs', () => {
    expect(compareMessagePosition(
      { id: 'a', created_at: '2026-09-22T07:44:42.4571+01:00' },
      { id: 'z', created_at: '2026-09-22T06:44:42.457100Z' },
    )).toBeLessThan(0);
  });

  it('orders millisecond-only realtime rows with precise history rows', () => {
    expect(compareMessagePosition(
      { id: 'z', created_at: '2026-09-22T06:44:42.457Z' },
      { id: 'a', created_at: '2026-09-22T06:44:42.457001Z' },
    )).toBeLessThan(0);
  });
});
