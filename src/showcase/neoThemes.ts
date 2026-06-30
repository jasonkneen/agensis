// Neo‑brutal theme registry.
//
// The `neo` UI family (see index.css, [data-ui-theme="neo"]) gives the app its
// brutal *structure*: thick ink borders, hard offset shadows, chunky controls,
// stamped labels. That structure is driven entirely by CSS custom properties
// (--neo-ink, --primary, --canvas-*, --neo-shadow-ink, …). This module supplies
// the *palette* layer: a big library of distinct neo‑brutal looks, each applied
// at runtime by writing those variables inline on <html> — the same mechanism
// the accent presets use (themePresets.ts), just for the full palette instead of
// only the brand hue.
//
// Each theme defines a compact `light` and `dark` seed (paper / ink / primary /
// a couple of accents). `expand()` derives the ~25 surface tokens the neo family
// reads, so adding a theme is ~10 values, not 50. This composes with the app's
// existing light/dark toggle: switching scheme re-applies the matching seed.

import { applyThemePreset, getStoredPreset } from './themePresets';

export type NeoScheme = 'light' | 'dark';
export type NeoRadius = 'sharp' | 'default' | 'soft';

/** Compact per-scheme colour seed. Surfaces are derived from these. */
export interface NeoSeed {
  paper: string;       // page background  → --canvas-base / --background
  ink: string;         // text + borders   → --neo-ink (border/input/ring follow)
  primary: string;     // dominant accent  → --primary
  onPrimary: string;   // text on primary  → --primary-foreground
  card?: string;       // elevated surface → --card / --popover / --canvas-elevated
  raised?: string;     // secondary fill   → --secondary / --canvas-raised
  muted?: string;      // muted fill       → --muted
  shadow?: string;     // hard-shadow ink  → --neo-shadow-ink (default: ink)
  dot?: string;        // dot-grid colour  → --neo-dot
  success?: string;
  warning?: string;
  error?: string;
}

export interface NeoTheme {
  id: string;
  label: string;
  group: string;
  /** 3 colours for the picker chip: [primary, secondary accent, paper/ink]. */
  swatch: [string, string, string];
  /** Optional body font stack (themes can swap the whole feel). */
  font?: string;
  /** Optional display/heading font stack. */
  display?: string;
  /** Corner treatment. 'sharp' = hard 0px brutalism, 'soft' = friendlier. */
  radius?: NeoRadius;
  light: NeoSeed;
  dark: NeoSeed;
}

// ---- font stacks (loaded via the @import in index.css) -------------------
const F = {
  grotesk: "'Space Grotesk', system-ui, -apple-system, sans-serif",
  archivo: "'Archivo Black', 'Space Grotesk', system-ui, sans-serif",
  mono: "'IBM Plex Mono', 'Space Mono', ui-monospace, monospace",
  spaceMono: "'Space Mono', 'IBM Plex Mono', ui-monospace, monospace",
  inter: "'Inter', system-ui, -apple-system, sans-serif",
};

// ---- token keys this module owns (cleared on switch) ---------------------
export const NEO_MANAGED_KEYS = [
  '--neo-ink', '--neo-shadow-ink', '--neo-dot', '--neo-dot-size',
  '--neo-font', '--neo-display',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
  '--primary', '--primary-foreground',
  '--background', '--foreground',
  '--canvas-base', '--canvas-elevated', '--canvas-raised', '--canvas-overlay',
  '--card', '--card-foreground', '--popover', '--popover-foreground',
  '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground',
  '--text-primary', '--text-secondary', '--text-muted',
  '--success', '--warning', '--error',
  '--sh-accent', '--sh-accent-foreground',
] as const;

const RADII: Record<NeoRadius, Record<string, string>> = {
  sharp: { '--radius-sm': '0px', '--radius-md': '0px', '--radius-lg': '2px', '--radius-xl': '3px' },
  default: { '--radius-sm': '4px', '--radius-md': '8px', '--radius-lg': '10px', '--radius-xl': '12px' },
  soft: { '--radius-sm': '6px', '--radius-md': '12px', '--radius-lg': '16px', '--radius-xl': '20px' },
};

const mix = (a: string, pa: number, b: string) => `color-mix(in srgb, ${a} ${pa}%, ${b})`;

/** Expand a compact seed into the full set of neo surface tokens. Exported for
 *  tests and preview tooling; the app applies it through `applyNeoTheme`. */
export function expand(seed: NeoSeed, scheme: NeoScheme): Record<string, string> {
  const dark = scheme === 'dark';
  const { paper, ink, primary, onPrimary } = seed;

  // NOTE: color-mix percentages must sum to 100% — a smaller sum makes the
  // result translucent, which would let surfaces bleed through.
  const card = seed.card ?? (dark ? mix(paper, 88, '#ffffff 12%') : mix(paper, 42, '#ffffff 58%'));
  const raised = seed.raised ?? (dark ? mix(paper, 80, '#ffffff 20%') : mix(paper, 84, `${ink} 16%`));
  const muted = seed.muted ?? (dark ? mix(paper, 92, '#ffffff 8%') : mix(paper, 86, `${ink} 14%`));
  const overlay = card;
  const textSecondary = mix(ink, 78, `${paper} 22%`);
  const textMuted = mix(ink, 52, `${paper} 48%`);
  const shadow = seed.shadow ?? (dark ? mix(ink, 40, `${paper} 60%`) : ink);
  const dot = seed.dot ?? mix(ink, dark ? 15 : 13, 'transparent');
  const success = seed.success ?? (dark ? '#00e08a' : '#00c875');
  const warning = seed.warning ?? (dark ? '#ffd166' : '#f5d95f');
  const error = seed.error ?? (dark ? '#ff5f63' : '#ff3b30');
  const shAccent = mix(primary, 84, `${dark ? '#000000' : '#ffffff'} 16%`);

  return {
    '--neo-ink': ink,
    '--neo-shadow-ink': shadow,
    '--neo-dot': dot,
    '--primary': primary,
    '--primary-foreground': onPrimary,
    '--background': paper,
    '--foreground': ink,
    '--canvas-base': paper,
    '--canvas-elevated': card,
    '--canvas-raised': raised,
    '--canvas-overlay': overlay,
    '--card': card,
    '--card-foreground': ink,
    '--popover': card,
    '--popover-foreground': ink,
    '--secondary': raised,
    '--secondary-foreground': ink,
    '--muted': muted,
    '--muted-foreground': textSecondary,
    '--text-primary': ink,
    '--text-secondary': textSecondary,
    '--text-muted': textMuted,
    '--success': success,
    '--warning': warning,
    '--error': error,
    '--sh-accent': shAccent,
    '--sh-accent-foreground': onPrimary,
  };
}

// Common inks / papers reused across themes.
const INK = '#0a0a0a';
const CREAM = '#fff6df';
const PAPER2 = '#fff9ef';

export const NEO_THEMES: NeoTheme[] = [
  // ───────────────────────── POP — bright & loud ──────────────────────────
  {
    id: 'classic', label: 'Classic', group: 'Pop',
    swatch: ['#ffd84a', '#ff6bcb', INK],
    light: { paper: mix('#ffd84a', 13, 'white 87%'), ink: INK, primary: '#ffd84a', onPrimary: INK, card: '#ffffff' },
    dark: { paper: '#141414', ink: '#f4efe4', primary: '#ffd166', onPrimary: INK, card: '#1e1e1e', raised: '#272727', shadow: '#6b6258' },
  },
  {
    id: 'bubblegum', label: 'Bubblegum', group: 'Pop',
    swatch: ['#ff6bcb', '#7de3ff', '#ffffff'],
    light: { paper: '#ffffff', ink: INK, primary: '#ff6bcb', onPrimary: INK, raised: mix('#7de3ff', 18, 'white 82%') },
    dark: { paper: '#160d14', ink: '#ffeaf6', primary: '#ff6bcb', onPrimary: INK, card: '#21141d', raised: '#2b1b26' },
  },
  {
    id: 'mint-fresh', label: 'Mint Fresh', group: 'Pop',
    swatch: ['#5be3b0', '#ff6b5f', PAPER2],
    light: { paper: '#f3fff9', ink: INK, primary: '#5be3b0', onPrimary: INK },
    dark: { paper: '#0d1714', ink: '#e9fff5', primary: '#5be3b0', onPrimary: INK, card: '#13211c', raised: '#1b2c26' },
  },
  {
    id: 'tangerine', label: 'Tangerine', group: 'Pop',
    swatch: ['#ff7a1a', '#a98cff', CREAM],
    light: { paper: CREAM, ink: INK, primary: '#ff8a2b', onPrimary: INK },
    dark: { paper: '#17110a', ink: '#ffeede', primary: '#ff8a2b', onPrimary: INK, card: '#221810', raised: '#2d2014' },
  },
  {
    id: 'lagoon', label: 'Lagoon', group: 'Pop',
    swatch: ['#28c7e8', '#ffe45c', '#eafbff'],
    light: { paper: '#eafbff', ink: INK, primary: '#2fd0ef', onPrimary: INK },
    dark: { paper: '#08161b', ink: '#e2fbff', primary: '#2fd0ef', onPrimary: INK, card: '#0e2129', raised: '#142d36' },
  },
  {
    id: 'grape-soda', label: 'Grape Soda', group: 'Pop',
    swatch: ['#a98cff', '#b6ff6c', '#f4f0ff'],
    light: { paper: '#f4f0ff', ink: INK, primary: '#a98cff', onPrimary: INK },
    dark: { paper: '#120f1c', ink: '#efe9ff', primary: '#a98cff', onPrimary: INK, card: '#1b1630', raised: '#241d3f' },
  },
  {
    id: 'lime-punch', label: 'Lime Punch', group: 'Pop',
    swatch: ['#b6ff6c', '#ff4da6', '#ffffff'],
    light: { paper: '#fbffef', ink: INK, primary: '#aef25f', onPrimary: INK },
    dark: { paper: '#10140a', ink: '#f1ffe0', primary: '#aef25f', onPrimary: INK, card: '#1a2010', raised: '#232b16' },
  },
  {
    id: 'coral-crush', label: 'Coral Crush', group: 'Pop',
    swatch: ['#ff6b5f', '#5be3b0', '#fff3f0'],
    light: { paper: '#fff3f0', ink: INK, primary: '#ff6b5f', onPrimary: '#ffffff' },
    dark: { paper: '#180e0c', ink: '#ffe9e4', primary: '#ff7468', onPrimary: INK, card: '#231411', raised: '#2e1b17' },
  },
  {
    id: 'sky-pop', label: 'Sky Pop', group: 'Pop',
    swatch: ['#6fb7ff', '#ffd84a', '#eef6ff'],
    light: { paper: '#eef6ff', ink: INK, primary: '#6fb7ff', onPrimary: INK },
    dark: { paper: '#0a1018', ink: '#e6f1ff', primary: '#6fb7ff', onPrimary: INK, card: '#101a26', raised: '#172435' },
  },

  // ───────────────────────── DARK — loud on near-black ────────────────────
  {
    id: 'acid-noir', label: 'Acid Noir', group: 'Dark',
    swatch: ['#ffe45c', '#ff6bcb', '#0e0e0e'],
    light: { paper: '#fffdf2', ink: INK, primary: '#ffe45c', onPrimary: INK },
    dark: { paper: '#0e0e0e', ink: '#f6f1e6', primary: '#ffe45c', onPrimary: INK, card: '#181818', raised: '#222222', shadow: '#5f5a4e' },
  },
  {
    id: 'cyber-mint', label: 'Cyber Mint', group: 'Dark',
    swatch: ['#5be3b0', '#ff5fdc', '#0b0f0e'],
    light: { paper: '#f1fff9', ink: INK, primary: '#39d9a0', onPrimary: INK },
    dark: { paper: '#0b0f0e', ink: '#e9fff6', primary: '#3ff0ad', onPrimary: INK, card: '#121916', raised: '#19231f', shadow: '#4a6258' },
  },
  {
    id: 'vapor', label: 'Vapor', group: 'Dark',
    swatch: ['#ff6bcb', '#56e0ff', '#140b18'],
    light: { paper: '#fdf2ff', ink: '#1a0f1f', primary: '#ff6bcb', onPrimary: INK },
    dark: { paper: '#140b18', ink: '#ffe9fb', primary: '#ff6bcb', onPrimary: INK, card: '#1f1226', raised: '#2a1933', shadow: '#6a4d72' },
  },
  {
    id: 'electric-violet', label: 'Electric Violet', group: 'Dark',
    swatch: ['#7c5cff', '#b6ff6c', '#0d0b16'],
    light: { paper: '#f3f1ff', ink: '#0d0b16', primary: '#7c5cff', onPrimary: '#ffffff' },
    dark: { paper: '#0d0b16', ink: '#ece8ff', primary: '#8f72ff', onPrimary: '#ffffff', card: '#161224', raised: '#1f1a32', shadow: '#534c7a' },
  },
  {
    id: 'toxic-lime', label: 'Toxic Lime', group: 'Dark',
    swatch: ['#c6ff4d', '#ff3b8d', '#0c0f08'],
    light: { paper: '#fbffee', ink: INK, primary: '#9fe800', onPrimary: INK },
    dark: { paper: '#0c0f08', ink: '#eeffda', primary: '#c6ff4d', onPrimary: INK, card: '#131810', raised: '#1b2116', shadow: '#566049' },
  },
  {
    id: 'ember', label: 'Ember', group: 'Dark',
    swatch: ['#ff6a2b', '#ffd166', '#130c08'],
    light: { paper: '#fff5ee', ink: '#190d06', primary: '#ff6a2b', onPrimary: '#ffffff' },
    dark: { paper: '#130c08', ink: '#ffe9da', primary: '#ff7a3d', onPrimary: INK, card: '#1d130c', raised: '#281b12', shadow: '#6e5240' },
  },
  {
    id: 'arctic', label: 'Arctic', group: 'Dark',
    swatch: ['#56e0ff', '#ffffff', '#0a1016'],
    light: { paper: '#eef7fb', ink: '#08141d', primary: '#37cdf2', onPrimary: INK },
    dark: { paper: '#0a1016', ink: '#e8f6ff', primary: '#56e0ff', onPrimary: INK, card: '#101a22', raised: '#17242e', shadow: '#46606e' },
  },
  {
    id: 'hazard', label: 'Hazard', group: 'Dark',
    swatch: ['#ffd200', '#0a0a0a', '#111111'],
    radius: 'sharp', font: F.mono, display: F.archivo,
    light: { paper: '#fffced', ink: INK, primary: '#ffd200', onPrimary: INK },
    dark: { paper: '#111111', ink: '#fdf6df', primary: '#ffd200', onPrimary: INK, card: '#1a1a1a', raised: '#242424', shadow: '#615a3f' },
  },
  {
    id: 'magma', label: 'Magma', group: 'Dark',
    swatch: ['#ff3b6b', '#ff9f1c', '#120709'],
    radius: 'sharp',
    light: { paper: '#fff1f3', ink: '#1a070b', primary: '#ff3b6b', onPrimary: '#ffffff' },
    dark: { paper: '#120709', ink: '#ffe3e8', primary: '#ff4d74', onPrimary: '#ffffff', card: '#1d0d11', raised: '#281218', shadow: '#6e4049' },
  },

  // ───────────────────────── MONO & PRINT — ink-forward ───────────────────
  {
    id: 'xerox', label: 'Xerox', group: 'Mono & Print',
    swatch: ['#0a0a0a', '#ff3b30', '#ffffff'],
    radius: 'sharp', font: F.mono, display: F.archivo,
    light: { paper: '#ffffff', ink: INK, primary: INK, onPrimary: '#ffffff', raised: '#ededed', muted: '#f2f2f2', dot: mix(INK, 9, 'transparent') },
    dark: { paper: '#0c0c0c', ink: '#f4f4f4', primary: '#f4f4f4', onPrimary: INK, card: '#161616', raised: '#222222', shadow: '#555555' },
  },
  {
    id: 'newsprint', label: 'Newsprint', group: 'Mono & Print',
    swatch: ['#1a1a1a', '#d72631', '#f3ece0'],
    font: F.mono, display: F.archivo,
    light: { paper: '#f3ece0', ink: '#15130f', primary: '#15130f', onPrimary: '#f3ece0', error: '#d72631' },
    dark: { paper: '#15130f', ink: '#efe7d8', primary: '#efe7d8', onPrimary: '#15130f', card: '#1f1c16', raised: '#2a2620', shadow: '#615b4e' },
  },
  {
    id: 'blueprint', label: 'Blueprint', group: 'Mono & Print',
    swatch: ['#ffffff', '#7de3ff', '#0d2440'],
    font: F.mono,
    light: { paper: '#eef4fb', ink: '#0d2440', primary: '#1f4f86', onPrimary: '#ffffff', dot: mix('#0d2440', 16, 'transparent') },
    dark: { paper: '#0b1f38', ink: '#dfecfb', primary: '#8fd3ff', onPrimary: '#0b1f38', card: '#102744', raised: '#163251', shadow: '#3f5c80', dot: mix('#8fd3ff', 14, 'transparent') },
  },
  {
    id: 'riso-red', label: 'Riso Red', group: 'Mono & Print',
    swatch: ['#ff4438', '#2a4bd7', '#f6efe2'],
    font: F.spaceMono,
    light: { paper: '#f7f0e3', ink: '#1c1208', primary: '#ff4438', onPrimary: '#fff', success: '#2a4bd7' },
    dark: { paper: '#16100b', ink: '#ffe6e1', primary: '#ff5547', onPrimary: '#fff', card: '#201610', raised: '#2b1e16', shadow: '#6c4a40' },
  },
  {
    id: 'riso-blue', label: 'Riso Blue', group: 'Mono & Print',
    swatch: ['#2a4bd7', '#ff4438', '#f6efe2'],
    font: F.spaceMono,
    light: { paper: '#f4f0e6', ink: '#0c1330', primary: '#2a4bd7', onPrimary: '#fff', error: '#ff4438' },
    dark: { paper: '#0b0f1f', ink: '#e2e8ff', primary: '#6a82ff', onPrimary: '#0b0f1f', card: '#11172b', raised: '#182039', shadow: '#444f78' },
  },
  {
    id: 'graphite', label: 'Graphite', group: 'Mono & Print',
    swatch: ['#2d2d2d', '#ffd84a', '#e9e9e9'],
    light: { paper: '#ededed', ink: '#161616', primary: '#2d2d2d', onPrimary: '#ffffff', warning: '#ffd84a' },
    dark: { paper: '#121212', ink: '#ededed', primary: '#e6e6e6', onPrimary: '#121212', card: '#1c1c1c', raised: '#262626', shadow: '#555' },
  },

  // ───────────────────────── PASTEL — soft paper, candy accents ───────────
  {
    id: 'cotton-candy', label: 'Cotton Candy', group: 'Pastel',
    swatch: ['#ff9ad2', '#9be8ff', '#fff0f8'], radius: 'soft',
    light: { paper: '#fff0f8', ink: '#3a1730', primary: '#ff9ad2', onPrimary: '#3a1730' },
    dark: { paper: '#1a1018', ink: '#ffe6f4', primary: '#ff9ad2', onPrimary: '#3a1730', card: '#241620', raised: '#2f1d2a' },
  },
  {
    id: 'pistachio', label: 'Pistachio', group: 'Pastel',
    swatch: ['#a8e6a1', '#ffcf6b', '#f0f7e9'], radius: 'soft',
    light: { paper: '#f0f7e9', ink: '#1a2a14', primary: '#9bd98f', onPrimary: '#16240f' },
    dark: { paper: '#101610', ink: '#e8f5e2', primary: '#9bd98f', onPrimary: '#16240f', card: '#172017', raised: '#1f2a1e' },
  },
  {
    id: 'peach', label: 'Peach', group: 'Pastel',
    swatch: ['#ffb59a', '#8fd3ff', '#fff3ec'], radius: 'soft',
    light: { paper: '#fff3ec', ink: '#3a1d12', primary: '#ffab8a', onPrimary: '#3a1d12' },
    dark: { paper: '#1a110c', ink: '#ffe7db', primary: '#ffab8a', onPrimary: '#3a1d12', card: '#241812', raised: '#2f201a' },
  },
  {
    id: 'lavender-haze', label: 'Lavender Haze', group: 'Pastel',
    swatch: ['#c4b1ff', '#ffd6a8', '#f3effc'], radius: 'soft',
    light: { paper: '#f3effc', ink: '#241a3a', primary: '#c4b1ff', onPrimary: '#241a3a' },
    dark: { paper: '#14111e', ink: '#ece6ff', primary: '#c4b1ff', onPrimary: '#241a3a', card: '#1d1830', raised: '#26203f' },
  },
  {
    id: 'butter', label: 'Butter', group: 'Pastel',
    swatch: ['#ffe39a', '#a8d8c0', '#fffae8'], radius: 'soft',
    light: { paper: '#fffae8', ink: '#3a2c0e', primary: '#ffe08a', onPrimary: '#3a2c0e' },
    dark: { paper: '#17130a', ink: '#fff3d6', primary: '#ffe08a', onPrimary: '#3a2c0e', card: '#211a0f', raised: '#2c2315' },
  },
  {
    id: 'cloud-nine', label: 'Cloud Nine', group: 'Pastel',
    swatch: ['#a8d0ff', '#ffb3c1', '#eef5ff'], radius: 'soft',
    light: { paper: '#eef5ff', ink: '#142440', primary: '#a8d0ff', onPrimary: '#142440' },
    dark: { paper: '#0d121c', ink: '#e6efff', primary: '#a8d0ff', onPrimary: '#142440', card: '#131b29', raised: '#1a2536' },
  },

  // ───────────────────────── EARTH & RETRO — warm 70s ─────────────────────
  {
    id: 'terracotta', label: 'Terracotta', group: 'Earth & Retro',
    swatch: ['#d2693f', '#e8b423', '#f4e7d4'],
    light: { paper: '#f4e7d4', ink: '#2c1409', primary: '#d2693f', onPrimary: '#fff5ec' },
    dark: { paper: '#1a0f08', ink: '#f6e3cf', primary: '#e07a4e', onPrimary: '#1a0f08', card: '#23160d', raised: '#2e1f14', shadow: '#6f5341' },
  },
  {
    id: 'mustard', label: 'Mustard Field', group: 'Earth & Retro',
    swatch: ['#e3b007', '#3f7d4f', '#f3ead2'],
    light: { paper: '#f3ead2', ink: '#2a230c', primary: '#e8b81c', onPrimary: '#2a230c', success: '#3f7d4f' },
    dark: { paper: '#161206', ink: '#f4ecca', primary: '#e8b81c', onPrimary: '#2a230c', card: '#1f1a0c', raised: '#2a2312', shadow: '#62593b' },
  },
  {
    id: 'forest', label: 'Forest', group: 'Earth & Retro',
    swatch: ['#2f8f5b', '#ff9f43', '#eef3e6'],
    light: { paper: '#eef3e6', ink: '#0f2417', primary: '#2f8f5b', onPrimary: '#fff', warning: '#ff9f43' },
    dark: { paper: '#0b150f', ink: '#e4f1e6', primary: '#48b277', onPrimary: '#0b150f', card: '#111e16', raised: '#18291e', shadow: '#41604c' },
  },
  {
    id: 'cocoa', label: 'Cocoa', group: 'Earth & Retro',
    swatch: ['#c98a4b', '#7bb89a', '#1a120c'],
    light: { paper: '#f6ecdf', ink: '#231509', primary: '#b9743a', onPrimary: '#fff6ec' },
    dark: { paper: '#1a120c', ink: '#f1e2d0', primary: '#d29355', onPrimary: '#1a120c', card: '#241910', raised: '#302216', shadow: '#6c5340' },
  },
  {
    id: 'sunset', label: 'Sunset Strip', group: 'Earth & Retro',
    swatch: ['#ff7a59', '#ff3d9a', '#ffeede'],
    light: { paper: '#ffeede', ink: '#2c1230', primary: '#ff7a59', onPrimary: '#fff', error: '#ff3d9a' },
    dark: { paper: '#190b14', ink: '#ffe6dc', primary: '#ff8a6a', onPrimary: '#190b14', card: '#23121b', raised: '#2e1a25', shadow: '#6e4658' },
  },
  {
    id: 'oceanic', label: 'Oceanic', group: 'Earth & Retro',
    swatch: ['#11a8a8', '#ffce4f', '#e6f5f3'],
    light: { paper: '#e6f5f3', ink: '#06231f', primary: '#13b3b0', onPrimary: '#042320', warning: '#ffce4f' },
    dark: { paper: '#061615', ink: '#dcf4f0', primary: '#27ccc8', onPrimary: '#061615', card: '#0c211f', raised: '#122d2a', shadow: '#3d605c' },
  },
];

/** Ordered list of unique theme groups, for sectioned pickers. */
export const NEO_GROUPS: string[] = NEO_THEMES.reduce<string[]>((groups, t) => {
  if (!groups.includes(t.group)) groups.push(t.group);
  return groups;
}, []);

// ---- persistence ---------------------------------------------------------
const STORAGE_KEY = 'agensis_neo_theme';
export const DEFAULT_NEO_THEME = 'classic';

export function getStoredNeoTheme(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_NEO_THEME;
  } catch {
    return DEFAULT_NEO_THEME;
  }
}

function persist(id: string) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
}

function currentScheme(): NeoScheme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Strip every token this module manages, restoring the family's CSS defaults. */
export function clearNeoThemeVars() {
  const root = document.documentElement;
  for (const key of NEO_MANAGED_KEYS) root.style.removeProperty(key);
}

/** Write a theme's tokens inline for the given scheme. */
function applyNeoThemeVars(theme: NeoTheme, scheme: NeoScheme) {
  const root = document.documentElement;
  clearNeoThemeVars();
  const vars = expand(scheme === 'dark' ? theme.dark : theme.light, scheme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(RADII[theme.radius ?? 'default'])) root.style.setProperty(k, v);
  if (theme.font) root.style.setProperty('--neo-font', theme.font);
  if (theme.display) root.style.setProperty('--neo-display', theme.display);
}

export function findNeoTheme(id: string): NeoTheme {
  return NEO_THEMES.find((t) => t.id === id) ?? NEO_THEMES[0];
}

/** Select a neo theme (persists + applies if the neo family is active). */
export function applyNeoTheme(id: string) {
  persist(id);
  if (document.documentElement.getAttribute('data-ui-theme') !== 'neo') return;
  applyNeoThemeVars(findNeoTheme(id), currentScheme());
}

/**
 * Reconcile palette state with the current UI family + scheme. Call this after
 * [data-ui-theme] / [data-theme] change (the useTheme hook does this):
 *  - neo family    → apply the stored neo theme for the active scheme
 *  - other family  → drop neo overrides and restore the brand-hue accent preset
 * Re-applying on scheme change is what swaps each theme's light/dark seed.
 */
export function syncNeoTheme() {
  const root = document.documentElement;
  if (root.getAttribute('data-ui-theme') === 'neo') {
    applyNeoThemeVars(findNeoTheme(getStoredNeoTheme()), currentScheme());
  } else {
    clearNeoThemeVars();
    applyThemePreset(getStoredPreset());
  }
}
