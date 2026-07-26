import { ArrowLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MICRO_LABEL, PANE_HEADER, SCROLL_VIEWPORT_BLOCK, TEXT_BODY, TEXT_META } from '../inbox/inboxPresentation';
import {
  buildTenantWorkspaceRow,
  tenantDisplayName,
  tenantInitials,
  tenantJoinedLabel,
  tenantTileColor,
  type TenantAccount,
  type TenantAccountDetail,
  type TenantMemberWorkspace,
  type TenantWorkspace,
} from '../../lib/tenants';

// ---------------------------------------------------------------------------
// The account pane. Same 36px header band as the list, so the two line up
// pixel-for-pixel across the divider (the single most noticeable thing about a
// two-pane layout built carelessly — see InboxDetailPane).
//
// Reading order is deliberate: WHO (identity), then WHAT THEY HAVE (workspaces
// they own, then workspaces they were invited into), then the ids an operator
// needs to paste into a query or a support thread.
//
// The "Account actions" block near the top is EMPTY on purpose and says so.
// Upgrading a plan and adding credits land there; leaving the space visible and
// labelled means the layout does not have to be re-cut when they arrive, and
// nobody mistakes this pass for a surface that can already change an account.
// Every tenant route is read-only today.
// ---------------------------------------------------------------------------

interface TenantDetailPaneProps {
  /** The row that was clicked — renders the header before the fetch lands. */
  account: TenantAccount;
  detail: TenantAccountDetail | null;
  loading: boolean;
  error: string | null;
  /** Container-query class that reveals the back arrow in single-column mode. */
  backButtonClass?: string;
  onClose: () => void;
}

export function TenantDetailPane({
  account,
  detail,
  loading,
  error,
  backButtonClass,
  onClose,
}: TenantDetailPaneProps) {
  const title = tenantDisplayName(account);
  const owned = detail?.owned_workspaces ?? [];
  const shared = detail?.member_workspaces ?? [];

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <header className={PANE_HEADER}>
        {backButtonClass && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn('shrink-0', backButtonClass)}
            onClick={onClose}
            aria-label="Back to the account list"
          >
            <ArrowLeft />
          </Button>
        )}
        <span className="min-w-0 truncate text-sm font-semibold leading-5 tracking-tight text-foreground">
          {title}
        </span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          onClick={onClose}
          aria-label="Close account detail"
        >
          <X />
        </Button>
      </header>

      <ScrollArea className={cn('min-h-0 flex-1', SCROLL_VIEWPORT_BLOCK)}>
        <div className="flex min-w-0 flex-col gap-4 px-3 py-3">
          {/* Same tile, same left edge, same type sizes as the row it came from —
              opening an account should feel like the row grew. */}
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-xs font-semibold tracking-tight text-white"
              style={{ backgroundColor: tenantTileColor(account) }}
            >
              {tenantInitials(account)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-5 text-foreground">{title}</div>
              <div className={cn('mt-0.5 break-words leading-4 text-muted-foreground', TEXT_META)}>
                {account.email}
              </div>
            </div>
          </div>

          {/* Where "Upgrade plan" and "Add credits" go. Deliberately inert. */}
          <div className="rounded-md border border-dashed border-border/70 px-2.5 py-2">
            <div className={cn(MICRO_LABEL, 'mb-1')}>Account actions</div>
            <p className={cn('leading-snug text-muted-foreground', TEXT_META)}>
              Plan changes and credits arrive here. This view is read-only — nothing on it can
              alter an account.
            </p>
          </div>

          {error && (
            <p role="alert" className={cn('leading-snug text-destructive', TEXT_META)}>
              {error}
            </p>
          )}

          {loading && !detail ? (
            <div className="flex flex-col gap-2" data-tenant-detail-skeleton="">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <>
              <WorkspaceGroup
                label={`Workspaces owned (${owned.length})`}
                workspaces={owned}
                empty="This account owns no workspaces."
              />
              <WorkspaceGroup
                label={`Shared with this account (${shared.length})`}
                workspaces={shared}
                empty="Not a member of anyone else's workspace."
              />
            </>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-xs">
            <dt className="text-muted-foreground">Account id</dt>
            <dd className="min-w-0 break-all font-mono text-[0.7rem] text-foreground/80">{account.id}</dd>
            <dt className="text-muted-foreground">Registered</dt>
            <dd className="min-w-0 text-foreground/80">{tenantJoinedLabel(account.created_at) || 'Unknown'}</dd>
          </dl>
        </div>
      </ScrollArea>
    </section>
  );
}

// ---------------------------------------------------------------------------

function WorkspaceGroup({
  label,
  workspaces,
  empty,
}: {
  label: string;
  workspaces: readonly (TenantWorkspace | TenantMemberWorkspace)[];
  empty: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className={cn(MICRO_LABEL, 'mb-1.5')}>{label}</div>
      {workspaces.length === 0 ? (
        <p className={cn('leading-snug text-muted-foreground', TEXT_META)}>{empty}</p>
      ) : (
        // No rules between entries, same as the list — the 6px gutter separates.
        <div className="flex min-w-0 flex-col gap-0.5">
          {workspaces.map(workspace => {
            const row = buildTenantWorkspaceRow(workspace);
            return (
              <div
                key={row.workspace.id}
                className="flex min-w-0 items-center gap-2.5 rounded-md px-1 py-1.5 hover:bg-muted/50"
              >
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-[0.65rem] font-semibold tracking-tight text-white"
                  style={{ backgroundColor: row.color }}
                >
                  {row.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn('flex min-w-0 items-center gap-1.5 leading-5', TEXT_BODY)}>
                    <span className="min-w-0 truncate font-medium text-foreground">{row.name}</span>
                    {row.isSystem && (
                      <span className={cn('shrink-0 rounded-[4px] bg-muted px-1 py-px font-medium text-muted-foreground/90', TEXT_META)}>
                        System
                      </span>
                    )}
                  </div>
                  <div className={cn('min-w-0 truncate leading-4 text-muted-foreground', TEXT_META)}>
                    {row.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
