import bg1 from '../../images/download-21.webp';
import bg2 from '../../images/download-22.webp';
import bg3 from '../../images/download-24.webp';
import bg4 from '../../images/download-25.webp';
import bg5 from '../../images/download-26.webp';
import bg6 from '../../images/download-27.webp';
import bg7 from '../../images/download-28.webp';

export const WORKSPACE_BACKGROUNDS = [
  { id: 'green-fields', label: 'Green Fields', src: bg1 },
  { id: 'red-canyon', label: 'Red Canyon', src: bg2 },
  { id: 'palm-beach', label: 'Palm Beach', src: bg3 },
  { id: 'forest-gate', label: 'Forest Gate', src: bg4 },
  { id: 'night-battle', label: 'Night Battle', src: bg5 },
  { id: 'sky-meadow', label: 'Sky Meadow', src: bg6 },
  { id: 'sunset-canyon', label: 'Sunset Canyon', src: bg7 },
];

export const WORKSPACE_BACKGROUND_IMAGES = WORKSPACE_BACKGROUNDS.map(background => background.src);

// ---------------------------------------------------------------------------
// Storing a wallpaper CHOICE, not a wallpaper URL.
//
// `src` above is a Vite import, so it resolves to a content-hashed build asset
// like /assets/download-22-qzA4n-2F.webp. That hash changes whenever the image
// or the build does. Persisting one into `background_image` would therefore
// 404 on the next deploy — every workspace losing its wallpaper at once, with
// nothing in the data to explain why.
//
// So we store the stable `id` ('red-canyon') and resolve it at render. The
// column stays free-form because it also legitimately holds a user's uploaded
// data: URL from SettingsDialog, and existing rows already hold raw paths.
// ---------------------------------------------------------------------------

const BACKGROUND_BY_ID = new Map(WORKSPACE_BACKGROUNDS.map(b => [b.id, b.src]));

/** Every id, in registry order. */
export const WORKSPACE_BACKGROUND_IDS = WORKSPACE_BACKGROUNDS.map(b => b.id);

/**
 * Turn a stored `background_image` into something an `img`/`background-image`
 * can use.
 *
 * Three shapes reach this, all valid: a registry id (what we now write), a
 * data: URL (an upload), and a path or absolute URL (older rows, and the
 * hashed paths written before this existed). Anything unrecognised comes back
 * as-is rather than being blanked — a wallpaper we cannot classify is far more
 * likely to be a URL we did not anticipate than a mistake worth erasing.
 */
export function resolveBackgroundImage(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return BACKGROUND_BY_ID.get(raw) ?? raw;
}

/**
 * A wallpaper id for a NEW canvas, chosen from `seed` so it is stable.
 *
 * Deliberately derived rather than random: picking at render would reshuffle
 * the wallpaper on every reload, and picking randomly at creation would make
 * the same fixture produce different results in tests. Seeded with the canvas
 * id gives a different-looking wallpaper per canvas that never changes under
 * the user afterwards.
 */
export function backgroundIdForSeed(seed: string): string {
  const text = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return WORKSPACE_BACKGROUND_IDS[hash % WORKSPACE_BACKGROUND_IDS.length];
}
