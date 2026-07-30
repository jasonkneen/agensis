import { workspaceTileColor } from './workspaceRail';
import {
  compactUnits,
  formatDuration,
  formatStatDate,
  formatUsd,
  normalizeStats,
  normalizeUsage,
  tenantActivityLine,
  tenantCostChip,
  type TenantAccountStats,
  type TenantActivityStats,
  type TenantMeteringWindow,
  type TenantUsageSummary,
} from './tenantStats';

// ---------------------------------------------------------------------------
// Tenants — the owner-only view of every account on the deployment.
//
// This file is the whole of the surface's LOGIC: what a row says, what a search
// matches, how the workspaces under an account are grouped. No React, no DOM,
// no fetch — so the list can be reasoned about (and tested) without rendering
// anything, which matters more here than usual because the data being shaped is
// other people's.
//
// What it deliberately does NOT contain: any notion of who is allowed to see
// it. Hiding the button is cosmetic and lives in the component; the access
// control is `assertSystemOwner` in shared/tenant-admin.cjs, on the server, on
// both backends. If this module ever grows an `isOwner` helper the client acts
// on alone, that is the bug.
//
// SEARCH is client-side over the whole loaded list. The route returns the
// accounts (capped, with the true total alongside), so filtering costs no
// round-trip and cannot get out of step with a second server-side matcher.
// ---------------------------------------------------------------------------

export interface TenantAccount {
  id: string;
  email: string;
  display_name: string;
  accent_color: string;
  created_at: string | null;
  owned_workspace_count: number;
  membership_count: number;
  /** Activity + recorded spend, summed across the workspaces this account OWNS. */
  stats?: TenantAccountStats;
}

export interface TenantWorkspace {
  id: string;
  name: string;
  icon: string;
  is_system: boolean;
  parent_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  member_count: number;
  agent_count: number;
  /** Present on OWNED workspaces only — see the note on member_workspaces. */
  stats?: TenantActivityStats;
  usage?: TenantUsageSummary;
}

/** A workspace the account belongs to but does not own. */
export interface TenantMemberWorkspace extends TenantWorkspace {
  role: string;
  owner_email: string;
}

/** One capped list plus the true total, so a truncated view never reads as complete. */
export interface TenantInventoryList<T> {
  items: T[];
  total: number;
}

export interface TenantSkillItem {
  id: string;
  workspace_id: string;
  workspace_name: string;
  agent_name: string | null;
  skill: string;
  summary: string;
  byte_size: number;
  last_synced: string | null;
}

export interface TenantDocumentItem {
  id: string;
  workspace_id: string;
  workspace_name: string;
  title: string;
  folder: string;
  is_favorite: boolean;
  updated_at: string | null;
}

/** Workspace knowledge, grouped by category. Fact TEXT is deliberately absent. */
export interface TenantMemoryItem {
  workspace_id: string;
  workspace_name: string;
  category: string;
  fact_count: number;
  last_updated: string | null;
}

/** An agent's own file mirror — path and size, never content_cache. */
export interface TenantMemoryFileItem {
  id: string;
  workspace_id: string;
  workspace_name: string;
  agent_name: string | null;
  path: string;
  kind: string;
  summary: string;
  byte_size: number;
  last_synced: string | null;
}

export interface TenantTaskItem {
  id: string;
  workspace_id: string;
  workspace_name: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  updated_at: string | null;
}

/**
 * What an account HAS. Identifying metadata only — no document bodies, no skill
 * bodies, no memory fact text, no agent file contents. The server does not
 * select them; this type not having the fields is the second reminder.
 *
 * `null` when the deployment's schema predates one of these tables — the pane
 * degrades to what it showed before rather than erroring.
 */
export interface TenantInventory {
  skills: TenantInventoryList<TenantSkillItem>;
  documents: TenantInventoryList<TenantDocumentItem>;
  memories: TenantInventoryList<TenantMemoryItem>;
  memory_files: TenantInventoryList<TenantMemoryFileItem>;
  tasks: TenantInventoryList<TenantTaskItem>;
}

export interface TenantAccountDetail {
  account: TenantAccount;
  owned_workspaces: TenantWorkspace[];
  member_workspaces: TenantMemberWorkspace[];
  metering?: TenantMeteringWindow;
  inventory?: TenantInventory | null;
}

export interface TenantListPayload {
  accounts: TenantAccount[];
  total: number;
  truncated: boolean;
  /** When cost metering began. There is NO usage data before it — see tenantStats.ts. */
  metering?: TenantMeteringWindow;
}

/**
 * What to call an account. The email is the identity — it is what the operator
 * searched for and what they will paste into a support thread — so a blank
 * display name falls back to it rather than to "Unknown".
 */
export function tenantDisplayName(account: Pick<TenantAccount, 'display_name' | 'email'>): string {
  const name = String(account.display_name || '').trim();
  if (name) return name;
  const email = String(account.email || '').trim();
  return email || 'Unnamed account';
}

/**
 * Up to two initials, on the solid tile colour. Letters and digits only, so an
 * address like `+support@…` or `_jason@…` still yields something legible rather
 * than punctuation. NEVER an emoji or an icon — see the house rule.
 */
export function tenantInitials(account: Pick<TenantAccount, 'display_name' | 'email'>): string {
  const source = tenantDisplayName(account);
  const words = source
    .replace(/@.*$/, '')       // an email reduces to its local part
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/**
 * The account's tile colour — the same hash-to-palette function the workspace
 * rail uses, so an account and its workspaces are coloured by one system rather
 * than two. Keyed on id + email, which are both stable.
 */
export function tenantTileColor(account: Pick<TenantAccount, 'id' | 'email'>): string {
  return workspaceTileColor({ id: account.id, name: account.email });
}

/**
 * Everything a search may match, lowercased. Id is included so an operator can
 * paste a uuid out of a log or a URL and land on the account — the single most
 * common way anyone arrives at a support question.
 */
export function tenantSearchText(account: TenantAccount): string {
  return [account.email, account.display_name, account.id]
    .map(part => String(part || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

/**
 * Substring match on every whitespace-separated term, so "jason bounc" finds
 * `jason@bouncingfish.com` regardless of the order the terms were typed. An
 * empty query matches everything.
 */
export function matchesTenantSearch(account: TenantAccount, query: string): boolean {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = tenantSearchText(account);
  return terms.every(term => haystack.includes(term));
}

export function filterTenants(accounts: readonly TenantAccount[], query: string): TenantAccount[] {
  return accounts.filter(account => matchesTenantSearch(account, query));
}

/**
 * Newest account first. An operator's list is read as "who has signed up", and
 * the answer to that is at the top. Ties (and unparseable dates) fall back to
 * the id so the order is total and a re-render never reshuffles rows under the
 * pointer.
 */
export function sortTenants(accounts: readonly TenantAccount[]): TenantAccount[] {
  return [...accounts].sort((a, b) => {
    const left = Date.parse(String(a.created_at || ''));
    const right = Date.parse(String(b.created_at || ''));
    const leftValid = Number.isFinite(left);
    const rightValid = Number.isFinite(right);
    if (leftValid && rightValid && left !== right) return right - left;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** "3 workspaces · 2 shared" — the size of the tenant in one line. */
export function tenantSummaryLine(account: TenantAccount): string {
  const owned = Math.max(0, account.owned_workspace_count || 0);
  const shared = Math.max(0, account.membership_count || 0);
  const parts = [`${owned} ${owned === 1 ? 'workspace' : 'workspaces'}`];
  if (shared > 0) parts.push(`${shared} shared`);
  return parts.join(' · ');
}

/**
 * Absolute, never relative. Same rule as the inbox list: this app runs no
 * timers, so "3 months ago" is a label that silently rots while the window
 * stays open. A date cannot.
 */
export function tenantJoinedLabel(iso: string | null): string {
  const parsed = Date.parse(String(iso || ''));
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * WHO this account is, in two lines that never say the same thing twice.
 *
 * The bug this replaces: the title fell back to the email when there was no
 * display name, and the line under it was the email unconditionally — so the
 * overwhelmingly common case (nobody sets a display name) rendered
 * `user@example.com` as the heading AND as the subheading, using the
 * pane's most valuable two lines to say one thing.
 *
 * The rule is that line two must carry information line one does not:
 *   * named account   -> title is the name, subtitle is the email
 *   * unnamed account -> title is the email, subtitle is the FACTS (registered,
 *                        last active, size) — the things an operator opened the
 *                        account to find out
 *
 * There is no plan/tier in the data model yet. When one arrives it belongs at
 * the front of the fact list, and nothing else here has to change.
 */
export function tenantIdentityHeader(account: TenantAccount): { title: string; subtitle: string } {
  const title = tenantDisplayName(account);
  const email = String(account.email || '').trim();
  if (email && email !== title) return { title, subtitle: email };

  const stats = normalizeStats(account.stats);
  const facts: string[] = [];
  const joined = tenantJoinedLabel(account.created_at);
  if (joined) facts.push(`Registered ${joined}`);
  const lastActive = formatStatDate(stats.last_activity_at);
  if (lastActive) facts.push(`last active ${lastActive}`);
  // The workspace count goes here ONLY when the activity line will not carry
  // it — that line opens with it whenever there is one, and printing it in both
  // places is the same duplication this function exists to remove, moved down a
  // row. `stats.workspace_count === 0` is exactly the case where the activity
  // line has nothing to say (including a response from before stats existed).
  if (stats.workspace_count === 0 || facts.length === 0) {
    const owned = Math.max(0, account.owned_workspace_count || 0);
    facts.push(`${owned} ${owned === 1 ? 'workspace' : 'workspaces'}`);
  }
  return { title, subtitle: facts.join(' · ') };
}

export interface TenantRowModel {
  account: TenantAccount;
  /** Display name, or the email when there is none. */
  title: string;
  /** Never a repeat of the title — the email, or the account's facts. */
  subtitle: string;
  /** "3 workspaces · 2 shared". */
  summary: string;
  /** "12 ch · 1.2k msgs · 4 huddles" — what this tenant actually uses. */
  activity: string;
  /** Estimated spend since metering started, or '' when there is none to show. */
  cost: string;
  /** Right-aligned join date. */
  joined: string;
  initials: string;
  color: string;
  stats: TenantAccountStats;
}

/**
 * The list, filtered, sorted and pre-formatted. One function so the component
 * never does any of it inline — and so "what does a row say" is a thing with a
 * test rather than a thing spread across JSX.
 */
export function buildTenantRows(accounts: readonly TenantAccount[], query = ''): TenantRowModel[] {
  return sortTenants(filterTenants(accounts, query)).map(account => {
    const stats = normalizeStats(account.stats);
    const { title, subtitle } = tenantIdentityHeader(account);
    return {
      account,
      title,
      subtitle,
      summary: tenantSummaryLine(account),
      activity: tenantActivityLine(stats),
      cost: tenantCostChip(stats),
      joined: tenantJoinedLabel(account.created_at),
      initials: tenantInitials(account),
      color: tenantTileColor(account),
      stats,
    };
  });
}

/**
 * Deployment-wide totals for the list footer. Summed from the SAME per-account
 * blocks the rows render, so the footer can never disagree with the column
 * above it — and computed over the LOADED accounts, which is why the footer
 * also states how many that is.
 */
export function tenantDeploymentTotals(accounts: readonly TenantAccount[]): {
  messages: number;
  huddles: number;
  usd: number;
  calls: number;
  unpricedProviders: string[];
} {
  const unpriced = new Set<string>();
  let messages = 0;
  let huddles = 0;
  let usd = 0;
  let calls = 0;
  for (const account of accounts) {
    const stats = normalizeStats(account.stats);
    messages += stats.message_count;
    huddles += stats.huddle_count;
    usd += stats.usage.usd;
    calls += stats.usage.calls;
    for (const provider of stats.usage.unpriced_providers) unpriced.add(provider);
  }
  return {
    messages,
    huddles,
    usd: Math.round(usd * 1e6) / 1e6,
    calls,
    unpricedProviders: [...unpriced].sort(),
  };
}

/** The two lines shown when the filtered list is empty. */
export function tenantsEmptyState(query: string, total: number): { title: string; description: string } {
  if (String(query || '').trim()) {
    return {
      title: 'No matching accounts',
      description: 'Search matches an email address, a display name or an account id.',
    };
  }
  if (total === 0) {
    return {
      title: 'No accounts yet',
      description: 'Every account that signs up appears here.',
    };
  }
  return { title: 'Nothing to show', description: 'The account list came back empty.' };
}

/** "Showing 500 of 1,284 accounts" — only when the route actually capped it. */
export function tenantCountLabel(shown: number, total: number, truncated: boolean): string {
  if (truncated) return `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} accounts`;
  return `${total.toLocaleString()} ${total === 1 ? 'account' : 'accounts'}`;
}

/**
 * The line under the list. Two facts, and it must not conflate them: how many
 * rows the search left, and how much of the deployment is loaded at all. Saying
 * "3 accounts" while a search is active would misreport the deployment's size to
 * the one person whose job is to know it.
 */
export function tenantListFooter(
  shown: number,
  loaded: number,
  total: number,
  truncated: boolean,
  query: string,
): string {
  const base = tenantCountLabel(loaded, total, truncated);
  if (!String(query || '').trim()) return base;
  return `${shown.toLocaleString()} matching · ${base}`;
}

export interface TenantWorkspaceRowModel {
  workspace: TenantWorkspace;
  name: string;
  /** "4 members · 2 agents", plus the owner's email for a shared workspace. */
  detail: string;
  /** "18 ch · 4.2k msgs · 2h 10m huddles" — '' on a shared workspace. */
  activity: string;
  /** Estimated spend for this workspace, or '' when there is none to show. */
  cost: string;
  initials: string;
  color: string;
  isSystem: boolean;
}

/**
 * What one OWNED workspace is doing, as a line. Empty for a shared workspace:
 * its activity and its bill belong to the account that owns it, and repeating
 * the numbers under a member would let one workspace's spend be read twice.
 */
export function tenantWorkspaceActivityLine(workspace: TenantWorkspace): string {
  if (!workspace.stats) return '';
  const stats = workspace.stats;
  const parts: string[] = [];
  if (stats.channel_count > 0) parts.push(`${stats.channel_count} ch`);
  if (stats.message_count > 0) parts.push(`${compactUnits(stats.message_count)} msgs`);
  if (stats.agent_message_count > 0) parts.push(`${compactUnits(stats.agent_message_count)} by agents`);
  if (stats.huddle_count > 0) {
    const time = formatDuration(stats.huddle_seconds);
    parts.push(`${stats.huddle_count} huddle${stats.huddle_count === 1 ? '' : 's'}${time ? ` (${time})` : ''}`);
  }
  if (stats.document_count > 0) parts.push(`${stats.document_count} docs`);
  return parts.length > 0 ? parts.join(' · ') : 'No activity';
}

/** Workspace tiles use initials too — the icon column is text, never an emoji. */
export function tenantWorkspaceInitials(workspace: Pick<TenantWorkspace, 'name'>): string {
  const words = String(workspace.name || '').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export function buildTenantWorkspaceRow(
  workspace: TenantWorkspace | TenantMemberWorkspace,
): TenantWorkspaceRowModel {
  const members = Math.max(0, workspace.member_count || 0);
  const agents = Math.max(0, workspace.agent_count || 0);
  const parts = [
    `${members} ${members === 1 ? 'member' : 'members'}`,
    `${agents} ${agents === 1 ? 'agent' : 'agents'}`,
  ];
  const role = 'role' in workspace ? String(workspace.role || '').trim() : '';
  if (role) parts.unshift(role);
  const ownerEmail = 'owner_email' in workspace ? String(workspace.owner_email || '').trim() : '';
  if (ownerEmail) parts.push(ownerEmail);
  const usage = normalizeUsage(workspace.usage);
  return {
    workspace,
    name: String(workspace.name || '').trim() || 'Untitled workspace',
    detail: parts.join(' · '),
    activity: tenantWorkspaceActivityLine(workspace),
    // Blank, never "$0.00", when nothing was recorded — an unmetered workspace
    // and a genuinely free one must not read the same.
    cost: usage.calls === 0 ? '' : (usage.usd > 0 ? formatUsd(usage.usd) : `${usage.calls} calls`),
    initials: tenantWorkspaceInitials(workspace),
    color: workspaceTileColor({ id: workspace.id, name: workspace.name }),
    isSystem: workspace.is_system === true,
  };
}

// ---------------------------------------------------------------------------
// Inventory rows — what an account HAS.
//
// Pure shaping only, same as everything above: the pane renders what these
// return and holds no formatting of its own. None of these can surface a body,
// because the types they take do not carry one.
// ---------------------------------------------------------------------------

export interface TenantInventoryRow {
  key: string;
  /** The thing's own name — a skill, a document title, a task title, a path. */
  title: string;
  /** Where it lives and anything qualifying it, already joined with ' · '. */
  detail: string;
}

export interface TenantInventorySection {
  id: 'skills' | 'documents' | 'memories' | 'memory_files' | 'tasks';
  label: string;
  total: number;
  rows: TenantInventoryRow[];
  /** True when `total` exceeds what the server sent, so the UI can say so. */
  truncated: boolean;
  /** What to show instead of rows when there are none. */
  emptyLabel: string;
}

function bytesLabel(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value === 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function joinDetail(parts: Array<string | number | null | undefined>): string {
  return parts
    .map(part => (part === null || part === undefined ? '' : String(part).trim()))
    .filter(Boolean)
    .join(' · ');
}

/**
 * Every inventory section, in a fixed order, INCLUDING the empty ones.
 *
 * Empty sections are kept deliberately: "this account has no documents" is an
 * answer, and a pane that silently omits the section leaves the reader unsure
 * whether it was empty or never loaded. `null` inventory (schema too old) is the
 * one case that returns nothing at all, because there the answer is unknown.
 */
export function buildTenantInventorySections(
  inventory: TenantInventory | null | undefined,
): TenantInventorySection[] {
  if (!inventory) return [];
  const section = <T,>(
    id: TenantInventorySection['id'],
    label: string,
    list: TenantInventoryList<T> | undefined,
    emptyLabel: string,
    row: (item: T, index: number) => TenantInventoryRow,
  ): TenantInventorySection => {
    const items = Array.isArray(list?.items) ? list.items : [];
    // max(), not the raw total: a count query racing an insert can return fewer
    // than the rows already fetched, and "showing 5 of 0" is nonsense.
    const total = Math.max(items.length, Number(list?.total) || 0);
    return {
      id,
      label,
      total,
      rows: items.map(row),
      truncated: total > items.length,
      emptyLabel,
    };
  };

  return [
    section('skills', 'Skills', inventory.skills, 'No skills synced', (item, i) => ({
      key: item.id || `skill-${i}`,
      title: String(item.skill || '').trim() || 'Untitled skill',
      detail: joinDetail([item.workspace_name, item.agent_name, bytesLabel(item.byte_size)]),
    })),
    section('documents', 'Documents', inventory.documents, 'No documents', (item, i) => ({
      key: item.id || `doc-${i}`,
      title: String(item.title || '').trim() || 'Untitled',
      detail: joinDetail([item.workspace_name, item.folder, item.is_favorite ? 'Favourite' : '']),
    })),
    section('memories', 'Memory', inventory.memories, 'No memory facts', (item, i) => ({
      key: `${item.workspace_id}-${item.category}-${i}`,
      // The category IS the title here — the facts themselves are not sent.
      title: String(item.category || '').trim() || 'general',
      detail: joinDetail([
        item.workspace_name,
        `${item.fact_count} ${item.fact_count === 1 ? 'fact' : 'facts'}`,
      ]),
    })),
    section('memory_files', 'Agent memory files', inventory.memory_files, 'No agent memory files', (item, i) => ({
      key: item.id || `file-${i}`,
      title: String(item.path || '').trim() || 'Untitled file',
      detail: joinDetail([item.workspace_name, item.agent_name, item.kind, bytesLabel(item.byte_size)]),
    })),
    section('tasks', 'Tasks', inventory.tasks, 'No tasks', (item, i) => ({
      key: item.id || `task-${i}`,
      title: String(item.title || '').trim() || 'Untitled task',
      detail: joinDetail([item.workspace_name, item.status, item.priority]),
    })),
  ];
}
