/**
 * Small appearance helpers for the app's Default family.
 *
 * The palette still comes from the existing accent preset registry. This file
 * only owns the independent corner-rounding choice so the new family can stay
 * close to the ideation-canvas control language without introducing another
 * palette system.
 */

export const DEFAULT_RADIUS_IDS = ['sharp', 'soft', 'rounded', 'pill'] as const;
export type DefaultRadius = (typeof DEFAULT_RADIUS_IDS)[number];

export interface DefaultRadiusMeta {
  id: DefaultRadius;
  label: string;
  description: string;
  previewPx: number;
}

export const DEFAULT_RADIUS: DefaultRadius = 'soft';

/**
 * Corner rounding is ONE axis, so it is one number.
 *
 * It used to be these four presets, and they could not express "a bit rounder
 * than Soft". Worse, they did not order by radius — `rounded` (14px) sat
 * between `soft` (10px) and `pill`, so the picker read as four unrelated
 * styles. The scale below is a multiplier on the base token values in
 * index.css: 0 is square, 1 is the old `soft`, and the presets survive only as
 * named points on it so an existing stored value still means something. The
 * number shown in Settings is the maximum non-pill radius, not an abstract
 * base that larger Tailwind tokens are allowed to multiply past.
 */
export const RADIUS_SCALE_MIN = 0;
export const RADIUS_SCALE_MAX = 2.4;
export const RADIUS_SCALE_STEP = 0.05;
export const DEFAULT_RADIUS_SCALE = 1;
export const DEFAULT_RADIUS_MAX_PX = 10;

/** Past this the toolbar and primary button go fully round rather than rounder. */
export const RADIUS_PILL_THRESHOLD = 2;

const PRESET_SCALE: Record<DefaultRadius, number> = {
  sharp: 0,
  soft: 1,
  rounded: 1.4,
  pill: 2.2,
};

export const DEFAULT_RADII: readonly DefaultRadiusMeta[] = [
  { id: 'sharp', label: 'Sharp', description: 'Square corners', previewPx: 0 },
  { id: 'soft', label: 'Soft', description: 'Gentle rounding', previewPx: 8 },
  { id: 'rounded', label: 'Rounded', description: 'Friendlier corners', previewPx: 14 },
  { id: 'pill', label: 'Pill', description: 'Maximum softness', previewPx: 22 },
] as const;

const STORAGE_KEY = 'agensis_default_radius';

export function isDefaultRadius(value: unknown): value is DefaultRadius {
  return typeof value === 'string' && (DEFAULT_RADIUS_IDS as readonly string[]).includes(value);
}

export function clampRadiusScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RADIUS_SCALE;
  return Math.min(RADIUS_SCALE_MAX, Math.max(RADIUS_SCALE_MIN, n));
}

/**
 * Read a stored value as a scale. Accepts the legacy preset ids so a setting
 * saved before the slider existed still resolves to the rounding it described,
 * rather than silently snapping everyone back to the default.
 */
export function radiusScaleFrom(value: unknown): number {
  if (isDefaultRadius(value)) return PRESET_SCALE[value];
  return clampRadiusScale(value);
}

/** The literal CSS-pixel ceiling represented by the Settings readout. */
export function radiusMaxPxFrom(value: unknown): number {
  return Math.round(DEFAULT_RADIUS_MAX_PX * radiusScaleFrom(value));
}

export function getStoredDefaultRadius(): DefaultRadius {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isDefaultRadius(stored) ? stored : DEFAULT_RADIUS;
  } catch {
    return DEFAULT_RADIUS;
  }
}

/**
 * Apply a granular corner scale. Writes the multiplier the CSS reads, plus a
 * flag for the two tokens that switch to fully-round at the top of the range.
 */
export function applyRadiusScale(value: unknown): number {
  const scale = radiusScaleFrom(value);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.style.setProperty('--default-radius-scale', String(scale));
    if (scale >= RADIUS_PILL_THRESHOLD) root.setAttribute('data-radius-pill', 'true');
    else root.removeAttribute('data-radius-pill');
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {
    /* private mode */
  }
  return scale;
}

/**
 * Legacy preset entry point. Kept because boot paths and a stored setting still
 * speak in preset ids, but it no longer writes `data-default-radius` — nothing
 * reads that attribute since corners became a continuous scale. It resolves the
 * preset to its point on the scale and applies that, so an account saved before
 * the slider existed lands on the rounding its preset described.
 */
export function applyDefaultRadius(value: unknown): DefaultRadius {
  const radius = isDefaultRadius(value) ? value : DEFAULT_RADIUS;
  applyRadiusScale(radius);
  return radius;
}
