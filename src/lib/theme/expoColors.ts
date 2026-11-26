// Expo's colour choices — the ONE place they are defined.
//
// agensis has one style (Expo: lipped pills, edged opaque surfaces). What a
// person chooses is colour:
//   BASE   — the dark stage, and the ink (text) in light
//   ACCENT — primary buttons and every selected state
//   PAPER  — the light page, cards and the warm edges/lips around them
// plus PRESETS that set all three at once (Nord, Dracula, … ported from the
// retired Default family's named palettes).
//
// This module writes the seeds — and the few values that must be SOLVED for
// contrast, not hand-picked — into one <style id="agensis-expo-colors">.
// expo.css mixes every other surface from those seeds. Nothing else in the
// app may hard-code an Expo colour (tests/unit/expoColors.test.ts enforces it).

export interface ExpoSwatch { id: string; label: string; hex: string }
export interface ExpoPaper { id: string; label: string; cream: string; paper: string; tone: string }
export interface ExpoPreset { id: string; label: string; base: string; accent: string; paper: string }

export const EXPO_BASES = [
  { id: 'navy', label: 'Navy', hex: '#2b2d48' },
  { id: 'midnight', label: 'Midnight', hex: '#1b1e30' },
  { id: 'ink', label: 'Ink', hex: '#1f2b45' },
  { id: 'slate', label: 'Slate', hex: '#29333f' },
  { id: 'graphite', label: 'Graphite', hex: '#2a2a2f' },
  { id: 'charcoal', label: 'Charcoal', hex: '#222327' },
  { id: 'plum', label: 'Plum', hex: '#3a2a47' },
  { id: 'wine', label: 'Wine', hex: '#3d2431' },
  { id: 'espresso', label: 'Espresso', hex: '#382c26' },
  { id: 'olive', label: 'Olive', hex: '#2e3324' },
  { id: 'forest', label: 'Forest', hex: '#20382f' },
  { id: 'teal', label: 'Deep teal', hex: '#1d383b' },
  // Preset-only bases (the named palettes), still choosable on their own.
  { id: 'nord', label: 'Nord', hex: '#2e3440' },
  { id: 'dracula', label: 'Dracula', hex: '#282a36' },
  { id: 'tokyo', label: 'Tokyo Night', hex: '#1a1b26' },
  { id: 'gruvbox', label: 'Gruvbox', hex: '#282828' },
  { id: 'solarized', label: 'Solarized', hex: '#073642' },
] as const satisfies readonly ExpoSwatch[];

export const EXPO_ACCENTS = [
  { id: 'coral', label: 'Coral', hex: '#e8735f' },
  { id: 'tangerine', label: 'Tangerine', hex: '#e9853a' },
  { id: 'amber', label: 'Amber', hex: '#e2a72e' },
  { id: 'rose', label: 'Rose', hex: '#dd5f7f' },
  { id: 'berry', label: 'Berry', hex: '#c2457a' },
  { id: 'violet', label: 'Violet', hex: '#8a6fe0' },
  { id: 'indigo', label: 'Indigo', hex: '#5d6ce0' },
  { id: 'sky', label: 'Sky', hex: '#4c8ce0' },
  { id: 'cyan', label: 'Frost', hex: '#5fb4c9' },
  { id: 'teal', label: 'Teal', hex: '#2c9f96' },
  { id: 'mint', label: 'Mint', hex: '#62c29b' },
  { id: 'green', label: 'Green', hex: '#4ea468' },
  { id: 'pink', label: 'Pink', hex: '#ef7fb4' },
] as const satisfies readonly ExpoSwatch[];

export const EXPO_PAPERS = [
  { id: 'cream', label: 'Cream', cream: '#fbf4e4', paper: '#fffaf0', tone: '#c9a676' },
  { id: 'sand', label: 'Sand', cream: '#f6ecd8', paper: '#fdf7ea', tone: '#c3a064' },
  { id: 'linen', label: 'Linen', cream: '#f7f6f2', paper: '#ffffff', tone: '#b8b5aa' },
  { id: 'stone', label: 'Stone', cream: '#f0eee9', paper: '#faf9f6', tone: '#a8a294' },
  { id: 'sage', label: 'Sage', cream: '#eef3ea', paper: '#f9fcf6', tone: '#9db39a' },
  { id: 'mist', label: 'Mist', cream: '#ecf2f7', paper: '#f8fbfd', tone: '#9cb2c8' },
  { id: 'lilac', label: 'Lilac', cream: '#f3f0f8', paper: '#fcfbfe', tone: '#ada2cb' },
  { id: 'blush', label: 'Blush', cream: '#faefec', paper: '#fffaf8', tone: '#d1a297' },
  { id: 'nord', label: 'Snow', cream: '#eceff4', paper: '#f8f9fb', tone: '#a3b0c4' },
  { id: 'solarized', label: 'Solarized', cream: '#fdf6e3', paper: '#fffbf0', tone: '#c2b38a' },
  { id: 'gruvbox', label: 'Parchment', cream: '#fbf1c7', paper: '#fdf8e1', tone: '#c4b07f' },
] as const satisfies readonly ExpoPaper[];

export const EXPO_PRESETS = [
  { id: 'expo', label: 'Expo', base: 'navy', accent: 'coral', paper: 'cream' },
  { id: 'nord', label: 'Nord', base: 'nord', accent: 'cyan', paper: 'nord' },
  { id: 'dracula', label: 'Dracula', base: 'dracula', accent: 'violet', paper: 'lilac' },
  { id: 'tokyo', label: 'Tokyo Night', base: 'tokyo', accent: 'indigo', paper: 'mist' },
  { id: 'gruvbox', label: 'Gruvbox', base: 'gruvbox', accent: 'tangerine', paper: 'gruvbox' },
  { id: 'solarized', label: 'Solarized', base: 'solarized', accent: 'sky', paper: 'solarized' },
  { id: 'forest', label: 'Forest', base: 'forest', accent: 'mint', paper: 'sage' },
  { id: 'rosewood', label: 'Rosewood', base: 'wine', accent: 'rose', paper: 'blush' },
  { id: 'harbour', label: 'Harbour', base: 'ink', accent: 'amber', paper: 'mist' },
  { id: 'studio', label: 'Studio', base: 'graphite', accent: 'tangerine', paper: 'linen' },
] as const satisfies readonly ExpoPreset[];

export type ExpoBase = (typeof EXPO_BASES)[number]['id'];
export type ExpoAccent = (typeof EXPO_ACCENTS)[number]['id'];
export type ExpoPaperId = (typeof EXPO_PAPERS)[number]['id'];

const KEYS = { base: 'agensis_expo_base', accent: 'agensis_expo_accent', paper: 'agensis_expo_paper' } as const;
const DEFAULTS = { base: 'navy', accent: 'coral', paper: 'cream' } as const;

// ---- colour maths (sRGB, WCAG 2 relative luminance) ------------------------

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}
/** `t` of `a` mixed into `b` (t = 1 → a). */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a); const y = hexToRgb(b);
  return rgbToHex([0, 1, 2].map(i => x[i] * t + y[i] * (1 - t)) as Rgb);
}
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}
/**
 * Walk from `strong` toward `soft` and return the softest mix that still
 * reaches `target` contrast against `against`. Never softer than `maxSoft`.
 */
function solveInk(strong: string, soft: string, against: string, target: number, maxSoft: number): string {
  let best = strong;
  for (let s = 0; s <= maxSoft + 1e-9; s += 0.02) {
    const candidate = mixHex(soft, strong, s);
    if (contrast(candidate, against) >= target) best = candidate; else break;
  }
  return best;
}

// ---- the palette ------------------------------------------------------------

export interface ExpoTokens {
  navy: string; coral: string; cream: string; paper: string; tone: string;
  /** Text on the accent: the paper colour if it clears 3:1 (large/bold UI text), else the base. */
  onAccent: string;
  /** The light page the inks are solved against (mirrors expo.css --background). */
  lightBackground: string;
  inkLight2: string; inkLight3: string; inkDark2: string; inkDark3: string;
}

function find<T extends { id: string }>(list: readonly T[], id: string, fallback: string): T {
  return list.find(item => item.id === id) ?? list.find(item => item.id === fallback)!;
}

export function buildExpoTokens(baseId: string, accentId: string, paperId: string): ExpoTokens {
  const navy = find(EXPO_BASES, baseId, DEFAULTS.base).hex;
  const coral = find(EXPO_ACCENTS, accentId, DEFAULTS.accent).hex;
  const p = find(EXPO_PAPERS, paperId, DEFAULTS.paper);
  const lightBackground = mixHex(p.tone, p.cream, 0.09);
  const onAccent = contrast(p.paper, coral) >= 3 ? p.paper : navy;
  return {
    navy, coral, cream: p.cream, paper: p.paper, tone: p.tone, onAccent, lightBackground,
    // Secondary text clears 4.5:1 (body text), faint clears 3:1 — against the
    // page they actually sit on, in both schemes.
    inkLight2: solveInk(navy, p.cream, lightBackground, 4.6, 0.5),
    inkLight3: solveInk(navy, p.cream, lightBackground, 3.1, 0.7),
    inkDark2: solveInk(p.cream, navy, navy, 4.6, 0.4),
    inkDark3: solveInk(p.cream, navy, navy, 3.1, 0.6),
  };
}

export function buildExpoCss(t: ExpoTokens): string {
  return `:root:root[data-ui-theme="expo"]{--expo-navy:${t.navy};--expo-coral:${t.coral};--expo-cream:${t.cream};--expo-paper:${t.paper};--expo-tone:${t.tone};--expo-on-accent:${t.onAccent};--expo-ink-2-light:${t.inkLight2};--expo-ink-3-light:${t.inkLight3};--expo-ink-2-dark:${t.inkDark2};--expo-ink-3-dark:${t.inkDark3};}`;
}

// ---- storage + application --------------------------------------------------

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function getExpoBase(): ExpoBase { return find(EXPO_BASES, read(KEYS.base) ?? '', DEFAULTS.base).id; }
export function getExpoAccent(): ExpoAccent { return find(EXPO_ACCENTS, read(KEYS.accent) ?? '', DEFAULTS.accent).id; }
export function getExpoPaper(): ExpoPaperId { return find(EXPO_PAPERS, read(KEYS.paper) ?? '', DEFAULTS.paper).id; }

/** Write the stored choices into the page. Safe to call any time. */
export function applyExpoColors(root: HTMLElement = document.documentElement) {
  const base = getExpoBase(); const accent = getExpoAccent(); const paper = getExpoPaper();
  const doc = root.ownerDocument;
  let style = doc.getElementById('agensis-expo-colors') as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = 'agensis-expo-colors';
    doc.head.appendChild(style);
  }
  style.textContent = buildExpoCss(buildExpoTokens(base, accent, paper));
  root.setAttribute('data-expo-base', base);
  root.setAttribute('data-expo-accent', accent);
  root.setAttribute('data-expo-paper', paper);
  // Terminal, Mermaid, code blocks and the canvas read colours once and
  // re-read when this attribute changes (they observe data-theme-seed).
  root.setAttribute('data-theme-seed', `${base}.${accent}.${paper}`);
}

export function setExpoBase(id: ExpoBase) { write(KEYS.base, id); applyExpoColors(); }
export function setExpoAccent(id: ExpoAccent) { write(KEYS.accent, id); applyExpoColors(); }
export function setExpoPaper(id: ExpoPaperId) { write(KEYS.paper, id); applyExpoColors(); }
export function applyExpoPreset(id: string) {
  const preset = EXPO_PRESETS.find(p => p.id === id);
  if (!preset) return;
  write(KEYS.base, preset.base); write(KEYS.accent, preset.accent); write(KEYS.paper, preset.paper);
  applyExpoColors();
}
/** The preset the current three choices match, if any. */
export function currentExpoPreset(): string | null {
  const base = getExpoBase(); const accent = getExpoAccent(); const paper = getExpoPaper();
  return EXPO_PRESETS.find(p => p.base === base && p.accent === accent && p.paper === paper)?.id ?? null;
}
