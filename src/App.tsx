import { useState, useEffect, useCallback, useRef } from 'react';
import { MessageSquare, FileText, Brain, Layers3, CheckCircle2, Activity, Bot, Trash2 } from 'lucide-react';
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
import { Checkbox } from './components/ui/checkbox';
import { Label } from './components/ui/label';
import { ScrollArea } from './components/ui/scroll-area';
import { Spinner } from './components/ui/spinner';
import { cn } from './lib/utils';
import { getSetting } from './lib/settings';
import { useAuth } from './hooks/useAuth';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useDocuments } from './hooks/useDocuments';
import { useChat } from './hooks/useChat';
import { useMemory } from './hooks/useMemory';
import { useFiles } from './hooks/useFiles';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useTheme } from './hooks/useTheme';
import { useWindows } from './hooks/useWindows';
import { useMultiplayerCursors } from './hooks/useMultiplayerCursors';
import { useSharing } from './hooks/useSharing';
import { useCanvasObjects } from './hooks/useCanvasObjects';
import { useCanvasLayers } from './hooks/useCanvasLayers';
import { useTasks } from './hooks/useTasks';
import { useActivity } from './hooks/useActivity';
import { useWorkspaceContext } from './hooks/useWorkspaceContext';
import { useAgents } from './hooks/useAgents';
import { useAgentWebhooks } from './hooks/useAgentWebhooks';
import type { CanvasTemplate } from './lib/canvasTemplates';
import type { CanvasAppDefinition } from './lib/canvasApps';
import { makeAppletState } from './lib/canvasApps';
import type { CanvasLayer } from './hooks/useCanvasLayers';
import { CursorOverlay } from './components/cursors/CursorOverlay';
import type { Document, ChatSession, MemoryFact, CanvasGroup, CanvasObject, FloatingWindow, Task, ActivityEvent, WorkspaceAgent, AgentWebhook } from './types';
import type { WorkspaceMember } from './hooks/useSharing';
import type { CreateTaskInput } from './hooks/useTasks';
import bg1 from '../images/download-21.jpg';
import bg2 from '../images/download-22.jpg';
import bg3 from '../images/download-24.jpg';
import bg4 from '../images/download-25.jpg';
import bg5 from '../images/download-26.jpg';

const TOUR_KEY = 'hatch_tour_complete';
const SIDEBAR_KEY = 'hatch_sidebar_collapsed';
const CANVAS_BACKGROUNDS = [bg1, bg2, bg3, bg4, bg5];

export default function App() {
  const { user, loading: authLoading, signIn, signUp, signOut } = useAuth();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>('');
  const [showTour, setShowTour] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareDialogTitle, setShareDialogTitle] = useState('');
  const [createWorkspaceDialogOpen, setCreateWorkspaceDialogOpen] = useState(false);
  const [drawingActive, setDrawingActive] = useState(false);
  const [showCanvasGrid, setShowCanvasGrid] = useState(false);
  const [canvasGridBackground] = useState(() => CANVAS_BACKGROUNDS[Math.floor(Math.random() * CANVAS_BACKGROUNDS.length)]);
  const activeSceneRef = useRef<HTMLDivElement>(null);

  const { workspaces, loading: wsLoading, createWorkspace, updateWorkspace } = useWorkspaces(user?.id);
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId) || workspaces[0] || null;

  useEffect(() => {
    if (!wsLoading && workspaces.length > 0 && !workspaces.find(w => w.id === activeWorkspaceId)) {
      setActiveWorkspaceId(workspaces[0].id);
    }
  }, [wsLoading, workspaces, activeWorkspaceId]);

  const {
    documents, recents,
    createDocument, autoSave, deleteDocument, toggleFavorite
  } = useDocuments(activeWorkspaceId);

  const {
    sessions, activeSession, setActiveSession, messages, streaming,
    topLevelMessages, threadMessages, threadReplyCounts, activeThreadId,
    openThread, closeThread,
    createSession, updateSession, archiveSession, sendMessage,
  } = useChat(activeWorkspaceId);

  const { facts, categories, addFact, updateFact, deleteFact } = useMemory(activeWorkspaceId);
  const { uploadFiles } = useFiles(activeWorkspaceId);
  const { online, syncing, pendingCount, syncError, flushQueue, clearPendingQueue } = useNetworkStatus();
  const { mode: themeMode, setTheme } = useTheme();
  const { layers, activeLayer, activeLayerId, createLayer, activateLayer, deleteLayer, baseLayerId } = useCanvasLayers(activeWorkspaceId || null);
  const { windows, openWindow, closeWindow, focusWindow, updateWindow, minimizeWindow } = useWindows();
  const canvasRef = useRef<HTMLElement>(null);
  const { cursors } = useMultiplayerCursors(
    activeWorkspaceId,
    canvasRef,
    user?.id,
    user?.email || undefined
  );

  const workspacePresenceUsers = [
    ...(user ? [{
      id: user.id,
      name: user.email?.split('@')[0] || 'You',
      color: colorFromSeed(user.id),
      isCurrentUser: true,
    }] : []),
    ...cursors.map(cursor => ({
      id: cursor.id,
      name: cursor.name,
      color: cursor.color,
      isCurrentUser: false,
    })),
  ];
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
    agents,
    createAgent,
    updateAgent,
    deleteAgent,
  } = useAgents(activeWorkspaceId || null, user?.id);
  const {
    webhooks: agentWebhooks,
    createWebhook: createAgentWebhook,
    updateWebhook: updateAgentWebhook,
  } = useAgentWebhooks(activeWorkspaceId || null);

  const [selectedAgent, setSelectedAgent] = useState<WorkspaceAgent | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    actionLabel: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const { buildSnapshot: buildWorkspaceContext } = useWorkspaceContext({
    workspaceName: activeWorkspace?.name || 'Workspace',
    documents,
    memoryFacts: facts,
    tasks,
    canvasObjects,
  });

  const visibleCanvasObjects = canvasObjects.filter(
    obj => (obj.layer_id || 'base') === activeLayerId,
  );
  const visibleGroupIds = new Set(visibleCanvasObjects.map(obj => obj.group_id).filter(Boolean));
  const visibleCanvasGroups = canvasGroups.filter(group => visibleGroupIds.has(group.id));
  const activeWindows = windows.filter(win => (win.canvasId || 'base') === activeLayerId);
  const minimizedActiveWindows = activeWindows.filter(win => win.minimized);

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
      openWindow('chat', { title: session.title || 'Untitled', sessionId: session.id, canvasId: activeLayerId });
      logEvent({
        event_type: 'chat_created',
        entity_type: 'chat',
        entity_id: session.id,
        title: `New chat: ${session.title || 'Untitled'}`,
      });
    }
  }, [createSession, openWindow, activeLayerId, logEvent]);

  const handleNewDocument = useCallback(async () => {
    const doc = await createDocument();
    if (doc) {
      openWindow('document', { title: doc.title || 'Untitled', documentId: doc.id, canvasId: activeLayerId });
      logEvent({
        event_type: 'document_created',
        entity_type: 'document',
        entity_id: doc.id,
        title: `New document: ${doc.title || 'Untitled'}`,
      });
    }
  }, [createDocument, openWindow, activeLayerId, logEvent]);

  const handleOpenMemory = useCallback(() => {
    const existing = windows.find(w => w.type === 'memory');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('memory', { title: 'Memory', canvasId: activeLayerId });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId]);

  const handleOpenTasks = useCallback(() => {
    const existing = windows.find(w => w.type === 'tasks');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('tasks', { title: 'Tasks', canvasId: activeLayerId });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId]);

  const handleOpenActivity = useCallback(() => {
    const existing = windows.find(w => w.type === 'activity');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('activity', { title: 'Activity', canvasId: activeLayerId });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId]);

  const handleOpenAgents = useCallback(() => {
    const existing = windows.find(w => w.type === 'agents');
    if (existing) {
      focusWindow(existing.id);
      if (existing.minimized) minimizeWindow(existing.id);
      return;
    }
    openWindow('agents', { title: 'AI Agents', canvasId: activeLayerId });
  }, [windows, openWindow, focusWindow, minimizeWindow, activeLayerId]);

  const handleApplyTemplate = useCallback(async (template: CanvasTemplate) => {
    // Each template becomes its own self-contained board (canvas layer).
    const layerId = createLayer(template.name);
    for (const obj of template.objects) {
      await addCanvasObject(
        obj.type as import('./types').CanvasObjectType,
        { ...obj.overrides, layer_id: layerId } as Partial<import('./types').CanvasObject>,
      );
    }
  }, [createLayer, addCanvasObject]);

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
    openWindow('document', { title: doc.title, documentId: doc.id, canvasId: activeLayerId });
  }, [openWindow, activeLayerId]);

  const handleSessionOpen = useCallback((session: ChatSession) => {
    setActiveSession(session);
    openWindow('chat', { title: session.title, sessionId: session.id, canvasId: activeLayerId });
  }, [setActiveSession, openWindow, activeLayerId]);

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
  ) => {
    const snapshot = useWorkspaceCtx ? buildWorkspaceContext() : null;
    await sendMessage(content, model, memFacts, docs, snapshot, selectedAgent, threadParentId);
  }, [sendMessage, useWorkspaceCtx, buildWorkspaceContext, selectedAgent]);

  const handleHomeSendMessage = useCallback(async (
    content: string,
    model: string,
    memFacts?: MemoryFact[],
    docs?: Document[]
  ) => {
    const session = await createSession();
    if (session) {
      openWindow('chat', { title: content.slice(0, 30) || 'New Chat', sessionId: session.id, canvasId: activeLayerId });
      setTimeout(() => {
        wrappedSendMessage(content, model, memFacts, docs);
      }, 100);
    }
  }, [createSession, openWindow, wrappedSendMessage, activeLayerId]);

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
    return <AuthPage onSignIn={signIn} onSignUp={signUp} />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        workspace={activeWorkspace}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onNewChat={handleNewChat}
        onNewDocument={handleNewDocument}
        onUploadFile={() => {}}
        onCreateWorkspace={handleCreateWorkspace}
        onDocumentOpen={handleDocumentOpen}
        onSessionOpen={handleSessionOpen}
        onSessionUpdate={updateSession}
        onSessionArchive={archiveSession}
        onOpenMemory={handleOpenMemory}
        onOpenTasks={handleOpenTasks}
        onOpenActivity={handleOpenActivity}
        onOpenAgents={handleOpenAgents}
        onOpenTemplates={() => setTemplatePickerOpen(true)}
        openTaskCount={openTasks.length}
        recents={recents}
        sessions={sessions}
        floatingWindows={windows}
        themeMode={themeMode}
        onThemeChange={setTheme}
        userEmail={user.email || ''}
        onSignOut={signOut}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <NetworkStatusBar
          online={online}
          syncing={syncing}
          pendingCount={pendingCount}
          syncError={syncError}
          onSync={flushQueue}
          onClearQueue={clearPendingQueue}
        />

        <main ref={canvasRef} className="relative flex-1 overflow-hidden">
          <CanvasDropZone
            onAddObject={addCanvasObject}
            onUploadFiles={uploadFiles}
          >
            <CanvasGridButton
              activeLayerName={activeLayer.name}
              onClick={handleOpenCanvasGrid}
            />

            <WorkspacePresenceAvatars users={workspacePresenceUsers} />

            <CursorOverlay cursors={cursors} />

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
                workspaceName={activeWorkspace?.name || 'Personal'}
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
                selectedAgent={selectedAgent}
                onSelectAgent={setSelectedAgent}
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
                onNewChat={handleNewChat}
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
                baseLayerId={baseLayerId}
              />
            )}

            <CanvasTemplatePicker
              open={templatePickerOpen}
              onClose={() => setTemplatePickerOpen(false)}
              onApply={handleApplyTemplate}
              onCreateApp={handleCreateCanvasApp}
            />

            {minimizedActiveWindows.length > 0 && (
              <div className="absolute right-3 bottom-[72px] z-50 flex gap-1.5">
                {minimizedActiveWindows.map(win => (
                  <Button
                    key={win.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => minimizeWindow(win.id)}
                    className="bg-popover shadow-md"
                  >
                    {win.type === 'chat' ? <MessageSquare data-icon="inline-start" className="size-3" />
                      : win.type === 'memory' ? <Brain data-icon="inline-start" className="size-3" />
                      : win.type === 'tasks' ? <CheckCircle2 data-icon="inline-start" className="size-3" />
                      : win.type === 'activity' ? <Activity data-icon="inline-start" className="size-3" />
                      : win.type === 'agents' ? <Bot data-icon="inline-start" className="size-3" />
                      : <FileText data-icon="inline-start" className="size-3" />}
                    <span className="max-w-[120px] truncate">
                      {win.title}
                    </span>
                  </Button>
                ))}
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
        workspace={activeWorkspace}
        onUpdateWorkspace={updateWorkspace}
        workspaceName={activeWorkspace?.name || 'Personal'}
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
  selectedAgent,
  onSelectAgent,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
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
  onNewChat,
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
  selectedAgent: WorkspaceAgent | null;
  onSelectAgent: (agent: WorkspaceAgent | null) => void;
  onCreateAgent: (input: { name: string; avatar?: string; description?: string; system_prompt: string; soul?: string; instructions?: string; tools?: string[]; skills?: string[]; model?: string }) => void;
  onUpdateAgent: (id: string, updates: Partial<WorkspaceAgent>) => void;
  onDeleteAgent: (id: string) => void;
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
  onNewChat: () => void;
  onCloseWindow: (winId: string) => void;
  onFocusWindow: (winId: string) => void;
  onUpdateWindow: (id: string, updates: Partial<FloatingWindow>) => void;
  onMinimizeWindow: (id: string) => void;
  onShareWindow: (title: string) => void;
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[], threadParentId?: string | null) => void;
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
        onOpenNewChat={onNewChat}
        workspaceName={workspaceName}
      />

      {windows.filter(win => !win.minimized).map(win => {
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
              titleIcon={<MessageSquare size={13} />}
              breadcrumb={workspaceName}
            >
              <div className="flex h-full flex-col">
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3 text-xs text-muted-foreground">
                  <Label className="min-w-0 flex-1 cursor-pointer font-normal">
                    <Checkbox
                      checked={useWorkspaceCtx}
                      onCheckedChange={() => onToggleWorkspaceCtx()}
                      className="size-4 shrink-0"
                    />
                    <span className="truncate text-xs leading-none">Use workspace knowledge</span>
                  </Label>
                  <Badge
                    variant="secondary"
                    title="The AI can see open tasks, recent documents, memory, and canvas notes"
                    className="ml-auto max-w-[45%] truncate text-xs"
                  >
                    {useWorkspaceCtx ? `${documents.length} docs / ${facts.length} facts / ${tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').length} tasks` : 'Context off'}
                  </Badge>
                </div>
                <div className="min-h-0 flex-1">
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
                    selectedAgent={selectedAgent}
                    onSelectAgent={onSelectAgent}
                    canvasGroups={canvasGroups}
                    canvasObjects={canvasObjects}
                    onSendMessage={(content, model, mf, docs) => {
                      if (winSession && activeSession?.id !== win.sessionId) onSetActiveSession(winSession);
                      onSendMessage(content, model, mf, docs);
                    }}
                    onOpenThread={onOpenThread}
                    onCloseThread={onCloseThread}
                    onSendThreadReply={(content, model) => {
                      if (winSession && activeSession?.id !== win.sessionId) onSetActiveSession(winSession);
                      onSendMessage(content, model, facts, undefined, activeThreadId);
                    }}
                  />
                </div>
              </div>
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
              titleIcon={<Bot size={13} />}
              breadcrumb={workspaceName}
            >
              <AgentsWindowContent
                agents={agents}
                webhooks={agentWebhooks}
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

function colorFromSeed(seed: string): string {
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

function WorkspacePresenceAvatars({
  users,
}: {
  users: Array<{ id: string; name: string; color: string; isCurrentUser?: boolean }>;
}) {
  if (users.length === 0) return null;

  const visibleUsers = users.slice(0, 5);
  const overflow = users.length - visibleUsers.length;

  return (
    <div className="absolute top-3.5 right-3.5 z-[85] flex items-center gap-2 rounded-full border bg-popover/85 px-2.5 py-2 shadow-md backdrop-blur">
      <AvatarGroup>
        {visibleUsers.map((person, index) => (
          <Avatar
            key={person.id}
            size="sm"
            title={`${person.name}${person.isCurrentUser ? ' (you)' : ''}`}
            className={cn(index > 0 && '-ml-2')}
          >
            <AvatarFallback className="text-[10px] font-bold">
              {(person.name || '?').slice(0, 2).toUpperCase()}
            </AvatarFallback>
            {person.isCurrentUser && <AvatarBadge className="bg-green-500" />}
          </Avatar>
        ))}
        {overflow > 0 && (
          <AvatarGroupCount title={`${overflow} more users`} className="-ml-2 size-6 text-[10px]">
            +{overflow}
          </AvatarGroupCount>
        )}
      </AvatarGroup>
      <div className="flex min-w-0 flex-col">
        <span className="text-[11px] font-semibold leading-tight text-foreground">
          {users.length === 1 ? 'Just you' : `${users.length} here now`}
        </span>
        <span className="text-[10px] leading-tight text-muted-foreground">
          Live workspace presence
        </span>
      </div>
    </div>
  );
}

function CanvasGridButton({
  activeLayerName,
  onClick,
}: {
  activeLayerName: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      title="Show all canvases"
      className="absolute top-3.5 left-3.5 z-[80] bg-popover/95 shadow-md backdrop-blur"
    >
      <Layers3 data-icon="inline-start" className="size-4" />
      <span>{activeLayerName}</span>
    </Button>
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
          <Button type="button" onClick={onCreateLayer}>
            <Layers3 data-icon="inline-start" className="size-4" />
            New workspace
          </Button>
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
