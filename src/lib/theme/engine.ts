// The Default family's palette, GENERATED from a handful of seeds.
//
// WHY
// ---
// Every family used to be hand-written hex: two 50-line blocks per family in
// index.css, plus an accent preset that patched four variables inline on
// :root. A theme was therefore a fixed artefact. Change the tint of the greys
// and you re-typed thirty values; raise the contrast and nothing knew how.
//
// Here a theme is FIVE orthogonal choices, and everything else is derived:
//
//   palette   the tint of the neutrals (hue + a very small chroma)
//   accent    the brand hue — or "ink", where the primary IS the text colour
//   contrast  soft / standard / high: how far text and lines sit from paper
//   depth     hard (the softly-brutal offset shadow) / soft (blurred) / flat
//   scheme    light / dark (the existing [data-theme] axis)
//
// Secondary and faint text are not picked, they are SOLVED: the engine walks
// lightness until the WCAG contrast against the page meets the contrast
// level's target, so a warm, cool or high-contrast palette can never produce
// unreadable meta text. Graphite at standard contrast reproduces the old
// hand-written Default values to within a rounding step, so nobody's screen
// jumps when this lands.
//
// HOW IT IS APPLIED
// -----------------
// As scheme-scoped CSS rules in one <style> element — NOT inline styles on
// :root. An inline declaration beats every [data-theme] scope, which is how a
// light-mode tint once froze into dark mode (see themePresets.ts). Both
// schemes are emitted every time, so flipping light/dark needs no re-run.
// The selector doubles :root to outrank the static Default blocks in
// index.css (0,4,0 vs 0,3,0), which stay as the first-paint fallback.

export type ThemeScheme = 'light' | 'dark';
export type ThemeContrast = 'soft' | 'standard' | 'high';
export type ThemeDepth = 'hard' | 'soft' | 'flat';

export interface ThemePalette {
  id: string;
  label: string;
  /** OKLCH hue of the neutrals. Irrelevant when chroma is 0. */
  hue: number;
  /** OKLCH chroma of the neutrals. Keep tiny: 0.004–0.02 reads as a tint, not a colour. */
  chroma: number;
}

/** An OKLCH accent, or null for "ink": primary = text colour. */
export interface ThemeAccent {
  l: number;
  c: number;
  h: number;
}

export interface ThemeSeed {
  palette: ThemePalette;
  accent: ThemeAccent | null;
  contrast: ThemeContrast;
  depth: ThemeDepth;
}

export const THEME_PALETTES: ThemePalette[] = [
  { id: 'graphite', label: 'Graphite', hue: 0, chroma: 0 },
  { id: 'stone', label: 'Stone', hue: 70, chroma: 0.007 },
  { id: 'sand', label: 'Sand', hue: 82, chroma: 0.018 },
  { id: 'slate', label: 'Slate', hue: 255, chroma: 0.013 },
  { id: 'sage', label: 'Sage', hue: 150, chroma: 0.011 },
  { id: 'plum', label: 'Plum', hue: 315, chroma: 0.012 },
];

export const THEME_CONTRASTS: Array<{ id: ThemeContrast; label: string }> = [
  { id: 'soft', label: 'Soft' },
  { id: 'standard', label: 'Standard' },
  { id: 'high', label: 'High' },
];

export const THEME_DEPTHS: Array<{ id: ThemeDepth; label: string; description: string }> = [
  { id: 'hard', label: 'Hard', description: 'Offset shadows with no blur' },
  { id: 'soft', label: 'Soft', description: 'Blurred, low shadows' },
  { id: 'flat', label: 'Flat', description: 'Hairlines only; shadows on menus' },
];

// ---------------------------------------------------------------------------
// Colour maths: OKLCH -> linear sRGB -> WCAG relative luminance.
// ---------------------------------------------------------------------------

function oklchToLinearRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

export function luminance(l: number, c: number, h: number): number {
  const [r, g, b] = oklchToLinearRgb(l, c, h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The lightness, moving AWAY from the background, at which text of this
 * hue/chroma first reaches `target` contrast against it. Clamped to the ink
 * end if the target is unreachable.
 */
export function solveLightness(bgL: number, c: number, h: number, target: number, dark: boolean): number {
  const bgY = luminance(bgL, c, h);
  let lo = bgL;
  let hi = dark ? 1 : 0;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(luminance(mid, c, h), bgY) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (l: number, c: number, h: number, alpha?: number) =>
  `oklch(${r3(l)} ${r3(c)} ${r3(h)}${alpha === undefined ? '' : ` / ${alpha}`})`;

// ---------------------------------------------------------------------------
// The ramps. Lightness anchors are the old hand-written Default hex values
// converted to OKLCH (#f8f8f8 = 0.976, #0c0c0c = 0.153, ...).
// ---------------------------------------------------------------------------

interface Ramp {
  base: number; card: number; raised: number; overlay: number;
  border: number; borderSubtle: number; borderStrong: number;
  ink: number;
}

const RAMP: Record<ThemeScheme, Ramp> = {
  light: { base: 0.976, card: 1, raised: 0.955, overlay: 1, border: 0.907, borderSubtle: 0.937, borderStrong: 0.845, ink: 0.218 },
  dark: { base: 0.153, card: 0.187, raised: 0.217, overlay: 0.239, border: 0.265, borderSubtle: 0.222, borderStrong: 0.314, ink: 0.961 },
};

/** [secondary text target, faint text target, line distance multiplier, ink shift] */
const CONTRAST: Record<ThemeContrast, { secondary: number; faint: number; line: number; ink: number }> = {
  soft: { secondary: 4.8, faint: 3, line: 0.75, ink: 0.04 },
  standard: { secondary: 6.4, faint: 3.2, line: 1, ink: 0 },
  high: { secondary: 9, faint: 4.6, line: 1.5, ink: -0.08 },
};

function shadows(depth: ThemeDepth, scheme: ThemeScheme): Record<string, string> {
  const dark = scheme === 'dark';
  if (depth === 'hard') {
    // The Default family's signature, unchanged: hard-edged offsets. Toward
    // black in dark mode — mixing toward --foreground there makes a highlight.
    const ink = (pct: number, darkAlpha: number) => dark
      ? `rgba(0, 0, 0, ${darkAlpha})`
      : `color-mix(in srgb, var(--foreground) ${pct}%, transparent)`;
    return {
      '--shadow-sm': `2px 2px 0 ${ink(18, 0.55)}`,
      '--shadow-md': `3px 3px 0 ${ink(22, 0.6)}`,
      '--shadow-lg': `4px 4px 0 ${ink(26, 0.65)}`,
      '--shadow-xl': `5px 5px 0 ${ink(30, 0.7)}`,
      '--shadow-2xl': `6px 6px 0 ${ink(32, 0.75)}`,
      '--shadow-window': `4px 4px 0 ${ink(24, 0.62)}`,
      '--chrome-cast': `1px 0 0 ${ink(10, 0.5)}, 6px 0 0 ${ink(18, 0.6)}`,
      '--default-hard-shadow': `2px 2px 0 ${ink(20, 0.6)}`,
      '--default-hard-shadow-hover': `3px 3px 0 ${ink(22, 0.7)}`,
    };
  }
  const a = (light: number, darkA: number) => (dark ? darkA : light);
  const soft = {
    '--shadow-sm': `0 1px 2px rgba(0, 0, 0, ${a(0.06, 0.3)}), 0 2px 8px rgba(0, 0, 0, ${a(0.06, 0.25)})`,
    '--shadow-md': `0 2px 4px rgba(0, 0, 0, ${a(0.07, 0.35)}), 0 6px 16px rgba(0, 0, 0, ${a(0.08, 0.35)})`,
    '--shadow-lg': `0 4px 8px rgba(0, 0, 0, ${a(0.08, 0.4)}), 0 12px 28px -2px rgba(0, 0, 0, ${a(0.1, 0.45)})`,
    '--shadow-xl': `0 8px 16px rgba(0, 0, 0, ${a(0.1, 0.45)}), 0 20px 44px -6px rgba(0, 0, 0, ${a(0.14, 0.55)})`,
    '--shadow-2xl': `0 12px 24px rgba(0, 0, 0, ${a(0.12, 0.5)}), 0 28px 60px -8px rgba(0, 0, 0, ${a(0.16, 0.6)})`,
    '--shadow-window': `0 10px 24px -14px rgba(0, 0, 0, ${a(0.18, 0.7)})`,
    '--chrome-cast': `1px 0 0 rgba(0, 0, 0, ${a(0.08, 0.45)}), 7px 0 14px -8px rgba(0, 0, 0, ${a(0.18, 0.7)})`,
    '--default-hard-shadow': `0 1px 2px rgba(0, 0, 0, ${a(0.08, 0.35)})`,
    '--default-hard-shadow-hover': `0 2px 6px rgba(0, 0, 0, ${a(0.12, 0.45)})`,
  };
  if (depth === 'soft') return soft;
  // Flat: controls and cards carry no shadow at all; anything that genuinely
  // floats (menus, popovers, windows) keeps a soft one, or it would vanish
  // into what is behind it.
  return {
    ...soft,
    '--shadow-sm': 'none',
    '--shadow-md': 'none',
    '--chrome-cast': `1px 0 0 rgba(0, 0, 0, ${a(0.08, 0.45)})`,
    '--default-hard-shadow': 'none',
    '--default-hard-shadow-hover': 'none',
  };
}

/** Every token the engine owns, for one scheme. */
export function buildThemeTokens(seed: ThemeSeed, scheme: ThemeScheme): Record<string, string> {
  const dark = scheme === 'dark';
  const ramp = RAMP[scheme];
  const k = CONTRAST[seed.contrast];
  const { hue: h, chroma } = seed.palette;
  // Tint fades as surfaces approach white/black, where chroma reads as dirt.
  const c = dark ? chroma * 0.85 : chroma;
  const n = (l: number, cm = 1) => fmt(l, c * cm, h);

  // Lines move away from the card surface by `line` times their default distance.
  const line = (l: number) => r3(ramp.card + (l - ramp.card) * k.line);
  const ink = r3(Math.min(0.99, Math.max(0.08, ramp.ink + (dark ? -k.ink : k.ink))));
  const secondary = solveLightness(ramp.base, c, h, k.secondary, dark);
  const faint = solveLightness(ramp.base, c, h, k.faint, dark);

  const base = n(ramp.base);
  const card = n(ramp.card, ramp.card >= 0.999 ? 0 : 1);
  const raised = n(ramp.raised);
  const overlay = n(ramp.overlay, ramp.overlay >= 0.999 ? 0 : 1);
  const border = n(line(ramp.border));
  const borderSubtle = n(line(ramp.borderSubtle));
  const borderStrong = n(line(ramp.borderStrong));
  const inkColor = n(ink, 0.6);
  const inkSecondary = n(secondary, 0.8);
  const inkFaint = n(faint, 0.8);

  // Accent: a brand hue, or "ink" — primary is the text colour, exactly as the
  // old Default family did with --primary: var(--foreground).
  let primary = 'var(--foreground)';
  let primaryFg = 'var(--background)';
  if (seed.accent) {
    const { l, c: ac, h: ah } = seed.accent;
    primary = fmt(l, ac, ah);
    const y = luminance(l, ac, ah);
    // White whenever it clears 3:1 (the bar for button labels and UI text),
    // near-black otherwise. Strict "whichever is higher" picks black on every
    // mid-luminance hue — blue, violet, rose — where white is the convention
    // and still legible; pine's onColor() makes the same call.
    primaryFg = contrastRatio(1, y) >= 3 ? 'oklch(0.985 0 0)' : 'oklch(0.2 0 0)';
  }

  const status = (hue: number, cc: number) => fmt(dark ? 0.76 : 0.55, cc, hue);

  return {
    '--canvas-base': base,
    '--canvas-elevated': card,
    '--canvas-raised': raised,
    '--canvas-overlay': overlay,
    '--border': border,
    '--border-subtle': borderSubtle,
    '--border-strong': borderStrong,
    '--ink': inkColor,
    '--ink-secondary': inkSecondary,
    '--ink-muted': inkFaint,
    '--ink-inverse': base,
    '--background': base,
    '--foreground': inkColor,
    '--card': card,
    '--card-foreground': inkColor,
    '--popover': overlay,
    '--popover-foreground': inkColor,
    '--primary': primary,
    '--primary-foreground': primaryFg,
    '--secondary': raised,
    '--secondary-foreground': inkColor,
    '--muted': raised,
    '--muted-foreground': inkSecondary,
    '--sh-accent': `color-mix(in oklch, var(--primary) ${dark ? 18 : 14}%, var(--background))`,
    '--sh-accent-foreground': 'var(--foreground)',
    '--sh-border': border,
    '--input': border,
    '--ring': 'var(--primary)',
    '--accent': 'var(--primary)',
    '--accent-hover': `color-mix(in srgb, var(--primary) 82%, ${dark ? 'white' : 'var(--foreground)'} 18%)`,
    '--accent-subtle': `color-mix(in srgb, var(--primary) ${dark ? 16 : 12}%, transparent)`,
    '--accent-border': `color-mix(in srgb, var(--primary) ${dark ? 38 : 32}%, transparent)`,
    '--success': status(155, 0.13),
    '--warning': status(75, 0.15),
    '--error': status(30, 0.18),
    '--sidebar': card,
    '--sidebar-foreground': inkColor,
    '--sidebar-primary': 'var(--primary)',
    '--sidebar-primary-foreground': 'var(--primary-foreground)',
    '--sidebar-accent': raised,
    '--sidebar-accent-foreground': inkColor,
    '--sidebar-border': border,
    '--sidebar-ring': 'var(--primary)',
    ...shadows(seed.depth, scheme),
  };
}

/** The CSS text for both schemes, scoped to the Default family. */
export function buildThemeCss(seed: ThemeSeed): string {
  return (['light', 'dark'] as const).map((scheme) => {
    const body = Object.entries(buildThemeTokens(seed, scheme))
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n');
    return `:root:root[data-ui-theme="default"][data-theme="${scheme}"] {\n${body}\n}`;
  }).join('\n\n');
}
