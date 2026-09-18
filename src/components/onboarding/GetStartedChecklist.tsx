import { Check } from 'lucide-react';
import type { ChecklistStep, ChecklistStepId } from '@/lib/onboardingChecklist';
import { cn } from '@/lib/utils';
import { CardActions } from './CardActions';

interface GetStartedChecklistProps {
  /** From computeChecklistSteps — the panel owns the computation now. */
  steps: ChecklistStep[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onDismiss: () => void;
  onCreateAgent: () => void;
  onStartRoom: () => void;
  onMessageAgent: () => void;
  onInvite: () => void;
}

/**
 * The first-run checklist in the sidebar footer.
 *
 * Presentational: whether it is shown at all is decided by GetStartedPanel,
 * which shares this space with per-surface tips and so needs one place that
 * knows which of the two wins. Its dismissed/collapsed state lives there too,
 * under the same localStorage keys as before.
 */
export function GetStartedChecklist({
  steps,
  collapsed,
  onToggleCollapse,
  onDismiss,
  onCreateAgent,
  onStartRoom,
  onMessageAgent,
  onInvite,
}: GetStartedChecklistProps) {
  const actions: Record<ChecklistStepId, () => void> = {
    agent: onCreateAgent,
    room: onStartRoom,
    message: onMessageAgent,
    invite: onInvite,
  };

  const doneCount = steps.filter(s => s.done).length;
  const total = steps.length;

  return (
    <div className="pointer-events-auto w-full select-none rounded-xl border border-border bg-card p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">Get started</span>
        <span className="text-xs tabular-nums text-muted-foreground">{doneCount}/{total}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }}
          />
        </div>
        <CardActions
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
          onDismiss={onDismiss}
          expandLabel="Expand checklist"
          collapseLabel="Collapse checklist"
          dismissLabel="Dismiss checklist"
        />
      </div>

      {!collapsed && (
        <div className="mt-2 flex flex-col gap-0.5">
          {steps.map(step => (
            <button
              key={step.id}
              type="button"
              onClick={step.done ? undefined : actions[step.id]}
              disabled={step.done}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm transition',
                step.done ? 'cursor-default' : 'hover:bg-muted',
              )}
            >
              <span
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full border transition',
                  step.done ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                )}
              >
                {step.done && <Check className="size-3" />}
              </span>
              <span className={cn('min-w-0 flex-1 truncate', step.done ? 'text-primary line-through' : 'text-foreground')}>
                {step.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
