import type { AgentConnection, WorkspaceAgent } from '../types';
import { agentAccentColor } from './agentAccent';
import { AGENT_TEMPLATES } from './agentTemplates';
import type { SystemCapabilities } from './backendClient';

// ---------------------------------------------------------------------------
// What the Skills window shows, decided here rather than inside the component.
//
// THE ROW IS A SKILL; THE AGENTS ARE CHIPS ON IT. The page has to answer "which
// agents can do what" at a glance, and one row per skill answers it in one
// glance — the same skill on three agents is one row with three chips, not
// three rows, and the list stays the length of the skill set rather than
// (agents x skills).
//
// Two different things share one list — skills, and skill LIBRARIES found on
// the backend host — so selection has to name which kind it is. Keying
// selection on a bare string would let a library called "research" and a skill
// called "research" select each other, which is the sort of bug that only shows
// up on somebody else's workspace.
// ---------------------------------------------------------------------------

/**
 * How ONE agent came to claim ONE skill.
 *
 * This is per (agent, skill), not per skill, because it is the answer to the
 * question the page exists for: a live daemon that reports `browse` really can
 * browse, and an offline agent with `browse` typed into its form is a claim
 * nobody has checked. Rolling that up to the skill would lose exactly the
 * distinction that matters.
 */
export type SkillClaimSource = 'advertised' | 'configured';

/** Where a skill came from at all. */
export type SkillOrigin =
  /** At least one agent in this workspace carries it. */
  | 'agent'
  /** agensis ships it (a template's skill layer) and nobody here carries it yet. */
  | 'catalog'
  /**
   * Written in this workspace, in the app (`workspace_skills`), and carried by
   * no agent yet. Distinguished from 'catalog' because the two need opposite
   * things from a reader: a catalog skill is waiting to be ATTACHED to an agent,
   * while a stored skill is already readable by every agent through `read_skill`
   * and is waiting only to be USED.
   */
  | 'workspace';

export interface SkillAgentRef {
  id: string;
  name: string;
  handle: string;
  runMode: string;
  source: SkillClaimSource;
  /** A live daemon connection is advertising this agent's capabilities now. */
  connected: boolean;
  /** Slack-style chip identity: initials on a solid colour. NEVER an emoji. */
  initials: string;
  color: string;
}

export interface SkillEntry {
  name: string;
  /** Every agent that has it. The same skill under several agents is the POINT. */
  agents: SkillAgentRef[];
  origin: SkillOrigin;
  /** At least one agent's live daemon advertised it itself. */
  advertised: boolean;
  /**
   * A body for this name is stored in `workspace_skills`.
   *
   * Independent of `origin`: a skill can be carried by three agents (origin
   * 'agent') AND have a workspace-authored body, which is the good case — the
   * name is claimed and the procedure behind it exists. It is also what makes
   * the row editable, since only stored skills have anything to edit.
   */
  stored: boolean;
  /** The stored row's id, for the edit affordance. '' when nothing is stored. */
  storedId: string;
  /** The stored `description:` line, shown under the name. '' when unstored. */
  summary: string;
}

/**
 * The bit of a stored `workspace_skills` row a list row needs.
 *
 * Deliberately not the whole WorkspaceSkill: the list never renders a body, and
 * a narrower parameter keeps the (pure, unit-tested) view builder independent of
 * the wire shape the routes happen to return.
 */
export interface StoredSkillRef {
  id: string;
  name: string;
  summary: string;
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
 * Up to two initials for a chip. Letters and digits only, so a handle like
 * `_ops` or an agent called `@qa` still yields something legible rather than
 * punctuation. NEVER an emoji — same house rule the workspace tiles follow.
 */
export function skillAgentInitials(agent: Pick<WorkspaceAgent, 'name' | 'handle'>): string {
  const source = String(agent.name || agent.handle || '').trim();
  const words = source.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/**
 * Every skill id agensis itself ships, from the agent templates' skill layers
 * (today: the Sandbox Agent's provisioning + provider skills).
 *
 * These have no advertising daemon and may be carried by nobody, but they are
 * real, readable skills — agensis holds their definitions — so hiding them
 * would make the page lie about what the workspace can do.
 */
export function catalogSkillNames(): string[] {
  const names = new Set<string>();
  for (const template of AGENT_TEMPLATES) {
    for (const skill of template.skills) {
      const name = String(skill).trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Skill name -> the agents that have it.
 *
 * The UNION of both sources per agent, not one or the other. An earlier version
 * took a connected agent's advertised list INSTEAD of its configured one, so
 * the moment a daemon connected, every skill somebody had typed into that
 * agent's profile disappeared from the page — including the sandbox provider
 * skills, which are configured by definition and never advertised.
 */
export function buildSkillEntries(
  agents: readonly WorkspaceAgent[],
  connections: readonly AgentConnection[],
  catalog: readonly string[] = catalogSkillNames(),
  stored: readonly StoredSkillRef[] = [],
): SkillEntry[] {
  const connByAgent = new Map<string, AgentConnection>();
  for (const conn of connections) {
    const key = String(conn.agent_id || conn.handle || '').toLowerCase();
    if (key) connByAgent.set(key, conn);
  }

  const bySkill = new Map<string, SkillAgentRef[]>();
  for (const agent of agents) {
    if (agent.enabled === false) continue;
    const conn = connByAgent.get(String(agent.id).toLowerCase())
      || connByAgent.get(String(agent.handle || '').toLowerCase());
    const advertised = new Set(normalizeSkills(conn?.capabilities?.skills));
    const configured = normalizeSkills(agent.skills);
    const connected = advertised.size > 0;

    for (const skill of new Set([...advertised, ...configured])) {
      const chips = bySkill.get(skill) || [];
      chips.push({
        id: String(agent.id),
        name: agent.name,
        handle: String(agent.handle || ''),
        runMode: String(agent.run_mode || 'builtin'),
        source: advertised.has(skill) ? 'advertised' : 'configured',
        connected,
        initials: skillAgentInitials(agent),
        color: agentAccentColor(agent),
      });
      bySkill.set(skill, chips);
    }
  }

  // Catalog skills nobody carries still get a row — with no chips, which is
  // itself the honest answer to "which agents can use this": none, yet.
  for (const name of catalog) {
    if (!bySkill.has(name)) bySkill.set(name, []);
  }

  // Workspace-authored skills, same rule and a stronger reason. A stored skill
  // that no agent carries is not a placeholder: its body is readable RIGHT NOW
  // by any agent via `read_skill`. Hiding it until somebody typed the name onto
  // an agent would put the store back where it started — a procedure nothing
  // could find. Added last so a name an agent already claims keeps its chips.
  const storedByName = new Map<string, StoredSkillRef>();
  for (const entry of stored) {
    const name = String(entry?.name || '').trim();
    if (!name) continue;
    storedByName.set(name.toLowerCase(), entry);
    if (![...bySkill.keys()].some(existing => existing.toLowerCase() === name.toLowerCase())) {
      bySkill.set(name, []);
    }
  }

  return [...bySkill.entries()]
    .map(([name, chips]) => {
      const row = storedByName.get(name.toLowerCase());
      return {
        name,
        agents: chips,
        // 'agent' whenever anybody carries it, because that is the more useful
        // fact about a row; 'workspace' before 'catalog' for an uncarried name,
        // since a stored body is real and a catalog name is only a definition
        // agensis ships.
        origin: (chips.length > 0 ? 'agent' : row ? 'workspace' : 'catalog') as SkillOrigin,
        advertised: chips.some(chip => chip.source === 'advertised'),
        stored: Boolean(row),
        storedId: row?.id || '',
        summary: row?.summary || '',
      };
    })
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
