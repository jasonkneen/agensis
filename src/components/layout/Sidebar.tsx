import React from 'react';
import {
  Activity,
  Archive,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Layers3,
  LayoutTemplate,
  LogOut,
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  Paperclip,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import type { ThemeMode } from '../../hooks/useTheme';
import type { ChatSession, Document, FloatingWindow, ItemPresenceUser, Workspace } from '../../types';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

const SIDEBAR_WIDTH_KEY = 'hatch_sidebar_width';
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 380;

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
  onOpenTemplates?: () => void;
  openTaskCount?: number;
  recents: Document[];
  sessions: ChatSession[];
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
  onUploadFile,
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
  onOpenTemplates,
  openTaskCount = 0,
  recents,
  sessions,
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
  const resizeRef = React.useRef<{ startX: number; startWidth: number } | null>(null);
  const [closedSections, setClosedSections] = React.useState<Set<string>>(() => new Set());
  const userInitial = (userEmail[0] || 'U').toUpperCase();
  const activeSessions = sessions.filter(session => !session.archived_at);
  const archivedSessions = sessions.filter(session => session.archived_at);
  const folderNames = Array.from(new Set(activeSessions.map(session => session.folder || 'General')));
  const groupedSessions = folderNames.map(folder => ({
    folder,
    sessions: activeSessions.filter(session => (session.folder || 'General') === folder),
  }));
  const documentFolderNames = Array.from(new Set(recents.map(doc => doc.folder || 'General')));
  const groupedDocuments = documentFolderNames.map(folder => ({
    folder,
    documents: recents.filter(doc => (doc.folder || 'General') === folder),
  }));
  const focusedWindow = floatingWindows
    .filter(win => !win.minimized)
    .reduce<FloatingWindow | null>((topWindow, win) => (
      !topWindow || win.zIndex > topWindow.zIndex ? win : topWindow
    ), null);
  const focusedWindowType = focusedWindow?.type;
  const workspaceLabel = activeLayerName || workspace?.name || 'Personal';

  const toggleSection = (id: string, open: boolean) => {
    setClosedSections(prev => {
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (collapsed) {
    return (
      <aside
        data-sidebar-panel
        className="m-2 flex h-[calc(100%-1rem)] w-[52px] shrink-0 flex-col items-center gap-1 overflow-hidden rounded-xl border border-border bg-card py-2 text-card-foreground shadow-xl"
      >
        <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleCollapse} aria-label="Expand sidebar">
          <PanelLeft />
        </Button>
        <Separator />
        <IconButton icon={<Search />} title="Search" onClick={onOpenCommandPalette} />
        <IconButton icon={<Sparkles />} title="New Channel" onClick={onNewChat} />
        <IconButton icon={<FileText />} title="New Document" onClick={onNewDocument} />
        {onOpenTasks && <IconButton icon={<CheckCircle2 />} title={`Tasks${openTaskCount ? ` (${openTaskCount})` : ''}`} onClick={onOpenTasks} />}
        {onOpenActivity && <IconButton icon={<Activity />} title="Activity" onClick={onOpenActivity} />}
        {onOpenAgents && <IconButton icon={<Bot />} title="AI Agents" onClick={onOpenAgents} />}
        {onOpenTemplates && <IconButton icon={<LayoutTemplate />} title="Canvas Apps" onClick={onOpenTemplates} />}
        <IconButton icon={<Brain />} title="Memory" onClick={onOpenMemory} />
        <div className="flex-1" />
        <IconButton icon={<LogOut />} title="Sign out" onClick={onSignOut} />
      </aside>
    );
  }

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    let latestWidth = sidebarWidth;

    const handleMove = (event: MouseEvent) => {
      if (!resizeRef.current) return;
      const next = resizeRef.current.startWidth + event.clientX - resizeRef.current.startX;
      latestWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next));
      setSidebarWidth(latestWidth);
    };

    const handleUp = () => {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(latestWidth)));
      resizeRef.current = null;
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  };

  return (
    <aside
      data-sidebar-panel
      className="m-2 relative flex h-[calc(100%-1rem)] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl"
      style={{ width: sidebarWidth }}
    >
      <div className="px-2 pt-2 pb-3">
        <div className="sidebar-workspace-pill flex min-w-0 w-full items-center gap-1 rounded-lg border border-border bg-popover/95 p-1 shadow-sm">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleCollapse} aria-label="Collapse sidebar">
            <PanelLeftClose />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start px-2"
            onClick={onOpenWorkspaceGrid}
            title="Show all workspaces"
          >
            <Layers3 data-icon="inline-start" />
            <span className="truncate">{workspaceLabel}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSettings}
            aria-label="Workspace settings"
            title="Workspace settings"
          >
            <Settings />
          </Button>
        </div>
      </div>

      <div className="px-2 pb-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="sidebar-search min-w-0 w-full justify-start text-muted-foreground"
          onClick={onOpenCommandPalette}
        >
          <Search data-icon="inline-start" />
          <span className="truncate">Search...</span>
        </Button>
      </div>

      <nav className="flex flex-col gap-1 px-2 pb-2">
        <ActionRow icon={<Sparkles />} label="Open channel" active={focusedWindowType === 'chat'} onClick={onNewChat} />
        <ActionRow icon={<FileText />} label="Write a document" active={focusedWindowType === 'document'} onClick={onNewDocument} />
        <ActionRow icon={<Paperclip />} label="Upload a file" onClick={onUploadFile} />
        <ActionRow icon={<FolderPlus />} label="Create a workspace" onClick={onCreateWorkspace} />
        <ActionRow icon={<Brain />} label="Memory" active={focusedWindowType === 'memory'} onClick={onOpenMemory} />
        {onOpenTasks && <ActionRow icon={<CheckCircle2 />} label="Tasks" count={openTaskCount} active={focusedWindowType === 'tasks'} onClick={onOpenTasks} />}
        {onOpenActivity && <ActionRow icon={<Activity />} label="Activity" active={focusedWindowType === 'activity'} onClick={onOpenActivity} />}
        {onOpenAgents && <ActionRow icon={<Bot />} label="AI Agents" active={focusedWindowType === 'agents'} onClick={onOpenAgents} />}
        {onOpenTemplates && <ActionRow icon={<LayoutTemplate />} label="Canvas Apps" onClick={onOpenTemplates} />}
      </nav>

      <ScrollArea className="min-h-0 flex-1 px-2">
        {recents.length === 0 && sessions.length === 0 ? (
          <Empty className="min-h-40 border-0 p-4">
            <EmptyHeader>
              <EmptyTitle>No items yet</EmptyTitle>
              <EmptyDescription>Create your first document or channel.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1 pb-2">
            {groupedSessions.map(group => (
              <SidebarSection
                key={group.folder}
                id={`chats:${group.folder}`}
                label={group.folder === 'General' ? 'Channels' : group.folder}
                icon={group.folder === 'General' ? <MessageSquare /> : <Folder />}
                count={group.sessions.length}
                open={!closedSections.has(`chats:${group.folder}`)}
                onOpenChange={open => toggleSection(`chats:${group.folder}`, open)}
              >
                {group.sessions.slice(0, 8).map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    onOpen={() => onSessionOpen(session)}
                    onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
                    onArchive={() => onSessionArchive?.(session.id, true)}
                    presenceUsers={chatPresence[session.id] || []}
                  />
                ))}
              </SidebarSection>
            ))}
            {archivedSessions.length > 0 && (
              <SidebarSection
                id="archived"
                label="Archived"
                icon={<Archive />}
                count={archivedSessions.length}
                open={!closedSections.has('archived')}
                onOpenChange={open => toggleSection('archived', open)}
              >
                {archivedSessions.slice(0, 6).map(session => (
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
            )}
            {groupedDocuments.map(group => (
              <SidebarSection
                key={`docs-${group.folder}`}
                id={`docs:${group.folder}`}
                label={group.folder === 'General' ? 'Documents' : `Documents / ${group.folder}`}
                icon={group.folder === 'General' ? <FileText /> : <Folder />}
                count={group.documents.length}
                open={!closedSections.has(`docs:${group.folder}`)}
                onOpenChange={open => toggleSection(`docs:${group.folder}`, open)}
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
              </SidebarSection>
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border p-2">
        <ThemeToggle mode={themeMode} onModeChange={onThemeChange} />
        <div className="flex items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback>{userInitial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{userEmail}</div>
            <div className="truncate text-xs text-muted-foreground">{workspace?.name || 'Personal'}</div>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onOpenSettings} aria-label="Settings">
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
        className="absolute top-0 right-0 bottom-0 z-10 w-2 cursor-col-resize touch-none"
        onMouseDown={handleResizeStart}
      />
    </aside>
  );
}

function IconButton({ icon, title, onClick }: { icon: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" onClick={onClick} aria-label={title} title={title}>
      {icon}
    </Button>
  );
}

function ActionRow({
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
    <Button
      type="button"
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      className="sidebar-action-row w-full justify-start"
      data-active={active ? 'true' : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="truncate">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className="sidebar-action-count ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary">
          {count}
        </span>
      )}
    </Button>
  );
}

function SidebarSection({
  id,
  label,
  icon,
  count,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="pt-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="sidebar-section-trigger flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-controls={`${id}-content`}
        >
          <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
            {icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
            {count}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent id={`${id}-content`} className="sidebar-section-content pt-1 pl-6">
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
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`sidebar-item-row sidebar-item-row-${kind} w-full justify-start text-muted-foreground`}
      onClick={onClick}
    >
      <span className="sidebar-item-icon flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="truncate">{label}</span>
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
    </Button>
  );
}

const ITEM_FOLDERS = ['General', 'Work', 'Research', 'Drafts', 'Ideas', 'Webhooks'];

function SessionRow({
  session,
  archived = false,
  onOpen,
  onMoveFolder,
  onArchive,
  presenceUsers = [],
}: {
  session: ChatSession;
  archived?: boolean;
  onOpen: () => void;
  onMoveFolder: (folder: string) => void;
  onArchive: () => void;
  presenceUsers?: ItemPresenceUser[];
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <ItemRow
            icon={archived ? <Archive /> : <MessageSquare />}
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
          {archived ? 'Unarchive channel' : 'Archive channel'}
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
        <div>
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
