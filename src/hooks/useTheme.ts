import { useState, useEffect, useCallback } from 'react';
import { applyExpoColors } from '../lib/theme/expoColors';

// agensis has ONE style: Expo. The only choice left here is the scheme —
// light, dark, or follow the system. Colour (base, accent, paper) and font are
// separate choices layered on top (lib/theme/expoColors.ts, lib/settings.ts).
export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'agensis_theme';

/**
 * Every value ever stored under agensis_theme, mapped onto the one family.
 * Default, Classic, Brutal (neo), Paper and the old expo-* modes all keep
 * their light/dark/system choice; anything unrecognised starts light.
 */
export function normalizeThemeMode(stored: string | null | undefined): ThemeMode {
  const value = String(stored ?? '');
  if (value === 'system' || value.endsWith('-system')) return 'system';
  if (value === 'dark' || value.endsWith('-dark')) return 'dark';
  return 'light';
}

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveScheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? getSystemTheme() : mode;
}

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveScheme(mode));
  root.setAttribute('data-ui-theme', 'expo');
  applyExpoColors(root);
  // The page behind the app and the browser chrome take the ACTIVE base and
  // paper, read back from the stylesheet — a hard-coded navy/cream was wrong
  // the moment someone picked Forest or Stone.
  root.style.removeProperty('background');
  const bg = getComputedStyle(root).getPropertyValue('--background').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute('content', bg);
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const normalized = normalizeThemeMode(stored);
    if (stored !== normalized) localStorage.setItem(STORAGE_KEY, normalized);
    return normalized;
  });

  const resolved = resolveScheme(mode);

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme(mode);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const setTheme = useCallback((next: ThemeMode) => {
    const normalized = normalizeThemeMode(next);
    setMode(normalized);
    localStorage.setItem(STORAGE_KEY, normalized);
  }, []);

  return { mode, resolved, setTheme };
}
