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
      '--sh-accent': 'oklch(0.93 0.03 256)',
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
      '--sh-accent': 'oklch(0.93 0.04 293)',
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
      '--sh-accent': 'oklch(0.93 0.04 152)',
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
      '--sh-accent': 'oklch(0.94 0.03 17)',
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
      '--sh-accent': 'oklch(0.94 0.05 70)',
    },
  },
];

const STORAGE_KEY = 'hatch_theme_preset';

export function applyThemePreset(id: string) {
  const preset = THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0];
  const root = document.documentElement;
  // Clear any prior preset overrides first so switching presets is clean.
  for (const key of MANAGED_KEYS) root.style.removeProperty(key);
  if (!preset.reset) {
    for (const [key, value] of Object.entries(preset.vars)) {
      root.style.setProperty(key, value);
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, preset.id);
  } catch {
    /* ignore */
  }
}

export function getStoredPreset(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'neutral';
  } catch {
    return 'neutral';
  }
}
