import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTheme, type ThemeMode } from '../../src/hooks/useTheme';
import { clearNeoThemeVars } from '../../src/showcase/neoThemes';
import { clearNormalTheme } from '../../src/showcase/normalThemes';
import { clearTwTheme } from '../../src/showcase/twThemes';
import { applyThemePreset } from '../../src/showcase/themePresets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let setTheme: (mode: ThemeMode) => void;

function Probe() {
  const theme = useTheme();
  setTheme = theme.setTheme;
  return createElement('span', null, theme.mode);
}

function render() {
  act(() => root.render(createElement(Probe)));
}

function switchTheme(mode: ThemeMode) {
  act(() => setTheme(mode));
}

function styleValue(name: string) {
  return document.documentElement.style.getPropertyValue(name);
}

beforeEach(() => {
  window.localStorage.clear();
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearNeoThemeVars();
  clearNormalTheme();
  clearTwTheme();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-ui-theme');
  applyThemePreset('neutral');
  window.localStorage.clear();
});

describe('useTheme family application order', () => {
  it('keeps the active palette after switching between shared-token families', () => {
    window.localStorage.setItem('agensis_theme', 'neo-light');
    window.localStorage.setItem('agensis_neo_theme', 'blueprint');
    window.localStorage.setItem('agensis_normal_theme', 'carbon');
    window.localStorage.setItem('agensis_tw_theme', 'gold');
    window.localStorage.setItem('agensis_theme_preset', 'blue');

    render();
    expect(styleValue('--default-radius-scale')).toBe('1');
    expect(styleValue('--background')).toBe('#eef4fb');
    expect(styleValue('--card')).toBe('color-mix(in srgb, #eef4fb 42%, #ffffff 58%)');
    expect(styleValue('--primary')).toBe('#1f4f86');
    expect(styleValue('--neo-ink')).toBe('#0d2440');

    switchTheme('neo-dark');
    expect(styleValue('--background')).toBe('#0b1f38');
    expect(styleValue('--primary')).toBe('#8fd3ff');
    expect(styleValue('--neo-ink')).toBe('#dfecfb');

    switchTheme('normal-light');
    expect(styleValue('--background')).toBe('#f5f4f2');
    expect(styleValue('--primary')).toBe('#d9541e');
    expect(styleValue('--neo-ink')).toBe('');

    switchTheme('paper-light');
    expect(styleValue('--background')).toBe('#f2e9d7');
    expect(styleValue('--card')).toBe('#fdf8ec');
    expect(styleValue('--primary')).toBe('oklch(0.62 0.19 256)');

    switchTheme('default-light');
    expect(styleValue('--background')).toBe('');
    expect(styleValue('--card')).toBe('');
    expect(styleValue('--primary')).toBe('oklch(0.62 0.19 256)');
  });

  it('preserves the numeric radius slider value and resolves legacy preset ids', () => {
    window.localStorage.setItem('agensis_theme', 'neo-light');
    window.localStorage.setItem('agensis_neo_theme', 'blueprint');
    window.localStorage.setItem('agensis_default_radius', '1.4');

    render();
    expect(styleValue('--default-radius-scale')).toBe('1.4');

    switchTheme('neo-dark');
    switchTheme('normal-light');
    switchTheme('paper-light');
    switchTheme('default-light');
    expect(styleValue('--default-radius-scale')).toBe('1.4');
    expect(window.localStorage.getItem('agensis_default_radius')).toBe('1.4');

    window.localStorage.setItem('agensis_default_radius', 'rounded');
    switchTheme('neo-light');
    expect(styleValue('--default-radius-scale')).toBe('1.4');
    expect(window.localStorage.getItem('agensis_default_radius')).toBe('1.4');
  });
});
