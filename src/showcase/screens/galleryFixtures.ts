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
  // Shaped like a real feed: an agent flapping on and off (the run that
  // collapses), a sender posting several messages, and one-off task events.
  const rows: Array<[ActivityEvent['event_type'], string, number, Record<string, unknown>]> = [
    ['agent_connected' as ActivityEvent['event_type'], '@coder connected', 3, {}],
    ['agent_disconnected' as ActivityEvent['event_type'], '@coder disconnected', 4, {}],
    ['agent_connected' as ActivityEvent['event_type'], '@coder connected', 14, {}],
    ['agent_disconnected' as ActivityEvent['event_type'], '@coder disconnected', 15, {}],
    ['agent_connected' as ActivityEvent['event_type'], '@coder connected', 75, {}],
    ['agent_disconnected' as ActivityEvent['event_type'], '@coder disconnected', 76, {}],
    ['agent_connected' as ActivityEvent['event_type'], '@spark-1 connected', 80, {}],
    ['task_created', 'Unify theme families into one engine', 95, {}],
    ['message_sent' as ActivityEvent['event_type'], 'Ada: message', 100, { content: 'Yes, the window title already says Users.', sender_name: 'Ada', role: 'assistant' }],
    ['message_sent' as ActivityEvent['event_type'], 'Ada: message', 104, { content: 'I will keep the role picker on one row.', sender_name: 'Ada', role: 'assistant' }],
    ['message_sent' as ActivityEvent['event_type'], 'Ada: message', 109, { content: 'Pushed the Users window change.', sender_name: 'Ada', role: 'assistant' }],
    ['task_created', 'Audit empty states', 200, {}],
  ];
  return rows.map(([event_type, title, minutes, metadata], i) => ({
    id: `event-${i + 1}`,
    workspace_id: WORKSPACE_ID,
    user_id: CURRENT_USER_ID,
    event_type,
    entity_type: 'task',
    entity_id: `task-${i + 1}`,
    title,
    metadata,
    created_at: ago(minutes),
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

// --- Inbox -----------------------------------------------------------------

const INBOX: Array<[string, string, string, string, boolean, number]> = [
  ['approval', 'Ada wants to run a shell command', 'npm run build in agensis-ux — allow once, or always for this folder?', 'Ada', true, 3],
  ['mention', 'Scout mentioned you in #research', '@you the OpenRouter pricing page changed on Monday; three of our models moved tiers.', 'Scout', true, 18],
  ['task', 'Quill finished “Release notes: inbox”', 'Ready for review. I kept the language plain and dropped the internal names.', 'Quill', true, 47],
  ['mention', 'Riley replied in #design', 'Agree on one framed list. Can the bin stay visible while it is confirming?', 'Riley', false, 130],
  ['task', 'Forge is blocked on signing', 'The notarisation key expired yesterday; nothing ships to the desktop until it is renewed.', 'Forge', false, 260],
];

export function seedInboxItems() {
  return INBOX.map(([category, title, body, actorName, unread, minutes], i) => ({
    id: `${category}:inbox-${i + 1}`,
    category,
    title,
    body,
    contextKey: `thread:inbox-${i + 1}`,
    sessionId: null,
    entityType: null,
    entityId: null,
    actorName,
    createdAt: ago(minutes),
    unread,
  }));
}

// Docs are HTML (a contentEditable editor), not markdown.
export const SAMPLE_DOC_MARKDOWN = `<h1>Theme engine</h1>
<p>The Default theme is <strong>generated</strong> from four choices.</p>
<table><thead><tr><th>Seed</th><th>What it moves</th></tr></thead><tbody>
<tr><td>Palette</td><td>The tint of every neutral surface and line</td></tr>
<tr><td>Colour</td><td>The primary: buttons, focus, selection</td></tr>
<tr><td>Contrast</td><td>How far text and lines sit from the page</td></tr>
<tr><td>Depth</td><td>Hard, soft or flat shadows</td></tr>
</tbody></table>
<h2>Why</h2>
<ul><li>One engine instead of four hand-written families</li><li>Secondary text is <em>solved</em> to a contrast target, never picked</li></ul>
<pre><code>const tokens = buildThemeTokens(seed, 'dark');</code></pre>`;

// --- Settings / Resources / Files / Nostr (data those surfaces fetch) --------

const cli = (id: string, label: string, available: boolean, version: string | null) =>
  ({ id, label, command: id, available, path: available ? `/usr/local/bin/${id}` : null, version, install_hint: available ? null : `npm i -g ${id}` });

export const SYSTEM_CAPABILITIES = {
  checkedAt: new Date().toISOString(),
  workspacePath: '/work/agensis',
  clis: [cli('claude', 'Claude Code', true, '2.4.1'), cli('codex', 'Codex', true, '0.92.0'), cli('amp', 'Amp', false, null), cli('grok', 'Grok', true, '1.3.0')],
  packages: [
    { name: '@anthropic-ai/claude-agent-sdk', available: true, version: '0.9.2', path: '/work/node_modules/@anthropic-ai/claude-agent-sdk' },
    { name: 'node-pty', available: true, version: '1.1.0', path: '/work/node_modules/node-pty' },
  ],
  skills: [
    { id: 'claude-skills', label: 'Claude skills', type: 'claude', path: '~/.claude/skills', available: true, count: 24 },
    { id: 'codex-skills', label: 'Codex skills', type: 'codex', path: '~/.codex/skills', available: true, count: 6 },
  ],
  codexAppServer: { available: true, command: 'codex app-server', transports: ['stdio'] },
};

export const GATEWAYS = [
  { id: 'gw-1', workspace_id: WORKSPACE_ID, name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet', protocol: 'openai', has_key: true },
  { id: 'gw-2', workspace_id: WORKSPACE_ID, name: 'Local Ollama', base_url: 'http://localhost:11434/v1', model: 'qwen3:32b', protocol: 'openai', has_key: false },
];

export const RESOURCES = [
  ['Production database', 'Postgres behind the API; reads are open, writes go through the steward', 'database', 'agent-4', 'active'],
  ['Release pipeline', 'Builds, signs and publishes the desktop app', 'deployment', 'agent-1', 'active'],
  ['Design tokens', 'The theme engine seeds and palettes', 'context', 'agent-3', 'archived'],
].map(([name, description, facet, steward, status], i) => ({
  id: `res-${i + 1}`, workspace_id: WORKSPACE_ID, steward_agent_id: steward, controller_id: null, name, description, facet,
  descriptor: {}, version: 3 + i, visibility: 'workspace', status, deleted_at: null, created_by: CURRENT_USER_ID,
  created_at: ago(60 * 24 * (i + 2)), updated_at: ago(90 * (i + 1)),
}));


export const NOSTR_CONNECTION = {
  id: 'nostr-1', workspaceId: WORKSPACE_ID, relayHttpUrl: 'https://relay.example.test', relayWsUrl: 'wss://relay.example.test',
  communityId: 'agent-builders', host: 'relay.example.test', name: 'Agent Builders', description: 'People building agent tools in the open',
  relayPubkey: 'npub1relay', memberPubkey: 'npub1you', policyVersion: '1', status: 'active', lastError: '', subscriptions: [],
};

export const NOSTR_CHANNELS = [
  ['general', 'Anything about building agents', true, true],
  ['show-and-tell', 'Demos and screenshots', true, false],
  ['mcp', 'Model Context Protocol servers', true, true],
  ['hiring', 'Jobs and contracts', false, false],
].map(([name, description, joined, subscribed], i) => ({
  id: `nc-${i + 1}`, name: name as string, description: description as string, type: 'chat', visibility: 'public' as const,
  archived: false, joined: joined as boolean,
  subscription: subscribed ? { bridgeId: `br-${i}`, channelId: `nc-${i + 1}`, sessionId: `s-n${i}`, enabled: i !== 2, status: i === 2 ? 'paused' : 'live', lastError: '' } : null,
}));
