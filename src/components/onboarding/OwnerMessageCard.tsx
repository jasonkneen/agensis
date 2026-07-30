import { ChevronDown, ChevronUp, Megaphone, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OwnerMessage } from '@/lib/tenantCampaigns';

interface OwnerMessageCardProps {
  message: OwnerMessage;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Dismiss for this USER, on the server — see useOwnerMessages. */
  onDismiss: () => void;
}

/**
 * A message from whoever runs this deployment, in the sidebar footer.
 *
 * The SAME frame, header rhythm and two controls as PageTipCard and
 * GetStartedChecklist, because it is the same space and the furniture must not
 * move. What changes is the emphasis: an accent border and header, a megaphone
 * instead of a lightbulb, and FOR YOU where the tip card names a surface — so it
 * reads as addressed rather than as another piece of generic advice.
 *
 * The body is rendered as a TEXT NODE. It is operator-authored prose arriving
 * from the server, and nothing on this path builds HTML from it: no
 * dangerouslySetInnerHTML, no markdown link whose href could come from the
 * message. Line breaks survive through `whitespace-pre-line`, which is CSS, not
 * parsing.
 */
export function OwnerMessageCard({
  message, collapsed, onToggleCollapse, onDismiss,
}: OwnerMessageCardProps) {
  return (
    <div
      className={cn(
        'pointer-events-auto w-full select-none rounded-xl border bg-card p-3 shadow-lg',
        'border-primary/50 ring-1 ring-primary/20',
      )}
      data-owner-message="tip"
    >
      <div className="flex items-center gap-2">
        <Megaphone className="size-3.5 shrink-0 text-primary" />
        <span className="text-sm font-semibold text-foreground">Message</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-primary">
          FOR YOU
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="grid size-5 place-items-center rounded text-muted-foreground transition hover:text-foreground"
          aria-label={collapsed ? 'Expand message' : 'Collapse message'}
        >
          {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="grid size-5 place-items-center rounded text-muted-foreground transition hover:text-foreground"
          aria-label="Dismiss this message"
          title="Dismiss this message"
        >
          <X className="size-4" />
        </button>
      </div>

      {!collapsed && (
        <div className="mt-2 px-1.5">
          <div className="text-sm font-medium text-foreground">{message.title}</div>
          <p className="mt-1 whitespace-pre-line text-xs leading-snug text-muted-foreground">
            {message.body}
          </p>
        </div>
      )}
    </div>
  );
}
