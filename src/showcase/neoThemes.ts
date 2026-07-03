// Neo‑brutal theme registry.
//
// The `neo` UI family (see index.css, [data-ui-theme="neo"]) gives the app its
// brutal *structure*: thick ink borders, hard offset shadows, chunky controls,
// stamped labels — all driven by CSS custom properties. This module supplies
// two layers on top of that, applied at runtime by writing those variables
// inline on <html> (the same mechanism the accent presets use):
//
//   1. PALETTE  — paper / ink / primary / accents (per light + dark scheme).
//   2. STYLE    — a "profile" that swaps font, shadow depth, press distance,
//                 corner radius, heading treatment and paper texture. This is
//                 what makes themes structurally different, not just recoloured.
//
// A theme = a palette seed (per scheme) + a style profile id. Both compose with
// the app's existing light/dark toggle: switching scheme re-applies the seed.

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
  dot?: string;        // texture colour   → --neo-dot
  success?: string;
  warning?: string;
  error?: string;
}

export interface NeoTheme {
  id: string;
  label: string;
  group: string;
  /** Structural personality — see STYLE_PROFILES. Defaults to 'brutal'. */
  style: string;
  /** 3 colours for the picker chip: [primary, secondary accent, paper/ink]. */
  swatch: [string, string, string];
  light: NeoSeed;
  dark: NeoSeed;
}

// ---- font stacks ----------------------------------------------------------
// Base faces ship in index.css's @import; the rest are lazy-loaded by
// ensureNeoFonts() the first time a neo theme is applied (see below), so
// non-neo users never download them.
const SANS = 'system-ui, -apple-system, sans-serif';
const MONO = 'ui-monospace, monospace';
const F = {
  // base (always available)
  grotesk: `'Space Grotesk', ${SANS}`,
  archivo: `'Archivo Black', 'Space Grotesk', ${SANS}`,
  mono: `'IBM Plex Mono', 'Space Mono', ${MONO}`,
  spaceMono: `'Space Mono', 'IBM Plex Mono', ${MONO}`,
  inter: `'Inter', ${SANS}`,
  // display faces (lazy)
  anton: `'Anton', 'Archivo Black', ${SANS}`,
  bungee: `'Bungee', 'Archivo Black', ${SANS}`,
  syne: `'Syne', 'Space Grotesk', ${SANS}`,
  unbounded: `'Unbounded', 'Archivo Black', ${SANS}`,
  bebas: `'Bebas Neue', 'Archivo Black', ${SANS}`,
  staatliches: `'Staatliches', 'Archivo Black', ${SANS}`,
  rubikMono: `'Rubik Mono One', 'Space Mono', ${MONO}`,
  bricolage: `'Bricolage Grotesque', 'Space Grotesk', ${SANS}`,
  bigShoulders: `'Big Shoulders Display', 'Archivo Black', ${SANS}`,
  darker: `'Darker Grotesque', 'Space Grotesk', ${SANS}`,
  // body faces (lazy)
  hanken: `'Hanken Grotesk', ${SANS}`,
  dmSans: `'DM Sans', ${SANS}`,
  workSans: `'Work Sans', ${SANS}`,
  manrope: `'Manrope', ${SANS}`,
  schibsted: `'Schibsted Grotesk', ${SANS}`,
  figtree: `'Figtree', ${SANS}`,
  jetbrains: `'JetBrains Mono', 'IBM Plex Mono', ${MONO}`,
};

// Google Fonts loaded on demand (the new faces only; base faces are in the
// index.css @import). Injected once when the first neo theme is applied.
const NEO_FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Anton&family=Bebas+Neue&family=Big+Shoulders+Display:wght@700;800;900&family=Bricolage+Grotesque:wght@500;600;700;800&family=Bungee&family=Darker+Grotesque:wght@600;700;800;900&family=DM+Sans:wght@400;500;700&family=Figtree:wght@400;600;700&family=Hanken+Grotesk:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600;700&family=Manrope:wght@400;600;700;800&family=Rubik+Mono+One&family=Schibsted+Grotesk:wght@400;600;700;800&family=Staatliches&family=Syne:wght@600;700;800&family=Unbounded:wght@600;700;900&family=Work+Sans:wght@400;600;700&display=swap';

let neoFontsInjected = false;
/** Inject the lazy neo font stylesheet once (no-op if already present). */
function ensureNeoFonts() {
  if (neoFontsInjected || typeof document === 'undefined') return;
  neoFontsInjected = true;
  if (document.querySelector('link[data-neo-fonts]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = NEO_FONT_HREF;
  link.setAttribute('data-neo-fonts', '');
  document.head.appendChild(link);
}

// hard offset shadow of size n, keeping the per-theme shadow ink.
const sh = (n: number) => `${n}px ${n}px 0 var(--neo-shadow-ink)`;
const dots = (size: number) => ({
  texture: 'radial-gradient(var(--neo-dot) 1.1px, transparent 1.1px)',
  textureSize: `${size}px ${size}px`,
});
const grid = (size: number) => ({
  texture: 'linear-gradient(var(--neo-dot) 1px, transparent 1px), linear-gradient(90deg, var(--neo-dot) 1px, transparent 1px)',
  textureSize: `${size}px ${size}px`,
});
const hatch = {
  texture: 'repeating-linear-gradient(45deg, var(--neo-dot) 0 1px, transparent 1px 10px)',
  textureSize: 'auto',
};
const noTexture = { texture: 'none', textureSize: 'auto' };

export interface NeoStyleProfile {
  label: string;
  font: string;
  display: string;
  weight: string;
  spacing: string;
  transform: string;
  radius: NeoRadius;
  shadow: { xs: string; sm: string; md: string; lg: string; x: string; y: string };
  texture: string;
  textureSize: string;
}

// Eight structural personalities. The same palette under two profiles reads as
// two different products — heavy poster vs. flat Swiss vs. terminal vs. zine.
export const STYLE_PROFILES: Record<string, NeoStyleProfile> = {
  // current neo look — the safe default (must match the index.css base block)
  brutal: {
    label: 'Brutal', font: F.grotesk, display: F.grotesk,
    weight: '700', spacing: '-0.01em', transform: 'none', radius: 'default',
    shadow: { xs: sh(1.5), sm: sh(2), md: sh(3), lg: sh(4), x: '3px', y: '3px' },
    ...dots(22),
  },
  // big Archivo Black headlines, deep shadows, fat dots — loud poster energy
  heavy: {
    label: 'Heavy Poster', font: F.grotesk, display: F.archivo,
    weight: '400', spacing: '-0.02em', transform: 'none', radius: 'default',
    shadow: { xs: sh(2), sm: sh(3), md: sh(5), lg: sh(7), x: '4px', y: '4px' },
    ...dots(26),
  },
  // near-flat, sharp corners, fine grid — Swiss / International brutalism
  flat: {
    label: 'Flat Swiss', font: F.grotesk, display: F.grotesk,
    weight: '700', spacing: '-0.02em', transform: 'none', radius: 'sharp',
    shadow: { xs: '0 0 0 var(--neo-shadow-ink)', sm: sh(1), md: sh(1), lg: sh(2), x: '1px', y: '1px' },
    ...grid(26),
  },
  // monospace everything, uppercase, crisp shadows, grid — terminal / ops
  techno: {
    label: 'Terminal', font: F.mono, display: F.mono,
    weight: '700', spacing: '0.02em', transform: 'uppercase', radius: 'sharp',
    shadow: { xs: sh(1), sm: sh(2), md: sh(2), lg: sh(3), x: '2px', y: '2px' },
    ...grid(22),
  },
  // Space Mono body, Archivo display, diagonal hatch — risograph zine
  print: {
    label: 'Riso Zine', font: F.spaceMono, display: F.archivo,
    weight: '400', spacing: '0.03em', transform: 'uppercase', radius: 'default',
    shadow: { xs: sh(1.5), sm: sh(2), md: sh(3), lg: sh(4), x: '3px', y: '3px' },
    ...hatch,
  },
  // Inter body, rounded corners, softer shadows, fine dots — friendly product
  soft: {
    label: 'Soft Product', font: F.inter, display: F.grotesk,
    weight: '700', spacing: '-0.005em', transform: 'none', radius: 'soft',
    shadow: { xs: sh(1.5), sm: sh(2), md: sh(3), lg: sh(4), x: '2px', y: '2px' },
    ...dots(18),
  },
  // wide tracked uppercase Archivo display, no texture, thin shadow — magazine
  editorial: {
    label: 'Editorial', font: F.inter, display: F.archivo,
    weight: '400', spacing: '0.10em', transform: 'uppercase', radius: 'sharp',
    shadow: { xs: '0 0 0 var(--neo-shadow-ink)', sm: sh(1), md: sh(2), lg: sh(2), x: '2px', y: '2px' },
    ...noTexture,
  },
  // chunky bouncy shadows, soft corners, big dots — sticker pack
  sticker: {
    label: 'Sticker Pack', font: F.grotesk, display: F.grotesk,
    weight: '700', spacing: '-0.01em', transform: 'none', radius: 'soft',
    shadow: { xs: sh(2), sm: sh(3), md: sh(4), lg: sh(6), x: '4px', y: '4px' },
    ...dots(28),
  },

  // ---- font-forward profiles: each anchored on a distinctive display face ----
  // tall condensed caps — billboard
  billboard: {
    label: 'Billboard', font: F.hanken, display: F.anton,
    weight: '400', spacing: '0.01em', transform: 'uppercase', radius: 'default',
    shadow: { xs: sh(2), sm: sh(3), md: sh(4), lg: sh(6), x: '4px', y: '4px' },
    ...dots(24),
  },
  // Bungee signage — arcade
  arcade: {
    label: 'Arcade', font: F.grotesk, display: F.bungee,
    weight: '400', spacing: '0', transform: 'uppercase', radius: 'default',
    shadow: { xs: sh(2), sm: sh(3), md: sh(4), lg: sh(6), x: '4px', y: '4px' },
    ...dots(26),
  },
  // Syne — gallery / art-book
  gallery: {
    label: 'Gallery', font: F.inter, display: F.syne,
    weight: '800', spacing: '-0.01em', transform: 'none', radius: 'sharp',
    shadow: { xs: '0 0 0 var(--neo-shadow-ink)', sm: sh(1), md: sh(2), lg: sh(2), x: '2px', y: '2px' },
    ...noTexture,
  },
  // Unbounded — rounded heavy balloon
  balloon: {
    label: 'Balloon', font: F.dmSans, display: F.unbounded,
    weight: '700', spacing: '-0.01em', transform: 'none', radius: 'soft',
    shadow: { xs: sh(2), sm: sh(3), md: sh(4), lg: sh(6), x: '3px', y: '3px' },
    ...dots(22),
  },
  // Bebas Neue — tall marquee caps
  marquee: {
    label: 'Marquee', font: F.workSans, display: F.bebas,
    weight: '400', spacing: '0.04em', transform: 'uppercase', radius: 'sharp',
    shadow: { xs: sh(1), sm: sh(2), md: sh(2), lg: sh(3), x: '2px', y: '2px' },
    ...grid(24),
  },
  // Staatliches — condensed stencil caps
  stencil: {
    label: 'Stencil', font: F.hanken, display: F.staatliches,
    weight: '400', spacing: '0.03em', transform: 'uppercase', radius: 'default',
    shadow: { xs: sh(1.5), sm: sh(2), md: sh(3), lg: sh(4), x: '3px', y: '3px' },
    ...hatch,
  },
  // Rubik Mono One — blocky monospace slab
  block: {
    label: 'Block', font: F.spaceMono, display: F.rubikMono,
    weight: '400', spacing: '0', transform: 'uppercase', radius: 'sharp',
    shadow: { xs: sh(1), sm: sh(2), md: sh(2), lg: sh(3), x: '2px', y: '2px' },
    ...grid(22),
  },
  // Bricolage Grotesque — modern press / editorial-tech
  press: {
    label: 'Press', font: F.schibsted, display: F.bricolage,
    weight: '800', spacing: '-0.015em', transform: 'none', radius: 'default',
    shadow: { xs: sh(1.5), sm: sh(2), md: sh(3), lg: sh(4), x: '3px', y: '3px' },
    ...dots(20),
  },
  // Manrope throughout, technical grid paper — drafting / blueprint
  blueprint: {
    label: 'Blueprint', font: F.manrope, display: F.manrope,
    weight: '800', spacing: '-0.015em', transform: 'none', radius: 'default',
    shadow: { xs: sh(1.5), sm: sh(2), md: sh(3), lg: sh(4), x: '3px', y: '3px' },
    ...grid(24),
  },
  // Big Shoulders Display — industrial transit
  transit: {
    label: 'Transit', font: F.manrope, display: F.bigShoulders,
    weight: '900', spacing: '0.01em', transform: 'uppercase', radius: 'sharp',
    shadow: { xs: sh(1.5), sm: sh(2), md: sh(3), lg: sh(4), x: '3px', y: '3px' },
    ...grid(24),
  },
  // Darker Grotesque — high-contrast magazine
  mag: {
    label: 'Mag', font: F.figtree, display: F.darker,
    weight: '900', spacing: '-0.02em', transform: 'none', radius: 'sharp',
    shadow: { xs: '0 0 0 var(--neo-shadow-ink)', sm: sh(1), md: sh(2), lg: sh(2), x: '2px', y: '2px' },
    ...noTexture,
  },
};

export function resolveNeoStyle(theme: NeoTheme): NeoStyleProfile {
  return STYLE_PROFILES[theme.style] ?? STYLE_PROFILES.brutal;
}

const RADII: Record<NeoRadius, Record<string, string>> = {
  sharp: { '--radius-sm': '0px', '--radius-md': '0px', '--radius-lg': '2px', '--radius-xl': '3px' },
  default: { '--radius-sm': '4px', '--radius-md': '8px', '--radius-lg': '10px', '--radius-xl': '12px' },
  soft: { '--radius-sm': '6px', '--radius-md': '12px', '--radius-lg': '16px', '--radius-xl': '20px' },
};

// ---- token keys this module owns (cleared on switch) ---------------------
export const NEO_MANAGED_KEYS = [
  '--neo-ink', '--neo-shadow-ink', '--neo-dot', '--neo-dot-size',
  '--neo-font', '--neo-display', '--neo-display-weight', '--neo-display-spacing', '--neo-display-transform',
  '--neo-texture', '--neo-texture-size',
  '--neo-shadow-xs', '--neo-shadow-sm', '--neo-shadow-md', '--neo-shadow-lg', '--neo-shadow-x', '--neo-shadow-y',
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

const mix = (a: string, pa: number, b: string) => `color-mix(in srgb, ${a} ${pa}%, ${b})`;

/** Expand a compact seed into the full set of neo surface tokens. Exported for
 *  tests and preview tooling; the app applies it through `applyNeoTheme`. */
export function expand(seed: NeoSeed, scheme: NeoScheme): Record<string, string> {
  const dark = scheme === 'dark';
  const { paper, ink, primary, onPrimary } = seed;

  // NOTE: color-mix percentages must sum to 100% — a smaller sum makes the
  // result translucent, which would let surfaces bleed through.
  // Dark surfaces lift toward the theme's own `primary` (not flat white), so
  // elevated/inset/muted fills carry the palette's hue and read as *warm/rich
  // dark with dimension* instead of near-black grey. Most themes still set
  // card/raised explicitly; this hue-tint reaches every dark theme's muted
  // fill and gives new palettes depth without per-theme tuning.
  const card = seed.card ?? (dark ? mix(paper, 89, `${primary} 11%`) : mix(paper, 42, '#ffffff 58%'));
  const raised = seed.raised ?? (dark ? mix(paper, 81, `${primary} 19%`) : mix(paper, 84, `${ink} 16%`));
  const muted = seed.muted ?? (dark ? mix(paper, 91, `${primary} 9%`) : mix(paper, 86, `${ink} 14%`));
  const overlay = card;
  const textSecondary = mix(ink, 78, `${paper} 22%`);
  const textMuted = mix(ink, 52, `${paper} 48%`);
  // Light: the hard shadow is solid ink — the classic neo offset. Dark: prefer
  // a theme's own hand-tuned shadow ink when set; otherwise derive a quieter
  // ink-tinted neutral (much less ink than the light-mode 100%) so the offset
  // stays visible against near-black pages without washing out as a bright
  // "halo". 34% lands the derived shadow near the hand-tuned seeds (#5f–#6e)
  // so untuned Pop/Pastel dark themes read as crisply as the tuned groups.
  // A flat translucent black was tried here and reverted — composited
  // over the near-black canvas most dark themes use, it reads as ~1.1:1
  // contrast (invisible) instead of a hard shadow.
  const shadow = seed.shadow ?? (dark ? mix(ink, 34, `${paper} 66%`) : ink);
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
  // ───────────────────────── BLUEPRINT — default, Manrope ──────────────────
  {
    id: 'blueprint', label: 'Blueprint', group: 'Blueprint', style: 'blueprint',
    swatch: ['#ffffff', '#7de3ff', '#0d2440'],
    light: { paper: '#eef4fb', ink: '#0d2440', primary: '#1f4f86', onPrimary: '#ffffff', dot: mix('#0d2440', 16, 'transparent') },
    dark: { paper: '#0b1f38', ink: '#dfecfb', primary: '#8fd3ff', onPrimary: '#0b1f38', card: '#102744', raised: '#163251', shadow: '#3f5c80', dot: mix('#8fd3ff', 14, 'transparent') },
  },

  // ───────────────────────── POP — bright & loud ──────────────────────────
  {
    id: 'classic', label: 'Classic', group: 'Pop', style: 'brutal',
    swatch: ['#ffd84a', '#ff6bcb', INK],
    light: { paper: mix('#ffd84a', 13, 'white 87%'), ink: INK, primary: '#ffd84a', onPrimary: INK, card: '#ffffff' },
    dark: { paper: '#141414', ink: '#f4efe4', primary: '#ffd166', onPrimary: INK, card: '#1e1e1e', raised: '#272727', shadow: '#6b6258' },
  },
  {
    id: 'bubblegum', label: 'Bubblegum', group: 'Pop', style: 'sticker',
    swatch: ['#ff6bcb', '#7de3ff', '#ffffff'],
    light: { paper: '#ffffff', ink: INK, primary: '#ff6bcb', onPrimary: INK, raised: mix('#7de3ff', 18, 'white 82%') },
    dark: { paper: '#160d14', ink: '#ffeaf6', primary: '#ff6bcb', onPrimary: INK, card: '#21141d', raised: '#2b1b26' },
  },
  {
    id: 'mint-fresh', label: 'Mint Fresh', group: 'Pop', style: 'balloon',
    swatch: ['#5be3b0', '#ff6b5f', PAPER2],
    light: { paper: '#f3fff9', ink: INK, primary: '#5be3b0', onPrimary: INK },
    dark: { paper: '#0d1714', ink: '#e9fff5', primary: '#5be3b0', onPrimary: INK, card: '#13211c', raised: '#1b2c26' },
  },
  {
    id: 'tangerine', label: 'Tangerine', group: 'Pop', style: 'billboard',
    swatch: ['#ff7a1a', '#a98cff', CREAM],
    light: { paper: CREAM, ink: INK, primary: '#ff8a2b', onPrimary: INK },
    dark: { paper: '#17110a', ink: '#ffeede', primary: '#ff8a2b', onPrimary: INK, card: '#221810', raised: '#2d2014' },
  },
  {
    id: 'lagoon', label: 'Lagoon', group: 'Pop', style: 'block',
    swatch: ['#28c7e8', '#ffe45c', '#eafbff'],
    light: { paper: '#eafbff', ink: INK, primary: '#2fd0ef', onPrimary: INK },
    dark: { paper: '#08161b', ink: '#e2fbff', primary: '#2fd0ef', onPrimary: INK, card: '#0e2129', raised: '#142d36' },
  },
  {
    id: 'grape-soda', label: 'Grape Soda', group: 'Pop', style: 'arcade',
    swatch: ['#a98cff', '#b6ff6c', '#f4f0ff'],
    light: { paper: '#f4f0ff', ink: INK, primary: '#a98cff', onPrimary: INK },
    dark: { paper: '#120f1c', ink: '#efe9ff', primary: '#a98cff', onPrimary: INK, card: '#1b1630', raised: '#241d3f' },
  },
  {
    id: 'lime-punch', label: 'Lime Punch', group: 'Pop', style: 'transit',
    swatch: ['#b6ff6c', '#ff4da6', '#ffffff'],
    light: { paper: '#fbffef', ink: INK, primary: '#aef25f', onPrimary: INK },
    dark: { paper: '#10140a', ink: '#f1ffe0', primary: '#aef25f', onPrimary: INK, card: '#1a2010', raised: '#232b16' },
  },
  {
    id: 'coral-crush', label: 'Coral Crush', group: 'Pop', style: 'soft',
    swatch: ['#ff6b5f', '#5be3b0', '#fff3f0'],
    light: { paper: '#fff3f0', ink: INK, primary: '#ff6b5f', onPrimary: '#ffffff' },
    dark: { paper: '#180e0c', ink: '#ffe9e4', primary: '#ff7468', onPrimary: INK, card: '#231411', raised: '#2e1b17' },
  },
  {
    id: 'sky-pop', label: 'Sky Pop', group: 'Pop', style: 'brutal',
    swatch: ['#6fb7ff', '#ffd84a', '#eef6ff'],
    light: { paper: '#eef6ff', ink: INK, primary: '#6fb7ff', onPrimary: INK },
    dark: { paper: '#0a1018', ink: '#e6f1ff', primary: '#6fb7ff', onPrimary: INK, card: '#101a26', raised: '#172435' },
  },
  {
    id: 'cobalt', label: 'Cobalt', group: 'Pop', style: 'press',
    swatch: ['#3b5bdb', '#ffd84a', '#eef2ff'],
    light: { paper: '#eef2ff', ink: INK, primary: '#3b5bdb', onPrimary: '#ffffff' },
    dark: { paper: '#0a0d1a', ink: '#e4e9ff', primary: '#5c7cfa', onPrimary: INK, card: '#111631', raised: '#182046', shadow: '#454f80' },
  },
  {
    id: 'flamingo', label: 'Flamingo', group: 'Pop', style: 'balloon',
    swatch: ['#ff5d8f', '#5be3b0', '#fff0f5'],
    light: { paper: '#fff0f5', ink: INK, primary: '#ff5d8f', onPrimary: '#ffffff' },
    dark: { paper: '#170b11', ink: '#ffe4ee', primary: '#ff6b9d', onPrimary: INK, card: '#22111a', raised: '#2d1824', shadow: '#6d4657' },
  },

  // ───────────────────────── DARK — loud on near-black ────────────────────
  {
    id: 'acid-noir', label: 'Acid Noir', group: 'Dark', style: 'heavy',
    swatch: ['#ffe45c', '#ff6bcb', '#0e0e0e'],
    light: { paper: '#fffdf2', ink: INK, primary: '#ffe45c', onPrimary: INK },
    dark: { paper: '#0e0e0e', ink: '#f6f1e6', primary: '#ffe45c', onPrimary: INK, card: '#181818', raised: '#222222', shadow: '#5f5a4e' },
  },
  {
    id: 'cyber-mint', label: 'Cyber Mint', group: 'Dark', style: 'techno',
    swatch: ['#5be3b0', '#ff5fdc', '#0b0f0e'],
    light: { paper: '#f1fff9', ink: INK, primary: '#39d9a0', onPrimary: INK },
    dark: { paper: '#0b0f0e', ink: '#e9fff6', primary: '#3ff0ad', onPrimary: INK, card: '#121916', raised: '#19231f', shadow: '#4a6258' },
  },
  {
    id: 'vapor', label: 'Vapor', group: 'Dark', style: 'marquee',
    swatch: ['#ff6bcb', '#56e0ff', '#140b18'],
    light: { paper: '#fdf2ff', ink: '#1a0f1f', primary: '#ff6bcb', onPrimary: INK },
    dark: { paper: '#140b18', ink: '#ffe9fb', primary: '#ff6bcb', onPrimary: INK, card: '#1f1226', raised: '#2a1933', shadow: '#6a4d72' },
  },
  {
    id: 'electric-violet', label: 'Electric Violet', group: 'Dark', style: 'gallery',
    swatch: ['#7c5cff', '#b6ff6c', '#0d0b16'],
    light: { paper: '#f3f1ff', ink: '#0d0b16', primary: '#7c5cff', onPrimary: '#ffffff' },
    dark: { paper: '#0d0b16', ink: '#ece8ff', primary: '#8f72ff', onPrimary: '#ffffff', card: '#161224', raised: '#1f1a32', shadow: '#534c7a' },
  },
  {
    id: 'toxic-lime', label: 'Toxic Lime', group: 'Dark', style: 'block',
    swatch: ['#c6ff4d', '#ff3b8d', '#0c0f08'],
    light: { paper: '#fbffee', ink: INK, primary: '#9fe800', onPrimary: INK },
    dark: { paper: '#0c0f08', ink: '#eeffda', primary: '#c6ff4d', onPrimary: INK, card: '#131810', raised: '#1b2116', shadow: '#566049' },
  },
  {
    id: 'ember', label: 'Ember', group: 'Dark', style: 'transit',
    swatch: ['#ff6a2b', '#ffd166', '#130c08'],
    light: { paper: '#fff5ee', ink: '#190d06', primary: '#ff6a2b', onPrimary: '#ffffff' },
    dark: { paper: '#130c08', ink: '#ffe9da', primary: '#ff7a3d', onPrimary: INK, card: '#1d130c', raised: '#281b12', shadow: '#6e5240' },
  },
  {
    id: 'arctic', label: 'Arctic', group: 'Dark', style: 'flat',
    swatch: ['#56e0ff', '#ffffff', '#0a1016'],
    light: { paper: '#eef7fb', ink: '#08141d', primary: '#37cdf2', onPrimary: INK },
    dark: { paper: '#0a1016', ink: '#e8f6ff', primary: '#56e0ff', onPrimary: INK, card: '#101a22', raised: '#17242e', shadow: '#46606e' },
  },
  {
    id: 'hazard', label: 'Hazard', group: 'Dark', style: 'techno',
    swatch: ['#ffd200', '#0a0a0a', '#111111'],
    light: { paper: '#fffced', ink: INK, primary: '#ffd200', onPrimary: INK },
    dark: { paper: '#111111', ink: '#fdf6df', primary: '#ffd200', onPrimary: INK, card: '#1a1a1a', raised: '#242424', shadow: '#615a3f' },
  },
  {
    id: 'magma', label: 'Magma', group: 'Dark', style: 'heavy',
    swatch: ['#ff3b6b', '#ff9f1c', '#120709'],
    light: { paper: '#fff1f3', ink: '#1a070b', primary: '#ff3b6b', onPrimary: '#ffffff' },
    dark: { paper: '#120709', ink: '#ffe3e8', primary: '#ff4d74', onPrimary: '#ffffff', card: '#1d0d11', raised: '#281218', shadow: '#6e4049' },
  },
  {
    id: 'deep-sea', label: 'Deep Sea', group: 'Dark', style: 'block',
    swatch: ['#2dd4bf', '#ffd166', '#071413'],
    light: { paper: '#e8f4f2', ink: '#06201d', primary: '#0d9488', onPrimary: '#ffffff' },
    dark: { paper: '#071413', ink: '#dbf3ef', primary: '#2dd4bf', onPrimary: INK, card: '#0d1f1d', raised: '#132b28', shadow: '#3f5f5a' },
  },
  {
    id: 'plum-noir', label: 'Plum Noir', group: 'Dark', style: 'gallery',
    swatch: ['#b968e6', '#ffd84a', '#100a16'],
    light: { paper: '#f6f0fb', ink: '#1a0f24', primary: '#8b3fc4', onPrimary: '#ffffff' },
    dark: { paper: '#100a16', ink: '#efe4f8', primary: '#b968e6', onPrimary: INK, card: '#1a1024', raised: '#241633', shadow: '#544066' },
  },

  // ───────────────────────── MONO & PRINT — ink-forward ───────────────────
  {
    id: 'xerox', label: 'Xerox', group: 'Mono & Print', style: 'mag',
    swatch: ['#0a0a0a', '#ff3b30', '#ffffff'],
    light: { paper: '#ffffff', ink: INK, primary: INK, onPrimary: '#ffffff', raised: '#ededed', muted: '#f2f2f2', dot: mix(INK, 9, 'transparent') },
    dark: { paper: '#0c0c0c', ink: '#f4f4f4', primary: '#f4f4f4', onPrimary: INK, card: '#161616', raised: '#222222', shadow: '#555555' },
  },
  {
    id: 'newsprint', label: 'Newsprint', group: 'Mono & Print', style: 'print',
    swatch: ['#1a1a1a', '#d72631', '#f3ece0'],
    light: { paper: '#f3ece0', ink: '#15130f', primary: '#15130f', onPrimary: '#f3ece0', error: '#d72631' },
    dark: { paper: '#15130f', ink: '#efe7d8', primary: '#efe7d8', onPrimary: '#15130f', card: '#1f1c16', raised: '#2a2620', shadow: '#615b4e' },
  },
  {
    id: 'riso-red', label: 'Riso Red', group: 'Mono & Print', style: 'marquee',
    swatch: ['#ff4438', '#2a4bd7', '#f6efe2'],
    light: { paper: '#f7f0e3', ink: '#1c1208', primary: '#ff4438', onPrimary: '#fff', success: '#2a4bd7' },
    dark: { paper: '#16100b', ink: '#ffe6e1', primary: '#ff5547', onPrimary: '#fff', card: '#201610', raised: '#2b1e16', shadow: '#6c4a40' },
  },
  {
    id: 'riso-blue', label: 'Riso Blue', group: 'Mono & Print', style: 'press',
    swatch: ['#2a4bd7', '#ff4438', '#f6efe2'],
    light: { paper: '#f4f0e6', ink: '#0c1330', primary: '#2a4bd7', onPrimary: '#fff', error: '#ff4438' },
    dark: { paper: '#0b0f1f', ink: '#e2e8ff', primary: '#6a82ff', onPrimary: '#0b0f1f', card: '#11172b', raised: '#182039', shadow: '#444f78' },
  },
  {
    id: 'graphite', label: 'Graphite', group: 'Mono & Print', style: 'editorial',
    swatch: ['#2d2d2d', '#ffd84a', '#e9e9e9'],
    light: { paper: '#ededed', ink: '#161616', primary: '#2d2d2d', onPrimary: '#ffffff', warning: '#ffd84a' },
    dark: { paper: '#121212', ink: '#ededed', primary: '#e6e6e6', onPrimary: '#121212', card: '#1c1c1c', raised: '#262626', shadow: '#555' },
  },
  {
    id: 'slate-ink', label: 'Slate Ink', group: 'Mono & Print', style: 'blueprint',
    swatch: ['#3d5a72', '#ff6b5f', '#0c1014'],
    light: { paper: '#eceef1', ink: '#12181f', primary: '#3d5a72', onPrimary: '#ffffff', raised: '#e0e3e8', muted: '#e6e9ed' },
    dark: { paper: '#0c1014', ink: '#e2e8ef', primary: '#6b91b0', onPrimary: '#0c1014', card: '#141a20', raised: '#1c242c', shadow: '#43505c' },
  },

  // ───────────────────────── PASTEL — soft paper, candy accents ───────────
  {
    id: 'cotton-candy', label: 'Cotton Candy', group: 'Pastel', style: 'mag',
    swatch: ['#ff9ad2', '#9be8ff', '#fff0f8'],
    light: { paper: '#fff0f8', ink: '#3a1730', primary: '#ff9ad2', onPrimary: '#3a1730' },
    dark: { paper: '#1a1018', ink: '#ffe6f4', primary: '#ff9ad2', onPrimary: '#3a1730', card: '#241620', raised: '#2f1d2a' },
  },
  {
    id: 'pistachio', label: 'Pistachio', group: 'Pastel', style: 'stencil',
    swatch: ['#a8e6a1', '#ffcf6b', '#f0f7e9'],
    light: { paper: '#f0f7e9', ink: '#1a2a14', primary: '#9bd98f', onPrimary: '#16240f' },
    dark: { paper: '#101610', ink: '#e8f5e2', primary: '#9bd98f', onPrimary: '#16240f', card: '#172017', raised: '#1f2a1e' },
  },
  {
    id: 'peach', label: 'Peach', group: 'Pastel', style: 'soft',
    swatch: ['#ffb59a', '#8fd3ff', '#fff3ec'],
    light: { paper: '#fff3ec', ink: '#3a1d12', primary: '#ffab8a', onPrimary: '#3a1d12' },
    dark: { paper: '#1a110c', ink: '#ffe7db', primary: '#ffab8a', onPrimary: '#3a1d12', card: '#241812', raised: '#2f201a' },
  },
  {
    id: 'lavender-haze', label: 'Lavender Haze', group: 'Pastel', style: 'balloon',
    swatch: ['#c4b1ff', '#ffd6a8', '#f3effc'],
    light: { paper: '#f3effc', ink: '#241a3a', primary: '#c4b1ff', onPrimary: '#241a3a' },
    dark: { paper: '#14111e', ink: '#ece6ff', primary: '#c4b1ff', onPrimary: '#241a3a', card: '#1d1830', raised: '#26203f' },
  },
  {
    id: 'butter', label: 'Butter', group: 'Pastel', style: 'sticker',
    swatch: ['#ffe39a', '#a8d8c0', '#fffae8'],
    light: { paper: '#fffae8', ink: '#3a2c0e', primary: '#ffe08a', onPrimary: '#3a2c0e' },
    dark: { paper: '#17130a', ink: '#fff3d6', primary: '#ffe08a', onPrimary: '#3a2c0e', card: '#211a0f', raised: '#2c2315' },
  },
  {
    id: 'cloud-nine', label: 'Cloud Nine', group: 'Pastel', style: 'gallery',
    swatch: ['#a8d0ff', '#ffb3c1', '#eef5ff'],
    light: { paper: '#eef5ff', ink: '#142440', primary: '#a8d0ff', onPrimary: '#142440' },
    dark: { paper: '#0d121c', ink: '#e6efff', primary: '#a8d0ff', onPrimary: '#142440', card: '#131b29', raised: '#1a2536' },
  },

  // ───────────────────────── EARTH & RETRO — warm 70s ─────────────────────
  {
    id: 'terracotta', label: 'Terracotta', group: 'Earth & Retro', style: 'print',
    swatch: ['#d2693f', '#e8b423', '#f4e7d4'],
    light: { paper: '#f4e7d4', ink: '#2c1409', primary: '#d2693f', onPrimary: '#fff5ec' },
    dark: { paper: '#1a0f08', ink: '#f6e3cf', primary: '#e07a4e', onPrimary: '#1a0f08', card: '#23160d', raised: '#2e1f14', shadow: '#6f5341' },
  },
  {
    id: 'mustard', label: 'Mustard Field', group: 'Earth & Retro', style: 'stencil',
    swatch: ['#e3b007', '#3f7d4f', '#f3ead2'],
    light: { paper: '#f3ead2', ink: '#2a230c', primary: '#e8b81c', onPrimary: '#2a230c', success: '#3f7d4f' },
    dark: { paper: '#161206', ink: '#f4ecca', primary: '#e8b81c', onPrimary: '#2a230c', card: '#1f1a0c', raised: '#2a2312', shadow: '#62593b' },
  },
  {
    id: 'forest', label: 'Forest', group: 'Earth & Retro', style: 'editorial',
    swatch: ['#2f8f5b', '#ff9f43', '#eef3e6'],
    light: { paper: '#eef3e6', ink: '#0f2417', primary: '#2f8f5b', onPrimary: '#fff', warning: '#ff9f43' },
    dark: { paper: '#0b150f', ink: '#e4f1e6', primary: '#48b277', onPrimary: '#0b150f', card: '#111e16', raised: '#18291e', shadow: '#41604c' },
  },
  {
    id: 'cocoa', label: 'Cocoa', group: 'Earth & Retro', style: 'billboard',
    swatch: ['#c98a4b', '#7bb89a', '#1a120c'],
    light: { paper: '#f6ecdf', ink: '#231509', primary: '#b9743a', onPrimary: '#fff6ec' },
    dark: { paper: '#1a120c', ink: '#f1e2d0', primary: '#d29355', onPrimary: '#1a120c', card: '#241910', raised: '#302216', shadow: '#6c5340' },
  },
  {
    id: 'sunset', label: 'Sunset Strip', group: 'Earth & Retro', style: 'arcade',
    swatch: ['#ff7a59', '#ff3d9a', '#ffeede'],
    light: { paper: '#ffeede', ink: '#2c1230', primary: '#ff7a59', onPrimary: '#fff', error: '#ff3d9a' },
    dark: { paper: '#190b14', ink: '#ffe6dc', primary: '#ff8a6a', onPrimary: '#190b14', card: '#23121b', raised: '#2e1a25', shadow: '#6e4658' },
  },
  {
    id: 'oceanic', label: 'Oceanic', group: 'Earth & Retro', style: 'flat',
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
export const DEFAULT_NEO_THEME = 'blueprint';

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
  root.removeAttribute('data-neo-style');
}

/** Write a theme's palette + style tokens inline for the given scheme. */
function applyNeoThemeVars(theme: NeoTheme, scheme: NeoScheme) {
  const root = document.documentElement;
  ensureNeoFonts();
  clearNeoThemeVars();
  const vars = expand(scheme === 'dark' ? theme.dark : theme.light, scheme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);

  // structural style profile: fonts, headings, shadow depth, radius, texture.
  const s = resolveNeoStyle(theme);
  // Expose the profile to CSS so component treatments (badge rotation, switch
  // knob, table chrome, button feel) can branch per style, not just per token.
  root.setAttribute('data-neo-style', theme.style);
  for (const [k, v] of Object.entries(RADII[s.radius])) root.style.setProperty(k, v);
  root.style.setProperty('--neo-font', s.font);
  root.style.setProperty('--neo-display', s.display);
  root.style.setProperty('--neo-display-weight', s.weight);
  root.style.setProperty('--neo-display-spacing', s.spacing);
  root.style.setProperty('--neo-display-transform', s.transform);
  root.style.setProperty('--neo-shadow-xs', s.shadow.xs);
  root.style.setProperty('--neo-shadow-sm', s.shadow.sm);
  root.style.setProperty('--neo-shadow-md', s.shadow.md);
  root.style.setProperty('--neo-shadow-lg', s.shadow.lg);
  root.style.setProperty('--neo-shadow-x', s.shadow.x);
  root.style.setProperty('--neo-shadow-y', s.shadow.y);
  root.style.setProperty('--neo-texture', s.texture);
  root.style.setProperty('--neo-texture-size', s.textureSize);
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
 * Reconcile palette + style with the current UI family + scheme. Call this after
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
