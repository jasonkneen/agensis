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
  // enterFullExpand/exitFullExpand persist a view-mode preference to
  // localStorage; clear it so it can't leak across tests and spuriously
  // restore full-expand in a later instance.
  try { window.localStorage.clear(); } catch { /* jsdom always has it */ }
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

describe('useWindows full-expand (focus) mode', () => {
  it('starts in multi mode and toggles into/out of full', () => {
    const a = mount();
    act(() => { a.api().openWindow('chat', { title: 'A1' }); });
    expect(a.api().viewMode).toBe('multi');

    const id = a.api().windows[0].id;
    act(() => { a.api().toggleFullExpand(id); });
    expect(a.api().viewMode).toBe('full');
    // Focus target is raised + un-minimized so it is the single visible window.
    expect(a.api().windows[0].minimized).toBe(false);

    act(() => { a.api().toggleFullExpand(id); });
    expect(a.api().viewMode).toBe('multi');
  });

  it('enterFullExpand un-minimizes and raises the target', () => {
    const a = mount();
    act(() => { a.api().openWindow('chat', { title: 'A1' }); });
    act(() => { a.api().openWindow('document', { title: 'A2' }); });
    const chatId = a.api().windows[0].id;
    // Minimize the chat, then enter full-expand focused on it.
    act(() => { a.api().minimizeWindow(chatId); });
    expect(a.api().windows[0].minimized).toBe(true);
    act(() => { a.api().enterFullExpand(chatId); });
    expect(a.api().viewMode).toBe('full');
    const chat = a.api().windows.find(w => w.id === chatId)!;
    expect(chat.minimized).toBe(false);
    // Raised above the other window.
    const other = a.api().windows.find(w => w.id !== chatId)!;
    expect(chat.zIndex).toBeGreaterThan(other.zIndex);
  });

  it('singleton window types reuse one instance instead of duplicating', () => {
    const a = mount();
    act(() => { a.api().openWindow('tasks', { title: 'Tasks' }); });
    act(() => { a.api().openWindow('tasks', { title: 'Tasks again' }); });
    const tasks = a.api().windows.filter(w => w.type === 'tasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].minimized).toBe(false);
  });

  it('collapses back to multi when the last visible window closes', () => {
    const a = mount();
    act(() => { a.api().openWindow('chat', { title: 'A1' }); });
    const id = a.api().windows[0].id;
    act(() => { a.api().enterFullExpand(id); });
    expect(a.api().viewMode).toBe('full');
    act(() => { a.api().closeWindow(id); });
    // Auto-reset effect: no visible window ⇒ full mode cannot persist.
    expect(a.api().viewMode).toBe('multi');
  });
});

describe('useWindows full-expand preference persistence', () => {
  afterEach(() => {
    try { window.localStorage.clear(); } catch { /* jsdom always has it */ }
  });

  it('persists the full-expand choice to localStorage on toggle', () => {
    const a = mount();
    act(() => { a.api().openWindow('chat', { title: 'A1' }); });
    const id = a.api().windows[0].id;
    act(() => { a.api().enterFullExpand(id); });
    expect(window.localStorage.getItem('agensis:viewMode')).toBe('full');
    act(() => { a.api().exitFullExpand(); });
    expect(window.localStorage.getItem('agensis:viewMode')).toBe('multi');
  });

  it('restores full-expand after a remount once a window becomes visible', () => {
    // First session: choose full-expand.
    const first = mount();
    act(() => { first.api().openWindow('chat', { title: 'A1' }); });
    act(() => { first.api().enterFullExpand(first.api().windows[0].id); });
    expect(first.api().viewMode).toBe('full');

    // Simulate a reload: a brand-new hook instance. Windows are in-memory so it
    // starts empty and in 'multi' (full needs a visible window)...
    const second = mount();
    expect(second.api().windows).toHaveLength(0);
    expect(second.api().viewMode).toBe('multi');

    // ...but opening a window restores the remembered full-expand mode.
    act(() => { second.api().openWindow('chat', { title: 'B1' }); });
    expect(second.api().viewMode).toBe('full');
  });

  it('does not restore full-expand after the user explicitly exited it', () => {
    const first = mount();
    act(() => { first.api().openWindow('chat', { title: 'A1' }); });
    act(() => { first.api().enterFullExpand(first.api().windows[0].id); });
    act(() => { first.api().exitFullExpand(); });

    const second = mount();
    act(() => { second.api().openWindow('chat', { title: 'B1' }); });
    expect(second.api().viewMode).toBe('multi');
  });
})
