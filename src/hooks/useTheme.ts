import { useState, useEffect, useCallback } from 'react';
import { syncNeoTheme, findNeoTheme, getStoredNeoTheme } from '../showcase/neoThemes';

export type ThemeMode = 'light' | 'dark' | 'system' | 'tinyworld-light' | 'tinyworld-dark' | 'neo-light' | 'neo-dark';

const STORAGE_KEY = 'agensis_theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): { scheme: 'light' | 'dark'; family: 'classic' | 'tinyworld' | 'neo' } {
  if (mode === 'system') return { scheme: getSystemTheme(), family: 'classic' };
  if (mode === 'tinyworld-light') return { scheme: 'light', family: 'tinyworld' };
  if (mode === 'tinyworld-dark') return { scheme: 'dark', family: 'tinyworld' };
  if (mode === 'neo-light') return { scheme: 'light', family: 'neo' };
  if (mode === 'neo-dark') return { scheme: 'dark', family: 'neo' };
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
  const bg = family === 'tinyworld'
    ? (scheme === 'dark' ? '#181714' : '#f4ede0')
    : family === 'neo'
      ? neoBg
      : (scheme === 'dark' ? '#0c0c0c' : '#f8f8f8');
  document.documentElement.style.background = bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
  // Reconcile the neo palette layer now that family + scheme are settled.
  // For the neo family this applies the stored neo theme's matching light/dark
  // seed; for other families it clears neo overrides and restores the accent.
  syncNeoTheme();
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (
      stored === 'light' || stored === 'dark' || stored === 'system'
      || stored === 'tinyworld-light' || stored === 'tinyworld-dark'
      || stored === 'neo-light' || stored === 'neo-dark'
    ) return stored;
    return 'dark';
  });

  const resolved = resolveTheme(mode).scheme;

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const setTheme = useCallback((next: ThemeMode) => {
    setMode(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return { mode, resolved, setTheme };
}
