import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResizeHandle } from '../../src/components/common/ResizeHandle';

// This pins the accessibility contract, not the styling. A pane-resize seam
// used to be written by hand at thirteen call sites and drifted into four
// spellings on three tiers: one of them could not be focused at all, and two
// announced as a separator without being a tab stop. Those are exactly the
// facts a snapshot of class names would not have caught, so they are asserted
// as behaviour: the element is a separator, it is reachable, and it says which
// way it moves.

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(node); });
  return host.firstElementChild as HTMLElement;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe('ResizeHandle', () => {
  it('is a focusable separator, not a button', () => {
    const el = render(createElement(ResizeHandle, { orientation: 'vertical', 'aria-label': 'Resize list' }));
    expect(el.getAttribute('role')).toBe('separator');
    // The whole point of the rewrite: a button invites Enter and does nothing.
    expect(el.tagName).not.toBe('BUTTON');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('aria-label')).toBe('Resize list');
  });

  it('reports the axis it moves on', () => {
    const vertical = render(createElement(ResizeHandle, { orientation: 'vertical' }));
    expect(vertical.getAttribute('aria-orientation')).toBe('vertical');
    act(() => { root!.unmount(); });
    host!.remove();

    const horizontal = render(createElement(ResizeHandle, { orientation: 'horizontal' }));
    expect(horizontal.getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('passes the caller its position classes and keeps its own', () => {
    const el = render(createElement(ResizeHandle, { orientation: 'vertical', className: 'inset-y-0 -ml-1.5' }));
    expect(el.className).toContain('inset-y-0');
    expect(el.className).toContain('-ml-1.5');
    expect(el.className).toContain('cursor-col-resize');
  });

  it('forwards the value triple a splitter is supposed to announce', () => {
    const el = render(createElement(ResizeHandle, {
      orientation: 'vertical',
      'aria-valuenow': 240,
      'aria-valuemin': 180,
      'aria-valuemax': 520,
    }));
    expect(el.getAttribute('aria-valuenow')).toBe('240');
    expect(el.getAttribute('aria-valuemin')).toBe('180');
    expect(el.getAttribute('aria-valuemax')).toBe('520');
  });

  it('keeps the grab line out of the accessibility tree', () => {
    const el = render(createElement(ResizeHandle, { orientation: 'vertical' }));
    const line = el.querySelector('span');
    expect(line).not.toBeNull();
    expect(line!.getAttribute('aria-hidden')).toBe('true');
  });
});
