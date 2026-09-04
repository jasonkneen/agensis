// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  applyRadiusScale,
  clampRadiusScale,
  radiusScaleFrom,
  DEFAULT_RADIUS_SCALE,
  RADIUS_PILL_THRESHOLD,
  RADIUS_SCALE_MAX,
} from '../../src/showcase/defaultTheme';

// Corner rounding used to be four presets (sharp/soft/rounded/pill) and is now
// a continuous scale. The thing worth pinning is the migration: an account
// saved before the slider holds a preset STRING, and resolving that to the
// default instead of to the rounding it described would silently restyle every
// existing user's app the next time they loaded it.

describe('radius scale', () => {
  it('resolves every legacy preset to a distinct, ordered value', () => {
    const sharp = radiusScaleFrom('sharp');
    const soft = radiusScaleFrom('soft');
    const rounded = radiusScaleFrom('rounded');
    const pill = radiusScaleFrom('pill');

    expect(sharp).toBe(0);
    // 'soft' was the default, so it must map to the scale's neutral point or
    // everyone's corners move on upgrade.
    expect(soft).toBe(DEFAULT_RADIUS_SCALE);
    // The presets' own names implied an order their VALUES did not have before
    // (rounded was 14px while soft was 10px and pill 22px). On the scale the
    // order has to be real and strictly increasing.
    expect(sharp).toBeLessThan(soft);
    expect(soft).toBeLessThan(rounded);
    expect(rounded).toBeLessThan(pill);
    // 'pill' must actually reach the fully-round switch, or the preset that
    // promised maximum softness would stop delivering it.
    expect(pill).toBeGreaterThanOrEqual(RADIUS_PILL_THRESHOLD);
  });

  it('passes numbers through and clamps nonsense to the default', () => {
    expect(radiusScaleFrom(1.35)).toBe(1.35);
    expect(clampRadiusScale(99)).toBe(RADIUS_SCALE_MAX);
    expect(clampRadiusScale(-5)).toBe(0);
    // An unparseable stored value must not produce NaN corners.
    expect(clampRadiusScale('not a number')).toBe(DEFAULT_RADIUS_SCALE);
    expect(clampRadiusScale(undefined)).toBe(DEFAULT_RADIUS_SCALE);
  });

  it('writes the multiplier the CSS reads, and the pill flag only at the top', () => {
    const root = document.documentElement;

    applyRadiusScale(1.2);
    expect(root.style.getPropertyValue('--default-radius-scale')).toBe('1.2');
    expect(root.getAttribute('data-radius-pill')).toBeNull();

    applyRadiusScale(RADIUS_SCALE_MAX);
    expect(root.getAttribute('data-radius-pill')).toBe('true');

    // And it must come back off — a one-way flag would strand the toolbar and
    // primary button fully round for the rest of the session.
    applyRadiusScale(1);
    expect(root.getAttribute('data-radius-pill')).toBeNull();
  });
});
