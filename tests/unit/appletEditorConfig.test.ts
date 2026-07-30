import { describe, expect, it } from 'vitest';
import { appletThemeExtensions, editorSchemeFrom } from '../../src/lib/appletEditorConfig';

describe('editorSchemeFrom', () => {
  it('maps the two values useTheme actually writes', () => {
    expect(editorSchemeFrom('light')).toBe('light');
    expect(editorSchemeFrom('dark')).toBe('dark');
  });

  it('falls back to dark for anything else — the app default', () => {
    // A missing attribute, an experimental theme name, or garbage must never
    // leave the editor unstyled or throw in the observer callback.
    for (const odd of [null, undefined, '', 'system', 'neo-dark', 'DARK']) {
      expect(editorSchemeFrom(odd)).toBe('dark');
    }
  });
});

describe('appletThemeExtensions', () => {
  it('builds a non-empty extension set for both schemes', () => {
    // The compartment swap on theme change reconfigures with this; an empty
    // array would silently strip all highlighting.
    expect(appletThemeExtensions('dark').length).toBeGreaterThan(0);
    expect(appletThemeExtensions('light').length).toBeGreaterThan(0);
  });

  it('the two schemes are actually different configurations', () => {
    const dark = appletThemeExtensions('dark');
    const light = appletThemeExtensions('light');
    // Same chrome, different token palette — index 1 is the syntaxHighlighting
    // extension. If someone collapses them into one palette this fails and the
    // light theme goes unreadable quietly.
    expect(dark[1]).not.toBe(light[1]);
    expect(dark[0]).toBe(light[0]);
  });
});
