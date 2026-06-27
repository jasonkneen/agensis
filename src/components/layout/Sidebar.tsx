import React from 'react';
import {
  Activity,
  Archive,
  Bot,
  Brain,
  CheckCircle2,
  FileText,
  Folder,
  FolderPlus,
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
import type { ChatSession, Document, FloatingWindow, Workspace } from '../../types';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
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
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenCommandPalette: () => void;
  onNewChat: () => void;
  onNewDocument: () => void;
  onUploadFile: () => void;
  onCreateWorkspace: () => void;
  onDocumentOpen: (doc: Document) => void;
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
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  userEmail: string;
  onSignOut: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  workspace,
  collapsed,
  onToggleCollapse,
  onOpenCommandPalette,
  onNewChat,
  onNewDocument,
  onUploadFile,
  onCreateWorkspace,
  onDocumentOpen,
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
  const userInitial = (userEmail[0] || 'U').toUpperCase();
  const activeSessions = sessions.filter(session => !session.archived_at);
  const archivedSessions = sessions.filter(session => session.archived_at);
  const folderNames = Array.from(new Set(activeSessions.map(session => session.folder || 'General')));
  const groupedSessions = folderNames.map(folder => ({
    folder,
    sessions: activeSessions.filter(session => (session.folder || 'General') === folder),
  }));

  if (collapsed) {
    return (
      <aside className="flex h-full w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleCollapse} aria-label="Expand sidebar">
          <PanelLeft />
        </Button>
        <Separator />
        <IconButton icon={<Search />} title="Search" onClick={onOpenCommandPalette} />
        <IconButton icon={<Sparkles />} title="New Chat" onClick={onNewChat} />
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
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-card text-card-foreground"
      style={{ width: sidebarWidth }}
    >
      <div className="flex items-center gap-2 p-2">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleCollapse} aria-label="Collapse sidebar">
          <PanelLeftClose />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="sidebar-search min-w-0 flex-1 justify-start text-muted-foreground"
          onClick={onOpenCommandPalette}
        >
          <Search data-icon="inline-start" />
          <span className="truncate">Search...</span>
        </Button>
      </div>

      <nav className="flex flex-col gap-1 px-2 pb-2">
        <ActionRow icon={<Sparkles />} label="Chat with AI" onClick={onNewChat} />
        <ActionRow icon={<FileText />} label="Write a document" onClick={onNewDocument} />
        <ActionRow icon={<Paperclip />} label="Upload a file" onClick={onUploadFile} />
        <ActionRow icon={<FolderPlus />} label="Create a workspace" onClick={onCreateWorkspace} />
        <ActionRow icon={<Brain />} label="Memory" onClick={onOpenMemory} />
        {onOpenTasks && <ActionRow icon={<CheckCircle2 />} label={openTaskCount > 0 ? `Tasks / ${openTaskCount}` : 'Tasks'} onClick={onOpenTasks} />}
        {onOpenActivity && <ActionRow icon={<Activity />} label="Activity" onClick={onOpenActivity} />}
        {onOpenAgents && <ActionRow icon={<Bot />} label="AI Agents" onClick={onOpenAgents} />}
        {onOpenTemplates && <ActionRow icon={<LayoutTemplate />} label="Canvas Apps" onClick={onOpenTemplates} />}
      </nav>

      <ScrollArea className="min-h-0 flex-1 px-2">
        {recents.length === 0 && sessions.length === 0 ? (
          <Empty className="min-h-40 border-0 p-4">
            <EmptyHeader>
              <EmptyTitle>No items yet</EmptyTitle>
              <EmptyDescription>Create your first document or chat.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1 pb-2">
            {groupedSessions.map(group => (
              <div key={group.folder}>
                <SectionLabel label={group.folder === 'General' ? 'Chats' : group.folder} />
                {group.sessions.slice(0, 8).map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    onOpen={() => onSessionOpen(session)}
                    onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
                    onArchive={() => onSessionArchive?.(session.id, true)}
                  />
                ))}
              </div>
            ))}
            {archivedSessions.length > 0 && (
              <div>
                <SectionLabel label="Archived" />
                {archivedSessions.slice(0, 6).map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    archived
                    onOpen={() => onSessionOpen(session)}
                    onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
                    onArchive={() => onSessionArchive?.(session.id, false)}
                  />
                ))}
              </div>
            )}
            {recents.length > 0 && <SectionLabel label="Documents" />}
            {recents.slice(0, 6).map(doc => (
                <ItemRow
                  key={doc.id}
                  icon={<FileText />}
                  label={doc.title}
                  onClick={() => onDocumentOpen(doc)}
                  kind="document"
                />
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
          <Button type="button" variant="ghost" size="icon-xs" onClick={onOpenSettings} aria-label="Settings">
            <Settings />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onSignOut} aria-label="Sign out">
            <LogOut />
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

function ActionRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="sidebar-action-row w-full justify-start" onClick={onClick}>
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
      {label}
    </div>
  );
}

function ItemRow({
  icon,
  label,
  onClick,
  kind = 'item',
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  kind?: 'item' | 'session' | 'document';
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`sidebar-item-row sidebar-item-row-${kind} w-full justify-start text-muted-foreground`}
      onClick={onClick}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}

const CHAT_FOLDERS = ['General', 'Work', 'Research', 'Drafts', 'Ideas', 'Webhooks'];

function SessionRow({
  session,
  archived = false,
  onOpen,
  onMoveFolder,
  onArchive,
}: {
  session: ChatSession;
  archived?: boolean;
  onOpen: () => void;
  onMoveFolder: (folder: string) => void;
  onArchive: () => void;
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
            {CHAT_FOLDERS.map(folder => (
              <ContextMenuItem key={folder} onSelect={() => onMoveFolder(folder)}>
                {folder}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={onArchive}>
          {archived ? <RotateCcw data-icon="inline-start" /> : <Archive data-icon="inline-start" />}
          {archived ? 'Unarchive chat' : 'Archive chat'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
