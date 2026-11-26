import { useState, useEffect, useCallback } from 'react';
import { syncNormalTheme, clearNormalTheme } from '../showcase/normalThemes';
import { applyThemePreset, getStoredPreset } from '../showcase/themePresets';
import { applyRadiusScale, getStoredRadiusScale } from '../showcase/defaultTheme';

export type ThemeMode = 'light' | 'dark' | 'system' | 'default-light' | 'default-dark' | 'default-system' | 'expo-light' | 'expo-dark' | 'normal-light' | 'normal-dark';

const STORAGE_KEY = 'agensis_theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): { scheme: 'light' | 'dark'; family: 'default' | 'classic' | 'expo' } {
  if (mode === 'system') return { scheme: getSystemTheme(), family: 'classic' };
  if (mode === 'default-system') return { scheme: getSystemTheme(), family: 'default' };
  if (mode === 'default-light') return { scheme: 'light', family: 'default' };
  if (mode === 'default-dark') return { scheme: 'dark', family: 'default' };
  if (mode === 'expo-light') return { scheme: 'light', family: 'expo' };
  if (mode === 'expo-dark') return { scheme: 'dark', family: 'expo' };
  if (mode === 'normal-light') return { scheme: 'light', family: 'classic' };
  if (mode === 'normal-dark') return { scheme: 'dark', family: 'classic' };
  return { scheme: mode, family: 'classic' };
}

function applyTheme(mode: ThemeMode) {
  const { scheme, family } = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', scheme);
  document.documentElement.setAttribute('data-ui-theme', family);
  const bg = family === 'expo'
    ? (scheme === 'dark' ? '#2b2d48' : '#fbf4e4')
    : (scheme === 'dark' ? '#0c0c0c' : '#f8f8f8');
  document.documentElement.style.background = bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
  // The registries share surface keys. Clear stale inline tokens from every
  // family before applying the active one, otherwise a later inactive-family
  // clear can erase the active palette.
  clearNormalTheme();

  // Default owns its radius through a scoped data attribute. Keeping this
  // outside the colour families means switching away cannot leak roundness.
  applyRadiusScale(getStoredRadiusScale());

  // Apply the active family last. Expo has a fixed palette; applyThemePreset
  // clears managed inline keys and returns early for it.
  if (family === 'expo') {
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
    // Brutal (neo) was removed; its stored modes land on Default.
    if (stored === 'neo-light' || stored === 'neo-dark') {
      const migrated = stored === 'neo-dark' ? 'default-dark' : 'default-light';
      localStorage.setItem(STORAGE_KEY, migrated);
      return migrated;
    }
    // Paper was replaced by Expo; its stored modes land there.
    if (stored === 'paper-light' || stored === 'paper-dark') {
      const migrated = stored === 'paper-dark' ? 'expo-dark' : 'expo-light';
      localStorage.setItem(STORAGE_KEY, migrated);
      return migrated;
    }
    if (
      stored === 'light' || stored === 'dark' || stored === 'system'
      || stored === 'default-light' || stored === 'default-dark' || stored === 'default-system'
      || stored === 'expo-light' || stored === 'expo-dark'
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
