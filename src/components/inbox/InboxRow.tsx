import React from 'react';
import { ExternalLink, MailOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CATEGORY_ICON,
  FOCUS_RING,
  PILL_BUTTON,
  ROW_PADDING,
  ROW_WASH_HOVER,
  ROW_WASH_SELECTED,
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
// ---------------------------------------------------------------------------

interface InboxRowProps {
  row: InboxRowModel;
  selected: boolean;
  onSelect: (key: string) => void;
  onMarkRead: (key: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

export const InboxRow = React.memo(function InboxRow({
  row,
  selected,
  onSelect,
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
  const hasActions = unread || canOpen;

  return (
    <div
      className="group/row relative"
      style={
        {
          '--inbox-wash': selected ? ROW_WASH_SELECTED : ROW_WASH_HOVER,
        } as React.CSSProperties
      }
    >
      {/* Full-bleed hit target and background layer. */}
      <button
        type="button"
        data-inbox-row=""
        onClick={() => onSelect(group.key)}
        aria-current={selected ? 'true' : undefined}
        aria-label={`Open ${label.text.toLowerCase()} from ${sender}`}
        className={cn(
          'absolute inset-0 z-0 block w-full transition-colors',
          FOCUS_RING,
          selected
            ? 'bg-[var(--inbox-wash)]'
            : 'group-hover/row:bg-[var(--inbox-wash)] group-focus-within/row:bg-[var(--inbox-wash)]',
        )}
      />

      {/* Content layer. Inert to the pointer so every click lands on the button
          underneath — the row is one target, not a patchwork of them. */}
      <div className={cn('pointer-events-none relative z-10 flex min-w-0 items-start gap-2.5', ROW_PADDING)}>
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
        >
          {initials || <CategoryIcon className="size-3.5" />}
        </span>

        <div className="min-w-0 flex-1">
          {/* Line 1 — who, and when. */}
          <div className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-4 text-foreground">
              {sender}
            </span>
            <span
              className={cn(
                'flex shrink-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground/80 transition-opacity',
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
              'flex min-w-0 items-center gap-1.5 text-[11px] leading-[13px] transition-[padding]',
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
                'mt-1.5 line-clamp-2 text-[13px] leading-[18px]',
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
