import { describe, expect, it } from 'vitest';
import { nextHuddleConnectionEpoch } from '../../src/hooks/useHuddle';

describe('huddle connection epochs', () => {
  it('advances when joins share a wall-clock millisecond', () => {
    const first = nextHuddleConnectionEpoch(0, 1_700_000_000_000);
    const second = nextHuddleConnectionEpoch(first, 1_700_000_000_000);
    expect(second).toBe(first + 1);
  });

  it('does not move backwards when the system clock moves backwards', () => {
    expect(nextHuddleConnectionEpoch(1_700_000_000_100, 1_700_000_000_000)).toBe(1_700_000_000_101);
  });

  it('saturates safely at the largest representable integer', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(nextHuddleConnectionEpoch(max - 1, max)).toBe(max);
    expect(nextHuddleConnectionEpoch(max, 0)).toBe(max);
  });
});
