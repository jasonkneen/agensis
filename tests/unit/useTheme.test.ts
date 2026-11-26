import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTheme, type ThemeMode } from '../../src/hooks/useTheme';
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
  clearNormalTheme();
  clearTwTheme();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-ui-theme');
  applyThemePreset('neutral');
  window.localStorage.clear();
});

describe('useTheme family application order', () => {
  it('migrates the removed Paper Dark mode to regular Dark', () => {
    window.localStorage.setItem('agensis_theme', 'paper-dark');

    render();

    expect(container.textContent).toBe('dark');
    expect(window.localStorage.getItem('agensis_theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('classic');
  });

  it('keeps the active palette after switching between shared-token families', () => {
    window.localStorage.setItem('agensis_theme', 'normal-light');
    window.localStorage.setItem('agensis_normal_theme', 'carbon');
    window.localStorage.setItem('agensis_tw_theme', 'gold');
    window.localStorage.setItem('agensis_theme_preset', 'blue');

    render();
    expect(styleValue('--default-radius-scale')).toBe('1');
    expect(styleValue('--background')).toBe('#f5f4f2');
    expect(styleValue('--primary')).toBe('#d9541e');

    switchTheme('paper-light');
    expect(styleValue('--background')).toBe('#f2e9d7');
    expect(styleValue('--card')).toBe('#fdf8ec');
    expect(styleValue('--primary')).toBe('oklch(0.62 0.19 256)');

    switchTheme('default-light');
    expect(styleValue('--background')).toBe('');
    expect(styleValue('--card')).toBe('');
    // The Default family generates its palette (src/lib/theme/engine.ts) as a
    // scheme-scoped stylesheet, so the accent must NOT be inline on :root —
    // an inline value would beat the dark scope — and the engine's light
    // scope must carry it instead.
    expect(styleValue('--primary')).toBe('');
    const engineCss = document.getElementById('agensis-theme-engine')?.textContent ?? '';
    const lightScope = engineCss.split('[data-theme="dark"]')[0];
    expect(lightScope).toContain('--primary: oklch(0.62 0.19 256);');

    // Back into a Classic family: its own tokens return, none of Paper's linger.
    switchTheme('normal-dark');
    expect(styleValue('--background')).not.toBe('');
    expect(styleValue('--background')).not.toBe('#f2e9d7');
    expect(styleValue('--card')).not.toBe('#fdf8ec');
  });

  it('migrates a stored Brutal mode to the matching Default mode', () => {
    window.localStorage.setItem('agensis_theme', 'neo-dark');

    render();

    expect(container.textContent).toBe('default-dark');
    expect(window.localStorage.getItem('agensis_theme')).toBe('default-dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('default');
  });

  it('preserves the numeric radius slider value and resolves legacy preset ids', () => {
    window.localStorage.setItem('agensis_theme', 'normal-light');
    window.localStorage.setItem('agensis_default_radius', '1.4');

    render();
    expect(styleValue('--default-radius-scale')).toBe('1.4');

    switchTheme('normal-dark');
    switchTheme('paper-light');
    switchTheme('default-light');
    expect(styleValue('--default-radius-scale')).toBe('1.4');
    expect(window.localStorage.getItem('agensis_default_radius')).toBe('1.4');

    window.localStorage.setItem('agensis_default_radius', 'rounded');
    switchTheme('normal-light');
    expect(styleValue('--default-radius-scale')).toBe('1.4');
    expect(window.localStorage.getItem('agensis_default_radius')).toBe('1.4');
  });
});
