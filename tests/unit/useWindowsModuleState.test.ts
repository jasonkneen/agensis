// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWindows } from '../../src/hooks/useWindows';

// Item 7 — module-level state isolation.
//
// The H1 fix moved the z-index counter from a module-level `let nextZIndex = 100`
// (shared by every hook consumer, non-SSR-safe, untestable) to a hook-scoped
// `useRef(100)`. This test proves the isolation: two independent useWindows
// instances each seed their OWN counter, so the first window opened in each
// gets zIndex 101 — a shared module counter would give the second instance 102.

type WindowsApi = ReturnType<typeof useWindows>;

// Minimal hook harness: render a component that captures the hook's return value
// into an external ref, so the test can drive it via act() with no testing-library.
function mountUseWindows(): { api: () => WindowsApi; root: Root; container: HTMLDivElement } {
  const captured: { current: WindowsApi | null } = { current: null };
  function Probe() {
    captured.current = useWindows();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Probe));
  });
  return { api: () => captured.current as WindowsApi, root, container };
}

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function mount() {
  const m = mountUseWindows();
  mounted.push(m);
  return m;
}

afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.container.remove();
  }
});

describe('useWindows module-state isolation', () => {
  it('two independent instances do not share the z-index counter', () => {
    const a = mount();
    const b = mount();

    act(() => { a.api().openWindow('chat', { title: 'A1' }); });
    act(() => { b.api().openWindow('chat', { title: 'B1' }); });

    const aWin = a.api().windows;
    const bWin = b.api().windows;
    expect(aWin).toHaveLength(1);
    expect(bWin).toHaveLength(1);
    // Each instance seeds from its own useRef(100) → first open is 101 in BOTH.
    // A shared module-level counter would make instance B's first window 102.
    expect(aWin[0].zIndex).toBe(101);
    expect(bWin[0].zIndex).toBe(101);
  });

  it('a second instance is unaffected by the first instance advancing its counter', () => {
    const a = mount();
    // Advance A's counter several times.
    act(() => { a.api().openWindow('chat', { title: 'A1' }); });
    act(() => { a.api().openWindow('document', { title: 'A2' }); });
    act(() => { a.api().openWindow('memory', { title: 'A3' }); });
    const aLast = a.api().windows.at(-1)!.zIndex;
    expect(aLast).toBeGreaterThanOrEqual(103);

    // A fresh instance still starts at 101 — proof the counter is per-instance.
    const b = mount();
    act(() => { b.api().openWindow('chat', { title: 'B1' }); });
    expect(b.api().windows[0].zIndex).toBe(101);
  });
});
