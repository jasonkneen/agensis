import { ChevronDown, ChevronUp, Lightbulb, X } from 'lucide-react';
import { TIP_SURFACE_LABEL, type PageTip } from '@/lib/pageTips';

interface PageTipCardProps {
  tip: PageTip;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Dismiss THIS tip for good; the next one for the surface takes its place. */
  onDismiss: () => void;
}

/**
 * A tip about the surface the user is currently on, in the sidebar footer.
 *
 * Same frame, same header rhythm and the same two controls as
 * GetStartedChecklist, because it is the same space — the card changes, the
 * furniture does not. The middle of the header says which surface the tip is
 * about, so it is obvious why the panel changed when a window was focused.
 */
export function PageTipCard({ tip, collapsed, onToggleCollapse, onDismiss }: PageTipCardProps) {
  return (
    <div className="pointer-events-auto w-full select-none rounded-xl border border-border bg-card p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <Lightbulb className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">Tip</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {TIP_SURFACE_LABEL[tip.surface]}
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="grid size-5 place-items-center rounded text-muted-foreground transition hover:text-foreground"
          aria-label={collapsed ? 'Expand tip' : 'Collapse tips'}
        >
          {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="grid size-5 place-items-center rounded text-muted-foreground transition hover:text-foreground"
          aria-label="Dismiss this tip"
          title="Dismiss this tip"
        >
          <X className="size-4" />
        </button>
      </div>

      {!collapsed && (
        <div className="mt-2 px-1.5">
          <div className="text-sm font-medium text-foreground">{tip.title}</div>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">{tip.body}</p>
        </div>
      )}
    </div>
  );
}
