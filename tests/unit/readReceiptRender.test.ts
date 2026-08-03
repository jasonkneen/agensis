import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReadReceipt } from '../../src/components/chat/ReadReceipt';
import { TooltipProvider } from '../../src/components/ui/tooltip';

// The regression these tests exist for: the read state rendered as a solid
// blob. `<Eye fill="currentColor" />` applies the fill to EVERY node of the
// lucide icon, and lucide's eye is an almond path PLUS a pupil circle — so the
// almond went solid and the pupil disappeared into it, leaving a 14px lozenge
// with no eye in it.
//
// The invariant is therefore about WHICH element carries the fill, not about
// how it looks: the almond must never be filled, in either state.
//
// `createElement` inside a `.ts` file rather than JSX, because the runner's glob
// is tests/unit/**/*.test.ts and `.test.tsx` is not in it. Same harness as
// tests/unit/seenPillRender.test.ts — do not invent a second one.

const ME = 'me-1';
const AGENT = 'agent-1';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(createElement(TooltipProvider, null, node)));
}

const resolve = (id: string) => (id === AGENT ? 'Coder' : null);

function glyph(): SVGElement {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('no eye glyph rendered');
  return svg;
}

describe('ReadReceipt eye glyph', () => {
  it('never fills the almond outline when read', () => {
    render(createElement(ReadReceipt, { readerIds: [AGENT], resolveName: resolve }));
    const path = glyph().querySelector('path');
    expect(path).not.toBeNull();
    // The blob. Any truthy fill here and the icon stops being an eye.
    expect(path?.getAttribute('fill')).not.toBe('currentColor');
    expect(glyph().getAttribute('fill')).toBe('none');
  });

  it('fills only the pupil when read', () => {
    render(createElement(ReadReceipt, { readerIds: [AGENT], resolveName: resolve }));
    expect(glyph().querySelector('circle')?.getAttribute('fill')).toBe('currentColor');
    expect(glyph().getAttribute('data-read')).toBe('true');
  });

  it('leaves the pupil hollow when unread', () => {
    // Unread only renders at all in a DM; a channel shows nothing until
    // somebody has actually read it.
    render(createElement(ReadReceipt, { readerIds: [], resolveName: resolve, isDirect: true }));
    expect(glyph().querySelector('circle')?.getAttribute('fill')).toBe('none');
    expect(glyph().querySelector('path')?.getAttribute('fill')).not.toBe('currentColor');
    expect(glyph().getAttribute('data-read')).toBe('false');
  });

  it('keeps the stroke on both states, so the eye stays legible', () => {
    render(createElement(ReadReceipt, { readerIds: [AGENT], resolveName: resolve }));
    expect(glyph().getAttribute('stroke')).toBe('currentColor');
    act(() => root.unmount());
    root = createRoot(container);
    render(createElement(ReadReceipt, { readerIds: [], resolveName: resolve, isDirect: true }));
    expect(glyph().getAttribute('stroke')).toBe('currentColor');
  });

  it('renders nothing in a channel until somebody has read it', () => {
    render(createElement(ReadReceipt, { readerIds: [], resolveName: resolve }));
    expect(container.querySelector('svg')).toBeNull();
  });

  it('states the fact in text, not in the glyph', () => {
    render(createElement(ReadReceipt, { readerIds: [AGENT], resolveName: resolve }));
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'Read by 1 person',
    );
    expect(glyph().getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a count only in a group of more than one', () => {
    render(createElement(ReadReceipt, { readerIds: [AGENT, ME], resolveName: resolve }));
    expect(container.textContent).toContain('2');
    act(() => root.unmount());
    root = createRoot(container);
    render(createElement(ReadReceipt, { readerIds: [AGENT], resolveName: resolve }));
    expect(container.textContent).not.toContain('1');
  });
});
