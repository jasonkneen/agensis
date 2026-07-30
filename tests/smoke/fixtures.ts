// Seed data for the smoke gate.
//
// Every item carries a unique, unmistakable marker (`Smoke<Thing>01`) so the
// assertion "all N items are on screen" is a plain substring check against the
// rendered text, and stays true through markup changes.
//
// The markers deliberately look nothing like real content: if one ever appears
// in a screenshot or a bug report, it came from here.

import type {
  ActivityEvent,
  AgentConnection,
  AgentMemoryFile,
  InboxItem,
  Message,
  Task,
  WorkspaceAgent,
} from '../../src/types';
import type { WorkspaceMember } from '../../src/hooks/useSharing';
import type { WorkspaceUser, WorkspaceInvite } from '../../src/hooks/useWorkspaceUsers';
import type { TenantAccount } from '../../src/lib/tenants';
import { SEED_COUNT } from './harness';

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
export const CURRENT_USER_ID = '22222222-2222-4222-8222-222222222222';
export const CURRENT_USER_EMAIL = 'smoke@example.test';
/**
 * Who created the seeded agents. Deliberately NOT `CURRENT_USER_ID` — that is
 * the incident's precondition (a workspace full of agents somebody else made)
 * and the state in which the owner filter used to empty the screen.
 */
export const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';

const NOW = '2026-07-27T05:00:00.000Z';

function seq(): number[] {
  return Array.from({ length: SEED_COUNT }, (_, i) => i + 1);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// --- Agents ----------------------------------------------------------------

export const AGENT_MARKERS = seq().map(n => `SmokeAgent${pad(n)}`);

export function seedAgents(overrides: Partial<WorkspaceAgent> = {}): WorkspaceAgent[] {
  return seq().map((n, i) => ({
    id: `agent-${pad(n)}`,
    workspace_id: WORKSPACE_ID,
    name: AGENT_MARKERS[i],
    avatar: 'bot',
    accent_color: '#6366f1',
    description: `Seeded agent ${pad(n)}`,
    system_prompt: 'You are a seeded agent.',
    tools: [],
    skills: [],
    handle: `smokeagent${pad(n)}`,
    model: 'auto',
    run_mode: 'daemon' as const,
    enabled: true,
    created_by: OTHER_USER_ID,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }));
}

// --- Skills ----------------------------------------------------------------
//
// A skill reaches this surface through a daemon connection's capabilities, so
// the fixture seeds CONNECTIONS, not a `skills` array — the path the real data
// takes.

export const SKILL_MARKERS = seq().map(n => `smoke-skill-${pad(n)}`);

export function seedConnections(agents: WorkspaceAgent[]): AgentConnection[] {
  return agents.map((agent, i) => ({
    id: `conn-${pad(i + 1)}`,
    workspace_id: WORKSPACE_ID,
    agent_id: agent.id,
    name: agent.name,
    handle: agent.handle || agent.name,
    host: 'smoke-host',
    cwd: '/smoke',
    status: 'online' as const,
    metadata: {},
    capabilities: { skills: [SKILL_MARKERS[i]] },
    connected_at: NOW,
    last_seen_at: NOW,
    updated_at: NOW,
  }));
}

// --- Chat ------------------------------------------------------------------

export const MESSAGE_MARKERS = seq().map(n => `SmokeMessage${pad(n)}`);

export function seedMessages(): Message[] {
  return seq().map((n, i) => ({
    id: `msg-${pad(n)}`,
    session_id: 'session-1',
    role: (n % 2 === 0 ? 'assistant' : 'user') as 'user' | 'assistant',
    content: MESSAGE_MARKERS[i],
    sender_kind: n % 2 === 0 ? 'agent' : 'user',
    sender_id: n % 2 === 0 ? 'agent-01' : CURRENT_USER_ID,
    sender_name: n % 2 === 0 ? AGENT_MARKERS[0] : 'Smoke Human',
    created_at: `2026-07-27T05:0${i}:00.000Z`,
  }));
}

// --- Tasks -----------------------------------------------------------------

export const TASK_MARKERS = seq().map(n => `SmokeTask${pad(n)}`);

export function seedTasks(overrides: Partial<Task> = {}): Task[] {
  return seq().map((n, i) => ({
    id: `task-${pad(n)}`,
    workspace_id: WORKSPACE_ID,
    created_by: OTHER_USER_ID,
    assignee_id: null,
    parent_id: null,
    title: TASK_MARKERS[i],
    description: '',
    status: 'todo' as const,
    priority: 'normal' as const,
    due_date: null,
    start_date: null,
    source_type: 'manual' as const,
    source_id: null,
    completed_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }));
}

// --- Activity --------------------------------------------------------------

export const ACTIVITY_MARKERS = seq().map(n => `SmokeEvent${pad(n)}`);

export function seedActivity(): ActivityEvent[] {
  return seq().map((n, i) => ({
    id: `event-${pad(n)}`,
    workspace_id: WORKSPACE_ID,
    user_id: CURRENT_USER_ID,
    event_type: 'task_created' as ActivityEvent['event_type'],
    entity_type: 'task',
    entity_id: `task-${pad(n)}`,
    title: ACTIVITY_MARKERS[i],
    metadata: {},
    created_at: NOW,
  }));
}

// --- Members / invites -----------------------------------------------------

export const MEMBER_MARKERS = seq().map(n => `smokemember${pad(n)}@example.test`);

export function seedMembers(): WorkspaceUser[] {
  return seq().map((n, i) => ({
    id: `member-${pad(n)}`,
    user_id: `user-${pad(n)}`,
    email: MEMBER_MARKERS[i],
    role: 'editor' as WorkspaceUser['role'],
    invited_by: null,
    created_at: NOW,
  }));
}

export function seedTaskMembers(): WorkspaceMember[] {
  return seq().map((n, i) => ({
    id: `member-${pad(n)}`,
    workspace_id: WORKSPACE_ID,
    user_id: `user-${pad(n)}`,
    role: 'editor' as WorkspaceMember['role'],
    invited_by: null,
    created_at: NOW,
    email: MEMBER_MARKERS[i],
  }));
}

export const INVITE_MARKERS = seq().map(n => `smokeinvite${pad(n)}@example.test`);

export function seedInvites(overrides: Partial<WorkspaceInvite> = {}): WorkspaceInvite[] {
  return seq().map((n, i) => ({
    id: `invite-${pad(n)}`,
    workspace_id: WORKSPACE_ID,
    token: `tok-${pad(n)}`,
    email: INVITE_MARKERS[i],
    role: 'editor' as WorkspaceInvite['role'],
    status: 'pending' as const,
    created_by_email: CURRENT_USER_EMAIL,
    accepted_by_email: null,
    accepted_at: null,
    expires_at: null,
    dismissed_at: null,
    created_at: NOW,
    ...overrides,
  }));
}

// --- Memory ----------------------------------------------------------------

export const MEMORY_MARKERS = seq().map(n => `smoke-memory-${pad(n)}.md`);

export function seedMemoryFiles(): AgentMemoryFile[] {
  return seq().map((n, i) => ({
    id: `memfile-${pad(n)}`,
    workspace_id: WORKSPACE_ID,
    agent_id: 'agent-01',
    path: `memory/${MEMORY_MARKERS[i]}`,
    kind: 'memory',
    summary: `Seeded memory file ${pad(n)}`,
    byte_size: 128,
    editable: false,
    last_synced: NOW,
    created_at: NOW,
    updated_at: NOW,
  }));
}

// --- Inbox -----------------------------------------------------------------

export const INBOX_MARKERS = seq().map(n => `SmokeInboxItem${pad(n)}`);

export function seedInboxItems(options: { unread?: boolean } = {}): InboxItem[] {
  const unread = options.unread ?? true;
  return seq().map((n, i) => ({
    id: `mention:inbox-${pad(n)}`,
    category: 'mention' as const,
    // The row's headline is derived from the category ("Mentioned you"), so the
    // marker has to ride the body — which is what the list actually shows.
    title: INBOX_MARKERS[i],
    body: INBOX_MARKERS[i],
    contextKey: `thread:inbox-${pad(n)}`,
    sessionId: null,
    entityType: null,
    entityId: null,
    actorName: 'Smoke Human',
    createdAt: NOW,
    unread,
  }));
}

// --- Tenants ---------------------------------------------------------------

export const TENANT_MARKERS = seq().map(n => `SmokeTenant${pad(n)}`);

export function seedTenants(): TenantAccount[] {
  return seq().map((n, i) => ({
    id: `tenant-${pad(n)}`,
    email: `tenant${pad(n)}@example.test`,
    display_name: TENANT_MARKERS[i],
    accent_color: '#6366f1',
    created_at: NOW,
    owned_workspace_count: 1,
    membership_count: 2,
  }));
}

// --- No-op callbacks -------------------------------------------------------
//
// Every handler a surface is given does nothing. That is what makes the
// trap-state prober safe: it clicks real controls, and a click cannot reach
// anything outside the mount.

export const noop = () => { };
export const asyncNoop = async () => { };
export const asyncNull = async () => null;
export const asyncTrue = async () => true;
