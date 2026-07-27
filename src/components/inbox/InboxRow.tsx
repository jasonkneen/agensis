import React from 'react';
import { Check, ExternalLink, MailOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CATEGORY_ICON,
  FOCUS_RING,
  PILL_BUTTON,
  ROW_AVATAR,
  ROW_PADDING,
  ROW_WASH_HOVER,
  ROW_WASH_SELECTED,
  TEXT_BODY,
  TEXT_META,
} from './inboxPresentation';
import type { InboxRowModel } from './inboxModel';

// ---------------------------------------------------------------------------
// Three lines of text and a face.
//
//   ( AB )  Scout                                      • 2:34 PM
//           Needs your decision
//           Ship the migration now or wait for the …
//
// Everything structural is absent on purpose: no border between rows, no gap,
// no card, no radius, no shadow, no left accent bar, no reply count, no
// category badge, no checkbox. Rows butt straight onto each other and the 12px
// vertical padding does the separating. The only thing that ever paints a
// background is hover/selection, at ~3-5% of --foreground over --card.
//
// At rest the row shows zero controls. On hover the timestamp fades out and the
// actions fade in over the space it left, so the row never carries two clusters
// of chrome at once.
//
// The whole row is one real <button> stretched under the text (z-0), which is
// what lets the action pill be real buttons on top (z-10) without nesting
// interactive elements.
//
// The one exception to "no checkbox" is the avatar, which IS the checkbox — it
// turns into one in place, at the same 32px, so nothing on the row moves when
// selection mode opens. See ROW_AVATAR in inboxPresentation.ts.
// ---------------------------------------------------------------------------

interface InboxRowProps {
  row: InboxRowModel;
  selected: boolean;
  /** The list is in bulk-selection mode: the whole row toggles, nothing opens. */
  selectionMode: boolean;
  /** This row is part of the current bulk selection. */
  checked: boolean;
  onSelect: (key: string) => void;
  /** `extend` is a shift-click — range-select from the anchor. */
  onToggleSelect: (key: string, extend: boolean) => void;
  onMarkRead: (key: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

export const InboxRow = React.memo(function InboxRow({
  row,
  selected,
  selectionMode,
  checked,
  onSelect,
  onToggleSelect,
  onMarkRead,
  onOpenSession,
}: InboxRowProps) {
  const { group, when, label, sender, initials, preview } = row;
  const unread = group.unreadCount > 0;
  const CategoryIcon = CATEGORY_ICON[group.category];
  const sessionId = group.sessionId;
  const canOpen = !!sessionId && !!onOpenSession;
  // With nothing to offer, the timestamp must NOT fade on hover — a row that
  // blanks its only metadata and puts nothing in its place just looks broken.
  // In selection mode there is nothing to offer either: the per-row actions are
  // replaced by the bulk ones in the header.
  const hasActions = !selectionMode && (unread || canOpen);
  // In selection mode the row IS the checkbox — clicking anywhere toggles, and
  // shift-click ranges. Opening an item mid-bulk-select would swap the list for
  // a 340px column under a header built for the full width.
  const rowWash = selectionMode ? checked : selected;

  return (
    <div
      className="group/row relative"
      style={
        {
          '--inbox-wash': rowWash ? ROW_WASH_SELECTED : ROW_WASH_HOVER,
        } as React.CSSProperties
      }
    >
      {/* Full-bleed hit target and background layer. */}
      <button
        type="button"
        data-inbox-row=""
        onClick={event => {
          if (selectionMode) onToggleSelect(group.key, event.shiftKey);
          else onSelect(group.key);
        }}
        aria-current={!selectionMode && selected ? 'true' : undefined}
        aria-pressed={selectionMode ? checked : undefined}
        aria-label={
          selectionMode
            ? `${checked ? 'Deselect' : 'Select'} ${label.text.toLowerCase()} from ${sender}`
            : `Open ${label.text.toLowerCase()} from ${sender}`
        }
        className={cn(
          'absolute inset-0 z-0 block w-full transition-colors',
          FOCUS_RING,
          rowWash
            ? 'bg-[var(--inbox-wash)]'
            : 'group-hover/row:bg-[var(--inbox-wash)] group-focus-within/row:bg-[var(--inbox-wash)]',
        )}
      />

      {/* Content layer. Inert to the pointer so every click lands on the button
          underneath — the row is one target, not a patchwork of them. The avatar
          opts back in, because it is the one thing that does something else. */}
      <div className={cn('pointer-events-none relative z-10 flex min-w-0 items-start gap-2.5', ROW_PADDING)}>
        <button
          type="button"
          data-inbox-avatar=""
          onClick={event => {
            event.stopPropagation();
            onToggleSelect(group.key, event.shiftKey);
          }}
          aria-pressed={selectionMode ? checked : undefined}
          aria-label={
            selectionMode
              ? `${checked ? 'Deselect' : 'Select'} ${sender}`
              : `Select ${sender} — start choosing rows for bulk actions`
          }
          title={selectionMode ? 'Shift-click to select a range' : 'Select for bulk actions'}
          className={cn(
            ROW_AVATAR,
            checked
              ? 'bg-primary text-primary-foreground'
              : selectionMode
                ? 'bg-muted/40 ring-1 ring-inset ring-muted-foreground/40 hover:ring-muted-foreground/70'
                : 'bg-muted text-muted-foreground hover:ring-2 hover:ring-inset hover:ring-primary/60',
          )}
        >
          {/* Initials at rest; they step aside for the tick on hover so the
              avatar advertises what it does before anyone has clicked it. */}
          <span
            aria-hidden="true"
            className={cn(
              'transition-opacity',
              checked || selectionMode ? 'opacity-0' : 'group-hover/row:opacity-0',
            )}
          >
            {initials || <CategoryIcon className="size-3.5" />}
          </span>
          <Check
            aria-hidden="true"
            className={cn(
              'absolute size-4 transition-opacity',
              checked
                ? 'opacity-100'
                : selectionMode
                  ? 'opacity-0'
                  : 'opacity-0 text-muted-foreground group-hover/row:opacity-100',
            )}
          />
        </button>

        <div className="min-w-0 flex-1">
          {/* Line 1 — who, and when. Both halves share leading-5 so the name and
              the timestamp sit on one band however far apart their sizes are. */}
          <div className="flex min-w-0 items-start gap-2">
            <span className={cn('min-w-0 flex-1 truncate font-semibold leading-5 text-foreground', TEXT_BODY)}>
              {sender}
            </span>
            <span
              className={cn(
                'flex shrink-0 items-center gap-1.5 leading-5 text-muted-foreground/80 transition-opacity',
                TEXT_META,
                unread ? 'font-medium' : 'font-normal',
                hasActions && 'group-hover/row:opacity-0 group-focus-within/row:opacity-0',
              )}
            >
              {unread && (
                <span role="img" aria-label="Unread" className="size-1.5 rounded-full bg-primary" />
              )}
              <span className="tabular-nums">{when}</span>
            </span>
          </div>

          {/* Line 2 — what kind of thing this is. The only coloured text in the
              list, and only for the two categories that block a human. */}
          <div
            className={cn(
              'flex min-w-0 items-center gap-1.5 leading-4 transition-[padding]',
              TEXT_META,
              label.tone === 'blocker'
                ? 'font-medium text-amber-600 dark:text-amber-400/90'
                : label.tone === 'error'
                  ? 'font-medium text-destructive/90'
                  : 'font-medium text-muted-foreground/80',
              hasActions && 'group-hover/row:pr-16 group-focus-within/row:pr-16',
            )}
          >
            <span className="shrink-0">{label.text}</span>
            {label.chip && (
              <span className="min-w-0 truncate rounded-[4px] bg-muted px-1 py-px font-medium text-muted-foreground/90">
                {label.chip}
              </span>
            )}
          </div>

          {/* Line 3 — the preview IS the subject. Read rows desaturate rather
              than dim, so the list never looks half switched-off. */}
          {preview && (
            <p
              className={cn(
                // break-words so a path, a uuid or a stack frame WRAPS instead
                // of running past the pane edge and being cut off mid-token.
                'mt-1.5 line-clamp-2 break-words leading-snug',
                TEXT_BODY,
                unread ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground',
              )}
            >
              {preview}
            </p>
          )}
        </div>
      </div>

      {/* Hover actions, in the corner the timestamp just vacated. */}
      {hasActions && (
        <div
          className={cn(
            'pointer-events-none absolute right-2.5 top-2 z-10 flex items-center gap-0.5 rounded-full p-0.5 opacity-0 transition-opacity duration-150 ease-out',
            'bg-[var(--inbox-wash)]',
            'group-hover/row:pointer-events-auto group-hover/row:opacity-100',
            'group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100',
          )}
        >
          {unread && (
            <button
              type="button"
              className={PILL_BUTTON}
              onClick={() => onMarkRead(group.key)}
              aria-label="Mark as read"
              title="Mark as read"
            >
              <MailOpen />
            </button>
          )}
          {canOpen && (
            <button
              type="button"
              className={PILL_BUTTON}
              onClick={() => onOpenSession?.(sessionId as string)}
              aria-label="Open the chat this came from"
              title="Open chat"
            >
              <ExternalLink />
            </button>
          )}
        </div>
      )}
    </div>
  );
});
