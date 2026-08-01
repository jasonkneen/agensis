// The Show desktop row's PLACEMENT and its accessible state, which only a mount
// can show. `resolveShowDesktop` (showDesktop.test.ts) proves what a press does;
// this proves the control that fires it is where the ask put it — directly under
// Inbox, in both the expanded sidebar and the collapsed rail — and that it
// announces its toggle state rather than looking like another launcher.
//
// Written with createElement so it stays a .ts file inside the existing
// `tests/unit/**/*.test.ts` glob.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  // Tasks and Memory moved up to join Inbox and Desktop in the fixed block
  // above the collapsible sections. Desktop is still directly under Inbox — the
  // two assertions above still describe the truth — but "directly under Inbox"
  // no longer pins the whole block, so the block itself is asserted here rather
  // than left to be reshuffled silently.
  it('leads a fixed top block of Inbox, Desktop, Tasks, Memory', () => {
    mount({ onShowDesktop: () => {}, onOpenTasks: () => {} });
    const order = rows().map(labelOf);
    const inbox = order.findIndex(label => label === 'Inbox');
    expect(order.slice(inbox, inbox + 4)).toEqual(['Inbox', 'Desktop', 'Tasks', 'Memory']);
  });

  it('uses that same block order in the collapsed rail', () => {
    mount({ collapsed: true, onShowDesktop: () => {}, onOpenTasks: () => {} });
    const order = rows().map(labelOf);
    const inbox = order.findIndex(label => label === 'Inbox');
    expect(order.slice(inbox, inbox + 4)).toEqual(['Inbox', 'Desktop', 'Tasks', 'Memory']);
  });

  // The block exists to sit ABOVE the sections; if a section ever renders
  // between Memory and Threads the divider is separating the wrong things.
  it('puts the whole block above the collapsible sections', () => {
    mount({ onShowDesktop: () => {}, onOpenTasks: () => {} });
    const order = rows().map(labelOf);
    const memory = order.findIndex(label => label === 'Memory');
    const threads = order.findIndex(label => label.startsWith('Threads'));
    expect(memory).toBeGreaterThanOrEqual(0);
    expect(threads).toBeGreaterThan(memory);
  });

  // The rules are decoration, not navigation: they must not turn up as rows.
  it('draws its dividers as non-interactive elements, not rows', () => {
    mount({ onShowDesktop: () => {}, onOpenTasks: () => {} });
    expect(container.querySelectorAll('.sidebar-group-divider')).toHaveLength(2);
    expect(container.querySelectorAll('button.sidebar-group-divider')).toHaveLength(0);
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

  it('exposes a working file upload action in expanded and collapsed sidebars', () => {
    const onUploadFile = vi.fn();
    mount({ onUploadFile });
    expect(findRow('Upload files')).toBeDefined();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.multiple).toBe(true);
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    act(() => input?.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onUploadFile).toHaveBeenCalledWith([file]);

    act(() => root.unmount());
    mount({ collapsed: true, onUploadFile });
    expect(findRow('Upload files')).toBeDefined();
  });
});
