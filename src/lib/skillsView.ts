import type { AgentConnection, WorkspaceAgent } from '../types';
import type { SystemCapabilities } from './backendClient';

// ---------------------------------------------------------------------------
// What the Skills window shows, decided here rather than inside the component.
//
// Two different things share one list — skills that agents advertise, and skill
// LIBRARIES a daemon enumerated on its machine — so selection has to name which
// kind it is. Keying selection on a bare string would let a library called
// "research" and a skill called "research" select each other, which is the sort
// of bug that only shows up on somebody else's workspace.
// ---------------------------------------------------------------------------

/** Where a skill's membership came from. */
export type SkillSource = 'synced' | 'configured';

export interface SkillAgentRef {
  id: string;
  name: string;
  handle: string;
  runMode: string;
  /** The daemon is connected right now and advertised this skill itself. */
  connected: boolean;
}

export interface SkillEntry {
  name: string;
  agents: SkillAgentRef[];
  /**
   * 'synced' when at least one agent's LIVE daemon connection advertised it,
   * 'configured' when every claim comes from the agent row's own skills list.
   *
   * The component already made this distinction to pick a source and then threw
   * it away, so the list could not tell you whether a skill is one a machine
   * actually has or one somebody typed into a form. In a preview that is the
   * single most useful fact about a skill, so it is kept.
   */
  source: SkillSource;
}

export interface LibraryEntry {
  id: string;
  label: string;
  path: string;
  type: string;
  count: number;
}

export type SkillsSelection =
  | { kind: 'skill'; name: string }
  | { kind: 'library'; id: string }
  | null;

function normalizeSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v).trim()).filter(Boolean);
}

/**
 * Skill name -> the agents that expose it.
 *
 * A live daemon connection's capabilities win over the agent row's configured
 * list, because the machine is the authority on what it can actually do; the
 * configured list is what we have to go on when nothing is connected.
 */
export function buildSkillEntries(
  agents: readonly WorkspaceAgent[],
  connections: readonly AgentConnection[],
): SkillEntry[] {
  const connByAgent = new Map<string, AgentConnection>();
  for (const conn of connections) {
    const key = String(conn.agent_id || conn.handle || '').toLowerCase();
    if (key) connByAgent.set(key, conn);
  }

  const bySkill = new Map<string, { agents: SkillAgentRef[]; anySynced: boolean }>();
  for (const agent of agents) {
    if (agent.enabled === false) continue;
    const conn = connByAgent.get(String(agent.id).toLowerCase())
      || connByAgent.get(String(agent.handle || '').toLowerCase());
    const synced = normalizeSkills(conn?.capabilities?.skills);
    const fromDaemon = synced.length > 0;
    const skills = fromDaemon ? synced : normalizeSkills(agent.skills);

    for (const skill of skills) {
      const bucket = bySkill.get(skill) || { agents: [], anySynced: false };
      bucket.agents.push({
        id: String(agent.id),
        name: agent.name,
        handle: String(agent.handle || ''),
        runMode: String(agent.run_mode || 'builtin'),
        connected: fromDaemon,
      });
      if (fromDaemon) bucket.anySynced = true;
      bySkill.set(skill, bucket);
    }
  }

  return [...bySkill.entries()]
    .map(([name, bucket]) => ({
      name,
      agents: bucket.agents,
      source: (bucket.anySynced ? 'synced' : 'configured') as SkillSource,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Daemon-enumerated skill/agent libraries, biggest first. */
export function buildLibraryEntries(capabilities: SystemCapabilities | null): LibraryEntry[] {
  return (capabilities?.skills || [])
    .filter(lib => lib.available && (lib.type === 'skills' || lib.type === 'agents'))
    .sort((a, b) => b.count - a.count)
    .map(lib => ({
      id: lib.id,
      label: lib.label,
      path: lib.path,
      type: lib.type,
      count: lib.count,
    }));
}

/** Case-insensitive match on the skill name OR any agent that exposes it. */
export function filterSkills(entries: readonly SkillEntry[], query: string): SkillEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter(entry =>
    entry.name.toLowerCase().includes(q)
    || entry.agents.some(agent => agent.name.toLowerCase().includes(q)),
  );
}

export function filterLibraries(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter(entry => entry.label.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q));
}

/**
 * Clicking the open row again closes the pane — the same toggle the agents grid
 * uses, so selection behaves the same way everywhere.
 */
export function toggleSkillsSelection(current: SkillsSelection, next: NonNullable<SkillsSelection>): SkillsSelection {
  if (!current) return next;
  if (current.kind !== next.kind) return next;
  if (current.kind === 'skill' && next.kind === 'skill') return current.name === next.name ? null : next;
  if (current.kind === 'library' && next.kind === 'library') return current.id === next.id ? null : next;
  return next;
}

/** Whether a row is the selected one. Kind is compared first — see the header. */
export function isSelected(selection: SkillsSelection, candidate: NonNullable<SkillsSelection>): boolean {
  if (!selection || selection.kind !== candidate.kind) return false;
  if (selection.kind === 'skill' && candidate.kind === 'skill') return selection.name === candidate.name;
  if (selection.kind === 'library' && candidate.kind === 'library') return selection.id === candidate.id;
  return false;
}

/**
 * A selection that no longer exists must not hold the pane open — a daemon
 * disconnecting can remove a skill from under a selected row, and a stale
 * selection would leave a detail pane describing something that is gone.
 */
export function selectionStillExists(
  selection: SkillsSelection,
  skills: readonly SkillEntry[],
  libraries: readonly LibraryEntry[],
): boolean {
  if (!selection) return false;
  if (selection.kind === 'skill') return skills.some(s => s.name === selection.name);
  return libraries.some(l => l.id === selection.id);
}

/**
 * Below this the two panes cannot both hold a readable column, so the detail
 * takes the whole surface with a back affordance. Same number the memory
 * browser uses — this is the same interaction and should break at the same
 * point.
 */
export const SKILLS_SPLIT_MIN_WIDTH = 960;
