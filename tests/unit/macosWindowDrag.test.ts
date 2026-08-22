// The macOS window has to be movable.
//
// `titleBarStyle: 'hiddenInset'` (electron/main.cjs) removes the system title
// bar, which means the window can be dragged ONLY from an element the renderer
// marks with `-webkit-app-region: drag`. The chrome columns already reserve
// DESKTOP_TITLEBAR_INSET px of clear space at the top for the traffic lights,
// so the space looked right while carrying no drag region at all — and the
// window could not be moved from anywhere on screen. Nothing caught it: the
// reserved band renders identically either way, and every other check is blind
// to a CSS property only Chromium acts on.
//
// So this pins the property itself, on both columns that reserve the band, and
// pins that a browser tab (titlebarInset 0, the web app) gets no drag region —
// a stray one there would make part of the page undraggable-but-inert.
//
// Written with createElement so it stays a .ts file inside the existing
// `tests/unit/**/*.test.ts` glob.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sidebar } from '../../src/components/layout/Sidebar';
import { WorkspaceRail } from '../../src/components/layout/WorkspaceRail';
import { TooltipProvider } from '../../src/components/ui/tooltip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What App passes on desktop; see DESKTOP_TITLEBAR_INSET in src/App.tsx. */
const DESKTOP_TITLEBAR_INSET = 52;

let container: HTMLDivElement;
let root: Root;

// A null workspace keeps every data hook in the sidebar on its early-out path,
// so the mount touches no backend — the band does not depend on data.
function sidebarProps() {
  return {
    workspace: null,
    collapsed: true,
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

function railProps() {
  return {
    workspaces: [],
    activeWorkspaceId: '',
    onSelectWorkspace: () => {},
    onCreateWorkspace: () => {},
  };
}

// The rail's tiles use Tooltip, which throws outside a provider; App renders one
// far above both columns.
function mount(component: unknown, props: Record<string, unknown>) {
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(TooltipProvider, null, createElement(component as never, props as never)),
    );
  });
}

function dragRegions(): HTMLElement[] {
  return [...container.querySelectorAll('[data-titlebar-drag]')] as HTMLElement[];
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove();
});

describe('macOS titlebar drag band', () => {
  // The property itself is asserted against the stylesheet rather than the
  // mounted node: jsdom does not model -webkit-app-region, so it drops the
  // declaration on the way in and a DOM assertion would pass on an empty rule.
  it('defines the drag property in the stylesheet', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(/\.titlebar-drag-region\s*\{[^}]*-webkit-app-region:\s*drag/);
  });

  it('gives the workspace rail a drag region across the reserved band', () => {
    mount(WorkspaceRail, { ...railProps(), titlebarInset: DESKTOP_TITLEBAR_INSET });

    const [band] = dragRegions();
    expect(band).toBeDefined();
    expect(band.classList.contains('titlebar-drag-region')).toBe(true);
    expect(band.getAttribute('style')).toMatch(new RegExp(`height:\\s*${DESKTOP_TITLEBAR_INSET}px`));
  });

  it('gives the collapsed sidebar the same drag region', () => {
    mount(Sidebar, { ...sidebarProps(), titlebarInset: DESKTOP_TITLEBAR_INSET });

    const [band] = dragRegions();
    expect(band).toBeDefined();
    expect(band.classList.contains('titlebar-drag-region')).toBe(true);
  });

  it('covers no control — the band is behind the rows, not over them', () => {
    mount(WorkspaceRail, { ...railProps(), titlebarInset: DESKTOP_TITLEBAR_INSET });

    const band = dragRegions()[0];
    for (const button of container.querySelectorAll('button')) {
      expect(band.contains(button)).toBe(false);
    }
  });

  it('adds no drag region in a browser tab, where titlebarInset is 0', () => {
    mount(WorkspaceRail, railProps());
    expect(dragRegions()).toHaveLength(0);
  });

  it('adds no drag region to the sidebar in a browser tab', () => {
    mount(Sidebar, sidebarProps());
    expect(dragRegions()).toHaveLength(0);
  });
});
