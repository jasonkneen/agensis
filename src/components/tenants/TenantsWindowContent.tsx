import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useTenantDetail, useTenants } from '@/hooks/useTenants';
import {
  buildTenantRows,
  tenantCountLabel,
  tenantDisplayName,
  tenantInitials,
  tenantJoinedLabel,
  tenantTileColor,
  tenantsEmptyState,
  tenantWorkspaceInitials,
  type TenantAccount,
  type TenantWorkspace,
} from '@/lib/tenants';

// The Tenants admin surface: every registered account, searchable, with the
// selected one's detail beside it.
//
// Two panes, matching the inbox — roomy rows, no separators, one hairline
// between the panes. Density was explicitly rejected on the inbox and this is
// the same kind of list, so it gets the same treatment rather than becoming a
// data table.
//
// Rendering this at all is gated on the server's own answer (useTenantAccess),
// and every route re-checks. Nothing here is a security boundary.

export function TenantsWindowContent() {
  const { accounts, total, truncated, loading, error } = useTenants(true);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { detail, loading: detailLoading } = useTenantDetail(selectedId);

  const rows = useMemo(() => buildTenantRows(accounts, query), [accounts, query]);
  const empty = tenantsEmptyState(query, total);

  return (
    <div className="flex h-full min-h-0 text-foreground">
      <div className="flex min-h-0 w-[22rem] shrink-0 flex-col border-r border-border/60">
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search accounts"
            aria-label="Search accounts"
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {tenantCountLabel(rows.length, total, truncated)}
          </span>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {loading ? (
            <div className="flex flex-col gap-3 p-3">
              {[0, 1, 2, 3].map(n => (
                <div key={n} className="flex items-center gap-3">
                  <Skeleton className="size-9 shrink-0 rounded-md" />
                  <div className="min-w-0 flex-1"><Skeleton className="h-4 w-2/3" /></div>
                </div>
              ))}
            </div>
          ) : error ? (
            <p className="px-4 py-6 text-sm text-destructive">{error}</p>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8">
              <p className="text-sm font-semibold text-foreground">{empty.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{empty.description}</p>
            </div>
          ) : (
            rows.map(row => (
              <TenantRow
                key={row.account.id}
                account={row.account}
                selected={row.account.id === selectedId}
                onSelect={() => setSelectedId(row.account.id)}
              />
            ))
          )}
        </ScrollArea>
      </div>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!selectedId ? (
          <p className="m-auto text-sm text-muted-foreground">Choose an account to see its details.</p>
        ) : detailLoading || !detail ? (
          <div className="flex flex-col gap-3 p-5">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-40" />
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-6 p-5">
              <header className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-[9px] text-[15px] font-semibold text-white"
                  style={{ backgroundColor: tenantTileColor(detail.account) }}
                >
                  {tenantInitials(detail.account)}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{tenantDisplayName(detail.account)}</h2>
                  <p className="truncate text-sm text-muted-foreground">{detail.account.email}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Joined {tenantJoinedLabel(detail.account.created_at)}
                  </p>
                </div>
              </header>

              {/* Deliberately empty for now: upgrading an account and adding
                  credits land here once that layout is settled. Reserving the
                  space keeps the header from being rebuilt around them later. */}

              <TenantWorkspaceList
                title="Owns"
                workspaces={detail.owned_workspaces}
                emptyText="No workspaces of their own."
              />
              <TenantWorkspaceList
                title="Member of"
                workspaces={detail.member_workspaces}
                emptyText="Not a member of anyone else's workspace."
              />
            </div>
          </ScrollArea>
        )}
      </section>
    </div>
  );
}

function TenantRow({
  account,
  selected,
  onSelect,
}: {
  account: TenantAccount;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      // No separators. Padding plus the selected wash does the separating, the
      // way the inbox does it.
      className={cn(
        'flex w-full items-center gap-3 px-3 py-3 text-left transition-colors',
        selected ? 'bg-muted' : 'hover:bg-muted/60',
      )}
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-[8px] text-[12px] font-semibold text-white"
        style={{ backgroundColor: tenantTileColor(account) }}
      >
        {tenantInitials(account)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{tenantDisplayName(account)}</span>
        <span className="block truncate text-xs text-muted-foreground">{account.email}</span>
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {account.owned_workspace_count}
      </span>
    </button>
  );
}

function TenantWorkspaceList({
  title,
  workspaces,
  emptyText,
}: {
  title: string;
  workspaces: readonly TenantWorkspace[];
  emptyText: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title} <span className="tabular-nums">{workspaces.length}</span>
      </h3>
      {workspaces.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {workspaces.map(workspace => (
            <li key={workspace.id} className="flex items-center gap-2.5 rounded-md px-1 py-1.5 hover:bg-muted/50">
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-muted text-[11px] font-semibold text-muted-foreground"
              >
                {tenantWorkspaceInitials(workspace)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{workspace.name}</span>
                <span className="block truncate text-xs text-muted-foreground tabular-nums">
                  {workspace.member_count} members · {workspace.agent_count} agents
                </span>
              </span>
              {workspace.is_system && <Badge variant="secondary" className="shrink-0">System</Badge>}
              {workspace.parent_id && <Badge variant="outline" className="shrink-0">Child</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
