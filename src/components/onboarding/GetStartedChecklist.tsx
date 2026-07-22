import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import type { ChatSession, WorkspaceAgent } from '../../types';
import { cn } from '@/lib/utils';

// Handles seeded into every workspace by default — an agent OUTSIDE this set
// means the user actually created their own, so "Create your first agent" is real.
const DEFAULT_AGENT_HANDLES = new Set(['scout', 'research', 'coder', 'q', 'mills', 'general']);

const DISMISS_KEY = 'agensis_getstarted_dismissed';
const COLLAPSE_KEY = 'agensis_getstarted_collapsed';

interface GetStartedChecklistProps {
  agents: WorkspaceAgent[];
  sessions: ChatSession[];
  memberCount: number;
  onCreateAgent: () => void;
  onStartRoom: () => void;
  onMessageAgent: () => void;
  onInvite: () => void;
}

interface StepDef {
  id: string;
  label: string;
  done: boolean;
  action: () => void;
}

export function GetStartedChecklist({
  agents,
  sessions,
  memberCount,
  onCreateAgent,
  onStartRoom,
  onMessageAgent,
  onInvite,
}: GetStartedChecklistProps) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');

  const steps = useMemo<StepDef[]>(() => {
    const createdAgent = agents.some(a => !DEFAULT_AGENT_HANDLES.has(String(a.handle || '').toLowerCase()));
    const startedRoom = sessions.some(s => s.folder !== 'Direct messages');
    const messagedAgent = sessions.some(s => s.folder === 'Direct messages');
    const invited = memberCount > 1;
    return [
      { id: 'agent', label: 'Create your first agent', done: createdAgent, action: onCreateAgent },
      { id: 'room', label: 'Start your first channel', done: startedRoom, action: onStartRoom },
      { id: 'message', label: 'Message an agent', done: messagedAgent, action: onMessageAgent },
      { id: 'invite', label: 'Invite teammates', done: invited, action: onInvite },
    ];
  }, [agents, sessions, memberCount, onCreateAgent, onStartRoom, onMessageAgent, onInvite]);

  const doneCount = steps.filter(s => s.done).length;
  const total = steps.length;
  const allDone = doneCount === total;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };
  const toggleCollapse = () => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      return next;
    });
  };

  // Self-hide once fully complete (and remember), or when the user dismisses it.
  if (dismissed || allDone) return null;

  return (
    <div className="pointer-events-auto w-full select-none rounded-xl border border-border bg-card p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">Get started</span>
        <span className="text-xs tabular-nums text-muted-foreground">{doneCount}/{total}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${(doneCount / total) * 100}%` }}
          />
        </div>
        <button
          type="button"
          onClick={toggleCollapse}
          className="grid size-5 place-items-center rounded text-muted-foreground transition hover:text-foreground"
          aria-label={collapsed ? 'Expand checklist' : 'Collapse checklist'}
        >
          {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="grid size-5 place-items-center rounded text-muted-foreground transition hover:text-foreground"
          aria-label="Dismiss checklist"
        >
          <X className="size-4" />
        </button>
      </div>

      {!collapsed && (
        <div className="mt-2 flex flex-col gap-0.5">
          {steps.map(step => (
            <button
              key={step.id}
              type="button"
              onClick={step.done ? undefined : step.action}
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
