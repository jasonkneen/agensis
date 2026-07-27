import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GetStartedPanel } from '../../src/components/onboarding/GetStartedPanel';
import { PAGE_TIPS } from '../../src/lib/pageTips';
import type { ChatSession, WorkspaceAgent } from '../../src/types';

// Two things about the shared sidebar-footer space that only a mount can show:
//
//   1. it really does hand the space over — the checklist while setup is
//      outstanding, a tip about the focused surface afterwards, in ONE slot;
//   2. a dismissed tip stays dismissed across a remount and is stored under a
//      workspace-scoped key, so it cannot leak to another account sharing the
//      browser. That is a claim about storage, and storage is exactly the part
//      a typecheck cannot see.
//
// The frame assertion at the end is the "this is the same space, not a new
// widget" rule: both cards must carry an identical outer className.

const DONE_AGENTS: WorkspaceAgent[] = [{ id: 'a1', handle: 'reviewer' } as WorkspaceAgent];
const DONE_SESSIONS: ChatSession[] = [
  { id: 's1', folder: 'Channels' } as ChatSession,
  { id: 's2', folder: 'Direct messages' } as ChatSession,
];

let container: HTMLDivElement;
let root: Root;

function mount(props: Partial<Parameters<typeof GetStartedPanel>[0]> = {}) {
  root = createRoot(container);
  act(() => {
    root.render(createElement(GetStartedPanel, {
      workspaceId: 'ws-1',
      agents: DONE_AGENTS,
      sessions: DONE_SESSIONS,
      memberCount: 2,
      surface: 'canvas',
      onCreateAgent: () => {},
      onStartRoom: () => {},
      onMessageAgent: () => {},
      onInvite: () => {},
      ...props,
    }));
  });
}

function unmount() {
  act(() => root.unmount());
}

function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no button labelled "${label}"`);
  act(() => button.click());
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  localStorage.clear();
});

describe('GetStartedPanel', () => {
  it('shows the checklist while setup is outstanding, not a tip', () => {
    mount({ agents: [], sessions: [], memberCount: 1 });
    expect(container.textContent).toContain('Get started');
    expect(container.textContent).toContain('Create your first agent');
    expect(container.textContent).not.toContain('Tip');
    unmount();
  });

  it('shows a tip about the focused surface once setup is done', () => {
    mount({ surface: 'agents' });
    const first = PAGE_TIPS.find(t => t.surface === 'agents')!;
    expect(container.textContent).toContain('Tip');
    expect(container.textContent).toContain('Agents');
    expect(container.textContent).toContain(first.title);
    unmount();
  });

  it('changes tip when the focused surface changes', () => {
    mount({ surface: 'inbox' });
    expect(container.textContent).toContain(PAGE_TIPS.find(t => t.surface === 'inbox')!.title);
    act(() => {
      root.render(createElement(GetStartedPanel, {
        workspaceId: 'ws-1',
        agents: DONE_AGENTS,
        sessions: DONE_SESSIONS,
        memberCount: 2,
        surface: 'tasks',
        onCreateAgent: () => {},
        onStartRoom: () => {},
        onMessageAgent: () => {},
        onInvite: () => {},
      }));
    });
    expect(container.textContent).toContain(PAGE_TIPS.find(t => t.surface === 'tasks')!.title);
    unmount();
  });

  it('dismissing a tip reveals the next one and survives a remount', () => {
    const tips = PAGE_TIPS.filter(t => t.surface === 'canvas');
    mount();
    expect(container.textContent).toContain(tips[0].title);

    click('Dismiss this tip');
    expect(container.textContent).not.toContain(tips[0].title);
    expect(container.textContent).toContain(tips[1].title);
    unmount();

    // The dismissal is stored under a WORKSPACE-scoped key, so another account
    // in the same browser reads a different bucket entirely.
    expect(localStorage.getItem('agensis.tips.dismissed:ws-1')).toContain(tips[0].id);

    mount();
    expect(container.textContent).not.toContain(tips[0].title);
    expect(container.textContent).toContain(tips[1].title);
    unmount();
  });

  it('does not carry a dismissal into another workspace', () => {
    const tips = PAGE_TIPS.filter(t => t.surface === 'canvas');
    mount();
    click('Dismiss this tip');
    unmount();

    mount({ workspaceId: 'ws-2' });
    expect(container.textContent).toContain(tips[0].title);
    unmount();
  });

  it('collapses to just the header, and remembers it', () => {
    const tip = PAGE_TIPS.find(t => t.surface === 'canvas')!;
    mount();
    click('Collapse tips');
    expect(container.textContent).toContain('Tip');
    expect(container.textContent).not.toContain(tip.body);
    unmount();

    mount();
    expect(container.textContent).not.toContain(tip.body);
    unmount();
  });

  it('hands the space to tips when the checklist is dismissed with steps left', () => {
    mount({ agents: [], sessions: [], memberCount: 1 });
    click('Dismiss checklist');
    expect(container.textContent).not.toContain('Get started');
    expect(container.textContent).toContain('Tip');
    unmount();
  });

  it('keeps the checklist on its long-standing storage keys', () => {
    mount({ agents: [], sessions: [], memberCount: 1 });
    click('Dismiss checklist');
    unmount();
    // scripts/reset-test-account.cjs tells people to clear exactly these.
    expect(localStorage.getItem('agensis_getstarted_dismissed')).toBe('1');
  });

  it('gives the tip card the same frame as the checklist', () => {
    mount({ agents: [], sessions: [], memberCount: 1 });
    const checklistFrame = container.firstElementChild?.className;
    unmount();

    localStorage.clear();
    mount();
    const tipFrame = container.firstElementChild?.className;
    expect(tipFrame).toBe(checklistFrame);
    unmount();
  });
});
