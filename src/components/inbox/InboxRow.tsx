import React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CATEGORY_ICON,
  COL,
  FOCUS_RING,
  ROW_BASE,
  categoryAccent,
} from './inboxPresentation';
import type { InboxRowModel } from './inboxModel';

// ---------------------------------------------------------------------------
// One line. One type size. Five columns that never move.
//
//   [•] [icon] [actor +N] [Title — preview…............] [12m ago] [›]
//
// Unread is carried by WEIGHT plus the dot in the left gutter — never by a
// background wash, because a wash makes the row a card and a list of cards is
// a feed, not something you can scan. The only background this row ever paints
// is selection.
// ---------------------------------------------------------------------------

interface InboxRowProps {
  row: InboxRowModel;
  selected: boolean;
  onSelect: (key: string) => void;
}

export const InboxRow = React.memo(function InboxRow({ row, selected, onSelect }: InboxRowProps) {
  const { group, when } = row;
  const Icon = CATEGORY_ICON[group.category];
  const accent = categoryAccent(group.category);
  const unread = group.unreadCount > 0;
  const blocker = group.category === 'blocker';
  // A burst on one thread is one row; the count says how much tail is hiding.
  const extra = group.items.length - 1;

  return (
    <button
      type="button"
      data-inbox-row=""
      onClick={() => onSelect(group.key)}
      aria-current={selected ? 'true' : undefined}
      title={group.body ? `${group.title} — ${group.body}` : group.title}
      className={cn(
        ROW_BASE,
        FOCUS_RING,
        // Selection is a tint of --primary: the one token guaranteed to sit
        // clear of the muted hover surface in every theme, light and dark.
        selected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/60',
      )}
    >
      {/* Blockers get a hairline rule instead of a tinted row — enough to find
          them at a glance, not enough to turn the list into stripes. */}
      {blocker && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-amber-500" />
      )}

      <span className={COL.dot}>
        {unread && (
          <span role="img" aria-label="Unread" className="size-1.5 rounded-full bg-primary" />
        )}
      </span>

      <Icon
        aria-hidden="true"
        className={cn(
          COL.icon,
          accent || (unread ? 'text-foreground/55' : 'text-muted-foreground/70'),
        )}
      />

      <span className={cn(COL.actor, 'min-w-0')}>
        <span
          className={cn(
            'min-w-0 truncate',
            unread ? 'font-medium text-foreground/80' : 'text-muted-foreground',
          )}
        >
          {group.actorName}
        </span>
        {extra > 0 && (
          <span className="shrink-0 tabular-nums text-muted-foreground/70">+{extra}</span>
        )}
      </span>

      {/* Title and preview share ONE line and truncate together — the preview is
          subordinate typography, not a second row. */}
      <span className="min-w-0 flex-1 truncate">
        <span className={unread ? 'font-semibold text-foreground' : 'text-foreground/65'}>
          {group.title}
        </span>
        {group.body && (
          <span className="text-muted-foreground">
            {' — '}
            {group.body}
          </span>
        )}
      </span>

      <span
        className={cn(COL.time, unread ? 'text-foreground/70' : 'text-muted-foreground')}
      >
        {when}
      </span>

      <ChevronRight
        aria-hidden="true"
        className={cn(
          COL.chevron,
          'text-muted-foreground opacity-0 transition-opacity',
          'group-hover/row:opacity-70 group-focus-visible/row:opacity-70',
        )}
      />
    </button>
  );
});
