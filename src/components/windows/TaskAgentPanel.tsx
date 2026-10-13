import { Button } from '@agensis/ui/components/button';
import { cn } from '@/lib/utils';
import { agentHandle } from '../../lib/agentAccent';
import { agentPanelState } from '../../lib/pm/agentPanel';
import type { AgentConnection, Task, WorkspaceAgent } from '../../types';
import { TaskActivityChip } from './TaskActivityChip';

// The agent panel in the task drawer, from the approved drawer mock. Shown only when the
// task is assigned to an agent: who it is, whether it is connected, where the task stands
// with it, and the live run chip when it is working. Agents are never attached to a
// project, only to tasks, so this is where an agent shows up on the project's work.

export function TaskAgentPanel({
  task,
  agents,
  agentConnections,
  chatSessionId,
  onOpenSession,
}: {
  task: Pick<Task, 'assignee_id' | 'status' | 'updated_at'>;
  agents: WorkspaceAgent[];
  agentConnections: AgentConnection[];
  /** The chat this task is being worked in, when it has one. */
  chatSessionId: string | null;
  onOpenSession?: (sessionId: string) => void;
}) {
  const state = agentPanelState(task, agents, agentConnections);
  if (!state.agent) return null;

  return (
    <section
      className="mx-4 my-3 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3"
      aria-label="Agent working on this task"
    >
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-violet-500/40 px-1.5 text-xs text-violet-400">{state.agent.name || 'Agent'}</span>
        <span className="text-xs text-muted-foreground">@{agentHandle(state.agent)}</span>
        <span
          className={cn(
            'ml-auto flex items-center gap-1.5 text-xs',
            state.presence === 'offline' ? 'text-muted-foreground' : 'text-foreground',
          )}
          data-presence={state.presence}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              state.presence === 'busy' ? 'bg-amber-500' : state.presence === 'online' ? 'bg-emerald-500' : 'bg-muted-foreground/50',
            )}
            aria-hidden
          />
          {state.presenceLabel}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{state.summary}</p>
        <TaskActivityChip task={task} sessionId={chatSessionId} />
      </div>
      {chatSessionId && onOpenSession && (
        <Button type="button" variant="outline" size="xs" className="mt-2" onClick={() => onOpenSession(chatSessionId)}>
          Open the chat
        </Button>
      )}
    </section>
  );
}
