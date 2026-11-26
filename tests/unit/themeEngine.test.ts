import { describe, expect, it } from 'vitest';
import {
  THEME_CONTRASTS,
  THEME_DEPTHS,
  THEME_PALETTES,
  buildThemeCss,
  buildThemeTokens,
  contrastRatio,
  luminance,
  type ThemeSeed,
} from '../../src/lib/theme/engine';

const L = (v: string) => Number(/oklch\(([\d.]+)/.exec(v)?.[1]);
const parse = (v: string) => {
  const m = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(v);
  if (!m) throw new Error(`not oklch: ${v}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
};
const ratio = (fg: string, bg: string) => {
  const a = parse(fg);
  const b = parse(bg);
  return contrastRatio(luminance(a.l, a.c, a.h), luminance(b.l, b.c, b.h));
};

const graphite: ThemeSeed = { palette: THEME_PALETTES[0], accent: null, contrast: 'standard', depth: 'hard' };

describe('theme engine', () => {
  it('Graphite/standard reproduces the old hand-written Default lightness ramp', () => {
    // #f8f8f8 #ffffff #f0f0f0 #e0e0e0 #1a1a1a #5a5a5a, and the dark set.
    const light = buildThemeTokens(graphite, 'light');
    expect(L(light['--background'])).toBeCloseTo(0.976, 2);
    expect(L(light['--card'])).toBeCloseTo(1, 2);
    expect(L(light['--muted'])).toBeCloseTo(0.955, 2);
    expect(L(light['--border'])).toBeCloseTo(0.907, 2);
    expect(L(light['--foreground'])).toBeCloseTo(0.218, 2);
    expect(Math.abs(L(light['--muted-foreground']) - 0.459)).toBeLessThan(0.04);

    const dark = buildThemeTokens(graphite, 'dark');
    expect(L(dark['--background'])).toBeCloseTo(0.153, 2);
    expect(L(dark['--card'])).toBeCloseTo(0.187, 2);
    expect(L(dark['--foreground'])).toBeCloseTo(0.961, 2);
    expect(Math.abs(L(dark['--muted-foreground']) - 0.682)).toBeLessThan(0.04);
  });

  it('keeps the old Default identity: ink primary and hard offset shadows', () => {
    const t = buildThemeTokens(graphite, 'light');
    expect(t['--primary']).toBe('var(--foreground)');
    expect(t['--primary-foreground']).toBe('var(--background)');
    expect(t['--shadow-sm']).toMatch(/^2px 2px 0 /);
  });

  // The whole point of solving rather than picking: no palette, contrast level
  // or scheme can produce unreadable secondary text.
  for (const palette of THEME_PALETTES) {
    for (const { id: contrast } of THEME_CONTRASTS) {
      for (const scheme of ['light', 'dark'] as const) {
        it(`${palette.id}/${contrast}/${scheme}: secondary text clears 4.5:1 and faint clears 3:1`, () => {
          const t = buildThemeTokens({ ...graphite, palette, contrast }, scheme);
          expect(ratio(t['--muted-foreground'], t['--background'])).toBeGreaterThanOrEqual(4.5);
          expect(ratio(t['--ink-muted'], t['--background'])).toBeGreaterThanOrEqual(2.95);
          expect(ratio(t['--foreground'], t['--background'])).toBeGreaterThanOrEqual(12);
        });
      }
    }
  }

  it('high contrast pushes lines further from the surface than soft', () => {
    const soft = buildThemeTokens({ ...graphite, contrast: 'soft' }, 'light');
    const high = buildThemeTokens({ ...graphite, contrast: 'high' }, 'light');
    expect(L(high['--border'])).toBeLessThan(L(soft['--border']));
  });

  it('chooses a readable label colour for every accent', () => {
    const accents = [
      { l: 0.77, c: 0.16, h: 70 }, // amber: needs dark text
      { l: 0.62, c: 0.19, h: 256 }, // blue: white text
    ];
    const [amber, blue] = accents.map(a => buildThemeTokens({ ...graphite, accent: a }, 'light'));
    expect(amber['--primary-foreground']).toBe('oklch(0.2 0 0)');
    expect(blue['--primary-foreground']).toBe('oklch(0.985 0 0)');
  });

  it('every depth defines every shadow token', () => {
    const keys = Object.keys(buildThemeTokens(graphite, 'light')).filter(k => k.includes('shadow') || k === '--chrome-cast');
    for (const { id } of THEME_DEPTHS) {
      const t = buildThemeTokens({ ...graphite, depth: id }, 'dark');
      for (const k of keys) expect(t[k], `${id} ${k}`).toBeTruthy();
    }
  });

  it('emits scheme-scoped rules that outrank the static Default blocks', () => {
    const css = buildThemeCss(graphite);
    expect(css).toContain(':root:root[data-ui-theme="default"][data-theme="light"]');
    expect(css).toContain(':root:root[data-ui-theme="default"][data-theme="dark"]');
    expect(css).not.toMatch(/NaN|undefined/);
  });
});
