import { workspaceTileColor } from './workspaceRail';

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
}

/** A workspace the account belongs to but does not own. */
export interface TenantMemberWorkspace extends TenantWorkspace {
  role: string;
  owner_email: string;
}

export interface TenantAccountDetail {
  account: TenantAccount;
  owned_workspaces: TenantWorkspace[];
  member_workspaces: TenantMemberWorkspace[];
}

export interface TenantListPayload {
  accounts: TenantAccount[];
  total: number;
  truncated: boolean;
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

export interface TenantRowModel {
  account: TenantAccount;
  /** Display name, or the email when there is none. */
  title: string;
  /** The email — always shown, even when it is also the title's source. */
  subtitle: string;
  /** "3 workspaces · 2 shared". */
  summary: string;
  /** Right-aligned join date. */
  joined: string;
  initials: string;
  color: string;
}

/**
 * The list, filtered, sorted and pre-formatted. One function so the component
 * never does any of it inline — and so "what does a row say" is a thing with a
 * test rather than a thing spread across JSX.
 */
export function buildTenantRows(accounts: readonly TenantAccount[], query = ''): TenantRowModel[] {
  return sortTenants(filterTenants(accounts, query)).map(account => ({
    account,
    title: tenantDisplayName(account),
    subtitle: String(account.email || ''),
    summary: tenantSummaryLine(account),
    joined: tenantJoinedLabel(account.created_at),
    initials: tenantInitials(account),
    color: tenantTileColor(account),
  }));
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
  initials: string;
  color: string;
  isSystem: boolean;
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
  return {
    workspace,
    name: String(workspace.name || '').trim() || 'Untitled workspace',
    detail: parts.join(' · '),
    initials: tenantWorkspaceInitials(workspace),
    color: workspaceTileColor({ id: workspace.id, name: workspace.name }),
    isSystem: workspace.is_system === true,
  };
}
