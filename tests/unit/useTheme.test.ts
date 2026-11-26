import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { normalizeThemeMode, useTheme, type ThemeMode } from '../../src/hooks/useTheme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let setTheme: (mode: ThemeMode) => void;

function Probe() {
  const theme = useTheme();
  setTheme = theme.setTheme;
  return createElement('span', null, theme.mode);
}
const render = () => act(() => root.render(createElement(Probe)));

beforeEach(() => {
  window.localStorage.clear();
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    });
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-ui-theme');
  window.localStorage.clear();
});

describe('one style: Expo', () => {
  it.each([
    ['default-light', 'light'], ['default-dark', 'dark'], ['default-system', 'system'],
    ['normal-light', 'light'], ['normal-dark', 'dark'],
    ['expo-light', 'light'], ['expo-dark', 'dark'],
    ['neo-dark', 'dark'], ['paper-light', 'light'], ['paper-dark', 'dark'],
    ['light', 'light'], ['dark', 'dark'], ['system', 'system'],
    [null, 'light'], ['garbage', 'light'],
  ])('maps stored %s to %s', (stored, expected) => {
    expect(normalizeThemeMode(stored)).toBe(expected);
  });

  it('migrates any stored family to Expo, keeping the scheme, and rewrites storage', () => {
    window.localStorage.setItem('agensis_theme', 'normal-dark');
    render();
    expect(container.textContent).toBe('dark');
    expect(window.localStorage.getItem('agensis_theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('expo');
  });

  it('is always Expo whatever scheme is chosen', () => {
    render();
    for (const mode of ['light', 'dark', 'system'] as ThemeMode[]) {
      act(() => setTheme(mode));
      expect(document.documentElement.getAttribute('data-ui-theme')).toBe('expo');
      expect(window.localStorage.getItem('agensis_theme')).toBe(mode);
    }
  });

  it('writes the colour palette so swatch choices apply', () => {
    window.localStorage.setItem('agensis_expo_accent', 'teal');
    render();
    expect(document.getElementById('agensis-expo-colors')?.textContent).toContain('--expo-coral:#2c9f96');
    expect(document.documentElement.getAttribute('data-theme-seed')).toBe('navy.teal.cream');
  });
});
