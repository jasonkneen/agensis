import { ChevronDown, ChevronUp, X } from 'lucide-react';

// The collapse/dismiss pair in the corner of an onboarding card. Three cards
// (owner message, get-started checklist, page tip) each drew both buttons by
// hand, byte-identical apart from the labels, so the size and the hover
// treatment had three places to drift.

interface CardActionsProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onDismiss: () => void;
  /** Accessible names, e.g. "Expand checklist" / "Collapse checklist" / "Dismiss checklist". */
  expandLabel: string;
  collapseLabel: string;
  dismissLabel: string;
}

const ACTION = 'grid size-5 place-items-center rounded text-muted-foreground transition hover:text-foreground';

export function CardActions({ collapsed, onToggleCollapse, onDismiss, expandLabel, collapseLabel, dismissLabel }: CardActionsProps) {
  return (
    <>
      <button type="button" onClick={onToggleCollapse} className={ACTION} aria-label={collapsed ? expandLabel : collapseLabel}>
        {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      <button type="button" onClick={onDismiss} className={ACTION} aria-label={dismissLabel} title={dismissLabel}>
        <X className="size-4" />
      </button>
    </>
  );
}
