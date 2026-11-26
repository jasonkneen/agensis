import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkspaceSwitcher } from '../../src/components/layout/WorkspaceSwitcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The rail's loading states moved to the switcher that replaced it: the
// workspace control must never be an unlabeled blank while workspaces settle.
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });

function mount(props: Partial<ComponentProps<typeof WorkspaceSwitcher>>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(WorkspaceSwitcher, {
    workspaces: [], activeWorkspaceId: null, onSelectWorkspace: () => {},
    desktops: [], activeDesktopId: null, pins: [], onTogglePin: () => {},
    ...props,
  })));
  return container;
}

describe('workspace switcher loading states', () => {
  it('says it is loading, busy, while workspaces settle', () => {
    const el = mount({ loading: true });
    const status = el.querySelector('[data-workspace-switcher-status]');
    expect(status?.getAttribute('aria-busy')).toBe('true');
    expect(status?.textContent).toContain('Loading workspaces…');
  });

  it('shows the reason and a Retry when workspaces could not load', () => {
    let retried = 0;
    const el = mount({ loadError: 'Connection lost', onRetry: () => { retried += 1; } });
    expect(el.textContent).toContain('Connection lost');
    const retry = [...el.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    act(() => retry?.click());
    expect(retried).toBe(1);
  });

  it('feeds every pre-ready readiness state to the switcher as loading', () => {
    // 'pending' is the pre-session state: no user id yet, so no fetch has been
    // attempted. It must read as loading — it used to fall through to the
    // 'unavailable' branch and paint a connection error over a healthy account
    // on cold load.
    expect(appSource).toContain("workspaceReadiness.status === 'pending'");
    expect(appSource).toContain("workspaceReadiness.status === 'missing'");
    expect(appSource).toContain("workspaceReadiness.status === 'preparing'");
    expect(appSource).toContain("loadError={workspaceReadiness.status === 'unavailable'");
  });
});
