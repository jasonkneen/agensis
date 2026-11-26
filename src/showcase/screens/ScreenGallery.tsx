// DEV-ONLY screen gallery: /#screens (all) or /#screens/<id> (one, full size).
//
// Renders the real presentational window contents from the smoke-gate fixture
// props, inside a replica of the floating window frame, so a screen can be
// LOOKED AT (and screenshotted by Playwright) without signing in, without a
// backend and without real data. Gated on import.meta.env.DEV in main.tsx, so
// Rollup drops this chunk from production builds.

import { useEffect, useState, type ReactNode } from 'react';
import { MoreHorizontal, Minus, X, Moon, Sun, Users, Bot, ListTodo, FolderKanban, Sparkles, Activity, Hash } from 'lucide-react';
import { useTheme, type ThemeMode } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

import { UsersWindowContent } from '@/components/windows/UsersWindowContent';
import { AgentsWindowContent } from '@/components/windows/AgentsWindowContent';
import { TasksWindowContent } from '@/components/windows/TasksWindowContent';
import { ProjectsWindowContent } from '@/components/windows/ProjectsWindowContent';
import { SkillsWindowContent } from '@/components/windows/SkillsWindowContent';
import { ActivityWindowContent } from '@/components/windows/ActivityWindowContent';
import { ChatWindowContent } from '@/components/windows/ChatWindowContent';
import { AppearancePanel } from '@/components/settings/AppearancePanel';
import { Sidebar } from '@/components/layout/Sidebar';
import { MemorySection } from '@/components/memory/MemorySection';
import { InboxWindowContent } from '@/components/inbox/InboxWindowContent';
import { ResourcesWindowContent } from '@/components/windows/ResourcesWindowContent';
import { NostrCommunitySetup } from '@/components/chat/NostrCommunitySetup';
import { Dialog, DialogContent } from '@agensis/ui/components/dialog';
import { HomeCanvas } from '@/components/home/HomeCanvas';
import { DocWindowContent } from '@/components/windows/DocWindowContent';
import { ChatThreadPanel } from '@/components/chat/ChatThreadPanel';
import { SchedulesWindow } from '@/components/windows/SchedulesWindow';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import {
  CURRENT_USER_EMAIL,
  CURRENT_USER_ID,
  WORKSPACE_ID,
  asyncNoop,
  asyncNull,
  asyncTrue,
  noop,
  seedActivity,
  seedAgents,
  seedConnections,
  seedMembers,
  seedMessages,
  seedTaskMembers,
  seedTasks,
  seedInboxItems,
  SAMPLE_DOC_MARKDOWN,
  SYSTEM_CAPABILITIES,
  GATEWAYS,
  RESOURCES,
  NOSTR_CONNECTION,
  NOSTR_CHANNELS,
} from './galleryFixtures';

interface Screen {
  id: string;
  title: string;
  icon: ReactNode;
  render: () => ReactNode;
}

const agents = seedAgents();
const tasksProps = {
  tasks: seedTasks(),
  members: seedTaskMembers(),
  agents,
  agentConnections: [],
  currentUserEmail: CURRENT_USER_EMAIL,
  workspaceId: WORKSPACE_ID,
  currentUserId: CURRENT_USER_ID,
  onCreateTask: asyncNull,
  onUpdateTask: noop,
  onToggleStatus: noop,
  onDeleteTask: noop,
  onUpdateAgent: noop,
};


const usersProps = (members: ReturnType<typeof seedMembers>) => ({
  workspaceName: 'Main',
  currentUserId: CURRENT_USER_ID,
  currentUserEmail: 'you@example.test',
  members,
  joinLinks: [],
  canManage: true,
  onCreateJoinLink: async () => { throw new Error('gallery'); },
  onRevokeJoinLink: asyncNoop,
  onRemoveMember: asyncNoop,
  onChangeMemberRole: asyncNoop,
});

function AppearanceScreen() {
  const { mode, setTheme } = useTheme();
  return (
    <div className="h-full overflow-auto p-5">
      <AppearancePanel workspace={null} onUpdateWorkspace={noop} themeMode={mode} onThemeChange={setTheme} />
    </div>
  );
}

function SidebarScreen() {
  const { mode, setTheme } = useTheme();
  const workspace = { id: WORKSPACE_ID, name: 'Workspace 1', created_at: new Date().toISOString() } as never;
  const sessions = ['general', 'design', 'release-notes'].map((title, i) => ({
    id: `s-${i}`, workspace_id: WORKSPACE_ID, title, model: 'auto', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })) as never;
  return (
    <div className="relative h-full w-[220px] overflow-hidden border-r border-border">
      <Sidebar
        workspace={workspace}
        collapsed={false}
        onToggleCollapse={noop}
        onOpenCommandPalette={noop}
        onNewChat={noop}
        onNewDocument={noop}
        onUploadFile={noop}
        onCreateWorkspace={noop}
        onDocumentOpen={noop}
        onSessionOpen={noop}
        onOpenMemory={noop}
        recents={[]}
        sessions={sessions}
        floatingWindows={[]}
        themeMode={mode}
        onThemeChange={setTheme}
        userEmail="you@example.test"
        onSignOut={noop}
        onOpenSettings={noop}
        notificationsSlot={<button type="button" aria-label="Notifications" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground"><Activity className="size-4" /></button>}
      />
    </div>
  );
}

// Some work assigned to agents so the triage strip has real numbers to show.
const agentTasks = seedTasks().map((task, i) => ({
  ...task,
  assignee_id: agents[i % agents.length].id,
  status: (['in_review', 'todo', 'in_progress', 'backlog', 'done', 'in_review'] as const)[i % 6],
  completed_at: i % 6 === 4 ? new Date().toISOString() : null,
}));

const memoryFacts = [
  ['Release notes go out with every user-visible change', 'process'],
  ['Default theme is generated from palette, colour, contrast and depth', 'design'],
  ['Desktop app runs the main checkout through vite dev', 'environment'],
  ['Never put emoji in UI chrome', 'design'],
].map(([fact, category], i) => ({ id: `fact-${i}`, workspace_id: WORKSPACE_ID, fact, category, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));

function SettingsScreen({ tab }: { tab: 'tools' | 'ai' }) {
  const { mode, setTheme } = useTheme();
  return (
    <SettingsDialog
      open
      onClose={noop}
      workspaceName="Main"
      userEmail="you@example.test"
      workspace={{ id: WORKSPACE_ID, name: 'Main', local_path: '/work/agensis' } as never}
      onUpdateWorkspace={noop}
      themeMode={mode}
      onThemeChange={setTheme}
      secretsWorkspaceId={WORKSPACE_ID}
      isWorkspaceOwner
      initialTab={tab}
    />
  );
}

// The gallery must never reach a real backend: apiUrl() points at production.
// Inbox gets fixtures; every other backend read gets an empty list. Asset and
// vite requests pass through.
if (typeof window !== 'undefined' && !(window as { __galleryFetch?: boolean }).__galleryFetch) {
  (window as { __galleryFetch?: boolean }).__galleryFetch = true;
  const realFetch = window.fetch.bind(window);
  const json = (data: unknown) => new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/inbox(\?|$)/.test(url)) return json({ items: seedInboxItems(), unreadCount: 3 });
    if (url.includes('/backend/system/capabilities')) return json(SYSTEM_CAPABILITIES);
    if (/\/resources\/[^/]+\/operations/.test(url)) return json([]);
    if (/\/resources(\?|$)/.test(url)) return json(RESOURCES);
    if (/\/nostr-communities\/[^/]+\/channels(\?|$)/.test(url)) return json(NOSTR_CHANNELS);
    if (/\/gateways(\?|$)/.test(url)) return json(GATEWAYS);
    if (url.includes('/backend/')) return json([]);
    return realFetch(input, init);
  };
}

const sampleDoc = {
  id: 'doc-1', workspace_id: WORKSPACE_ID, title: 'Theme engine', content: SAMPLE_DOC_MARKDOWN, is_favorite: false,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
} as never;

const threadMessages = seedMessages().map((m, i) => ({ ...m, thread_parent_id: i === 0 ? null : 'msg-1' }));

const SCREENS: Screen[] = [
  { id: 'resources', title: 'Resources', icon: <Sparkles className="size-3.5" />, render: () => <ResourcesWindowContent workspaceId={WORKSPACE_ID} agents={agents} /> },
  { id: 'nostr', title: 'Nostr community', icon: <Hash className="size-3.5" />, render: () => (
    // It is a dialog body in the app (needs Dialog for its DialogTitle).
    <Dialog open>
      <DialogContent className="max-w-2xl">
        <NostrCommunitySetup workspaceId={WORKSPACE_ID} onBack={noop} onClose={noop} onCreate={() => null} existingConnection={NOSTR_CONNECTION as never} />
      </DialogContent>
    </Dialog>
  ) },
  { id: 'inbox', title: 'Inbox', icon: <Users className="size-3.5" />, render: () => <InboxWindowContent workspaceId={WORKSPACE_ID} agents={agents} onReplyInThread={async () => ({ delivered: true })} /> },
  { id: 'home', title: 'Home', icon: <Sun className="size-3.5" />, render: () => (
    <div className="relative h-full"><HomeCanvas documents={[]} agents={agents} workspaceId={WORKSPACE_ID} memoryFacts={[]} onSendMessage={noop} onOpenNewDocument={noop} workspaceName="Main" /></div>
  ) },
  { id: 'doc', title: 'Theme engine', icon: <Sparkles className="size-3.5" />, render: () => (
    <DocWindowContent document={sampleDoc} onAutoSave={noop} onToggleFavorite={noop} onDelete={noop} onTitleChange={noop} fetchDocumentContent={async () => SAMPLE_DOC_MARKDOWN} />
  ) },
  { id: 'thread', title: 'Thread', icon: <Hash className="size-3.5" />, render: () => (
    <ChatThreadPanel parentMessage={threadMessages[0]} threadMessages={threadMessages} streaming={false} onSendReply={noop} onClose={noop} workspaceId={WORKSPACE_ID} currentUserId={CURRENT_USER_ID} />
  ) },
  { id: 'memory', title: 'Memory', icon: <Sparkles className="size-3.5" />, render: () => (
    <MemorySection facts={memoryFacts} categories={['process', 'design', 'environment']} onAdd={noop} onUpdate={noop} onDelete={noop}
      workspaceId={WORKSPACE_ID} agents={agents} userId={CURRENT_USER_ID} userEmail="you@example.test" documents={[]} />
  ) },
  { id: 'schedules', title: 'Automations', icon: <Activity className="size-3.5" />, render: () => <SchedulesWindow workspaceId={WORKSPACE_ID} agents={agents} sessions={[]} /> },
  { id: 'settings-tools', title: 'Settings', icon: <Sun className="size-3.5" />, render: () => <SettingsScreen tab="tools" /> },
  { id: 'settings-ai', title: 'Settings', icon: <Sun className="size-3.5" />, render: () => <SettingsScreen tab="ai" /> },
  { id: 'sidebar', title: 'Sidebar', icon: <Users className="size-3.5" />, render: () => <SidebarScreen /> },
  { id: 'appearance', title: 'Appearance', icon: <Sun className="size-3.5" />, render: () => <AppearanceScreen /> },
  { id: 'users-solo', title: 'Users', icon: <Users className="size-3.5" />, render: () => <UsersWindowContent {...usersProps(seedMembers(1))} /> },
  { id: 'users', title: 'Users', icon: <Users className="size-3.5" />, render: () => <UsersWindowContent {...usersProps(seedMembers())} /> },
  {
    id: 'agents', title: 'Agents', icon: <Bot className="size-3.5" />, render: () => (
      <AgentsWindowContent
        agents={agents}
        tasks={agentTasks}
        webhooks={[]}
        connections={seedConnections(agents)}
        workspaceId={WORKSPACE_ID}
        currentUserId={CURRENT_USER_ID}
        onCreateAgent={asyncTrue}
        onUpdateAgent={noop}
        onDeleteAgent={noop}
        onDisconnectAgent={asyncNull}
        onCreateWebhook={asyncNull}
        onUpdateWebhook={asyncNull}
        onInviteAgent={noop}
        onOpenConnections={noop}
      />
    ),
  },
  { id: 'tasks', title: 'Tasks', icon: <ListTodo className="size-3.5" />, render: () => <TasksWindowContent {...tasksProps} /> },
  { id: 'projects', title: 'Projects', icon: <FolderKanban className="size-3.5" />, render: () => <ProjectsWindowContent tasksProps={tasksProps} /> },
  {
    id: 'skills', title: 'Skills', icon: <Sparkles className="size-3.5" />, render: () => (
      <SkillsWindowContent agents={agents} agentConnections={seedConnections(agents)} systemCapabilities={null} workspaceId={WORKSPACE_ID} />
    ),
  },
  {
    id: 'activity', title: 'Activity', icon: <Activity className="size-3.5" />, render: () => (
      <ActivityWindowContent events={seedActivity()} loading={false} workspaceId={WORKSPACE_ID} currentUserId={CURRENT_USER_ID} />
    ),
  },
  {
    id: 'channel', title: 'general', icon: <Hash className="size-3.5" />, render: () => (
      <ChatWindowContent
        messages={seedMessages()}
        streaming={false}
        memoryFacts={[]}
        documents={[]}
        agents={agents}
        workspaceId={WORKSPACE_ID}
        sessionId="session-1"
        channelTitle="general"
        currentUserId={CURRENT_USER_ID}
        onSendMessage={noop}
        threadReplyCounts={{ 'msg-2': 3 }}
        onOpenThread={noop}
      />
    ),
  },
];

/** A replica of FloatingWindowShell's frame + title bar, without the window manager. */
function Frame({ screen, className }: { screen: Screen; className?: string }) {
  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-card', className)} data-window-surface>
      <div data-window-titlebar className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex shrink-0 items-center text-muted-foreground">{screen.icon}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-xs text-muted-foreground">Main</span>
          <span className="text-xs text-muted-foreground">{'>'}</span>
          <span className="truncate text-xs font-medium">{screen.title}</span>
        </div>
        <MoreHorizontal className="size-3.5 text-muted-foreground" />
        <Minus className="size-3.5 text-muted-foreground" />
        <X className="size-3.5 text-muted-foreground" />
      </div>
      <div className="min-h-0 flex-1">{screen.render()}</div>
    </div>
  );
}

function readRoute(): string | null {
  const [, id] = window.location.hash.replace('#', '').split('/');
  return id || null;
}

const MODES: ThemeMode[] = ['default-light', 'default-dark'];

export function ScreenGallery() {
  const { mode, setTheme } = useTheme();
  const [only, setOnly] = useState<string | null>(readRoute);

  useEffect(() => {
    const onHash = () => setOnly(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const screen = only ? SCREENS.find(s => s.id === only) : null;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-4 text-xs">
        <span className="font-medium">Screens</span>
        <a href="#screens" className="text-muted-foreground hover:text-foreground">All</a>
        {SCREENS.map(s => (
          <a key={s.id} href={`#screens/${s.id}`} className={cn('text-muted-foreground hover:text-foreground', only === s.id && 'text-foreground')}>{s.id}</a>
        ))}
        <div className="flex-1" />
        {MODES.map(m => (
          <button key={m} type="button" onClick={() => setTheme(m)} className={cn('flex items-center gap-1 text-muted-foreground', mode === m && 'text-foreground')}>
            {m.endsWith('dark') ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
            {m.replace('default-', '')}
          </button>
        ))}
      </div>
      {screen ? (
        <div className="min-h-0 flex-1 p-6">
          <Frame screen={screen} className="mx-auto h-full max-w-[1000px]" />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-6 overflow-auto p-6">
          {SCREENS.map(s => <Frame key={s.id} screen={s} className="h-[560px]" />)}
        </div>
      )}
    </div>
  );
}
