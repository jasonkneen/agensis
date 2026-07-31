import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../src/components/layout/Sidebar';
import type { ChatSession } from '../../src/types';
import type { NostrConnection } from '../../src/lib/nostrCommunities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function session(id: string, title: string): ChatSession {
  return {
    id, workspace_id: 'workspace-1', title, model: 'default',
    created_at: '2026-07-31T00:00:00.000Z', updated_at: '2026-07-31T00:00:00.000Z',
  };
}

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
    recents: [],
    floatingWindows: [],
    themeMode: 'system' as const,
    onThemeChange: () => {},
    userEmail: 'someone@example.com',
    onSignOut: () => {},
    onOpenSettings: () => {},
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('imported community channels in the sidebar', () => {
  it('renders a community subgroup, source chip, paused state, and settings re-entry', () => {
    const manage = vi.fn();
    const local = session('local', 'Product');
    const imported = Array.from({ length: 9 }, (_, index) => session(`remote-${index}`, index === 0 ? 'agents' : `remote-${index}`));
    const connection: NostrConnection = {
      id: 'connection-1', workspaceId: 'workspace-1', relayHttpUrl: 'https://community.test',
      relayWsUrl: 'wss://community.test', communityId: 'community-1', host: 'community.test',
      name: 'Hermes Agents', description: '', relayPubkey: 'a'.repeat(64), memberPubkey: 'b'.repeat(64),
      policyVersion: '', status: 'connected', lastError: '',
      subscriptions: imported.map((item, index) => ({
        bridgeId: `bridge-${index}`, channelId: index === 0 ? 'agents' : `remote-${index}`, sessionId: item.id,
        enabled: index !== 0, status: index === 0 ? 'disconnected' : 'connected', lastError: '',
      })),
    };
    root = createRoot(container);
    act(() => {
      root.render(createElement(Sidebar, {
        ...baseProps(), sessions: [local, ...imported], nostrConnections: [connection],
        onManageNostrCommunity: manage,
      } as never));
    });

    const channels = container.querySelector<HTMLButtonElement>('[aria-controls="channels-content"]');
    act(() => channels?.click());
    expect(container.textContent).toContain('Product');
    expect(container.textContent).toContain('Hermes Agents');

    const settings = container.querySelector<HTMLButtonElement>('[aria-label="Manage Hermes Agents Nostr community"]');
    expect(settings).not.toBeNull();
    act(() => settings?.click());
    expect(manage).toHaveBeenCalledWith(connection);

    const group = container.querySelector<HTMLButtonElement>('[aria-controls="nostr-community:connection-1-content"]');
    act(() => group?.click());
    expect(container.querySelector('[data-testid="nostr-source-chip"]')?.textContent).toBe('Nostr');
    expect(container.querySelectorAll('[data-testid="nostr-source-chip"]')).toHaveLength(9);
    expect(container.querySelector('[data-testid="nostr-subscription-state"]')?.textContent).toBe('Paused');
  });
});
