import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersWindow } from '../../src/components/windows/UsersWindow';
import { UsersWindowContent } from '../../src/components/windows/UsersWindowContent';
import type {
  CreatedWorkspaceJoinLink,
  CreateWorkspaceJoinLinkInput,
  WorkspaceJoinLink,
  WorkspaceMember,
} from '../../src/features/workspace-connections';

const NOW = Date.now();
const YESTERDAY = new Date(NOW - 86_400_000).toISOString();
const IN_TEN_MINUTES = new Date(NOW + 10 * 60_000).toISOString();

function makeMember(overrides: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    id: 'member-1',
    user_id: 'u-member',
    email: 'member@example.test',
    role: 'editor',
    invited_by: 'u-owner',
    created_at: YESTERDAY,
    ...overrides,
  };
}

function makeJoinLink(overrides: Partial<WorkspaceJoinLink> = {}): WorkspaceJoinLink {
  return {
    id: 'join-1',
    workspace_id: 'ws-1',
    label: 'Build agent',
    role: 'editor',
    audience: 'both',
    status: 'pending',
    redeemed_as: null,
    redeemed_by: null,
    redeemed_agent_id: null,
    redeemed_at: null,
    expires_at: IN_TEN_MINUTES,
    created_by: 'u-owner',
    created_by_email: 'owner@example.test',
    created_at: YESTERDAY,
    ...overrides,
  };
}

function makeCreatedJoinLink(overrides: Partial<CreatedWorkspaceJoinLink> = {}): CreatedWorkspaceJoinLink {
  return {
    ...makeJoinLink(),
    url: 'https://agensis.io/join/agj_once',
    expiresInMs: 15 * 60_000,
    singleUse: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let originalFetch: typeof globalThis.fetch;
let originalClipboard: PropertyDescriptor | undefined;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  vi.restoreAllMocks();
});

function renderContent(options: {
  members?: WorkspaceMember[];
  joinLinks?: WorkspaceJoinLink[];
  canManage?: boolean;
  onCreateJoinLink?: (input: CreateWorkspaceJoinLinkInput) => Promise<CreatedWorkspaceJoinLink>;
  onRevokeJoinLink?: (linkId: string) => Promise<void>;
} = {}) {
  const members = options.members ?? [
    makeMember({ id: null, user_id: 'u-owner', email: 'owner@example.test', role: 'owner' }),
    makeMember(),
  ];
  act(() => {
    root.render(createElement(UsersWindowContent, {
      workspaceName: 'Test workspace',
      currentUserId: 'u-owner',
      currentUserEmail: 'owner@example.test',
      members,
      joinLinks: options.joinLinks ?? [],
      canManage: options.canManage ?? true,
      onCreateJoinLink: options.onCreateJoinLink ?? (async () => makeCreatedJoinLink()),
      onRevokeJoinLink: options.onRevokeJoinLink ?? (async () => undefined),
      onRemoveMember: async () => undefined,
      onChangeMemberRole: async () => undefined,
    }));
  });
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find(button => (button.textContent || '').includes(text));
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find(button => button.getAttribute('aria-label') === label);
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function flushEffects() {
  await act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

describe('unified workspace join links', () => {
  it('creates one audience-aware link and copies the exact one-time URL', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const create = vi.fn(async () => makeCreatedJoinLink());
    renderContent({ onCreateJoinLink: create });

    expect(container.textContent).toContain('One URL works for people and agents');
    expect(container.textContent).toContain('expires after 15 minutes');
    expect(container.textContent).toContain('used once');

    act(() => {
      setSelectValue(container.querySelector('#join-audience') as HTMLSelectElement, 'agent');
      setSelectValue(container.querySelector('#join-role') as HTMLSelectElement, 'viewer');
      setInputValue(container.querySelector('#join-label') as HTMLInputElement, ' Remote code handler ');
    });
    await click(buttonByText('Create & copy link')!);

    expect(create).toHaveBeenCalledWith({
      audience: 'agent',
      role: 'viewer',
      label: 'Remote code handler',
    });
    expect(writeText).toHaveBeenCalledWith('https://agensis.io/join/agj_once');
    expect(container.textContent).toContain('Link copied');
  });

  it('derives expired/redeemed states, shows the redemption lane, and only revokes a live link', async () => {
    const revoke = vi.fn(async () => undefined);
    renderContent({
      onRevokeJoinLink: revoke,
      joinLinks: [
        makeJoinLink({ id: 'live', label: 'Live connection' }),
        makeJoinLink({ id: 'expired', label: 'Expired connection', expires_at: YESTERDAY }),
        makeJoinLink({
          id: 'redeemed',
          label: 'Agent connection',
          status: 'redeemed',
          audience: 'agent',
          redeemed_as: 'agent',
          redeemed_agent_id: 'agent-1',
          redeemed_at: YESTERDAY,
        }),
        makeJoinLink({ id: 'revoked', label: 'Revoked connection', status: 'revoked' }),
      ],
    });

    expect(container.textContent).toContain('expired');
    expect(container.textContent).toContain('redeemed as agent');
    expect(container.textContent).toContain('revoked');
    expect(buttonByLabel('Revoke join link Live connection')).toBeDefined();
    expect(buttonByLabel('Revoke join link Expired connection')).toBeUndefined();
    expect(buttonByLabel('Revoke join link Agent connection')).toBeUndefined();

    await click(buttonByLabel('Revoke join link Live connection')!);
    expect(revoke).toHaveBeenCalledWith('live');
  });

  it('keeps a non-manager read-only and removes all join/member management controls', () => {
    renderContent({
      canManage: false,
      members: [
        makeMember({ id: 'me', user_id: 'u-owner', email: 'reader@example.test', role: 'editor' }),
        makeMember(),
      ],
    });

    expect(container.textContent).toContain('Join links are private to workspace owners and admins');
    expect(buttonByText('Create & copy link')).toBeUndefined();
    expect(buttonByLabel('Remove member@example.test')).toBeUndefined();
    expect(container.querySelector('[aria-label="Change role for member@example.test"]')).toBeNull();
  });

  it('does not call either join-links or the legacy invites endpoint for a non-manager', async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/members')) {
        return jsonResponse([
          makeMember({ id: 'me', user_id: 'u-reader', email: 'reader@example.test', role: 'editor' }),
        ]);
      }
      return jsonResponse([]);
    }) as typeof fetch;

    act(() => {
      root.render(createElement(UsersWindow, {
        workspaceId: 'ws-reader',
        workspaceName: 'Read only',
        currentUserId: 'u-reader',
        currentUserEmail: 'reader@example.test',
      }));
    });
    await flushEffects();
    await flushEffects();

    expect(requests.some(url => url.includes('/members'))).toBe(true);
    expect(requests.some(url => url.includes('/join-links'))).toBe(false);
    expect(requests.some(url => /\/invites(?:\/|$|\?)/.test(url))).toBe(false);
  });

  it('loads join links after the member list proves the user is an owner', async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/members')) {
        return jsonResponse([
          makeMember({ id: null, user_id: 'u-owner', email: 'owner@example.test', role: 'owner' }),
        ]);
      }
      return jsonResponse([]);
    }) as typeof fetch;

    act(() => {
      root.render(createElement(UsersWindow, {
        workspaceId: 'ws-owner',
        workspaceName: 'Managed',
        currentUserId: 'u-owner',
        currentUserEmail: 'owner@example.test',
      }));
    });
    await flushEffects();
    await flushEffects();

    expect(requests.some(url => url.includes('/join-links'))).toBe(true);
    expect(requests.some(url => /\/invites(?:\/|$|\?)/.test(url))).toBe(false);
  });
});

function jsonResponse<T>(data: T): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, error: null }),
  } as Response;
}
