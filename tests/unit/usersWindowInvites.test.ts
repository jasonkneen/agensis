import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UsersWindowContent } from '../../src/components/windows/UsersWindowContent';
import type { WorkspaceInvite } from '../../src/hooks/useWorkspaceUsers';

// inviteDismissal.test.ts proves the rule. This file proves the LIST OBEYS it —
// that the Dismiss button is genuinely absent next to a live link rather than
// merely computed-absent, and that a dismissed row is reachable again through
// the toggle. Those are the two things a human would check by eye, and neither
// is visible from the pure function alone.

const NOW = Date.now();
const YESTERDAY = new Date(NOW - 86_400_000).toISOString();
const NEXT_WEEK = new Date(NOW + 7 * 86_400_000).toISOString();

function makeInvite(o: Partial<WorkspaceInvite> & { id: string }): WorkspaceInvite {
  return {
    workspace_id: 'ws-1',
    token: '',
    email: '',
    role: 'editor',
    status: 'pending',
    created_by_email: 'owner@example.com',
    accepted_by_email: null,
    accepted_at: null,
    expires_at: NEXT_WEEK,
    dismissed_at: null,
    created_at: YESTERDAY,
    ...o,
  };
}

const INVITES: WorkspaceInvite[] = [
  makeInvite({ id: 'live', email: 'live@example.com' }),
  makeInvite({ id: 'revoked', email: 'revoked@example.com', status: 'revoked' }),
  makeInvite({
    id: 'accepted',
    email: 'accepted@example.com',
    status: 'accepted',
    accepted_by_email: 'joined@example.com',
    accepted_at: YESTERDAY,
  }),
  makeInvite({ id: 'expired', email: 'expired@example.com', expires_at: YESTERDAY }),
  makeInvite({ id: 'tidied', email: 'tidied@example.com', status: 'revoked', dismissed_at: YESTERDAY }),
];

let container: HTMLDivElement;
let root: Root;
let calls: Array<{ id: string; dismissed: boolean }>;
let bulkCalls: number;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function render(invites: WorkspaceInvite[]) {
  act(() => {
    root.render(createElement(UsersWindowContent, {
      workspaceName: 'Test workspace',
      currentUserId: 'u1',
      currentUserEmail: 'owner@example.com',
      inviteOrigin: 'https://agensis.io',
      members: [],
      invites,
      onCreateInvite: async () => null,
      onRevokeInvite: async () => { },
      onSetInviteDismissed: async (id: string, dismissed: boolean) => { calls.push({ id, dismissed }); },
      onDismissSpentInvites: async () => { bulkCalls += 1; },
      onRemoveMember: async () => { },
      onChangeMemberRole: async () => { },
    } as never));
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return buttons().find(b => b.getAttribute('aria-label') === label);
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return buttons().find(b => (b.textContent || '').includes(text));
}

function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  calls = [];
  bulkCalls = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('invite links list', () => {
  it('offers no Dismiss on a live link — only Revoke', () => {
    render(INVITES);
    expect(buttonByLabel('Dismiss invite for live@example.com')).toBeUndefined();
    expect(buttonByLabel('Revoke invite for live@example.com')).toBeDefined();
  });

  it('offers Dismiss on every spent link', () => {
    render(INVITES);
    for (const email of ['revoked@example.com', 'accepted@example.com', 'expired@example.com']) {
      expect(buttonByLabel(`Dismiss invite for ${email}`)).toBeDefined();
    }
  });

  it('hides a dismissed row until the toggle is used, then offers Restore', () => {
    render(INVITES);
    expect(container.textContent).not.toContain('tidied@example.com');

    const toggle = buttonByText('Show dismissed (1)');
    expect(toggle).toBeDefined();
    click(toggle!);

    expect(container.textContent).toContain('tidied@example.com');
    const restore = buttonByLabel('Restore invite for tidied@example.com');
    expect(restore).toBeDefined();
    click(restore!);
    expect(calls).toEqual([{ id: 'tidied', dismissed: false }]);
  });

  it('keeps the live link visible in both modes', () => {
    render(INVITES);
    expect(container.textContent).toContain('live@example.com');
    click(buttonByText('Show dismissed (1)')!);
    expect(container.textContent).toContain('live@example.com');
  });

  it('sends a dismiss for the clicked row only', () => {
    render(INVITES);
    click(buttonByLabel('Dismiss invite for revoked@example.com')!);
    expect(calls).toEqual([{ id: 'revoked', dismissed: true }]);
  });

  it('labels an expired link expired, not pending', () => {
    render([makeInvite({ id: 'expired', email: 'expired@example.com', expires_at: YESTERDAY })]);
    expect(container.textContent).toContain('expired');
    expect(container.textContent).not.toContain('pending');
  });

  it('counts only the spent links on the bulk clear, and confirms before running it', () => {
    render(INVITES);
    // live is excluded; tidied is already dismissed. 3 remain.
    const clear = buttonByText('Clear spent (3)');
    expect(clear).toBeDefined();

    click(clear!);
    expect(bulkCalls).toBe(0);
    expect(buttonByText('Clear 3?')).toBeDefined();

    click(buttonByText('Clear 3?')!);
    expect(bulkCalls).toBe(1);
  });

  it('shows no bulk clear when every link is still live', () => {
    render([makeInvite({ id: 'live', email: 'live@example.com' })]);
    expect(buttonByText('Clear spent')).toBeUndefined();
    expect(buttonByText('Show dismissed')).toBeUndefined();
  });
});
