// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { setThemePalette, syncEngineTheme } from '../../src/lib/theme/applyEngineTheme';

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  document.documentElement.removeAttribute('data-theme-seed');
  document.documentElement.style.background = '';
  document.documentElement.setAttribute('data-ui-theme', 'default');
  document.documentElement.setAttribute('data-theme', 'dark');
});

describe('syncEngineTheme side effects', () => {
  // Terminal, canvas, Mermaid and code highlighting re-read colours when an
  // attribute on <html> changes. A palette change only rewrites a <style>, so
  // without this stamp they kept the old colours until the next light/dark flip.
  it('stamps a seed attribute that changes with the palette', () => {
    syncEngineTheme();
    const before = document.documentElement.getAttribute('data-theme-seed');
    expect(before).toMatch(/^graphite\./);
    setThemePalette('nord');
    expect(document.documentElement.getAttribute('data-theme-seed')).toMatch(/^nord\./);
  });

  it('paints the page background and theme-color from the active palette, Default only', () => {
    setThemePalette('nord');
    const bg = document.documentElement.style.background;
    expect(bg).toMatch(/oklch\(0\.253 /); // Nord's lifted dark base, not #0c0c0c
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toMatch(/^oklch\(0\.253 /);

    document.documentElement.setAttribute('data-ui-theme', 'classic');
    document.documentElement.style.background = 'rgb(1, 2, 3)';
    syncEngineTheme();
    expect(document.documentElement.style.background).toBe('rgb(1, 2, 3)');
  });
});
