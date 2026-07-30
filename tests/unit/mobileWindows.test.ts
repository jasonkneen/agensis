import { describe, it, expect } from 'vitest';
import type { FloatingWindow } from '../../src/types';
import { pickActiveWindowId } from '../../src/lib/mobileWindows';

function win(id: string, zIndex: number, minimized = false): FloatingWindow {
  return {
    id,
    type: 'chat',
    title: id,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    zIndex,
    minimized,
  } as FloatingWindow;
}

describe('pickActiveWindowId', () => {
  it('returns null when there are no windows', () => {
    expect(pickActiveWindowId([])).toBeNull();
  });

  it('returns null when every window is minimized', () => {
    expect(pickActiveWindowId([win('a', 5, true), win('b', 9, true)])).toBeNull();
  });

  it('returns the only open window', () => {
    expect(pickActiveWindowId([win('solo', 3)])).toBe('solo');
  });

  it('picks the highest zIndex (the focused window)', () => {
    expect(pickActiveWindowId([win('a', 2), win('b', 7), win('c', 5)])).toBe('b');
  });

  it('ignores minimized windows even when they have the highest zIndex', () => {
    expect(pickActiveWindowId([win('a', 2), win('buried-max', 99, true), win('c', 5)])).toBe('c');
  });

  it('is order-independent (highest zIndex wins regardless of array position)', () => {
    const top = win('top', 42);
    expect(pickActiveWindowId([top, win('a', 1), win('b', 8)])).toBe('top');
    expect(pickActiveWindowId([win('a', 1), win('b', 8), top])).toBe('top');
  });
});
