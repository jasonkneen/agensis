import { useSyncExternalStore } from 'react';
import type { ThemeInput } from '@streamdown/code';
import { getStoredNeoTheme } from '../showcase/neoThemes';
import { getStoredNormalTheme } from '../showcase/normalThemes';
import { getStoredTwTheme } from '../showcase/twThemes';

export type ChatShikiThemePair = [light: ThemeInput, dark: ThemeInput];

const DEFAULT_CODE_THEMES: ChatShikiThemePair = ['github-light', 'github-dark'];

/**
 * Syntax palettes for the Agensis colour themes that have a close Shiki peer.
 * The surrounding code surface still uses Agensis tokens, so every other
 * palette inherits the correct canvas, border and foreground even when it
 * deliberately falls back to the neutral GitHub syntax pair.
 */
const CODE_THEMES_BY_PALETTE: Readonly<Record<string, ChatShikiThemePair>> = {
  dracula: ['github-light', 'dracula'],
  'tokyo-night': ['github-light', 'tokyo-night'],
  'one-dark': ['github-light', 'one-dark-pro'],
  nord: ['github-light', 'nord'],
  catppuccin: ['catppuccin-latte', 'catppuccin-mocha'],
  gruvbox: ['gruvbox-light-medium', 'gruvbox-dark-medium'],
  solarized: ['solarized-light', 'solarized-dark'],
  github: ['github-light', 'github-dark'],
  everforest: ['everforest-light', 'everforest-dark'],
  'rose-pine': ['rose-pine-dawn', 'rose-pine'],
  kanagawa: ['kanagawa-lotus', 'kanagawa-wave'],
  ocean: ['github-light', 'github-dark'],
  rose: ['rose-pine-dawn', 'rose-pine'],
  forest: ['everforest-light', 'everforest-dark'],
  amber: ['gruvbox-light-medium', 'gruvbox-dark-medium'],
  sepia: ['gruvbox-light-soft', 'gruvbox-dark-soft'],
};

export function chatShikiThemesFor(paletteId: string): ChatShikiThemePair {
  return CODE_THEMES_BY_PALETTE[paletteId] ?? DEFAULT_CODE_THEMES;
}

function readChatPalette(): string {
  if (typeof document === 'undefined') return '';
  const root = document.documentElement;
  const family = root.dataset.uiTheme || 'default';

  if (family === 'neo') return getStoredNeoTheme();
  if (family === 'paper') return getStoredTwTheme();
  if (root.hasAttribute('data-normal-theme-group')) return getStoredNormalTheme();
  return '';
}

function subscribeToTheme(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      'class',
      'data-theme',
      'data-ui-theme',
      'data-normal-theme-group',
      'data-neo-style',
      'style',
    ],
  });
  window.addEventListener('storage', onChange);
  return () => {
    observer.disconnect();
    window.removeEventListener('storage', onChange);
  };
}

/** Reactively follows every Agensis theme family and palette switch. */
export function useChatShikiThemes(): ChatShikiThemePair {
  const palette = useSyncExternalStore(subscribeToTheme, readChatPalette, () => '');
  return chatShikiThemesFor(palette);
}
