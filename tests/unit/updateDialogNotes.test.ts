import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReleaseNote } from '../../src/lib/releaseNotes';

// The What's New dialog: a gallery on top, the newest release expanded with its
// highlights as bullets, and EVERYTHING older folded into ONE expander. These
// assert the shape a reader actually gets, because the previous version gave
// every old release its own collapsed row — thirty of which is its own wall.

const { UpdateDialog } = await import('../../src/components/UpdateDialog');

let container: HTMLDivElement;
let root: Root;

const note = (n: number, over: Partial<ReleaseNote> = {}): ReleaseNote => ({
  version: `v${n}`,
  date: `2026-07-${String(n).padStart(2, '0')}`,
  title: `Release ${n}`,
  summary: `Summary for release ${n}.`,
  highlights: [`Highlight ${n}A`, `Highlight ${n}B`],
  ...over,
});

function render(notes: ReleaseNote[]) {
  act(() => {
    root.render(
      createElement(UpdateDialog, {
        open: true,
        onOpenChange: () => {},
        notes,
        mode: 'updated' as const,
        onReload: () => {},
      }),
    );
  });
}

/** The dialog portals to document.body, so query there, not the container. */
const inDialog = (selector: string) => Array.from(document.body.querySelectorAll(selector));

beforeEach(() => {
  // The carousel (embla) reads matchMedia for its breakpoint options, which
  // jsdom does not implement — without this the whole dialog throws on mount.
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  if (!('ResizeObserver' in window)) {
    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }
  if (!('IntersectionObserver' in window)) {
    Object.defineProperty(window, 'IntersectionObserver', {
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() { return []; }
        readonly root = null;
        readonly rootMargin = '';
        readonly thresholds = [];
      },
    });
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Embla measures the DOM; jsdom reports zeroes, which is harmless here but
  // noisy. Silence only that path.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('UpdateDialog release notes', () => {
  it('folds every older release into a SINGLE expander', () => {
    render([note(9), note(8), note(7), note(6), note(5)]);
    const expanders = inDialog('details');
    expect(expanders).toHaveLength(1);
    expect(expanders[0].textContent).toContain('Earlier updates');
  });

  it('counts the older releases on the expander, so the reader can judge it', () => {
    render([note(9), note(8), note(7), note(6)]);
    const summary = inDialog('details > summary')[0];
    expect(summary?.textContent).toContain('3');
  });

  it('shows the newest release expanded, outside the expander', () => {
    render([note(9), note(8)]);
    const details = inDialog('details')[0];
    expect(document.body.textContent).toContain('Release 9');
    // The latest must not be inside the collapsed section — that is the whole
    // point of separating it.
    expect(details?.textContent).not.toContain('Release 9');
    expect(details?.textContent).toContain('Release 8');
  });

  it('renders highlights as list items, not a run-on paragraph', () => {
    render([note(9)]);
    const items = inDialog('li').map(li => li.textContent);
    expect(items).toContain('Highlight 9A');
    expect(items).toContain('Highlight 9B');
  });

  it('renders no expander at all when there is only one release', () => {
    render([note(9)]);
    expect(inDialog('details')).toHaveLength(0);
  });

  it('still renders the gallery when there are no notes', () => {
    // The notes fetch failing must not take the whole dialog down with it.
    render([]);
    expect(document.body.textContent).toContain('aren’t available');
    expect(inDialog('[data-testid^="wireframe-"]').length).toBeGreaterThan(0);
  });

  it('draws a wireframe demo for the gallery', () => {
    render([note(9)]);
    const demos = inDialog('[data-testid^="wireframe-"]');
    expect(demos.length).toBeGreaterThan(0);
    // Every demo must be labelled — an unlabelled role=img is invisible to a
    // screen reader, and these carry the only explanation of the animation.
    for (const demo of demos) {
      expect(demo.getAttribute('aria-label')?.trim()).toBeTruthy();
    }
  });
});
