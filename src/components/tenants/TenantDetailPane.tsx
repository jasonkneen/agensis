import { ArrowLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MICRO_LABEL, PANE_HEADER, SCROLL_VIEWPORT_BLOCK, TEXT_BODY, TEXT_META } from '../inbox/inboxPresentation';
import {
  buildTenantInventorySections,
  buildTenantWorkspaceRow,
  tenantIdentityHeader,
  tenantInitials,
  tenantJoinedLabel,
  tenantTileColor,
  type TenantAccount,
  type TenantAccountDetail,
  type TenantInventorySection,
  type TenantMemberWorkspace,
  type TenantWorkspace,
} from '../../lib/tenants';
import {
  buildActivityStats,
  buildCostSummary,
  compactUnits,
  formatCount,
  formatStatDate,
  formatUsd,
  normalizeStats,
  usageUnitsLine,
  type TenantMeteringWindow,
} from '../../lib/tenantStats';

// ---------------------------------------------------------------------------
// The account pane. Same 36px header band as the list, so the two line up
// pixel-for-pixel across the divider (the single most noticeable thing about a
// two-pane layout built carelessly — see InboxDetailPane).
//
// Reading order is deliberate: WHO (identity), then WHAT IT COSTS, then WHAT
// THEY DO (activity), then WHAT THEY HAVE (workspaces owned, then workspaces
// they were invited into), then the ids an operator needs to paste into a query
// or a support thread.
//
// Cost is second because it is the question this pane was rebuilt to answer.
// It is also the only block on the surface that can actively mislead, so every
// string in it comes from `buildCostSummary` — which is required to distinguish
// "not recording", "recording, nothing seen", and "a figure, since a date" —
// rather than from a `usd > 0 ?` ternary written inline here.
//
// The "Account actions" block is EMPTY on purpose and says so. Upgrading a plan
// and adding credits land there; leaving the space visible and labelled means
// the layout does not have to be re-cut when they arrive, and nobody mistakes
// this pass for a surface that can already change an account. Every tenant route
// is read-only today.
// ---------------------------------------------------------------------------

interface TenantDetailPaneProps {
  /** The row that was clicked — renders the header before the fetch lands. */
  account: TenantAccount;
  detail: TenantAccountDetail | null;
  loading: boolean;
  error: string | null;
  /** When metering began. Nulls mean it has not — never rendered as zero spend. */
  metering: TenantMeteringWindow | null;
  /** Container-query class that reveals the back arrow in single-column mode. */
  backButtonClass?: string;
  onClose: () => void;
}

export function TenantDetailPane({
  account,
  detail,
  loading,
  error,
  metering,
  backButtonClass,
  onClose,
}: TenantDetailPaneProps) {
  // The detail response is authoritative once it lands; the clicked row is what
  // holds the header steady until then.
  const shown = detail?.account ?? account;
  const { title, subtitle } = tenantIdentityHeader(shown);
  const stats = normalizeStats(shown.stats);
  // Empty sections are kept — "no documents" is an answer. A null inventory
  // (schema older than these tables) yields none at all, because there the
  // honest answer is "unknown", not "none".
  const inventorySections = buildTenantInventorySections(detail?.inventory);
  const owned = detail?.owned_workspaces ?? [];
  const shared = detail?.member_workspaces ?? [];
  const meteringWindow = detail?.metering ?? metering ?? null;
  const cost = buildCostSummary(stats.usage, meteringWindow);
  const units = usageUnitsLine(stats.usage);

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
              opening an account should feel like the row grew. The second line is
              the EMAIL when there is a display name, and the account's facts when
              the email is already the title: never the title repeated. */}
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-xs font-semibold tracking-tight text-white"
              style={{ backgroundColor: tenantTileColor(shown) }}
            >
              {tenantInitials(shown)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-5 text-foreground">{title}</div>
              <div className={cn('mt-0.5 break-words leading-4 text-muted-foreground', TEXT_META)}>
                {subtitle}
              </div>
            </div>
          </div>

          <CostBlock cost={cost} units={units} providers={stats.usage.providers} />

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
              <ActivityBlock stats={stats} />
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
              {inventorySections.map(section => (
                <InventoryGroup key={section.id} section={section} />
              ))}
            </>
          )}

          {/* Where "Upgrade plan" and "Add credits" go. Deliberately inert. */}
          <div className="rounded-md border border-dashed border-border/70 px-2.5 py-2">
            <div className={cn(MICRO_LABEL, 'mb-1')}>Account actions</div>
            <p className={cn('leading-snug text-muted-foreground', TEXT_META)}>
              Plan changes and credits arrive here. This view is read-only — nothing on it can
              alter an account.
            </p>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-xs">
            <dt className="text-muted-foreground">Account id</dt>
            <dd className="min-w-0 break-all font-mono text-[0.7rem] text-foreground/80">{shown.id}</dd>
            <dt className="text-muted-foreground">Registered</dt>
            <dd className="min-w-0 text-foreground/80">{tenantJoinedLabel(shown.created_at) || 'Unknown'}</dd>
            <dt className="text-muted-foreground">Last active</dt>
            <dd className="min-w-0 text-foreground/80">{formatStatDate(stats.last_activity_at) || 'Never'}</dd>
          </dl>
        </div>
      </ScrollArea>
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * What this account has cost, and everything that qualifies that number.
 *
 * The caveat line is NOT optional decoration: the figure is our own token count
 * times a hand-maintained list price, over a window that starts the day
 * metering was switched on. Rendering the amount without it would present an
 * estimate as a bill and a partial window as an all-time total.
 */
function CostBlock({
  cost,
  units,
  providers,
}: {
  cost: ReturnType<typeof buildCostSummary>;
  units: string;
  providers: ReturnType<typeof normalizeStats>['usage']['providers'];
}) {
  return (
    <div className="rounded-md border border-border/70 bg-muted/25 px-2.5 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <div className={cn(MICRO_LABEL, 'flex-1')}>Estimated spend</div>
        {cost.since && (
          <span className={cn('shrink-0 text-muted-foreground/80', TEXT_META)}>{cost.since}</span>
        )}
      </div>
      <div className="mt-1 flex min-w-0 items-baseline gap-2">
        <span className="text-lg font-semibold leading-6 tabular-nums tracking-tight text-foreground">
          {cost.amount}
        </span>
        {units && (
          <span className={cn('min-w-0 truncate text-muted-foreground', TEXT_META)}>{units}</span>
        )}
      </div>

      {providers.length > 0 && (
        <div className="mt-2 flex min-w-0 flex-col gap-0.5">
          {providers.map(provider => (
            <div key={provider.provider} className={cn('flex min-w-0 items-baseline gap-2', TEXT_META)}>
              <span className="min-w-0 flex-1 truncate capitalize text-foreground/80">{provider.provider}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {compactUnits(provider.input_units + provider.cache_read_units + provider.cache_write_units)} in
                {' · '}
                {compactUnits(provider.output_units)} out
              </span>
              <span className="w-16 shrink-0 text-right tabular-nums text-foreground/80">
                {/* A metered-but-unpriced provider shows a dash, not $0.00 — its
                    spend is real and simply is not in the total above. */}
                {provider.priced ? formatUsd(provider.usd) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}

      {cost.unpricedNote && (
        <p className={cn('mt-2 leading-snug text-amber-600 dark:text-amber-400', TEXT_META)}>
          {cost.unpricedNote}
        </p>
      )}
      <p className={cn('mt-1.5 leading-snug text-muted-foreground/80', TEXT_META)}>{cost.caveat}</p>
    </div>
  );
}

/**
 * The activity grid. Two columns of tiles, all always present — a grid whose
 * tiles appear and disappear cannot be read down a column, and a zero is an
 * answer.
 */
function ActivityBlock({ stats }: { stats: ReturnType<typeof normalizeStats> }) {
  const items = buildActivityStats(stats);
  return (
    <div className="flex min-w-0 flex-col">
      <div className={cn(MICRO_LABEL, 'mb-1.5')}>
        Activity{stats.workspace_count > 0 ? ` (${formatCount(stats.workspace_count)} owned workspaces)` : ''}
      </div>
      {/* TWO columns at every width, deliberately. The pane's floor is 18rem
          (MIN_DETAIL_REM), and a third column there gives each tile ~5.5rem —
          too narrow for a value and a detail line. The container query that
          would fix that is on the WINDOW, not this pane, so it would widen the
          grid at exactly the sizes where the pane is at its narrowest. */}
      <div className="grid grid-cols-2 gap-1.5">
        {items.map(item => (
          <div key={item.label} className="min-w-0 rounded-md border border-border/60 px-2 py-1.5">
            <div className={cn('truncate text-muted-foreground', TEXT_META)}>{item.label}</div>
            <div className={cn('mt-0.5 truncate font-semibold leading-5 tabular-nums text-foreground', TEXT_BODY)}>
              {item.value}
            </div>
            {item.detail && (
              <div className={cn('mt-0.5 truncate leading-4 text-muted-foreground/80', TEXT_META)} title={item.detail}>
                {item.detail}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

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
                    {row.cost && (
                      <span className={cn('ml-auto shrink-0 tabular-nums text-muted-foreground', TEXT_META)}>
                        {row.cost}
                      </span>
                    )}
                  </div>
                  <div className={cn('min-w-0 truncate leading-4 text-muted-foreground', TEXT_META)}>
                    {row.detail}
                  </div>
                  {row.activity && (
                    <div className={cn('min-w-0 truncate leading-4 text-muted-foreground/80', TEXT_META)}>
                      {row.activity}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * One inventory list: skills, documents, memory, agent files, or tasks.
 *
 * Metadata only, by construction — TenantInventoryRow carries a title and a
 * detail line and has nowhere to put a body even if the server sent one.
 * The count in the label is the TRUE total; when the list is capped the footer
 * says so, so a truncated view is never mistaken for a complete one.
 */
function InventoryGroup({ section }: { section: TenantInventorySection }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className={cn(MICRO_LABEL, 'mb-1.5')}>{`${section.label} (${section.total})`}</div>
      {section.rows.length === 0 ? (
        <p className={cn('leading-snug text-muted-foreground', TEXT_META)}>{section.emptyLabel}</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-0.5">
          {section.rows.map(row => (
            <div key={row.key} className="flex min-w-0 flex-col rounded-md px-1 py-1.5 hover:bg-muted/50">
              <span className={cn('min-w-0 truncate font-medium text-foreground', TEXT_BODY)}>
                {row.title}
              </span>
              {row.detail && (
                <span className={cn('min-w-0 truncate text-muted-foreground', TEXT_META)}>
                  {row.detail}
                </span>
              )}
            </div>
          ))}
          {section.truncated && (
            <p className={cn('px-1 pt-1 leading-snug text-muted-foreground', TEXT_META)}>
              {`Showing ${section.rows.length} of ${section.total}.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
