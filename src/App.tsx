import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { MessageSquare, FileText, Brain, Layers3, CheckCircle2, Activity, Bot, Trash2, Settings, Star, Sparkles, Command, Wrench, ChevronDown, Pencil } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { NetworkStatusBar } from './components/layout/NetworkStatusBar';
import { HomeCanvas } from './components/home/HomeCanvas';
import { FloatingWindowShell } from './components/windows/FloatingWindowShell';
import { ChatWindowContent } from './components/windows/ChatWindowContent';
import { DocWindowContent } from './components/windows/DocWindowContent';
import { TasksWindowContent } from './components/windows/TasksWindowContent';
import { ActivityWindowContent } from './components/windows/ActivityWindowContent';
import { AgentsWindowContent } from './components/windows/AgentsWindowContent';
import { MemorySection } from './components/memory/MemorySection';
import { OnboardingTour } from './components/onboarding/OnboardingTour';
import CommandPalette from './components/search/CommandPalette';
import { AuthPage } from './components/auth/AuthPage';
import { ShareDialog } from './components/sharing/ShareDialog';
import { CreateWorkspaceDialog } from './components/sharing/CreateWorkspaceDialog';
import { DrawingLayer } from './components/canvas/DrawingLayer';
import { CanvasDropZone } from './components/canvas/CanvasDropZone';
import CanvasTemplatePicker from './components/canvas/CanvasTemplatePicker';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { backendClient, getSystemCapabilities, type SystemCapabilities } from './lib/backendClient';
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount } from './components/ui/avatar';
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { ScrollArea } from './components/ui/scroll-area';
import { Spinner } from './components/ui/spinner';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/sonner';
import { cn } from './lib/utils';
import { applyUiAppearanceSettings, getSetting, getSettings } from './lib/settings';
import { applyThemePreset } from './showcase/themePresets';
import { WORKSPACE_CHROME_GAP, WORKSPACE_DOCK_BOTTOM_OFFSET, WORKSPACE_DOCK_HEIGHT } from './lib/workspaceLayout';
import { useAuth } from './hooks/useAuth';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useDocuments } from './hooks/useDocuments';
import { useChat } from './hooks/useChat';
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
import { useAgents } from './hooks/useAgents';
import { useAgentWebhooks } from './hooks/useAgentWebhooks';
import { useAgentConnections } from './hooks/useAgentConnections';
import { useWorkspacePresence, windowLabel, type WorkspacePresenceUser } from './hooks/useWorkspacePresence';
import { useWorkspaceKnowledge, type WorkspaceContextCounts } from './hooks/useWorkspaceKnowledge';
import type { CanvasAppDefinition } from './lib/canvasApps';
import { makeAppletState } from './lib/canvasApps';
import { WORKSPACE_BACKGROUND_IMAGES } from './lib/backgrounds';
import type { CanvasLayer } from './hooks/useCanvasLayers';
import { CursorOverlay } from './components/cursors/CursorOverlay';
import type { ChannelParticipant, Document, ChatSession, MemoryFact, CanvasGroup, CanvasObject, FloatingWindow, Task, ActivityEvent, WorkspaceAgent, AgentWebhook, PresenceVisibilityMode, Workspace, Message as ChatMessage, AgentConnection, UploadedFile } from './types';
import type { WorkspaceMember } from './hooks/useSharing';
import type { CreateTaskInput } from './hooks/useTasks';

const TOUR_KEY = 'agensis_tour_complete';
const SIDEBAR_KEY = 'agensis_sidebar_collapsed';
const PRESENCE_VISIBILITY_KEY = 'agensis_presence_visibility';
const PRESENCE_FAVORITES_KEY = 'agensis_presence_favorites';
const CANVAS_BACKGROUNDS = WORKSPACE_BACKGROUND_IMAGES;

function windowDockIcon(type: FloatingWindow['type']) {
  if (type === 'chat') return <MessageSquare className="size-4" />;
  if (type === 'memory') return <Brain className="size-4" />;
  if (type === 'tasks') return <CheckCircle2 className="size-4" />;
  if (type === 'activity') return <Activity className="size-4" />;
  if (type === 'agents') return <Bot className="size-4" />;
  return <FileText className="size-4" />;
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
  const activeTotal = enabled
    ? CONTEXT_COUNT_ITEMS
        .filter(item => enabledKeys.has(item.key))
        .reduce((total, item) => total + counts[item.key], 0)
    : 0;

  const setItemEnabled = (key: keyof WorkspaceContextCounts, checked: boolean) => {
    setEnabledKeys(prev => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={enabled ? 'secondary' : 'outline'}
          size="sm"
          className="knowledge-context-trigger h-8 shrink-0 gap-1.5 rounded-lg px-2.5 text-xs"
          title={enabled ? `Workspace context includes ${title}` : 'Workspace context is off'}
        >
          <CheckCircle2 className={enabled ? 'text-pink-500' : 'text-muted-foreground'} />
          <span>Knowledge</span>
          <Badge variant="secondary" className="h-5 rounded-md border-0 px-1.5 text-[10px] shadow-none">
            {activeTotal}
          </Badge>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Knowledge</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={enabled}
          onCheckedChange={checked => {
            if (Boolean(checked) !== enabled) onToggle();
          }}
        >
          Use workspace knowledge
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {CONTEXT_COUNT_ITEMS.map(item => (
          <DropdownMenuCheckboxItem
            key={item.key}
            checked={enabledKeys.has(item.key)}
            disabled={!enabled}
            onCheckedChange={checked => setItemEnabled(item.key, Boolean(checked))}
          >
            {item.icon}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="ml-auto text-xs text-muted-foreground">{counts[item.key]}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>('');
  const [showTour, setShowTour] = useState(false);
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

  const { workspaces, loading: wsLoading, createWorkspace } = useWorkspaces(user?.id);
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId) || workspaces[0] || null;

  useEffect(() => {
    if (!wsLoading && workspaces.length > 0 && !workspaces.find(w => w.id === activeWorkspaceId)) {
      setActiveWorkspaceId(workspaces[0].id);
    }
  }, [wsLoading, workspaces, activeWorkspaceId]);

  const {
    documents, recents,
    createDocument, saveDocument, autoSave, deleteDocument, toggleFavorite
  } = useDocuments(activeWorkspaceId);

  const {
    sessions, activeSession, setActiveSession, messages, streaming,
    topLevelMessages, threadMessages, threadReplyCounts, activeThreadId,
    openThread, closeThread,
    createSession, updateSession, archiveSession, sendMessage,
  } = useChat(activeWorkspaceId);

  const { facts, categories, addFact, updateFact, deleteFact } = useMemory(activeWorkspaceId);
  const { files: uploadedFiles, uploadFiles } = useFiles(activeWorkspaceId);
  const { online, syncing, pendingCount, syncError, flushQueue, clearPendingQueue } = useNetworkStatus();
  const { mode: themeMode, setTheme } = useTheme();

  useEffect(() => {
    const settings = getSettings();
    applyUiAppearanceSettings(settings);
    applyThemePreset(settings.ui_theme_preset);
  }, []);
  const { layers, activeLayer, activeLayerId, createLayer, activateLayer, deleteLayer, updateLayer, baseLayerId } = useCanvasLayers(activeWorkspaceId || null);
  const { windows, openWindow, closeWindow, focusWindow, updateWindow, minimizeWindow } = useWindowManager();
  const canvasRef = useRef<HTMLElement>(null);
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
  } = useAgents(activeWorkspaceId || null, user?.id);
  const {
    connections: agentConnections,
  } = useAgentConnections(activeWorkspaceId || null);
  const workspacePresenceUsers = useWorkspacePresence({
    user,
    cursors,
    remotePresenceUsers: itemPresence.remotePresenceUsers,
    documents,
    sessions,
    agentConnections,
    agents,
  });
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
  } = useTasks(activeWorkspaceId || null, user?.id);

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
  const visibleCanvasObjects = canvasObjects.filter(
    obj => (obj.layer_id || 'base') === viewedLayerId,
  );
  const visibleGroupIds = new Set(visibleCanvasObjects.map(obj => obj.group_id).filter(Boolean));
  const visibleCanvasGroups = canvasGroups.filter(group => visibleGroupIds.has(group.id));
  const exactWorkspaceWindows = focusedRemotePresence
    ? focusedRemotePresence.windows.map(win => ({
        ...win,
        id: `remote:${focusedRemotePresence.userId}:${win.id}`,
        ownerUserId: focusedRemotePresence.userId,
      }))
    : windows;
  const activeWindows = exactWorkspaceWindows.filter(win => (win.canvasId || 'base') === viewedLayerId);
  const dockWindows = windows.filter(win => (win.canvasId || 'base') === activeLayerId);
  const focusedDockWindow = dockWindows
    .filter(win => !win.minimized)
    .reduce<FloatingWindow | null>((topWindow, win) => (
      !topWindow || win.zIndex > topWindow.zIndex ? win : topWindow
    ), null);
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
  const openLayerSettings = useCallback((layerId = activeLayerId) => {
    setSettingsLayerId(layerId);
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

  const handleNewChat = useCallback(async () => {
    const session = await createSession();
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

  const handleOpenTasks = useCallback(() => {
    const existing = windows.find(w => w.type === 'tasks');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('tasks', { title: 'Tasks', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenActivity = useCallback(() => {
    const existing = windows.find(w => w.type === 'activity');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('activity', { title: 'Activity', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenAgents = useCallback(() => {
    const existing = windows.find(w => w.type === 'agents');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('agents', { title: 'AI Agents', canvasId: activeLayerId, ownerUserId: user?.id });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId, user?.id]);

  const handleOpenAgentProfile = useCallback((agentIdOrHandle?: string | null) => {
    if (agentIdOrHandle) setFocusedAgentKey(agentIdOrHandle);
    handleOpenAgents();
  }, [handleOpenAgents]);

  const handleCreateCanvasApp = useCallback(async (app: CanvasAppDefinition) => {
    await addCanvasObject('applet', {
      x: 12,
      y: 10,
      width: 76,
      height: 72,
      fill: 'var(--canvas-raised)',
      stroke: 'var(--border)',
      stroke_width: 1,
      file_name: app.id,
      text_content: makeAppletState(app.id, { agentRuns: [] }),
      src: app.buildHtml(),
      layer_id: activeLayerId,
    });
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
    else if (win.type === 'tasks') handleOpenTasks();
    else if (win.type === 'activity') handleOpenActivity();
    else if (win.type === 'agents') handleOpenAgents();
  }, [documents, handleDocumentOpen, handleOpenActivity, handleOpenAgents, handleOpenMemory, handleOpenTasks, handleSessionOpen, sessions]);

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
    const session = await createSession();
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
    const session = await createSession();
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


  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Spinner className="size-8" />
      </div>
    );
  }

  if (!user) {
    return <AuthPage onSignIn={signIn} onSignUp={signUp} onOAuthSignIn={signInWithOAuth} />;
  }

  return (
    <TooltipProvider>
    <div className="relative flex h-screen overflow-hidden bg-background" style={{ gap: WORKSPACE_CHROME_GAP, padding: WORKSPACE_CHROME_GAP }}>
      <img
        src={workspaceBackdropImage}
        alt=""
        className="pointer-events-none absolute inset-0 z-0 size-full object-cover"
        style={{ opacity: workspaceBackdropOpacity }}
      />
      <div className="pointer-events-none absolute inset-0 z-0 bg-[var(--home-bg-overlay)]" style={{ opacity: workspaceBackdropOverlayOpacity }} />
      <Sidebar
        workspace={activeWorkspace}
        activeLayerName={viewedLayer.name || activeWorkspace?.name || 'Personal'}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onOpenWorkspaceGrid={handleOpenCanvasGrid}
        onNewChat={handleNewChat}
        onNewDocument={handleNewDocument}
        onUploadFile={() => {}}
        onCreateWorkspace={handleCreateWorkspace}
        onDocumentOpen={handleDocumentOpen}
        onDocumentUpdate={saveDocument}
        onSessionOpen={handleSessionOpen}
        onSessionUpdate={updateSession}
        onSessionArchive={archiveSession}
        onOpenMemory={handleOpenMemory}
        onOpenTasks={handleOpenTasks}
        onOpenActivity={handleOpenActivity}
        onOpenAgents={handleOpenAgents}
        onAgentMessage={handleAgentDirectMessage}
        onAgentProfile={(agent) => handleOpenAgentProfile(agent.agentId || agent.id || agent.handle || agent.name)}
        onOpenTemplates={() => setTemplatePickerOpen(true)}
        openTaskCount={openTasks.length}
        recents={recents}
        sessions={sessions}
        agents={agents}
        agentConnections={agentConnections}
        floatingWindows={windows}
        documentPresence={itemPresence.documentPresence}
        chatPresence={itemPresence.chatPresence}
        themeMode={themeMode}
        onThemeChange={setTheme}
        userEmail={user.email || ''}
        onSignOut={signOut}
        onOpenSettings={() => openLayerSettings(activeLayerId)}
      />

      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <NetworkStatusBar
          online={online}
          syncing={syncing}
          pendingCount={pendingCount}
          syncError={syncError}
          onSync={flushQueue}
          onClearQueue={clearPendingQueue}
        />

        <main ref={canvasRef} data-workspace-viewport className="relative min-h-0 flex-1 overflow-hidden rounded-none">
          <CanvasDropZone
            onAddObject={addCanvasObject}
            onUploadFiles={uploadFiles}
          >
            <div
              className="workspace-bottom-controls absolute right-2 z-[11000] flex items-end gap-2"
              style={{ bottom: WORKSPACE_DOCK_BOTTOM_OFFSET }}
            >
              {!drawingActive && (
                <Button
                  type="button"
                  variant="default"
                  size="icon-lg"
                  className="size-9 rounded-full shadow-lg transition-transform hover:scale-105"
                  onClick={() => setDrawingActive(true)}
                  title="Draw on canvas"
                  aria-label="Draw on canvas"
                >
                  <Pencil data-icon="inline-start" className="size-4" />
                </Button>
              )}
              <WorkspacePresenceAvatars
                users={workspacePresenceUsers}
                getMode={getPresenceMode}
                onModeChange={setPresenceMode}
                favoriteIds={presenceFavorites}
                focusedUserId={focusedPresenceUserId}
                onToggleFavorite={togglePresenceFavorite}
                onFocusUser={setFocusedPresenceUserId}
                onOpenRemoteWindow={handleOpenPresenceWindow}
              />
            </div>

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
                streaming={streaming}
                workspaceName={viewedLayer.name || activeWorkspace?.name || 'Personal'}
                workspaceId={activeWorkspaceId || ''}
                userId={user.id}
                userEmail={user.email || ''}
                canvasObjects={visibleCanvasObjects}
                canvasGroups={visibleCanvasGroups}
                windows={activeWindows}
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
                onCreateAgentWebhook={createAgentWebhook}
                onUpdateAgentWebhook={updateAgentWebhook}
                topLevelMessages={topLevelMessages}
                threadMessages={threadMessages}
                threadReplyCounts={threadReplyCounts}
                activeThreadId={activeThreadId}
                onOpenThread={openThread}
                onCloseThread={closeThread}
                useWorkspaceCtx={useWorkspaceCtx}
                onToggleWorkspaceCtx={() => setUseWorkspaceCtx(v => !v)}
                onHomeSendMessage={handleHomeSendMessage}
                onNewDocument={handleNewDocument}
                onCloseWindow={handleCloseWindow}
                onFocusWindow={focusWindow}
                onUpdateWindow={updateWindow}
                onMinimizeWindow={minimizeWindow}
                onShareWindow={handleShareWindow}
                onSendMessage={wrappedSendMessage}
                onSetActiveSession={setActiveSession}
                onDeleteDocument={async (id) => {
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
                }}
                onAutoSaveDocument={autoSave}
                onToggleFavorite={toggleFavorite}
                onAddFact={(fact, category) => {
                  addFact(fact, category);
                  logEvent({
                    event_type: 'memory_added',
                    entity_type: 'memory',
                    title: `Memory added: ${fact.slice(0, 60)}${fact.length > 60 ? '...' : ''}`,
                    metadata: { category },
                  });
                }}
                onUpdateFact={updateFact}
                onDeleteFact={deleteFact}
                onCreateTask={handleCreateTask}
                onUpdateTask={handleUpdateTask}
                onToggleTaskStatus={handleToggleTaskStatus}
                onDeleteTask={handleDeleteTask}
                onCommentCreated={(docTitle) => logEvent({
                  event_type: 'comment_created',
                  entity_type: 'document',
                  title: docTitle ? `New comment on ${docTitle}` : 'New document comment',
                })}
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
              getPresenceMode={getPresenceMode}
              canEditObject={canEditCanvasObject}
              onCreateAppletTask={handleCreateTask}
              onUpdateAppletTask={handleUpdateTask}
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
              onCreateCustomApp={handleCreateCustomApplet}
            />

            {dockWindows.length > 0 && (
              <div
                className="workspace-window-dock agensis-glass-panel absolute left-1/2 z-[11000] flex max-w-[calc(100%-12rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-[16px] border p-[5px] shadow-md"
                style={{ bottom: WORKSPACE_DOCK_BOTTOM_OFFSET, height: WORKSPACE_DOCK_HEIGHT }}
              >
                {dockWindows.map(win => {
                  const active = focusedDockWindow?.id === win.id;
                  const dockActionLabel = win.minimized ? 'Open' : active ? 'Hide' : 'Focus';
                  return (
                  <Button
                    key={win.id}
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (win.minimized) {
                        focusWindow(win.id);
                        minimizeWindow(win.id);
                        return;
                      }
                      if (active) {
                        minimizeWindow(win.id);
                        return;
                      }
                      focusWindow(win.id);
                    }}
                    className={cn(
                      'relative size-8 rounded-xl border border-transparent text-foreground/90 transition-colors hover:bg-background/70 hover:text-foreground',
                      active && 'border-border/70 bg-background/80 text-foreground shadow-sm',
                      win.minimized && 'text-muted-foreground',
                    )}
                    title={`${dockActionLabel} ${windowLabel(win)}`}
                    aria-label={`${dockActionLabel} ${windowLabel(win)}`}
                  >
                    {windowDockIcon(win.type)}
                    <span
                      aria-hidden
                      className={cn(
                        'absolute bottom-0.5 left-1/2 h-1 w-2 -translate-x-1/2 rounded-[2px]',
                        active ? 'bg-foreground' : win.minimized ? 'bg-muted-foreground/55' : 'bg-primary/65',
                      )}
                    />
                  </Button>
                  );
                })}
              </div>
            )}

          </CanvasDropZone>
        </main>
      </div>

      {showTour && <OnboardingTour onComplete={handleTourComplete} />}

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        documents={documents}
        sessions={sessions}
        facts={facts}
        tasks={tasks}
        onDocumentOpen={handleDocumentOpen}
        onSessionOpen={handleSessionOpen}
        onTaskOpen={() => handleOpenTasks()}
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
  focusedAgentKey,
  onAgentProfile,
  onCreateAgentWebhook,
  onUpdateAgentWebhook,
  topLevelMessages,
  threadMessages,
  threadReplyCounts,
  activeThreadId,
  onOpenThread,
  onCloseThread,
  useWorkspaceCtx,
  onToggleWorkspaceCtx,
  onHomeSendMessage,
  onNewDocument,
  onCloseWindow,
  onFocusWindow,
  onUpdateWindow,
  onMinimizeWindow,
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
}: {
  documents: Document[];
  facts: MemoryFact[];
  categories: string[];
  sessions: ChatSession[];
  activeSession: ChatSession | null;
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>;
  streaming: boolean;
  workspaceName: string;
  workspaceId: string;
  userId: string;
  userEmail: string;
  canvasObjects: CanvasObject[];
  canvasGroups: CanvasGroup[];
  windows: FloatingWindow[];
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
  onCreateAgent: (input: { name: string; avatar?: string; openpet_avatar_id?: string | null; accent_color?: string | null; description?: string; system_prompt: string; soul?: string; instructions?: string; tools?: string[]; skills?: string[]; model?: string; run_mode?: 'builtin' | 'daemon' }) => void;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onDeleteAgent: (id: string) => void;
  focusedAgentKey: string | null;
  onAgentProfile: (agentIdOrHandle?: string | null) => void;
  onCreateAgentWebhook: (input: { agent_id?: string | null; name: string }) => Promise<AgentWebhook | null>;
  onUpdateAgentWebhook: (id: string, updates: Partial<AgentWebhook>) => Promise<AgentWebhook | null>;
  topLevelMessages: import('./types').Message[];
  threadMessages: import('./types').Message[];
  threadReplyCounts: Record<string, number>;
  activeThreadId: string | null;
  onOpenThread: (messageId: string) => void;
  onCloseThread: () => void;
  useWorkspaceCtx: boolean;
  onToggleWorkspaceCtx: () => void;
  onHomeSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => void;
  onNewDocument: () => void;
  onCloseWindow: (winId: string) => void;
  onFocusWindow: (winId: string) => void;
  onUpdateWindow: (id: string, updates: Partial<FloatingWindow>) => void;
  onMinimizeWindow: (id: string) => void;
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
  return (
    <>
      <HomeCanvas
        documents={documents}
        memoryFacts={facts}
        onSendMessage={onHomeSendMessage}
        onOpenNewDocument={onNewDocument}
        workspaceName={workspaceName}
        backgroundOpacity={backgroundOpacity}
        backgroundImage={backgroundImage}
      />

      {windows.filter(win => !win.minimized).map(win => {
        const presenceMode = getPresenceMode(win.ownerUserId);
        const isWindowOwner = !win.ownerUserId || win.ownerUserId === userId;
        const canControlWindow = isWindowOwner && !(win.locked && !isWindowOwner);

        if (win.type === 'chat') {
          const winSession = sessions.find(s => s.id === win.sessionId);
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
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
                <ChatWindowContent
                  messages={winSession && activeSession?.id === win.sessionId ? (messages as never[]) : []}
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
                  contextControls={(
                    <KnowledgeContextControl
                      counts={contextCounts}
                      enabled={useWorkspaceCtx}
                      title={contextCountsTitle}
                      onToggle={onToggleWorkspaceCtx}
                    />
                  )}
                  onSendMessage={(content, model, mf, docs) => {
                    if (winSession && activeSession?.id !== win.sessionId) onSetActiveSession(winSession);
                    onSendMessage(content, model, mf, docs, null, winSession || null);
                  }}
                  onOpenThread={onOpenThread}
                  onCloseThread={onCloseThread}
                  onSendThreadReply={(content, model) => {
                    if (winSession && activeSession?.id !== win.sessionId) onSetActiveSession(winSession);
                    onSendMessage(content, model, facts, undefined, activeThreadId, winSession || null);
                  }}
                  channelTitle={winSession?.title || win.title}
                />
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
              <DocWindowContent
                document={doc}
                workspaceId={workspaceId}
                userId={userId}
                currentUserEmail={userEmail}
                onAutoSave={onAutoSaveDocument}
                onToggleFavorite={onToggleFavorite}
                onDelete={(id) => {
                  onRequestConfirm({
                    title: 'Delete this document?',
                    description: 'This removes the document from the workspace.',
                    actionLabel: 'Delete',
                    onConfirm: async () => {
                      await onDeleteDocument(id);
                      onCloseWindow(win.id);
                    },
                  });
                }}
                onTitleChange={(title) => onUpdateWindow(win.id, { title })}
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
                facts={facts}
                categories={categories}
                onAdd={onAddFact}
                onUpdate={onUpdateFact}
                onDelete={onDeleteFact}
              />
            </FloatingWindowShell>
          );
        }

        if (win.type === 'tasks') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
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
              <TasksWindowContent
                tasks={tasks}
                members={members}
                currentUserEmail={userEmail}
                workspaceId={workspaceId}
                currentUserId={userId}
                onCreateTask={onCreateTask}
                onUpdateTask={onUpdateTask}
                onToggleStatus={onToggleTaskStatus}
                onDeleteTask={onDeleteTask}
              />
            </FloatingWindowShell>
          );
        }

        if (win.type === 'activity') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
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
              <ActivityWindowContent
                events={activityEvents}
                loading={activityLoading}
              />
            </FloatingWindowShell>
          );
        }

        if (win.type === 'agents') {
          return (
            <FloatingWindowShell
              key={win.id}
              window={win}
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
              <AgentsWindowContent
                agents={agents}
                webhooks={agentWebhooks}
                connections={agentConnections}
                focusedAgentKey={focusedAgentKey}
                onCreateAgent={onCreateAgent}
                onUpdateAgent={onUpdateAgent}
                onDeleteAgent={onDeleteAgent}
                onCreateWebhook={onCreateAgentWebhook}
                onUpdateWebhook={onUpdateAgentWebhook}
              />
            </FloatingWindowShell>
          );
        }

        return null;
      })}
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
        if (!cancelled && data) setRemoteMessages(data as ChatMessage[]);
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
      onSendMessage={() => {}}
      readOnly
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
}: {
  users: WorkspacePresenceUser[];
  getMode: (id?: string | null) => PresenceVisibilityMode;
  onModeChange: (id: string, mode: PresenceVisibilityMode) => void;
  favoriteIds: string[];
  focusedUserId: string | null;
  onToggleFavorite: (id: string) => void;
  onFocusUser: (id: string | null) => void;
  onOpenRemoteWindow: (win: FloatingWindow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
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
    <div ref={panelRef} data-presence-panel className="relative flex flex-col items-end gap-2">
      {expanded && (
        <div className="absolute right-0 bottom-full z-10 mb-2 w-96 overflow-hidden rounded-lg border agensis-glass-panel text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div>
              <div className="text-sm font-semibold">Shared users and agents</div>
              <div className="text-[11px] text-muted-foreground">View activity, focus a participant, or share your windows</div>
            </div>
            <Badge variant="secondary">{users.length}</Badge>
          </div>
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
                      <AvatarBadge className={person.kind === 'agent' && person.status === 'busy' ? 'bg-amber-500' : 'bg-green-500'} />
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
                      <div className="presence-activity-chips mt-2 flex flex-wrap gap-x-1.5 gap-y-2">
                        {person.activityItems.map(item => (
                          <Badge key={item} variant="secondary" className="presence-activity-chip max-w-[12rem] truncate text-[10px]">
                            {item}
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
        </div>
      )}
      <div className="presence-top-row order-1 group/presence-row flex items-center gap-1 rounded-full border bg-popover/90 p-1 shadow-md backdrop-blur">
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
                    <AvatarBadge className={person.kind === 'agent' && person.status === 'busy' ? 'bg-amber-500' : 'bg-green-500'} />
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
              className="h-8 rounded-full px-3 text-xs"
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
                className="h-8 max-w-40 rounded-full px-2 text-xs"
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
