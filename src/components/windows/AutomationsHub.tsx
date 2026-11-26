import { useState } from 'react';
import { Clock, Zap } from 'lucide-react';
import type { ChatSession, WorkspaceAgent } from '../../types';
import { cn } from '../../lib/utils';
import { SchedulesWindow } from './SchedulesWindow';
import { AutomationsWindowContent } from './AutomationsWindowContent';

// Schedules and automations are one idea to the person using them — "make
// something happen without me" — so they are one window with two tabs. The two
// engines stay separate underneath (a schedule wakes an agent on a timer; an
// automation posts a message when an event happens, with no agent and no model
// call; see AGENTS.md "Workspace automations"), and each tab is the existing
// window, unchanged.

export type AutomationsHubTab = 'schedule' | 'event';

const TABS: Array<{ id: AutomationsHubTab; label: string; icon: typeof Clock }> = [
  { id: 'schedule', label: 'On a schedule', icon: Clock },
  { id: 'event', label: 'When something happens', icon: Zap },
];

export function AutomationsHub({
  workspaceId,
  agents,
  sessions,
  initialTab = 'schedule',
}: {
  workspaceId: string;
  agents: WorkspaceAgent[];
  sessions: ChatSession[];
  initialTab?: AutomationsHubTab;
}) {
  const [tab, setTab] = useState<AutomationsHubTab>(initialTab);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div role="tablist" aria-label="Automation kind" className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium text-muted-foreground outline-none transition-colors',
              'hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              tab === id && 'bg-muted text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
        {tab === 'schedule'
          ? <SchedulesWindow workspaceId={workspaceId} agents={agents} sessions={sessions} />
          : <AutomationsWindowContent workspaceId={workspaceId} sessions={sessions} />}
      </div>
    </div>
  );
}
