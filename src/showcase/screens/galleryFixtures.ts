// Realistic-looking seed data for the DEV screen gallery (/#screens).
//
// Same row shapes as tests/smoke/fixtures.ts, but that file imports the smoke
// harness (node:fs) and its markers are deliberately unreadable — fine for an
// assertion, useless for judging a layout. Nothing here leaves the browser.

import type { ActivityEvent, AgentConnection, Message, Task, WorkspaceAgent } from '@/types';
import type { WorkspaceMember } from '@/hooks/useSharing';
import type { WorkspaceUser } from '@/hooks/useWorkspaceUsers';

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
export const CURRENT_USER_ID = '22222222-2222-4222-8222-222222222222';
export const CURRENT_USER_EMAIL = 'you@example.test';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const AGENTS: Array<[string, string, string]> = [
  ['Ada', 'Lead engineer — plans the work and reviews every merge', '#6366f1'],
  ['Scout', 'Researches APIs and writes the findings up', '#0ea5e9'],
  ['Quill', 'Writes release notes and docs', '#f59e0b'],
  ['Forge', 'Builds and ships the desktop app', '#10b981'],
  ['Atlas', 'Keeps the roadmap and the board tidy', '#ec4899'],
  ['Echo', 'Answers support threads', '#8b5cf6'],
];

export function seedAgents(): WorkspaceAgent[] {
  return AGENTS.map(([name, description, accent], i) => ({
    id: `agent-${i + 1}`,
    workspace_id: WORKSPACE_ID,
    name,
    avatar: 'bot',
    accent_color: accent,
    description,
    system_prompt: '',
    tools: [],
    skills: [],
    handle: name.toLowerCase(),
    model: 'auto',
    run_mode: 'daemon' as const,
    enabled: true,
    created_by: OTHER_USER_ID,
    created_at: NOW,
    updated_at: NOW,
  }));
}

const SKILLS = ['release-notes', 'code-review', 'web-research', 'figma-export', 'sql-explain', 'triage'];

export function seedConnections(agents: WorkspaceAgent[]): AgentConnection[] {
  return agents.map((agent, i) => ({
    id: `conn-${i + 1}`,
    workspace_id: WORKSPACE_ID,
    agent_id: agent.id,
    name: agent.name,
    handle: agent.handle || agent.name,
    host: i % 2 ? 'studio-mac' : 'build-box',
    cwd: '/work',
    status: (i === 4 ? 'offline' : 'online') as AgentConnection['status'],
    metadata: {},
    capabilities: { skills: [SKILLS[i % SKILLS.length]], clis: [], mcpServers: [], memoryRoot: null },
    connected_at: NOW,
    last_seen_at: NOW,
    updated_at: NOW,
  }));
}

const LINES: Array<[boolean, string]> = [
  [false, 'Can we get the invite flow down to one screen? It has three headers for one member.'],
  [true, 'Yes. The window title already says **Users**, so the content can drop its own title and lead with the list. I will keep the role picker and the copy-link button on one row.'],
  [false, 'And the theme picker — there are four families now. Pick one engine.'],
  [true, 'Agreed. One engine, seeded by a neutral tint and an accent, generates both light and dark. The old families stay reachable until you sign off on removing them.'],
];

export function seedMessages(): Message[] {
  return LINES.map(([agent, content], i) => ({
    id: `msg-${i + 1}`,
    session_id: 'session-1',
    role: (agent ? 'assistant' : 'user') as 'user' | 'assistant',
    content,
    sender_kind: agent ? 'agent' : 'user',
    sender_id: agent ? 'agent-1' : CURRENT_USER_ID,
    sender_name: agent ? 'Ada' : 'You',
    created_at: ago((LINES.length - i) * 4),
  }));
}

const TASKS: Array<[string, Task['status'], Task['priority']]> = [
  ['Unify theme families into one engine', 'in_progress', 'high'],
  ['Users window: drop the duplicate header', 'todo', 'high'],
  ['Composer parity between main and sub-thread', 'todo', 'normal'],
  ['Reply summaries under messages', 'todo', 'normal'],
  ['Audit empty states', 'done', 'low'],
  ['Dark outer ring on light-lined chips', 'todo', 'low'],
];

export function seedTasks(): Task[] {
  return TASKS.map(([title, status, priority], i) => ({
    id: `task-${i + 1}`,
    workspace_id: WORKSPACE_ID,
    created_by: OTHER_USER_ID,
    assignee_id: null,
    parent_id: null,
    title,
    description: '',
    status,
    priority,
    due_date: null,
    start_date: null,
    source_type: 'manual' as const,
    source_id: null,
    completed_at: status === 'done' ? NOW : null,
    created_at: ago(i * 90),
    updated_at: ago(i * 30),
  }));
}

export function seedActivity(): ActivityEvent[] {
  return TASKS.map(([title], i) => ({
    id: `event-${i + 1}`,
    workspace_id: WORKSPACE_ID,
    user_id: CURRENT_USER_ID,
    event_type: 'task_created' as ActivityEvent['event_type'],
    entity_type: 'task',
    entity_id: `task-${i + 1}`,
    title,
    metadata: {},
    created_at: ago(i * 47),
  }));
}

const EMAILS = ['you@example.test', 'sam@example.test', 'riley@example.test', 'morgan@example.test'];

export function seedMembers(count = EMAILS.length): WorkspaceUser[] {
  return EMAILS.slice(0, count).map((email, i) => ({
    id: `member-${i + 1}`,
    user_id: i === 0 ? CURRENT_USER_ID : `user-${i + 1}`,
    email,
    role: (i === 0 ? 'owner' : i === 1 ? 'admin' : 'editor') as WorkspaceUser['role'],
    invited_by: null,
    created_at: NOW,
  }));
}

export function seedTaskMembers(): WorkspaceMember[] {
  return seedMembers().map(m => ({
    id: m.id ?? `member-${m.user_id}`,
    workspace_id: WORKSPACE_ID,
    user_id: m.user_id,
    role: (m.role === 'owner' ? 'owner' : 'editor') as WorkspaceMember['role'],
    invited_by: null,
    created_at: NOW,
    email: m.email,
  }));
}

export const noop = () => { };
export const asyncNoop = async () => { };
export const asyncNull = async () => null;
export const asyncTrue = async () => true;
