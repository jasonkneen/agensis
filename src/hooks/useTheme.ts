import { useState, useEffect, useCallback } from 'react';
import { syncNeoTheme, findNeoTheme, getStoredNeoTheme } from '../showcase/neoThemes';
import { syncNormalTheme } from '../showcase/normalThemes';
import { syncTwTheme, findTwTheme, getStoredTwTheme } from '../showcase/twThemes';
import { applyThemePreset, getStoredPreset } from '../showcase/themePresets';

export type ThemeMode = 'light' | 'dark' | 'system' | 'tinyworld-light' | 'tinyworld-dark' | 'neo-light' | 'neo-dark' | 'normal-light' | 'normal-dark';

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
  if (family === 'tinyworld') {
    // Match the html fallback / status-bar colour to the active world's paper
    // when it's a plain colour (skip derived color-mix values).
    const paper = findTwTheme(getStoredTwTheme())[scheme].paper;
    if (/^#|^rgb|^hsl|^oklch/.test(paper)) twBg = paper;
  }
  const bg = family === 'tinyworld'
    ? twBg
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
  // Normal themes overwrite the accent preset vars applied by syncNeoTheme's
  // non-neo branch so they win cleanly without any ordering dependency.
  syncNormalTheme(mode);
  // syncNormalTheme's clear branch strips --primary/--ring/--sh-accent (they're
  // in NORMAL_MANAGED_KEYS) for classic + tinyworld, wiping the accent preset
  // that syncNeoTheme's non-neo branch just applied. App.tsx only re-asserts it
  // on mount, so without this a light<->dark toggle silently drops the accent.
  // Re-assert last for the families that keep a preset (not neo, not normal-*).
  if (family !== 'neo' && mode !== 'normal-light' && mode !== 'normal-dark') {
    applyThemePreset(getStoredPreset());
  }
  // Reconcile the TinyWorld paper layer (world canvas/border/text/flourish).
  // Worlds deliberately don't own --primary/--sh-accent, so this composes with
  // the accent preset just applied above rather than fighting it: tinyworld →
  // apply the stored world's light/dark paper; other families → clear it.
  syncTwTheme(mode);
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (
      stored === 'light' || stored === 'dark' || stored === 'system'
      || stored === 'tinyworld-light' || stored === 'tinyworld-dark'
      || stored === 'neo-light' || stored === 'neo-dark'
      || stored === 'normal-light' || stored === 'normal-dark'
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
