import { NewChannelDialog } from './components/chat/NewChannelDialog';
import { DEFAULT_BACKGROUND_OPACITY } from './lib/wallpaperDefaults';
import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { Globe, SquareTerminal, MessageSquare, FileText, Brain, Layers3, CheckCircle2, Activity, Bot, Database, Trash2, Settings, Sparkles, Command, Wrench, Pencil, Plus, Users, Ungroup, Minimize2, Maximize2, ArrowRight, Clock, Inbox, Building2, Zap } from 'lucide-react';
import { useIsMobile } from './hooks/use-mobile';
import { Sidebar } from './components/layout/Sidebar';
import { WorkspaceRail } from './components/layout/WorkspaceRail';
import { NetworkStatusBar } from './components/layout/NetworkStatusBar';
import { HomeCanvas } from './components/home/HomeCanvas';
import { FloatingWindowShell } from './components/windows/FloatingWindowShell';
import { MobileWindowSwitcher } from './components/windows/MobileWindowSwitcher';
import { pickActiveWindowId } from './lib/mobileWindows';
import { computeGroupBounds, computeGroupRole } from './lib/windowGroups';
import { isDesktopShell } from './lib/desktopShell';
import { tipSurfaceFor } from './lib/pageTips';
import { DIRECT_MESSAGES_FOLDER } from './lib/onboardingChecklist';
import { WindowGroupFrame } from './components/windows/WindowGroupFrame';
import { ChatWindowContent } from './components/windows/ChatWindowContent';
import { ChatWindowBody, DocWindowBody, TasksWindowBody } from './components/windows/WindowBodies';
import { channelMessages } from './components/chat/channelView';
import { MemorySection } from './components/memory/MemorySection';
import { SkillsWindowContent } from './components/windows/SkillsWindowContent';
import { countOpenTasks } from './components/windows/taskSchedule';
import { OnboardingTour } from './components/onboarding/OnboardingTour';
import { GetStartedPanel } from './components/onboarding/GetStartedPanel';
import { OwnerMessageDialog } from './components/onboarding/OwnerMessageDialog';
import { OwnerMessageProvider } from './components/onboarding/OwnerMessageProvider';
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
import { FeedbackButton } from './components/feedback/FeedbackButton';
import { NotificationsBell } from './components/notifications/NotificationsBell';
import { Separator } from './components/ui/separator';
import { apiAuthHeaders, apiUrl, getSystemCapabilities, type SystemCapabilities } from './lib/backendClient';
import { Avatar, AvatarFallback, AvatarImage } from './components/ui/avatar';
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
import {
  clampWorkspaceRailWidth,
  pickInitialWorkspaceId,
  readWorkspaceRailWidth,
  WORKSPACE_RAIL_COLLAPSED_WIDTH,
} from './lib/workspaceRail';
import {
  buildDesktopOverlay,
  DESKTOP_TIER_EMPTY_MESSAGE,
  DESKTOP_TIER_PENDING_MESSAGE,
  type OverlayWorkspaceTile,
} from './lib/desktopOverlay';
import {
  clearShowDesktopStash,
  isDrawToolAvailable,
  isShowingDesktop,
  resolveShowDesktop,
  type ShowDesktopStash,
} from './lib/showDesktop';
import { InlineRename } from './components/common/InlineRename';
import { TenantsWindowContent } from './components/tenants/TenantsWindowContent';
import { useTenantAccess } from './hooks/useTenants';
import { writeFailureNotice, type SendOutcome, type WriteFailure } from './lib/writeFeedback';
import { useAuth } from './hooks/useAuth';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useDocuments } from './hooks/useDocuments';
import { useChat, type SendMessageResult } from './hooks/useChat';
import { useWorkspaceBootstrap } from './hooks/useWorkspaceBootstrap';
import { useSubThreads } from './hooks/useSubThreads';
import { useSessionMessages } from './hooks/useSessionMessages';
import { useUserProfile } from './hooks/useUserProfile';
import type { QuotedMessageSource } from './lib/quotedSessionContext';
import { useMemory } from './hooks/useMemory';
import { useFiles } from './hooks/useFiles';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useTheme } from './hooks/useTheme';
import { WindowManagerProvider, useWindowManager } from './providers/WindowManagerProvider';
import { HuddleDockProvider } from './components/huddle/HuddleDockContext';
import { HuddleDock } from './components/huddle/HuddleDock';
import { useItemPresence } from './hooks/useItemPresence';
import { useMultiplayerCursors } from './hooks/useMultiplayerCursors';
import { useSharing } from './hooks/useSharing';
import { useCanvasObjects } from './hooks/useCanvasObjects';
import { useCanvasLayers } from './hooks/useCanvasLayers';
import { useTasks } from './hooks/useTasks';
import { useNostrCommunities } from './hooks/useNostrCommunities';
import type { NostrConnection } from './lib/nostrCommunities';
import { useActivity } from './hooks/useActivity';
import { useInbox } from './hooks/useInbox';
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
import { PresenceRoster } from './components/presence/PresenceRoster';
import type { ChannelParticipant, Document, ChatSession, MemoryFact, Message, MessageAttachment, CanvasGroup, CanvasObject, FloatingWindow, Task, ActivityEvent, WorkspaceAgent, AgentWebhook, PresenceVisibilityMode, Workspace, AgentConnection, UploadedFile } from './types';
import { windowsClosedWithSessions } from './lib/sessionRealtime';
import type { InboxOpenTarget } from './components/inbox/inboxSources';
import type { InboxOpenSession } from './components/inbox/inboxNavigation';
import type { WorkspaceMember } from './hooks/useSharing';
import type { CreateTaskInput } from './hooks/useTasks';

// BUNDLE-03: lazy-load the less-frequently-opened window surfaces so their code
// (and heavy deps) splits out of the main chunk and loads only when a window of
// that type is first opened. ChatWindowContent stays eager — it is the hot path.
// Named exports are adapted to the default-export shape React.lazy expects.
const ActivityWindowContent = lazy(() => import('./components/windows/ActivityWindowContent').then(m => ({ default: m.ActivityWindowContent })));
const AgentsWindowContent = lazy(() => import('./components/windows/AgentsWindowContent').then(m => ({ default: m.AgentsWindowContent })));
const ResourcesWindowContent = lazy(() => import('./components/windows/ResourcesWindowContent').then(m => ({ default: m.ResourcesWindowContent })));
const UsersWindow = lazy(() => import('./components/windows/UsersWindow').then(m => ({ default: m.UsersWindow })));
const SchedulesWindow = lazy(() => import('./components/windows/SchedulesWindow').then(m => ({ default: m.SchedulesWindow })));
const AutomationsWindowContent = lazy(() => import('./components/windows/AutomationsWindowContent').then(m => ({ default: m.AutomationsWindowContent })));
const TerminalPanel = lazy(() => import('./components/windows/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const BrowserPanel = lazy(() => import('./components/windows/BrowserPanel').then(m => ({ default: m.BrowserPanel })));
const InboxWindowContent = lazy(() => import('./components/inbox/InboxWindowContent').then(m => ({ default: m.InboxWindowContent })));

const TOUR_KEY = 'agensis_tour_complete';
const SIDEBAR_KEY = 'agensis_sidebar_collapsed';
const ACTIVE_WORKSPACE_KEY = 'agensis_active_workspace';
const WORKSPACE_RAIL_WIDTH_KEY = 'agensis_workspace_rail_width';
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
  if (type === 'resources') return <Database className="size-4" />;
  if (type === 'browser') return <Globe className="size-4" />;
  if (type === 'terminal') return <SquareTerminal className="size-4" />;
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
  // A sole agent participant only implies a DM when the session is actually a DM
  // (folder 'Direct messages') or the participant is direct-flagged. A one-agent
  // CHANNEL is still a channel — see the matching guard in Sidebar.tsx.
  return agentParticipants.find(participant => participant.direct)
    || (session?.folder === 'Direct messages' && agentParticipants.length === 1 ? agentParticipants[0] : null);
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

// One place for "that write did not happen". Every create/send handler below
// routes its failure through here so a rejected write can never again look like
// a successful one — the reason the app read as a zombie was that these paths
// all ended in a bare `return`.
function reportWriteFailure(action: string, failure: WriteFailure | null) {
  const notice = failure
    ? writeFailureNotice(action, failure)
    : writeFailureNotice(action, {
      kind: 'unknown',
      retryable: true,
      reason: 'Something went wrong and nothing was saved.',
      detail: null,
    });
  toast.error(notice.title, { description: notice.description });
}

export default function App() {
  return (
    <WindowManagerProvider>
      {/* Above AppContent, deliberately: the huddle session must outlive every
          view AppContent renders, or navigating away drops the call — which is
          exactly what it did while the session lived inside the channel. */}
      <HuddleDockProvider>
        <AppContent />
      </HuddleDockProvider>
    </WindowManagerProvider>
  );
}

function AppContent() {
  const {
    user,
    loading: authLoading,
    signIn,
    signUp,
    signOut,
    signInWithOAuth,
    socialAuthProviders,
    authNotice,
    dismissAuthNotice,
  } = useAuth();
  // The update surface (deploy toast + "what's new" dialog + version check +
  // cache-bust reload) is mounted as <AppUpdateManager /> in the tree below.
  // Seeded from the last workspace this browser was in, so a reload lands you
  // back where you were instead of always on workspaces[0]. The stored id is a
  // hint, not a promise — the effect below re-resolves it once the list arrives
  // and falls back to the first workspace if it names one you no longer have.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(
    () => localStorage.getItem(ACTIVE_WORKSPACE_KEY) || '',
  );
  const [showTour, setShowTour] = useState(false);
  // The workspace rail is resizable, and its width is the canvas viewport's
  // leading inset (Sidebar's `leadingInset`), so App owns it rather than the
  // rail — a width kept private to the rail would leave every floating window
  // positioned against the old one. The rail commits once per drag, on release.
  const [workspaceRailWidth, setWorkspaceRailWidth] = useState(
    () => readWorkspaceRailWidth(localStorage.getItem(WORKSPACE_RAIL_WIDTH_KEY)),
  );
  const handleWorkspaceRailWidthChange = useCallback((next: number) => {
    const clamped = clampWorkspaceRailWidth(next);
    setWorkspaceRailWidth(clamped);
    localStorage.setItem(WORKSPACE_RAIL_WIDTH_KEY, String(clamped));
  }, []);
  const isMobile = useIsMobile();
  // Phone: the rail rides inside the off-canvas drawer beside a full-width
  // sidebar, so it stays the icon strip whatever width was saved on desktop.
  const renderedRailWidth = isMobile ? WORKSPACE_RAIL_COLLAPSED_WIDTH : workspaceRailWidth;
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

  const { workspaces, loading: wsLoading, createWorkspace, updateWorkspace, readiness: workspaceReadiness, retryWorkspaceSetup } = useWorkspaces(user?.id);
  // NOT simply workspaces[0]. The list is ordered by updated_at, so the newest
  // workspace sorts first — and the System workspace (the feedback inbox) sorts
  // first the moment it is created. Neither an empty starter pair nor the
  // feedback inbox is somewhere you should LAND; they are places you go on
  // purpose. Prefer a workspace that actually has something in it.
  const defaultWorkspace = useMemo(
    () => workspaces.find(w => !w.is_system) || workspaces[0] || null,
    [workspaces],
  );
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId) || defaultWorkspace;
  const {
    connections: nostrConnections,
    resolved: nostrConnectionsResolved,
    error: nostrConnectionsError,
    refetch: refetchNostrCommunities,
  } = useNostrCommunities(activeWorkspace?.id || null);

  useEffect(() => {
    if (wsLoading || workspaces.length === 0) return;
    // One picker, tested in workspaceRail.ts: keep the id you were in if it
    // still exists, else the first NON-SYSTEM workspace. Two competing copies of
    // this rule is how you get an app that disagrees with its own sidebar.
    const resolved = pickInitialWorkspaceId(activeWorkspaceId, workspaces);
    if (resolved && resolved !== activeWorkspaceId) setActiveWorkspaceId(resolved);
  }, [wsLoading, workspaces, activeWorkspaceId]);

  // Remember the switch. Only writes ids that resolved to a real workspace —
  // the '' bootstrap value would otherwise stomp a perfectly good stored id on
  // every cold load, before the list has come back.
  useEffect(() => {
    if (activeWorkspaceId) localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
  }, [activeWorkspaceId]);

  const { data: workspaceBootstrap } = useWorkspaceBootstrap(activeWorkspaceId || null);

  const {
    documents, recents,
    createDocument, saveDocument, autoSave, deleteDocument, toggleFavorite, fetchDocumentContent
  } = useDocuments(activeWorkspaceId, (workspaceBootstrap?.documents as import('./types').Document[] | undefined) || null);

  const {
    sessions, closedSessionIds, activeSession, setActiveSession, messages, streaming,
    hasMoreMessages, loadingEarlier, loadEarlierMessages,
    topLevelMessages, threadMessages, threadReplyCounts, activeThreadId,
    openThread, closeThread,
    createSession, splitSession, escalateSessionToChannel, updateSession, patchSessionLocal, archiveSession, sendMessage, deleteSession, closeAndClearSession, mergeSession,
  } = useChat(
    activeWorkspaceId,
    user?.email?.split('@')[0] || undefined,
    (workspaceBootstrap?.sessions as import('./types').ChatSession[] | undefined) || null,
    user?.id,
  );

  const {
    subThreadsByMessage,
    activeSubThread,
    activeSubThreadHostSessionId,
    subThreadMessages,
    subThreadHasMore,
    subThreadLoadingEarlier,
    loadEarlierSubThreadMessages,
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
  const { online, syncing, pendingCount, syncError, flushQueue, clearPendingQueue } = useNetworkStatus(user?.id ?? null);
  const { mode: themeMode, setTheme } = useTheme();

  useEffect(() => {
    const settings = getSettings();
    applyUiAppearanceSettings(settings);
    applyThemePreset(settings.ui_theme_preset);
    // Seed the persisted neo theme so it's ready when the neo family activates.
    applyNeoTheme(settings.ui_neo_theme);
  }, []);
  const { layers, layersWorkspaceId, activeLayer, activeLayerId, createLayer, activateLayer, deleteLayer, updateLayer, baseLayerId } = useCanvasLayers(activeWorkspaceId || null);

  // The server answers whether this account may see Tenants. Never inferred
  // from the signed-in email client-side — the browser can be told anything,
  // and the routes re-check regardless. Keyed on the user id rather than a
  // boolean, so switching account re-asks instead of carrying the previous
  // answer over.
  const { isOwner: isSystemOwner } = useTenantAccess(user?.id ?? null);

  // Rename. Both return false on a rejected write so the inline editor stays
  // open and says so, rather than closing over a change that never landed.
  const handleRenameWorkspace = useCallback(async (id: string, name: string) => {
    const { workspace } = await updateWorkspace(id, { name });
    return Boolean(workspace);
  }, [updateWorkspace]);

  const handleRenameDesktop = useCallback((id: string, name: string) => {
    updateLayer(id, { name });
    return true;
  }, [updateLayer]);

  const {
    windows,
    openWindow,
    openSessionBeside,
    openSplitWindow,
    closeWindow,
    closeAllWindows,
    focusWindow,
    updateWindow,
    minimizeWindow,
    setWindowsMinimized,
    focusWindowGroup,
    minimizeWindowGroup,
    ungroupTiledWindows,
    viewMode,
  } = useWindowManager();
  const canvasRef = useRef<HTMLElement>(null);

  // A server-scoped chat_sessions close removes the canonical session first;
  // close every matching floating window too so an inactive composer cannot
  // promote a stale session and fail only after the person presses Send.
  useEffect(() => {
    if (closedSessionIds.length === 0) return;
    for (const windowId of windowsClosedWithSessions(windows, closedSessionIds)) {
      closeWindow(windowId);
    }
  }, [closedSessionIds, windows, closeWindow]);

  // Which windows the "Show desktop" sidebar row put away, per desktop. In
  // memory alongside the windows themselves — a stash that outlived a reload
  // would name ids that no longer exist. See src/lib/showDesktop.ts.
  const [showDesktopStash, setShowDesktopStash] = useState<ShowDesktopStash>({});

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
      // Show desktop's stash is keyed by desktop id, and 'base' is every
      // workspace's default — so ids stashed against the outgoing workspace
      // would name the incoming one's desktop. Nothing survives the switch.
      setShowDesktopStash(clearShowDesktopStash());
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
  // The Agents window only needs to know whether to close its form; the toast
  // carries the reason.
  const handleCreateAgent = useCallback(async (input: CreateAgentInput): Promise<boolean> => {
    const { agent, failure } = await createAgent(input);
    if (!agent) {
      reportWriteFailure('create the agent', failure);
      return false;
    }
    return true;
  }, [createAgent]);

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

  // Sidebar badge only — the unfiltered count of things waiting on a human. The
  // inbox window runs its own useInbox with the tab the user picked. `agents` is
  // passed so a pending approval counts (and is named) here exactly as it is in
  // the window; a badge that ignored parked tool calls would be silent about the
  // one thing in the inbox that expires.
  const { unreadCount: inboxUnreadCount } = useInbox(activeWorkspaceId || null, 'all', agents);

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
  const workspaceBackdropOpacity = Math.min(1, Math.max(0, viewedLayer.background_opacity ?? activeWorkspace?.background_opacity ?? DEFAULT_BACKGROUND_OPACITY));
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
  // Draw belongs to the DESKTOP: it paints on the canvas behind the panels, so
  // it is only offered when the desktop is what you are looking at. See
  // isDrawToolAvailable in src/lib/showDesktop.ts.
  const drawToolAvailable = isDrawToolAvailable(windows, activeLayerId, drawingActive);
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
  // Which surface the sidebar-footer panel gives advice about. This is a
  // windowed desktop, so there is no route to read: the answer is the focused
  // window, which is `focusedDockWindow` above — the top non-minimized window
  // ON THE ACTIVE PROJECT, focus being encoded as zIndex. A window parked on
  // another project is not on screen and must not claim the panel; nothing open
  // means the canvas itself. Tenants used to be an overlay passed separately;
  // it is a window now, so it resolves through focusedWindowType like the rest
  // and needs no special case.
  const tipSurface = useMemo(() => tipSurfaceFor({
    overlay: null,
    focusedWindowType: focusedDockWindow?.type ?? null,
    isDirectMessage: focusedDockWindow?.type === 'chat'
      && sessions.find(item => item.id === focusedDockWindow.sessionId)?.folder === DIRECT_MESSAGES_FOLDER,
  }), [focusedDockWindow, sessions]);
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
      background_opacity: settingsLayer.background_opacity ?? activeWorkspace.background_opacity ?? DEFAULT_BACKGROUND_OPACITY,
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

  // The "+" beside Channels opens the template gallery rather than creating a
  // channel outright. Creation still happens here, once a template is picked.
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [managedNostrConnectionId, setManagedNostrConnectionId] = useState<string | null>(null);
  const managedNostrConnection = nostrConnections.find(connection => connection.id === managedNostrConnectionId) || null;
  const handleNewChat = useCallback(() => {
    setManagedNostrConnectionId(null);
    setNewChannelOpen(true);
  }, []);
  const handleManageNostrCommunity = useCallback((connection: NostrConnection) => {
    setManagedNostrConnectionId(connection.id);
    setNewChannelOpen(true);
  }, []);
  const handleNewChannelOpenChange = useCallback((open: boolean) => {
    setNewChannelOpen(open);
    if (!open) setManagedNostrConnectionId(null);
  }, []);

  // RETURNS the created session. BridgeSetup reads `.id` off this to attach a
  // transport to the channel it just made — it always did, but this function
  // returned undefined on every path, so that read was against a value that did
  // not exist and the bridge failed with "its id came back empty". Returning the
  // row is the fix, not a convenience.
  const createChannelFromTemplate = useCallback(async (draft: {
    title: string; icon: string; description: string; intent: string; conversation_mode: string;
    participants?: import('./types').ChannelParticipant[];
  }) => {
    const { session, failure } = await createSession('auto', {
      canvas_id: activeLayerId,
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.icon ? { icon: draft.icon } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.intent ? { intent: draft.intent } : {}),
      // Only when there ARE any: an empty array and an absent key mean the same
      // thing to the roster, and sending the key on every create would overwrite
      // nothing while adding a column to every insert.
      ...(draft.participants?.length ? { participants: draft.participants } : {}),
      conversation_mode: draft.conversation_mode,
    } as Partial<import('./types').ChatSession>);
    if (!session) {
      reportWriteFailure('create the channel', failure);
      return null;
    }
    openWindow('chat', { title: session.title || 'Untitled', sessionId: session.id, canvasId: activeLayerId, ownerUserId: user?.id });
    logEvent({
      event_type: 'chat_created',
      entity_type: 'chat',
      entity_id: session.id,
      title: `New chat: ${session.title || 'Untitled'}`,
    });
    return session;
  }, [createSession, openWindow, activeLayerId, user?.id, logEvent]);

  const handleNewDocument = useCallback(async () => {
    const doc = await createDocument();
    if (!doc) {
      // createDocument has no error channel of its own; the honest thing to say
      // is that it did not happen, not to silently do nothing.
      reportWriteFailure('create the document', null);
      return;
    }
    openWindow('document', { title: doc.title || 'Untitled', documentId: doc.id, canvasId: activeLayerId, ownerUserId: user?.id });
    logEvent({
      event_type: 'document_created',
      entity_type: 'document',
      entity_id: doc.id,
      title: `New document: ${doc.title || 'Untitled'}`,
    });
  }, [createDocument, openWindow, activeLayerId, user?.id, logEvent]);

  // Tenants is a WINDOW, not a full-screen overlay. It used to render as
  // `absolute inset-0` at modal z-index over the whole workspace, so opening it
  // took the entire surface and nothing else could be reached — unlike every
  // other view, which the window manager owns. Same open-or-focus shape as the
  // rest, so it minimises to the dock, tiles, and closes like anything else.
  const handleOpenTenants = useCallback(() => {
    const existing = windows.find(w => w.type === 'tenants');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('tenants', { title: 'Tenants', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenBrowser = useCallback(() => {
    const count = windows.filter(w => w.type === 'browser').length;
    openWindow('browser', {
      title: count === 0 ? 'Browser' : `Browser ${count + 1}`,
      canvasId: activeLayerId,
      ownerUserId: user?.id,
    });
  }, [windows, openWindow, activeLayerId, user?.id]);

  // Probed once per mount: the shell cannot change under a running page, and a
  // fresh probe per render would create a throwaway <webview> element each time.
  const [desktopShell] = useState(isDesktopShell);

  // Terminals and browsers are NOT singletons like the other window types — you
  // want several open at once, each with its own shell or page. Every press
  // opens a new one; the number keeps the dock and window switcher readable.
  const handleOpenTerminal = useCallback(() => {
    const count = windows.filter(w => w.type === 'terminal').length;
    openWindow('terminal', {
      title: count === 0 ? 'Terminal' : `Terminal ${count + 1}`,
      canvasId: activeLayerId,
      ownerUserId: user?.id,
    });
  }, [windows, openWindow, activeLayerId, user?.id]);

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

  const handleOpenInbox = useCallback(() => {
    const existing = windows.find(w => w.type === 'inbox');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('inbox', { title: 'Inbox', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  // Show desktop: put this desktop's open panels away so the wallpaper and the
  // home composer are all that's left, and bring them back on the next press.
  // Minimise, never close — the windows stay in the dock with their state.
  const handleShowDesktop = useCallback(() => {
    const decision = resolveShowDesktop(windows, activeLayerId, showDesktopStash);
    setShowDesktopStash(decision.stash);
    if (decision.action === 'none') return;
    setWindowsMinimized(decision.windowIds, decision.action === 'hide');
  }, [windows, activeLayerId, showDesktopStash, setWindowsMinimized]);

  const showingDesktop = isShowingDesktop(windows, activeLayerId, showDesktopStash);

  const handleOpenUsers = useCallback(() => {
    const existing = windows.find(w => w.type === 'users');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('users', { title: 'Users', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenResources = useCallback(() => {
    const existing = windows.find(w => w.type === 'resources');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('resources', { title: 'Shared Resources', canvasId: activeLayerId, ownerUserId: user?.id });
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

  const handleOpenAutomations = useCallback(() => {
    const existing = windows.find(w => w.type === 'automations');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('automations', { title: 'Automations', canvasId: activeLayerId, ownerUserId: user?.id });
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

  // Quick "copy invite link" used by the presence popup. This is the SAME
  // short-lived, single-use URL for a person or an agent; the join page chooses
  // the correct instructions without User-Agent sniffing.
  const handleCopyInviteLink = useCallback(async (): Promise<string | null> => {
    if (!activeWorkspaceId) return null;
    try {
      const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(activeWorkspaceId)}/join-links`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ role: 'editor', audience: 'both', label: 'Quick invite' }),
      });
      const payload = await res.json().catch(() => null);
      const url = typeof payload?.data?.url === 'string' ? payload.data.url : '';
      if (!res.ok || !url) return null;
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

  // The human half of a JOIN LINK (the single short-lived invite URL that serves
  // people and agents alike). /join/<token> is a server-rendered page on the
  // backend; its "Sign in and join" button lands here as ?join=<token>, and this
  // redeems it with the signed-in user's own session token.
  //
  // Why a second effect rather than folding it into the ?invite= one above: they
  // hit different endpoints with different lifetimes and different failure
  // semantics. A join link is single-use and expires in minutes, so "it did not
  // work" is a NORMAL outcome — and the ?invite= handler's unconditional reload
  // would wipe the message explaining it off the screen before anyone read it.
  // So the two paths diverge: success reloads (to pick up the new workspace),
  // failure stays put and says why.
  //
  // Either way the token leaves the URL immediately, so it never lands in a
  // bookmark, the back button, or a screenshot of the address bar.
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('join');
    if (!token) return;
    params.delete('join');
    const qs = params.toString();
    const cleanUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    (async () => {
      let joined = false;
      try {
        const res = await fetch(apiUrl(`/backend/join/${encodeURIComponent(token)}/redeem`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({ as: 'human' }),
        });
        joined = res.ok;
      } catch {
        joined = false;
      }
      if (joined) {
        window.location.replace(cleanUrl);
        return;
      }
      // Strip the token without a navigation, so the toast survives to be read.
      window.history.replaceState(null, '', cleanUrl);
      // Expired, already used, withdrawn, or never valid — the server refuses
      // all four identically, so there is one message here too. Saying which
      // would answer "did this link ever exist?" for anyone willing to ask.
      toast.error('That join link is no longer valid', {
        description: 'It may have expired, been used, or been withdrawn. Ask whoever sent it for a new one.',
      });
    })();
  }, [user]);

  // A channel edited its own row (title, icon, description, intent,
  // participants). The window that saved it updates its own header, but the
  // SIDEBAR reads this session list — so a rename showed in the header and
  // nowhere else until a reload. updateSession already patches both the list
  // and the active session; this just routes the save into it. No second write:
  // the row is already saved, so only the local list is patched.
  const handleSessionMetaSaved = useCallback((sessionId: string, patch: Record<string, unknown>) => {
    patchSessionLocal(sessionId, patch as Partial<import('./types').ChatSession>);
  }, [patchSessionLocal]);

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

  // Inbox rows carry a session id, not a session — resolve and open it so
  // "go read it where it happened" is one click from the triage list.
  const handleSessionOpenById = useCallback((sessionId: string) => {
    const session = sessions.find(item => item.id === sessionId);
    if (session) handleSessionOpen(session);
  }, [sessions, handleSessionOpen]);

  /**
   * An inbox row: open the conversation BESIDE the inbox, focused on the part
   * the row was about.
   *
   * Both halves matter and they are separate mechanisms. `openSessionBeside`
   * tiles the chat against the inbox window (falling back to a normal open when
   * there is nothing to tile against), and `openThread` points the chat's thread
   * panel at the reply — without it the reader lands at the bottom of a channel
   * with the message they came for somewhere up the scrollback, which is the
   * whole complaint. Same pair of steps the sidebar's thread rows already use.
   */
  const handleOpenInboxItem = useCallback((target: InboxOpenTarget & { beside?: boolean }) => {
    const session = sessions.find(item => item.id === target.sessionId);
    if (!session) {
      // Never a silent no-op: a row that does nothing when clicked reads as a
      // broken inbox, and "the conversation is gone" is a real answer.
      toast.error('That conversation is no longer in this workspace.');
      return;
    }
    setActiveSession(session);
    const opts = {
      title: session.title,
      sessionId: session.id,
      canvasId: activeLayerId,
      ownerUserId: user?.id,
    };
    if (target.beside) openSessionBeside('inbox', opts);
    else openWindow('chat', opts);
    // Closing on the way through matters as much as opening: a thread left over
    // from the previous row would still be on screen next to a message it has
    // nothing to do with.
    if (target.threadParentId) openThread(target.threadParentId);
    else closeThread();
  }, [sessions, setActiveSession, openSessionBeside, openWindow, openThread, closeThread, activeLayerId, user?.id]);

  // A sidebar thread row: open the session it lives in, then focus the thread
  // itself. Both steps are needed — opening only the session drops the person
  // into a channel with the reply they came for somewhere up the scrollback.
  const handleOpenThreadFromSidebar = useCallback((sessionId: string, parentMessageId: string) => {
    const session = sessions.find(item => item.id === sessionId);
    if (!session) return;
    handleSessionOpen(session);
    openThread(parentMessageId);
  }, [sessions, handleSessionOpen, openThread]);

  const handleSplitThread = useCallback(async (source: ChatSession) => {
    const pending = toast.loading(`Splitting “${source.title || 'thread'}”…`);
    const forked = await splitSession(source);
    if (!forked) {
      toast.error('Split failed — try again', { id: pending });
      return;
    }
    toast.success(`Split created — “${forked.title}” added under its parent`, { id: pending });
    // Split is a point-in-time duplicate: the source keeps the live session
    // slot (and any in-flight job), while the fork opens through ChatWindowBody
    // as its own non-active session so it never borrows the source's streaming
    // state or looks like it is still processing.
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

  // "Escalate" a thread: carry its transcript as explicit quoted context into
  // an EXISTING channel so a
  // conversation stranded in a DM (no share/save/hand-off path — see the
  // thread-escalation gap) lands somewhere a team can pick it up. Unlike
  // split, this never creates a new session — it opens the target channel the
  // human already chose so they land straight on the imported context.
  const handleEscalateToChannel = useCallback(async (source: ChatSession, targetChannelId: string) => {
    const target = sessions.find(item => item.id === targetChannelId);
    const pending = toast.loading(`Escalating “${source.title || 'thread'}” to ${target?.title || 'channel'}…`);
    const ok = await escalateSessionToChannel(source, targetChannelId);
    if (!ok) {
      toast.error('Escalate failed — try again', { id: pending });
      return;
    }
    toast.success(`Context added to “${target?.title || 'channel'}”`, { id: pending });
    if (target) handleSessionOpen(target);
  }, [sessions, escalateSessionToChannel, handleSessionOpen]);

  // "Hand off" a thread to a different agent: find (or start) a DM with that
  // agent, carry the source transcript in as quoted context, then actually
  // send a message so the agent is dispatched and picks it up — a hand-off
  // that just carried text and left it sitting unread would be no better than
  // the "no options offered at all" gap this replaces.
  const handleHandOffToAgent = useCallback(async (
    source: ChatSession,
    agent: { id: string; name: string; handle: string | null },
  ) => {
    const handle = agent.handle?.trim().replace(/^@+/, '') || '';
    const title = agent.name?.trim() || (handle ? `@${handle}` : 'Agent');
    const pending = toast.loading(`Handing “${source.title || 'thread'}” to ${title}…`);

    let target = sessions.find(session => !session.archived_at && isDirectSessionForAgent(session, agent.id, handle));
    if (!target) {
      const participant: ChannelParticipant = {
        id: `agent:${agent.id}`,
        kind: 'agent',
        name: title,
        handle: handle || null,
        agent_id: agent.id,
        user_id: null,
        status: null,
        direct: true,
        added_at: new Date().toISOString(),
      };
      const { session, failure } = await createSession('auto', {
        title,
        folder: 'Direct messages',
        conversation_mode: 'auto',
        participants: [participant],
      });
      if (!session) {
        toast.error(`Couldn't start a conversation with ${title}`, { id: pending });
        reportWriteFailure(`open a conversation with ${title}`, failure);
        return;
      }
      target = session;
    }

    const contextAdded = await escalateSessionToChannel(source, target.id);
    if (!contextAdded) {
      toast.error('Hand-off failed — try again', { id: pending });
      return;
    }

    await sendMessage(
      `This thread was handed to you from “${source.title || 'a DM'}”. The context above is what was said before you joined — please pick it up.`,
      'auto',
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      target,
    );

    toast.success(`Handed off to ${title}`, { id: pending });
    handleSessionOpen(target);
    openWindow('chat', { title, sessionId: target.id, canvasId: activeLayerId, ownerUserId: user?.id });
    logEvent({
      event_type: 'chat_created',
      entity_type: 'chat',
      entity_id: target.id,
      title: `Handed off thread to ${title}`,
    });
  }, [sessions, createSession, escalateSessionToChannel, sendMessage, handleSessionOpen, openWindow, activeLayerId, user?.id, logEvent]);

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
    if (result.status === 'pending') {
      toast.success('Synthesis started — the split stays available until the combined reply is saved', { id: pending });
      return;
    }
    toast.success('Merged — reconciling both branches into the parent', { id: pending });
  }, [mergeSession, handleSessionOpen]);

  const handleDeleteSession = useCallback((id: string) => {
    const session = sessions.find(item => item.id === id);
    const title = session?.title || 'conversation';
    setConfirmAction({
      title: `Close “${title}”?`,
      description: 'The conversation leaves your sidebar. You can open it again from history if it is still available.',
      actionLabel: 'Close conversation',
      onConfirm: async () => {
        const pending = toast.loading(`Closing “${title}”…`);
        if (!await deleteSession(id)) {
          toast.error('Close failed — your access may have changed', { id: pending });
          return;
        }
        toast.success('Conversation closed', { id: pending });
      },
    });
  }, [deleteSession, sessions]);

  // Delete a DM conversation: soft-delete all its messages, close (soft-delete)
  // the session, and close any open chat window pointing at it — "close the
  // thread" has to shut the actual window, not just drop the sidebar row, or the
  // user is left staring at a dead/empty chat pane. Everything is soft-deleted;
  // the data is retained for later use. Confirm first — one-click was too easy
  // to mis-tap on the highest-traffic chrome.
  const handleDeleteDm = useCallback((session: ChatSession) => {
    const title = session.title || 'conversation';
    setConfirmAction({
      title: `Delete “${title}”?`,
      description: 'This removes the conversation from your view and closes any open window for it. The data is soft-deleted, not hard-wiped.',
      actionLabel: 'Delete conversation',
      onConfirm: async () => {
        const pending = toast.loading(`Deleting “${title}”…`);
        const deleted = await closeAndClearSession(session.id);
        if (!deleted) {
          toast.error('Delete failed — workspace manager permission is required', { id: pending });
          return;
        }
        windows.filter(w => w.sessionId === session.id).forEach(w => closeWindow(w.id));
        toast.success('Conversation deleted and closed', { id: pending });
      },
    });
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
    const { session, failure } = await createSession('auto', {
      title,
      folder: 'Direct messages',
      conversation_mode: 'auto',
      participants: [participant],
    });
    if (!session) {
      reportWriteFailure(`open a conversation with ${title}`, failure);
      return;
    }
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
    else if (win.type === 'resources') handleOpenResources();
    else if (win.type === 'inbox') handleOpenInbox();
    else if (win.type === 'schedules') handleOpenSchedules();
    else if (win.type === 'automations') handleOpenAutomations();
  }, [documents, handleDocumentOpen, handleOpenActivity, handleOpenAgents, handleOpenAutomations, handleOpenInbox, handleOpenMemory, handleOpenResources, handleOpenSchedules, handleOpenSkills, handleOpenTasks, handleSessionOpen, sessions]);

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
    // Thread composer's "Send to channel" switch (messages.broadcast_to_channel).
    broadcastToChannel?: boolean,
    // Structured uploaded-file references for rendering (messages.attachments).
    // The agent's view of an attachment is still the "[Linked files]" text the
    // composer folded into `content`.
    attachments?: MessageAttachment[],
  ) => {
    const snapshot = useWorkspaceCtx ? buildWorkspaceContext() : null;
    // The result travels back to whichever composer called this: `delivered:
    // false` means the row was rolled back, so that composer must put the
    // user's text back instead of leaving them with an empty box.
    return sendMessage(content, model, memFacts, docs, snapshot, selectedAgent, threadParentId, targetSession, broadcastToChannel, attachments);
  }, [sendMessage, useWorkspaceCtx, buildWorkspaceContext, selectedAgent]);

  const handleCreateCustomApplet = useCallback(async () => {
    const { session, failure } = await createSession('auto', { canvas_id: activeLayerId });
    if (!session) {
      reportWriteFailure('start the applet chat', failure);
      return;
    }

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
  ): Promise<boolean> => {
    // The home composer has no transcript to fall back on: if the channel is
    // never created there is nowhere for the message to appear, which is why
    // this used to swallow the user's text whole. Report false and the composer
    // keeps the draft.
    const { session, failure } = await createSession('auto', { canvas_id: activeLayerId });
    if (!session) {
      reportWriteFailure('start the channel', failure);
      return false;
    }
    openWindow('chat', { title: content.slice(0, 30) || 'New Channel', sessionId: session.id, canvasId: activeLayerId, ownerUserId: user?.id });
    setTimeout(() => {
      wrappedSendMessage(content, model, memFacts, docs, null, session);
    }, 100);
    return true;
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
    const { workspace, failure } = await createWorkspace(name.trim(), icon.trim() || '🗂️', description.trim());
    if (!workspace) {
      // Leave the dialog open with what was typed still in it. Closing it on a
      // rejected insert is the version of this bug that loses the most work.
      reportWriteFailure('create the workspace', failure);
      return;
    }
    setActiveWorkspaceId(workspace.id);
    setCreateWorkspaceDialogOpen(false);
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
  const handleCreateSubThreadFromScene = useCallback(async (
    messageId: string,
    agent: WorkspaceAgent,
    sourceContext?: QuotedMessageSource,
  ) => {
    const slug = agent.handle || agent.name.toLowerCase().replace(/\s+/g, '-');
    const created = await createSubThread(messageId, slug, agent.id, agent.name, {
      sourceContext,
    });
    if (!created) {
      toast.error(`Could not delegate this message to ${agent.name}. Nothing was started.`);
      return;
    }
    toast.success(`Delegated to ${agent.name}.`);
    // Background task — don't open the sub-thread panel; let it run autonomously.
    // The user can view it from the Threads panel.
  }, [createSubThread]);
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
  const handleSidebarUploadFile = useCallback((files: File[]) => uploadFiles(files), [uploadFiles]);
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
        <AuthPage
          onSignIn={signIn}
          onSignUp={signUp}
          onOAuthSignIn={signInWithOAuth}
          socialAuthProviders={socialAuthProviders}
          notice={authNotice}
          onDismissNotice={dismissAuthNotice}
        />
        <AppUpdateManager swOnly />
      </>
    );
  }

  return (
    <TooltipProvider>
      {/* Owner broadcasts: ONE fetch here, consumed by all three surfaces (the
          sidebar-footer card, the dialog below, the home banner). Inside the
          signed-in branch because the messages are addressed to this account —
          there is nothing to fetch for a logged-out visitor. */}
      <OwnerMessageProvider userId={user.id}>
      <div className="relative flex h-screen overflow-hidden bg-background">
        <img
          src={workspaceBackdropImage}
          alt=""
          className="pointer-events-none absolute inset-0 z-[var(--z-backdrop)] size-full object-cover"
          style={{ opacity: workspaceBackdropOpacity }}
        />
        <div className="pointer-events-none absolute inset-0 z-[var(--z-backdrop)] bg-[var(--home-bg-overlay)]" style={{ opacity: workspaceBackdropOverlayOpacity }} />
        <div
          className={cn(
            isMobile
              ? cn(
                'fixed inset-y-0 left-0 z-[var(--z-drawer)] flex transition-transform duration-200 ease-out',
                mobileDrawerOpen ? 'translate-x-0' : 'pointer-events-none -translate-x-full',
              )
              : 'contents',
          )}
          style={isMobile ? { padding: WORKSPACE_CHROME_GAP } : undefined}
        >
          {/* Workspace switcher, pinned outside the sidebar. On desktop the
              wrapper is `contents`, so this is a direct flex child of the shell
              row and lands at the far left; on phone it rides inside the
              off-canvas drawer beside the sidebar rather than eating screen
              width the canvas needs. */}
          <WorkspaceRail
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={setActiveWorkspaceId}
            onRenameWorkspace={handleRenameWorkspace}
            onOpenTenants={isSystemOwner ? handleOpenTenants : undefined}
            onCreateWorkspace={handleCreateWorkspace}
            loading={wsLoading || workspaceReadiness.status === 'missing' || workspaceReadiness.status === 'preparing'}
            loadError={workspaceReadiness.status === 'unavailable' ? workspaceReadiness.reason : null}
            onRetry={workspaceReadiness.canRetry ? retryWorkspaceSetup : undefined}
            titlebarInset={isMobile ? 0 : DESKTOP_TITLEBAR_INSET}
            // Phone: the rail rides inside the off-canvas drawer beside a
            // full sidebar, so it stays the icon strip and is not resizable.
            width={renderedRailWidth}
            onWidthChange={handleWorkspaceRailWidthChange}
            resizable={!isMobile}
          />
          <Sidebar
            workspace={activeWorkspace}
            activeLayerName={viewedLayer.name || activeWorkspace?.name || 'Personal'}
            overlay={isMobile}
            titlebarInset={isMobile ? 0 : DESKTOP_TITLEBAR_INSET}
            // The rail sits left of the sidebar, so the canvas viewport's left
            // inset is rail + sidebar, not sidebar alone. The rail is resizable,
            // so this is its LIVE width, never the 52px collapsed constant.
            leadingInset={isMobile ? 0 : renderedRailWidth}
            collapsed={isMobile ? false : sidebarCollapsed}
            onToggleCollapse={isMobile ? handleCloseMobileDrawer : handleToggleSidebar}
            onOpenCommandPalette={handleOpenCommandPalette}
            onOpenWorkspaceGrid={handleOpenCanvasGrid}
            onNewChat={handleNewChat}
            nostrConnections={nostrConnections}
            nostrConnectionsResolved={nostrConnectionsResolved}
            nostrConnectionsError={nostrConnectionsError}
            onRetryNostrConnections={() => { void refetchNostrCommunities(); }}
            onManageNostrCommunity={handleManageNostrCommunity}
            onNewDocument={handleNewDocument}
            onUploadFile={handleSidebarUploadFile}
            onCreateWorkspace={handleCreateWorkspace}
            onDocumentOpen={handleDocumentOpen}
            onDocumentUpdate={saveDocument}
            onAddToCanvasApplet={handleCreateDocApp}
            onSessionOpen={handleSessionOpen}
            activeSessionId={activeSession?.id ?? null}
            onSessionUpdate={updateSession}
            onSessionArchive={archiveSession}
            onSessionDelete={handleDeleteSession}
            onDirectMessageDelete={handleDeleteDm}
            onSessionSplit={handleSplitThread}
            onSessionMerge={handleMergeThread}
            onSessionEscalateToChannel={handleEscalateToChannel}
            onSessionEscalateToAgent={handleHandOffToAgent}
            onOpenInbox={handleOpenInbox}
            onShowDesktop={handleShowDesktop}
            showingDesktop={showingDesktop}
            onOpenThread={handleOpenThreadFromSidebar}
            onOpenMemory={handleOpenMemory}
            onOpenSkills={handleOpenSkills}
            onOpenTasks={handleOpenTasks}
            onOpenActivity={handleOpenActivity}
            onOpenAgents={handleOpenAgents}
            onOpenResources={handleOpenResources}
            onOpenUsers={handleOpenUsers}
            onOpenSchedules={handleOpenSchedules}
            onOpenAutomations={handleOpenAutomations}
            onAgentMessage={handleAgentDirectMessage}
            onAgentProfile={handleSidebarAgentProfile}
            onOpenTemplates={handleOpenTemplates}
            // Desktop only. The terminal has no web transport at all — a browser
            // tab cannot open a shell — and the browser panel is desktop-first,
            // so neither is offered in a web tab. Both sidebar surfaces (the rail
            // button and the action tile) already render only when their handler
            // is present, so withholding it hides both.
            onOpenBrowser={desktopShell ? handleOpenBrowser : undefined}
            onOpenTerminal={desktopShell ? handleOpenTerminal : undefined}
            openTaskCount={
              // countOpenTasks, NOT useTasks' openTasks: that list includes
              // subtasks, which are not rows in the Tasks window, so the badge
              // counted work the list could not show. It also deliberately
              // ignores the window's assignment filter (all/mine/others):
              // usePersistedPreference reads storage once per mount and does
              // not sync between components, so a badge wired to it would go
              // stale the moment the filter changed in the window — the same
              // disagreement in a harder-to-explain form. The badge is a "does
              // this workspace need me" signal; the narrowed number is already
              // shown next to the filter control that caused it.
              countOpenTasks(tasks)
            }
            inboxUnreadCount={inboxUnreadCount}
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
              <GetStartedPanel
                workspaceId={activeWorkspaceId || null}
                agents={agents}
                sessions={sessions}
                memberCount={members.length}
                surface={tipSurface}
                onCreateAgent={handleOpenAgents}
                onStartRoom={handleNewChat}
                onMessageAgent={handleOpenAgents}
                onInvite={handleOpenUsers}
              />
            )}
            notificationsSlot={<NotificationsBell workspaceId={activeWorkspaceId || null} variant="inline" />}
            presenceSlot={(
              <PresenceRoster
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
            className="fixed inset-0 z-[var(--z-drawer-scrim)] bg-black/50 backdrop-blur-sm"
            onClick={() => setMobileDrawerOpen(false)}
            aria-hidden
          />
        )}

        {/* Canvas column. Above the sidebar, below the workspace rail — see the
            ladder in src/lib/chromeDepth.ts. Its rung is also the ceiling for
            every floating window, which numbers itself from 100 up inside this
            stacking context (useWindows.ts). */}
        <div
          className="relative z-[var(--z-content)] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
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
                  backgroundOpacity={viewedLayer.background_opacity ?? activeWorkspace?.background_opacity ?? DEFAULT_BACKGROUND_OPACITY}
                  backgroundImage=""
                  contextCounts={contextCounts}
                  contextCountsTitle={contextCountsTitle}
                  onSelectAgent={setSelectedAgent}
                  onAgentProfile={handleOpenAgentProfile}
                  onSessionMetaSaved={handleSessionMetaSaved}
                  onCreateAgent={handleCreateAgent}
                  onUpdateAgent={updateAgent}
                  onDeleteAgent={deleteAgent}
                  onDisconnectAgent={disconnectAgent}
                  onCreateAgentWebhook={createAgentWebhook}
                  onUpdateAgentWebhook={updateAgentWebhook}
                  onInviteAgent={handleOpenUsers}
                  onOpenConnections={() => openLayerSettings(activeLayerId, 'connections')}
                  topLevelMessages={topLevelMessages}
                  threadMessages={threadMessages}
                  threadReplyCounts={threadReplyCounts}
                  activeThreadId={activeThreadId}
                  onOpenThread={openThread}
                  onCloseThread={closeThread}
                  subThreadsByMessage={subThreadsByMessage}
                  activeSubThread={activeSubThread}
                  activeSubThreadHostSessionId={activeSubThreadHostSessionId}
                  subThreadMessages={subThreadMessages}
                  subThreadHasMore={subThreadHasMore}
                  subThreadLoadingEarlier={subThreadLoadingEarlier}
                  onLoadEarlierSubThread={loadEarlierSubThreadMessages}
                  subThreadStreaming={subThreadStreaming}
                  onOpenSubThread={openSubThread}
                  onCloseSubThread={closeSubThread}
                  onCreateSubThread={handleCreateSubThreadFromScene}
                  onSendSubThreadMessage={sendSubThreadMessage}
                  onSplitThread={handleSplitThread}
                  onTypingChange={itemPresence.setTyping}
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
                  onOpenSessionById={handleSessionOpenById}
                  onOpenInboxItem={handleOpenInboxItem}
                  onDeleteDocument={handleDeleteDocumentFromScene}
                  onAutoSaveDocument={autoSave}
                  onAddToCanvasApplet={handleCreateDocApp}
                  fetchDocumentContent={fetchDocumentContent}
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
                <WorkspaceDesktopOverlay
                  workspaces={workspaces}
                  activeWorkspaceId={activeWorkspaceId}
                  layers={layers}
                  layersWorkspaceId={layersWorkspaceId}
                  objects={canvasObjects}
                  windows={windows}
                  activeLayerId={activeLayerId}
                  backgroundImage={canvasGridBackground}
                  onClose={handleCloseCanvasGrid}
                  onSelectWorkspace={setActiveWorkspaceId}
                  onCreateWorkspace={handleCreateWorkspace}
                  onSelectLayer={handleSelectCanvasFromGrid}
                  onCreateLayer={handleCreateCanvasFromGrid}
                  onDeleteLayer={handleDeleteCanvasFromGrid}
                  onOpenSettings={(layerId) => openLayerSettings(layerId)}
                  onRenameLayer={handleRenameDesktop}
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

              {/*
                The dock renders only when it has something in it. Draw used to
                be its permanent last button, so an empty dock was impossible;
                now that Draw is desktop-only, full-expand mode would otherwise
                leave an empty glass pill floating over a maximized window.
              */}
              {((!isFullExpandMode && dockEntries.length > 0) || drawToolAvailable) && (
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
                {!isFullExpandMode && dockWindows.length > 0 && drawToolAvailable && (
                  <Separator orientation="vertical" className="mx-0.5 h-6" />
                )}
                {drawToolAvailable && (
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
                )}
              </div>
              )}

            </CanvasDropZone>
          </main>
        </div>

        {showTour && (
          <OnboardingTour
            onComplete={handleTourComplete}
            onInvite={handleOpenUsers}
            workspaceId={activeWorkspaceId || null}
            workspaceReadiness={workspaceReadiness}
            onRetryWorkspaceSetup={retryWorkspaceSetup}
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
          isWorkspaceOwner={Boolean(activeWorkspace?.user_id && activeWorkspace.user_id === user.id)}
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
      <NewChannelDialog
        open={newChannelOpen}
        onOpenChange={handleNewChannelOpenChange}
        onCreate={createChannelFromTemplate}
        workspaceId={activeWorkspaceId || null}
        agents={agents}
        agentConnections={agentConnections}
        sessions={sessions}
        nostrConnection={managedNostrConnection}
        onNostrChange={() => { void refetchNostrCommunities(); }}
      />
      <RegistrationApprovalPopup workspaceId={activeWorkspaceId || null} />
      <FeedbackButton
        workspaceId={activeWorkspaceId || null}
        userId={user.id}
        contextLabel={viewedLayer.name || activeWorkspace?.name || ''}
      />
      <HuddleDock />
      <AppUpdateManager />
      {/* Renders nothing unless an owner broadcast for the 'dialog' surface is
          waiting; closing it is the server-side dismissal. */}
      <OwnerMessageDialog />
      <Toaster />
      </OwnerMessageProvider>
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
  onSessionMetaSaved,
  onCreateAgentWebhook,
  onUpdateAgentWebhook,
  onInviteAgent,
  onOpenConnections,
  topLevelMessages,
  threadMessages,
  threadReplyCounts,
  activeThreadId,
  onOpenThread,
  onCloseThread,
  subThreadsByMessage,
  activeSubThread,
  activeSubThreadHostSessionId,
  subThreadMessages,
  subThreadHasMore,
  subThreadLoadingEarlier,
  onLoadEarlierSubThread,
  subThreadStreaming,
  onOpenSubThread,
  onCloseSubThread,
  onCreateSubThread: onCreateSubThreadProp,
  onSendSubThreadMessage,
  onSplitThread,
  onTypingChange,
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
  onOpenSessionById,
  onOpenInboxItem,
  onDeleteDocument,
  onAutoSaveDocument,
  onAddToCanvasApplet,
  fetchDocumentContent,
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
  onCreateAgent: (input: CreateAgentInput) => Promise<boolean>;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onDeleteAgent: (id: string) => void;
  onDisconnectAgent: (id: string) => Promise<unknown>;
  focusedAgentKey: string | null;
  onAgentProfile: (agentIdOrHandle?: string | null) => void;
  onSessionMetaSaved?: (sessionId: string, patch: Record<string, unknown>) => void;
  onCreateAgentWebhook: (input: { agent_id?: string | null; name: string }) => Promise<AgentWebhook | null>;
  onUpdateAgentWebhook: (id: string, updates: Partial<AgentWebhook>) => Promise<AgentWebhook | null>;
  onInviteAgent: () => void;
  onOpenConnections: () => void;
  topLevelMessages: import('./types').Message[];
  threadMessages: import('./types').Message[];
  threadReplyCounts: Record<string, number>;
  activeThreadId: string | null;
  onOpenThread: (messageId: string) => void;
  onCloseThread: () => void;
  subThreadsByMessage: Record<string, import('./types').ChatSession[]>;
  activeSubThread: import('./types').ChatSession | null;
  activeSubThreadHostSessionId: string | null;
  subThreadMessages: import('./types').Message[];
  subThreadHasMore: boolean;
  subThreadLoadingEarlier: boolean;
  onLoadEarlierSubThread: () => void;
  subThreadStreaming: boolean;
  onOpenSubThread: (session: import('./types').ChatSession, hostSessionId?: string) => void;
  onCloseSubThread: () => void;
  onCreateSubThread: (
    messageId: string,
    agent: WorkspaceAgent,
    sourceContext?: QuotedMessageSource,
  ) => void;
  onSendSubThreadMessage: (content: string, attachments?: MessageAttachment[]) => void | Promise<SendOutcome | void>;
  onSplitThread: (source: import('./types').ChatSession) => void;
  /** useItemPresence().setTyping — see src/lib/typingPresence.ts. */
  onTypingChange: (type: 'chat' | 'document', itemId: string, typing: boolean) => void;
  useWorkspaceCtx: boolean;
  onToggleWorkspaceCtx: () => void;
  // false = no channel was created, so the composer must keep the draft.
  onHomeSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => Promise<boolean>;
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
  // Resolves `{ delivered: false }` when the message was rejected and rolled
  // back, so the composer that called it can restore the draft.
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[], threadParentId?: string | null, targetSession?: ChatSession | null, broadcastToChannel?: boolean, attachments?: MessageAttachment[]) => Promise<SendMessageResult>;
  onSetActiveSession: (session: ChatSession) => void;
  onOpenSessionById: (sessionId: string) => void;
  /** Inbox rows carry more than a session id — see components/inbox/inboxNavigation. */
  onOpenInboxItem: InboxOpenSession;
  onDeleteDocument: (id: string) => void;
  onAutoSaveDocument: (id: string, updates: { title?: string; content?: string }) => void;
  onAddToCanvasApplet: (doc: Document) => void;
  fetchDocumentContent: (id: string, force?: boolean) => Promise<string>;
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
  const { profile: userProfile } = useUserProfile(userId || null);
  const receiptsEnabled = userProfile?.share_read_receipts !== false;
  const isFullExpandMode = viewMode === 'full';

  // On a phone the canvas shows exactly one window — the focused one (highest
  // zIndex, the same signal a click uses to raise a window). Everything else is
  // reachable through the bottom switcher bar instead of the free-floating layout.
  const nonMinimizedWindows = useMemo(
    () => windows.filter(win => !win.minimized),
    [windows],
  );
  const topWindowId = pickActiveWindowId(windows);
  const mobileActiveWindowId = topWindowId;
  // Full-expand shows exactly one window — the top (highest-z, most recently
  // opened/focused) — edge-to-edge. Mobile keeps the same single-window rule.
  // Otherwise render the full float set.
  const renderedWindows = useMemo(
    () => (isFullExpandMode || isMobile) && topWindowId
      ? nonMinimizedWindows.filter(win => win.id === topWindowId)
      : nonMinimizedWindows,
    [isFullExpandMode, isMobile, topWindowId, nonMinimizedWindows],
  );
  const renderedWindowIds = useMemo(
    () => new Set(renderedWindows.map(win => win.id)),
    [renderedWindows],
  );
  // A chat composer owns draft state inside ChatWindowContent. Removing a chat
  // from this map on minimise, mobile switching, or full-expand used to unmount
  // that subtree and silently discard the draft. Keep every open chat mounted;
  // FloatingWindowShell hides inactive ones with the native hidden/inert
  // semantics so they neither paint nor retain keyboard/pointer input.
  const mountedWindows = useMemo(
    () => windows.filter(win => renderedWindowIds.has(win.id) || win.type === 'chat'),
    [windows, renderedWindowIds],
  );

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

  // Focusing a chat from the phone switcher bypasses the window shell's
  // pointer handler. Promote its session here as well, otherwise the visible
  // window and the global thread/composer state can briefly belong to
  // different chats (especially when the switcher is activated by keyboard).
  const focusWindowFromSwitcher = useCallback((windowId: string) => {
    onFocusWindow(windowId);
    const focused = windows.find(window => window.id === windowId);
    if (focused?.type !== 'chat' || !focused.sessionId) return;
    const session = sessions.find(candidate => candidate.id === focused.sessionId);
    if (session) onSetActiveSession(session);
  }, [onFocusWindow, onSetActiveSession, sessions, windows]);

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

      {mountedWindows.map(win => {
        const presenceMode = getPresenceMode(win.ownerUserId);
        const isWindowOwner = !win.ownerUserId || win.ownerUserId === userId;
        const canControlWindow = isWindowOwner && !(win.locked && !isWindowOwner);
        const adjacentEdges = adjacencyByWindowId.get(win.id);
        const groupRole = groupRoleByWindowId.get(win.id);

        if (win.type === 'chat') {
          const winSession = sessions.find(s => s.id === win.sessionId);
          const ownsActiveSubThread = Boolean(
            winSession && activeSubThreadHostSessionId === winSession.id,
          );
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
              hidden={!renderedWindowIds.has(win.id)}
              isSelected={selectedWindowIds.includes(win.id)}
              adjacentEdges={adjacentEdges}
              groupRole={groupRole}
              isMobile={isMobile}
              isFullExpand={isFullExpandMode}
              onToggleFullExpand={toggleFullExpand}
              onClose={onCloseWindow}
              onFocus={id => {
                onFocusWindow(id);
                if (winSession) onSetActiveSession(winSession);
              }}
              onUpdate={onUpdateWindow}
              onMinimize={onMinimizeWindow}
              onShare={() => onShareWindow(win.title)}
              presenceMode={presenceMode}
              currentUserId={userId}
              canControl={canControlWindow}
              bodyInteractive
              titleIcon={<MessageSquare size={13} />}
              breadcrumb={workspaceName}
            >
              {canControlWindow ? (
                <ChatWindowBody
                  winSession={winSession}
                  isActiveSession={activeSession?.id === win.sessionId}
                  onAppSendMessage={onSendMessage}
                  onSetActiveSession={onSetActiveSession}
                  onAppSplitThread={onSplitThread}
                  onAppTypingChange={onTypingChange}
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
                  onSessionMetaSaved={onSessionMetaSaved}
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
                  activeSubThread={ownsActiveSubThread ? activeSubThread : null}
                  subThreadMessages={ownsActiveSubThread ? subThreadMessages : EMPTY_MESSAGES}
                  subThreadHasMore={ownsActiveSubThread ? subThreadHasMore : false}
                  subThreadLoadingEarlier={ownsActiveSubThread ? subThreadLoadingEarlier : false}
                  onLoadEarlierSubThread={onLoadEarlierSubThread}
                  subThreadStreaming={ownsActiveSubThread && subThreadStreaming}
                  onOpenSubThread={onOpenSubThread}
                  onCloseSubThread={onCloseSubThread}
                  onCreateSubThread={onCreateSubThreadProp}
                  onSendSubThreadMessage={onSendSubThreadMessage}
                  channelTitle={winSession?.title || win.title}
                  currentUserId={userId}
                  receiptActive={win.id === topWindowId}
                  receiptsEnabled={receiptsEnabled}
                />
              ) : (
                <ReadOnlyChatWindowContent
                  session={winSession || null}
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
                  onAgentProfile={onAgentProfile}
                  subThreadsByMessage={subThreadsByMessage}
                  activeSubThread={ownsActiveSubThread ? activeSubThread : null}
                  subThreadMessages={ownsActiveSubThread ? subThreadMessages : EMPTY_MESSAGES}
                  subThreadStreaming={ownsActiveSubThread && subThreadStreaming}
                  onOpenSubThread={onOpenSubThread}
                  onCloseSubThread={onCloseSubThread}
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
                onAddToCanvasApplet={onAddToCanvasApplet}
                fetchDocumentContent={fetchDocumentContent}
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
                documents={documents}
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
                workspaceId={workspaceId}
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
                onOpenSession={onOpenSessionById}
                focusTaskId={win.focusTaskId}
                onUploadFiles={onUploadFiles}
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
                  workspaceId={workspaceId}
                  currentUserId={userId}
                />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        if (win.type === 'tenants') {
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
              titleIcon={<Building2 size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <TenantsWindowContent />
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
                  sessions={sessions}
                  tasks={tasks}
                  workspaceId={workspaceId}
                  workspaceName={workspaceName}
                  currentUserId={userId}
                  focusedAgentKey={focusedAgentKey}
                  onCreateAgent={onCreateAgent}
                  onUpdateAgent={onUpdateAgent}
                  onDeleteAgent={onDeleteAgent}
                  onDisconnectAgent={onDisconnectAgent}
                  onCreateWebhook={onCreateAgentWebhook}
                  onUpdateWebhook={onUpdateAgentWebhook}
                  onInviteAgent={onInviteAgent}
                  onOpenConnections={onOpenConnections}
                  // Reuse the stable per-session chat body used by ordinary chat
                  // windows. It owns the inactive-session subscription and
                  // promotes the selected conversation only when the first send
                  // happens, without borrowing another chat's streaming state.
                  renderSessionChat={session => {
                    const isActiveSession = activeSession?.id === session.id;
                    const ownsActiveSubThread = activeSubThreadHostSessionId === session.id;
                    return (
                      <ChatWindowBody
                        winSession={session}
                        isActiveSession={isActiveSession}
                        onAppSendMessage={onSendMessage}
                        onSetActiveSession={onSetActiveSession}
                        onAppSplitThread={onSplitThread}
                        onAppTypingChange={onTypingChange}
                        messages={isActiveSession ? (messages as never[]) : EMPTY_MESSAGES}
                        hasMoreMessages={isActiveSession ? hasMoreMessages : false}
                        loadingEarlier={loadingEarlier}
                        onLoadEarlier={() => onLoadEarlier(session.id)}
                        topLevelMessages={isActiveSession ? topLevelMessages : undefined}
                        threadMessages={threadMessages}
                        threadReplyCounts={threadReplyCounts}
                        activeThreadId={activeThreadId}
                        streaming={isActiveSession ? streaming : false}
                        memoryFacts={facts}
                        documents={documents}
                        agents={agents}
                        agentConnections={agentConnections}
                        presenceUsers={presenceUsers}
                        selectedAgent={selectedAgent}
                        onSelectAgent={onSelectAgent}
                        onAgentProfile={onAgentProfile}
                        onSessionMetaSaved={onSessionMetaSaved}
                        isDirectMessage={isDirectChatSession(session)}
                        canvasGroups={canvasGroups}
                        canvasObjects={canvasObjects}
                        workspaceId={workspaceId}
                        uploadedFiles={uploadedFiles}
                        onUploadFiles={onUploadFiles}
                        onCreateTask={onCreateTask}
                        systemCapabilities={systemCapabilities}
                        contextControls={null}
                        onOpenThread={messageId => {
                          if (!isActiveSession) {
                            onSetActiveSession(session);
                            // useChat clears the previous session's thread in a
                            // layout effect. Open this one after that promotion
                            // commits or the same layout effect erases the click.
                            queueMicrotask(() => onOpenThread(messageId));
                            return;
                          }
                          onOpenThread(messageId);
                        }}
                        onCloseThread={onCloseThread}
                        subThreadsByMessage={subThreadsByMessage}
                        activeSubThread={ownsActiveSubThread ? activeSubThread : null}
                        subThreadMessages={ownsActiveSubThread ? subThreadMessages : EMPTY_MESSAGES}
                        subThreadHasMore={ownsActiveSubThread ? subThreadHasMore : false}
                        subThreadLoadingEarlier={ownsActiveSubThread ? subThreadLoadingEarlier : false}
                        onLoadEarlierSubThread={onLoadEarlierSubThread}
                        subThreadStreaming={ownsActiveSubThread && subThreadStreaming}
                        onOpenSubThread={onOpenSubThread}
                        onCloseSubThread={onCloseSubThread}
                        onCreateSubThread={onCreateSubThreadProp}
                        onSendSubThreadMessage={onSendSubThreadMessage}
                        channelTitle={session.title || 'Conversation'}
                        currentUserId={userId}
                        receiptActive={win.id === topWindowId}
                        receiptsEnabled={receiptsEnabled}
                      />
                    );
                  }}
                />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        if (win.type === 'resources') {
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
              titleIcon={<Database size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <ResourcesWindowContent workspaceId={workspaceId} agents={agents} />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        if (win.type === 'terminal') {
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
              titleIcon={<SquareTerminal size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <TerminalPanel />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        if (win.type === 'browser') {
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
              titleIcon={<Globe size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <BrowserPanel />
              </Suspense>
            </FloatingWindowShell>
          );
        }

        if (win.type === 'inbox') {
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
              titleIcon={<Inbox size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <InboxWindowContent
                  workspaceId={workspaceId}
                  agents={agents}
                  onOpenSession={onOpenInboxItem}
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

        if (win.type === 'automations') {
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
              titleIcon={<Zap size={13} />}
              breadcrumb={workspaceName}
            >
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                <AutomationsWindowContent
                  workspaceId={workspaceId}
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
          onFocus={focusWindowFromSwitcher}
          onClose={onCloseWindow}
          onOpenMenu={onOpenMobileMenu}
        />
      )}
    </>
  );
}

function ReadOnlyChatWindowContent({
  session,
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
  onAgentProfile,
  subThreadsByMessage = {},
  activeSubThread = null,
  subThreadMessages = [],
  subThreadHasMore = false,
  subThreadLoadingEarlier = false,
  onLoadEarlierSubThread,
  subThreadStreaming = false,
  onOpenSubThread,
  onCloseSubThread,
}: {
  session: ChatSession | null;
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
  onAgentProfile?: (agentIdOrHandle?: string | null) => void;
  subThreadsByMessage?: Record<string, ChatSession[]>;
  activeSubThread?: ChatSession | null;
  subThreadMessages?: Message[];
  subThreadHasMore?: boolean;
  subThreadLoadingEarlier?: boolean;
  onLoadEarlierSubThread?: () => void;
  subThreadStreaming?: boolean;
  onOpenSubThread?: (subThread: ChatSession, hostSessionId?: string) => void;
  onCloseSubThread?: () => void;
}) {
  const {
    messages: remoteMessages,
    hasMore,
    loadingEarlier,
    loadEarlier,
  } = useSessionMessages(sessionId);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const topLevelMessages = useMemo(() => channelMessages(remoteMessages), [remoteMessages]);
  const threadReplyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const message of remoteMessages) {
      if (message.thread_parent_id && message.message_kind !== 'tool_step') {
        counts[message.thread_parent_id] = (counts[message.thread_parent_id] || 0) + 1;
      }
    }
    return counts;
  }, [remoteMessages]);
  const threadMessages = useMemo(
    () => activeThreadId
      ? remoteMessages.filter(message => message.thread_parent_id === activeThreadId)
      : [],
    [activeThreadId, remoteMessages],
  );
  const openThread = useCallback((messageId: string) => setActiveThreadId(messageId), []);
  const closeThread = useCallback(() => setActiveThreadId(null), []);

  useEffect(() => {
    if (activeThreadId && !remoteMessages.some(message => message.id === activeThreadId)) {
      setActiveThreadId(null);
    }
  }, [activeThreadId, remoteMessages]);

  return (
    <ChatWindowContent
      sessionId={sessionId}
      messages={remoteMessages}
      topLevelMessages={topLevelMessages}
      hasMoreMessages={hasMore}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={loadEarlier}
      threadMessages={threadMessages}
      threadReplyCounts={threadReplyCounts}
      activeThreadId={activeThreadId}
      onOpenThread={openThread}
      onCloseThread={closeThread}
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
      onAgentProfile={onAgentProfile}
      subThreadsByMessage={subThreadsByMessage}
      activeSubThread={activeSubThread}
      subThreadMessages={subThreadMessages}
      subThreadHasMore={subThreadHasMore}
      subThreadLoadingEarlier={subThreadLoadingEarlier}
      onLoadEarlierSubThread={onLoadEarlierSubThread}
      subThreadStreaming={subThreadStreaming}
      onOpenSubThread={onOpenSubThread}
      onCloseSubThread={onCloseSubThread}
      channelTitle={session?.title || undefined}
      onSendMessage={NOOP_SEND_MESSAGE}
      readOnly
    />
  );
}

/**
 * The full-screen switcher: **workspaces** (projects) on top, the selected
 * workspace's **desktops** below.
 *
 * It used to be one tier — a grid of `canvas_layers` under the heading "All
 * workspaces" — so an account with three workspaces opened it and saw a single
 * tile called "Workspace 1". Both tiers are now named for what they actually
 * are, and the hierarchy (a workspace contains desktops) is on screen instead of
 * being implied.
 *
 * Every decision about what a tile says, which one reads as current, and
 * critically whether a desktop list may be shown under a given workspace's name
 * lives in `src/lib/desktopOverlay.ts` and is unit-tested there. This is the
 * painter. The props keep the code's `layer` vocabulary because App's state and
 * handlers do — only what the user reads says "desktop".
 *
 * Selecting a workspace switches the app to it. That is a side effect beyond
 * this overlay, and it is the deliberate choice: App loads desktops for the
 * ACTIVE workspace only, so the alternative — fetching another workspace's
 * desktops just to preview them — means the tier below can disagree with the
 * tier above, which is the exact confusion this screen was built to remove. It
 * is also what the user is asking for: you do not browse a workspace's desktops
 * in order to stay where you are. The one frame where the loaded desktops still
 * belong to the previous workspace is covered by the model's `pending` state.
 */
function WorkspaceDesktopOverlay({
  workspaces,
  activeWorkspaceId,
  layers,
  layersWorkspaceId,
  objects,
  windows,
  activeLayerId,
  backgroundImage,
  onClose,
  onSelectWorkspace,
  onCreateWorkspace,
  onSelectLayer,
  onCreateLayer,
  onDeleteLayer,
  onOpenSettings,
  onRenameLayer,
  baseLayerId,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  layers: CanvasLayer[];
  /** The workspace `layers` was loaded for — NOT necessarily the active one. */
  layersWorkspaceId: string | null;
  objects: CanvasObject[];
  windows: FloatingWindow[];
  activeLayerId: string;
  backgroundImage: string;
  onClose: () => void;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  onSelectLayer: (id: string) => void;
  onCreateLayer: () => void;
  onDeleteLayer: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onRenameLayer: (id: string, name: string) => Promise<boolean> | boolean;
  baseLayerId: string;
}) {
  const [renamingDesktopId, setRenamingDesktopId] = useState<string | null>(null);
  const model = useMemo(
    () => buildDesktopOverlay({
      workspaces,
      selectedWorkspaceId: activeWorkspaceId,
      desktops: layers,
      desktopsWorkspaceId: layersWorkspaceId,
      activeDesktopId: activeLayerId,
      baseDesktopId: baseLayerId,
      objects,
      windows,
    }),
    [workspaces, activeWorkspaceId, layers, layersWorkspaceId, activeLayerId, baseLayerId, objects, windows],
  );

  const renderWorkspaceTile = (tile: OverlayWorkspaceTile) => (
    <button
      key={tile.id}
      type="button"
      data-overlay-workspace={tile.id}
      data-active={tile.active ? 'true' : undefined}
      aria-current={tile.active ? 'true' : undefined}
      onClick={() => onSelectWorkspace(tile.id)}
      className={cn(
        'flex min-w-0 items-center gap-2.5 rounded-xl border bg-card/80 p-2.5 text-left shadow-sm transition-colors',
        'hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        tile.active && 'border-primary/40 bg-primary/10 ring-1 ring-primary/40',
      )}
    >
      {/* Initials on a solid colour, the same colour and letters the rail gives
          this workspace. Never the `icon` column — see workspaceGlyph. */}
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold tracking-tight text-white"
        style={{ backgroundColor: tile.color }}
      >
        {tile.initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{tile.name}</span>
      {tile.active && <Badge variant="secondary" className="shrink-0">Current</Badge>}
      {!tile.active && tile.isSystem && (
        <span className="shrink-0 text-xs text-muted-foreground">System</span>
      )}
    </button>
  );

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
        className="relative flex h-full max-h-full w-full max-w-6xl flex-col gap-4"
      >
        <header className="flex shrink-0 items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-foreground">Workspaces and desktops</h2>
            <p className="text-sm text-muted-foreground">Pick a workspace, then a desktop inside it</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenSettings(activeLayerId)}>
              <Settings data-icon="inline-start" className="size-4" />
              Desktop settings
            </Button>
            <Button type="button" onClick={onCreateLayer} disabled={model.desktopTier === 'pending'}>
              <Layers3 data-icon="inline-start" className="size-4" />
              New desktop
            </Button>
          </div>
        </header>

        {/* The workspace tier. Capped at a third of the panel rather than given
            a third: three workspaces in a strip that always reserves 300px
            leaves a hole between the tiers that reads as a rendering fault. It
            grows with the list and starts scrolling at the cap, so an account
            with a dozen workspaces still cannot push the desktops off-screen. */}
        <section aria-label="Workspaces" className="flex max-h-[33%] min-h-0 shrink-0 flex-col gap-2">
          <h3 className="shrink-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Workspaces</h3>
          <ScrollArea className="min-h-0">
            <div className="grid grid-cols-1 gap-2 pb-1 pr-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {model.workspaces.map(renderWorkspaceTile)}
              {model.systemWorkspaces.map(renderWorkspaceTile)}
              <button
                type="button"
                onClick={onCreateWorkspace}
                className="flex min-w-0 items-center gap-2.5 rounded-xl border border-dashed border-border p-2.5 text-left text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-card/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-border">
                  <Plus className="size-4" />
                </span>
                <span className="truncate text-sm font-semibold">New workspace</span>
              </button>
            </div>
          </ScrollArea>
        </section>

        <div aria-hidden="true" className="h-px shrink-0 bg-border" />

        <section aria-label="Desktops" className="flex min-h-0 flex-1 flex-col gap-2">
          <h3 className="shrink-0 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Desktops in {model.selectedWorkspaceName}
          </h3>
          {model.desktopTier !== 'ready' ? (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
              {model.desktopTier === 'pending' ? DESKTOP_TIER_PENDING_MESSAGE : DESKTOP_TIER_EMPTY_MESSAGE}
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid grid-cols-1 gap-4 pb-1 pr-1 sm:grid-cols-2 lg:grid-cols-4">
                {model.desktops.map(tile => {
                  const previewCount = Math.min(tile.itemCount, 6);
                  return (
                    <Card
                      key={tile.id}
                      role="button"
                      tabIndex={0}
                      data-overlay-desktop={tile.id}
                      onClick={() => onSelectLayer(tile.id)}
                      onKeyDown={e => {
                        // The card is a keyboard launcher, but its Settings and
                        // Delete buttons are real controls inside it. Do not
                        // let Space/Enter on either child also switch desktop
                        // (or scroll the page for Space).
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectLayer(tile.id);
                        }
                      }}
                      className={cn(
                        'cursor-pointer shadow-lg transition-colors',
                        tile.active && 'border-primary/40 bg-primary/10 ring-1 ring-primary/40',
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
                              onOpenSettings(tile.id);
                            }}
                            title="Desktop settings"
                            aria-label="Desktop settings"
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
                          <div className="min-w-0 flex-1">
                            {renamingDesktopId === tile.id ? (
                              <InlineRename
                                value={tile.name}
                                ariaLabel={`Rename ${tile.name}`}
                                onCommit={(name: string) => onRenameLayer(tile.id, name)}
                                onCancel={() => setRenamingDesktopId(null)}
                              />
                            ) : (
                              <h3
                                // Double-click, matching the rail: a single click
                                // on a desktop tile switches to it.
                                onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); setRenamingDesktopId(tile.id); }}
                                title="Double-click to rename"
                                className="truncate text-sm font-bold text-foreground"
                              >
                                {tile.name}
                              </h3>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {tile.itemCount} items - {tile.windowCount} windows
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {tile.active && <Badge variant="secondary">Current</Badge>}
                            {tile.canDelete && (
                              <Button
                                type="button"
                                variant="destructive"
                                size="xs"
                                onClick={e => {
                                  e.stopPropagation();
                                  onDeleteLayer(tile.id);
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
          )}
        </section>
      </div>
    </div>
  );
}
