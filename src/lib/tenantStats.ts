// ---------------------------------------------------------------------------
// Tenant statistics and cost, formatted.
//
// Everything the Tenants window says about how much a tenant uses and what it
// costs, as pure functions. Split out of src/lib/tenants.ts (which is identity
// and list shaping) because this half carries the one thing on the surface that
// can be actively misleading: a money figure.
//
// THE HONESTY RULES, all of them enforced here rather than in JSX:
//
//   1. NO USAGE HISTORY EXISTS before metering was switched on. Every cost
//      figure is therefore labelled with the date it counts FROM. A total with
//      no "since" on it reads as all-time and would be false — and unfixable,
//      because there is nothing to back-fill from.
//   2. AN ESTIMATE SAYS SO. The server multiplies our own counts by a list
//      price typed into shared/usage-rates.cjs. It is not an invoice, and no
//      string here calls it one.
//   3. UNPRICED IS NOT FREE. A provider we meter but have no rate for
//      (Deepgram, Cartesia, LiveKit) contributes real money and zero dollars to
//      the total. That gets said out loud instead of being folded into a number
//      that looks complete.
//   4. NOT-YET-METERED IS NOT ZERO either. Before the first event lands, the
//      answer is "nothing recorded yet", never "$0.00".
// ---------------------------------------------------------------------------

/** Counts for one workspace, or summed across an account's workspaces. */
export interface TenantActivityStats {
  channel_count: number;
  dm_count: number;
  thread_count: number;
  message_count: number;
  agent_message_count: number;
  human_message_count: number;
  huddle_count: number;
  live_huddle_count: number;
  huddle_seconds: number;
  agent_count: number;
  live_daemon_count: number;
  document_count: number;
  member_count: number;
  last_activity_at: string | null;
}

export interface TenantAccountStats extends TenantActivityStats {
  workspace_count: number;
  usage: TenantUsageSummary;
}

export interface TenantUsageProvider {
  provider: string;
  calls: number;
  input_units: number;
  output_units: number;
  cache_write_units: number;
  cache_read_units: number;
  usd: number;
  priced: boolean;
}

export interface TenantUsageSummary {
  usd: number;
  calls: number;
  estimated_rates: boolean;
  unpriced_providers: string[];
  providers: TenantUsageProvider[];
  rates_as_of: string;
}

/** When metering began, and what it has seen. Nulls mean "not started". */
export interface TenantMeteringWindow {
  started_at: string | null;
  first_event_at: string | null;
  last_event_at: string | null;
  rates_as_of: string;
}

export const EMPTY_USAGE: TenantUsageSummary = {
  usd: 0,
  calls: 0,
  estimated_rates: false,
  unpriced_providers: [],
  providers: [],
  rates_as_of: '',
};

export const EMPTY_STATS: TenantAccountStats = {
  channel_count: 0,
  dm_count: 0,
  thread_count: 0,
  message_count: 0,
  agent_message_count: 0,
  human_message_count: 0,
  huddle_count: 0,
  live_huddle_count: 0,
  huddle_seconds: 0,
  agent_count: 0,
  live_daemon_count: 0,
  document_count: 0,
  member_count: 0,
  last_activity_at: null,
  workspace_count: 0,
  usage: EMPTY_USAGE,
};

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * A response may predate a deploy, or come from a lane whose usage table does
 * not exist yet. Every consumer reads through these, so a missing block is a
 * zero rather than a crash halfway down a render.
 */
export function normalizeUsage(value: Partial<TenantUsageSummary> | null | undefined): TenantUsageSummary {
  if (!value || typeof value !== 'object') return EMPTY_USAGE;
  const usd = Number(value.usd);
  return {
    usd: Number.isFinite(usd) && usd > 0 ? usd : 0,
    calls: count(value.calls),
    estimated_rates: value.estimated_rates === true,
    unpriced_providers: Array.isArray(value.unpriced_providers)
      ? value.unpriced_providers.map(String).filter(Boolean)
      : [],
    providers: Array.isArray(value.providers) ? value.providers : [],
    rates_as_of: String(value.rates_as_of || ''),
  };
}

export function normalizeStats(value: Partial<TenantAccountStats> | null | undefined): TenantAccountStats {
  if (!value || typeof value !== 'object') return EMPTY_STATS;
  return {
    channel_count: count(value.channel_count),
    dm_count: count(value.dm_count),
    thread_count: count(value.thread_count),
    message_count: count(value.message_count),
    agent_message_count: count(value.agent_message_count),
    human_message_count: count(value.human_message_count),
    huddle_count: count(value.huddle_count),
    live_huddle_count: count(value.live_huddle_count),
    huddle_seconds: count(value.huddle_seconds),
    agent_count: count(value.agent_count),
    live_daemon_count: count(value.live_daemon_count),
    document_count: count(value.document_count),
    member_count: count(value.member_count),
    last_activity_at: value.last_activity_at ? String(value.last_activity_at) : null,
    workspace_count: count(value.workspace_count),
    usage: normalizeUsage(value.usage),
  };
}

// --- Formatting -------------------------------------------------------------

/** Exact, grouped. An operator reading this wants the number, not "1.2k". */
export function formatCount(value: number): string {
  return count(value).toLocaleString();
}

/**
 * Money, at the precision the figure deserves.
 *
 * A sub-cent total renders as "<$0.01" rather than "$0.00": a thousand Haiku
 * calls that genuinely cost three tenths of a cent are NOT free, and the one
 * screen whose job is finding spend must not print zero for a non-zero number.
 * Exactly zero — no priced usage at all — is the only "$0.00".
 */
export function formatUsd(value: number): string {
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

/** "2h 14m", "6m 30s", "45s", "" for nothing. Never a bare seconds count in the thousands. */
export function formatDuration(seconds: number): string {
  const total = count(seconds);
  if (total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  return `${secs}s`;
}

/**
 * Absolute, never relative — the same rule as the rest of this surface. This
 * app runs no timers, so "3 days ago" is a label that rots silently while the
 * window stays open.
 */
export function formatStatDate(iso: string | null): string {
  const parsed = Date.parse(String(iso || ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return '';
  return new Date(parsed).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// --- The lines the UI renders ----------------------------------------------

export interface TenantStatItem {
  label: string;
  value: string;
  /** A second line under the value — a split, a duration, a live count. */
  detail?: string;
}

/**
 * The activity grid. Ordered by what an operator asks first: how much talking,
 * how much of it was the agents (that is the half that costs money), how much
 * voice, then the furniture.
 *
 * Every tile is always present, including zeros. A grid whose tiles come and go
 * cannot be scanned down a column, and "0 huddles" is an answer.
 */
export function buildActivityStats(stats: TenantActivityStats): TenantStatItem[] {
  const agentShare = stats.message_count > 0
    ? Math.round((stats.agent_message_count / stats.message_count) * 100)
    : 0;
  const huddleTime = formatDuration(stats.huddle_seconds);

  return [
    {
      label: 'Messages',
      value: formatCount(stats.message_count),
      detail: stats.message_count > 0
        ? `${formatCount(stats.agent_message_count)} by agents (${agentShare}%) · ${formatCount(stats.human_message_count)} by people`
        : 'Nothing sent yet',
    },
    {
      label: 'Channels',
      value: formatCount(stats.channel_count),
      detail: `${formatCount(stats.dm_count)} DMs · ${formatCount(stats.thread_count)} threads`,
    },
    {
      label: 'Huddles',
      value: formatCount(stats.huddle_count),
      detail: stats.live_huddle_count > 0
        ? `${formatCount(stats.live_huddle_count)} live now${huddleTime ? ` · ${huddleTime} total` : ''}`
        : (huddleTime ? `${huddleTime} total` : 'No voice calls yet'),
    },
    {
      label: 'Agents',
      value: formatCount(stats.agent_count),
      detail: stats.live_daemon_count > 0
        ? `${formatCount(stats.live_daemon_count)} daemon${stats.live_daemon_count === 1 ? '' : 's'} connected`
        : 'No daemon connected',
    },
    {
      label: 'Documents',
      value: formatCount(stats.document_count),
      detail: `${formatCount(stats.member_count)} member${stats.member_count === 1 ? '' : 's'}`,
    },
    {
      label: 'Last active',
      value: formatStatDate(stats.last_activity_at) || 'Never',
      detail: stats.last_activity_at ? '' : 'No message, document or daemon yet',
    },
  ];
}

/**
 * The honest headline for a cost block: what it says, and what it must never
 * say. Returns a title, the figure, and a caveat line that is REQUIRED to be
 * rendered next to it.
 *
 * The four states are genuinely different and the UI must not collapse them:
 *   * metering off       — no table, no epoch. "Not recording."
 *   * metering on, empty — recording since a date, nothing seen. NOT "$0.00".
 *   * priced             — a figure, with its "since" and its "estimate".
 *   * partly unpriced    — a figure that is KNOWN to be short, and says so.
 */
export function buildCostSummary(
  usage: TenantUsageSummary,
  metering: TenantMeteringWindow | null,
): { amount: string; recording: boolean; since: string; caveat: string; unpricedNote: string } {
  const startedAt = metering?.started_at || null;
  const since = formatStatDate(startedAt);
  const ratesAsOf = formatStatDate(usage.rates_as_of || metering?.rates_as_of || null);

  if (!startedAt) {
    return {
      amount: 'Not recording',
      recording: false,
      since: '',
      caveat: 'Usage metering has not started on this deployment, so no spend has been recorded. Nothing before it starts can be recovered.',
      unpricedNote: '',
    };
  }

  if (usage.calls === 0) {
    return {
      amount: 'No usage yet',
      recording: true,
      since: since ? `Metering started ${since}` : 'Metering started',
      caveat: 'Nothing has been recorded for this account since metering started. This is not a $0 bill — it is an empty window.',
      unpricedNote: '',
    };
  }

  const rateNote = ratesAsOf ? ` at list rates as of ${ratesAsOf}` : '';
  return {
    amount: formatUsd(usage.usd),
    recording: true,
    since: since ? `Since ${since}` : '',
    caveat: `Estimate${rateNote}, from our own token counts. Not an invoice — it excludes discounts, free tiers and minimums.${usage.estimated_rates ? ' Some calls used a model with no listed rate and were priced at the Opus rate.' : ''}`,
    unpricedNote: usage.unpriced_providers.length > 0
      ? `${usage.unpriced_providers.join(', ')} usage is recorded but has no rate configured, so it is NOT included above.`
      : '',
  };
}

/** "12,481 calls · 4.2M in · 310k out" — the units behind the money. */
export function usageUnitsLine(usage: TenantUsageSummary): string {
  if (usage.calls === 0) return '';
  const totals = usage.providers.reduce(
    (acc, provider) => ({
      input: acc.input + count(provider.input_units) + count(provider.cache_write_units) + count(provider.cache_read_units),
      output: acc.output + count(provider.output_units),
    }),
    { input: 0, output: 0 },
  );
  const parts = [`${formatCount(usage.calls)} call${usage.calls === 1 ? '' : 's'}`];
  if (totals.input > 0) parts.push(`${compactUnits(totals.input)} in`);
  if (totals.output > 0) parts.push(`${compactUnits(totals.output)} out`);
  return parts.join(' · ');
}

/** Token counts run to millions, where exact digits stop being readable. */
export function compactUnits(value: number): string {
  const units = count(value);
  if (units >= 1_000_000) return `${(units / 1_000_000).toFixed(units >= 10_000_000 ? 0 : 1)}M`;
  if (units >= 1_000) return `${(units / 1_000).toFixed(units >= 10_000 ? 0 : 1)}k`;
  return String(units);
}

/**
 * The one-line activity summary under a list row. Compact by necessity — it
 * shares a 96px row with the name and the email — so it carries the three
 * numbers that actually separate one tenant from another.
 */
export function tenantActivityLine(stats: TenantAccountStats): string {
  const parts: string[] = [];
  const workspaces = count(stats.workspace_count);
  if (workspaces > 0) parts.push(`${workspaces} ${workspaces === 1 ? 'workspace' : 'workspaces'}`);
  if (stats.channel_count > 0) parts.push(`${formatCount(stats.channel_count)} ch`);
  if (stats.message_count > 0) parts.push(`${compactUnits(stats.message_count)} msgs`);
  if (stats.huddle_count > 0) parts.push(`${formatCount(stats.huddle_count)} huddles`);
  if (stats.agent_count > 0) parts.push(`${formatCount(stats.agent_count)} agents`);
  return parts.length > 0 ? parts.join(' · ') : 'No activity';
}

/**
 * The cost chip on a list row, or '' when there is nothing truthful to put
 * there. Empty rather than "$0.00" whenever no priced usage was recorded — an
 * unmetered account and a free one must not look the same.
 */
export function tenantCostChip(stats: TenantAccountStats): string {
  if (stats.usage.calls === 0) return '';
  if (stats.usage.usd <= 0) return `${formatCount(stats.usage.calls)} calls`;
  return formatUsd(stats.usage.usd);
}
