import { beforeEach, describe, expect, it } from 'vitest';
import { applyExpoColors, getExpoAccent, getExpoBase, setExpoAccent, setExpoBase } from '../../src/lib/theme/expoColors';
import { readFileSync } from 'node:fs';

const root = document.documentElement;

describe('expo colour choices', () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute('data-expo-accent');
    root.removeAttribute('data-expo-base');
  });

  it('defaults to coral on navy and stamps nothing', () => {
    applyExpoColors();
    expect(getExpoAccent()).toBe('coral');
    expect(getExpoBase()).toBe('navy');
    expect(root.hasAttribute('data-expo-accent')).toBe(false);
    expect(root.hasAttribute('data-expo-base')).toBe(false);
  });

  it('stores and stamps a choice, and clears it when set back to the default', () => {
    setExpoAccent('teal');
    setExpoBase('forest');
    expect(root.getAttribute('data-expo-accent')).toBe('teal');
    expect(root.getAttribute('data-expo-base')).toBe('forest');
    setExpoAccent('coral');
    expect(root.hasAttribute('data-expo-accent')).toBe(false);
  });

  it('ignores an unknown stored value', () => {
    localStorage.setItem('agensis_expo_accent', 'neon');
    expect(getExpoAccent()).toBe('coral');
  });

  it('every non-default choice has a rule in expo.css', () => {
    const css = readFileSync('src/styles/expo.css', 'utf8');
    for (const id of ['tangerine', 'rose', 'violet', 'sky', 'teal', 'green']) expect(css).toContain(`[data-expo-accent="${id}"]`);
    for (const id of ['plum', 'forest', 'slate', 'espresso', 'charcoal']) expect(css).toContain(`[data-expo-base="${id}"]`);
    // No shade is left hard-coded to the old navy or coral, or a choice would miss it.
    expect(css).not.toMatch(/#33355a|#4a4c6e|#1d1e33|#f5a493|#b8412b/i);
  });
});
