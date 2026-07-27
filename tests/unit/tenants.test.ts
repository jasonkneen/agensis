import { describe, expect, it } from 'vitest';
import {
  buildTenantRows,
  buildTenantWorkspaceRow,
  filterTenants,
  matchesTenantSearch,
  sortTenants,
  tenantCountLabel,
  tenantDeploymentTotals,
  tenantDisplayName,
  tenantIdentityHeader,
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
import { EMPTY_STATS } from '../../src/lib/tenantStats';

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

// ---------------------------------------------------------------------------
// The account header — the redundancy the owner called out first.
//
// The bug: the title fell back to the email when there was no display name, and
// the line beneath it was the email unconditionally. In the overwhelmingly
// common case (nobody sets a display name) that rendered
// `trumanfuller@gmail.com` as BOTH lines, spending the pane's two most valuable
// lines saying one thing.
// ---------------------------------------------------------------------------

describe('tenantIdentityHeader', () => {
  it('never repeats the title on the second line', () => {
    const named = tenantIdentityHeader(account());
    const unnamed = tenantIdentityHeader(account({ display_name: '' }));
    expect(named.subtitle).not.toBe(named.title);
    expect(unnamed.subtitle).not.toBe(unnamed.title);
  });

  it('shows the name over the email when the account has a name', () => {
    expect(tenantIdentityHeader(account())).toEqual({
      title: 'Jason Kneen',
      subtitle: 'jason@bouncingfish.com',
    });
  });

  it('carries real facts, not a repeat, when the email IS the title', () => {
    const header = tenantIdentityHeader(account({ display_name: '' }));
    expect(header.title).toBe('jason@bouncingfish.com');
    expect(header.subtitle).toContain('Registered');
    expect(header.subtitle).not.toContain('@');
  });

  it('leaves the workspace count to the activity line rather than saying it twice', () => {
    // The line directly below the subtitle opens with "3 workspaces". Printing
    // it here as well is the same duplication this function removes, moved down
    // one row.
    const active = account({ display_name: '', stats: { ...EMPTY_STATS, workspace_count: 3 } });
    expect(tenantIdentityHeader(active).subtitle).not.toContain('workspace');
    expect(buildTenantRows([active])[0].activity).toContain('3 workspaces');
  });

  it('keeps the workspace count in the subtitle when the activity line has none', () => {
    // A response with no stats block at all (an older deploy) must not lose the
    // one size figure the row had before this feature existed.
    const header = tenantIdentityHeader(account({ display_name: '' }));
    expect(header.subtitle).toContain('3 workspaces');
    expect(buildTenantRows([account({ display_name: '' })])[0].activity).toBe('No activity');
  });

  it('falls back to the workspace count when there is no date to show at all', () => {
    const header = tenantIdentityHeader(account({ display_name: '', created_at: null }));
    expect(header.subtitle).toBe('3 workspaces');
  });

  it('adds last-active to the fact line when the account has been metered', () => {
    const header = tenantIdentityHeader(account({
      display_name: '',
      stats: { ...EMPTY_STATS, last_activity_at: '2026-07-20T00:00:00.000Z' },
    }));
    expect(header.subtitle).toContain('last active');
  });

  it('still produces two usable lines for an account with no email and no name', () => {
    const header = tenantIdentityHeader(account({ display_name: '', email: '' }));
    expect(header.title).toBe('Unnamed account');
    expect(header.subtitle).toContain('workspaces');
  });
});

describe('a list row carries activity and cost', () => {
  it('shows what the tenant uses, and blanks the cost chip when nothing was metered', () => {
    const [row] = buildTenantRows([account()]);
    expect(row.activity).toBe('No activity');
    // Not "$0.00": an unmetered account and a free one must not read the same.
    expect(row.cost).toBe('');
  });

  it('sums the deployment from the SAME blocks the rows render', () => {
    const totals = tenantDeploymentTotals([
      account({ id: 'a', stats: { ...EMPTY_STATS, message_count: 100, huddle_count: 2 } }),
      account({
        id: 'b',
        stats: {
          ...EMPTY_STATS,
          message_count: 50,
          usage: { ...EMPTY_STATS.usage, usd: 3.5, calls: 9, unpriced_providers: ['deepgram'] },
        },
      }),
    ]);
    expect(totals.messages).toBe(150);
    expect(totals.huddles).toBe(2);
    expect(totals.usd).toBe(3.5);
    expect(totals.calls).toBe(9);
    // A provider with no rate is named so the footer can say the figure is short.
    expect(totals.unpricedProviders).toEqual(['deepgram']);
  });
});
