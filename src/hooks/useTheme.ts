import { useState, useEffect, useCallback } from 'react';
import { syncNeoTheme, clearNeoThemeVars, findNeoTheme, getStoredNeoTheme } from '../showcase/neoThemes';
import { syncNormalTheme, clearNormalTheme } from '../showcase/normalThemes';
import { syncTwTheme, clearTwTheme, findTwTheme, getStoredTwTheme } from '../showcase/twThemes';
import { applyThemePreset, getStoredPreset } from '../showcase/themePresets';
import { applyRadiusScale, getStoredRadiusScale } from '../showcase/defaultTheme';

export type ThemeMode = 'light' | 'dark' | 'system' | 'default-light' | 'default-dark' | 'default-system' | 'paper-light' | 'paper-dark' | 'neo-light' | 'neo-dark' | 'normal-light' | 'normal-dark';

const STORAGE_KEY = 'agensis_theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): { scheme: 'light' | 'dark'; family: 'default' | 'classic' | 'paper' | 'neo' } {
  if (mode === 'system') return { scheme: getSystemTheme(), family: 'classic' };
  if (mode === 'default-system') return { scheme: getSystemTheme(), family: 'default' };
  if (mode === 'default-light') return { scheme: 'light', family: 'default' };
  if (mode === 'default-dark') return { scheme: 'dark', family: 'default' };
  if (mode === 'paper-light') return { scheme: 'light', family: 'paper' };
  if (mode === 'paper-dark') return { scheme: 'dark', family: 'paper' };
  if (mode === 'neo-light') return { scheme: 'light', family: 'neo' };
  if (mode === 'neo-dark') return { scheme: 'dark', family: 'neo' };
  if (mode === 'normal-light') return { scheme: 'light', family: 'classic' };
  if (mode === 'normal-dark') return { scheme: 'dark', family: 'classic' };
  return { scheme: mode, family: 'classic' };
}

function applyTheme(mode: ThemeMode) {
  const { scheme, family } = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', scheme);
  document.documentElement.setAttribute('data-ui-theme', family);
  let neoBg = scheme === 'dark' ? '#141414' : '#fff9df';
  if (family === 'neo') {
    // Match the html fallback / mobile status-bar colour to the active neo
    // theme's paper when it's a plain colour (skip derived color-mix values).
    const paper = findNeoTheme(getStoredNeoTheme())[scheme].paper;
    if (/^#|^rgb|^hsl|^oklch/.test(paper)) neoBg = paper;
  }
  let twBg = scheme === 'dark' ? '#181714' : '#f4ede0';
  if (family === 'paper') {
    // Match the html fallback / status-bar colour to the active world's paper
    // when it's a plain colour (skip derived color-mix values).
    const paper = findTwTheme(getStoredTwTheme())[scheme].paper;
    if (/^#|^rgb|^hsl|^oklch/.test(paper)) twBg = paper;
  }
  const bg = family === 'paper'
    ? twBg
    : family === 'neo'
      ? neoBg
      : family === 'default'
        ? (scheme === 'dark' ? '#0c0c0c' : '#f8f8f8')
        : (scheme === 'dark' ? '#0c0c0c' : '#f8f8f8');
  document.documentElement.style.background = bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
  // The registries share surface keys. Clear stale inline tokens from every
  // family before applying the active one, otherwise a later inactive-family
  // clear can erase the active palette (notably Neo).
  clearNeoThemeVars();
  clearNormalTheme();
  clearTwTheme();

  // Default owns its radius through a scoped data attribute. Keeping this
  // outside the colour families means switching away cannot leak roundness.
  applyRadiusScale(getStoredRadiusScale());

  // Apply the active family last. Paper worlds deliberately leave accent
  // preset keys alone, so restore the saved preset after applying the world.
  if (family === 'neo') {
    syncNeoTheme();
  } else if (family === 'paper') {
    syncTwTheme(mode);
    applyThemePreset(getStoredPreset());
  } else if (mode === 'normal-light' || mode === 'normal-dark') {
    syncNormalTheme(mode);
  } else {
    applyThemePreset(getStoredPreset());
  }
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (
      stored === 'light' || stored === 'dark' || stored === 'system'
      || stored === 'default-light' || stored === 'default-dark' || stored === 'default-system'
      || stored === 'paper-light' || stored === 'paper-dark'
      || stored === 'neo-light' || stored === 'neo-dark'
      || stored === 'normal-light' || stored === 'normal-dark'
    ) return stored;
    return 'default-light';
  });

  const resolved = resolveTheme(mode).scheme;

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system' && mode !== 'default-system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme(mode);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const setTheme = useCallback((next: ThemeMode) => {
    setMode(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return { mode, resolved, setTheme };
}
