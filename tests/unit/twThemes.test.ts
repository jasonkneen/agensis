import { describe, it, expect } from 'vitest';
import {
  TW_WORLDS,
  TW_MANAGED_KEYS,
  expandTw,
  findTwTheme,
} from '../../src/showcase/twThemes';

// The default "Gold" world MUST reproduce the current hardcoded CSS
// (index.css [data-ui-theme="tinyworld"] blocks) byte-for-byte, so introducing
// the world registry is a zero-regression change. These expected maps are
// transcribed directly from index.css — if a token drifts, this fails.

const GOLD_LIGHT: Record<string, string> = {
  '--canvas-base': '#f2e9d7',
  '--canvas-elevated': '#fdf8ec',
  '--canvas-raised': '#ebe0ca',
  '--canvas-overlay': '#fffdf6',
  '--background': '#f2e9d7',
  '--foreground': '#2a2722',
  '--card': '#fdf8ec',
  '--card-foreground': '#2a2722',
  '--popover': '#fdf8ec',
  '--popover-foreground': '#2a2722',
  '--secondary': '#ebe0ca',
  '--secondary-foreground': '#2a2722',
  '--muted': '#ebe0ca',
  '--muted-foreground': '#6f695f',
  '--border': '#e2d5bb',
  '--border-subtle': '#ede2ce',
  '--border-strong': '#c7bca4',
  '--sh-border': '#e2d5bb',
  '--input': '#e2d5bb',
  '--text-primary': '#2a2722',
  '--text-secondary': '#6f695f',
  '--text-muted': '#918979',
  '--success': '#2db37c',
  '--warning': '#e8a330',
  '--error': '#e8532a',
  '--tw-gold-outline': '#9f7a2c',
  '--tw-gold-fill': '#fff3c1',
  '--tw-control-outline': '#4a3f2e',
};

const GOLD_DARK: Record<string, string> = {
  '--canvas-base': '#17150f',
  '--canvas-elevated': '#221d14',
  '--canvas-raised': '#2c2518',
  '--canvas-overlay': '#372d1c',
  '--background': '#17150f',
  '--foreground': '#f5ecdc',
  '--card': '#221d14',
  '--card-foreground': '#f5ecdc',
  '--popover': '#221d14',
  '--popover-foreground': '#f5ecdc',
  '--secondary': '#2c2518',
  '--secondary-foreground': '#f5ecdc',
  '--muted': '#2c2518',
  '--muted-foreground': '#a89c88',
  '--border': '#4d4230',
  '--border-subtle': '#37301f',
  '--border-strong': '#756550',
  '--sh-border': '#4d4230',
  '--input': '#4d4230',
  '--text-primary': '#f5ecdc',
  '--text-secondary': '#c8bba7',
  '--text-muted': '#8d806e',
  '--success': '#65d7a0',
  '--warning': '#f0b85d',
  '--error': '#f27d5f',
  '--tw-gold-outline': '#f0c468',
  '--tw-gold-fill': 'rgba(118, 79, 28, 0.82)',
  '--tw-control-outline': '#c2ad8f',
};

describe('twThemes — Gold world matches current CSS', () => {
  const gold = findTwTheme('gold');

  it('light Gold reproduces the hardcoded CSS exactly', () => {
    expect(expandTw(gold.light)).toEqual(GOLD_LIGHT);
  });

  it('dark Gold reproduces the hardcoded CSS exactly', () => {
    expect(expandTw(gold.dark)).toEqual(GOLD_DARK);
  });
});

describe('twThemes — registry invariants', () => {
  it('has unique world ids and gold is first (default)', () => {
    const ids = TW_WORLDS.map(w => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('gold');
  });

  it('every world emits exactly the managed keys, all defined, for both schemes', () => {
    const managed = [...TW_MANAGED_KEYS].sort();
    for (const w of TW_WORLDS) {
      for (const scheme of ['light', 'dark'] as const) {
        const vars = expandTw(w[scheme]);
        // clearTwTheme() removes TW_MANAGED_KEYS, so the set applied must match
        // the set cleared — otherwise a leftover token would leak on switch.
        expect(Object.keys(vars).sort()).toEqual(managed);
        for (const v of Object.values(vars)) {
          expect(typeof v).toBe('string');
          expect(v.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
