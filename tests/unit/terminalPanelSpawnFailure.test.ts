// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// xterm needs a real canvas/layout; the panel's contract under test is what it
// SAYS when the shell cannot start, not how it paints a running one.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() { }
    open() { }
    focus() { }
    write() { }
    dispose() { }
    onData() { return { dispose() { } }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { } } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { TerminalPanel } from '../../src/components/windows/TerminalPanel';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class { observe() { } unobserve() { } disconnect() { } } as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

function installBridge(spawn: () => Promise<unknown>) {
  (window as { electronAPI?: unknown }).electronAPI = {
    pty: {
      spawn,
      write: async () => { },
      resize: async () => { },
      kill: async () => { },
      onData: () => () => { },
      onExit: () => () => { },
    },
  };
}

describe('TerminalPanel when the shell cannot start', () => {
  // The desktop bug: node-pty's spawn-helper lost its exec bit, the main
  // process threw "posix_spawnp failed.", the IPC promise REJECTED, and the
  // panel — which only handled a resolved { ok: false } — stayed on
  // "starting" forever. A terminal that never loads and never says why.
  it('reports a thrown spawn error instead of hanging', async () => {
    installBridge(() => Promise.reject(new Error('posix_spawnp failed.')));
    await act(async () => { root.render(createElement(TerminalPanel)); });
    expect(container.textContent).toContain('Terminal unavailable');
    expect(container.textContent).toContain('posix_spawnp failed.');
  });

  it('still reports a resolved { ok: false } the way it always did', async () => {
    installBridge(() => Promise.resolve({ ok: false, error: 'node-pty is not installed for this build' }));
    await act(async () => { root.render(createElement(TerminalPanel)); });
    expect(container.textContent).toContain('node-pty is not installed for this build');
  });
});
