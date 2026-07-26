import { describe, expect, it } from 'vitest';
import {
  buildTenantRows,
  buildTenantWorkspaceRow,
  filterTenants,
  matchesTenantSearch,
  sortTenants,
  tenantCountLabel,
  tenantDisplayName,
  tenantInitials,
  tenantJoinedLabel,
  tenantListFooter,
  tenantSearchText,
  tenantSummaryLine,
  tenantTileColor,
  tenantWorkspaceInitials,
  tenantsEmptyState,
  type TenantAccount,
  type TenantMemberWorkspace,
  type TenantWorkspace,
} from '../../src/lib/tenants';

// The tenant list, as pure data — search, order and row copy. Everything the
// component renders comes from here, so the list can be checked without a DOM.

function account(overrides: Partial<TenantAccount> = {}): TenantAccount {
  return {
    id: 'acc-1',
    email: 'jason@bouncingfish.com',
    display_name: 'Jason Kneen',
    accent_color: '',
    created_at: '2026-01-15T10:00:00.000Z',
    owned_workspace_count: 3,
    membership_count: 1,
    ...overrides,
  };
}

function workspace(overrides: Partial<TenantWorkspace> = {}): TenantWorkspace {
  return {
    id: 'ws-1',
    name: 'Acme Rebuild',
    icon: '',
    is_system: false,
    parent_id: null,
    created_at: '2026-02-01T10:00:00.000Z',
    updated_at: '2026-02-02T10:00:00.000Z',
    member_count: 4,
    agent_count: 2,
    ...overrides,
  };
}

describe('tenantDisplayName', () => {
  it('prefers the display name', () => {
    expect(tenantDisplayName(account())).toBe('Jason Kneen');
  });

  it('falls back to the email, which is the identity an operator actually has', () => {
    expect(tenantDisplayName(account({ display_name: '   ' }))).toBe('jason@bouncingfish.com');
  });

  it('never renders an empty row', () => {
    expect(tenantDisplayName({ display_name: '', email: '' })).toBe('Unnamed account');
  });
});

describe('tenantInitials', () => {
  it('takes one letter from each of the first two words', () => {
    expect(tenantInitials(account())).toBe('JK');
  });

  it('takes two letters from a single word', () => {
    expect(tenantInitials(account({ display_name: 'Jason' }))).toBe('JA');
  });

  it('reduces an email to its local part', () => {
    expect(tenantInitials(account({ display_name: '', email: 'testing@bouncingfish.com' }))).toBe('TE');
  });

  it('skips punctuation rather than rendering it', () => {
    expect(tenantInitials(account({ display_name: '', email: '+support@x.test' }))).toBe('SU');
    expect(tenantInitials(account({ display_name: '_jason.kneen@x.test' }))).toBe('JK');
  });

  it('never returns an emoji, and always returns something', () => {
    const initials = tenantInitials(account({ display_name: '🎉 🎉', email: '' }));
    expect(initials).toBe('?');
    expect(/\p{Extended_Pictographic}/u.test(initials)).toBe(false);
  });
});

describe('tenantTileColor', () => {
  it('is stable for the same account and comes from the rail palette', () => {
    const first = tenantTileColor(account());
    expect(first).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tenantTileColor(account())).toBe(first);
  });

  it('is not keyed on the display name, so a rename does not recolour the tile', () => {
    expect(tenantTileColor(account({ display_name: 'Someone Else' }))).toBe(tenantTileColor(account()));
  });
});

describe('search', () => {
  it('matches on email, display name and id', () => {
    expect(tenantSearchText(account())).toBe('jason@bouncingfish.com jason kneen acc-1');
    expect(matchesTenantSearch(account(), 'bouncingfish')).toBe(true);
    expect(matchesTenantSearch(account(), 'kneen')).toBe(true);
    expect(matchesTenantSearch(account(), 'acc-1')).toBe(true);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(matchesTenantSearch(account(), '  JASON  ')).toBe(true);
  });

  it('requires every term but not their order', () => {
    expect(matchesTenantSearch(account(), 'kneen bouncing')).toBe(true);
    expect(matchesTenantSearch(account(), 'kneen missing')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(matchesTenantSearch(account(), '')).toBe(true);
    expect(matchesTenantSearch(account(), '   ')).toBe(true);
  });

  it('does not match an unrelated account', () => {
    expect(matchesTenantSearch(account(), 'someone-else')).toBe(false);
  });

  it('filterTenants keeps only matches and preserves input order', () => {
    const accounts = [
      account({ id: 'a', email: 'a@x.test', display_name: 'Ann' }),
      account({ id: 'b', email: 'b@y.test', display_name: 'Bob' }),
      account({ id: 'c', email: 'c@x.test', display_name: 'Cat' }),
    ];
    expect(filterTenants(accounts, 'x.test').map(a => a.id)).toEqual(['a', 'c']);
  });
});

describe('sortTenants', () => {
  it('puts the newest account first', () => {
    const accounts = [
      account({ id: 'old', created_at: '2025-01-01T00:00:00.000Z' }),
      account({ id: 'new', created_at: '2026-06-01T00:00:00.000Z' }),
      account({ id: 'mid', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(sortTenants(accounts).map(a => a.id)).toEqual(['new', 'mid', 'old']);
  });

  it('sinks accounts with no usable date, and breaks ties on id so the order is total', () => {
    const accounts = [
      account({ id: 'zz', created_at: null }),
      account({ id: 'bb', created_at: '2026-01-01T00:00:00.000Z' }),
      account({ id: 'aa', created_at: '2026-01-01T00:00:00.000Z' }),
      account({ id: 'yy', created_at: 'not-a-date' }),
    ];
    expect(sortTenants(accounts).map(a => a.id)).toEqual(['aa', 'bb', 'yy', 'zz']);
  });

  it('does not mutate the input', () => {
    const accounts = [account({ id: 'a', created_at: '2025-01-01T00:00:00.000Z' }), account({ id: 'b' })];
    sortTenants(accounts);
    expect(accounts.map(a => a.id)).toEqual(['a', 'b']);
  });
});

describe('row copy', () => {
  it('summarizes owned and shared workspaces, singular where it should be', () => {
    expect(tenantSummaryLine(account({ owned_workspace_count: 3, membership_count: 1 }))).toBe('3 workspaces · 1 shared');
    expect(tenantSummaryLine(account({ owned_workspace_count: 1, membership_count: 0 }))).toBe('1 workspace');
    expect(tenantSummaryLine(account({ owned_workspace_count: 0, membership_count: 0 }))).toBe('0 workspaces');
  });

  it('renders the join date absolutely, and blanks an unparseable one', () => {
    expect(tenantJoinedLabel('2026-01-15T10:00:00.000Z')).toMatch(/2026/);
    expect(tenantJoinedLabel(null)).toBe('');
    expect(tenantJoinedLabel('nonsense')).toBe('');
  });

  it('buildTenantRows filters, sorts and pre-formats in one pass', () => {
    const accounts = [
      account({ id: 'a', email: 'ann@x.test', display_name: 'Ann', created_at: '2025-01-01T00:00:00.000Z' }),
      account({ id: 'b', email: 'bob@y.test', display_name: 'Bob', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const rows = buildTenantRows(accounts, 'x.test');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Ann');
    expect(rows[0].subtitle).toBe('ann@x.test');
    expect(rows[0].initials).toBe('AN');
    expect(rows[0].color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(buildTenantRows(accounts).map(row => row.account.id)).toEqual(['b', 'a']);
  });

  it('counts the list honestly, including when the route capped it', () => {
    expect(tenantCountLabel(12, 12, false)).toBe('12 accounts');
    expect(tenantCountLabel(1, 1, false)).toBe('1 account');
    expect(tenantCountLabel(500, 1284, true)).toBe('Showing 500 of 1,284 accounts');
  });

  it('never conflates "rows after the search" with "size of the deployment"', () => {
    // The footer is read by the one person whose job is to know how many
    // accounts exist. Reporting the filtered count as the total would be a lie
    // to exactly the wrong reader.
    expect(tenantListFooter(12, 12, 12, false, '')).toBe('12 accounts');
    expect(tenantListFooter(3, 12, 12, false, 'jason')).toBe('3 matching · 12 accounts');
    expect(tenantListFooter(3, 12, 12, false, '   ')).toBe('12 accounts');
    expect(tenantListFooter(2, 500, 1284, true, 'ann'))
      .toBe('2 matching · Showing 500 of 1,284 accounts');
  });

  it('explains an empty list differently when it is a search miss', () => {
    expect(tenantsEmptyState('jason', 12).title).toBe('No matching accounts');
    expect(tenantsEmptyState('', 0).title).toBe('No accounts yet');
    expect(tenantsEmptyState('', 12).title).toBe('Nothing to show');
  });
});

describe('workspace rows', () => {
  it('uses initials, never the workspace emoji icon', () => {
    expect(tenantWorkspaceInitials({ name: 'Acme Rebuild' })).toBe('AR');
    expect(tenantWorkspaceInitials({ name: 'Personal' })).toBe('PE');
    expect(tenantWorkspaceInitials({ name: '🏠' })).toBe('?');
    const row = buildTenantWorkspaceRow(workspace({ icon: '🏠' }));
    expect(row.initials).toBe('AR');
    expect(/\p{Extended_Pictographic}/u.test(row.detail + row.name + row.initials)).toBe(false);
  });

  it('describes an owned workspace by members and agents', () => {
    expect(buildTenantWorkspaceRow(workspace()).detail).toBe('4 members · 2 agents');
    expect(buildTenantWorkspaceRow(workspace({ member_count: 1, agent_count: 1 })).detail)
      .toBe('1 member · 1 agent');
  });

  it('leads a shared workspace with the role and ends with its owner', () => {
    const shared: TenantMemberWorkspace = {
      ...workspace({ id: 'ws-2', name: 'Client Portal' }),
      role: 'editor',
      owner_email: 'someone@else.test',
    };
    expect(buildTenantWorkspaceRow(shared).detail)
      .toBe('editor · 4 members · 2 agents · someone@else.test');
  });

  it('marks the System workspace and names an untitled one', () => {
    expect(buildTenantWorkspaceRow(workspace({ is_system: true })).isSystem).toBe(true);
    expect(buildTenantWorkspaceRow(workspace({ name: '  ' })).name).toBe('Untitled workspace');
  });
});
