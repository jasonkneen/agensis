import React from 'react';
import { cn } from '@/lib/utils';
import {
  FOCUS_RING,
  ROW_PADDING,
  ROW_WASH_HOVER,
  ROW_WASH_SELECTED,
  TEXT_BODY,
  TEXT_META,
} from '../inbox/inboxPresentation';
import type { TenantRowModel } from '../../lib/tenants';

// ---------------------------------------------------------------------------
// One account. Deliberately the SAME row as the inbox's — text against a 32px
// tile, roomy, with nothing drawn between rows:
//
//   [JK]  Jason Kneen                              15 Jan 2026
//         jason@bouncingfish.com
//         3 workspaces · 18 ch · 4.2k msgs · 2 huddles      $12.40
//
// It is not a data table, and that is not an oversight. A dense grid of every
// account on the deployment invites scanning it like a spreadsheet; roomy rows
// with one identity per row invite finding the ONE account you came for. Density
// was proposed for the inbox and rejected there for the same reason — see
// inboxPresentation.ts.
//
// The cost chip sits at the end of the activity line rather than getting a
// fourth line: it is the number the list is scanned FOR, and it belongs on the
// same baseline as the usage it came from. It is BLANK, never "$0.00", when
// nothing was recorded — an account nobody has metered and an account that
// genuinely cost nothing must not look identical (see tenantCostChip).
//
// The tile is initials on the account's palette colour, from the same
// hash-to-colour function the workspace rail uses. Never an emoji, never a
// photo, never a gravatar (which would leak the operator's browsing of this
// surface to a third party).
// ---------------------------------------------------------------------------

interface TenantRowProps {
  row: TenantRowModel;
  selected: boolean;
  onSelect: (accountId: string) => void;
}

export const TenantRow = React.memo(function TenantRow({ row, selected, onSelect }: TenantRowProps) {
  const { account, title, subtitle, activity, cost, joined, initials, color } = row;
  // `subtitle` is already guaranteed not to repeat the title — it is the email
  // for a named account and the account's facts for an unnamed one. See
  // tenantIdentityHeader; the row does not decide this.
  const showSubtitle = Boolean(subtitle) && subtitle !== title;

  return (
    <div
      className="group/row relative"
      style={{ '--tenant-wash': selected ? ROW_WASH_SELECTED : ROW_WASH_HOVER } as React.CSSProperties}
    >
      {/* Full-bleed hit target and background layer, exactly as InboxRow does
          it, so the whole row is one target rather than a patchwork. */}
      <button
        type="button"
        data-tenant-row={account.id}
        onClick={() => onSelect(account.id)}
        aria-current={selected ? 'true' : undefined}
        aria-label={`Open ${title}${showSubtitle ? ` (${subtitle})` : ''}`}
        className={cn(
          'absolute inset-0 z-0 block w-full transition-colors',
          FOCUS_RING,
          selected
            ? 'bg-[var(--tenant-wash)]'
            : 'group-hover/row:bg-[var(--tenant-wash)] group-focus-within/row:bg-[var(--tenant-wash)]',
        )}
      />

      <div className={cn('pointer-events-none relative z-10 flex min-w-0 items-start gap-2.5', ROW_PADDING)}>
        {/* Rounded SQUARE, not a circle — the rail's shape for "an account or a
            workspace", against the inbox's circle for "a person who sent you
            something". The radius is a literal pixel value for the same reason
            the rail's is: `rounded-lg` resolves off the theme's --radius scale
            and lands near-circular on a 32px tile in some themes. */}
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-xs font-semibold tracking-tight text-white"
          style={{ backgroundColor: color }}
        >
          {initials}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <span className={cn('min-w-0 flex-1 truncate font-semibold leading-5 text-foreground', TEXT_BODY)}>
              {title}
            </span>
            {joined && (
              <span className={cn('shrink-0 leading-5 tabular-nums text-muted-foreground/80', TEXT_META)}>
                {joined}
              </span>
            )}
          </div>

          {showSubtitle && (
            <div className={cn('mt-0.5 min-w-0 truncate leading-4 text-muted-foreground/90', TEXT_META)}>
              {subtitle}
            </div>
          )}

          <div className="mt-1.5 flex min-w-0 items-baseline gap-2">
            <p className={cn('min-w-0 flex-1 truncate leading-snug text-muted-foreground', TEXT_BODY)}>
              {activity}
            </p>
            {cost && (
              <span
                className={cn(
                  'shrink-0 rounded-[4px] bg-muted px-1.5 py-px font-medium tabular-nums leading-5 text-foreground/80',
                  TEXT_META,
                )}
                title="Estimated spend since metering started"
              >
                {cost}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
