import React from 'react';
import { cn } from '@/lib/utils';
import { FOCUS_RING } from './inboxPresentation';
import { INBOX_FILTERS } from './inboxModel';
import type { InboxFilter } from '../../types';

// ---------------------------------------------------------------------------
// A segmented control, not a row of chips. One recessed track, one raised
// active segment — so the bar reads as "which slice of the list am I looking
// at" rather than as six independent buttons.
//
// Counts come from the caller and are held steady across filter switches, so
// the control never resizes underneath the pointer mid-click.
// ---------------------------------------------------------------------------

interface InboxFilterTabsProps {
  filter: InboxFilter;
  counts: Record<InboxFilter, number>;
  onChange: (filter: InboxFilter) => void;
}

export const InboxFilterTabs = React.memo(function InboxFilterTabs({
  filter,
  counts,
  onChange,
}: InboxFilterTabsProps) {
  return (
    <div
      role="group"
      aria-label="Filter inbox"
      className={cn(
        'flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/70 p-0.5',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
    >
      {INBOX_FILTERS.map(tab => {
        const active = tab.id === filter;
        const count = counts[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            aria-pressed={active}
            className={cn(
              'flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium whitespace-nowrap transition-colors',
              FOCUS_RING,
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {count > 0 && (
              <span
                className={cn(
                  'tabular-nums',
                  // The one count worth a colour: something is stopped on a human.
                  tab.id === 'blocker'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground/70',
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});
