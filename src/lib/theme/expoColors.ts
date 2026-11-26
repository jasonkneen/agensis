// Expo's two colour choices: the BASE (navy by default — the dark stage, and
// the ink in light) and the ACCENT (coral — primary buttons and every selected
// state). expo.css mixes every other shade from these two, keyed off
// data-expo-base / data-expo-accent on <html>. The default choice sets no
// attribute, so the stylesheet's own values stand.

export const EXPO_ACCENTS = [
  { id: 'coral', label: 'Coral', swatch: '#e8735f' },
  { id: 'tangerine', label: 'Tangerine', swatch: '#e9853a' },
  { id: 'rose', label: 'Rose', swatch: '#dd5f7f' },
  { id: 'violet', label: 'Violet', swatch: '#8a6fe0' },
  { id: 'sky', label: 'Sky', swatch: '#4c8ce0' },
  { id: 'teal', label: 'Teal', swatch: '#2c9f96' },
  { id: 'green', label: 'Green', swatch: '#4ea468' },
] as const;

export const EXPO_BASES = [
  { id: 'navy', label: 'Navy', swatch: '#2b2d48' },
  { id: 'plum', label: 'Plum', swatch: '#3a2a47' },
  { id: 'forest', label: 'Forest', swatch: '#20382f' },
  { id: 'slate', label: 'Slate', swatch: '#29333f' },
  { id: 'espresso', label: 'Espresso', swatch: '#382c26' },
  { id: 'charcoal', label: 'Charcoal', swatch: '#222327' },
] as const;

export type ExpoAccent = (typeof EXPO_ACCENTS)[number]['id'];
export type ExpoBase = (typeof EXPO_BASES)[number]['id'];

const ACCENT_KEY = 'agensis_expo_accent';
const BASE_KEY = 'agensis_expo_base';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function getExpoAccent(): ExpoAccent {
  const v = read(ACCENT_KEY);
  return (EXPO_ACCENTS.find(a => a.id === v)?.id ?? 'coral');
}
export function getExpoBase(): ExpoBase {
  const v = read(BASE_KEY);
  return (EXPO_BASES.find(b => b.id === v)?.id ?? 'navy');
}

/** Stamp the stored choices on <html>. Safe to call any time, in any family. */
export function applyExpoColors(root: HTMLElement = document.documentElement) {
  const accent = getExpoAccent();
  const base = getExpoBase();
  if (accent === 'coral') root.removeAttribute('data-expo-accent');
  else root.setAttribute('data-expo-accent', accent);
  if (base === 'navy') root.removeAttribute('data-expo-base');
  else root.setAttribute('data-expo-base', base);
}

export function setExpoAccent(id: ExpoAccent) {
  write(ACCENT_KEY, id);
  applyExpoColors();
}
export function setExpoBase(id: ExpoBase) {
  write(BASE_KEY, id);
  applyExpoColors();
}
