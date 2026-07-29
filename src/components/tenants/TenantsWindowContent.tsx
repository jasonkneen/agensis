import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Megaphone, RotateCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  FOCUS_RING,
  LIST_COLUMN_CLASS,
  PANE_HEADER,
  ROW_PADDING,
  SCROLL_VIEWPORT_BLOCK,
  TEXT_BODY,
  TEXT_META,
} from '../inbox/inboxPresentation';
import { useSplitResize } from '../../hooks/useSplitResize';
import { useTenants } from '../../hooks/useTenants';
import {
  buildTenantRows,
  tenantDeploymentTotals,
  tenantListFooter,
  tenantsEmptyState,
  type TenantRowModel,
} from '../../lib/tenants';
import {
  compactUnits,
  formatStatDate,
  formatUsd,
  type TenantMeteringWindow,
} from '../../lib/tenantStats';
import { CampaignComposer } from './CampaignComposer';
import { TenantDetailPane } from './TenantDetailPane';
import { TenantRow } from './TenantRow';

// ---------------------------------------------------------------------------
// TENANTS — every registered account, and what each one has.
//
// The owner-only admin surface. Master-detail, borrowed wholesale from the inbox
// (InboxWindowContent): a searchable column of roomy rows on the left, the
// selected account on the right, ONE hairline between them, drag to resize, and
// a single-column fallback below 42rem where the detail replaces the list.
// Matching that language rather than inventing a third list style is the point —
// see inboxPresentation.ts for the type scale and row metrics.
//
// ACCESS CONTROL IS NOT HERE. Every route this window calls independently
// verifies the caller is the system owner (shared/tenant-admin.cjs,
// `assertSystemOwner`, on both backends). Rendering this component for a
// non-owner produces three 403s and an empty list, which is the correct
// outcome — the button being hidden is a nicety, not the control.
//
// Read-only by design in this pass. There is no action on this surface that can
// change anyone's account; where those will live is marked in the detail pane.
// ---------------------------------------------------------------------------

const DEFAULT_LIST_WIDTH = 340;
const MIN_LIST_WIDTH = 240;
const MAX_LIST_WIDTH = 520;
const LIST_WIDTH_KEY = 'agensis.tenants.list-width';

/** The detail pane's readability floor, in rem — see InboxWindowContent. */
const MIN_DETAIL_REM = 18;

function minDetailPx(): number {
  if (typeof document === 'undefined') return MIN_DETAIL_REM * 16;
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return MIN_DETAIL_REM * (Number.isFinite(root) && root > 0 ? root : 16);
}

/**
 * Below 42rem two panes cannot both hold a readable column, so the list goes
 * full width and the detail replaces it. A container query on the window, not a
 * media query: this lives in a floating window whose width has nothing to do
 * with the viewport's. Written out in full because Tailwind scans source text
 * and never sees a concatenated class name.
 */
const SINGLE_COLUMN_HIDE = '@max-2xl/tenantswin:hidden';

/**
 * The list pane's width, as CLASSES driven by a custom property rather than an
 * inline `width` — so the single-column container query below can override it
 * in the ordinary cascade instead of fighting an inline style with `!`. Same
 * shape as AgentsWindowContent's split pane.
 */
const LIST_PANE_WIDTH = [
  // The 18rem here IS MIN_DETAIL_REM — Tailwind scans source text, so it cannot
  // be interpolated. Change one and change the other.
  'w-[var(--tenants-list-width)] max-w-[calc(100%-18rem)]',
  '@max-2xl/tenantswin:w-full @max-2xl/tenantswin:max-w-none',
].join(' ');

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_LIST_WIDTH;
  try {
    const raw = Number(window.sessionStorage.getItem(LIST_WIDTH_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIST_WIDTH;
    return Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.round(raw)));
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

export const TenantsWindowContent = React.memo(function TenantsWindowContent() {
  const {
    accounts, total, truncated, metering, loading, error, refetch,
    detail, detailLoading, detailError, selectedId, select,
  } = useTenants(true);

  const [query, setQuery] = useState('');
  const [listWidth, setListWidth] = useState(readStoredWidth);
  // The composer is a MODE of this window rather than a dialog over it: it
  // replaces the master-detail entirely, because the thing it needs the room for
  // is the list of who matched.
  const [composing, setComposing] = useState(false);

  // Search and ordering are pure (src/lib/tenants.ts) and run over the loaded
  // list, so typing costs no round-trip and there is no second server-side
  // matcher to disagree with.
  const rows = useMemo(() => buildTenantRows(accounts, query), [accounts, query]);

  // Kept by ID, never by index: the list re-sorts on refetch and an index would
  // silently open a different person's account.
  const selected = useMemo(
    () => accounts.find(account => account.id === selectedId) ?? null,
    [accounts, selectedId],
  );

  // --- Drag-to-resize -------------------------------------------------------
  // The gesture is `useSplitResize` (pointer capture with its NotFoundError
  // guard, arrow keys, double-click to reset), shared with the inbox and the
  // Agents and Memory dividers. What stays local is what is specific to THIS
  // split: the clamp, read straight off the ref — no ResizeObserver, no state,
  // so a window drag still costs zero re-renders — and sessionStorage.
  const rootRef = useRef<HTMLDivElement | null>(null);

  const clampWidth = useCallback((value: number) => {
    const container = rootRef.current?.clientWidth ?? 0;
    const ceiling = container > 0
      ? Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, container - minDetailPx()))
      : MAX_LIST_WIDTH;
    return Math.min(ceiling, Math.max(MIN_LIST_WIDTH, Math.round(value)));
  }, []);

  const { handlers: resizeHandlers } = useSplitResize({
    axis: 'x',
    size: listWidth,
    clamp: clampWidth,
    // Clamped on the way in here, because the pane width IS this state — there
    // is no separate draft to re-derive from.
    onPreview: value => setListWidth(clampWidth(value)),
    onCommit: value => {
      setListWidth(value);
      try {
        window.sessionStorage.setItem(LIST_WIDTH_KEY, String(value));
      } catch {
        // Width is a nicety; a storage-denied browser just gets the default back.
      }
    },
    onReset: () => setListWidth(DEFAULT_LIST_WIDTH),
  });

  if (composing) {
    return (
      <div className="@container/tenantswin flex h-full min-h-0 bg-card text-card-foreground">
        <CampaignComposer accounts={accounts} onClose={() => setComposing(false)} />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="@container/tenantswin flex h-full min-h-0 bg-card text-card-foreground"
    >
      <section
        className={cn(
          'relative flex min-h-0 min-w-0 shrink-0 flex-col border-r border-border/60',
          LIST_PANE_WIDTH,
          // Only in single-column mode does an open account REPLACE the list.
          selected && SINGLE_COLUMN_HIDE,
        )}
        style={{ '--tenants-list-width': `${listWidth}px` } as React.CSSProperties}
      >
        <div className={PANE_HEADER}>
          {/* The search field IS the header. There is one filter on this surface
              and it is the only thing an operator arrives wanting. */}
          <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search accounts"
            aria-label="Search accounts by email, name or id"
            className={cn(
              'min-w-0 flex-1 bg-transparent leading-5 text-foreground placeholder:text-muted-foreground/70',
              'focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden',
              TEXT_BODY,
            )}
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              <X />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setComposing(true)}
            aria-label="Message accounts"
            title="Message accounts"
          >
            <Megaphone />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={refetch}
            aria-label="Refresh accounts"
            title="Refresh"
          >
            <RotateCw className={loading ? 'animate-spin' : undefined} />
          </Button>
        </div>

        <TenantList
          rows={rows}
          query={query}
          loaded={accounts.length}
          total={total}
          truncated={truncated}
          totals={tenantDeploymentTotals(accounts)}
          metering={metering}
          loading={loading}
          error={error}
          selectedId={selectedId}
          onSelect={select}
        />

        {/* An invisible 12px grab strip whose hairline only appears under the
            pointer — the divider is the pane border, not this. Present whenever
            both panes are, which is now every width above the single-column
            breakpoint, selection or not. */}
        <button
          type="button"
          aria-label="Resize account list"
          title="Drag to resize. Double-click to reset."
          {...resizeHandlers}
          className={cn(
            'group/resize absolute inset-y-0 -right-1.5 z-30 w-3 cursor-col-resize',
            SINGLE_COLUMN_HIDE,
            FOCUS_RING,
          )}
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-border group-focus-visible/resize:bg-border"
          />
        </button>
      </section>

      {selected ? (
        <TenantDetailPane
          account={selected}
          detail={detail}
          metering={metering}
          loading={detailLoading}
          error={detailError}
          /* The back arrow exists only when the detail has replaced the list. */
          backButtonClass="hidden @max-2xl/tenantswin:inline-flex"
          onClose={() => select(null)}
        />
      ) : (
        <TenantDetailPlaceholder />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------

/**
 * What sits where the account pane will be, before one is opened.
 *
 * It exists so this surface has the SAME two-pane geometry whether or not an
 * account is open. Before it, nothing selected meant the list pane was
 * `flex-1` — and the row column inside it is capped at `LIST_COLUMN_CLASS`'s
 * 42rem, a cap written for the inbox, which lives in a floating window barely
 * wider than that. Tenants is a full-bleed overlay across the whole canvas, so
 * the same cap left a ~630px ribbon of rows marooned in the middle of a 1600px
 * window under a full-width search bar. Hidden below the single-column
 * breakpoint, where the list legitimately owns the whole width.
 */
function TenantDetailPlaceholder() {
  return (
    <section
      className={cn(
        'flex min-h-0 min-w-0 flex-1 items-center justify-center bg-card px-6 text-center',
        SINGLE_COLUMN_HIDE,
      )}
    >
      <p className={cn('max-w-[18rem] leading-relaxed text-muted-foreground', TEXT_BODY)}>
        Select an account to see the workspaces it owns and the ones shared with it.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------

interface TenantListProps {
  rows: TenantRowModel[];
  query: string;
  /** How many accounts the route actually returned, before the search filter. */
  loaded: number;
  total: number;
  truncated: boolean;
  /** Deployment-wide sums over the LOADED accounts — see the footer note. */
  totals: ReturnType<typeof tenantDeploymentTotals>;
  metering: TenantMeteringWindow | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (accountId: string) => void;
}

/** Pure list pane — takes pre-formatted rows, so it reads no clock and no store. */
export function TenantList({
  rows, query, loaded, total, truncated, totals, metering, loading, error, selectedId, onSelect,
}: TenantListProps) {
  // Arrow keys walk the rows; the rows are real buttons, so Enter/Space already
  // open them and no extra key handling is needed.
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-tenant-row]'),
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown'
      ? (current < 0 ? 0 : Math.min(current + 1, buttons.length - 1))
      : (current < 0 ? buttons.length - 1 : Math.max(current - 1, 0));
    event.preventDefault();
    buttons[next]?.focus();
  }, []);

  if (loading && rows.length === 0) {
    return (
      <div className="min-h-0 flex-1" data-tenant-skeleton="">
        <div className={LIST_COLUMN_CLASS}>
          {[0, 1, 2, 3].map(index => (
            <div key={index} className={cn('flex items-start gap-2.5', ROW_PADDING)}>
              <Skeleton className="size-8 shrink-0 rounded-[9px]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="ml-auto h-3 w-16" />
                </div>
                <Skeleton className="mt-1.5 h-2.5 w-40" />
                <Skeleton className="mt-2 h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error && rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-[18rem]">
          <p className={cn('font-medium text-foreground', TEXT_BODY)}>Could not load accounts</p>
          <p className={cn('mt-1 leading-relaxed text-muted-foreground', TEXT_BODY)}>{error}</p>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    const empty = tenantsEmptyState(query, total);
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-[18rem]">
          <p className={cn('font-medium text-foreground', TEXT_BODY)}>{empty.title}</p>
          <p className={cn('mt-1 leading-relaxed text-muted-foreground', TEXT_BODY)}>{empty.description}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className={cn('min-h-0 flex-1', SCROLL_VIEWPORT_BLOCK)}>
      {/* One flat stream, newest account first, nothing drawn between rows.
          Capped and centred so a wide window does not stretch rows into a thin
          edge-to-edge ribbon. */}
      <div className={cn('flex flex-col pb-2', LIST_COLUMN_CLASS)} onKeyDown={handleKeyDown}>
        {rows.map(row => (
          <TenantRow
            key={row.account.id}
            row={row}
            selected={row.account.id === selectedId}
            onSelect={onSelect}
          />
        ))}
        {/* The count sits UNDER the list, not in the header: it is a footnote
            about what you are looking at, and a capped list has to say so
            rather than quietly under-reporting the deployment's size. */}
        <div className={cn('flex flex-col gap-0.5 px-3 pt-2 text-muted-foreground/80', TEXT_META)}>
          <p>{tenantListFooter(rows.length, loaded, total, truncated, query)}</p>
          {/* The deployment line. Summed over the accounts that were LOADED,
              which is the same set the rows above came from — so it can never
              disagree with the column, and a capped list's footer says so on
              the line directly above this one. */}
          <p>
            {compactUnits(totals.messages)} messages
            {totals.huddles > 0 ? ` · ${totals.huddles.toLocaleString()} huddles` : ''}
            {totals.calls > 0 ? ` · ${formatUsd(totals.usd)} estimated` : ''}
          </p>
          {/* Metering honesty, on the surface itself rather than only in a pane
              you have to open. There is no usage history before this date and
              none can be back-filled, so a total shown without it would read as
              all-time and be false. */}
          <p>
            {metering?.started_at
              ? `Cost metering since ${formatStatDate(metering.started_at)} — estimates only, no data exists before that date.`
              : 'Cost metering has not started on this deployment — no spend has been recorded.'}
            {totals.unpricedProviders.length > 0
              ? ` ${totals.unpricedProviders.join(', ')} usage is recorded but unpriced and is not in the figure above.`
              : ''}
          </p>
        </div>
      </div>
    </ScrollArea>
  );
}
