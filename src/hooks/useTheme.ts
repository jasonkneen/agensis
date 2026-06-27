import { useState, useEffect, useCallback } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system' | 'tinyworld-light' | 'tinyworld-dark' | 'neo-light' | 'neo-dark';

const STORAGE_KEY = 'hatch_theme';

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
  const bg = family === 'tinyworld'
    ? (scheme === 'dark' ? '#181714' : '#f4ede0')
    : family === 'neo'
      ? (scheme === 'dark' ? '#3a1414' : '#fff6d6')
      : (scheme === 'dark' ? '#0c0c0c' : '#f8f8f8');
  document.documentElement.style.background = bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
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
