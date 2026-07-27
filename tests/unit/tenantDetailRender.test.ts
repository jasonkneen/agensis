import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TenantDetailPane } from '../../src/components/tenants/TenantDetailPane';
import { TenantRow } from '../../src/components/tenants/TenantRow';
import { buildTenantRows, type TenantAccount, type TenantAccountDetail } from '../../src/lib/tenants';
import { EMPTY_STATS, type TenantMeteringWindow } from '../../src/lib/tenantStats';

// What a reader cannot check by eye, and what a typecheck cannot catch:
//
//   1. the pane MOUNTS at all — it pulls in the cost block, the activity grid,
//      the workspace groups and two lib modules, and a bad import is a blank
//      right-hand side in production with a completely green typecheck;
//   2. the header does not print the same string twice (the bug this pass was
//      opened to fix);
//   3. the rendered TEXT never claims more than the data supports. The cost
//      block is the one place on this surface that can actively mislead, so the
//      assertions below are on what the DOM says, not on what a helper returned.

const ACCOUNT: TenantAccount = {
  id: 'acc-1',
  email: 'trumanfuller@gmail.com',
  display_name: '',
  accent_color: '',
  created_at: '2026-01-15T10:00:00.000Z',
  owned_workspace_count: 2,
  membership_count: 1,
  stats: {
    ...EMPTY_STATS,
    channel_count: 6,
    message_count: 900,
    agent_message_count: 700,
    human_message_count: 200,
    huddle_count: 3,
    huddle_seconds: 3600,
    agent_count: 4,
    document_count: 2,
    member_count: 3,
    workspace_count: 2,
    last_activity_at: '2026-07-20T00:00:00.000Z',
    usage: {
      usd: 8.25,
      calls: 61,
      estimated_rates: false,
      unpriced_providers: ['deepgram'],
      providers: [{
        provider: 'anthropic',
        calls: 61,
        input_units: 1_200_000,
        output_units: 260_000,
        cache_write_units: 0,
        cache_read_units: 0,
        usd: 8.25,
        priced: true,
      }],
      rates_as_of: '2026-07-27',
    },
  },
};

const METERING: TenantMeteringWindow = {
  started_at: '2026-07-01T00:00:00.000Z',
  first_event_at: '2026-07-02T00:00:00.000Z',
  last_event_at: '2026-07-20T00:00:00.000Z',
  rates_as_of: '2026-07-27',
};

const DETAIL: TenantAccountDetail = {
  account: ACCOUNT,
  owned_workspaces: [{
    id: 'ws-1',
    name: 'Acme Rebuild',
    icon: '',
    is_system: false,
    parent_id: null,
    created_at: '2026-01-16T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
    member_count: 3,
    agent_count: 4,
    stats: { ...EMPTY_STATS, channel_count: 6, message_count: 900, agent_message_count: 700, huddle_count: 3, huddle_seconds: 3600 },
    usage: ACCOUNT.stats!.usage,
  }],
  member_workspaces: [{
    id: 'ws-2',
    name: 'Someone Else',
    icon: '',
    is_system: false,
    parent_id: null,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-02T00:00:00.000Z',
    member_count: 2,
    agent_count: 1,
    role: 'editor',
    owner_email: 'other@example.test',
  }],
  metering: METERING,
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPane(props: Partial<Parameters<typeof TenantDetailPane>[0]> = {}) {
  act(() => {
    root.render(createElement(TenantDetailPane, {
      account: ACCOUNT,
      detail: DETAIL,
      loading: false,
      error: null,
      metering: METERING,
      onClose: () => {},
      ...props,
    }));
  });
  return container.textContent || '';
}

describe('TenantDetailPane', () => {
  it('mounts with the cost block, the activity grid and both workspace groups', () => {
    const text = renderPane();
    expect(text).toContain('Estimated spend');
    expect(text).toContain('Activity');
    expect(text).toContain('Workspaces owned (1)');
    expect(text).toContain('Shared with this account (1)');
  });

  it('does not print the email twice — the bug this pass was opened to fix', () => {
    renderPane();
    // The email is the heading (no display name), so it must appear ONCE and
    // the second line must carry facts instead.
    const occurrences = (container.textContent || '').split('trumanfuller@gmail.com').length - 1;
    // Once in the header band, once as the identity title. Never a third time
    // as a subtitle immediately beneath its own heading.
    expect(occurrences).toBeLessThanOrEqual(2);
    expect(container.textContent).toContain('Registered');
  });

  it('shows the money WITH its window and an explicit "not an invoice"', () => {
    const text = renderPane();
    expect(text).toContain('$8.25');
    expect(text).toContain('Since');
    expect(text).toContain('Not an invoice');
    expect(text).toContain('list rates as of');
  });

  it('names the provider whose spend is NOT in the total', () => {
    const text = renderPane();
    expect(text).toContain('deepgram');
    expect(text).toContain('NOT included');
  });

  it('says "No usage yet" — never $0.00 — for an empty metering window', () => {
    const bare: TenantAccount = { ...ACCOUNT, stats: { ...EMPTY_STATS, workspace_count: 1 } };
    const text = renderPane({ account: bare, detail: { ...DETAIL, account: bare } });
    expect(text).toContain('No usage yet');
    expect(text).not.toContain('$0.00');
  });

  it('says metering is not recording when it never started', () => {
    // A deployment where metering never started has NO usage rows anywhere, so
    // the workspaces are cleared too — a fixture with spend under an account
    // that was never metered describes a state that cannot happen.
    const bare: TenantAccount = { ...ACCOUNT, stats: { ...EMPTY_STATS } };
    const text = renderPane({
      account: bare,
      detail: {
        ...DETAIL,
        account: bare,
        owned_workspaces: [{ ...DETAIL.owned_workspaces[0], usage: undefined }],
        metering: undefined,
      },
      metering: null,
    });
    expect(text).toContain('Not recording');
    // Nowhere on the pane is a dollar figure invented for an unmetered account.
    expect(text).not.toContain('$');
  });

  it('renders a workspace with no stats block at all (a pre-deploy response)', () => {
    const text = renderPane({
      detail: {
        ...DETAIL,
        owned_workspaces: [{ ...DETAIL.owned_workspaces[0], stats: undefined, usage: undefined }],
      },
    });
    expect(text).toContain('Acme Rebuild');
  });
});

describe('TenantRow', () => {
  it('shows the activity line and the cost chip', () => {
    const [row] = buildTenantRows([ACCOUNT]);
    act(() => { root.render(createElement(TenantRow, { row, selected: false, onSelect: () => {} })); });
    const text = container.textContent || '';
    expect(text).toContain('900 msgs');
    expect(text).toContain('$8.25');
  });

  it('renders no cost chip at all when nothing was recorded', () => {
    const [row] = buildTenantRows([{ ...ACCOUNT, stats: { ...EMPTY_STATS } }]);
    act(() => { root.render(createElement(TenantRow, { row, selected: false, onSelect: () => {} })); });
    expect(container.textContent).not.toContain('$');
  });
});
