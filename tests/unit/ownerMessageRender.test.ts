import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GetStartedPanel } from '../../src/components/onboarding/GetStartedPanel';
import { OwnerMessageBanner } from '../../src/components/onboarding/OwnerMessageBanner';
import { OwnerMessageDialog } from '../../src/components/onboarding/OwnerMessageDialog';
import { OwnerMessageContext } from '../../src/lib/ownerMessageContext';
import { PAGE_TIPS } from '../../src/lib/pageTips';
import type { OwnerMessage } from '../../src/lib/tenantCampaigns';
import type { ChatSession, WorkspaceAgent } from '../../src/types';

// Three claims about an owner broadcast that only a mount can settle:
//
//   1. IT ACTUALLY TAKES THE SPACE, over an unfinished checklist and over a tip.
//      That ordering is argued for in resolveGetStartedSlot; this is the proof
//      the component honours it.
//   2. DISMISSING IS A SERVER WRITE AND NOTHING ELSE. No localStorage key is
//      touched — which is the whole reason the dismissal holds on another
//      machine and is not shared with a second account in this browser.
//   3. THE BODY IS A TEXT NODE. Angle brackets in operator prose must render as
//      characters, not as markup, on every one of the three surfaces.

const DONE_AGENTS: WorkspaceAgent[] = [{ id: 'a1', handle: 'reviewer' } as WorkspaceAgent];
const DONE_SESSIONS: ChatSession[] = [
  { id: 's1', folder: 'Channels' } as ChatSession,
  { id: 's2', folder: 'Direct messages' } as ChatSession,
];

const MESSAGE: OwnerMessage = {
  id: 'campaign-1',
  title: 'Huddles are worth a try',
  body: 'Press the huddle button in any channel to talk to the agents in it.',
  surface: 'tip',
  created_at: '2026-07-27T12:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;
let dismiss: ReturnType<typeof vi.fn>;

/** Mount a subtree with a fixed owner message in context — no fetch involved. */
function mountWith(message: OwnerMessage | null, child: ReturnType<typeof createElement>) {
  root = createRoot(container);
  act(() => {
    root.render(createElement(
      OwnerMessageContext.Provider,
      {
        value: {
          forSurface: (surface) => (message && message.surface === surface ? message : null),
          dismiss,
        },
      },
      child,
    ));
  });
}

function panel(props: Partial<Parameters<typeof GetStartedPanel>[0]> = {}) {
  return createElement(GetStartedPanel, {
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
  dismiss = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  localStorage.clear();
});

describe('an owner message in the sidebar footer', () => {
  it('takes the space from a TIP, and says FOR YOU', () => {
    mountWith(MESSAGE, panel());
    expect(container.textContent).toContain('FOR YOU');
    expect(container.textContent).toContain(MESSAGE.title);
    expect(container.textContent).toContain(MESSAGE.body);
    // The tip that would otherwise be here is not.
    expect(container.textContent).not.toContain(PAGE_TIPS.find(t => t.surface === 'canvas')!.title);
    unmount();
  });

  it('takes the space from an UNFINISHED CHECKLIST too', () => {
    // The argued ordering: a broadcast segmented on "has no agents" is aimed at
    // exactly the accounts that still have a checklist, so ranking it below
    // would mean it never reaches them.
    mountWith(MESSAGE, panel({ agents: [], sessions: [], memberCount: 1 }));
    expect(container.textContent).toContain('FOR YOU');
    expect(container.textContent).not.toContain('Create your first agent');
    unmount();
  });

  it('gives the space back the moment there is no message', () => {
    mountWith(null, panel({ agents: [], sessions: [], memberCount: 1 }));
    expect(container.textContent).not.toContain('FOR YOU');
    expect(container.textContent).toContain('Create your first agent');
    unmount();
  });

  it('dismisses through the SERVER and writes no localStorage key', () => {
    mountWith(MESSAGE, panel());
    click('Dismiss this message');
    expect(dismiss).toHaveBeenCalledTimes(1);
    // Not a preference. A localStorage dismissal would be per-device and, worse,
    // scoped by workspace rather than by user — shared with anyone else signing
    // in on this browser.
    expect(Object.keys(localStorage)).toHaveLength(0);
    unmount();
  });

  it('collapsing hides the body but keeps the header, and does not dismiss', () => {
    mountWith(MESSAGE, panel());
    click('Collapse message');
    expect(container.textContent).toContain('FOR YOU');
    expect(container.textContent).not.toContain(MESSAGE.body);
    expect(dismiss).not.toHaveBeenCalled();
    unmount();
  });

  it('arrives collapsed if the user had collapsed a tip — and the expander recovers it', () => {
    // The one trap-shaped thing here: `tips.collapsed` is a STORED preference
    // shared with the tip card, so a user who collapsed a tip last week has an
    // owner message arrive already folded up. That is allowed only because it
    // announces itself and can be undone without knowing it happened — which is
    // what this asserts, rather than my believing it.
    localStorage.setItem('agensis.tips.collapsed:ws-1', '1');
    mountWith(MESSAGE, panel());
    expect(container.textContent).not.toContain(MESSAGE.body);
    // It is still visibly a message addressed to them, not an empty slot.
    expect(container.textContent).toContain('FOR YOU');
    const expander = container.querySelector('button[aria-label="Expand message"]');
    expect(expander).toBeTruthy();
    act(() => (expander as HTMLButtonElement).click());
    expect(container.textContent).toContain(MESSAGE.body);
    expect(dismiss).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the shared card frame, and adds only emphasis to it', () => {
    // Same space, same furniture: the rounded card, border, padding and shadow
    // are the tip card's; the accent border and ring are the difference.
    mountWith(MESSAGE, panel());
    const frame = container.firstElementChild?.className ?? '';
    unmount();

    mountWith(null, panel());
    const tipFrame = container.firstElementChild?.className ?? '';
    unmount();

    for (const shared of ['rounded-xl', 'bg-card', 'p-3', 'shadow-lg', 'w-full']) {
      expect(frame).toContain(shared);
      expect(tipFrame).toContain(shared);
    }
    expect(frame).toContain('border-primary/50');
    expect(tipFrame).not.toContain('border-primary/50');
  });

  it('renders the body as TEXT, so markup in operator prose is not markup', () => {
    const nasty: OwnerMessage = { ...MESSAGE, body: 'Use <b>bold</b> & <script>alert(1)</script> sparingly' };
    mountWith(nasty, panel());
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<b>bold</b>');
    unmount();
  });
});

describe('the dialog surface', () => {
  const DIALOG: OwnerMessage = { ...MESSAGE, surface: 'dialog' };

  /** Radix portals its content, so the assertions read document.body. */
  function dialogText() {
    return document.body.textContent ?? '';
  }

  it('renders nothing at all when the message is for another surface', () => {
    mountWith(MESSAGE, createElement(OwnerMessageDialog));
    expect(dialogText()).not.toContain(MESSAGE.title);
    unmount();
  });

  it('opens over the app and dismisses through the server', () => {
    mountWith(DIALOG, createElement(OwnerMessageDialog));
    expect(dialogText()).toContain(DIALOG.title);
    expect(dialogText()).toContain(DIALOG.body);
    const gotIt = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Got it');
    expect(gotIt).toBeTruthy();
    act(() => gotIt!.click());
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(Object.keys(localStorage)).toHaveLength(0);
    unmount();
  });

  it('renders the body as text and carries no link', () => {
    mountWith({ ...DIALOG, body: 'Read <b>this</b> at https://example.test' }, createElement(OwnerMessageDialog));
    expect(document.body.querySelector('a')).toBeNull();
    expect(document.body.querySelector('[role="dialog"] b')).toBeNull();
    expect(dialogText()).toContain('<b>this</b>');
    unmount();
  });
});

describe('the home-screen banner', () => {
  const BANNER: OwnerMessage = { ...MESSAGE, surface: 'banner' };

  it('renders nothing when there is no message for its surface', () => {
    mountWith(MESSAGE, createElement(OwnerMessageBanner));
    expect(container.textContent).toBe('');
    unmount();
  });

  it('renders the message and dismisses through the server', () => {
    mountWith(BANNER, createElement(OwnerMessageBanner));
    expect(container.textContent).toContain(BANNER.title);
    expect(container.textContent).toContain('FOR YOU');
    click('Dismiss this message');
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(Object.keys(localStorage)).toHaveLength(0);
    unmount();
  });

  it('carries no link, whatever the message says', () => {
    mountWith({ ...BANNER, body: 'Go to https://example.test now' }, createElement(OwnerMessageBanner));
    expect(container.querySelector('a')).toBeNull();
    unmount();
  });
});
