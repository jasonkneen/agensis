import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyNormalTheme,
  clearNormalTheme,
  expandNormal,
  findNormalTheme,
} from '../../src/showcase/normalThemes';

describe('normal themes', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.setAttribute('data-theme', 'dark');
    clearNormalTheme();
  });

  afterEach(() => {
    clearNormalTheme();
    localStorage.clear();
  });

  it('ships Carbon as a dark-first neutral palette with a warm accent', () => {
    const carbon = findNormalTheme('carbon');
    expect(carbon).toBeDefined();
    expect(carbon?.group).toBe('Minimal');
    expect(carbon?.dark.bg).toBe('#08090a');
    expect(carbon?.dark.elevated).toBe('#111213');
    expect(carbon?.dark.primary).toBe('#ff6b2c');

    const vars = expandNormal(carbon!.dark);
    expect(vars['--background']).toBe('#08090a');
    expect(vars['--card']).toBe('#111213');
    expect(vars['--primary']).toBe('#ff6b2c');
  });

  it('exposes and clears the active palette identity for theme-specific traits', () => {
    applyNormalTheme('carbon');

    expect(document.documentElement.getAttribute('data-normal-theme')).toBe('carbon');
    expect(document.documentElement.getAttribute('data-normal-theme-group')).toBe('Minimal');
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('#08090a');

    clearNormalTheme();

    expect(document.documentElement.hasAttribute('data-normal-theme')).toBe(false);
    expect(document.documentElement.hasAttribute('data-normal-theme-group')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('');
  });
});
