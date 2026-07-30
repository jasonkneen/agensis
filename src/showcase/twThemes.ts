// Paper "world" registry.
//
// The Paper family (see index.css, [data-ui-theme="paper"]) is the warm-paper
// UI theme: soft cream surfaces, a signature flourish hue, gently bevelled
// controls. It has always been ONE hardcoded palette (gold). This module keeps
// Paper a single theme but lets you re-paint its *surfaces* — every "world"
// is the same Paper chrome wearing a different warm-tinted paper + flourish.
//
// Two-tone by design: a world owns the paper (canvas ramp, borders, text,
// semantics, flourish, control outline) — but NOT --primary / --ring /
// --sh-accent. Those stay owned by the accent-preset picker, so a world always
// composes with your picked accent (world paper + your accent). Under the
// default "Neutral" preset --primary falls through to the CSS gold, exactly as
// today. This mirrors the neo/normal registries: seeds are written inline on
// <html> and reconciled on scheme/family change by syncTwTheme().
//
// The default "Gold" world reproduces the current hardcoded CSS byte-for-byte
// (asserted by twThemes.test.ts), so shipping this is zero-regression.

export type TwScheme = 'light' | 'dark';

/** A fully-resolved per-scheme paper. Values may be hex or color-mix() strings. */
export interface TwSeed {
  paper: string;        // --canvas-base / --background
  elevated: string;     // --canvas-elevated / --card / --popover
  raised: string;       // --canvas-raised / --secondary / --muted
  overlay: string;      // --canvas-overlay
  border: string;       // --border / --sh-border / --input
  borderSubtle: string; // --border-subtle
  borderStrong: string; // --border-strong
  ink: string;          // --text-primary / --foreground (+ *-foreground mirrors)
  inkSecondary: string; // --text-secondary
  inkMuted: string;     // --text-muted
  mutedFg: string;      // --muted-foreground (distinct from inkSecondary in dark)
  success: string;
  warning: string;
  error: string;
  flourishOutline: string; // --tw-gold-outline (the signature flourish)
  flourishFill: string;    // --tw-gold-fill
  controlOutline: string;  // --tw-control-outline (per-world ink tint)
}

export interface TwWorld {
  id: string;
  label: string;
  /** [flourish, paper, ink] for the picker chip. */
  swatch: [string, string, string];
  light: TwSeed;
  dark: TwSeed;
}

// Every CSS custom property this module writes inline. Deliberately EXCLUDES the
// accent-preset family (--primary, --primary-foreground, --ring, --sh-accent)
// and --shadow-*/--accent-* (which derive from --primary in CSS), so worlds
// never fight the accent picker and switching away restores the preset cleanly.
export const TW_MANAGED_KEYS = [
  '--canvas-base', '--canvas-elevated', '--canvas-raised', '--canvas-overlay',
  '--background', '--foreground',
  '--card', '--card-foreground', '--popover', '--popover-foreground',
  '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground',
  '--border', '--border-subtle', '--border-strong', '--sh-border', '--input',
  '--text-primary', '--text-secondary', '--text-muted',
  '--success', '--warning', '--error',
  '--tw-gold-outline', '--tw-gold-fill', '--tw-control-outline',
] as const;

// Keys ONLY Paper sets — no other family (neo/normal) touches these. When
// leaving Paper, only these need explicit removal: every *shared* key above
// (canvas/border/text/semantics) is already cleared by syncNeoTheme +
// syncNormalTheme, whose managed-key clears run before syncTwTheme in
// applyTheme and together cover all of them. Blanket-removing the shared keys
// here would instead wipe an active normal theme's inline paper.
const TW_UNIQUE_KEYS = ['--tw-gold-outline', '--tw-gold-fill', '--tw-control-outline'] as const;

/** Map a fully-resolved seed onto its CSS custom properties. */
export function expandTw(seed: TwSeed): Record<string, string> {
  return {
    '--canvas-base': seed.paper,
    '--canvas-elevated': seed.elevated,
    '--canvas-raised': seed.raised,
    '--canvas-overlay': seed.overlay,
    '--background': seed.paper,
    '--foreground': seed.ink,
    '--card': seed.elevated,
    '--card-foreground': seed.ink,
    '--popover': seed.elevated,
    '--popover-foreground': seed.ink,
    '--secondary': seed.raised,
    '--secondary-foreground': seed.ink,
    '--muted': seed.raised,
    '--muted-foreground': seed.mutedFg,
    '--border': seed.border,
    '--border-subtle': seed.borderSubtle,
    '--border-strong': seed.borderStrong,
    '--sh-border': seed.border,
    '--input': seed.border,
    '--text-primary': seed.ink,
    '--text-secondary': seed.inkSecondary,
    '--text-muted': seed.inkMuted,
    '--success': seed.success,
    '--warning': seed.warning,
    '--error': seed.error,
    '--tw-gold-outline': seed.flourishOutline,
    '--tw-gold-fill': seed.flourishFill,
    '--tw-control-outline': seed.controlOutline,
  };
}

// ── world derivation ───────────────────────────────────────────────────────
// Gold is written explicitly (it must equal the current CSS exactly). Every
// other world is derived from a compact anchor spec so its ramp keeps the same
// lightness relationships — coherent by construction, not 400 hand-picked hexes.
// Derived values use color-mix() referencing the world's own anchors, so they
// resolve without depending on any other token.

const mix = (a: string, pa: number, b: string, pb: number) =>
  `color-mix(in srgb, ${a} ${pa}%, ${b} ${pb}%)`;

// shared semantics — warm, world-agnostic (from Gold). Semantics don't need to
// be re-hued per world and keeping them fixed removes a large blind surface.
const SEM_LIGHT = { success: '#2db37c', warning: '#e8a330', error: '#e8532a' };
const SEM_DARK = { success: '#65d7a0', warning: '#f0b85d', error: '#f27d5f' };

interface Anchor { paper: string; ink: string; flourish: string; }

function makeLight({ paper, ink, flourish }: Anchor): TwSeed {
  return {
    paper,
    elevated: mix(paper, 68, '#ffffff', 32),
    raised: mix(paper, 88, ink, 12),
    overlay: mix(paper, 40, '#ffffff', 60),
    border: mix(paper, 72, ink, 28),
    borderSubtle: mix(paper, 84, ink, 16),
    borderStrong: mix(paper, 56, ink, 44),
    ink,
    inkSecondary: mix(ink, 62, paper, 38),
    inkMuted: mix(ink, 46, paper, 54),
    mutedFg: mix(ink, 62, paper, 38),
    ...SEM_LIGHT,
    flourishOutline: mix(flourish, 82, ink, 18),
    flourishFill: mix(flourish, 34, '#ffffff', 66),
    controlOutline: mix(ink, 80, paper, 20),
  };
}

function makeDark({ paper, ink, flourish }: Anchor): TwSeed {
  return {
    paper,
    elevated: mix(paper, 82, flourish, 18),
    raised: mix(paper, 72, flourish, 28),
    overlay: mix(paper, 66, flourish, 34),
    border: mix(paper, 62, ink, 38),
    borderSubtle: mix(paper, 78, ink, 22),
    borderStrong: mix(paper, 44, ink, 56),
    ink,
    inkSecondary: mix(ink, 74, paper, 26),
    inkMuted: mix(ink, 48, paper, 52),
    mutedFg: mix(ink, 60, paper, 40),
    ...SEM_DARK,
    flourishOutline: mix(flourish, 78, '#ffffff', 22),
    flourishFill: mix(flourish, 40, paper, 60),
    controlOutline: mix(ink, 72, paper, 28),
  };
}

function makeWorld(
  id: string,
  label: string,
  light: Anchor,
  dark: Anchor,
): TwWorld {
  return {
    id,
    label,
    swatch: [light.flourish, light.paper, light.ink],
    light: makeLight(light),
    dark: makeDark(dark),
  };
}

// The default world — an exact copy of the current hardcoded CSS (index.css
// [data-ui-theme="paper"] blocks). Verified byte-for-byte by twThemes.test.
const GOLD: TwWorld = {
  id: 'gold',
  label: 'Gold',
  swatch: ['#d9a13a', '#f2e9d7', '#2a2722'],
  light: {
    paper: '#f2e9d7',
    elevated: '#fdf8ec',
    raised: '#ebe0ca',
    overlay: '#fffdf6',
    border: '#e2d5bb',
    borderSubtle: '#ede2ce',
    borderStrong: '#c7bca4',
    ink: '#2a2722',
    inkSecondary: '#6f695f',
    inkMuted: '#918979',
    mutedFg: '#6f695f',
    success: '#2db37c',
    warning: '#e8a330',
    error: '#e8532a',
    flourishOutline: '#9f7a2c',
    flourishFill: '#fff3c1',
    controlOutline: '#4a3f2e',
  },
  dark: {
    paper: '#17150f',
    elevated: '#221d14',
    raised: '#2c2518',
    overlay: '#372d1c',
    border: '#4d4230',
    borderSubtle: '#37301f',
    borderStrong: '#756550',
    ink: '#f5ecdc',
    inkSecondary: '#c8bba7',
    inkMuted: '#8d806e',
    mutedFg: '#a89c88',
    success: '#65d7a0',
    warning: '#f0b85d',
    error: '#f27d5f',
    flourishOutline: '#f0c468',
    flourishFill: 'rgba(118, 79, 28, 0.82)',
    controlOutline: '#c2ad8f',
  },
};

// The nine new worlds. Anchors are warm-paper tints toward each world's hue;
// makeWorld derives the full coherent ramp. NOTE: these were tuned by structure,
// not eyeballed on a live render — a hue that reads off is a one-anchor fix.
export const TW_WORLDS: TwWorld[] = [
  GOLD,
  makeWorld('meadow', 'Meadow',
    { paper: '#eef1df', ink: '#24291d', flourish: '#6f9438' },
    { paper: '#12160e', ink: '#e9f0dc', flourish: '#9cc265' }),
  makeWorld('coast', 'Coast',
    { paper: '#e6f0ee', ink: '#1c2926', flourish: '#2f8f88' },
    { paper: '#0c1615', ink: '#dcefec', flourish: '#4fc3b8' }),
  makeWorld('orchard', 'Orchard',
    { paper: '#f4e9ec', ink: '#2b2023', flourish: '#b0577a' },
    { paper: '#170f12', ink: '#f0e0e5', flourish: '#d98aa6' }),
  makeWorld('dusk', 'Dusk',
    { paper: '#ece9f2', ink: '#26222e', flourish: '#7c6bb0' },
    { paper: '#120f18', ink: '#e8e2f0', flourish: '#a996d8' }),
  makeWorld('ember', 'Ember',
    { paper: '#f4e7dd', ink: '#2c1f18', flourish: '#c8683f' },
    { paper: '#16100b', ink: '#f2e0d2', flourish: '#e08a58' }),
  makeWorld('frost', 'Frost',
    { paper: '#e9edf1', ink: '#1f262d', flourish: '#5b7d9c' },
    { paper: '#0e1318', ink: '#e2e9f0', flourish: '#86a8c4' }),
  makeWorld('moss', 'Moss',
    { paper: '#eceedd', ink: '#26281c', flourish: '#7d8b3e' },
    { paper: '#13140d', ink: '#e9ecd8', flourish: '#adb96a' }),
  makeWorld('clay', 'Clay',
    { paper: '#efe7db', ink: '#2a231b', flourish: '#a77b4e' },
    { paper: '#15110c', ink: '#efe4d6', flourish: '#c99c6b' }),
  makeWorld('ink', 'Ink',
    { paper: '#ecebe8', ink: '#22201d', flourish: '#6b6660' },
    { paper: '#121110', ink: '#ececea', flourish: '#9a938a' }),
];

// ── persistence + apply ────────────────────────────────────────────────────

const STORAGE_KEY = 'agensis_tw_theme';
export const DEFAULT_TW_THEME = 'gold';

export function getStoredTwTheme(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_TW_THEME;
  } catch {
    return DEFAULT_TW_THEME;
  }
}

function persist(id: string) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
}

export function findTwTheme(id: string): TwWorld {
  return TW_WORLDS.find((w) => w.id === id) ?? TW_WORLDS[0];
}

function currentScheme(): TwScheme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * Remove Paper's own tokens. Only the TW-unique keys are stripped here; the
 * shared canvas/border/text keys are owned+cleared by neo/normal and would wipe
 * an active normal theme if removed here (see TW_UNIQUE_KEYS).
 */
export function clearTwTheme() {
  const root = document.documentElement;
  for (const key of TW_UNIQUE_KEYS) root.style.removeProperty(key);
}

function applyTwThemeVars(world: TwWorld, scheme: TwScheme) {
  const root = document.documentElement;
  clearTwTheme();
  const vars = expandTw(scheme === 'dark' ? world.dark : world.light);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

/** True when the Paper family is currently active. */
export function isPaperActive(): boolean {
  return document.documentElement.getAttribute('data-ui-theme') === 'paper';
}

/** Select a world (persists + applies if the Paper family is active). */
export function applyTwTheme(id: string) {
  persist(id);
  if (!isPaperActive()) return;
  applyTwThemeVars(findTwTheme(id), currentScheme());
}

/**
 * Reconcile the world paper with the current family + scheme. Called from
 * applyTheme after [data-ui-theme] / [data-theme] settle:
 *  - paper family → apply the stored world for the active scheme
 *  - other family     → drop world overrides (the CSS / preset defaults return)
 * Re-applying on scheme change is what swaps a world's light/dark paper.
 */
export function syncTwTheme(mode: string) {
  if (mode === 'paper-light' || mode === 'paper-dark') {
    applyTwThemeVars(findTwTheme(getStoredTwTheme()), currentScheme());
  } else {
    clearTwTheme();
  }
}
