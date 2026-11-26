import { describe, it, expect, beforeEach } from 'vitest';
import { themeSignature } from '../../src/components/canvas/CanvasObjectRenderer';

// Why this exists: CanvasObjectRenderer re-initialises every applet iframe when
// the theme changes, by posting state + the FULL tasks and agents arrays. It
// used to do that on any <html> style mutation, and Sidebar.tsx writes four
// --workspace-viewport-* properties to <html> on every frame of a sidebar drag.
// The signature below is the gate that keeps a drag from becoming a broadcast.
describe('themeSignature', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('html');
    root.setAttribute('data-theme', 'dark');
    root.setAttribute('data-ui-theme', 'default');
    root.style.setProperty('--background', '#101014');
  });

  it('does not move when only the sidebar viewport vars change', () => {
    const before = themeSignature(root);
    root.style.setProperty('--workspace-viewport-left', '320px');
    root.style.setProperty('--workspace-viewport-top', '8px');
    expect(themeSignature(root)).toBe(before);

    // A drag is a stream of these; every frame must stay quiet.
    for (const left of ['321px', '322px', '323px']) {
      root.style.setProperty('--workspace-viewport-left', left);
      expect(themeSignature(root)).toBe(before);
    }
  });

  it('moves when the colour scheme flips', () => {
    const before = themeSignature(root);
    root.setAttribute('data-theme', 'light');
    expect(themeSignature(root)).not.toBe(before);
  });

  it('moves when the theme family changes', () => {
    const before = themeSignature(root);
    root.setAttribute('data-ui-theme', 'paper');
    expect(themeSignature(root)).not.toBe(before);
  });

  it('moves when a theme token is rewritten', () => {
    const before = themeSignature(root);
    root.style.setProperty('--background', '#ffffff');
    expect(themeSignature(root)).not.toBe(before);
  });

  it('still notices a theme token change while viewport vars are also present', () => {
    root.style.setProperty('--workspace-viewport-left', '320px');
    const before = themeSignature(root);
    root.style.setProperty('--primary', '#ff0000');
    expect(themeSignature(root)).not.toBe(before);
  });
});
