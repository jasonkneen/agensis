import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// The one way a window or panel labels a block of its content.
//
// Before this, every window drew its own: a coloured icon + a bold h2 + a
// count badge, often directly under a toolbar that already said the same
// thing, under a title bar that ALSO said it ("Users" > "People &
// connections 1" > "Members 1" for a single member). A section label is
// chrome, not content — it is a quiet uppercase micro-label in the muted
// colour, with a plain count, and the window title above it does the naming.
// No accent icon: colour is reserved for state and for the primary action.

export function SectionHeader({
  title,
  count,
  action,
  className,
}: {
  title: ReactNode;
  count?: number | null;
  /** Right-aligned control: a ghost button, a spinner, a link. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-7 items-center gap-2 px-0.5', className)}>
      <h2 className="ui-section-label">{title}</h2>
      {typeof count === 'number' && (
        <span className="text-2xs tabular-nums text-muted-foreground/80">{count}</span>
      )}
      {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
    </div>
  );
}

export function Section({
  title,
  count,
  action,
  description,
  children,
  className,
}: {
  title: ReactNode;
  count?: number | null;
  action?: ReactNode;
  /** One sentence. If it needs two, it belongs in a help popover. */
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-1.5', className)}>
      <SectionHeader title={title} count={count} action={action} />
      {description && <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}

/**
 * A run of rows in ONE frame with hairline dividers between them — not a card
 * per row. Eight rows that are each a bordered, padded card read as eight
 * separate objects; one frame with dividers reads as one list, and costs half
 * the vertical space.
 */
export function ListGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card/50 divide-y divide-border/70', className)}>
      {children}
    </div>
  );
}

/**
 * Row actions that should not compete with the row's content until the row is
 * the subject: shown on hover or keyboard focus within the row, and always on
 * touch screens, where there is no hover to reveal them.
 */
export const ROW_REVEAL =
  'opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100';

export function ListRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('group/row flex min-h-12 items-center gap-3 px-3 py-2 transition-colors hover:bg-foreground/[0.025]', className)}>
      {children}
    </div>
  );
}
