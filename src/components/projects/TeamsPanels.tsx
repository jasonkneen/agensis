import { useMemo, useState } from 'react';
import { Button } from '@agensis/ui/components/button';
import { Input } from '@agensis/ui/components/input';
import { cn } from '@/lib/utils';
import { agentHandle } from '../../lib/agentAccent';
import { directory, teamStats, toggleMember, type DirectoryPerson } from '../../lib/pm/teams';
import type { Task, WorkspaceAgent } from '../../types';
import type { WorkspaceMember } from '../../hooks/useSharing';
import type { Team, useTeams } from '../../hooks/useTeams';

// Teams cards and the Members list from the approved Section 9 mock. People and agents
// share one list; a team groups them for workload and is never attached to a project.

type TeamActions = Pick<ReturnType<typeof useTeams>, 'createTeam' | 'updateTeam' | 'deleteTeam'>;

const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function peopleList(members: WorkspaceMember[], agents: WorkspaceAgent[]): DirectoryPerson[] {
  return [
    ...members.map(member => ({ id: member.user_id, name: member.email?.split('@')[0] || 'Member', isAgent: false, role: cap(member.role) })),
    ...agents.filter(agent => agent.enabled !== false).map(agent => ({ id: agent.id, name: `@${agentHandle(agent)}`, isAgent: true, role: 'Task runner' })),
  ];
}

const AgentTag = ({ children }: { children: string }) => (
  <span className="rounded-full border border-violet-500/50 px-2 text-[0.6875rem] text-violet-500">{children}</span>
);

function Avatar({ name, isAgent }: { name: string; isAgent: boolean }) {
  return (
    <span
      title={name}
      className={cn('grid size-6 place-items-center rounded-full border-2 border-card text-[0.5625rem] font-semibold', isAgent ? 'bg-violet-500/20 text-violet-500' : 'bg-primary/20')}
    >
      {name.replace('@', '').slice(0, 2).toUpperCase()}
    </span>
  );
}

function TeamCard({ team, people, tasks, agentIds, actions }: { team: Team; people: DirectoryPerson[]; tasks: Task[]; agentIds: Set<string>; actions: TeamActions }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const stats = teamStats(team, tasks, agentIds);
  const shown = people.filter(person => team.member_ids.includes(person.id));

  const saveName = () => {
    const next = name.trim();
    if (next && next !== team.name) void actions.updateTeam(team.id, { name: next });
    else setName(team.name);
  };

  return (
    <div className="rounded-xl border border-border bg-card/60 p-3.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{team.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {stats.people} {stats.people === 1 ? 'person' : 'people'} · {stats.agents} {stats.agents === 1 ? 'agent' : 'agents'} · {stats.openTasks} open {stats.openTasks === 1 ? 'task' : 'tasks'}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" aria-expanded={editing} onClick={() => setEditing(value => !value)}>
          {editing ? 'Done' : 'Edit'}
        </Button>
      </div>
      <div className="mt-2.5 flex -space-x-1.5">
        {shown.slice(0, 6).map(person => (
          <Avatar key={person.id} name={person.name} isAgent={person.isAgent} />
        ))}
        {shown.length === 0 && <span className="text-xs text-muted-foreground">No members yet</span>}
      </div>
      {editing && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <Input value={name} onChange={event => setName(event.target.value)} onBlur={saveName} aria-label="Team name" className="h-8 text-sm" />
          <ul className="max-h-40 space-y-1 overflow-y-auto" aria-label="Team members">
            {people.map(person => (
              <li key={person.id}>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={team.member_ids.includes(person.id)}
                    onChange={() => void actions.updateTeam(team.id, { member_ids: toggleMember(team.member_ids, person.id) })}
                  />
                  <span className={cn(person.isAgent && 'text-violet-500')}>{person.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={() => void actions.deleteTeam(team.id)}>
            Delete team
          </Button>
        </div>
      )}
    </div>
  );
}

/** The Teams page: cards with counts and avatars, and a form to create one. */
export function TeamsPage({ teams, actions, members, agents, tasks }: { teams: Team[]; actions: TeamActions; members: WorkspaceMember[]; agents: WorkspaceAgent[]; tasks: Task[] }) {
  const [draft, setDraft] = useState('');
  const people = useMemo(() => peopleList(members, agents), [members, agents]);
  const agentIds = useMemo(() => new Set(agents.map(agent => agent.id)), [agents]);

  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft('');
    await actions.createTeam({ name });
  };

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="teams-page">
      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault();
          void create();
        }}
      >
        <Input value={draft} onChange={event => setDraft(event.target.value)} placeholder="New team name" aria-label="New team name" className="h-8 max-w-xs text-sm" />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          New team
        </Button>
      </form>
      {teams.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No teams yet. A team groups people and agents so you can see their combined workload.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {teams.map(team => (
            <TeamCard key={team.id} team={team} people={people} tasks={tasks} agentIds={agentIds} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
}

type MemberFilter = 'all' | 'people' | 'agents';

/** The Members page: people and agents in one table, with role, teams and open tasks. */
export function MembersPage({ teams, members, agents, tasks }: { teams: Team[]; members: WorkspaceMember[]; agents: WorkspaceAgent[]; tasks: Task[] }) {
  const [filter, setFilter] = useState<MemberFilter>('all');
  const rows = useMemo(() => directory(peopleList(members, agents), teams, tasks), [members, agents, teams, tasks]);
  const shown = rows.filter(row => filter === 'all' || (filter === 'agents' ? row.isAgent : !row.isAgent));

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="members-page">
      <div className="flex gap-1.5 text-xs" role="group" aria-label="Member filter">
        {([['all', 'All'], ['people', 'People'], ['agents', 'Agents']] as Array<[MemberFilter, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={cn('rounded-full border border-border px-2.5 py-1', filter === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {label}
          </button>
        ))}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Name</th>
            <th className="py-2 pr-3 font-medium">Role</th>
            <th className="py-2 pr-3 font-medium">Team</th>
            <th className="py-2 font-medium">Open tasks</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(row => (
            <tr key={row.id} className="border-b border-border last:border-0">
              <td className="py-2.5 pr-3">{row.isAgent ? <><AgentTag>{row.name.replace('@', '')}</AgentTag> <span className="text-xs text-muted-foreground">agent</span></> : row.name}</td>
              <td className="py-2.5 pr-3 text-muted-foreground">{row.role}</td>
              <td className="py-2.5 pr-3 text-muted-foreground">{row.teamNames.join(', ') || '—'}</td>
              <td className="py-2.5">{row.openTasks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
