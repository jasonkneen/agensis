import React from 'react';
import {
  Archive,
  Bot,
  Brain,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Hash,
  Layers3,
  LayoutTemplate,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Star,
  UserRound,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import type { ThemeMode } from '../../hooks/useTheme';
import type { AgentConnection, ChatSession, Document, FloatingWindow, ItemPresenceUser, Workspace, WorkspaceAgent } from '../../types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { isImageAvatar } from '../../lib/openpets';

const SIDEBAR_WIDTH_KEY = 'agensis_sidebar_width';
const AGENT_FAVORITES_KEY = 'agensis_sidebar_agent_favorites';
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 380;

type SidebarAgentTarget = {
  id: string;
  agentId: string | null;
  name: string;
  handle: string | null;
  avatar?: string | null;
  status?: AgentConnection['status'];
  runMode?: WorkspaceAgent['run_mode'];
};

type SidebarMessageTarget = SidebarAgentTarget & {
  session?: ChatSession;
};

interface SidebarProps {
  workspace: Workspace | null;
  activeLayerName?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenCommandPalette: () => void;
  onOpenWorkspaceGrid?: () => void;
  onNewChat: () => void;
  onNewDocument: () => void;
  onUploadFile: () => void;
  onCreateWorkspace: () => void;
  onDocumentOpen: (doc: Document) => void;
  onDocumentUpdate?: (id: string, updates: { title?: string; content?: string; folder?: string | null }) => void;
  onSessionOpen: (session: ChatSession) => void;
  onSessionUpdate?: (id: string, updates: Partial<ChatSession>) => void;
  onSessionArchive?: (id: string, archived?: boolean) => void;
  onOpenMemory: () => void;
  onOpenTasks?: () => void;
  onOpenActivity?: () => void;
  onOpenAgents?: () => void;
  onAgentMessage?: (agent: SidebarAgentTarget) => void;
  onAgentProfile?: (agent: SidebarAgentTarget) => void;
  onOpenTemplates?: () => void;
  openTaskCount?: number;
  recents: Document[];
  sessions: ChatSession[];
  agents?: WorkspaceAgent[];
  agentConnections?: AgentConnection[];
  floatingWindows: FloatingWindow[];
  documentPresence?: Record<string, ItemPresenceUser[]>;
  chatPresence?: Record<string, ItemPresenceUser[]>;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  userEmail: string;
  onSignOut: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  workspace,
  activeLayerName,
  collapsed,
  onToggleCollapse,
  onOpenCommandPalette,
  onOpenWorkspaceGrid,
  onNewChat,
  onNewDocument,
  onCreateWorkspace,
  onDocumentOpen,
  onDocumentUpdate,
  onSessionOpen,
  onSessionUpdate,
  onSessionArchive,
  onOpenMemory,
  onOpenTasks,
  onOpenActivity,
  onOpenAgents,
  onAgentMessage,
  onAgentProfile,
  onOpenTemplates,
  openTaskCount = 0,
  recents,
  sessions,
  agents = [],
  agentConnections = [],
  floatingWindows,
  documentPresence = {},
  chatPresence = {},
  themeMode,
  onThemeChange,
  onOpenSettings,
  userEmail,
  onSignOut,
}: SidebarProps) {
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    if (typeof localStorage === 'undefined') return 280;
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, saved)) : 280;
  });
  const sidebarRef = React.useRef<HTMLElement | null>(null);
  const resizeRef = React.useRef<{ startX: number; startWidth: number } | null>(null);
  const resizeFrameRef = React.useRef<number | null>(null);
  const [openSections, setOpenSections] = React.useState<Set<string>>(() => new Set());
  const [favoriteAgentKeys, setFavoriteAgentKeys] = React.useState<Set<string>>(() => {
    if (typeof localStorage === 'undefined') return new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(AGENT_FAVORITES_KEY) || '[]') as string[];
      return new Set(Array.isArray(saved) ? saved.filter(key => typeof key === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const userInitial = (userEmail[0] || 'U').toUpperCase();
  const uniqueSessions = React.useMemo(() => uniqueById(sessions), [sessions]);
  const uniqueRecents = React.useMemo(() => uniqueById(recents), [recents]);
  const directAgents = React.useMemo(
    () => buildDirectAgents(agents, agentConnections, favoriteAgentKeys),
    [agents, agentConnections, favoriteAgentKeys],
  );
  const { activeChannelSessions, directSessions, threadSessions } = React.useMemo(() => {
    const activeSessions = uniqueSessions.filter(session => !session.archived_at);
    const direct = activeSessions.filter(isDirectSession);
    const threads = activeSessions.filter(session => !isDirectSession(session) && isThreadSession(session));
    return {
      activeChannelSessions: activeSessions.filter(session => !isDirectSession(session) && !isThreadSession(session)),
      directSessions: direct,
      threadSessions: threads,
    };
  }, [uniqueSessions]);
  const archivedSessions = React.useMemo(() => uniqueSessions.filter(session => Boolean(session.archived_at)), [uniqueSessions]);
  const directMessageTargets = React.useMemo(
    () => buildDirectMessageTargets(directSessions, directAgents, favoriteAgentKeys),
    [directSessions, directAgents, favoriteAgentKeys],
  );
  const groupedThreadSessions = React.useMemo(() => groupSessionsByFolder(threadSessions, 'Threads'), [threadSessions]);
  const groupedSessions = React.useMemo(() => groupSessionsByFolder(activeChannelSessions), [activeChannelSessions]);
  const groupedDocuments = React.useMemo(() => groupDocumentsByFolder(uniqueRecents), [uniqueRecents]);
  const focusedWindow = floatingWindows
    .filter(win => !win.minimized)
    .reduce<FloatingWindow | null>((topWindow, win) => (
      !topWindow || win.zIndex > topWindow.zIndex ? win : topWindow
    ), null);
  const focusedWindowType = focusedWindow?.type;
  const workspaceLabel = activeLayerName || workspace?.name || 'Personal';

  const setWorkspaceViewportLeft = React.useCallback((width: number, isCollapsed = collapsed) => {
    const left = isCollapsed ? 68 : width + 16;
    document.documentElement.style.setProperty('--workspace-viewport-left', `${left}px`);
    document.documentElement.style.setProperty('--workspace-viewport-top', '8px');
    document.documentElement.style.setProperty('--workspace-viewport-right', '8px');
    document.documentElement.style.setProperty('--workspace-viewport-bottom', '8px');
  }, [collapsed]);

  React.useEffect(() => {
    setWorkspaceViewportLeft(sidebarWidth);
  }, [setWorkspaceViewportLeft, sidebarWidth]);

  const toggleSection = (id: string, open: boolean) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const revealSection = (id: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    onToggleCollapse();
  };

  const toggleAgentFavorite = (agent: SidebarAgentTarget) => {
    const key = getAgentKey(agent);
    setFavoriteAgentKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(AGENT_FAVORITES_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  };

  if (collapsed) {
    return (
      <aside
        data-sidebar-panel
        className="sidebar-collapsed-panel m-2 flex h-[calc(100%-1rem)] w-[52px] shrink-0 flex-col items-center gap-1 overflow-visible rounded-xl rounded-tl-none border border-border bg-card/45 py-2 text-card-foreground shadow-xl"
      >
        <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleCollapse} aria-label="Expand sidebar">
          <PanelLeft />
        </Button>
        <Separator />
        <SidebarRailButton icon={<Layers3 />} title="Switch workspace" onClick={onOpenWorkspaceGrid || onCreateWorkspace} />
        <SidebarRailButton icon={<Plus />} title="Create workspace" onClick={onCreateWorkspace} />
        <SidebarRailButton icon={<Settings />} title="Workspace settings" onClick={onOpenSettings} />
        <Separator />
        <SidebarRailButton icon={<Search />} title="Search" onClick={onOpenCommandPalette} />
        <SidebarRailButton icon={<MessageSquare />} title="Threads" count={threadSessions.length} onClick={() => revealSection('threads')} />
        <SidebarRailButton icon={<Hash />} title="Channels" count={activeChannelSessions.length} onClick={() => revealSection('channels')} />
        <SidebarRailButton icon={<FileText />} title="Documents" count={uniqueRecents.length} onClick={() => revealSection('documents')} />
        <SidebarRailButton icon={<Bot />} title="Direct messages" count={directMessageTargets.length} onClick={() => revealSection('direct-messages')} />
        <SidebarRailButton icon={<Archive />} title="Archive" count={archivedSessions.length} onClick={() => revealSection('archive')} />
        {onOpenTasks && <SidebarRailButton icon={<RotateCcw />} title="Tasks" count={openTaskCount} onClick={onOpenTasks} />}
        <SidebarRailButton icon={<Brain />} title="Memory" onClick={onOpenMemory} />
        {onOpenActivity && <SidebarRailButton icon={<RotateCcw />} title="Activity" onClick={onOpenActivity} />}
        {onOpenAgents && <SidebarRailButton icon={<Bot />} title="Agents" count={agents.length} onClick={onOpenAgents} />}
        {onOpenTemplates && <SidebarRailButton icon={<LayoutTemplate />} title="Applets" onClick={onOpenTemplates} />}
        <div className="flex-1" />
        <SidebarRailButton icon={<Settings />} title="App settings" onClick={onOpenSettings} />
        <SidebarRailButton icon={<LogOut />} title="Sign out" onClick={onSignOut} />
      </aside>
    );
  }

  const handleResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    let latestWidth = sidebarWidth;

    const handleMove = (event: PointerEvent) => {
      if (!resizeRef.current) return;
      const next = resizeRef.current.startWidth + event.clientX - resizeRef.current.startX;
      latestWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next));
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        sidebarRef.current?.style.setProperty('width', `${latestWidth}px`);
        setWorkspaceViewportLeft(latestWidth, false);
        resizeFrameRef.current = null;
      });
    };

    const handleUp = () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      sidebarRef.current?.style.setProperty('width', `${latestWidth}px`);
      setWorkspaceViewportLeft(latestWidth, false);
      setSidebarWidth(latestWidth);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(latestWidth)));
      resizeRef.current = null;
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  };

  return (
    <aside
      ref={sidebarRef}
      data-sidebar-panel
      className="m-2 relative flex h-[calc(100%-1rem)] shrink-0 flex-col overflow-hidden rounded-xl rounded-tl-none border border-border bg-card/45 text-card-foreground shadow-xl"
      style={{ width: sidebarWidth }}
    >
      <div className="px-2 pt-2 pb-3">
        <div className="sidebar-workspace-pill flex min-w-0 w-full items-center gap-1 rounded-lg border border-border bg-popover/60 p-1 shadow-sm">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleCollapse} aria-label="Collapse sidebar">
            <PanelLeftClose />
          </Button>
          <button
            type="button"
            className="sidebar-workspace-switch flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpenWorkspaceGrid || onCreateWorkspace}
            aria-label="Switch workspace"
          >
            <span className="min-w-0 truncate text-left">{workspaceLabel}</span>
          </button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onCreateWorkspace} aria-label="Create workspace">
            <Plus />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onOpenSettings} aria-label="Workspace settings">
            <Settings />
          </Button>
        </div>
      </div>

      <div className="px-2 pb-2">
        <button
          type="button"
          className="sidebar-search flex min-h-8 min-w-0 w-full items-center gap-2 rounded-md border px-2.5 text-left text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpenCommandPalette}
        >
          <Search className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">Search...</span>
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 [&_[data-radix-scroll-area-viewport]>div]:!block">
        <div className="flex flex-col gap-1 pb-2">
            <SidebarSection
              id="threads"
              label="Threads"
              icon={<MessageSquare />}
              count={threadSessions.length}
              open={openSections.has('threads')}
              onOpenChange={open => toggleSection('threads', open)}
            >
              {groupedThreadSessions.map(group => (
                group.folder === 'General' ? (
                  group.sessions.slice(0, 8).map(session => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      icon={<MessageSquare />}
                      archiveNoun="thread"
                      onOpen={() => onSessionOpen(session)}
                      onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
                      onArchive={() => onSessionArchive?.(session.id, true)}
                      presenceUsers={chatPresence[session.id] || []}
                    />
                  ))
                ) : (
                  <SidebarFolderGroup
                    key={group.folder}
                    id={`threads-folder:${group.folder}`}
                    label={group.folder}
                    count={group.sessions.length}
                    open={openSections.has(`threads-folder:${group.folder}`)}
                    onOpenChange={open => toggleSection(`threads-folder:${group.folder}`, open)}
                  >
                    {group.sessions.slice(0, 8).map(session => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        icon={<MessageSquare />}
                        archiveNoun="thread"
                        onOpen={() => onSessionOpen(session)}
                        onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
                        onArchive={() => onSessionArchive?.(session.id, true)}
                        presenceUsers={chatPresence[session.id] || []}
                      />
                    ))}
                  </SidebarFolderGroup>
                )
              ))}
            </SidebarSection>
            <SidebarSection
              id="channels"
              label="Channels"
              icon={<Hash />}
              count={activeChannelSessions.length}
              actionLabel="New channel"
              onAction={onNewChat}
              open={openSections.has('channels')}
              onOpenChange={open => toggleSection('channels', open)}
            >
              {groupedSessions.map(group => (
                group.folder === 'General' ? (
                  group.sessions.slice(0, 8).map(session => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      icon={<Hash />}
                      onOpen={() => onSessionOpen(session)}
                      onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
                      onArchive={() => onSessionArchive?.(session.id, true)}
                      presenceUsers={chatPresence[session.id] || []}
                    />
                  ))
                ) : (
                  <SidebarFolderGroup
                    key={group.folder}
                    id={`channels-folder:${group.folder}`}
                    label={group.folder}
                    count={group.sessions.length}
                    open={openSections.has(`channels-folder:${group.folder}`)}
                    onOpenChange={open => toggleSection(`channels-folder:${group.folder}`, open)}
                  >
                    {group.sessions.slice(0, 8).map(session => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        icon={<Hash />}
                        onOpen={() => onSessionOpen(session)}
                        onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
                        onArchive={() => onSessionArchive?.(session.id, true)}
                        presenceUsers={chatPresence[session.id] || []}
                      />
                    ))}
                  </SidebarFolderGroup>
                )
              ))}
            </SidebarSection>
            <SidebarSection
              id="documents"
              label="Documents"
              icon={<FileText />}
              count={uniqueRecents.length}
              actionLabel="New document"
              onAction={onNewDocument}
              open={openSections.has('documents')}
              onOpenChange={open => toggleSection('documents', open)}
            >
              {groupedDocuments.map(group => (
                group.folder === 'General' ? (
                  group.documents.map(doc => (
                    <DocumentRow
                      key={doc.id}
                      doc={doc}
                      onOpen={() => onDocumentOpen(doc)}
                      onMoveFolder={folder => onDocumentUpdate?.(doc.id, { folder })}
                      presenceUsers={documentPresence[doc.id] || []}
                    />
                  ))
                ) : (
                  <SidebarFolderGroup
                    key={group.folder}
                    id={`docs-folder:${group.folder}`}
                    label={group.folder}
                    count={group.documents.length}
                    open={openSections.has(`docs-folder:${group.folder}`)}
                    onOpenChange={open => toggleSection(`docs-folder:${group.folder}`, open)}
                  >
                    {group.documents.map(doc => (
                      <DocumentRow
                        key={doc.id}
                        doc={doc}
                        onOpen={() => onDocumentOpen(doc)}
                        onMoveFolder={folder => onDocumentUpdate?.(doc.id, { folder })}
                        presenceUsers={documentPresence[doc.id] || []}
                      />
                    ))}
                  </SidebarFolderGroup>
                )
              ))}
            </SidebarSection>
            <SidebarSection
              id="direct-messages"
              label="Direct messages"
              icon={<Bot />}
              count={directMessageTargets.length}
              open={openSections.has('direct-messages')}
              onOpenChange={open => toggleSection('direct-messages', open)}
            >
              {directMessageTargets.map(agent => (
                <DirectAgentRow
                  key={getAgentKey(agent)}
                  agent={agent}
                  favorite={favoriteAgentKeys.has(getAgentKey(agent))}
                  onMessage={() => {
                    if (agent.session) {
                      onSessionOpen(agent.session);
                      return;
                    }
                    onAgentMessage?.(agent);
                  }}
                  onProfile={() => onAgentProfile?.(agent)}
                  onCopyMention={() => copyAgentMention(agent)}
                  onToggleFavorite={() => toggleAgentFavorite(agent)}
                />
              ))}
            </SidebarSection>
            <SidebarSection
              id="archive"
              label="Archive"
              icon={<Archive />}
              count={archivedSessions.length}
              open={openSections.has('archive')}
              onOpenChange={open => toggleSection('archive', open)}
            >
              {archivedSessions.slice(0, 8).map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  archived
                  onOpen={() => onSessionOpen(session)}
                  onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
                  onArchive={() => onSessionArchive?.(session.id, false)}
                  presenceUsers={chatPresence[session.id] || []}
                />
              ))}
            </SidebarSection>
            {onOpenTasks && <ActionTile icon={<RotateCcw />} label="Tasks" count={openTaskCount} active={focusedWindowType === 'tasks'} onClick={onOpenTasks} />}
            <ActionTile icon={<Brain />} label="Memory" active={focusedWindowType === 'memory'} onClick={onOpenMemory} />
            {onOpenActivity && <ActionTile icon={<RotateCcw />} label="Activity" active={focusedWindowType === 'activity'} onClick={onOpenActivity} />}
            {onOpenAgents && <ActionTile icon={<Bot />} label="Agents" count={agents.length} active={focusedWindowType === 'agents'} onClick={onOpenAgents} />}
            {onOpenTemplates && <ActionTile icon={<LayoutTemplate />} label="Applets" onClick={onOpenTemplates} />}
        </div>
      </ScrollArea>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border p-2">
        <div className="flex items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback>{userInitial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{userEmail}</div>
          </div>
          <ThemeToggle mode={themeMode} onModeChange={onThemeChange} />
          <Button type="button" variant="ghost" size="icon-sm" onClick={onOpenSettings} aria-label="App settings">
            <Settings className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onSignOut} aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className="absolute top-0 right-0 bottom-0 z-10 w-3 cursor-col-resize touch-none"
        onPointerDown={handleResizeStart}
      />
    </aside>
  );
}

function normalizeSectionName(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function uniqueById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function groupSessionsByFolder(sessions: ChatSession[], sectionName?: string) {
  const folderNames = Array.from(new Set(sessions.map(session => getSessionFolder(session, sectionName))));
  return folderNames.map(folder => ({
    folder,
    sessions: sessions.filter(session => getSessionFolder(session, sectionName) === folder),
  }));
}

function groupDocumentsByFolder(documents: Document[]) {
  const folderNames = Array.from(new Set(documents.map(doc => doc.folder || 'General')));
  return folderNames.map(folder => ({
    folder,
    documents: documents.filter(doc => (doc.folder || 'General') === folder),
  }));
}

function getSessionFolder(session: ChatSession, sectionName?: string) {
  const folder = session.folder?.trim() || 'General';
  return sectionName && normalizeSectionName(folder) === normalizeSectionName(sectionName) ? 'General' : folder;
}

function directAgentParticipantForSession(session?: ChatSession | null) {
  const participants = Array.isArray(session?.participants) ? session.participants : [];
  const agentParticipants = participants.filter(participant =>
    participant?.kind === 'agent' && (participant.agent_id || participant.handle || participant.name)
  );
  if (agentParticipants.length === 0) return null;
  return agentParticipants.find(participant => participant.direct) || (agentParticipants.length === 1 ? agentParticipants[0] : null);
}

function getParticipantAvatar(participant: ReturnType<typeof directAgentParticipantForSession>) {
  if (!participant || typeof participant !== 'object') return null;
  const record = participant as unknown as Record<string, unknown>;
  const value = record.avatar ?? record.avatar_url ?? record.image ?? record.icon;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isDirectSession(session: ChatSession) {
  if (directAgentParticipantForSession(session)) return true;
  if (session.folder === 'Direct messages') return true;
  const participants = Array.isArray(session.participants) ? session.participants : [];
  const agentParticipants = participants.filter(participant => participant.kind === 'agent');
  if (agentParticipants.length !== 1) return false;
  const personParticipants = participants.filter(participant => participant.kind === 'user');
  return personParticipants.length <= 1;
}

function isThreadSession(session: ChatSession) {
  const record = session as unknown as Record<string, unknown>;
  const folder = normalizeSectionName(session.folder);
  if (folder === 'thread' || folder === 'threads') return true;
  if (['thread', 'threads'].includes(normalizeSectionName(record.kind))) return true;
  if (['thread', 'threads'].includes(normalizeSectionName(record.type))) return true;
  if (['thread', 'threads'].includes(normalizeSectionName(record.category))) return true;
  return [
    'thread_parent_id',
    'threadParentId',
    'parent_message_id',
    'parentMessageId',
    'parent_thread_id',
    'parentThreadId',
  ].some(key => Boolean(record[key]));
}

function normalizeHandle(handle: string | null | undefined) {
  const next = handle?.trim().replace(/^@+/, '');
  return next || null;
}

function getAgentKey(agent: SidebarAgentTarget) {
  return (agent.agentId || agent.handle || agent.id).toLowerCase();
}

function getStatusRank(status: SidebarAgentTarget['status']) {
  if (status === 'online') return 0;
  if (status === 'busy') return 1;
  return 2;
}

function buildDirectAgents(
  agents: WorkspaceAgent[],
  connections: AgentConnection[],
  favoriteKeys: Set<string>,
): SidebarAgentTarget[] {
  const byKey = new Map<string, SidebarAgentTarget>();
  const aliases = new Map<string, string>();

  const getAliases = (agent: SidebarAgentTarget) => {
    const keys = new Set<string>();
    keys.add(getAgentKey(agent));
    if (agent.agentId) keys.add(`id:${agent.agentId.toLowerCase()}`);
    if (agent.handle) keys.add(`handle:${agent.handle.toLowerCase()}`);
    if (agent.name) keys.add(`name:${agent.name.trim().toLowerCase()}`);
    return Array.from(keys);
  };

  const findKey = (agent: SidebarAgentTarget) => {
    for (const alias of getAliases(agent)) {
      const existingKey = aliases.get(alias);
      if (existingKey) return existingKey;
    }
    return getAgentKey(agent);
  };

  const upsert = (agent: SidebarAgentTarget) => {
    const key = findKey(agent);
    const previous = byKey.get(key);
    const next: SidebarAgentTarget = {
      ...previous,
      ...agent,
      agentId: previous?.agentId || agent.agentId,
      handle: previous?.handle || agent.handle,
      avatar: previous?.avatar || agent.avatar,
      runMode: previous?.runMode || agent.runMode,
      status: getStatusRank(agent.status) < getStatusRank(previous?.status) ? agent.status : previous?.status,
    };
    byKey.set(key, next);
    for (const alias of getAliases(next)) aliases.set(alias, key);
  };

  for (const agent of agents) {
    const handle = normalizeHandle(agent.handle) || normalizeHandle(agent.name);
    upsert({
      id: agent.id,
      agentId: agent.id,
      name: agent.name || handle || 'Agent',
      handle,
      avatar: agent.avatar,
      runMode: agent.run_mode,
    });
  }

  for (const connection of connections) {
    const handle = normalizeHandle(connection.handle);
    const key = (connection.agent_id || handle || connection.id).toLowerCase();
    const existing = byKey.get(key) || (handle ? Array.from(byKey.values()).find(agent => agent.handle?.toLowerCase() === handle.toLowerCase()) : undefined);
    const merged: SidebarAgentTarget = {
      id: existing?.id || connection.agent_id || connection.id,
      agentId: connection.agent_id || existing?.agentId || null,
      name: existing?.name || connection.name || handle || 'Agent',
      handle: existing?.handle || handle,
      avatar: existing?.avatar,
      status: connection.status,
      runMode: existing?.runMode || 'daemon',
    };
    upsert(merged);
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const favoriteDelta = Number(favoriteKeys.has(getAgentKey(b))) - Number(favoriteKeys.has(getAgentKey(a)));
    if (favoriteDelta !== 0) return favoriteDelta;
    const statusDelta = getStatusRank(a.status) - getStatusRank(b.status);
    if (statusDelta !== 0) return statusDelta;
    return a.name.localeCompare(b.name);
  });
}

function buildDirectMessageTargets(
  directSessions: ChatSession[],
  directAgents: SidebarAgentTarget[],
  favoriteKeys: Set<string>,
): SidebarMessageTarget[] {
  const byKey = new Map<string, SidebarMessageTarget>();
  const aliases = new Map<string, string>();

  const getAliases = (agent: SidebarMessageTarget) => {
    const keys = new Set<string>();
    keys.add(getAgentKey(agent));
    if (agent.agentId) keys.add(`id:${agent.agentId.toLowerCase()}`);
    if (agent.handle) keys.add(`handle:${agent.handle.toLowerCase()}`);
    if (agent.name) keys.add(`name:${agent.name.trim().toLowerCase()}`);
    return Array.from(keys);
  };

  const findKey = (agent: SidebarMessageTarget) => {
    for (const alias of getAliases(agent)) {
      const existingKey = aliases.get(alias);
      if (existingKey) return existingKey;
    }
    return getAgentKey(agent);
  };

  const upsert = (agent: SidebarMessageTarget) => {
    const key = findKey(agent);
    const previous = byKey.get(key);
    const next: SidebarMessageTarget = {
      ...previous,
      ...agent,
      id: previous?.id || agent.id,
      agentId: previous?.agentId || agent.agentId,
      handle: previous?.handle || agent.handle,
      avatar: previous?.avatar || agent.avatar,
      runMode: previous?.runMode || agent.runMode,
      session: previous?.session || agent.session,
      status: getStatusRank(agent.status) < getStatusRank(previous?.status) ? agent.status : previous?.status,
    };
    byKey.set(key, next);
    for (const alias of getAliases(next)) aliases.set(alias, key);
  };

  directAgents.forEach(agent => upsert(agent));
  directSessions.forEach(session => upsert(buildDirectTargetFromSession(session)));

  return Array.from(byKey.values()).sort((a, b) => {
    const sessionDelta = Number(Boolean(b.session)) - Number(Boolean(a.session));
    if (sessionDelta !== 0) return sessionDelta;
    const favoriteDelta = Number(favoriteKeys.has(getAgentKey(b))) - Number(favoriteKeys.has(getAgentKey(a)));
    if (favoriteDelta !== 0) return favoriteDelta;
    const statusDelta = getStatusRank(a.status) - getStatusRank(b.status);
    if (statusDelta !== 0) return statusDelta;
    return a.name.localeCompare(b.name);
  });
}

function buildDirectTargetFromSession(session: ChatSession): SidebarMessageTarget {
  const participant = directAgentParticipantForSession(session);
  const handle = normalizeHandle(participant?.handle);
  const agentId = participant?.agent_id || null;
  return {
    id: agentId || handle || session.id,
    agentId,
    name: participant?.name || session.title || handle || 'Direct message',
    handle,
    avatar: getParticipantAvatar(participant),
    status: participant?.status as AgentConnection['status'] | undefined,
    session,
  };
}

function copyAgentMention(agent: SidebarAgentTarget) {
  const handle = normalizeHandle(agent.handle);
  if (!handle || typeof navigator === 'undefined') return;
  void navigator.clipboard?.writeText(`@${handle}`);
}

function DirectAgentRow({
  agent,
  favorite,
  onMessage,
  onProfile,
  onCopyMention,
  onToggleFavorite,
}: {
  agent: SidebarMessageTarget;
  favorite: boolean;
  onMessage: () => void;
  onProfile: () => void;
  onCopyMention: () => void;
  onToggleFavorite: () => void;
}) {
  const handle = normalizeHandle(agent.handle);
  const status = agent.status || 'offline';
  const statusColor = status === 'online' ? 'bg-emerald-500' : status === 'busy' ? 'bg-amber-500' : 'bg-muted-foreground/40';
  const avatar = agent.avatar || null;
  const avatarSrc = isImageAvatar(avatar) ? avatar : undefined;
  const profileEnabled = Boolean(agent.agentId || handle);

  return (
    <div className="sidebar-agent-row group flex min-w-0 w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground">
      <button
        type="button"
        className="sidebar-agent-primary min-w-0 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onMessage}
      >
        <span className="relative flex size-7 shrink-0 items-center justify-center">
          <Avatar size="default" className="size-7 rounded-md bg-muted">
            {avatarSrc && <AvatarImage src={avatarSrc} alt="" className="rounded-md" />}
            <AvatarFallback className="rounded-md">
              <Bot className="size-4" />
            </AvatarFallback>
          </Avatar>
          <span className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background ${statusColor}`} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-tight text-foreground">{agent.name}</span>
          <span className="block truncate text-xs leading-tight text-muted-foreground">
            {handle ? `@${handle}` : 'agent'}
          </span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 opacity-70 group-hover:opacity-100"
            aria-label={`More actions for ${agent.name}`}
            onClick={event => event.stopPropagation()}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={onMessage}>
            <MessageSquare data-icon="inline-start" />
            Message
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onProfile} disabled={!profileEnabled}>
            <UserRound data-icon="inline-start" />
            View profile
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCopyMention} disabled={!handle}>
            <Copy data-icon="inline-start" />
            Copy mention
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onToggleFavorite}>
            <Star data-icon="inline-start" />
            {favorite ? 'Remove favorite' : 'Add to favorites'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SidebarRailButton({
  icon,
  title,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="sidebar-rail-button relative"
      onClick={onClick}
      aria-label={title}
      title={typeof count === 'number' && count > 0 ? `${title} (${count})` : title}
    >
      {icon}
      <span className="sidebar-rail-label">{title}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="sidebar-rail-count">{formatCount(count)}</span>
      )}
    </Button>
  );
}

function formatCount(count: number) {
  return count > 99 ? '99+' : String(count);
}

function ActionTile({
  icon,
  label,
  count,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="sidebar-action-row flex min-w-0 w-full items-center overflow-hidden rounded-md text-left text-sm font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      data-active={active ? 'true' : undefined}
      onClick={onClick}
    >
      <span className="sidebar-item-icon flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="sidebar-action-label min-w-0 truncate text-left">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="sidebar-action-count min-w-[1.25rem] rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-primary-foreground">
          {formatCount(count)}
        </span>
      )}
    </button>
  );
}

function SidebarSection({
  id,
  label,
  icon,
  count,
  actionLabel,
  onAction,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  count: number;
  actionLabel?: string;
  onAction?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const hasAction = Boolean(actionLabel && onAction);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="pt-2">
      <div className="sidebar-section-header">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="sidebar-section-trigger flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-controls={`${id}-content`}
          >
            <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
            <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
              {icon}
            </span>
            <span className="sidebar-section-label min-w-0 truncate text-left">{label}</span>
            {!hasAction && count > 0 && (
              <span className="sidebar-section-count min-w-[1.25rem] rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-primary-foreground">
                {formatCount(count)}
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        {hasAction && (
          <button
            type="button"
            className="sidebar-section-action"
            aria-label={actionLabel}
            title={actionLabel}
            onClick={(event) => {
              event.stopPropagation();
              onAction?.();
            }}
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
      <CollapsibleContent id={`${id}-content`} className="sidebar-section-content pt-1 pl-6">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SidebarFolderGroup({
  id,
  label,
  count,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  label: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="pt-1">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="sidebar-folder-trigger flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-controls={`${id}-content`}
        >
          <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <Folder className="size-4 shrink-0" />
          <span className="sidebar-section-label min-w-0 truncate text-left">{label}</span>
          {count > 0 && (
            <span className="sidebar-section-count min-w-[1.25rem] rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-primary-foreground">
              {formatCount(count)}
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent id={`${id}-content`} className="pt-1 pl-5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ItemRow({
  icon,
  label,
  onClick,
  kind = 'item',
  presenceUsers = [],
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  kind?: 'item' | 'session' | 'document';
  presenceUsers?: ItemPresenceUser[];
}) {
  return (
    <button
      type="button"
      className={`sidebar-item-row sidebar-item-row-${kind} flex min-w-0 w-full items-center overflow-hidden rounded-md text-left text-sm font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring`}
      onClick={onClick}
    >
      <span className="sidebar-item-icon flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="sidebar-item-label min-w-0 truncate text-left">{label}</span>
      {presenceUsers.length > 0 && (
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {presenceUsers.slice(0, 3).map(person => (
            <span
              key={person.userId}
              className="size-2 rounded-full ring-1 ring-background"
              style={{ backgroundColor: person.color }}
              title={`${person.name}${person.typing ? ' is typing' : ' is active'}`}
            />
          ))}
          {presenceUsers.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{presenceUsers.length - 3}</span>
          )}
        </span>
      )}
    </button>
  );
}

const ITEM_FOLDERS = ['General', 'Work', 'Research', 'Drafts', 'Ideas', 'Webhooks'];

function SessionRow({
  session,
  archived = false,
  icon,
  archiveNoun = 'channel',
  onOpen,
  onMoveFolder,
  onArchive,
  presenceUsers = [],
}: {
  session: ChatSession;
  archived?: boolean;
  icon?: React.ReactNode;
  archiveNoun?: string;
  onOpen: () => void;
  onMoveFolder: (folder: string) => void;
  onArchive: () => void;
  presenceUsers?: ItemPresenceUser[];
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="min-w-0 w-full">
          <ItemRow
            icon={archived ? <Archive /> : icon || <MessageSquare />}
            label={session.title}
            onClick={onOpen}
            kind="session"
            presenceUsers={presenceUsers}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{session.title}</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Folder data-icon="inline-start" />
            Move to folder
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {ITEM_FOLDERS.map(folder => (
              <ContextMenuItem key={folder} onSelect={() => onMoveFolder(folder)}>
                {folder}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={onArchive}>
          {archived ? <RotateCcw data-icon="inline-start" /> : <Archive data-icon="inline-start" />}
          {archived ? `Unarchive ${archiveNoun}` : `Archive ${archiveNoun}`}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function DocumentRow({
  doc,
  onOpen,
  onMoveFolder,
  presenceUsers = [],
}: {
  doc: Document;
  onOpen: () => void;
  onMoveFolder: (folder: string) => void;
  presenceUsers?: ItemPresenceUser[];
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="min-w-0 w-full">
          <ItemRow
            icon={<FileText />}
            label={doc.title}
            onClick={onOpen}
            kind="document"
            presenceUsers={presenceUsers}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{doc.title}</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Folder data-icon="inline-start" />
            Move to folder
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {ITEM_FOLDERS.map(folder => (
              <ContextMenuItem key={folder} onSelect={() => onMoveFolder(folder)}>
                {folder}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
