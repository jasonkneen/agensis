import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FloatingWindow } from '../../src/types';
import { MobileWindowSwitcher } from '../../src/components/windows/MobileWindowSwitcher';

function win(id: string, zIndex: number, title = id): FloatingWindow {
  return { id, type: 'chat', title, x: 0, y: 0, width: 400, height: 300, zIndex, minimized: false } as FloatingWindow;
}

function render(props: Parameters<typeof MobileWindowSwitcher>[0]): string {
  return renderToStaticMarkup(createElement(MobileWindowSwitcher, props));
}

const noop = () => {};

describe('MobileWindowSwitcher', () => {
  it('always renders the menu button (reachable even with no windows)', () => {
    const html = render({ windows: [], activeWindowId: null, onFocus: noop, onClose: noop, onOpenMenu: noop });
    expect(html).toContain('aria-label="Open menu"');
    expect(html).toContain('No open windows');
  });

  it('renders one switch chip per open window', () => {
    const html = render({
      windows: [win('a', 1, 'Alpha'), win('b', 2, 'Beta')],
      activeWindowId: 'b',
      onFocus: noop,
      onClose: noop,
      onOpenMenu: noop,
    });
    expect(html).toContain('aria-label="Switch to Alpha"');
    expect(html).toContain('aria-label="Switch to Beta"');
    expect(html).toContain('aria-label="Close Alpha"');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
  });

  it('marks the active window with aria-current and the primary style', () => {
    const html = render({
      windows: [win('a', 1, 'Alpha'), win('b', 2, 'Beta')],
      activeWindowId: 'b',
      onFocus: noop,
      onClose: noop,
      onOpenMenu: noop,
    });
    // The active chip carries the primary border; exactly one aria-current="true".
    expect(html).toContain('border-primary/70');
    expect((html.match(/aria-current="true"/g) || []).length).toBe(1);
  });

  it('does not render the empty-state hint when windows are open', () => {
    const html = render({
      windows: [win('a', 1, 'Alpha')],
      activeWindowId: 'a',
      onFocus: noop,
      onClose: noop,
      onOpenMenu: noop,
    });
    expect(html).not.toContain('No open windows');
  });
});
