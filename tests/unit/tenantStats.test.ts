import { describe, expect, it } from 'vitest';
import {
  buildActivityStats,
  buildCostSummary,
  compactUnits,
  formatCount,
  formatDuration,
  formatStatDate,
  formatUsd,
  normalizeStats,
  normalizeUsage,
  tenantActivityLine,
  tenantCostChip,
  usageUnitsLine,
  EMPTY_STATS,
  EMPTY_USAGE,
  type TenantAccountStats,
  type TenantMeteringWindow,
  type TenantUsageSummary,
} from '../../src/lib/tenantStats';

// Tenant statistics and cost, as pure data.
//
// Most of this file is about ONE thing: a money figure on an admin screen is
// the most dangerous string in the product, and every way it can lie has a test
// here — an estimate presented as a bill, an empty metering window presented as
// a $0 bill, an unpriced provider folded silently into a total, and a sub-cent
// figure rounded down to "free".

function usage(overrides: Partial<TenantUsageSummary> = {}): TenantUsageSummary {
  return {
    usd: 12.5,
    calls: 40,
    estimated_rates: false,
    unpriced_providers: [],
    providers: [
      {
        provider: 'anthropic',
        calls: 40,
        input_units: 2_000_000,
        output_units: 300_000,
        cache_write_units: 0,
        cache_read_units: 0,
        usd: 12.5,
        priced: true,
      },
    ],
    rates_as_of: '2026-07-27',
    ...overrides,
  };
}

function stats(overrides: Partial<TenantAccountStats> = {}): TenantAccountStats {
  return {
    ...EMPTY_STATS,
    channel_count: 12,
    dm_count: 3,
    thread_count: 8,
    message_count: 1200,
    agent_message_count: 800,
    human_message_count: 400,
    huddle_count: 4,
    live_huddle_count: 0,
    huddle_seconds: 5400,
    agent_count: 6,
    live_daemon_count: 2,
    document_count: 15,
    member_count: 4,
    last_activity_at: '2026-07-20T09:00:00.000Z',
    workspace_count: 2,
    usage: usage(),
    ...overrides,
  };
}

const metering: TenantMeteringWindow = {
  started_at: '2026-07-01T00:00:00.000Z',
  first_event_at: '2026-07-02T00:00:00.000Z',
  last_event_at: '2026-07-20T00:00:00.000Z',
  rates_as_of: '2026-07-27',
};

describe('normalizing a server response', () => {
  it('turns a missing stats block into zeroes rather than crashing a render', () => {
    expect(normalizeStats(undefined)).toEqual(EMPTY_STATS);
    expect(normalizeStats(null)).toEqual(EMPTY_STATS);
    expect(normalizeUsage(undefined)).toEqual(EMPTY_USAGE);
  });

  it('reads bigint counts that arrived as strings', () => {
    // Postgres returns counts as bigint strings on both drivers, and a response
    // shaped by an older deploy may still carry them.
    const normalized = normalizeStats({ message_count: '4200' as unknown as number });
    expect(normalized.message_count).toBe(4200);
  });

  it('refuses a negative or non-finite count', () => {
    const normalized = normalizeStats({
      message_count: -5,
      huddle_seconds: Number.NaN,
      agent_count: Infinity,
    });
    expect(normalized.message_count).toBe(0);
    expect(normalized.huddle_seconds).toBe(0);
    expect(normalized.agent_count).toBe(0);
  });
});

describe('formatting', () => {
  it('never prints $0.00 for a real sub-cent amount', () => {
    // A thousand Haiku calls that cost three tenths of a cent are not free, and
    // the one screen whose job is finding spend must not say they are.
    expect(formatUsd(0.003)).toBe('<$0.01');
    expect(formatUsd(0.009999)).toBe('<$0.01');
  });

  it('prints exactly $0.00 only for nothing at all', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-1)).toBe('$0.00');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });

  it('shows cents up to $1000 and whole dollars above it', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(999.994)).toBe('$999.99');
    expect(formatUsd(4210.7)).toBe('$4,211');
  });

  it('formats durations at the largest useful unit', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(5400)).toBe('1h 30m');
    expect(formatDuration(7200)).toBe('2h');
  });

  it('compacts token counts but keeps small numbers exact', () => {
    expect(compactUnits(940)).toBe('940');
    expect(compactUnits(1500)).toBe('1.5k');
    expect(compactUnits(42_000)).toBe('42k');
    expect(compactUnits(2_400_000)).toBe('2.4M');
  });

  it('groups counts and refuses to invent a date', () => {
    expect(formatCount(12345)).toBe((12345).toLocaleString());
    expect(formatStatDate(null)).toBe('');
    expect(formatStatDate('not a date')).toBe('');
    // The epoch is the SQL floor value for "never", not a real timestamp.
    expect(formatStatDate('1970-01-01T00:00:00.000Z')).toBe('');
  });
});

describe('the activity grid', () => {
  it('always renders every tile, including zeros', () => {
    // A grid whose tiles come and go cannot be scanned down a column, and
    // "0 huddles" is an answer.
    const empty = buildActivityStats(EMPTY_STATS);
    const full = buildActivityStats(stats());
    expect(empty.map(item => item.label)).toEqual(full.map(item => item.label));
  });

  it('splits messages by who wrote them — the agent share is what costs money', () => {
    const items = buildActivityStats(stats());
    const messages = items.find(item => item.label === 'Messages');
    expect(messages?.value).toBe((1200).toLocaleString());
    expect(messages?.detail).toContain('67%');
    expect(messages?.detail).toContain('by agents');
  });

  it('says a huddle is live rather than only reporting total time', () => {
    const items = buildActivityStats(stats({ live_huddle_count: 1 }));
    expect(items.find(item => item.label === 'Huddles')?.detail).toContain('1 live now');
  });

  it('reports "Never" for an account with no activity at all', () => {
    const items = buildActivityStats(EMPTY_STATS);
    expect(items.find(item => item.label === 'Last active')?.value).toBe('Never');
  });
});

describe('the cost summary — the four states it must not collapse', () => {
  it('says NOT RECORDING when metering never started', () => {
    const summary = buildCostSummary(EMPTY_USAGE, null);
    expect(summary.recording).toBe(false);
    expect(summary.amount).toBe('Not recording');
    expect(summary.amount).not.toContain('$');
    expect(summary.caveat).toMatch(/has not started/i);
  });

  it('says NO USAGE YET — never $0.00 — for an empty metering window', () => {
    // An account nobody has metered and an account that genuinely cost nothing
    // must not look identical, because only one of them is a fact.
    const summary = buildCostSummary(usage({ usd: 0, calls: 0, providers: [] }), metering);
    expect(summary.recording).toBe(true);
    expect(summary.amount).toBe('No usage yet');
    expect(summary.amount).not.toContain('$0.00');
    expect(summary.since).toMatch(/^Metering started /);
    expect(summary.caveat).toMatch(/not a \$0 bill/i);
  });

  it('labels a real figure with its window AND calls it an estimate', () => {
    const summary = buildCostSummary(usage(), metering);
    expect(summary.amount).toBe('$12.50');
    expect(summary.since).toMatch(/^Since /);
    expect(summary.caveat).toMatch(/^Estimate/);
    expect(summary.caveat).toMatch(/Not an invoice/);
    expect(summary.caveat).toMatch(/list rates as of/);
  });

  it('admits when a figure is short because a provider has no rate', () => {
    const summary = buildCostSummary(usage({ unpriced_providers: ['cartesia', 'deepgram'] }), metering);
    expect(summary.unpricedNote).toContain('cartesia, deepgram');
    expect(summary.unpricedNote).toMatch(/NOT included/);
  });

  it('admits when an unknown model was priced at a fallback rate', () => {
    const summary = buildCostSummary(usage({ estimated_rates: true }), metering);
    expect(summary.caveat).toMatch(/no listed rate/);
  });
});

describe('list-row copy', () => {
  it('summarizes what a tenant actually uses', () => {
    expect(tenantActivityLine(stats())).toBe('2 workspaces · 12 ch · 1.2k msgs · 4 huddles · 6 agents');
  });

  it('says "No activity" rather than rendering an empty line', () => {
    expect(tenantActivityLine(EMPTY_STATS)).toBe('No activity');
  });

  it('leaves the cost chip BLANK when nothing was recorded', () => {
    expect(tenantCostChip(stats({ usage: usage({ calls: 0, usd: 0 }) }))).toBe('');
  });

  it('shows a call count when usage was recorded but could not be priced', () => {
    // Real spend with no rate: showing "$0.00" here would report it as free.
    const chip = tenantCostChip(stats({ usage: usage({ usd: 0, calls: 9, unpriced_providers: ['deepgram'] }) }));
    expect(chip).toBe('9 calls');
  });

  it('shows the money when there is money to show', () => {
    expect(tenantCostChip(stats())).toBe('$12.50');
  });

  it('states the units behind the figure', () => {
    expect(usageUnitsLine(usage())).toBe('40 calls · 2.0M in · 300k out');
    expect(usageUnitsLine(usage({ calls: 0 }))).toBe('');
  });
});
