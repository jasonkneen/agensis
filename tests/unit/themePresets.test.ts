import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '../../src/showcase/themePresets';

// applyThemePreset writes preset vars as INLINE styles on :root, and an inline
// declaration beats every stylesheet rule — including the dark-mode scope.
// So any preset value that must DIFFER between light and dark cannot be a
// literal here. A literal --sh-accent (L 0.93, a light-mode tint) froze into
// dark mode against --sh-accent-foreground at L 0.985: near-white text on a
// near-white surface, dL 0.055 where a healthy pair is ~0.72.
describe('theme presets are safe to pin inline', () => {
  const coloured = THEME_PRESETS.filter(p => !p.reset);

  it('ships more than one colour preset, so this is worth guarding', () => {
    expect(coloured.length).toBeGreaterThan(1);
  });

  it('never pins a LITERAL accent — it must derive from the scope background', () => {
    for (const preset of coloured) {
      const accent = preset.vars['--sh-accent'];
      expect(accent, preset.id).toBeTruthy();
      expect(accent, `${preset.id}: a literal accent freezes light-mode into dark`)
        .toMatch(/var\(--background\)/);
    }
  });

  it('pins --primary deliberately: a brand hue is the same hue in dark mode', () => {
    for (const preset of coloured) {
      expect(preset.vars['--primary'], preset.id).toMatch(/^oklch\(/);
    }
  });

  it('gives every preset a foreground that contrasts with its own primary', () => {
    // Parsed from the oklch() literals: L is the first component.
    const lightnessOf = (v: string) => Number(v.match(/oklch\(([0-9.]+)/)?.[1] ?? NaN);
    for (const preset of coloured) {
      const bg = lightnessOf(preset.vars['--primary']);
      const fg = lightnessOf(preset.vars['--primary-foreground']);
      expect(Number.isFinite(bg) && Number.isFinite(fg), preset.id).toBe(true);
      // Amber sits at L 0.77 and correctly takes a near-black foreground; the
      // mid-lightness hues take white. Either way the gap must be real.
      expect(Math.abs(bg - fg), `${preset.id}: primary/foreground too close`).toBeGreaterThan(0.25);
    }
  });

  it('every managed key a preset sets is cleared on reset', () => {
    // Switching presets removes the previous overrides; a key set by some
    // preset but absent from MANAGED_KEYS would survive the switch and leak.
    const managed = new Set(['--primary', '--primary-foreground', '--ring', '--sh-accent']);
    for (const preset of coloured) {
      for (const key of Object.keys(preset.vars)) {
        expect(managed.has(key), `${key} is set by ${preset.id} but never cleared`).toBe(true);
      }
    }
  });
});
