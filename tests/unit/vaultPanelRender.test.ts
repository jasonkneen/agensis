import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VaultSections } from '../../src/components/settings/SettingsDialog';
import type { VaultEntry } from '../../src/hooks/useWorkspaceVault';

// What only a mount can settle about the vault surface:
//
//   1. NO VALUE REACHES THE DOM. The panel is fed entries that carry no value —
//      because the route cannot return one — and the rendered text is checked for
//      any part of a plausible secret anyway. A masked preview used to live here.
//   2. A PROVIDER SLOT IS WRITABLE EVEN WHEN UNSET. That is the whole fix — before
//      it, a Box key had nowhere to be typed.
//   3. NAMESPACED ENTRIES SIT UNDER THEIR OWNER, not loose in a list.

const WS = 'ws-1';
const NEVER_RENDERED = 'box_live_ThisMustNeverAppear';

function entry(over: Partial<VaultEntry> & { key: string }): VaultEntry {
  return {
    group: 'shared',
    lane: 'shared',
    owner: '',
    ownerLabel: '',
    label: over.key,
    provider: '',
    credential: '',
    description: '',
    configured: true,
    updated_at: '2026-07-20T10:00:00.000Z',
    ...over,
  };
}

const ENTRIES: VaultEntry[] = [
  entry({
    key: 'sandbox:box:api_key',
    group: 'provider',
    lane: 'provider',
    owner: 'box',
    ownerLabel: 'Box sandboxes',
    label: 'API key',
    provider: 'box',
    credential: 'api_key',
    configured: false,
    updated_at: null,
    env: 'BOX_API_KEY',
  }),
  entry({ key: 'STRIPE_TOKEN', label: 'STRIPE_TOKEN', description: 'billing' }),
];

let container: HTMLDivElement;
let root: Root;

// React's onChange is wired to the native `input` event and reads the value off
// the node, so the value has to go through the prototype setter React patched.
async function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount() {
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(VaultSections, { workspaceId: WS }));
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    async json() { return { data: ENTRIES, error: null }; },
  })));
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('the vault panel', () => {
  it('groups entries under the provider that owns them', async () => {
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('Provider credentials');
    expect(text).toContain('Box sandboxes');
    expect(text).toContain('API key');
    expect(text).toContain('Shared secrets');
    // The raw key is shown as the technical identifier under the friendly label,
    // so an operator can match it to what an agent quotes when it is missing.
    expect(text).toContain('sandbox:box:api_key');
  });

  it('shows state instead of a value, and never renders a preview', async () => {
    await mount();
    const text = container.textContent ?? '';
    const setDate = new Date('2026-07-20T10:00:00.000Z')
      .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    expect(text).toContain('Not set');
    expect(text).toContain(`Set ${setDate}`);
    expect(text).not.toContain(NEVER_RENDERED);
    expect(text).not.toContain('•••');
    expect(text).not.toContain('…');
    // No reveal affordance can exist for something the server will not return.
    expect(container.querySelectorAll('[aria-label*="Show"]')).toHaveLength(0);
    // Every value input is a password field — nothing typed is echoed on screen.
    for (const input of container.querySelectorAll('input[placeholder*="Paste"], input[placeholder="value"]')) {
      expect(input.getAttribute('type')).toBe('password');
    }
  });

  it('offers a write on an unset provider slot', async () => {
    await mount();
    const rows = [...container.querySelectorAll('div.rounded-md.border')];

    const providerRow = rows.find(row => row.textContent?.includes('sandbox:box:api_key'));
    expect(providerRow).toBeTruthy();
    // Unset, and still writable — the entry Box's key had nowhere to go before.
    expect(providerRow!.querySelector('input')).toBeTruthy();
    expect(providerRow!.textContent).toContain('Save');
    // Nothing to delete yet.
    expect(providerRow!.querySelector('[aria-label^="Delete"]')).toBeNull();
    expect(providerRow!.textContent).toContain('BOX_API_KEY');

    const sharedRow = rows.find(row => row.textContent?.includes('STRIPE_TOKEN'));
    expect(sharedRow!.textContent).toContain('Replace');
    expect(sharedRow!.querySelector('[aria-label^="Delete"]')).toBeTruthy();
  });

  it('writes a provider credential through the route that can address it', async () => {
    await mount();
    const rows = [...container.querySelectorAll('div.rounded-md.border')];
    const providerRow = rows.find(row => row.textContent?.includes('sandbox:box:api_key'))!;
    const input = providerRow.querySelector('input') as HTMLInputElement;

    await setInputValue(input, NEVER_RENDERED);
    const save = [...providerRow.querySelectorAll('button')].find(b => b.textContent?.includes('Save'))!;
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const write = calls.find(call => String(call[1] && (call[1] as RequestInit).method) === 'PUT');
    expect(write).toBeTruthy();
    // The namespaced key cannot be addressed by the generic /vault/:key route, so
    // the panel must use the provider route instead.
    expect(String(write![0])).toContain('/sandbox-credentials/box');
    expect(String(write![0])).not.toContain('/vault/sandbox');
    expect(JSON.parse(String((write![1] as RequestInit).body))).toEqual({
      credential: 'api_key',
      value: NEVER_RENDERED,
    });
    // And the value is gone from the DOM once submitted.
    expect(container.textContent).not.toContain(NEVER_RENDERED);
  });
});
