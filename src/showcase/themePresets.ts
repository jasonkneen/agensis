// Live theme presets for the showcase. Each preset overrides the shadcn
// "primary" (and ring/accent) tokens at runtime by setting CSS custom
// properties on the document root. The light/dark axis is handled separately by
// the app's existing useTheme ([data-theme]); these only change the brand hue,
// so they compose with both light and dark.

export interface ThemePreset {
  id: string;
  label: string;
  swatch: string; // CSS color for the picker dot
  // When `reset` is set, the preset removes its inline overrides so the
  // mode-aware CSS defaults ([data-theme] blocks) provide the values — used by
  // "Neutral" so primary stays dark-on-light AND light-on-dark automatically.
  reset?: boolean;
  vars: Record<string, string>;
}

const MANAGED_KEYS = ['--primary', '--primary-foreground', '--ring', '--sh-accent'];

// ---------------------------------------------------------------------------
// A preset sets a BRAND HUE, and nothing that has to differ between light and
// dark may be a fixed value here.
//
// applyThemePreset writes these as INLINE styles on :root, and an inline
// declaration beats every stylesheet rule — including the dark-mode scope. So
// a literal `--sh-accent` froze the light-mode tint (L 0.93, near-white) into
// dark mode, where --sh-accent-foreground is L 0.985. Near-white text on a
// near-white surface: measured dL 0.055 against a healthy 0.72. Every accent
// surface — hover states, muted rows — went unreadable the moment anyone
// picked a colour.
//
// --sh-accent is therefore MIXED against var(--background), which the scope
// itself defines, so it re-resolves per theme instead of being pinned.
//
// --primary IS deliberately pinned across both: a brand hue is the same hue in
// dark mode, and --primary-foreground is chosen per preset to sit on it (white
// on the mid-lightness hues, near-black on amber at L 0.77).
// ---------------------------------------------------------------------------

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'neutral',
    label: 'Neutral',
    swatch: 'oklch(0.556 0 0)',
    reset: true,
    vars: {},
  },
  {
    id: 'blue',
    label: 'Blue',
    swatch: 'oklch(0.62 0.19 256)',
    vars: {
      '--primary': 'oklch(0.62 0.19 256)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring': 'oklch(0.62 0.19 256)',
      '--sh-accent': 'color-mix(in oklch, var(--primary) 14%, var(--background))',
    },
  },
  {
    id: 'violet',
    label: 'Violet',
    swatch: 'oklch(0.61 0.22 293)',
    vars: {
      '--primary': 'oklch(0.61 0.22 293)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring': 'oklch(0.61 0.22 293)',
      '--sh-accent': 'color-mix(in oklch, var(--primary) 14%, var(--background))',
    },
  },
  {
    id: 'green',
    label: 'Green',
    swatch: 'oklch(0.6 0.17 152)',
    vars: {
      '--primary': 'oklch(0.6 0.17 152)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring': 'oklch(0.6 0.17 152)',
      '--sh-accent': 'color-mix(in oklch, var(--primary) 14%, var(--background))',
    },
  },
  {
    id: 'rose',
    label: 'Rose',
    swatch: 'oklch(0.64 0.24 17)',
    vars: {
      '--primary': 'oklch(0.64 0.24 17)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring': 'oklch(0.64 0.24 17)',
      '--sh-accent': 'color-mix(in oklch, var(--primary) 14%, var(--background))',
    },
  },
  {
    id: 'amber',
    label: 'Amber',
    swatch: 'oklch(0.77 0.16 70)',
    vars: {
      '--primary': 'oklch(0.77 0.16 70)',
      '--primary-foreground': 'oklch(0.205 0 0)',
      '--ring': 'oklch(0.77 0.16 70)',
      '--sh-accent': 'color-mix(in oklch, var(--primary) 14%, var(--background))',
    },
  },
];

const STORAGE_KEY = 'agensis_theme_preset';

export function applyThemePreset(id: string) {
  const preset = THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0];
  const root = document.documentElement;
  try {
    localStorage.setItem(STORAGE_KEY, preset.id);
  } catch {
    /* ignore */
  }
  // The Neo family owns its full palette via the neo theme registry
  // (neoThemes.ts). Leave its inline overrides untouched so a brand-hue preset
  // can't clobber the active neo theme; the choice is still persisted above.
  if (root.getAttribute('data-ui-theme') === 'neo') return;
  // Clear any prior preset overrides first so switching presets is clean.
  for (const key of MANAGED_KEYS) root.style.removeProperty(key);
  if (!preset.reset) {
    for (const [key, value] of Object.entries(preset.vars)) {
      root.style.setProperty(key, value);
    }
  }
}

export function getStoredPreset(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'neutral';
  } catch {
    return 'neutral';
  }
}
