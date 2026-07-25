import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, FileText, Brain, Layers3, CheckCircle2, Activity, Bot, Trash2, Settings, Star, Sparkles, Command, Wrench, Pencil, Users, Ungroup, Minimize2, Maximize2, ArrowRight, Clock } from 'lucide-react';
import { useIsMobile } from './hooks/use-mobile';
import { Sidebar } from './components/layout/Sidebar';
import { NetworkStatusBar } from './components/layout/NetworkStatusBar';
import { HomeCanvas } from './components/home/HomeCanvas';
import { FloatingWindowShell } from './components/windows/FloatingWindowShell';
import { MobileWindowSwitcher } from './components/windows/MobileWindowSwitcher';
import { pickActiveWindowId } from './lib/mobileWindows';
import { computeGroupBounds, computeGroupRole } from './lib/windowGroups';
import { WindowGroupFrame } from './components/windows/WindowGroupFrame';
import { ChatWindowContent } from './components/windows/ChatWindowContent';
import { ChatWindowBody, DocWindowBody, TasksWindowBody } from './components/windows/WindowBodies';
import { MemorySection } from './components/memory/MemorySection';
import { SkillsWindowContent } from './components/windows/SkillsWindowContent';
import { OnboardingTour } from './components/onboarding/OnboardingTour';
import { GetStartedChecklist } from './components/onboarding/GetStartedChecklist';
import CommandPalette from './components/search/CommandPalette';
import { AuthPage } from './components/auth/AuthPage';
import { ShareDialog } from './components/sharing/ShareDialog';
import { CreateWorkspaceDialog } from './components/sharing/CreateWorkspaceDialog';
import { DrawingLayer } from './components/canvas/DrawingLayer';
import { CanvasDropZone } from './components/canvas/CanvasDropZone';
import { CanvasSelectionLayer } from './components/canvas/CanvasSelectionLayer';
import CanvasTemplatePicker from './components/canvas/CanvasTemplatePicker';
import { SettingsDialog, type SettingsTabId } from './components/settings/SettingsDialog';
import { RegistrationApprovalPopup } from './components/agents/RegistrationApprovalPopup';
import { NotificationsBell } from './components/notifications/NotificationsBell';
import { Separator } from './components/ui/separator';
import { apiAuthHeaders, apiUrl, backendClient, getSystemCapabilities, type SystemCapabilities } from './lib/backendClient';
import { inviteUrl } from './hooks/useWorkspaceUsers';
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from './components/ui/avatar';
import { isImageAvatar, isPetSpritesheetAvatar, renderablePetAssetUrl } from './lib/openpets';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from './components/ui/alert-dialog';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './components/ui/context-menu';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from './components/ui/dropdown-menu';
import { Switch } from './components/ui/switch';
import { ScrollArea } from './components/ui/scroll-area';
import { Spinner } from './components/ui/spinner';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';
import { AppUpdateManager } from './components/AppUpdateManager';
import { cn } from './lib/utils';
import { applyUiAppearanceSettings, getSetting, getSettings } from './lib/settings';
import { applyThemePreset } from './showcase/themePresets';
import { applyNeoTheme } from './showcase/neoThemes';
import { WORKSPACE_CHROME_GAP, WORKSPACE_DOCK_BOTTOM_OFFSET, WORKSPACE_DOCK_HEIGHT } from './lib/workspaceLayout';
import { useAuth } from './hooks/useAuth';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useDocuments } from './hooks/useDocuments';
import { useChat } from './hooks/useChat';
import { useWorkspaceBootstrap } from './hooks/useWorkspaceBootstrap';
import { useSubThreads } from './hooks/useSubThreads';
import { useSessionMessages } from './hooks/useSessionMessages';
import { useMemory } from './hooks/useMemory';
import { useFiles } from './hooks/useFiles';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useTheme } from './hooks/useTheme';
import { WindowManagerProvider, useWindowManager } from './providers/WindowManagerProvider';
import { useItemPresence } from './hooks/useItemPresence';
import { useMultiplayerCursors } from './hooks/useMultiplayerCursors';
import { useSharing } from './hooks/useSharing';
import { useCanvasObjects } from './hooks/useCanvasObjects';
import { useCanvasLayers } from './hooks/useCanvasLayers';
import { useTasks } from './hooks/useTasks';
import { useActivity } from './hooks/useActivity';
import { useAgents, type CreateAgentInput } from './hooks/useAgents';
import { useAgentWebhooks } from './hooks/useAgentWebhooks';
import { useAgentConnections } from './hooks/useAgentConnections';
import { useDockAttention } from './hooks/useDockAttention';
import { useWorkspacePresence, windowLabel, type WorkspacePresenceUser } from './hooks/useWorkspacePresence';
import { useAgentStatusFeed } from './hooks/useAgentStatusFeed';
import { useWorkspaceKnowledge, type WorkspaceContextCounts } from './hooks/useWorkspaceKnowledge';
import type { CanvasAppDefinition } from './lib/canvasApps';
import { makeAppletState, makeDocAppletState } from './lib/canvasApps';
import { WORKSPACE_BACKGROUND_IMAGES } from './lib/backgrounds';
import type { CanvasLayer } from './hooks/useCanvasLayers';
import { CursorOverlay } from './components/cursors/CursorOverlay';
import type { ChannelParticipant, Document, ChatSession, MemoryFact, CanvasGroup, CanvasObject, FloatingWindow, Task, ActivityEvent, WorkspaceAgent, AgentWebhook, PresenceVisibilityMode, Workspace, Message as ChatMessage, AgentConnection, UploadedFile } from './types';
import type { WorkspaceMember } from './hooks/useSharing';
import type { CreateTaskInput } from './hooks/useTasks';

// BUNDLE-03: lazy-load the less-frequently-opened window surfaces so their code
// (and heavy deps) splits out of the main chunk and loads only when a window of
// that type is first opened. ChatWindowContent stays eager — it is the hot path.
// Named exports are adapted to the default-export shape React.lazy expects.
const ActivityWindowContent = lazy(() => import('./components/windows/ActivityWindowContent').then(m => ({ default: m.ActivityWindowContent })));
const AgentsWindowContent = lazy(() => import('./components/windows/AgentsWindowContent').then(m => ({ default: m.AgentsWindowContent })));
const UsersWindow = lazy(() => import('./components/windows/UsersWindow').then(m => ({ default: m.UsersWindow })));
const SchedulesWindow = lazy(() => import('./components/windows/SchedulesWindow').then(m => ({ default: m.SchedulesWindow })));

const TOUR_KEY = 'agensis_tour_complete';
const SIDEBAR_KEY = 'agensis_sidebar_collapsed';
const PRESENCE_VISIBILITY_KEY = 'agensis_presence_visibility';
const PRESENCE_FAVORITES_KEY = 'agensis_presence_favorites';
const CANVAS_BACKGROUNDS = WORKSPACE_BACKGROUND_IMAGES;

// Native SDK desktop shell: app.zon uses titlebar = "hidden_inset_tall"
// (unified toolbar ~52pt). Traffic lights overlay content; pad the top so the
// sidebar header sits under them. Web builds get zero inset.
const IS_DESKTOP_SHELL =
  typeof window !== 'undefined' &&
  Boolean(
    (window as unknown as { zero?: unknown; electronAPI?: unknown }).zero ||
    (window as unknown as { electronAPI?: unknown }).electronAPI,
  );
// Match hidden_inset_tall band (~52pt). Short hidden_inset was ~28pt.
const DESKTOP_TITLEBAR_INSET = IS_DESKTOP_SHELL ? 52 : 0;

function windowDockIcon(type: FloatingWindow['type']) {
  if (type === 'chat') return <MessageSquare className="size-4" />;
  if (type === 'memory') return <Brain className="size-4" />;
  if (type === 'skills') return <Sparkles className="size-4" />;
  if (type === 'tasks') return <CheckCircle2 className="size-4" />;
  if (type === 'activity') return <Activity className="size-4" />;
  if (type === 'agents') return <Bot className="size-4" />;
  return <FileText className="size-4" />;
}

function participantAvatarValue(participant: ChannelParticipant | null): string | null {
  if (!participant) return null;
  const record = participant as unknown as Record<string, unknown>;
  const value = record.avatar ?? record.avatar_url ?? record.image ?? record.icon;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Avatar to show on a chat window's dock button: the direct agent's avatar from
// the workspace roster (the same source the chat window renders), falling back
// to any avatar carried on the participant. Returns null for multi-agent
// channels / non-agent chats, which keep the generic chat icon.
function dockChatAvatar(session: ChatSession | undefined, agents: WorkspaceAgent[]): string | null {
  const participant = directAgentParticipantForSession(session);
  if (!participant) {
    // Old DM sessions (folder='Direct messages') may lack participants. Fall back
    // to matching by session title so their dock buttons still show agent avatars.
    if (session?.folder === 'Direct messages') {
      const key = normalizeAgentLookupKey(session.title);
      const agent = key
        ? agents.find(item => [item.id, item.handle, item.name].some(v => normalizeAgentLookupKey(v) === key))
        : undefined;
      return (agent?.avatar && agent.avatar.trim()) || null;
    }
    return null;
  }
  const key = normalizeAgentLookupKey(participant.agent_id || participant.handle || participant.name);
  const agent = key
    ? agents.find(item => [item.id, item.handle, item.name].some(v => normalizeAgentLookupKey(v) === key))
    : undefined;
  return (agent?.avatar && agent.avatar.trim()) || participantAvatarValue(participant);
}

// Renders a chat window's agent avatar inside its size-8 dock button, mirroring
// the sidebar's spritesheet/image/fallback branches so animated pets animate and
// missing images fall back to the chat glyph.
function DockChatAvatar({ avatar }: { avatar: string }) {
  if (isPetSpritesheetAvatar(avatar)) {
    return (
      <span className="animated-pet-avatar-shell size-6 rounded-md">
        <span className="animated-pet-avatar" style={{ backgroundImage: `url(${renderablePetAssetUrl(avatar)})` }} />
      </span>
    );
  }
  const src = isImageAvatar(avatar) ? renderablePetAssetUrl(avatar) : undefined;
  const text = avatar?.trim();
  return (
    <Avatar size="sm" className="size-6 rounded-md bg-muted">
      {src && <AvatarImage src={src} alt="" className="rounded-md" />}
      <AvatarFallback className="rounded-md text-sm leading-none">
        {src ? <MessageSquare className="size-3.5" /> : text ? text : <MessageSquare className="size-3.5" />}
      </AvatarFallback>
    </Avatar>
  );
}

type DockEntry =
  | { kind: 'window'; win: FloatingWindow }
  | { kind: 'group'; groupId: string; members: FloatingWindow[] };

function renderDockButton(
  win: FloatingWindow,
  focusedDockWindow: FloatingWindow | null,
  handlers: { onOpen: () => void; onHide: () => void; onFocus: () => void; onClose?: () => void },
  bounce = false,
  avatar: string | null = null,
) {
  const active = focusedDockWindow?.id === win.id;
  const dockActionLabel = win.minimized ? 'Open' : active ? 'Hide' : 'Focus';
  return (
    <ContextMenu key={win.id}>
      <ContextMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => {
            if (win.minimized) {
              handlers.onOpen();
              return;
            }
            if (active) {
              handlers.onHide();
              return;
            }
            handlers.onFocus();
          }}
          className={cn(
            'relative size-8 rounded-xl border border-transparent text-foreground/90 transition-colors hover:bg-background/70 hover:text-foreground',
            active && 'border-border/70 bg-background/80 text-foreground shadow-sm',
            win.minimized && 'text-muted-foreground',
            bounce && 'dock-bounce',
          )}
          title={`${dockActionLabel} ${windowLabel(win)}`}
          aria-label={`${dockActionLabel} ${windowLabel(win)}`}
        >
          {win.type === 'chat' && avatar ? <DockChatAvatar avatar={avatar} /> : windowDockIcon(win.type)}
          <span
            aria-hidden
            className={cn(
              'absolute bottom-0.5 left-1/2 h-1 w-2 -translate-x-1/2 rounded-[2px]',
              active ? 'bg-foreground' : win.minimized ? 'bg-muted-foreground/55' : 'bg-primary/65',
            )}
          />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuLabel className="truncate">{windowLabel(win)}</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => (win.minimized ? handlers.onOpen() : handlers.onFocus())}>
          <ArrowRight data-icon="inline-start" />
          Switch to
        </ContextMenuItem>
        {win.minimized ? (
          <ContextMenuItem onSelect={handlers.onOpen}>
            <Maximize2 data-icon="inline-start" />
            Restore
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={handlers.onHide}>
            <Minimize2 data-icon="inline-start" />
            Minimise
          </ContextMenuItem>
        )}
        {handlers.onClose && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={handlers.onClose}>
              <Trash2 data-icon="inline-start" />
              Close
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

const ADJACENT_EDGE_TOLERANCE = 2;

// Hoisted rather than written inline (`() => {}`, `[]`), which would allocate a
// fresh reference every render and defeat ChatWindowContent's React.memo.
const NOOP_SEND_MESSAGE = () => { };
const EMPTY_MESSAGES: never[] = [];

function computeAdjacentEdges(win: FloatingWindow, allWindows: FloatingWindow[]): Set<'left' | 'right' | 'top' | 'bottom'> {
  const edges = new Set<'left' | 'right' | 'top' | 'bottom'>();
  if (!win.groupId) return edges;
  const siblings = allWindows.filter(w => w.id !== win.id && w.groupId === win.groupId && !w.minimized);
  for (const sib of siblings) {
    if (Math.abs((win.x + win.width) - sib.x) <= ADJACENT_EDGE_TOLERANCE) edges.add('right');
    if (Math.abs((sib.x + sib.width) - win.x) <= ADJACENT_EDGE_TOLERANCE) edges.add('left');
    if (Math.abs((win.y + win.height) - sib.y) <= ADJACENT_EDGE_TOLERANCE) edges.add('bottom');
    if (Math.abs((sib.y + sib.height) - win.y) <= ADJACENT_EDGE_TOLERANCE) edges.add('top');
  }
  return edges;
}

// Windows tiled together (drag-to-split) share a groupId — cluster them into
// one dock entry, at the position of the group's first member, so they're
// drawn together with a surrounding frame instead of as separate icons.
function groupDockWindows(dockWindows: FloatingWindow[]): DockEntry[] {
  const entries: DockEntry[] = [];
  const groupIndex = new Map<string, number>();
  for (const win of dockWindows) {
    if (!win.groupId) {
      entries.push({ kind: 'window', win });
      continue;
    }
    const existingIndex = groupIndex.get(win.groupId);
    if (existingIndex !== undefined) {
      const entry = entries[existingIndex];
      if (entry.kind === 'group') entry.members.push(win);
      continue;
    }
    groupIndex.set(win.groupId, entries.length);
    entries.push({ kind: 'group', groupId: win.groupId, members: [win] });
  }
  return entries;
}

type PresenceVisibilityMap = Record<string, PresenceVisibilityMode>;
function normalizeAgentLookupKey(value?: string | null) {
  return (value || '').trim().replace(/^@+/, '').toLowerCase();
}

function directAgentParticipantForSession(session?: ChatSession | null): ChannelParticipant | null {
  const participants = Array.isArray(session?.participants) ? session.participants : [];
  const agentParticipants = participants.filter(participant =>
    participant?.kind === 'agent' && (participant.agent_id || participant.handle || participant.name)
  );
  if (agentParticipants.length === 0) return null;
  return agentParticipants.find(participant => participant.direct) || (agentParticipants.length === 1 ? agentParticipants[0] : null);
}

function isDirectChatSession(session?: ChatSession | null) {
  return Boolean(directAgentParticipantForSession(session)) || session?.folder === 'Direct messages';
}

function isDirectSessionForAgent(session: ChatSession, agentId?: string | null, handle?: string | null) {
  if (!isDirectChatSession(session)) return false;
  const participant = directAgentParticipantForSession(session);
  const targetAgentId = normalizeAgentLookupKey(agentId);
  const targetHandle = normalizeAgentLookupKey(handle);
  const participantAgentId = normalizeAgentLookupKey(participant?.agent_id);
  const participantHandle = normalizeAgentLookupKey(participant?.handle);
  const participantName = normalizeAgentLookupKey(participant?.name);
  const title = normalizeAgentLookupKey(session.title);

  return Boolean(
    (targetAgentId && participantAgentId === targetAgentId)
    || (targetHandle && (participantHandle === targetHandle || participantName === targetHandle || title === targetHandle))
  );
}

// True when a session's direct agent has a live daemon connection reporting
// 'busy'. Matches the connection by agent_id first, then by normalized
// handle/name/title — the same resolution the chat participant status uses.
function isDirectAgentBusy(session: ChatSession, agentConnections: AgentConnection[]): boolean {
  const participant = directAgentParticipantForSession(session);
  if (!participant) return false;
  const agentId = normalizeAgentLookupKey(participant.agent_id);
  const handle = normalizeAgentLookupKey(participant.handle);
  const name = normalizeAgentLookupKey(participant.name);
  const title = normalizeAgentLookupKey(session.title);
  return agentConnections.some(conn => {
    if (conn.status !== 'busy') return false;
    if (agentId && normalizeAgentLookupKey(conn.agent_id) === agentId) return true;
    const connHandle = normalizeAgentLookupKey(conn.handle);
    const connName = normalizeAgentLookupKey(conn.name);
    return Boolean(
      (handle && (connHandle === handle || connName === handle))
      || (name && (connHandle === name || connName === name))
      || (title && (connHandle === title || connName === title)),
    );
  });
}

function loadPresenceVisibility(): PresenceVisibilityMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESENCE_VISIBILITY_KEY) || '{}') as PresenceVisibilityMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadPresenceFavorites(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESENCE_FAVORITES_KEY) || '[]') as string[];
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const CONTEXT_COUNT_ITEMS: Array<{
  key: keyof WorkspaceContextCounts;
  label: string;
  icon: React.ReactNode;
}> = [
    { key: 'docs', label: 'Documents', icon: <FileText /> },
    { key: 'facts', label: 'Memory', icon: <Brain /> },
    { key: 'tasks', label: 'Tasks', icon: <CheckCircle2 /> },
    { key: 'agents', label: 'AI agents', icon: <Bot /> },
    { key: 'skills', label: 'Skills', icon: <Sparkles /> },
    { key: 'commands', label: 'Commands', icon: <Command /> },
    { key: 'tools', label: 'Tools', icon: <Wrench /> },
    { key: 'webhooks', label: 'Webhooks', icon: <Activity /> },
  ];

function KnowledgeContextControl({
  counts,
  enabled,
  title,
  onToggle,
}: {
  counts: WorkspaceContextCounts;
  enabled: boolean;
  title: string;
  onToggle: () => void;
}) {
  const [enabledKeys, setEnabledKeys] = useState<Set<keyof WorkspaceContextCounts>>(
    () => new Set(CONTEXT_COUNT_ITEMS.map(item => item.key)),
  );
  const includedItems = CONTEXT_COUNT_ITEMS.filter(item => enabledKeys.has(item.key));
  const activeTotal = enabled
    ? includedItems.reduce((total, item) => total + counts[item.key], 0)
    : 0;
  const activeSources = enabled
    ? includedItems.filter(item => counts[item.key] > 0).length
    : 0;
  const summary = enabled
    ? `${activeTotal} item${activeTotal === 1 ? '' : 's'} · ${activeSources} source${activeSources === 1 ? '' : 's'}`
    : 'Context disabled';

  const setItemEnabled = (key: keyof WorkspaceContextCounts, checked: boolean) => {
    setEnabledKeys(prev => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  // Rendered as a SUBMENU of the chat window's channel overflow menu, not as a
  // standalone header button — a nested <DropdownMenu> would dismiss the outer
  // one, whereas Sub/SubTrigger share the parent menu's context.
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="gap-2 px-2 py-1.5"
        title={enabled ? `Workspace context includes ${title}` : 'Workspace context is off'}
      >
        <CheckCircle2 className={enabled ? 'text-pink-500' : 'text-muted-foreground'} />
        <span>Knowledge</span>
        <Badge variant="secondary" className="ml-auto h-5 rounded-md border-0 px-1.5 text-[10px] shadow-none">
          {activeTotal}
        </Badge>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72 p-0">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold leading-none">Knowledge</span>
            <span className="text-[11px] leading-none text-muted-foreground">{summary}</span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={checked => {
              if (Boolean(checked) !== enabled) onToggle();
            }}
            aria-label="Use workspace knowledge"
          />
        </div>
        <DropdownMenuSeparator className="my-0" />
        <DropdownMenuLabel className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Sources
        </DropdownMenuLabel>
        <div className="px-1 pb-1">
          {CONTEXT_COUNT_ITEMS.map(item => {
            const on = enabledKeys.has(item.key);
            const count = counts[item.key];
            const contributing = enabled && on && count > 0;
            return (
              <DropdownMenuItem
                key={item.key}
                disabled={!enabled}
                aria-pressed={on}
                onSelect={event => {
                  event.preventDefault();
                  setItemEnabled(item.key, !on);
                }}
                className={cn(
                  'gap-2.5 rounded-md px-2 py-1.5 transition-opacity',
                  enabled && !on && 'opacity-45',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors',
                    contributing ? 'bg-pink-500/10 text-pink-500' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span
                  className={cn(
                    'ml-auto inline-flex min-w-[1.75rem] justify-center rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors',
                    contributing
                      ? 'bg-pink-500/10 text-pink-600 dark:text-pink-400'
                      : 'text-muted-foreground/60',
                  )}
                >
                  {count}
                </span>
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function buildCanvasAppletCreationBrief(workspaceName: string) {
  return `Create a new agensis Canvas Applet for the "${workspaceName}" workspace.

Use this skill:
agensis Canvas Applet Builder
- Build production-quality self-contained HTML applets for agensis canvas.
- Treat the applet as a durable, editable artifact, not a throwaway snippet.
- Keep the implementation isolated, resilient, accessible, responsive, and easy to revise in later chat turns.
- Use the agensis iframe SDK contract below for state, tasks, agents, theme, and crash reporting.

The applet must be a self-contained single-file HTML artifact:
- One complete HTML document in a single fenced \`\`\`html block.
- Inline CSS and inline JavaScript only.
- No build step, no framework runtime, no external dependencies unless I explicitly ask.
- Responsive layout that works inside a resizable canvas iframe.
- Easy to update later: keep constants, state helpers, render functions, and event handlers clearly separated.
- Accessible controls, stable dimensions, no flashing layout shifts, and no uncaught errors.

Use this agensis iframe SDK contract:
- Listen for parent messages with type "agensis:init". The payload can include { state, tasks, agents, theme }.
- Post { source: "agensis-applet", type: "agensis:ready" } after the app is ready.
- Persist applet state by posting { source: "agensis-applet", type: "agensis:setState", payload: { state } }.
- Create tasks by posting { source: "agensis-applet", type: "agensis:createTask", payload: { title, priority, source_type } }.
- Update tasks by posting { source: "agensis-applet", type: "agensis:updateTask", payload: { id, updates } }.
- Report runtime failures by posting { source: "agensis-applet", type: "agensis:crash", payload: { message } }.
- Use payload.theme tokens when present so the applet matches the current agensis theme.

First ask one concise question if the applet idea is missing. If I provide a specific applet idea, build the first version directly.`;
}

export default function App() {
  return (
    <WindowManagerProvider>
      <AppContent />
    </WindowManagerProvider>
  );
}

function AppContent() {
  const { user, loading: authLoading, signIn, signUp, signOut, signInWithOAuth } = useAuth();
  // The update surface (deploy toast + "what's new" dialog + version check +
  // cache-bust reload) is mounted as <AppUpdateManager /> in the tree below.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>('');
  const [showTour, setShowTour] = useState(false);
  const isMobile = useIsMobile();
  // Phone: the sidebar is an off-canvas drawer (opened by the workspace hamburger)
  // instead of an inline rail, so the workspace canvas gets the full screen width.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    // No saved preference yet → collapse by default on phone-width viewports,
    // where a persistent sidebar would crowd out the workspace entirely. An
    // explicit user toggle (persisted) always wins on later loads.
    if (stored === null) return window.matchMedia('(max-width: 767px)').matches;
    return stored === '1';
  });
  const [presenceVisibility, setPresenceVisibility] = useState<PresenceVisibilityMap>(() => loadPresenceVisibility());
  const [presenceFavorites, setPresenceFavorites] = useState<string[]>(() => loadPresenceFavorites());
  const [focusedPresenceUserId, setFocusedPresenceUserId] = useState<string | null>(null);
  const [focusedAgentKey, setFocusedAgentKey] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareDialogTitle, setShareDialogTitle] = useState('');
  const [createWorkspaceDialogOpen, setCreateWorkspaceDialogOpen] = useState(false);
  const [drawingActive, setDrawingActive] = useState(false);
  const [showCanvasGrid, setShowCanvasGrid] = useState(false);
  const [canvasGridBackground] = useState(() => CANVAS_BACKGROUNDS[Math.floor(Math.random() * CANVAS_BACKGROUNDS.length)]);
  const activeSceneRef = useRef<HTMLDivElement>(null);
  const setupCallbackInFlightRef = useRef(false);

  const { workspaces, loading: wsLoading, createWorkspace } = useWorkspaces(user?.id);
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId) || workspaces[0] || null;

  useEffect(() => {
    if (!wsLoading && workspaces.length > 0 && !workspaces.find(w => w.id === activeWorkspaceId)) {
      setActiveWorkspaceId(workspaces[0].id);
    }
  }, [wsLoading, workspaces, activeWorkspaceId]);

  const { data: workspaceBootstrap } = useWorkspaceBootstrap(activeWorkspaceId || null);

  const {
    documents, recents,
    createDocument, saveDocument, autoSave, deleteDocument, toggleFavorite
  } = useDocuments(activeWorkspaceId, (workspaceBootstrap?.documents as import('./types').Document[] | undefined) || null);

  const {
    sessions, activeSession, setActiveSession, messages, streaming,
    hasMoreMessages, loadingEarlier, loadEarlierMessages,
    topLevelMessages, threadMessages, threadReplyCounts, activeThreadId,
    openThread, closeThread,
    createSession, splitSession, updateSession, archiveSession, sendMessage, deleteSession, closeAndClearSession, mergeSession,
  } = useChat(
    activeWorkspaceId,
    user?.email?.split('@')[0] || undefined,
    (workspaceBootstrap?.sessions as import('./types').ChatSession[] | undefined) || null,
  );

  const {
    subThreadsByMessage,
    activeSubThread,
    subThreadMessages,
    subThreadStreaming,
    createSubThread,
    openSubThread,
    closeSubThread,
    sendSubThreadMessage,
  } = useSubThreads(activeWorkspaceId);

  const { facts, categories, addFact, updateFact, deleteFact } = useMemory(activeWorkspaceId);
  const { files: uploadedFiles, uploadFiles } = useFiles(
    activeWorkspaceId,
    (workspaceBootstrap?.files as import('./types').UploadedFile[] | undefined) || null,
  );
  const { online, syncing, pendingCount, syncError, flushQueue, clearPendingQueue } = useNetworkStatus();
  const { mode: themeMode, setTheme } = useTheme();

  useEffect(() => {
    const settings = getSettings();
    applyUiAppearanceSettings(settings);
    applyThemePreset(settings.ui_theme_preset);
    // Seed the persisted neo theme so it's ready when the neo family activates.
    applyNeoTheme(settings.ui_neo_theme);
  }, []);
  const { layers, activeLayer, activeLayerId, createLayer, activateLayer, deleteLayer, updateLayer, baseLayerId } = useCanvasLayers(activeWorkspaceId || null);
  const {
    windows,
    openWindow,
    openSplitWindow,
    closeWindow,
    closeAllWindows,
    focusWindow,
    updateWindow,
    minimizeWindow,
    focusWindowGroup,
    minimizeWindowGroup,
    ungroupTiledWindows,
    viewMode,
  } = useWindowManager();
  const canvasRef = useRef<HTMLElement>(null);

  // The viewport clips floating panels to the 8px chrome gap by default. Only a
  // full-bleed candidate — a maximized window, or a tiled group that can fill the
  // panel — needs the viewport un-clipped so its shell can paint over the gap out
  // to the true panel edge. The per-edge bleed itself is still gated in the shell
  // (FloatingWindowShell), so a tiled split that DOESN'T fill the panel stays put.
  // viewMode is workspace-global, but a layer switch can land on a layer with no
  // visible window. Only treat the workspace as "full" for dock/viewport purposes
  // when the ACTIVE layer actually has a non-minimized window to show full — else
  // the dock would hide with nothing rendered. (The scene mirrors this per layer.)
  const activeLayerHasVisibleWindow = windows.some(
    win => !win.minimized && (win.canvasId || 'base') === activeLayerId,
  );
  const isFullExpandMode = viewMode === 'full' && activeLayerHasVisibleWindow;
  const viewportUnclipped = !isMobile
    && (isFullExpandMode
      || windows.some(win => !win.minimized && (win.maximized || Boolean(win.groupId))));

  // Windows are in-memory and keyed by canvas layer id, which is 'base' for
  // every workspace's default layer — so without this, the previous
  // workspace's open windows leak onto a newly created/selected workspace's
  // canvas, making it look identical. Clear them only on a genuine switch
  // (skip the initial ''→firstId hydration, which has no windows to clear).
  const prevWorkspaceIdRef = useRef<string>('');
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const prev = prevWorkspaceIdRef.current;
    prevWorkspaceIdRef.current = activeWorkspaceId;
    if (prev && prev !== activeWorkspaceId) {
      closeAllWindows();
    }
  }, [activeWorkspaceId, closeAllWindows]);
  const { cursors } = useMultiplayerCursors(
    activeWorkspaceId,
    canvasRef,
    user?.id,
    user?.email || undefined
  );
  const itemPresence = useItemPresence(
    activeWorkspaceId || null,
    windows,
    activeLayerId,
    user?.id,
    user?.email || undefined,
    'all',
  );
  const {
    agents,
    createAgent,
    updateAgent,
    deleteAgent,
    disconnectAgent,
  } = useAgents(
    activeWorkspaceId || null,
    user?.id,
    (workspaceBootstrap?.agents as import('./types').WorkspaceAgent[] | undefined) || null,
  );
  const {
    connections: agentConnections,
  } = useAgentConnections(
    activeWorkspaceId || null,
    (workspaceBootstrap?.connections as import('./types').AgentConnection[] | undefined) || null,
  );
  const workspacePresenceUsers = useWorkspacePresence({
    user,
    cursors,
    remotePresenceUsers: itemPresence.remotePresenceUsers,
    documents,
    sessions,
    agentConnections,
    agents,
  });
  const agentStatusFeed = useAgentStatusFeed(workspacePresenceUsers, agents, activeWorkspaceId || null);
  const getPresenceMode = useCallback((id?: string | null): PresenceVisibilityMode => {
    if (!id) return 'visible';
    const baseMode = id === user?.id ? 'visible' : presenceVisibility[id] || 'visible';
    if (focusedPresenceUserId && id !== focusedPresenceUserId) {
      return baseMode === 'hidden' ? 'hidden' : 'dimmed';
    }
    return baseMode;
  }, [focusedPresenceUserId, presenceVisibility, user?.id]);
  const setPresenceMode = useCallback((id: string, mode: PresenceVisibilityMode) => {
    setPresenceVisibility(prev => {
      const next = { ...prev };
      if (mode === 'visible') delete next[id];
      else next[id] = mode;
      localStorage.setItem(PRESENCE_VISIBILITY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const togglePresenceFavorite = useCallback((id: string) => {
    setPresenceFavorites(prev => {
      const next = prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id];
      localStorage.setItem(PRESENCE_FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const {
    members,
    autoShare,
    toggleAutoShare,
    inviteByEmail,
    removeMember,
    updateMemberRole,
  } = useSharing(activeWorkspaceId || null, user?.id);
  const {
    objects: canvasObjects,
    groups: canvasGroups,
    addObject: addCanvasObject,
    updateObject: updateCanvasObject,
    deleteObject: deleteCanvasObject,
    deleteObjectsInLayer,
    bringToFront: bringCanvasObjectToFront,
    createGroup: createCanvasGroup,
    deleteGroup: deleteCanvasGroup,
  } = useCanvasObjects(activeWorkspaceId || null, user?.id, activeLayerId);

  const {
    tasks,
    openTasks,
    createTask,
    updateTask,
    toggleTaskStatus,
    deleteTask,
  } = useTasks(
    activeWorkspaceId || null,
    user?.id,
    (workspaceBootstrap?.tasks as import('./types').Task[] | undefined) || null,
  );

  const { events: activityEvents, loading: activityLoading, logEvent } = useActivity(
    activeWorkspaceId || null,
    user?.id,
  );

  const {
    webhooks: agentWebhooks,
    createWebhook: createAgentWebhook,
    updateWebhook: updateAgentWebhook,
  } = useAgentWebhooks(activeWorkspaceId || null);

  const [selectedAgent, setSelectedAgent] = useState<WorkspaceAgent | null>(null);
  const [systemCapabilities, setSystemCapabilities] = useState<SystemCapabilities | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLayerId, setSettingsLayerId] = useState<string | null>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTabId>('general');
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    actionLabel: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const capabilityWorkspacePath = activeLayer?.local_path || activeLayer?.git_root || activeWorkspace?.local_path || activeWorkspace?.git_root || '';
  useEffect(() => {
    let cancelled = false;
    getSystemCapabilities(capabilityWorkspacePath)
      .then(capabilities => {
        if (!cancelled) setSystemCapabilities(capabilities);
      })
      .catch(() => {
        if (!cancelled) setSystemCapabilities(null);
      });
    return () => {
      cancelled = true;
    };
  }, [capabilityWorkspacePath]);

  const { contextCounts, contextCountsTitle, buildWorkspaceContext } = useWorkspaceKnowledge({
    workspaceName: activeWorkspace?.name || 'Workspace',
    documents,
    facts,
    tasks,
    canvasObjects,
    agents,
    agentWebhooks,
    capabilities: systemCapabilities,
  });

  const focusedRemotePresence = itemPresence.remotePresenceUsers.find(remote => remote.userId === focusedPresenceUserId);
  const viewedLayerId = focusedRemotePresence?.activeLayerId || activeLayerId;
  const viewedLayer = layers.find(layer => layer.id === viewedLayerId) || activeLayer;
  const workspaceBackdropImage = viewedLayer.background_image || activeWorkspace?.background_image || canvasGridBackground;
  const workspaceBackdropOpacity = Math.min(1, Math.max(0, viewedLayer.background_opacity ?? activeWorkspace?.background_opacity ?? 0.42));
  const workspaceBackdropOverlayOpacity = Math.max(0, 1 - workspaceBackdropOpacity);
  const visibleCanvasObjects = useMemo(
    () => canvasObjects.filter(obj => (obj.layer_id || 'base') === viewedLayerId),
    [canvasObjects, viewedLayerId],
  );
  const visibleCanvasGroups = useMemo(() => {
    const visibleGroupIds = new Set(visibleCanvasObjects.map(obj => obj.group_id).filter(Boolean));
    return canvasGroups.filter(group => visibleGroupIds.has(group.id));
  }, [visibleCanvasObjects, canvasGroups]);
  const activeWindows = useMemo(() => {
    const exactWorkspaceWindows = focusedRemotePresence
      ? focusedRemotePresence.windows.map(win => ({
        ...win,
        id: `remote:${focusedRemotePresence.userId}:${win.id}`,
        ownerUserId: focusedRemotePresence.userId,
      }))
      : windows;
    return exactWorkspaceWindows.filter(win => (win.canvasId || 'base') === viewedLayerId);
  }, [focusedRemotePresence, windows, viewedLayerId]);
  const { dockWindows, focusedDockWindow, dockEntries } = useMemo(() => {
    const dockWindows = windows.filter(win => (win.canvasId || 'base') === activeLayerId);
    const focusedDockWindow = dockWindows
      .filter(win => !win.minimized)
      .reduce<FloatingWindow | null>((topWindow, win) => (
        !topWindow || win.zIndex > topWindow.zIndex ? win : topWindow
      ), null);
    const dockEntries = groupDockWindows(dockWindows);
    return { dockWindows, focusedDockWindow, dockEntries };
  }, [windows, activeLayerId]);
  // macOS-style dock bounce: a chat window's icon bounces once when its agent
  // starts working (idle → busy). Derived purely from the realtime connection
  // status already in scope — no extra subscriptions.
  const dockBusyById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const win of dockWindows) {
      if (win.type !== 'chat' || !win.sessionId) continue;
      const session = sessions.find(item => item.id === win.sessionId);
      if (!session) continue;
      map.set(win.id, isDirectAgentBusy(session, agentConnections));
    }
    return map;
  }, [dockWindows, sessions, agentConnections]);
  const bouncingDockIds = useDockAttention(dockBusyById);
  // Chat dock buttons show their direct agent's avatar in place of the generic
  // chat glyph. Resolved from the same session→participant→agent path as the
  // bounce map, so avatar-bearing buttons are exactly the direct-chat set.
  const dockAvatarById = useMemo(() => {
    const map = new Map<string, string>();
    for (const win of dockWindows) {
      if (win.type !== 'chat' || !win.sessionId) continue;
      const session = sessions.find(item => item.id === win.sessionId);
      const avatar = dockChatAvatar(session, agents);
      if (avatar) map.set(win.id, avatar);
    }
    return map;
  }, [dockWindows, sessions, agents]);
  const canEditCanvasObject = useCallback((obj: CanvasObject) => !obj.user_id || obj.user_id === user?.id, [user?.id]);
  const settingsLayer = layers.find(layer => layer.id === (settingsLayerId || activeLayerId)) || activeLayer;
  const settingsWorkspace = useMemo<Workspace | null>(() => {
    if (!activeWorkspace || !settingsLayer) return activeWorkspace;
    return {
      ...activeWorkspace,
      id: settingsLayer.id,
      name: settingsLayer.name,
      description: settingsLayer.description ?? activeWorkspace.description ?? '',
      icon: settingsLayer.icon ?? activeWorkspace.icon ?? '',
      local_path: settingsLayer.local_path ?? '',
      project_kind: settingsLayer.project_kind ?? '',
      git_root: settingsLayer.git_root ?? '',
      git_remote: settingsLayer.git_remote ?? '',
      background_opacity: settingsLayer.background_opacity ?? activeWorkspace.background_opacity ?? 0.42,
      background_image: settingsLayer.background_image ?? activeWorkspace.background_image ?? '',
    };
  }, [activeWorkspace, settingsLayer]);
  const openLayerSettings = useCallback((layerId = activeLayerId, tab: SettingsTabId = 'general') => {
    setSettingsLayerId(layerId);
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, [activeLayerId]);
  const handleUpdateSettingsWorkspace = useCallback((id: string, updates: Partial<Workspace>) => {
    const layerUpdates: Partial<CanvasLayer> = {};
    if (updates.name !== undefined) layerUpdates.name = updates.name;
    if (updates.description !== undefined) layerUpdates.description = updates.description;
    if (updates.icon !== undefined) layerUpdates.icon = updates.icon;
    if (updates.local_path !== undefined) layerUpdates.local_path = updates.local_path;
    if (updates.project_kind !== undefined) layerUpdates.project_kind = updates.project_kind;
    if (updates.git_root !== undefined) layerUpdates.git_root = updates.git_root;
    if (updates.git_remote !== undefined) layerUpdates.git_remote = updates.git_remote;
    if (updates.background_opacity !== undefined) layerUpdates.background_opacity = updates.background_opacity;
    if (updates.background_image !== undefined) layerUpdates.background_image = updates.background_image;
    updateLayer(id, layerUpdates);
  }, [updateLayer]);

  useEffect(() => {
    const done = localStorage.getItem(TOUR_KEY);
    if (!done) {
      const timer = setTimeout(() => setShowTour(true), 1200);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleTourComplete = () => {
    localStorage.setItem(TOUR_KEY, '1');
    setShowTour(false);
  };

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  // The topmost (focused) window drives the phone's single-window view. When it
  // changes — a sidebar tap opened or focused a window — dismiss the drawer so
  // the freshly-opened window is revealed. Same value → useState bails, so this
  // is a no-op on unrelated re-renders.
  const topWindowId = useMemo(() => pickActiveWindowId(windows), [windows]);
  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [topWindowId]);

  const handleNewChat = useCallback(async () => {
    const session = await createSession('auto', { canvas_id: activeLayerId });
    if (session) {
      openWindow('chat', { title: session.title || 'Untitled', sessionId: session.id, canvasId: activeLayerId, ownerUserId: user?.id });
      logEvent({
        event_type: 'chat_created',
        entity_type: 'chat',
        entity_id: session.id,
        title: `New chat: ${session.title || 'Untitled'}`,
      });
    }
  }, [createSession, openWindow, activeLayerId, user?.id, logEvent]);

  const handleNewDocument = useCallback(async () => {
    const doc = await createDocument();
    if (doc) {
      openWindow('document', { title: doc.title || 'Untitled', documentId: doc.id, canvasId: activeLayerId, ownerUserId: user?.id });
      logEvent({
        event_type: 'document_created',
        entity_type: 'document',
        entity_id: doc.id,
        title: `New document: ${doc.title || 'Untitled'}`,
      });
    }
  }, [createDocument, openWindow, activeLayerId, user?.id, logEvent]);

  const handleOpenMemory = useCallback(() => {
    const existing = windows.find(w => w.type === 'memory');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('memory', { title: 'Memory', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenSkills = useCallback(() => {
    const existing = windows.find(w => w.type === 'skills');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('skills', { title: 'Skills', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenTasks = useCallback((taskId?: string) => {
    const existing = windows.find(w => w.type === 'tasks');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      if (taskId) updateWindow(existing.id, { focusTaskId: taskId });
      return;
    }
    openWindow('tasks', { title: 'Tasks', canvasId: activeLayerId, ownerUserId: user?.id, focusTaskId: taskId });
  }, [windows, openWindow, focusWindow, minimizeWindow, updateWindow, activeLayerId, user?.id]);

  const handleOpenActivity = useCallback(() => {
    const existing = windows.find(w => w.type === 'activity');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('activity', { title: 'Activity', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenAgents = useCallback((opts?: { preserveFocus?: boolean }) => {
    // The plain "Agents" launcher always lands on the card grid — clear any stale
    // profile focus so a prior agent-profile click can't re-drill into detail.
    // Profile drill-in passes { preserveFocus: true } to keep the just-set key.
    if (opts?.preserveFocus !== true) setFocusedAgentKey(null);
    const existing = windows.find(w => w.type === 'agents');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('agents', { title: 'AI Agents', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenUsers = useCallback(() => {
    const existing = windows.find(w => w.type === 'users');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('users', { title: 'Users', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenSchedules = useCallback(() => {
    const existing = windows.find(w => w.type === 'schedules');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('schedules', { title: 'Schedules', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  // Farm device-code pairing: after sign-in, return to /integrations/farm?code=…
  // (FarmIntegrationApproval stashes the path before redirecting here).
  useEffect(() => {
    if (!user || authLoading) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get('redirect') || '';
      const fromStore = sessionStorage.getItem('agensis.farm.approvalReturn') || '';
      const candidate = fromQuery || fromStore;
      if (!candidate) return;
      // Only allow the farm approval surface — never open external URLs.
      const path = candidate.startsWith('/')
        ? candidate
        : (() => {
            try {
              const url = new URL(candidate, window.location.origin);
              if (url.origin !== window.location.origin) return '';
              return `${url.pathname}${url.search}`;
            } catch {
              return '';
            }
          })();
      if (!path.startsWith('/integrations/farm')) return;
      sessionStorage.removeItem('agensis.farm.approvalReturn');
      if (`${window.location.pathname}${window.location.search}` === path) return;
      window.location.replace(path);
    } catch {
      /* ignore storage / navigation failures */
    }
  }, [user, authLoading]);

  // CursorBuddy and the Agensis CLI link unauthenticated users here. Once login
  // completes, CursorBuddy opens the agent surface; CLI setup additionally posts
  // a daemon connection payload back to the local setup callback.
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const source = (params.get('source') || '').toLowerCase();
    const referrer = (params.get('referrer') || '').toLowerCase();
    const intent = (params.get('intent') || '').toLowerCase();
    const isCursorBuddy = source === 'cursorbuddy' || referrer === 'cursorbuddy';
    const isAgensisCli = source === 'agensis-cli' || referrer === 'agensis-cli';
    if (!isCursorBuddy && !isAgensisCli) return;
    if (intent && !['connect', 'login', 'setup'].includes(intent)) return;

    const cleanupLaunchParams = () => {
      for (const key of ['source', 'referrer', 'intent', 'callback', 'state', 'profile', 'host', 'cwd', 'handle', 'name']) {
        params.delete(key);
      }
      const qs = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    };

    const callback = params.get('callback') || '';
    const state = params.get('state') || '';
    if (isAgensisCli && intent === 'setup' && callback && state) {
      if (wsLoading || setupCallbackInFlightRef.current) return;
      setupCallbackInFlightRef.current = true;
      const workspaceId = activeWorkspaceId || workspaces[0]?.id || '';
      const callbackUrl = (() => {
        try {
          const url = new URL(callback);
          if (url.protocol !== 'http:') return null;
          if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
          return url.toString();
        } catch {
          return null;
        }
      })();
      if (!callbackUrl) {
        setupCallbackInFlightRef.current = false;
        toast.error('Agensis setup callback was not a local URL.');
        cleanupLaunchParams();
        return;
      }

      const payload = {
        workspaceId,
        profile: params.get('profile') || 'default',
        host: params.get('host') || '',
        cwd: params.get('cwd') || '',
        handle: params.get('handle') || '',
        name: params.get('name') || '',
        baseUrl: window.location.origin,
      };
      void (async () => {
        try {
          const res = await fetch(apiUrl('/backend/agensis/setup/connect'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
            body: JSON.stringify(payload),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || !body?.data?.daemonArgs) {
            throw new Error(body?.error?.message || body?.message || `Setup failed (${res.status})`);
          }
          const callbackRes = await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              state,
              profile: payload.profile,
              daemonArgs: body.data.daemonArgs,
              workspaceId: body.data.workspaceId,
              agentId: body.data.agentId,
            }),
          });
          if (!callbackRes.ok) {
            const callbackBody = await callbackRes.json().catch(() => ({}));
            throw new Error(callbackBody?.error || `Local setup callback failed (${callbackRes.status})`);
          }
          toast.success('Agensis CLI connected.');
          handleOpenAgents();
          cleanupLaunchParams();
        } catch (error) {
          setupCallbackInFlightRef.current = false;
          toast.error(String(error instanceof Error ? error.message : error));
        }
      })();
      return;
    }

    if (!isCursorBuddy) return;
    handleOpenAgents();
    cleanupLaunchParams();
  }, [user, wsLoading, activeWorkspaceId, workspaces, handleOpenAgents]);

  // Quick "copy invite link" used by the presence popup: mints an editor invite
  // for the active workspace and copies the shareable URL.
  const handleCopyInviteLink = useCallback(async (): Promise<string | null> => {
    if (!activeWorkspaceId) return null;
    try {
      const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(activeWorkspaceId)}/invites`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ role: 'editor' }),
      });
      const payload = await res.json().catch(() => null);
      const token = payload?.data?.token;
      if (!token) return null;
      const url = inviteUrl(window.location.origin, token);
      await navigator.clipboard?.writeText(url);
      return url;
    } catch {
      return null;
    }
  }, [activeWorkspaceId]);

  // Accept-invite-on-load: if the URL carries ?invite=<token>, join the workspace
  // once authenticated, then reload (so useWorkspaces refetches the new workspace).
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('invite');
    if (!token) return;
    (async () => {
      try {
        await fetch(apiUrl(`/backend/invites/${encodeURIComponent(token)}/accept`), {
          method: 'POST',
          headers: apiAuthHeaders(),
        });
      } catch {
        // ignore — the reload below still strips the param
      }
      params.delete('invite');
      const qs = params.toString();
      window.location.replace(`${window.location.pathname}${qs ? `?${qs}` : ''}`);
    })();
  }, [user]);

  const handleOpenAgentProfile = useCallback((agentIdOrHandle?: string | null) => {
    if (agentIdOrHandle) setFocusedAgentKey(agentIdOrHandle);
    handleOpenAgents({ preserveFocus: true });
  }, [handleOpenAgents]);

  // Newly dropped applet to focus (select + raise) once it lands in the canvas
  // object list; cleared by DrawingLayer via onFocusObjectHandled.
  const [focusCanvasObjectId, setFocusCanvasObjectId] = useState<string | null>(null);

  const handleCreateCanvasApp = useCallback(async (app: CanvasAppDefinition) => {
    const created = await addCanvasObject('applet', {
      x: 12,
      y: 10,
      width: app.defaultWidth ?? 40,
      height: app.defaultHeight ?? 55,
      fill: 'var(--canvas-raised)',
      stroke: 'var(--border)',
      stroke_width: 1,
      file_name: app.id,
      text_content: makeAppletState(app.id, { agentRuns: [] }),
      src: app.buildHtml(),
      layer_id: activeLayerId,
    });
    if (created) setFocusCanvasObjectId(created.id);
  }, [addCanvasObject, activeLayerId]);

  const handleCreateDocApp = useCallback(async (doc: Document) => {
    const created = await addCanvasObject('applet', {
      x: 12,
      y: 10,
      width: 28,
      height: 48,
      fill: 'var(--canvas-raised)',
      stroke: 'var(--border)',
      stroke_width: 1,
      file_name: doc.title,
      text_content: makeDocAppletState(doc.id, doc.title),
      src: '',
      layer_id: activeLayerId,
    });
    if (created) setFocusCanvasObjectId(created.id);
  }, [addCanvasObject, activeLayerId]);

  const handleCreateTask = useCallback(async (input: CreateTaskInput) => {
    const task = await createTask(input);
    if (task) {
      logEvent({
        event_type: 'task_created',
        entity_type: 'task',
        entity_id: task.id,
        title: `Task created: ${task.title}`,
      });
    }
    return task;
  }, [createTask, logEvent]);

  const handleUpdateTask = useCallback(async (id: string, updates: Partial<Task>) => {
    const result = await updateTask(id, updates);
    if (result && updates.status === 'done') {
      const task = tasks.find(t => t.id === id);
      if (task) {
        logEvent({
          event_type: 'task_completed',
          entity_type: 'task',
          entity_id: id,
          title: `Task completed: ${task.title}`,
        });
      }
    }
    return result;
  }, [updateTask, tasks, logEvent]);

  const handleToggleTaskStatus = useCallback(async (task: Task) => {
    const willComplete = task.status !== 'done';
    const result = await toggleTaskStatus(task);
    if (willComplete) {
      logEvent({
        event_type: 'task_completed',
        entity_type: 'task',
        entity_id: task.id,
        title: `Task completed: ${task.title}`,
      });
    }
    return result;
  }, [toggleTaskStatus, logEvent]);

  const handleDeleteTask = useCallback(async (id: string) => {
    return deleteTask(id);
  }, [deleteTask]);

  const handleDocumentOpen = useCallback((doc: Document) => {
    openWindow('document', { title: doc.title, documentId: doc.id, canvasId: activeLayerId, ownerUserId: user?.id });
  }, [openWindow, activeLayerId, user?.id]);

  const handleSessionOpen = useCallback((session: ChatSession) => {
    setActiveSession(session);
    openWindow('chat', { title: session.title, sessionId: session.id, canvasId: activeLayerId, ownerUserId: user?.id });
  }, [setActiveSession, openWindow, activeLayerId, user?.id]);

  const handleSplitThread = useCallback(async (source: ChatSession) => {
    const pending = toast.loading(`Splitting “${source.title || 'thread'}”…`);
    const forked = await splitSession(source);
    if (!forked) {
      toast.error('Split failed — try again', { id: pending });
      return;
    }
    toast.success(`Split created — “${forked.title}” added under its parent`, { id: pending });
    // Split is a point-in-time duplicate: the source keeps the live session
    // slot (and any in-flight job), the fork opens as its own independent,
    // non-active window (InactiveChatWindow) so it never borrows the
    // source's streaming state or looks like it's still processing.
    openSplitWindow(source.id, {
      title: forked.title || 'Split',
      sessionId: forked.id,
      canvasId: activeLayerId,
      ownerUserId: user?.id,
    });
    logEvent({
      event_type: 'chat_created',
      entity_type: 'chat',
      entity_id: forked.id,
      title: `Split thread: ${forked.title}`,
    });
  }, [splitSession, openSplitWindow, activeLayerId, user?.id, logEvent]);

  const handleMergeThread = useCallback(async (fork: ChatSession) => {
    const pending = toast.loading(`Merging “${fork.title || 'split'}” into its parent…`);
    const result = await mergeSession(fork);
    if (result.status === 'error') {
      toast.error('Merge failed — missing split lineage or parent thread', { id: pending });
      return;
    }
    if (result.parent) handleSessionOpen(result.parent);
    if (result.status === 'empty') {
      toast.success('Nothing diverged in the split — fork removed, parent kept', { id: pending });
      return;
    }
    toast.success('Merged — reconciling both branches into the parent', { id: pending });
  }, [mergeSession, handleSessionOpen]);

  // Delete a DM conversation: soft-delete all its messages, close (soft-delete)
  // the session, and close any open chat window pointing at it — "close the
  // thread" has to shut the actual window, not just drop the sidebar row, or the
  // user is left staring at a dead/empty chat pane. Everything is soft-deleted;
  // the data is retained for later use.
  const handleDeleteDm = useCallback(async (session: ChatSession) => {
    const pending = toast.loading(`Deleting “${session.title || 'conversation'}”…`);
    await closeAndClearSession(session.id);
    windows.filter(w => w.sessionId === session.id).forEach(w => closeWindow(w.id));
    toast.success('Conversation deleted and closed', { id: pending });
  }, [closeAndClearSession, windows, closeWindow]);

  const handleAgentDirectMessage = useCallback(async (agent: { id: string; agentId?: string | null; name: string; handle: string | null }) => {
    const handle = agent.handle?.trim().replace(/^@+/, '') || '';
    const agentId = agent.agentId || agent.id || null;
    const title = agent.name?.trim() || (handle ? `@${handle}` : 'Agent');
    const existing = sessions.find(session => !session.archived_at && isDirectSessionForAgent(session, agentId, handle));
    if (existing) {
      handleSessionOpen(existing);
      return;
    }

    const participant: ChannelParticipant = {
      id: agentId ? `agent:${agentId}` : `agent:${handle}`,
      kind: 'agent',
      name: title,
      handle: handle || null,
      agent_id: agentId,
      user_id: null,
      status: null,
      direct: true,
      added_at: new Date().toISOString(),
    };
    const session = await createSession('auto', {
      title,
      folder: 'Direct messages',
      conversation_mode: 'auto',
      participants: [participant],
    });
    if (!session) return;
    setActiveSession(session);
    openWindow('chat', { title, sessionId: session.id, canvasId: activeLayerId, ownerUserId: user?.id });
    logEvent({
      event_type: 'chat_created',
      entity_type: 'chat',
      entity_id: session.id,
      title: `New agent chat: ${title}`,
    });
  }, [sessions, handleSessionOpen, createSession, setActiveSession, openWindow, activeLayerId, user?.id, logEvent]);

  const handleOpenPresenceWindow = useCallback((win: FloatingWindow) => {
    if (win.isPrivate) return;
    if (win.type === 'document' && win.documentId) {
      const doc = documents.find(item => item.id === win.documentId);
      if (doc) handleDocumentOpen(doc);
      return;
    }
    if (win.type === 'chat' && win.sessionId) {
      const session = sessions.find(item => item.id === win.sessionId);
      if (session) handleSessionOpen(session);
      return;
    }
    if (win.type === 'memory') handleOpenMemory();
    else if (win.type === 'skills') handleOpenSkills();
    else if (win.type === 'tasks') handleOpenTasks();
    else if (win.type === 'activity') handleOpenActivity();
    else if (win.type === 'agents') handleOpenAgents();
    else if (win.type === 'schedules') handleOpenSchedules();
  }, [documents, handleDocumentOpen, handleOpenActivity, handleOpenAgents, handleOpenMemory, handleOpenSchedules, handleOpenTasks, handleSessionOpen, sessions]);

  const [useWorkspaceCtx, setUseWorkspaceCtx] = useState(() => getSetting('ai_use_workspace_context'));
  const extractedMessageIdsRef = useRef<Set<string>>(new Set());

  // When an assistant message finishes streaming, scan for `TASK: ...` lines
  // emitted by the model and materialize them as real tasks in the workspace.
  useEffect(() => {
    if (streaming) return;
    if (!activeWorkspaceId) return;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    if (!lastAssistant) return;
    // Track every processed message id (not just the last) so switching
    // between chats and back doesn't re-extract an already-seen message.
    if (extractedMessageIdsRef.current.has(lastAssistant.id)) return;
    extractedMessageIdsRef.current.add(lastAssistant.id);

    const lines = lastAssistant.content.split('\n');
    const taskTitles: string[] = [];
    for (const line of lines) {
      const match = line.match(/^\s*(?:[-*]\s*)?TASK:\s*(.+?)\s*$/i);
      if (match && match[1]) {
        const title = match[1].replace(/^\*\*|\*\*$/g, '').trim();
        if (title.length > 0 && title.length < 200) taskTitles.push(title);
      }
    }

    if (taskTitles.length === 0) return;
    taskTitles.slice(0, 10).forEach(title => {
      handleCreateTask({
        title,
        source_type: 'ai',
        source_id: activeSession?.id ?? null,
      });
    });
  }, [streaming, messages, activeWorkspaceId, activeSession, handleCreateTask]);

  const wrappedSendMessage = useCallback(async (
    content: string,
    model: string,
    memFacts?: MemoryFact[],
    docs?: Document[],
    threadParentId?: string | null,
    targetSession?: ChatSession | null,
  ) => {
    const snapshot = useWorkspaceCtx ? buildWorkspaceContext() : null;
    await sendMessage(content, model, memFacts, docs, snapshot, selectedAgent, threadParentId, targetSession);
  }, [sendMessage, useWorkspaceCtx, buildWorkspaceContext, selectedAgent]);

  const handleCreateCustomApplet = useCallback(async () => {
    const session = await createSession('auto', { canvas_id: activeLayerId });
    if (!session) return;

    const title = 'Create a canvas applet';
    await updateSession(session.id, { title });
    openWindow('chat', { title, sessionId: session.id, canvasId: activeLayerId, ownerUserId: user?.id });

    const brief = buildCanvasAppletCreationBrief(viewedLayer.name || activeWorkspace?.name || 'Workspace');
    setTimeout(() => {
      wrappedSendMessage(brief, 'auto', undefined, undefined, null, session);
    }, 100);
  }, [
    createSession,
    updateSession,
    openWindow,
    activeLayerId,
    user?.id,
    viewedLayer.name,
    activeWorkspace?.name,
    wrappedSendMessage,
  ]);

  const handleHomeSendMessage = useCallback(async (
    content: string,
    model: string,
    memFacts?: MemoryFact[],
    docs?: Document[]
  ) => {
    const session = await createSession('auto', { canvas_id: activeLayerId });
    if (session) {
      openWindow('chat', { title: content.slice(0, 30) || 'New Channel', sessionId: session.id, canvasId: activeLayerId, ownerUserId: user?.id });
      setTimeout(() => {
        wrappedSendMessage(content, model, memFacts, docs, null, session);
      }, 100);
    }
  }, [createSession, openWindow, wrappedSendMessage, activeLayerId, user?.id]);

  const handleCreateWorkspace = useCallback(() => {
    setCreateWorkspaceDialogOpen(true);
  }, []);

  const handleCreateWorkspaceSubmit = useCallback(async ({
    name,
    description,
    icon,
  }: {
    name: string;
    description: string;
    icon: string;
  }) => {
    const ws = await createWorkspace(name.trim(), icon.trim() || '🗂️', description.trim());
    if (ws) {
      setActiveWorkspaceId(ws.id);
      setCreateWorkspaceDialogOpen(false);
    }
  }, [createWorkspace]);

  const handleCloseWindow = useCallback((winId: string) => {
    const win = windows.find(w => w.id === winId);
    if (win?.sessionId && activeSession?.id === win.sessionId) {
      setActiveSession(null as unknown as ChatSession);
    }
    closeWindow(winId);
  }, [windows, activeSession, setActiveSession, closeWindow]);

  const handleShareWindow = useCallback((title: string) => {
    setShareDialogTitle(title);
    setShareDialogOpen(true);
  }, []);

  const handleOpenCanvasGrid = useCallback(() => {
    setShowCanvasGrid(true);
  }, []);

  const handleCloseCanvasGrid = useCallback(() => {
    setShowCanvasGrid(false);
  }, []);

  const handleSelectCanvasFromGrid = useCallback((layerId: string) => {
    activateLayer(layerId);
    setShowCanvasGrid(false);
  }, [activateLayer]);

  const handleCreateCanvasFromGrid = useCallback(() => {
    createLayer();
    setShowCanvasGrid(false);
  }, [createLayer]);

  const handleDeleteCanvasFromGrid = useCallback(async (layerId: string) => {
    const layer = layers.find(item => item.id === layerId);
    if (!layer || layerId === baseLayerId) return;
    setConfirmAction({
      title: `Delete ${layer.name}?`,
      description: 'This will remove the canvas and all items on it.',
      actionLabel: 'Delete',
      onConfirm: async () => {
        await deleteObjectsInLayer(layerId);
        deleteLayer(layerId);
      },
    });
  }, [layers, baseLayerId, deleteObjectsInLayer, deleteLayer]);

  const handleOpenMobileMenu = useCallback(() => setMobileDrawerOpen(true), []);
  const handleToggleWorkspaceCtx = useCallback(() => setUseWorkspaceCtx(v => !v), []);
  const handleCreateSubThreadFromScene = useCallback(async (messageId: string, agent: WorkspaceAgent, messageContent?: string) => {
    const slug = agent.handle || agent.name.toLowerCase().replace(/\s+/g, '-');
    const otherAgents = agents
      .filter(a => a.enabled !== false && a.id !== agent.id)
      .map(a => ({
        id: a.id,
        name: a.name,
        handle: a.handle || a.name.toLowerCase().replace(/\s+/g, '-'),
      }));
    await createSubThread(messageId, slug, agent.id, agent.name, {
      contextMessage: messageContent,
      additionalAgents: otherAgents,
    });
    // Background task — don't open the sub-thread panel; let it run autonomously.
    // The user can view it from the Threads panel.
  }, [agents, createSubThread]);
  const handleDeleteDocumentFromScene = useCallback(async (id: string) => {
    const doc = documents.find(d => d.id === id);
    await deleteDocument(id);
    if (doc) {
      logEvent({
        event_type: 'document_deleted',
        entity_type: 'document',
        entity_id: id,
        title: `Document deleted: ${doc.title}`,
      });
    }
  }, [documents, deleteDocument, logEvent]);
  const handleAddFactFromScene = useCallback((fact: string, category: string) => {
    addFact(fact, category);
    logEvent({
      event_type: 'memory_added',
      entity_type: 'memory',
      title: `Memory added: ${fact.slice(0, 60)}${fact.length > 60 ? '...' : ''}`,
      metadata: { category },
    });
  }, [addFact, logEvent]);
  const handleCommentCreatedFromScene = useCallback((docTitle?: string) => logEvent({
    event_type: 'comment_created',
    entity_type: 'document',
    title: docTitle ? `New comment on ${docTitle}` : 'New document comment',
  }), [logEvent]);

  const handleCloseMobileDrawer = useCallback(() => setMobileDrawerOpen(false), []);
  const handleOpenCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const handleSidebarUploadFile = useCallback(() => { }, []);
  const handleOpenTemplates = useCallback(() => setTemplatePickerOpen(true), []);
  const handleOpenSettingsFromSidebar = useCallback(() => openLayerSettings(activeLayerId), [openLayerSettings, activeLayerId]);
  const handleSidebarAgentProfile = useCallback((agent: { id: string; agentId: string | null; handle: string | null; name: string }) => {
    handleOpenAgentProfile(agent.agentId || agent.id || agent.handle || agent.name);
  }, [handleOpenAgentProfile]);

  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Spinner className="size-8" />
      </div>
    );
  }

  if (!user) {
    // Mount AppUpdateManager here too: SW registration + the update prompt live
    // inside it, and logged-out visitors otherwise never register the service
    // worker — an outdated SW (e.g. one predating the landing page) would serve
    // the stale SPA shell forever with no update path to escape it.
    return (
      <>
        <AuthPage onSignIn={signIn} onSignUp={signUp} onOAuthSignIn={signInWithOAuth} />
        <AppUpdateManager />
      </>
    );
  }

  return (
    <TooltipProvider>
      <div className="relative flex h-screen overflow-hidden bg-background">
        <img
          src={workspaceBackdropImage}
          alt=""
          className="pointer-events-none absolute inset-0 z-0 size-full object-cover"
          style={{ opacity: workspaceBackdropOpacity }}
        />
        <div className="pointer-events-none absolute inset-0 z-0 bg-[var(--home-bg-overlay)]" style={{ opacity: workspaceBackdropOverlayOpacity }} />
        <div
          className={cn(
            isMobile
              ? cn(
                'fixed inset-y-0 left-0 z-[12000] flex transition-transform duration-200 ease-out',
                mobileDrawerOpen ? 'translate-x-0' : 'pointer-events-none -translate-x-full',
              )
              : 'contents',
          )}
          style={isMobile ? { padding: WORKSPACE_CHROME_GAP } : undefined}
        >
          <Sidebar
            workspace={activeWorkspace}
            activeLayerName={viewedLayer.name || activeWorkspace?.name || 'Personal'}
            activeCanvasId={activeLayerId}
            overlay={isMobile}
            titlebarInset={isMobile ? 0 : DESKTOP_TITLEBAR_INSET}
            collapsed={isMobile ? false : sidebarCollapsed}
            onToggleCollapse={isMobile ? handleCloseMobileDrawer : handleToggleSidebar}
            onOpenCommandPalette={handleOpenCommandPalette}
            onOpenWorkspaceGrid={handleOpenCanvasGrid}
            onNewChat={handleNewChat}
            onNewDocument={handleNewDocument}
            onUploadFile={handleSidebarUploadFile}
            onCreateWorkspace={handleCreateWorkspace}
            onDocumentOpen={handleDocumentOpen}
            onDocumentUpdate={saveDocument}
            onSessionOpen={handleSessionOpen}
            onSessionUpdate={updateSession}
            onSessionArchive={archiveSession}
            onSessionDelete={deleteSession}
            onDirectMessageDelete={handleDeleteDm}
            onSessionSplit={handleSplitThread}
            onSessionMerge={handleMergeThread}
            onOpenMemory={handleOpenMemory}
            onOpenSkills={handleOpenSkills}
            onOpenTasks={handleOpenTasks}
            onOpenActivity={handleOpenActivity}
            onOpenAgents={handleOpenAgents}
            onOpenUsers={handleOpenUsers}
            onOpenSchedules={handleOpenSchedules}
            onAgentMessage={handleAgentDirectMessage}
            onAgentProfile={handleSidebarAgentProfile}
            onOpenTemplates={handleOpenTemplates}
            openTaskCount={openTasks.length}
            recents={recents}
            sessions={sessions}
            agents={agents}
            agentConnections={agentConnections}
            floatingWindows={windows}
            documentPresence={itemPresence.documentPresence}
            chatPresence={itemPresence.chatPresence}
            agentStatusFeed={agentStatusFeed}
            themeMode={themeMode}
            onThemeChange={setTheme}
            userEmail={user.email || ''}
            userId={user.id}
            onSignOut={signOut}
            onOpenSettings={handleOpenSettingsFromSidebar}
            getStartedSlot={(
              <GetStartedChecklist
                agents={agents}
                sessions={sessions}
                memberCount={members.length}
                onCreateAgent={handleOpenAgents}
                onStartRoom={handleNewChat}
                onMessageAgent={handleOpenAgents}
                onInvite={handleOpenUsers}
              />
            )}
            notificationsSlot={<NotificationsBell workspaceId={activeWorkspaceId || null} variant="inline" />}
            presenceSlot={(
              <WorkspacePresenceAvatars
                users={workspacePresenceUsers}
                getMode={getPresenceMode}
                onModeChange={setPresenceMode}
                favoriteIds={presenceFavorites}
                focusedUserId={focusedPresenceUserId}
                onToggleFavorite={togglePresenceFavorite}
                onFocusUser={setFocusedPresenceUserId}
                onOpenRemoteWindow={handleOpenPresenceWindow}
                onCopyInviteLink={handleCopyInviteLink}
                onMessageAgent={person => handleAgentDirectMessage({
                  id: person.agentId || person.id,
                  agentId: person.agentId,
                  name: person.name,
                  handle: person.handle ?? null,
                })}
              />
            )}
          />
        </div>
        {isMobile && mobileDrawerOpen && (
          <div
            className="fixed inset-0 z-[11999] bg-black/50 backdrop-blur-sm"
            onClick={() => setMobileDrawerOpen(false)}
            aria-hidden
          />
        )}

        <div
          className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          style={{
            // Canvas column sits to the RIGHT of the full-height sidebar, so the
            // macOS traffic lights (top-left, over the sidebar) never overlap it —
            // it only needs the uniform 8px chrome gap, not the 52px titlebar
            // reserve. This lets panels + the maximize button fill to 8px from the
            // window's top edge. The sidebar keeps its own titlebarInset (below).
            paddingTop: WORKSPACE_CHROME_GAP,
            paddingRight: WORKSPACE_CHROME_GAP,
            paddingBottom: WORKSPACE_CHROME_GAP,
            paddingLeft: WORKSPACE_CHROME_GAP,
          }}
        >
          <NetworkStatusBar
            online={online}
            syncing={syncing}
            pendingCount={pendingCount}
            syncError={syncError}
            onSync={flushQueue}
            onClearQueue={clearPendingQueue}
          />

          <main
            ref={canvasRef}
            data-workspace-viewport
            className={cn(
              'relative min-h-0 flex-1 rounded-none',
              // A full-bleed window (maximized, or a tiled group filling the panel)
              // paints OVER the 8px chrome gap by extending its shell into the
              // padding — so the viewport must un-clip to let that extension reach
              // the true panel edge. Clipped by default so floating panels + their
              // resize handles never spill into the gap.
              viewportUnclipped ? 'overflow-visible' : 'overflow-hidden',
            )}
          >
            <CanvasDropZone
              onAddObject={addCanvasObject}
              onUploadFiles={uploadFiles}
            >
              <CursorOverlay cursors={cursors} getMode={getPresenceMode} />

              <div
                ref={activeSceneRef}
                className={cn('absolute inset-0 transition-opacity duration-200', showCanvasGrid ? 'opacity-10' : 'opacity-100')}
              >
                <CanvasLayerScene
                  documents={documents}
                  facts={facts}
                  categories={categories}
                  sessions={sessions}
                  activeSession={activeSession}
                  messages={messages}
                  hasMoreMessages={hasMoreMessages}
                  loadingEarlier={loadingEarlier}
                  onLoadEarlier={loadEarlierMessages}
                  streaming={streaming}
                  workspaceName={viewedLayer.name || activeWorkspace?.name || 'Personal'}
                  workspaceId={activeWorkspaceId || ''}
                  userId={user.id}
                  userEmail={user.email || ''}
                  canvasObjects={visibleCanvasObjects}
                  canvasGroups={visibleCanvasGroups}
                  windows={activeWindows}
                  isMobile={isMobile}
                  onOpenMobileMenu={handleOpenMobileMenu}
                  tasks={tasks}
                  members={members}
                  activityEvents={activityEvents}
                  activityLoading={activityLoading}
                  agents={agents}
                  agentWebhooks={agentWebhooks}
                  agentConnections={agentConnections}
                  presenceUsers={workspacePresenceUsers}
                  uploadedFiles={uploadedFiles}
                  onUploadFiles={uploadFiles}
                  selectedAgent={selectedAgent}
                  focusedAgentKey={focusedAgentKey}
                  systemCapabilities={systemCapabilities}
                  getPresenceMode={getPresenceMode}
                  backgroundOpacity={viewedLayer.background_opacity ?? activeWorkspace?.background_opacity ?? 0.42}
                  backgroundImage=""
                  contextCounts={contextCounts}
                  contextCountsTitle={contextCountsTitle}
                  onSelectAgent={setSelectedAgent}
                  onAgentProfile={handleOpenAgentProfile}
                  onCreateAgent={createAgent}
                  onUpdateAgent={updateAgent}
                  onDeleteAgent={deleteAgent}
                  onDisconnectAgent={disconnectAgent}
                  onCreateAgentWebhook={createAgentWebhook}
                  onUpdateAgentWebhook={updateAgentWebhook}
                  onOpenConnections={() => openLayerSettings(activeLayerId, 'connections')}
                  topLevelMessages={topLevelMessages}
                  threadMessages={threadMessages}
                  threadReplyCounts={threadReplyCounts}
                  activeThreadId={activeThreadId}
                  onOpenThread={openThread}
                  onCloseThread={closeThread}
                  subThreadsByMessage={subThreadsByMessage}
                  activeSubThread={activeSubThread}
                  subThreadMessages={subThreadMessages}
                  subThreadStreaming={subThreadStreaming}
                  onOpenSubThread={openSubThread}
                  onCloseSubThread={closeSubThread}
                  onCreateSubThread={handleCreateSubThreadFromScene}
                  onSendSubThreadMessage={sendSubThreadMessage}
                  onSplitThread={handleSplitThread}
                  useWorkspaceCtx={useWorkspaceCtx}
                  onToggleWorkspaceCtx={handleToggleWorkspaceCtx}
                  onHomeSendMessage={handleHomeSendMessage}
                  onNewDocument={handleNewDocument}
                  onOpenSchedules={handleOpenSchedules}
                  onCloseWindow={handleCloseWindow}
                  onFocusWindow={focusWindow}
                  onUpdateWindow={updateWindow}
                  onMinimizeWindow={minimizeWindow}
                  onMinimizeWindowGroup={minimizeWindowGroup}
                  onUngroupTiledWindows={ungroupTiledWindows}
                  onFocusWindowGroup={focusWindowGroup}
                  onShareWindow={handleShareWindow}
                  onSendMessage={wrappedSendMessage}
                  onSetActiveSession={setActiveSession}
                  onDeleteDocument={handleDeleteDocumentFromScene}
                  onAutoSaveDocument={autoSave}
                  onToggleFavorite={toggleFavorite}
                  onAddFact={handleAddFactFromScene}
                  onUpdateFact={updateFact}
                  onDeleteFact={deleteFact}
                  onCreateTask={handleCreateTask}
                  onUpdateTask={handleUpdateTask}
                  onToggleTaskStatus={handleToggleTaskStatus}
                  onDeleteTask={handleDeleteTask}
                  onCommentCreated={handleCommentCreatedFromScene}
                  onRequestConfirm={setConfirmAction}
                />
              </div>

              <DrawingLayer
                objects={visibleCanvasObjects}
                groups={visibleCanvasGroups}
                drawingActive={drawingActive}
                onToggleDrawing={() => setDrawingActive(prev => !prev)}
                onAddObject={addCanvasObject}
                onUpdateObject={updateCanvasObject}
                onDeleteObject={deleteCanvasObject}
                onBringToFront={bringCanvasObjectToFront}
                onCreateGroup={createCanvasGroup}
                onDeleteGroup={deleteCanvasGroup}
                onCreateTask={({ title, sourceId }) => handleCreateTask({ title, source_type: 'canvas', source_id: sourceId })}
                tasks={tasks}
                agents={agents}
                documents={documents}
                getPresenceMode={getPresenceMode}
                canEditObject={canEditCanvasObject}
                onCreateAppletTask={handleCreateTask}
                onUpdateAppletTask={handleUpdateTask}
                focusObjectId={focusCanvasObjectId}
                onFocusObjectHandled={() => setFocusCanvasObjectId(null)}
              />

              {showCanvasGrid && (
                <CanvasGridOverlay
                  layers={layers}
                  objects={canvasObjects}
                  windows={windows}
                  activeLayerId={activeLayerId}
                  backgroundImage={canvasGridBackground}
                  onClose={handleCloseCanvasGrid}
                  onSelectLayer={handleSelectCanvasFromGrid}
                  onCreateLayer={handleCreateCanvasFromGrid}
                  onDeleteLayer={handleDeleteCanvasFromGrid}
                  onOpenSettings={(layerId) => openLayerSettings(layerId)}
                  baseLayerId={baseLayerId}
                />
              )}

              <CanvasTemplatePicker
                open={templatePickerOpen}
                onClose={() => setTemplatePickerOpen(false)}
                onCreateApp={handleCreateCanvasApp}
                onCreateDocApp={handleCreateDocApp}
                onCreateCustomApp={handleCreateCustomApplet}
                documents={documents}
              />

              <div
                className="workspace-window-dock agensis-glass-panel absolute left-1/2 z-[11000] flex max-w-[calc(100%-12rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-[16px] border p-[5px] shadow-md"
                style={{ bottom: WORKSPACE_DOCK_BOTTOM_OFFSET, height: WORKSPACE_DOCK_HEIGHT }}
              >
                {!isFullExpandMode && dockEntries.map(entry => {
                  if (entry.kind === 'window') {
                    const win = entry.win;
                    return renderDockButton(win, focusedDockWindow, {
                      onOpen: () => { focusWindow(win.id); minimizeWindow(win.id); },
                      onHide: () => minimizeWindow(win.id),
                      onFocus: () => focusWindow(win.id),
                      onClose: () => handleCloseWindow(win.id),
                    }, bouncingDockIds.has(win.id), dockAvatarById.get(win.id) ?? null);
                  }
                  const { groupId, members } = entry;
                  return (
                    <div
                      key={groupId}
                      className="dock-window-group flex items-center gap-0.5 rounded-2xl border border-border/60 bg-background/40 p-0.5"
                      title={`Grouped: ${members.map(windowLabel).join(' + ')}`}
                    >
                      {members.map(member => renderDockButton(member, focusedDockWindow, {
                        onOpen: () => focusWindowGroup(groupId, member.id),
                        onHide: () => minimizeWindowGroup(groupId),
                        onFocus: () => focusWindowGroup(groupId, member.id),
                        onClose: () => handleCloseWindow(member.id),
                      }, bouncingDockIds.has(member.id), dockAvatarById.get(member.id) ?? null))}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => ungroupTiledWindows(groupId)}
                        className="size-5 rounded-lg text-muted-foreground hover:bg-background/70 hover:text-foreground"
                        title="Ungroup windows"
                        aria-label="Ungroup windows"
                      >
                        <Ungroup className="size-3" />
                      </Button>
                    </div>
                  );
                })}
                {!isFullExpandMode && dockWindows.length > 0 && (
                  <Separator orientation="vertical" className="mx-0.5 h-6" />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setDrawingActive(prev => !prev)}
                  className={cn(
                    'relative size-8 rounded-xl border border-transparent text-foreground/90 transition-colors hover:bg-background/70 hover:text-foreground',
                    drawingActive && 'border-border/70 bg-background/80 text-foreground shadow-sm',
                  )}
                  title={drawingActive ? 'Stop drawing' : 'Draw on canvas'}
                  aria-label={drawingActive ? 'Stop drawing' : 'Draw on canvas'}
                  aria-pressed={drawingActive}
                >
                  <Pencil className="size-4" />
                </Button>
              </div>

            </CanvasDropZone>
          </main>
        </div>

        {showTour && (
          <OnboardingTour
            onComplete={handleTourComplete}
            onInvite={handleOpenUsers}
            workspaceId={activeWorkspaceId || null}
            agents={agents}
            connections={agentConnections}
            createAgent={createAgent}
          />
        )}

        <CommandPalette
          open={commandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
          documents={documents}
          sessions={sessions}
          facts={facts}
          tasks={tasks}
          onDocumentOpen={handleDocumentOpen}
          onSessionOpen={handleSessionOpen}
          onTaskOpen={(task) => handleOpenTasks(task.id)}
          onViewChange={(view) => {
            if (view === 'tasks') handleOpenTasks();
            else if (view === 'activity') handleOpenActivity();
            else if (view === 'memory') handleOpenMemory();
            else if (view === 'chat') handleNewChat();
            else if (view === 'document') handleNewDocument();
          }}
        />

        <ShareDialog
          open={shareDialogOpen}
          onClose={() => setShareDialogOpen(false)}
          title={shareDialogTitle}
          workspaceName={activeWorkspace?.name || 'Personal'}
          currentUserEmail={user.email || ''}
          members={members}
          autoShare={autoShare}
          onToggleAutoShare={toggleAutoShare}
          onInvite={inviteByEmail}
          onRemoveMember={removeMember}
          onUpdateRole={updateMemberRole}
        />

        <CreateWorkspaceDialog
          open={createWorkspaceDialogOpen}
          onClose={() => setCreateWorkspaceDialogOpen(false)}
          onCreate={handleCreateWorkspaceSubmit}
        />

        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          workspace={settingsWorkspace}
          secretsWorkspaceId={activeWorkspace?.id ?? null}
          initialTab={settingsInitialTab}
          onUpdateWorkspace={handleUpdateSettingsWorkspace}
          workspaceName={settingsWorkspace?.name || 'Personal'}
          userEmail={user.email || ''}
          themeMode={themeMode}
          onThemeChange={setTheme}
        />

        <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <Trash2 />
              </AlertDialogMedia>
              <AlertDialogTitle>{confirmAction?.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirmAction?.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const action = confirmAction?.onConfirm;
                  setConfirmAction(null);
                  void action?.();
                }}
              >
                {confirmAction?.actionLabel || 'Confirm'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <RegistrationApprovalPopup workspaceId={activeWorkspaceId || null} />
      <AppUpdateManager />
      <Toaster />
    </TooltipProvider>
  );
}

function CanvasLayerScene({
  documents,
  facts,
  categories,
  sessions,
  activeSession,
  messages,
  hasMoreMessages,
  loadingEarlier,
  onLoadEarlier,
  streaming,
  workspaceName,
  workspaceId,
  userId,
  userEmail,
  canvasObjects,
  canvasGroups,
  windows,
  tasks,
  members,
  activityEvents,
  activityLoading,
  agents,
  agentWebhooks,
  agentConnections,
  presenceUsers,
  uploadedFiles,
  onUploadFiles,
  selectedAgent,
  systemCapabilities,
  getPresenceMode,
  backgroundOpacity,
  backgroundImage,
  contextCounts,
  contextCountsTitle,
  onSelectAgent,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
  onDisconnectAgent,
  focusedAgentKey,
  onAgentProfile,
  onCreateAgentWebhook,
  onUpdateAgentWebhook,
  onOpenConnections,
  topLevelMessages,
  threadMessages,
  threadReplyCounts,
  activeThreadId,
  onOpenThread,
  onCloseThread,
  subThreadsByMessage,
  activeSubThread,
  subThreadMessages,
  subThreadStreaming,
  onOpenSubThread,
  onCloseSubThread,
  onCreateSubThread: onCreateSubThreadProp,
  onSendSubThreadMessage,
  onSplitThread,
  useWorkspaceCtx,
  onToggleWorkspaceCtx,
  onHomeSendMessage,
  onNewDocument,
  onOpenSchedules,
  onCloseWindow,
  onFocusWindow,
  onUpdateWindow,
  onMinimizeWindow,
  onMinimizeWindowGroup,
  onUngroupTiledWindows,
  onFocusWindowGroup,
  onShareWindow,
  onSendMessage,
  onSetActiveSession,
  onDeleteDocument,
  onAutoSaveDocument,
  onToggleFavorite,
  onAddFact,
  onUpdateFact,
  onDeleteFact,
  onCreateTask,
  onUpdateTask,
  onToggleTaskStatus,
  onDeleteTask,
  onCommentCreated,
  onRequestConfirm,
  isMobile,
  onOpenMobileMenu,
}: {
  documents: Document[];
  facts: MemoryFact[];
  categories: string[];
  sessions: ChatSession[];
  activeSession: ChatSession | null;
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>;
  hasMoreMessages: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: (sessionId: string) => void;
  streaming: boolean;
  workspaceName: string;
  workspaceId: string;
  userId: string;
  userEmail: string;
  canvasObjects: CanvasObject[];
  canvasGroups: CanvasGroup[];
  windows: FloatingWindow[];
  isMobile: boolean;
  onOpenMobileMenu: () => void;
  tasks: Task[];
  members: WorkspaceMember[];
  activityEvents: ActivityEvent[];
  activityLoading: boolean;
  agents: WorkspaceAgent[];
  agentWebhooks: AgentWebhook[];
  agentConnections: AgentConnection[];
  presenceUsers: WorkspacePresenceUser[];
  uploadedFiles: UploadedFile[];
  onUploadFiles: (files: File[]) => Promise<UploadedFile[]>;
  selectedAgent: WorkspaceAgent | null;
  systemCapabilities: SystemCapabilities | null;
  getPresenceMode: (id?: string | null) => PresenceVisibilityMode;
  backgroundOpacity: number;
  backgroundImage?: string | null;
  contextCounts: WorkspaceContextCounts;
  contextCountsTitle: string;
  onSelectAgent: (agent: WorkspaceAgent | null) => void;
  onCreateAgent: (input: CreateAgentInput) => void;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onDeleteAgent: (id: string) => void;
  onDisconnectAgent: (id: string) => Promise<unknown>;
  focusedAgentKey: string | null;
  onAgentProfile: (agentIdOrHandle?: string | null) => void;
  onCreateAgentWebhook: (input: { agent_id?: string | null; name: string }) => Promise<AgentWebhook | null>;
  onUpdateAgentWebhook: (id: string, updates: Partial<AgentWebhook>) => Promise<AgentWebhook | null>;
  onOpenConnections: () => void;
  topLevelMessages: import('./types').Message[];
  threadMessages: import('./types').Message[];
  threadReplyCounts: Record<string, number>;
  activeThreadId: string | null;
  onOpenThread: (messageId: string) => void;
  onCloseThread: () => void;
  subThreadsByMessage: Record<string, import('./types').ChatSession[]>;
  activeSubThread: import('./types').ChatSession | null;
  subThreadMessages: import('./types').Message[];
  subThreadStreaming: boolean;
  onOpenSubThread: (session: import('./types').ChatSession) => void;
  onCloseSubThread: () => void;
  onCreateSubThread: (messageId: string, agent: WorkspaceAgent) => void;
  onSendSubThreadMessage: (content: string) => void;
  onSplitThread: (source: import('./types').ChatSession) => void;
  useWorkspaceCtx: boolean;
  onToggleWorkspaceCtx: () => void;
  onHomeSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => void;
  onNewDocument: () => void;
  onOpenSchedules: () => void;
  onCloseWindow: (winId: string) => void;
  onFocusWindow: (winId: string) => void;
  onUpdateWindow: (id: string, updates: Partial<FloatingWindow>) => void;
  onMinimizeWindow: (id: string) => void;
  onMinimizeWindowGroup: (groupId: string) => void;
  onUngroupTiledWindows: (groupId: string) => void;
  onFocusWindowGroup: (groupId: string, leadId: string) => void;
  onShareWindow: (title: string) => void;
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[], threadParentId?: string | null, targetSession?: ChatSession | null) => void;
  onSetActiveSession: (session: ChatSession) => void;
  onDeleteDocument: (id: string) => void;
  onAutoSaveDocument: (id: string, updates: { title?: string; content?: string }) => void;
  onToggleFavorite: (id: string, current: boolean) => void;
  onAddFact: (fact: string, category: string) => void;
  onUpdateFact: (id: string, fact: string, category: string) => void;
  onDeleteFact: (id: string) => void;
  onCreateTask: (input: CreateTaskInput) => void;
  onUpdateTask: (id: string, updates: Partial<Task>) => void;
  onToggleTaskStatus: (task: Task) => void;
  onDeleteTask: (id: string) => void;
  onCommentCreated: (docTitle?: string) => void;
  onRequestConfirm: (confirm: {
    title: string;
    description: string;
    actionLabel: string;
    onConfirm: () => void | Promise<void>;
  }) => void;
}) {
  const { selectedWindowIds, viewMode, toggleFullExpand } = useWindowManager();
  const isFullExpandMode = viewMode === 'full';

  // On a phone the canvas shows exactly one window — the focused one (highest
  // zIndex, the same signal a click uses to raise a window). Everything else is
  // reachable through the bottom switcher bar instead of the free-floating layout.
  const nonMinimizedWindows = windows.filter(win => !win.minimized);
  const topWindowId = pickActiveWindowId(windows);
  const mobileActiveWindowId = topWindowId;
  // Full-expand shows exactly one window — the top (highest-z, most recently
  // opened/focused) — edge-to-edge; every other window stays mounted upstream in
  // useWindows state (cached) so switching to it via the sidebar is instant.
  // Mobile keeps its own single-window rule. Otherwise render the full float set.
  const renderedWindows = (isFullExpandMode || isMobile) && topWindowId
    ? nonMinimizedWindows.filter(win => win.id === topWindowId)
    : nonMinimizedWindows;

  const adjacencyByWindowId = useMemo(
    () => new Map(windows.map(w => [w.id, computeAdjacentEdges(w, windows)])),
    [windows],
  );

  // One frame per visible group, drawn behind its members at their union box.
  const groupFrames = useMemo(() => {
    const ids = new Set(renderedWindows.map(w => w.groupId).filter(Boolean) as string[]);
    return [...ids].map(groupId => {
      const bounds = computeGroupBounds(groupId, renderedWindows);
      if (!bounds) return null;
      const members = renderedWindows.filter(w => w.groupId === groupId && !w.minimized);
      return { groupId, bounds, members, baseZIndex: Math.min(...members.map(w => w.zIndex)) };
    }).filter(Boolean) as Array<{ groupId: string; bounds: NonNullable<ReturnType<typeof computeGroupBounds>>; members: FloatingWindow[]; baseZIndex: number }>;
  }, [renderedWindows]);

  const groupRoleByWindowId = useMemo(
    () => new Map(windows.map(w => [w.id, computeGroupRole(w, windows)])),
    [windows],
  );

  // Identical for every chat window — build once instead of per-window in the map.
  const contextControlsElement = useMemo(() => (
    <KnowledgeContextControl
      counts={contextCounts}
      enabled={useWorkspaceCtx}
      title={contextCountsTitle}
      onToggle={onToggleWorkspaceCtx}
    />
  ), [contextCounts, useWorkspaceCtx, contextCountsTitle, onToggleWorkspaceCtx]);

  return (
    <>
      <HomeCanvas
        documents={documents}
        agents={agents}
        workspaceId={workspaceId}
        memoryFacts={facts}
        onSendMessage={onHomeSendMessage}
        onOpenNewDocument={onNewDocument}
        onOpenSchedules={onOpenSchedules}
        workspaceName={workspaceName}
        backgroundOpacity={backgroundOpacity}
        backgroundImage={backgroundImage}
      />

      <CanvasSelectionLayer />

      {groupFrames.map(frame => (
        <WindowGroupFrame
          key={`group-${frame.groupId}`}
          groupId={frame.groupId}
          bounds={frame.bounds}
          members={frame.members}
          baseZIndex={frame.baseZIndex}
          onMinimizeGroup={onMinimizeWindowGroup}
          onUngroup={onUngroupTiledWindows}
          onCloseGroup={gid => renderedWindows.filter(w => w.groupId === gid).forEach(w => onCloseWindow(w.id))}
          onFocusGroup={onFocusWindowGroup}
        />
      ))}

      {renderedWindows.map(win => {
        const presenceMode = getPresenceMode(win.ownerUserId);
        const isWindowOwner = !win.ownerUserId || win.ownerUserId === userId;
        const canControlWindow = isWindowOwner && !(win.locked && !isWindowOwner);
        const adjacentEdges = adjacencyByWindowId.get(win.id);
        const groupRole = groupRoleByWindowId.get(win.id);

        if (win.type === 'chat') {
          const winSession = sessions.find(s => s.id === win.sessionId);
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<MessageSquare size={13} />}
              breadcrumb={workspaceName}
            >
              {canControlWindow ? (
                winSession && activeSession?.id !== win.sessionId ? (
                  <InactiveChatWindow
                    session={winSession}
                    windowTitle={win.title}
                    facts={facts}
                    documents={documents}
                    agents={agents}
                    agentConnections={agentConnections}
                    presenceUsers={presenceUsers}
                    selectedAgent={selectedAgent}
                    onSelectAgent={onSelectAgent}
                    onAgentProfile={onAgentProfile}
                    canvasGroups={canvasGroups}
                    canvasObjects={canvasObjects}
                    workspaceId={workspaceId}
                    uploadedFiles={uploadedFiles}
                    onUploadFiles={onUploadFiles}
                    onCreateTask={onCreateTask}
                    systemCapabilities={systemCapabilities}
                    contextControls={contextControlsElement}
                    onSetActiveSession={onSetActiveSession}
                    onSendMessage={onSendMessage}
                    onOpenThread={onOpenThread}
                  />
                ) : (
                  <ChatWindowBody
                    winSession={winSession}
                    isActiveSession={activeSession?.id === win.sessionId}
                    onAppSendMessage={onSendMessage}
                    onSetActiveSession={onSetActiveSession}
                    onAppSplitThread={onSplitThread}
                    messages={winSession && activeSession?.id === win.sessionId ? (messages as never[]) : EMPTY_MESSAGES}
                    hasMoreMessages={winSession && activeSession?.id === win.sessionId ? hasMoreMessages : false}
                    loadingEarlier={loadingEarlier}
                    onLoadEarlier={winSession ? () => onLoadEarlier(winSession.id) : undefined}
                    topLevelMessages={winSession && activeSession?.id === win.sessionId ? topLevelMessages : undefined}
                    threadMessages={threadMessages}
                    threadReplyCounts={threadReplyCounts}
                    activeThreadId={activeThreadId}
                    streaming={activeSession?.id === win.sessionId ? streaming : false}
                    memoryFacts={facts}
                    documents={documents}
                    agents={agents}
                    agentConnections={agentConnections}
                    presenceUsers={presenceUsers}
                    selectedAgent={selectedAgent}
                    onSelectAgent={onSelectAgent}
                    onAgentProfile={onAgentProfile}
                    isDirectMessage={isDirectChatSession(winSession)}
                    canvasGroups={canvasGroups}
                    canvasObjects={canvasObjects}
                    workspaceId={workspaceId}
                    uploadedFiles={uploadedFiles}
                    onUploadFiles={onUploadFiles}
                    onCreateTask={onCreateTask}
                    systemCapabilities={systemCapabilities}
                    contextControls={contextControlsElement}
                    onOpenThread={onOpenThread}
                    onCloseThread={onCloseThread}
                    subThreadsByMessage={subThreadsByMessage}
                    activeSubThread={activeSubThread}
                    subThreadMessages={subThreadMessages}
                    subThreadStreaming={subThreadStreaming}
                    onOpenSubThread={onOpenSubThread}
                    onCloseSubThread={onCloseSubThread}
                    onCreateSubThread={onCreateSubThreadProp}
                    onSendSubThreadMessage={onSendSubThreadMessage}
                    channelTitle={winSession?.title || win.title}
                    currentUserId={userId}
                  />
                )
              ) : (
                <ReadOnlyChatWindowContent
                  sessionId={win.sessionId || null}
                  memoryFacts={facts}
                  documents={documents}
                  canvasGroups={canvasGroups}
                  canvasObjects={canvasObjects}
                  workspaceId={workspaceId}
                  agents={agents}
                  agentConnections={agentConnections}
                  presenceUsers={presenceUsers}
                  uploadedFiles={uploadedFiles}
                />
              )}
            </FloatingWindowShell>
          );
        }

        if (win.type === 'document') {
          const doc = documents.find(d => d.id === win.documentId);
          if (!doc) return null;
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<FileText size={13} />}
              breadcrumb={workspaceName}
            >
              <DocWindowBody
                windowId={win.id}
                onDeleteDocument={onDeleteDocument}
                onCloseWindow={onCloseWindow}
                onUpdateWindow={onUpdateWindow}
                onRequestConfirm={onRequestConfirm}
                document={doc}
                workspaceId={workspaceId}
                userId={userId}
                currentUserEmail={userEmail}
                onAutoSave={onAutoSaveDocument}
                onToggleFavorite={onToggleFavorite}
                onCommentCreated={onCommentCreated}
                tasks={tasks}
                onUpdateTask={onUpdateTask}
              />
            </FloatingWindowShell>
          );
        }

        if (win.type === 'memory') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<Brain size={13} />}
              breadcrumb={workspaceName}
            >
              <MemorySection
                workspaceId={workspaceId}
                agents={agents}
                userId={userId}
                userEmail={userEmail}
                facts={facts}
                categories={categories}
                onAdd={onAddFact}
                onUpdate={onUpdateFact}
                onDelete={onDeleteFact}
              />
            </FloatingWindowShell>
          );
        }

        if (win.type === 'skills') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<Sparkles size={13} />}
              breadcrumb={workspaceName}
            >
              <SkillsWindowContent
                agents={agents}
                agentConnections={agentConnections}
                systemCapabilities={systemCapabilities}
              />
            </FloatingWindowShell>
          );
        }

        if (win.type === 'tasks') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<CheckCircle2 size={13} />}
              breadcrumb={workspaceName}
            >
              <TasksWindowBody
                windowId={win.id}
                onUpdateWindow={onUpdateWindow}
                tasks={tasks}
                members={members}
                agents={agents}
                agentConnections={agentConnections}
                currentUserEmail={userEmail}
                workspaceId={workspaceId}
                currentUserId={userId}
                onCreateTask={onCreateTask}
                onUpdateTask={onUpdateTask}
                onToggleStatus={onToggleTaskStatus}
                onDeleteTask={onDeleteTask}
                onUpdateAgent={onUpdateAgent}
                focusTaskId={win.focusTaskId}
              />
            </FloatingWindowShell>
          );
        }

        if (win.type === 'activity') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<Activity size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <ActivityWindowContent
                  events={activityEvents}
                  loading={activityLoading}
                />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        if (win.type === 'agents') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<Bot size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <AgentsWindowContent
                  agents={agents}
                  webhooks={agentWebhooks}
                  connections={agentConnections}
                  currentUserId={userId}
                  focusedAgentKey={focusedAgentKey}
                  onCreateAgent={onCreateAgent}
                  onUpdateAgent={onUpdateAgent}
                  onDeleteAgent={onDeleteAgent}
                  onDisconnectAgent={onDisconnectAgent}
                  onCreateWebhook={onCreateAgentWebhook}
                  onUpdateWebhook={onUpdateAgentWebhook}
                  onOpenConnections={onOpenConnections}
                />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        if (win.type === 'users') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<Users size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <UsersWindow
                  workspaceId={workspaceId}
                  workspaceName={workspaceName}
                  currentUserId={userId}
                  currentUserEmail={userEmail}
                />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        if (win.type === 'schedules') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={onFocusWindow}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              titleIcon={<Clock size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <SchedulesWindow
                  workspaceId={workspaceId}
                  agents={agents}
                  sessions={sessions}
                />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        return null;
      })}

      {isMobile && (
        <MobileWindowSwitcher
          windows={nonMinimizedWindows}
          activeWindowId={mobileActiveWindowId}
          onFocus={onFocusWindow}
          onClose={onCloseWindow}
          onOpenMenu={onOpenMobileMenu}
        />
      )}
    </>
  );
}

function ReadOnlyChatWindowContent({
  sessionId,
  memoryFacts,
  documents,
  canvasGroups,
  canvasObjects,
  workspaceId,
  agents = [],
  agentConnections = [],
  presenceUsers = [],
  uploadedFiles,
}: {
  sessionId: string | null;
  memoryFacts: MemoryFact[];
  documents: Document[];
  canvasGroups: CanvasGroup[];
  canvasObjects: CanvasObject[];
  workspaceId: string;
  agents?: WorkspaceAgent[];
  agentConnections?: AgentConnection[];
  presenceUsers?: WorkspacePresenceUser[];
  uploadedFiles: UploadedFile[];
}) {
  const [remoteMessages, setRemoteMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setRemoteMessages([]);
      return;
    }

    backendClient
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .then((result: { data: ChatMessage[] | null }) => {
        const { data } = result;
        // Drop soft-deleted rows so a cleared conversation can't linger in a
        // second open tab that hasn't yet closed the window.
        if (!cancelled && data) {
          setRemoteMessages(data.filter(m => !(m as { deleted_at?: string | null }).deleted_at) as ChatMessage[]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <ChatWindowContent
      messages={remoteMessages}
      streaming={false}
      memoryFacts={memoryFacts}
      documents={documents}
      agents={agents}
      agentConnections={agentConnections}
      presenceUsers={presenceUsers}
      canvasGroups={canvasGroups}
      canvasObjects={canvasObjects}
      workspaceId={workspaceId}
      uploadedFiles={uploadedFiles}
      onSendMessage={NOOP_SEND_MESSAGE}
      readOnly
    />
  );
}

// An owned chat window that is NOT the globally-active session. It loads and
// live-subscribes to its own session's messages (via useSessionMessages) so a
// second open agent DM still shows history and receives replies in realtime.
// It stays interactive: sending or opening a thread first promotes this session
// to active, after which the live `useChat`-backed path takes over (including
// token streaming).
function InactiveChatWindow({
  session,
  windowTitle,
  facts,
  documents,
  agents,
  agentConnections,
  presenceUsers,
  selectedAgent,
  onSelectAgent,
  onAgentProfile,
  canvasGroups,
  canvasObjects,
  workspaceId,
  uploadedFiles,
  onUploadFiles,
  onCreateTask,
  systemCapabilities,
  contextControls,
  onSetActiveSession,
  onSendMessage,
  onOpenThread,
}: {
  session: ChatSession;
  windowTitle: string;
  facts: MemoryFact[];
  documents: Document[];
  agents: WorkspaceAgent[];
  agentConnections: AgentConnection[];
  presenceUsers: WorkspacePresenceUser[];
  selectedAgent: WorkspaceAgent | null;
  onSelectAgent: (agent: WorkspaceAgent | null) => void;
  onAgentProfile: (agentIdOrHandle?: string | null) => void;
  canvasGroups: CanvasGroup[];
  canvasObjects: CanvasObject[];
  workspaceId: string;
  uploadedFiles: UploadedFile[];
  onUploadFiles: (files: File[]) => Promise<UploadedFile[]>;
  onCreateTask: (input: CreateTaskInput) => void;
  systemCapabilities: SystemCapabilities | null;
  contextControls: React.ReactNode;
  onSetActiveSession: (session: ChatSession) => void;
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[], threadParentId?: string | null, targetSession?: ChatSession | null) => void;
  onOpenThread: (messageId: string) => void;
}) {
  const { messages, hasMore, loadingEarlier, loadEarlier } = useSessionMessages(session.id);
  const topLevelMessages = useMemo(() => messages.filter(m => !m.thread_parent_id), [messages]);
  const threadReplyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    messages.forEach(m => {
      if (m.thread_parent_id) counts[m.thread_parent_id] = (counts[m.thread_parent_id] || 0) + 1;
    });
    return counts;
  }, [messages]);

  // Stable references, or the React.memo on ChatWindowContent never hits.
  const handleSendMessage = useCallback(
    (content: string, model: string, mf?: MemoryFact[], docs?: Document[]) => {
      onSetActiveSession(session);
      onSendMessage(content, model, mf, docs, null, session);
    },
    [onSetActiveSession, onSendMessage, session],
  );

  const handleOpenThread = useCallback(
    (messageId: string) => {
      onSetActiveSession(session);
      onOpenThread(messageId);
    },
    [onSetActiveSession, onOpenThread, session],
  );

  return (
    <ChatWindowContent
      messages={messages as never[]}
      topLevelMessages={topLevelMessages}
      threadReplyCounts={threadReplyCounts}
      hasMoreMessages={hasMore}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={loadEarlier}
      streaming={false}
      memoryFacts={facts}
      documents={documents}
      agents={agents}
      agentConnections={agentConnections}
      presenceUsers={presenceUsers}
      selectedAgent={selectedAgent}
      onSelectAgent={onSelectAgent}
      onAgentProfile={onAgentProfile}
      isDirectMessage={isDirectChatSession(session)}
      canvasGroups={canvasGroups}
      canvasObjects={canvasObjects}
      workspaceId={workspaceId}
      uploadedFiles={uploadedFiles}
      onUploadFiles={onUploadFiles}
      onCreateTask={onCreateTask}
      systemCapabilities={systemCapabilities}
      contextControls={contextControls}
      onSendMessage={handleSendMessage}
      onOpenThread={handleOpenThread}
      channelTitle={session.title || windowTitle}
    />
  );
}

function WorkspacePresenceAvatars({
  users,
  getMode,
  onModeChange,
  favoriteIds,
  focusedUserId,
  onToggleFavorite,
  onFocusUser,
  onOpenRemoteWindow,
  onCopyInviteLink,
  onMessageAgent,
}: {
  users: WorkspacePresenceUser[];
  getMode: (id?: string | null) => PresenceVisibilityMode;
  onModeChange: (id: string, mode: PresenceVisibilityMode) => void;
  favoriteIds: string[];
  focusedUserId: string | null;
  onToggleFavorite: (id: string) => void;
  onFocusUser: (id: string | null) => void;
  onOpenRemoteWindow: (win: FloatingWindow) => void;
  onCopyInviteLink?: () => Promise<string | null>;
  onMessageAgent?: (person: WorkspacePresenceUser) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // The trigger pill (measured anchor) and the portaled popover panel. The
  // popover is portaled to document.body because the sidebar clips its own
  // content (overflow-hidden for the rounded corners), so a w-96 panel wider
  // than the sidebar would otherwise get cut off at the edge — same reason the
  // agent status feed portals out (see AgentStatusFeedOverlay in Sidebar.tsx).
  const triggerRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [portalPos, setPortalPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const hoverCloseTimer = useRef<number | null>(null);
  const openOnHover = () => {
    if (hoverCloseTimer.current) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
    setExpanded(true);
  };
  const closeOnHover = () => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = window.setTimeout(() => setExpanded(false), 220);
  };
  useEffect(() => () => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The popover is portaled out of panelRef, so check both the trigger
      // wrapper and the portaled panel before treating a click as "outside".
      const insideTrigger = panelRef.current?.contains(target);
      const insidePopover = portalRef.current?.contains(target);
      if (!insideTrigger && !insidePopover) {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [expanded]);

  // Position the portaled popover off the trigger pill's measured rect. The
  // panel is fixed-positioned over document.body (it can't render inline — the
  // sidebar clips it), anchored so its bottom sits just above the pill and it
  // opens rightward over the canvas, where there's room. Measured before paint
  // and on resize/scroll so it tracks the pill and never flashes clipped.
  useLayoutEffect(() => {
    if (!expanded) {
      setPortalPos(null);
      return;
    }
    const measure = () => {
      const el = triggerRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const left = box.left;
      // w-96 (384px), clamped so it never runs off the right of the viewport.
      const width = Math.min(384, window.innerWidth - left - 16);
      // Grow upward from just above the pill (8px gap, matching the old mb-2).
      const bottom = window.innerHeight - box.top + 8;
      setPortalPos({ left, bottom, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (triggerRef.current) observer.observe(triggerRef.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [expanded]);

  if (users.length === 0) return null;

  const visibleUsers = users.slice(0, 5);
  const overflow = users.length - visibleUsers.length;
  const favorites = users.filter(user => favoriteIds.includes(user.id));
  const focused = users.find(user => user.id === focusedUserId);
  const chipUsers = focused && !favorites.find(user => user.id === focused.id) ? [focused, ...favorites] : favorites;
  const showFocusControls = chipUsers.length > 0 || Boolean(focusedUserId);
  const modeOptions: Array<{ value: PresenceVisibilityMode; label: string }> = [
    { value: 'visible', label: 'Visible' },
    { value: 'dimmed', label: 'Dim' },
    { value: 'hidden', label: 'Muted' },
  ];
  return (
    <div
      ref={panelRef}
      data-presence-panel
      className="relative flex flex-col items-end gap-2"
      onMouseEnter={openOnHover}
      onMouseLeave={closeOnHover}
    >
      {expanded && portalPos && createPortal(
        <div
          ref={portalRef}
          data-presence-popover
          className="fixed z-[9600] overflow-hidden rounded-lg border agensis-glass-panel text-popover-foreground shadow-xl"
          style={{ left: portalPos.left, bottom: portalPos.bottom, width: portalPos.width }}
          onMouseEnter={openOnHover}
          onMouseLeave={closeOnHover}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div>
              <div className="text-sm font-semibold">Shared users and agents</div>
              <div className="text-[11px] text-muted-foreground">View activity, focus a participant, or share your windows</div>
            </div>
            <Badge variant="secondary">{users.length}</Badge>
          </div>
          {onCopyInviteLink && (
            <div className="border-b px-3 py-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={async () => {
                  const url = await onCopyInviteLink();
                  if (url) {
                    setInviteCopied(true);
                    window.setTimeout(() => setInviteCopied(false), 1600);
                  }
                }}
              >
                <Users data-icon="inline-start" className="size-3.5" />
                {inviteCopied ? 'Invite link copied' : 'Copy invite link'}
              </Button>
            </div>
          )}
          <div className="border-b px-3 py-2 text-[11px] text-muted-foreground">
            Non-private open windows appear here as local-open references. Moving, closing, or resizing your copy does not affect theirs.
          </div>
          <div className="max-h-80 overflow-auto p-2">
            {users.map(person => {
              const mode = getMode(person.id);
              const isFavorite = favoriteIds.includes(person.id);
              return (
                <div
                  key={person.id}
                  className={cn(
                    'flex items-start gap-2 rounded-md px-2 py-2',
                    focusedUserId === person.id && 'bg-accent/35',
                  )}
                >
                  <Avatar
                    size="sm"
                    className={cn(
                      mode === 'dimmed' && 'opacity-45 saturate-50',
                      mode === 'hidden' && 'opacity-25 saturate-0',
                    )}
                  >
                    <AvatarFallback className="text-[10px] font-bold">
                      {person.kind === 'agent' ? <Bot className="size-3" /> : (person.name || '?').slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                    {(person.isCurrentUser || person.kind === 'agent') && (
                      <AvatarBadge className={person.kind === 'agent' && person.status === 'busy' ? 'bg-amber-500 animate-pulse' : 'bg-green-500'} />
                    )}
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{person.name}</span>
                      {person.isCurrentUser && <Badge variant="outline">You</Badge>}
                      {person.kind === 'agent' && <Badge variant="secondary">@agent</Badge>}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {person.kind === 'agent'
                        ? person.status === 'busy' ? 'Daemon running' : 'Daemon connected'
                        : person.isCurrentUser ? 'Your workspace view' : mode === 'visible' ? 'Showing activity' : mode === 'dimmed' ? 'Dimmed activity' : 'Muted activity'}
                    </div>
                    {person.activityItems && person.activityItems.length > 0 && (
                      <div className="presence-activity-chips mt-2 flex min-w-0 flex-wrap gap-x-1.5 gap-y-2">
                        {person.activityItems.map(item => (
                          <Badge
                            key={item}
                            variant="secondary"
                            title={item}
                            className="presence-activity-chip min-w-0 max-w-full shrink justify-start text-[10px]"
                          >
                            <span className="min-w-0 truncate">{item}</span>
                          </Badge>
                        ))}
                      </div>
                    )}
                    {!person.isCurrentUser && person.windows && person.windows.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {person.windows.slice(0, 6).map(win => (
                          <Button
                            key={win.id}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-6 max-w-[10rem] px-2 text-[10px]"
                            onClick={() => onOpenRemoteWindow(win)}
                            title={`Open locally: ${win.title}`}
                          >
                            <span className="truncate">{windowLabel(win)}</span>
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex items-center gap-1">
                      {person.kind === 'agent' && onMessageAgent && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-xs"
                          title={`Message ${person.name}`}
                          onClick={() => onMessageAgent(person)}
                        >
                          <MessageSquare />
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant={isFavorite ? 'secondary' : 'outline'}
                        size="icon-xs"
                        title={isFavorite ? 'Remove favorite' : 'Favorite user'}
                        onClick={() => onToggleFavorite(person.id)}
                      >
                        <Star fill={isFavorite ? 'currentColor' : 'none'} />
                      </Button>
                      <Button
                        type="button"
                        variant={focusedUserId === person.id ? 'default' : 'outline'}
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => onFocusUser(focusedUserId === person.id ? null : person.id)}
                      >
                        {focusedUserId === person.id ? 'Viewing' : 'View'}
                      </Button>
                    </div>
                    {!person.isCurrentUser && (
                      <div className="flex items-center gap-1">
                        {modeOptions.map(option => (
                          <Button
                            key={option.value}
                            type="button"
                            variant={mode === option.value ? 'default' : 'outline'}
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => onModeChange(person.id, option.value)}
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
      <div ref={triggerRef} className="presence-top-row order-1 group/presence-row flex items-center gap-1 rounded-full border bg-popover/90 p-1 shadow-md backdrop-blur">
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="presence-avatar-trigger flex items-center rounded-full p-0.5 text-left transition-colors hover:bg-muted/60"
          aria-expanded={expanded}
          aria-label={`${users.length} shared participants`}
          title={`${users.length} shared participants`}
        >
          <AvatarGroup className="presence-avatar-group">
            {visibleUsers.map(person => {
              const mode = getMode(person.id);
              return (
                <Avatar
                  key={person.id}
                  size="sm"
                  title={`${person.name}${person.isCurrentUser ? ' (you)' : ''}`}
                  className={cn(
                    mode === 'dimmed' && 'opacity-45 saturate-50',
                    mode === 'hidden' && 'opacity-25 saturate-0',
                  )}
                >
                  <AvatarFallback className="text-[10px] font-bold">
                    {person.kind === 'agent' ? <Bot className="size-3" /> : (person.name || '?').slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                  {(person.isCurrentUser || person.kind === 'agent') && (
                    <AvatarBadge className={person.kind === 'agent' && person.status === 'busy' ? 'bg-amber-500 animate-pulse' : 'bg-green-500'} />
                  )}
                </Avatar>
              );
            })}
            {overflow > 0 && (
              <AvatarGroupCount title={`${overflow} more users`} className="presence-avatar-overflow size-6 text-[10px]">
                +{overflow}
              </AvatarGroupCount>
            )}
          </AvatarGroup>
        </button>
        {showFocusControls && (
          <>
            <div className="mx-1 h-6 w-px bg-border" aria-hidden />
            <Button
              type="button"
              variant={focusedUserId ? 'outline' : 'default'}
              size="sm"
              className="h-8 rounded-md px-3 text-xs"
              onClick={() => onFocusUser(null)}
            >
              All
            </Button>
            {chipUsers.map(person => (
              <Button
                key={person.id}
                type="button"
                variant={focusedUserId === person.id ? 'default' : 'outline'}
                size="sm"
                className="h-8 max-w-40 rounded-md px-2 text-xs"
                onClick={() => onFocusUser(focusedUserId === person.id ? null : person.id)}
                onDoubleClick={() => onToggleFavorite(person.id)}
                title="Double-click to remove from favorites"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: person.color }}
                />
                <span className="truncate">{person.name}</span>
              </Button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function CanvasGridOverlay({
  layers,
  objects,
  windows,
  activeLayerId,
  backgroundImage,
  onClose,
  onSelectLayer,
  onCreateLayer,
  onDeleteLayer,
  onOpenSettings,
  baseLayerId,
}: {
  layers: CanvasLayer[];
  objects: CanvasObject[];
  windows: FloatingWindow[];
  activeLayerId: string;
  backgroundImage: string;
  onClose: () => void;
  onSelectLayer: (id: string) => void;
  onCreateLayer: () => void;
  onDeleteLayer: (id: string) => void;
  onOpenSettings: (id: string) => void;
  baseLayerId: string;
}) {
  return (
    <div
      onClick={onClose}
      className="absolute inset-0 z-[120] flex items-center justify-center overflow-hidden p-8"
    >
      <img src={backgroundImage} alt="" className="pointer-events-none absolute inset-0 size-full object-cover opacity-20" />
      <div className="pointer-events-none absolute inset-0 bg-[var(--home-bg-overlay)]" />
      <div className="pointer-events-none absolute inset-0 bg-black/10 backdrop-blur-md" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-full w-full max-w-6xl flex-col gap-5"
      >
        <header className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-foreground">All workspaces</h2>
            <p className="text-sm text-muted-foreground">Choose a workspace or create a new one</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenSettings(activeLayerId)}>
              <Settings data-icon="inline-start" className="size-4" />
              Workspace settings
            </Button>
            <Button type="button" onClick={onCreateLayer}>
              <Layers3 data-icon="inline-start" className="size-4" />
              New workspace
            </Button>
          </div>
        </header>

        <ScrollArea className="min-h-0">
          <div className="grid grid-cols-1 gap-4 pb-1 sm:grid-cols-2 lg:grid-cols-4">
            {layers.map(layer => {
              const layerObjects = objects.filter(obj => (obj.layer_id || 'base') === layer.id);
              const layerWindows = windows.filter(win => (win.canvasId || 'base') === layer.id && !win.minimized);
              const isActive = layer.id === activeLayerId;
              const previewCount = Math.min(layerObjects.length, 6);
              return (
                <Card
                  key={layer.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectLayer(layer.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') onSelectLayer(layer.id);
                  }}
                  className={cn(
                    'cursor-pointer shadow-lg transition-colors',
                    isActive && 'border-primary/40 bg-primary/10 ring-1 ring-primary/40',
                  )}
                >
                  <CardContent className="flex flex-col gap-3 p-3">
                    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border bg-gradient-to-b from-card to-muted">
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon-xs"
                        className="absolute top-2 right-2 z-10 bg-popover/90"
                        onClick={e => {
                          e.stopPropagation();
                          onOpenSettings(layer.id);
                        }}
                        title="Workspace settings"
                        aria-label="Workspace settings"
                      >
                        <Settings />
                      </Button>
                      <div className="absolute inset-3 rounded-lg border border-dashed border-border" />
                      <div className="grid h-full grid-cols-3 grid-rows-2 gap-3 p-6">
                        {Array.from({ length: previewCount }).map((_, index) => (
                          <span
                            key={index}
                            className={cn(
                              'self-center rounded-md bg-primary/70',
                              index % 2 === 0 ? 'h-4' : 'h-2',
                              index % 3 === 0 ? 'rounded-full' : 'rounded-md',
                            )}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold text-foreground">{layer.name}</h3>
                        <p className="text-xs text-muted-foreground">
                          {layerObjects.length} items - {layerWindows.length} windows
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {isActive && <Badge variant="secondary">Current</Badge>}
                        {layer.id !== baseLayerId && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            onClick={e => {
                              e.stopPropagation();
                              onDeleteLayer(layer.id);
                            }}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
