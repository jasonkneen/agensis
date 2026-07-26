import { describe, expect, it } from 'vitest';
import * as backendCore from '../../shared/backend-core.cjs';
import { __vaultTest, type VaultEntry } from '../../src/hooks/useWorkspaceVault';

// ---------------------------------------------------------------------------
// The vault surface, as pure data.
//
// The server classifies each entry (group, owner, write lane) and the browser
// groups them for display. Both halves are decisions, not plumbing: getting the
// grouping wrong is how an orb's signing secret ends up looking like a loose
// deletable row, and getting the lane wrong is how the UI offers a write through
// a route that cannot address the key.
//
// Route behaviour, RBAC and the write-only guarantees are in
// tests/workspace-vault.test.cjs (the node runner, where the servers live).
// ---------------------------------------------------------------------------

const { classifyVaultKey, credentialLabel, VAULT_KEY_RE, VAULT_SECRET_COLUMNS } = backendCore as {
  classifyVaultKey: (key: string, options?: { managedKeys?: string[] }) => VaultEntry;
  credentialLabel: (value: string) => string;
  VAULT_KEY_RE: RegExp;
  VAULT_SECRET_COLUMNS: string[];
};

const { groupEntries, SECTION_ORDER } = __vaultTest;

function entry(key: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    ...classifyVaultKey(key, { managedKeys: ['ANTHROPIC_API_KEY'] }),
    description: '',
    configured: true,
    updated_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('vault key classification', () => {
  it('names the owner of a namespaced entry, so it never reads as a loose secret', () => {
    const box = entry('sandbox:box:api_key');
    expect(box.group).toBe('provider');
    expect(box.owner).toBe('box');
    expect(box.ownerLabel).toBe('Box');
    expect(box.label).toBe('API key');
    expect(box.lane).toBe('provider');

    const orb = entry('orb:5f3ab19c-1111-4111-8111-111111111111');
    expect(orb.group).toBe('orb');
    expect(orb.label).toBe('Signing secret');
    // No write lane: rotation belongs to the orb's own panel, where the operator
    // can also re-register the secret with the provider.
    expect(orb.lane).toBe('none');
    expect(orb.ownerLabel).toBe('Orb 5f3ab19c');
  });

  it('keeps a user key and a namespaced key in separate address spaces', () => {
    // The generic PUT/DELETE routes accept only this charset, which is precisely
    // why a user secret can never collide with (or overwrite) a namespaced one.
    expect(VAULT_KEY_RE.test('STRIPE_TOKEN')).toBe(true);
    expect(VAULT_KEY_RE.test('sandbox:box:api_key')).toBe(false);
    expect(VAULT_KEY_RE.test('orb:abc')).toBe(false);
    expect(VAULT_KEY_RE.test('a'.repeat(129))).toBe(false);
  });

  it('refuses to guess at a malformed namespaced key', () => {
    for (const key of ['sandbox:box', 'sandbox:box:api_key:extra', 'sandbox::api_key']) {
      const parsed = entry(key);
      expect(parsed.group).toBe('unknown');
      expect(parsed.lane).toBe('none');
    }
  });

  it('labels a credential for a reader without inventing one', () => {
    expect(credentialLabel('api_key')).toBe('API key');
    expect(credentialLabel('org_token')).toBe('Org token');
    expect(credentialLabel('')).toBe('Credential');
  });

  it('knows which columns hold secret material', () => {
    expect(VAULT_SECRET_COLUMNS).toEqual(['value', 'secret_cipher']);
  });
});

describe('vault grouping for display', () => {
  it('groups by kind, then by the thing that owns the entry', () => {
    const sections = groupEntries([
      entry('STRIPE_TOKEN'),
      entry('sandbox:box:api_key'),
      entry('sandbox:box:org_token'),
      entry('orb:5f3ab19c-1111-4111-8111-111111111111'),
      entry('ANTHROPIC_API_KEY'),
    ]);

    expect(sections.map(section => section.group)).toEqual(['managed', 'provider', 'orb', 'shared']);

    const provider = sections.find(section => section.group === 'provider')!;
    // Both Box credentials sit under ONE owner heading rather than as two loose rows.
    expect(provider.owners).toHaveLength(1);
    expect(provider.owners[0].ownerLabel).toBe('Box');
    expect(provider.owners[0].entries.map(item => item.label)).toEqual(['API key', 'Org token']);
  });

  it('renders sections in a stable order and drops empty ones', () => {
    const sections = groupEntries([entry('STRIPE_TOKEN')]);
    expect(sections).toHaveLength(1);
    expect(sections[0].group).toBe('shared');
    expect(SECTION_ORDER.indexOf('managed')).toBeLessThan(SECTION_ORDER.indexOf('shared'));
  });

  it('carries no field that could hold a value', () => {
    const [section] = groupEntries([entry('sandbox:box:api_key')]);
    const item = section.owners[0].entries[0] as Record<string, unknown>;
    for (const field of ['value', 'secret_cipher', 'preview']) {
      expect(field in item).toBe(false);
    }
    // What a reader gets instead: is it set, and when was it set.
    expect(item.configured).toBe(true);
    expect(item.updated_at).toBe('2026-07-20T10:00:00.000Z');
  });
});
