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

const SCREENS: Screen[] = [
  { id: 'appearance', title: 'Appearance', icon: <Sun className="size-3.5" />, render: () => <AppearanceScreen /> },
  { id: 'users-solo', title: 'Users', icon: <Users className="size-3.5" />, render: () => <UsersWindowContent {...usersProps(seedMembers(1))} /> },
  { id: 'users', title: 'Users', icon: <Users className="size-3.5" />, render: () => <UsersWindowContent {...usersProps(seedMembers())} /> },
  {
    id: 'agents', title: 'Agents', icon: <Bot className="size-3.5" />, render: () => (
      <AgentsWindowContent
        agents={agents}
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
