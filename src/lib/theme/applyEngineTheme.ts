// Reads the stored Default-family choices, runs the engine, and writes the
// result into ONE <style> element. See engine.ts for why it is a stylesheet
// and not inline properties on :root.

import { THEME_PRESETS, getStoredPreset } from '@/showcase/themePresets';
import {
  THEME_CONTRASTS,
  THEME_DEPTHS,
  THEME_PALETTES,
  buildThemeCss,
  buildThemeTokens,
  type ThemeAccent,
  type ThemeContrast,
  type ThemeDepth,
  type ThemeSeed,
} from './engine';

const STYLE_ID = 'agensis-theme-engine';
export const PALETTE_KEY = 'agensis_theme_palette';
export const CONTRAST_KEY = 'agensis_theme_contrast';
export const DEPTH_KEY = 'agensis_theme_depth';

export const DEFAULT_PALETTE = 'graphite';
export const DEFAULT_CONTRAST: ThemeContrast = 'standard';
export const DEFAULT_DEPTH: ThemeDepth = 'hard';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice lasts this session only */
  }
}

export function getStoredPalette(): string {
  const v = read(PALETTE_KEY);
  return THEME_PALETTES.some(p => p.id === v) ? (v as string) : DEFAULT_PALETTE;
}

export function getStoredContrast(): ThemeContrast {
  const v = read(CONTRAST_KEY);
  return THEME_CONTRASTS.some(c => c.id === v) ? (v as ThemeContrast) : DEFAULT_CONTRAST;
}

export function getStoredDepth(): ThemeDepth {
  const v = read(DEPTH_KEY);
  return THEME_DEPTHS.some(d => d.id === v) ? (v as ThemeDepth) : DEFAULT_DEPTH;
}

/** A preset's swatch is `oklch(L C H)`; "neutral" (reset) means ink. */
export function accentFromPreset(presetId: string): ThemeAccent | null {
  const preset = THEME_PRESETS.find(p => p.id === presetId);
  if (!preset || preset.reset) return null;
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(preset.swatch);
  if (!m) return null;
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

export function currentSeed(): ThemeSeed {
  return {
    palette: THEME_PALETTES.find(p => p.id === getStoredPalette()) ?? THEME_PALETTES[0],
    accent: accentFromPreset(getStoredPreset()),
    contrast: getStoredContrast(),
    depth: getStoredDepth(),
  };
}

/**
 * (Re)generate the Default family's stylesheet. Cheap and idempotent: call it
 * whenever any seed changes. The rules are scoped to [data-ui-theme="default"],
 * so leaving the element in place while another family is active is harmless.
 */
export function syncEngineTheme(seed: ThemeSeed = currentSeed()) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = buildThemeCss(seed);

  const root = document.documentElement;
  // Components that resolve colours in JS (terminal, canvas, Mermaid, code
  // highlighting) re-read them when an attribute on <html> changes. A
  // palette or accent change here only rewrites this <style> — no attribute
  // moves — so stamp the seed, and those watchers fire exactly as they did
  // when presets wrote inline styles.
  root.setAttribute('data-theme-seed', `${seed.palette.id}.${seed.accent ? `${seed.accent.h}-${seed.accent.c}` : 'ink'}.${seed.contrast}.${seed.depth}`);

  // The page background behind the app and the mobile status bar
  // (theme-color) were Graphite's #0c0c0c / #f8f8f8 whatever the palette;
  // under Nord or Sand that is a visible band at the edges. Default only.
  if (root.getAttribute('data-ui-theme') === 'default') {
    const scheme = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const bg = buildThemeTokens(seed, scheme)['--background'];
    root.style.background = bg;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  }
}

export function setThemePalette(id: string) {
  write(PALETTE_KEY, id);
  syncEngineTheme();
}

export function setThemeContrast(id: ThemeContrast) {
  write(CONTRAST_KEY, id);
  syncEngineTheme();
}

export function setThemeDepth(id: ThemeDepth) {
  write(DEPTH_KEY, id);
  syncEngineTheme();
}
