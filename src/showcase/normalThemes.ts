// Normal (non-brutal) theme registry.
//
// These themes apply to the 'classic' Chrome family (no thick borders, hard
// shadows, or display-font overrides) and repaint the full colour palette by
// writing CSS custom-property overrides inline on <html>. They compose with
// the app's existing light/dark toggle: picking a theme + toggling
// 'normal-light' / 'normal-dark' swaps between the theme's two seeds.

export interface NormalSeed {
  bg: string;          // --background, --canvas-base
  elevated: string;    // --card, --popover, --canvas-elevated
  raised: string;      // --secondary, --canvas-raised
  muted: string;       // --muted, --canvas-overlay
  fg: string;          // --foreground, --text-primary
  fgMuted: string;     // --muted-foreground, --text-secondary
  primary: string;     // --primary, --accent
  onPrimary: string;   // --primary-foreground
  border: string;      // --border, --sh-border, --input
  ring?: string;       // --ring (defaults to primary)
}

export interface NormalTheme {
  id: string;
  label: string;
  group: string;
  /** [primary, elevated, bg] colours for the picker chip */
  swatch: [string, string, string];
  light: NormalSeed;
  dark: NormalSeed;
}

export const NORMAL_MANAGED_KEYS = [
  '--background', '--foreground',
  '--card', '--card-foreground',
  '--popover', '--popover-foreground',
  '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground',
  '--sh-accent', '--sh-accent-foreground',
  '--sh-border', '--input', '--ring',
  '--sidebar', '--sidebar-foreground',
  '--canvas-base', '--canvas-elevated', '--canvas-raised', '--canvas-overlay',
  '--border', '--border-subtle', '--border-strong',
  '--text-primary', '--text-secondary', '--text-muted', '--text-inverse',
  '--accent', '--accent-hover', '--accent-subtle', '--accent-border',
] as const;

const mix = (a: string, pa: number, b: string) =>
  `color-mix(in srgb, ${a} ${pa}%, ${b})`;

export function expandNormal(seed: NormalSeed): Record<string, string> {
  const { bg, elevated, raised, muted, fg, fgMuted, primary, onPrimary, border } = seed;
  const ring = seed.ring ?? primary;
  const borderSubtle = mix(border, 55, bg);
  const borderStrong = mix(border, 55, fg);
  const textMuted = mix(fgMuted, 55, bg);
  const accentHover = mix(primary, 82, fg);
  const accentSubtle = `color-mix(in srgb, ${primary} 10%, transparent)`;
  const accentBorder = `color-mix(in srgb, ${primary} 25%, transparent)`;
  const shAccent = mix(primary, 18, bg);

  return {
    '--background': bg,
    '--foreground': fg,
    '--card': elevated,
    '--card-foreground': fg,
    '--popover': elevated,
    '--popover-foreground': fg,
    '--primary': primary,
    '--primary-foreground': onPrimary,
    '--secondary': raised,
    '--secondary-foreground': fg,
    '--muted': muted,
    '--muted-foreground': fgMuted,
    '--sh-accent': shAccent,
    '--sh-accent-foreground': fg,
    '--sh-border': border,
    '--input': border,
    '--ring': ring,
    '--sidebar': elevated,
    '--sidebar-foreground': fg,
    '--canvas-base': bg,
    '--canvas-elevated': elevated,
    '--canvas-raised': raised,
    '--canvas-overlay': elevated,
    '--border': border,
    '--border-subtle': borderSubtle,
    '--border-strong': borderStrong,
    '--text-primary': fg,
    '--text-secondary': fgMuted,
    '--text-muted': textMuted,
    '--text-inverse': onPrimary,
    '--accent': primary,
    '--accent-hover': accentHover,
    '--accent-subtle': accentSubtle,
    '--accent-border': accentBorder,
  };
}

export const NORMAL_THEMES: NormalTheme[] = [
  // ── Minimal — neutral grey scales ────────────────────────────────────────
  {
    id: 'slate', label: 'Slate', group: 'Minimal',
    swatch: ['#1e40af', '#f1f5f9', '#f8fafc'],
    light: { bg: '#f8fafc', elevated: '#ffffff', raised: '#f1f5f9', muted: '#e2e8f0', fg: '#0f172a', fgMuted: '#64748b', primary: '#1e40af', onPrimary: '#ffffff', border: '#cbd5e1' },
    dark:  { bg: '#0f172a', elevated: '#1e293b', raised: '#334155', muted: '#1e293b', fg: '#f1f5f9', fgMuted: '#94a3b8', primary: '#60a5fa', onPrimary: '#0f172a', border: '#334155' },
  },
  {
    id: 'zinc', label: 'Zinc', group: 'Minimal',
    swatch: ['#18181b', '#f4f4f5', '#fafafa'],
    light: { bg: '#fafafa', elevated: '#ffffff', raised: '#f4f4f5', muted: '#e4e4e7', fg: '#18181b', fgMuted: '#71717a', primary: '#18181b', onPrimary: '#fafafa', border: '#d4d4d8' },
    dark:  { bg: '#18181b', elevated: '#27272a', raised: '#3f3f46', muted: '#27272a', fg: '#fafafa', fgMuted: '#a1a1aa', primary: '#e4e4e7', onPrimary: '#18181b', border: '#3f3f46' },
  },
  {
    id: 'stone', label: 'Stone', group: 'Minimal',
    swatch: ['#44403c', '#f5f5f4', '#fafaf9'],
    light: { bg: '#fafaf9', elevated: '#ffffff', raised: '#f5f5f4', muted: '#e7e5e4', fg: '#1c1917', fgMuted: '#78716c', primary: '#44403c', onPrimary: '#fafaf9', border: '#d6d3d1' },
    dark:  { bg: '#1c1917', elevated: '#292524', raised: '#44403c', muted: '#292524', fg: '#fafaf9', fgMuted: '#a8a29e', primary: '#d6d3d1', onPrimary: '#1c1917', border: '#44403c' },
  },

  // ── Developer — code-editor palettes ─────────────────────────────────────
  {
    id: 'dracula', label: 'Dracula', group: 'Developer',
    swatch: ['#bd93f9', '#21222c', '#282a36'],
    light: { bg: '#f8f8f2', elevated: '#ffffff', raised: '#f0ecfe', muted: '#e6e2fc', fg: '#282a36', fgMuted: '#6272a4', primary: '#7c3aed', onPrimary: '#ffffff', border: '#d0c8f0' },
    dark:  { bg: '#282a36', elevated: '#21222c', raised: '#343746', muted: '#1d1e27', fg: '#f8f8f2', fgMuted: '#6272a4', primary: '#bd93f9', onPrimary: '#282a36', border: '#44475a' },
  },
  {
    id: 'tokyo-night', label: 'Tokyo Night', group: 'Developer',
    swatch: ['#7aa2f7', '#16161e', '#1a1b26'],
    light: { bg: '#d5d6db', elevated: '#e9e9ec', raised: '#c8c8cf', muted: '#babbc2', fg: '#343b58', fgMuted: '#6b7089', primary: '#2e7de9', onPrimary: '#d5d6db', border: '#a8a9b4' },
    dark:  { bg: '#1a1b26', elevated: '#16161e', raised: '#24283b', muted: '#13141c', fg: '#c0caf5', fgMuted: '#565f89', primary: '#7aa2f7', onPrimary: '#1a1b26', border: '#292e42' },
  },
  {
    id: 'one-dark', label: 'One Dark', group: 'Developer',
    swatch: ['#61afef', '#21252b', '#282c34'],
    light: { bg: '#fafafa', elevated: '#ffffff', raised: '#f0f0f5', muted: '#e8e8f0', fg: '#383a42', fgMuted: '#696c77', primary: '#4078f2', onPrimary: '#ffffff', border: '#d3d3d8' },
    dark:  { bg: '#282c34', elevated: '#21252b', raised: '#2c313c', muted: '#1e2128', fg: '#abb2bf', fgMuted: '#636d83', primary: '#61afef', onPrimary: '#282c34', border: '#3e4451' },
  },
  {
    id: 'nord', label: 'Nord', group: 'Developer',
    swatch: ['#88c0d0', '#3b4252', '#2e3440'],
    light: { bg: '#eceff4', elevated: '#e5e9f0', raised: '#d8dee9', muted: '#ccd3df', fg: '#2e3440', fgMuted: '#4c566a', primary: '#5e81ac', onPrimary: '#eceff4', border: '#c8ceda' },
    dark:  { bg: '#2e3440', elevated: '#3b4252', raised: '#434c5e', muted: '#2b3241', fg: '#eceff4', fgMuted: '#d8dee9', primary: '#88c0d0', onPrimary: '#2e3440', border: '#4c566a' },
  },
  {
    id: 'catppuccin', label: 'Catppuccin', group: 'Developer',
    swatch: ['#cba6f7', '#181825', '#1e1e2e'],
    light: { bg: '#eff1f5', elevated: '#e6e9ef', raised: '#dce0e8', muted: '#ccd0da', fg: '#4c4f69', fgMuted: '#6c6f85', primary: '#8839ef', onPrimary: '#eff1f5', border: '#bcc0cc' },
    dark:  { bg: '#1e1e2e', elevated: '#181825', raised: '#313244', muted: '#181825', fg: '#cdd6f4', fgMuted: '#a6adc8', primary: '#cba6f7', onPrimary: '#1e1e2e', border: '#45475a' },
  },
  {
    id: 'gruvbox', label: 'Gruvbox', group: 'Developer',
    swatch: ['#fabd2f', '#3c3836', '#282828'],
    light: { bg: '#fbf1c7', elevated: '#f2e5bc', raised: '#ebdbb2', muted: '#d5c4a1', fg: '#3c3836', fgMuted: '#7c6f64', primary: '#d65d0e', onPrimary: '#fbf1c7', border: '#bdae93' },
    dark:  { bg: '#282828', elevated: '#3c3836', raised: '#504945', muted: '#1d2021', fg: '#ebdbb2', fgMuted: '#a89984', primary: '#fabd2f', onPrimary: '#282828', border: '#504945' },
  },
  {
    id: 'solarized', label: 'Solarized', group: 'Developer',
    swatch: ['#268bd2', '#073642', '#002b36'],
    light: { bg: '#fdf6e3', elevated: '#eee8d5', raised: '#e8e2cf', muted: '#e2dcc9', fg: '#657b83', fgMuted: '#93a1a1', primary: '#268bd2', onPrimary: '#fdf6e3', border: '#cec8b4' },
    dark:  { bg: '#002b36', elevated: '#073642', raised: '#0e454f', muted: '#002028', fg: '#839496', fgMuted: '#586e75', primary: '#268bd2', onPrimary: '#002b36', border: '#094556' },
  },
  {
    id: 'github', label: 'GitHub', group: 'Developer',
    swatch: ['#0969da', '#f6f8fa', '#ffffff'],
    light: { bg: '#ffffff', elevated: '#ffffff', raised: '#f6f8fa', muted: '#eaeef2', fg: '#1f2328', fgMuted: '#636c76', primary: '#0969da', onPrimary: '#ffffff', border: '#d0d7de' },
    dark:  { bg: '#0d1117', elevated: '#161b22', raised: '#21262d', muted: '#0d1117', fg: '#e6edf3', fgMuted: '#8b949e', primary: '#2f81f7', onPrimary: '#ffffff', border: '#30363d' },
  },
  {
    id: 'everforest', label: 'Everforest', group: 'Developer',
    swatch: ['#8da101', '#f4f0d9', '#fdf6e3'],
    light: { bg: '#fdf6e3', elevated: '#fffbef', raised: '#f4f0d9', muted: '#eeead4', fg: '#414b50', fgMuted: '#829181', primary: '#8da101', onPrimary: '#fffbef', border: '#ddd8be' },
    dark:  { bg: '#2d353b', elevated: '#343f44', raised: '#3d484d', muted: '#272e33', fg: '#d3c6aa', fgMuted: '#859289', primary: '#a7c080', onPrimary: '#2d353b', border: '#4f585e' },
  },
  {
    id: 'rose-pine', label: 'Rosé Pine', group: 'Developer',
    swatch: ['#c4a7e7', '#1f1d2e', '#191724'],
    light: { bg: '#faf4ed', elevated: '#fffaf3', raised: '#f2e9e1', muted: '#ece0d6', fg: '#575279', fgMuted: '#797593', primary: '#907aa9', onPrimary: '#fffaf3', border: '#dfd8ca' },
    dark:  { bg: '#191724', elevated: '#1f1d2e', raised: '#26233a', muted: '#151320', fg: '#e0def4', fgMuted: '#908caa', primary: '#c4a7e7', onPrimary: '#191724', border: '#403d52' },
  },
  {
    id: 'kanagawa', label: 'Kanagawa', group: 'Developer',
    swatch: ['#7e9cd8', '#16161d', '#1f1f28'],
    light: { bg: '#e9e2c4', elevated: '#f2eccf', raised: '#ded6ac', muted: '#d4cb9c', fg: '#545464', fgMuted: '#716e61', primary: '#4d699b', onPrimary: '#f2eccf', border: '#cfc79a' },
    dark:  { bg: '#1f1f28', elevated: '#16161d', raised: '#2a2a37', muted: '#181820', fg: '#dcd7ba', fgMuted: '#727169', primary: '#7e9cd8', onPrimary: '#1f1f28', border: '#363646' },
  },

  // ── Tinted — muted accent washes ─────────────────────────────────────────
  {
    id: 'ocean', label: 'Ocean', group: 'Tinted',
    swatch: ['#1d4ed8', '#dbeafe', '#eff6ff'],
    light: { bg: '#eff6ff', elevated: '#ffffff', raised: '#dbeafe', muted: '#bfdbfe', fg: '#1e3a5f', fgMuted: '#3b82f6', primary: '#1d4ed8', onPrimary: '#ffffff', border: '#93c5fd' },
    dark:  { bg: '#020f1f', elevated: '#05213f', raised: '#0a3260', muted: '#011626', fg: '#bfdbfe', fgMuted: '#60a5fa', primary: '#3b82f6', onPrimary: '#020f1f', border: '#1e3a5f' },
  },
  {
    id: 'rose', label: 'Rose', group: 'Tinted',
    swatch: ['#e11d48', '#ffe4e6', '#fff1f2'],
    light: { bg: '#fff1f2', elevated: '#ffffff', raised: '#ffe4e6', muted: '#fecdd3', fg: '#881337', fgMuted: '#be123c', primary: '#e11d48', onPrimary: '#ffffff', border: '#fda4af' },
    dark:  { bg: '#1c0610', elevated: '#2a0a18', raised: '#3b1124', muted: '#160509', fg: '#fce7f0', fgMuted: '#fb7185', primary: '#f43f5e', onPrimary: '#1c0610', border: '#3b1124' },
  },
  {
    id: 'forest', label: 'Forest', group: 'Tinted',
    swatch: ['#16a34a', '#dcfce7', '#f0fdf4'],
    light: { bg: '#f0fdf4', elevated: '#ffffff', raised: '#dcfce7', muted: '#bbf7d0', fg: '#14532d', fgMuted: '#16a34a', primary: '#16a34a', onPrimary: '#ffffff', border: '#86efac' },
    dark:  { bg: '#052e16', elevated: '#14532d', raised: '#166534', muted: '#031b0e', fg: '#dcfce7', fgMuted: '#4ade80', primary: '#22c55e', onPrimary: '#052e16', border: '#166534' },
  },
  {
    id: 'amber', label: 'Amber', group: 'Tinted',
    swatch: ['#d97706', '#fef3c7', '#fffbeb'],
    light: { bg: '#fffbeb', elevated: '#ffffff', raised: '#fef3c7', muted: '#fde68a', fg: '#78350f', fgMuted: '#b45309', primary: '#d97706', onPrimary: '#ffffff', border: '#fcd34d' },
    dark:  { bg: '#1c0d00', elevated: '#3d1f00', raised: '#541e00', muted: '#120900', fg: '#fef3c7', fgMuted: '#fbbf24', primary: '#f59e0b', onPrimary: '#1c0d00', border: '#541e00' },
  },
  {
    id: 'sepia', label: 'Sepia', group: 'Tinted',
    swatch: ['#a8642a', '#fbf5e6', '#f4ecd8'],
    light: { bg: '#f4ecd8', elevated: '#fbf5e6', raised: '#ebe1c8', muted: '#e2d6b8', fg: '#433422', fgMuted: '#7a6a52', primary: '#a8642a', onPrimary: '#fbf5e6', border: '#d8cbac' },
    dark:  { bg: '#1c1710', elevated: '#262016', raised: '#322a1d', muted: '#181309', fg: '#ece0c8', fgMuted: '#a3927a', primary: '#d08a4e', onPrimary: '#1c1710', border: '#453a28' },
  },
];

/** Ordered unique group list for sectioned pickers. */
export const NORMAL_GROUPS: string[] = NORMAL_THEMES.reduce<string[]>((acc, t) => {
  if (!acc.includes(t.group)) acc.push(t.group);
  return acc;
}, []);

// ── persistence ───────────────────────────────────────────────────────────

const STORAGE_KEY = 'agensis_normal_theme';

export function getStoredNormalTheme(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
}

function persist(id: string) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
}

export function findNormalTheme(id: string): NormalTheme | undefined {
  return NORMAL_THEMES.find(t => t.id === id);
}

export function clearNormalTheme() {
  const root = document.documentElement;
  for (const key of NORMAL_MANAGED_KEYS) root.style.removeProperty(key);
}

function currentScheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyNormalThemeVars(theme: NormalTheme, scheme: 'light' | 'dark') {
  const seed = scheme === 'dark' ? theme.dark : theme.light;
  const vars = expandNormal(seed);
  const root = document.documentElement;
  clearNormalTheme();
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

export function applyNormalTheme(id: string) {
  persist(id);
  const theme = findNormalTheme(id);
  if (!theme) return;
  applyNormalThemeVars(theme, currentScheme());
}

/**
 * Reconcile: called from applyTheme after the scheme / family have been set.
 * If the active mode is 'normal-*', apply the stored normal theme for the
 * current scheme. Otherwise clear any normal overrides.
 */
export function syncNormalTheme(mode: string) {
  if (mode === 'normal-light' || mode === 'normal-dark') {
    const id = getStoredNormalTheme();
    const theme = id ? findNormalTheme(id) : undefined;
    if (theme) {
      applyNormalThemeVars(theme, currentScheme());
    } else {
      clearNormalTheme();
    }
  } else {
    clearNormalTheme();
  }
}
