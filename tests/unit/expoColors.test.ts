import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EXPO_ACCENTS, EXPO_BASES, EXPO_PAPERS, EXPO_PRESETS,
  applyExpoColors, applyExpoPreset, buildExpoTokens, contrast, currentExpoPreset,
  getExpoAccent, getExpoBase, getExpoPaper, setExpoAccent,
} from '../../src/lib/theme/expoColors';

const root = document.documentElement;

describe('expo colour choices', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById('agensis-expo-colors')?.remove();
  });

  it('defaults to Expo: navy, coral, cream', () => {
    expect([getExpoBase(), getExpoAccent(), getExpoPaper()]).toEqual(['navy', 'coral', 'cream']);
    expect(currentExpoPreset()).toBe('expo');
  });

  it('ignores an unknown stored value', () => {
    localStorage.setItem('agensis_expo_accent', 'neon');
    expect(getExpoAccent()).toBe('coral');
  });

  it('writes one style element and a seed the colour watchers observe', () => {
    setExpoAccent('teal');
    const css = document.getElementById('agensis-expo-colors')?.textContent ?? '';
    expect(css).toContain('--expo-coral:#2c9f96');
    expect(root.getAttribute('data-theme-seed')).toBe('navy.teal.cream');
    applyExpoColors();
    expect(document.querySelectorAll('#agensis-expo-colors')).toHaveLength(1);
  });

  it('presets set all three, and every preset points at real options', () => {
    for (const preset of EXPO_PRESETS) {
      expect(EXPO_BASES.some(b => b.id === preset.base)).toBe(true);
      expect(EXPO_ACCENTS.some(a => a.id === preset.accent)).toBe(true);
      expect(EXPO_PAPERS.some(p => p.id === preset.paper)).toBe(true);
    }
    applyExpoPreset('nord');
    expect([getExpoBase(), getExpoAccent(), getExpoPaper()]).toEqual(['nord', 'cyan', 'nord']);
    expect(currentExpoPreset()).toBe('nord');
  });

  // The point of solving rather than hand-picking: no combination of choices
  // can produce unreadable text.
  it('every base x accent x surface keeps text readable in both schemes', () => {
    for (const b of EXPO_BASES) for (const a of EXPO_ACCENTS) for (const p of EXPO_PAPERS) {
      const t = buildExpoTokens(b.id, a.id, p.id);
      const where = `${b.id}/${a.id}/${p.id}`;
      expect(contrast(t.onAccent, t.coral), `on-accent ${where}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.navy, t.lightBackground), `light ink ${where}`).toBeGreaterThanOrEqual(7);
      expect(contrast(t.inkLight2, t.lightBackground), `light secondary ${where}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.inkLight3, t.lightBackground), `light faint ${where}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.cream, t.navy), `dark ink ${where}`).toBeGreaterThanOrEqual(7);
      expect(contrast(t.inkDark2, t.navy), `dark secondary ${where}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.inkDark3, t.navy), `dark faint ${where}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('expo.css hard-codes no palette colour — every one comes from the choices', () => {
    const css = readFileSync('src/styles/expo.css', 'utf8');
    // Literal hexes are allowed only as the :root defaults and fixed state colours.
    const allowed = new Set(['#2b2d48', '#4a4c6e', '#e8735f', '#fbf4e4', '#fffaf0', '#c9a676', '#545670', '#7d7e95', '#c9c8dc', '#9796b3',
      '#f2c94c', '#7fc8a9', '#8fb7f0', '#2f8a63', '#a8770b', '#c8452f', '#ff8f79']);
    const found = [...new Set((css.match(/#[0-9a-f]{6}\b/gi) ?? []).map(h => h.toLowerCase()))];
    expect(found.filter(h => !allowed.has(h))).toEqual([]);
    expect(css).not.toMatch(/\[data-expo-(accent|base|paper)=/);
  });
});
