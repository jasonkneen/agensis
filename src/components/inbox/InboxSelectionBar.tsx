import { Ban, Check, Loader2, MailOpen, Minus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { FOCUS_RING, PANE_HEADER } from './inboxPresentation';
import type { InboxBulkAction, InboxBulkActionId } from './inboxSelection';

// ---------------------------------------------------------------------------
// The selection header. It REPLACES the filter bar rather than stacking under
// it, in the same 36px PANE_HEADER band, so the two panes still line up
// pixel-for-pixel across the divider while a bulk selection is open.
//
// Only actions the selection can actually perform are rendered — an inbox with
// no unread rows selected does not show a greyed-out "Mark read". A disabled
// button that is disabled for a reason nobody can see is worse than no button.
//
// Everything here is icon-first with a label that drops out below ~28rem of
// container, because this bar has to survive the same 400px floating window the
// rest of the surface does.
// ---------------------------------------------------------------------------

interface InboxSelectionBarProps {
  count: number;
  /** Underlying items behind those rows — a row is a conversation, not a message. */
  itemCount: number;
  allSelected: boolean;
  actions: InboxBulkAction[];
  busy: InboxBulkActionId | null;
  onToggleAll: () => void;
  onRun: (id: InboxBulkActionId) => void;
  onExit: () => void;
}

// Dismiss is deliberately NOT an X. Below ~28rem of container the labels drop
// and this bar becomes icons only — an X for "dismiss 3 blockers" sitting two
// pixels from the X that closes the bar is a destructive misclick waiting to
// happen. Ban reads as "retire this" and cannot be mistaken for "close".
const ACTION_ICON: Record<InboxBulkActionId, typeof MailOpen> = {
  'mark-read': MailOpen,
  dismiss: Ban,
};

export function InboxSelectionBar({
  count,
  itemCount,
  allSelected,
  actions,
  busy,
  onToggleAll,
  onRun,
  onExit,
}: InboxSelectionBarProps) {
  const dismiss = actions.find(action => action.id === 'dismiss');

  return (
    <div className={PANE_HEADER}>
      <button
        type="button"
        onClick={onToggleAll}
        aria-label={allSelected ? 'Select none' : 'Select all'}
        title={allSelected ? 'Select none' : 'Select all'}
        className={cn(
          '-ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-[5px] transition-colors',
          FOCUS_RING,
          allSelected
            ? 'bg-primary text-primary-foreground'
            : 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/40 hover:bg-primary/25',
        )}
      >
        {allSelected ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
      </button>

      <span
        role="status"
        className="min-w-0 truncate text-sm font-medium leading-5 text-foreground"
      >
        {count} selected
        {itemCount > count && (
          <span className="text-muted-foreground"> · {itemCount} items</span>
        )}
      </span>

      <div className="min-w-0 flex-1" />

      {actions
        .filter(action => !action.destructive)
        .map(action => {
          const Icon = ACTION_ICON[action.id];
          return (
            <Button
              key={action.id}
              type="button"
              size="xs"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              disabled={busy !== null}
              onClick={() => onRun(action.id)}
              title={`${action.label} (${action.count})`}
            >
              {busy === action.id
                ? <Loader2 className="animate-spin" data-icon="inline-start" />
                : <Icon data-icon="inline-start" />}
              <span className="@max-md/inboxwin:hidden">{action.label}</span>
            </Button>
          );
        })}

      {/* Dismiss retires a question an agent is still waiting on, so it is the
          one action that has to be confirmed — and the confirm names the real
          number of blockers, which is items, not rows. */}
      {dismiss && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="shrink-0 text-destructive hover:text-destructive"
              disabled={busy !== null}
              title={`Dismiss ${dismiss.count} blocker${dismiss.count === 1 ? '' : 's'}`}
            >
              {busy === 'dismiss'
                ? <Loader2 className="animate-spin" data-icon="inline-start" />
                : <Ban data-icon="inline-start" />}
              <span className="@max-md/inboxwin:hidden">{dismiss.label}</span>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Dismiss {dismiss.count} blocker{dismiss.count === 1 ? '' : 's'}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {dismiss.count === 1 ? 'This agent is' : 'These agents are'} waiting for an
                answer. Dismissing retires the question without giving one — nothing is
                sent back, and {dismiss.count === 1 ? 'it' : 'they'} will not be unblocked
                by this. To actually answer, open a row and use Resolve.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => onRun('dismiss')}>
                Dismiss
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        disabled={busy !== null}
        onClick={onExit}
        aria-label="Leave selection mode"
        title="Leave selection mode (Esc)"
      >
        <X />
      </Button>
    </div>
  );
}
