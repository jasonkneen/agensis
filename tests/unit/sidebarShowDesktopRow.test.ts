// The Show desktop row's PLACEMENT and its accessible state, which only a mount
// can show. `resolveShowDesktop` (showDesktop.test.ts) proves what a press does;
// this proves the control that fires it is where the ask put it — directly under
// Inbox, in both the expanded sidebar and the collapsed rail — and that it
// announces its toggle state rather than looking like another launcher.
//
// Written with createElement so it stays a .ts file inside the existing
// `tests/unit/**/*.test.ts` glob.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sidebar } from '../../src/components/layout/Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// A null workspace keeps every data hook in the sidebar on its early-out path,
// so the mount touches no backend — the rows themselves do not depend on data.
function baseProps() {
  return {
    workspace: null,
    collapsed: false,
    onToggleCollapse: () => {},
    onOpenCommandPalette: () => {},
    onNewChat: () => {},
    onNewDocument: () => {},
    onUploadFile: () => {},
    onCreateWorkspace: () => {},
    onDocumentOpen: () => {},
    onSessionOpen: () => {},
    onOpenMemory: () => {},
    onOpenInbox: () => {},
    recents: [],
    sessions: [],
    floatingWindows: [],
    themeMode: 'system' as const,
    onThemeChange: () => {},
    userEmail: 'someone@example.com',
    onSignOut: () => {},
    onOpenSettings: () => {},
  };
}

function mount(props: Record<string, unknown> = {}) {
  root = createRoot(container);
  act(() => {
    root.render(createElement(Sidebar, { ...baseProps(), ...props } as never));
  });
}

/** Every actionable control in the sidebar, in document order. */
function rows(): HTMLElement[] {
  return [...container.querySelectorAll('button')] as HTMLElement[];
}

function labelOf(el: HTMLElement): string {
  return (el.getAttribute('aria-label') || el.textContent || '').trim();
}

function findRow(label: string): HTMLElement | undefined {
  return rows().find(el => labelOf(el).startsWith(label));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Desktop row', () => {
  it('sits directly under Inbox in the expanded sidebar', () => {
    mount({ onShowDesktop: () => {} });
    const order = rows().map(labelOf);
    const inbox = order.findIndex(label => label === 'Inbox');
    expect(inbox).toBeGreaterThanOrEqual(0);
    expect(order[inbox + 1]).toBe('Desktop');
  });

  it('sits directly under Inbox in the collapsed rail too', () => {
    mount({ collapsed: true, onShowDesktop: () => {} });
    const order = rows().map(labelOf);
    const inbox = order.findIndex(label => label === 'Inbox');
    expect(inbox).toBeGreaterThanOrEqual(0);
    expect(order[inbox + 1]).toBe('Desktop');
  });

  it('is a keyboard-reachable button, not a div', () => {
    mount({ onShowDesktop: () => {} });
    const row = findRow('Desktop');
    expect(row?.tagName).toBe('BUTTON');
    expect(row?.getAttribute('type')).toBe('button');
    // No tabindex="-1" and not disabled: it is in the natural tab order.
    expect(row?.hasAttribute('disabled')).toBe(false);
    expect(row?.getAttribute('tabindex')).toBeNull();
  });

  it('reports its toggle state with aria-pressed', () => {
    mount({ onShowDesktop: () => {} });
    expect(findRow('Desktop')?.getAttribute('aria-pressed')).toBe('false');

    act(() => root.unmount());
    mount({ onShowDesktop: () => {}, showingDesktop: true });
    expect(findRow('Desktop')?.getAttribute('aria-pressed')).toBe('true');
    // And is visually marked with the same data-active hook every other
    // highlighted sidebar row uses, so themes need no new selector.
    expect(findRow('Desktop')?.getAttribute('data-active')).toBe('true');
  });

  it('leaves plain launchers without an aria-pressed state', () => {
    mount({ onShowDesktop: () => {} });
    expect(findRow('Inbox')?.hasAttribute('aria-pressed')).toBe(false);
  });

  it('fires its handler on click', () => {
    let presses = 0;
    mount({ onShowDesktop: () => { presses += 1; } });
    act(() => {
      findRow('Desktop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(presses).toBe(1);
  });

  it('is absent when the app does not pass a handler', () => {
    mount();
    expect(findRow('Desktop')).toBeUndefined();
  });
});
