import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PinnedWorkspaces, PIN_GRID_AT } from '../../src/components/layout/WorkspaceSwitcher';
import { resetTitlebarPinsCache, toggleTitlebarPin } from '../../src/lib/titlebarPins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); localStorage.clear(); resetTitlebarPinsCache(); });

const ws = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, name: `Space ${i}` }));
const render = (pins: string[], active = 'w0') => act(() => root.render(createElement(PinnedWorkspaces, { workspaces: ws(6), activeWorkspaceId: active, pins, onSelectWorkspace: () => {} })));

describe('pinned workspaces', () => {
  it('renders nothing with no pins', () => {
    render([]);
    expect(container.querySelector('[data-pinned-workspaces]')).toBeNull();
  });

  it('shows wide named buttons below the grid threshold', () => {
    render(['w0', 'w1', 'w2']);
    const group = container.querySelector('[data-pinned-workspaces]');
    expect(group?.getAttribute('data-pinned-workspaces')).toBe('wide');
    expect(group?.textContent).toContain('Space 1');
  });

  it(`switches to a tile grid at ${PIN_GRID_AT} pins and marks the active one`, () => {
    render(['w0', 'w1', 'w2', 'w3'], 'w2');
    const group = container.querySelector('[data-pinned-workspaces]');
    expect(group?.getAttribute('data-pinned-workspaces')).toBe('grid');
    expect(group?.textContent).not.toContain('Space 1');
    expect(container.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe('Space 2 workspace');
  });

  it('ignores a pin for a workspace that no longer exists', () => {
    render(['gone', 'w1']);
    expect(container.querySelectorAll('[data-pinned-workspace]')).toHaveLength(1);
  });
});

describe('title bar pins', () => {
  it('keeps menu order whatever order things were pinned in, and unpins', () => {
    toggleTitlebarPin('lock');
    toggleTitlebarPin('share');
    expect(JSON.parse(localStorage.getItem('agensis_titlebar_pins') || '[]')).toEqual(['share', 'lock']);
    toggleTitlebarPin('share');
    expect(JSON.parse(localStorage.getItem('agensis_titlebar_pins') || '[]')).toEqual(['lock']);
  });
});
