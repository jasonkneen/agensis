import type { Task } from '../../types';

// Team and member numbers for the Teams and Members pages. A team's member_ids holds
// user ids and agent ids together; open tasks and projects are counted from the tasks
// those members are assigned.

const open = (task: Pick<Task, 'status'>) => task.status !== 'done' && task.status !== 'cancelled';

export interface TeamLike {
  id: string;
  name: string;
  member_ids: string[];
}

export interface TeamStats {
  people: number;
  agents: number;
  openTasks: number;
  projects: number;
}

export function teamStats(team: TeamLike, tasks: Pick<Task, 'status' | 'assignee_id' | 'project_id'>[], agentIds: Set<string>): TeamStats {
  const members = new Set(team.member_ids);
  const projects = new Set<string>();
  let openTasks = 0;
  for (const task of tasks) {
    if (!task.assignee_id || !members.has(task.assignee_id) || !open(task)) continue;
    openTasks += 1;
    if (task.project_id) projects.add(task.project_id);
  }
  const agents = team.member_ids.filter(id => agentIds.has(id)).length;
  return { people: team.member_ids.length - agents, agents, openTasks, projects: projects.size };
}

/** The same list with `id` added when absent and removed when present. */
export function toggleMember(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id];
}

export interface DirectoryRow {
  id: string;
  name: string;
  isAgent: boolean;
  role: string;
  teamNames: string[];
  openTasks: number;
}

export interface DirectoryPerson {
  id: string;
  name: string;
  isAgent: boolean;
  role: string;
}

/** One row per person or agent, with the teams they are in and their open task count. */
export function directory(people: DirectoryPerson[], teams: TeamLike[], tasks: Pick<Task, 'status' | 'assignee_id'>[]): DirectoryRow[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.assignee_id && open(task)) counts.set(task.assignee_id, (counts.get(task.assignee_id) ?? 0) + 1);
  }
  return people.map(person => ({
    ...person,
    teamNames: teams.filter(team => team.member_ids.includes(person.id)).map(team => team.name),
    openTasks: counts.get(person.id) ?? 0,
  }));
}
