import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME_DEPTH, CHROME_DEPTH_ORDER, type ChromeDepthLevel } from '../../src/lib/chromeDepth';

// The chrome's z-index ladder is spelled twice — once as TypeScript, once as
// `--z-*` custom properties in index.css — because CSS cannot import a TS
// constant and Tailwind's `z-[...]` cannot take one either. Two copies of a
// number is exactly the arrangement that drifts, and z-index drift is the
// invisible kind: nothing throws, a dropdown just quietly opens behind a panel.
// So the copies are asserted equal here.

// `process.cwd()` is the repo root under both vitest and `npm run test:unit`;
// `import.meta.url` is not a file: URL once vitest has transformed this module.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** `--z-workspace-rail` for `workspaceRail`, `--z-modal` for `modal`, and so on. */
function cssVarName(level: ChromeDepthLevel): string {
  return `--z-${level.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
}

function declaredInCss(name: string): number | null {
  const match = css.match(new RegExp(`${name}\\s*:\\s*(-?\\d+)\\s*;`));
  return match ? Number(match[1]) : null;
}

describe('chrome depth ladder', () => {
  it('paints in the order the ladder claims', () => {
    const values = CHROME_DEPTH_ORDER.map(level => CHROME_DEPTH[level]);
    for (let i = 1; i < values.length; i++) {
      expect(
        values[i],
        `${CHROME_DEPTH_ORDER[i]} must sit at or above ${CHROME_DEPTH_ORDER[i - 1]}`,
      ).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it('lists every rung exactly once', () => {
    expect([...CHROME_DEPTH_ORDER].sort()).toEqual(Object.keys(CHROME_DEPTH).sort());
  });

  it('matches the --z-* mirror in index.css, rung for rung', () => {
    for (const level of CHROME_DEPTH_ORDER) {
      const name = cssVarName(level);
      expect(declaredInCss(name), `${name} is missing from index.css`).not.toBeNull();
      expect(declaredInCss(name), `${name} disagrees with CHROME_DEPTH.${level}`).toBe(CHROME_DEPTH[level]);
    }
  });
});

describe('the three shell columns', () => {
  // The hierarchy the owner asked for, in the order he described it: the
  // workspace rail on top casting onto the sidebar, the canvas column above the
  // sidebar too, and the sidebar underneath both.
  it('puts the workspace rail above the sidebar', () => {
    expect(CHROME_DEPTH.workspaceRail).toBeGreaterThan(CHROME_DEPTH.sidebar);
  });

  it('puts the canvas column above the sidebar', () => {
    expect(CHROME_DEPTH.content).toBeGreaterThan(CHROME_DEPTH.sidebar);
  });

  it('makes the sidebar the lowest of the three', () => {
    expect(CHROME_DEPTH.sidebar).toBeLessThan(CHROME_DEPTH.content);
    expect(CHROME_DEPTH.sidebar).toBeLessThan(CHROME_DEPTH.workspaceRail);
    expect(CHROME_DEPTH.sidebar).toBeGreaterThan(CHROME_DEPTH.backdrop);
  });

  it('keeps the collapsed sidebar rail above the canvas so its flyout labels land on top', () => {
    expect(CHROME_DEPTH.sidebarFlyout).toBeGreaterThan(CHROME_DEPTH.content);
    expect(CHROME_DEPTH.sidebarFlyout).toBeLessThan(CHROME_DEPTH.workspaceRail);
  });
});

describe('headroom above the chrome', () => {
  // Radix portals to the body at Tailwind's z-50 — tooltips, popovers, selects,
  // hover cards. Nothing painted in the chrome may reach that number, or menus
  // start opening behind the panels that triggered them. This is the assertion
  // that makes raising a chrome rung a test failure instead of a bug report.
  const TAILWIND_Z_50 = 50;

  it('reserves z-50 for Radix portals', () => {
    expect(CHROME_DEPTH.overlay).toBe(TAILWIND_Z_50);
  });

  it('keeps every shell column below it', () => {
    for (const level of ['backdrop', 'sidebar', 'content', 'sidebarFlyout', 'workspaceRail'] as const) {
      expect(CHROME_DEPTH[level], `${level} would cover a tooltip`).toBeLessThan(TAILWIND_Z_50);
    }
  });

  it('keeps menus above modals, and a modal opened from a menu above both', () => {
    expect(CHROME_DEPTH.modal).toBeGreaterThan(CHROME_DEPTH.modalScrim);
    expect(CHROME_DEPTH.contextMenu).toBeGreaterThan(CHROME_DEPTH.modal);
    expect(CHROME_DEPTH.menu).toBeGreaterThan(CHROME_DEPTH.contextMenu);
    expect(CHROME_DEPTH.nestedModal).toBeGreaterThan(CHROME_DEPTH.menu);
  });

  it('keeps the phone drawer above its own scrim and the window dock', () => {
    expect(CHROME_DEPTH.drawer).toBeGreaterThan(CHROME_DEPTH.drawerScrim);
    expect(CHROME_DEPTH.drawerScrim).toBeGreaterThan(CHROME_DEPTH.appDock);
  });
});
