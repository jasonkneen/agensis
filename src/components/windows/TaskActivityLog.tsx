import { useMemo } from 'react';
import { useActivity } from '../../hooks/useActivity';
import { projectActivity } from '../../lib/pm/projectActivity';
import type { WorkspaceMember } from '../../hooks/useSharing';

// The activity log in the task drawer, from the approved drawer mock: what happened to
// this task (created, updated, completed), newest first. It reads the task events the
// app already records and shows the latest few, so it never grows the panel without bound.

const SHOWN = 8;

function initials(email: string | null | undefined): string {
  return ((email ?? '').split('@')[0] || 'M').slice(0, 2).toUpperCase();
}

function when(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TaskActivityLog({
  workspaceId,
  userId,
  taskId,
  members,
}: {
  workspaceId: string | null;
  userId?: string;
  taskId: string;
  members: WorkspaceMember[];
}) {
  const { events } = useActivity(workspaceId, userId);
  const items = useMemo(() => projectActivity(events, [{ id: taskId }], SHOWN), [events, taskId]);

  return (
    <section className="border-t border-border px-4 py-3" aria-label="Task activity">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing recorded for this task yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map(item => {
            const member = members.find(candidate => candidate.user_id === item.user_id);
            return (
              <li key={item.id} className="flex items-center gap-2 text-xs">
                <span
                  className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/20 text-[0.5rem] font-semibold"
                  title={member?.email ?? 'An agent or the system'}
                >
                  {member ? initials(member.email) : 'AI'}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-muted-foreground">{when(item.created_at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
