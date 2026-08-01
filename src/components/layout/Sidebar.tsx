import { channelIconGlyph } from '../../lib/channelProfile';
import React from 'react';
import { createPortal } from 'react-dom';
import {
 Archive,
 AtSign,
 Bot,
 Users,
 Brain,
 ChevronRight,
 Clock,
 Code2,
 Copy,
 CreditCard,
 Database,
 FileText,
 Filter,
 Folder,
 GitMerge,
 Hash,
 Inbox,
 Layers3,
 Globe,
 LayoutTemplate,
 SquareTerminal,
 LogOut,
 MessageSquare,
 Minimize2,
 Sparkles,
 MoreHorizontal,
 Split,
 Trash2,
 Upload,
 PanelLeft,
 PanelLeftClose,
 Plus,
 RotateCcw,
 Search,
 Settings,
 Star,
 UserRound,
 Check,
  Zap,
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
import { AccountDialog } from '../account/AccountDialog';
import { AgentStatusFeed } from './AgentStatusFeed';
import { SessionWorkBadge } from '../chat/AgentWorkBadge';
import { APP_VERSION, BUILD_ID } from '../../lib/appVersion';
import { useAgentWorkFeed } from '../../hooks/useAgentWork';
import type { AgentStatusFeedState } from '../../hooks/useAgentStatusFeed';

/**
 * The sidebar panel clips its own content (`overflow-hidden`, for the rounded
 * neo-brutal corners) so the status bubble can't render inline — anything wide
 * enough to reach the edge gets cut off instead of "sticking out" onto the
 * canvas like a real speech bubble. Portal it to `document.body` and position
 * it with a measured rect off the sidebar's own ref instead.
 */
// Breathing room between the feed's bottom edge and the top of the sidebar
// footer (account / theme / settings row) so the bubble's shadow doesn't kiss
// the footer border.
const FEED_FOOTER_GAP = 6;

function AgentStatusFeedOverlay({
 anchorRef,
 footerRef,
 feed,
}: {
 anchorRef: React.RefObject<HTMLElement | null>;
 footerRef: React.RefObject<HTMLDivElement | null>;
 feed: AgentStatusFeedState;
}) {
 const [rect, setRect] = React.useState<{ left: number; bottom: number; width: number } | null>(null);

 // Keep the overlay mounted whenever there's something to show OR the feed is
 // muted — the muted state renders a restore pill (not a bubble), so we still
 // need a measured anchor rect even with no current update.
 const visible = !!feed.current || feed.muted;

 React.useEffect(() => {
  const el = anchorRef.current;
  if (!el || !visible) {
   setRect(null);
   return;
  }
  const measure = () => {
   const box = el.getBoundingClientRect();
   // Anchor the feed's BOTTOM edge to the TOP of the sidebar footer (the
   // account / theme / settings row), not the sidebar's own bottom. The
   // feed grows upward, so pinning it here keeps that control row fully
   // clear at every feed height. Anchoring to the sidebar bottom laid the
   // overlay — even the tiny muted "restore" pill — directly over those
   // controls, and its full-width pointer-events surface silently ate their
   // clicks. Fall back to the sidebar bottom if the footer isn't measured.
   const footer = footerRef.current;
   const bottom = footer
    ? window.innerHeight - footer.getBoundingClientRect().top + FEED_FOOTER_GAP
    : window.innerHeight - box.bottom;
   setRect({ left: box.left, bottom, width: box.width });
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(el);
  if (footerRef.current) observer.observe(footerRef.current);
  window.addEventListener('resize', measure);
  return () => {
   observer.disconnect();
   window.removeEventListener('resize', measure);
  };
 }, [anchorRef, footerRef, visible]);

 if (!visible || !rect) return null;

 // Fixed width regardless of message length — it used to size to content
 // ("max-content"), which made the bubble jump wider/narrower on every
 // update. A constant width (sidebar width + a modest stick-out) keeps the
 // box stable; text wraps and clamps inside it instead.
 const bubbleWidth = Math.min(rect.width + 40, window.innerWidth - rect.left - 16);

 return createPortal(
  <div
   className="pointer-events-none fixed z-[var(--z-agent-feed)]"
   style={{
    left: rect.left,
    bottom: rect.bottom,
    width: bubbleWidth,
   }}
  >
   <div className="pointer-events-auto">
    <AgentStatusFeed feed={feed} />
   </div>
  </div>,
  document.body,
 );
}
import { isImageAvatar, isPetSpritesheetAvatar, renderablePetAssetUrl } from '../../lib/openpets';
import { WORKSPACE_CHROME_GAP } from '../../lib/workspaceLayout';
import { partitionSidebarSessions } from '../../lib/sidebarSessions';
import { splitNostrChannelGroups } from '../../lib/nostrChannelGroups';
import type { NostrConnection, NostrChannelSubscription } from '../../lib/nostrCommunities';
import { isHuddleSession } from '../../lib/huddleTranscript';
import { oneOf, viewPreferenceKey } from '../../lib/viewPreferences';
import { cn } from '../../lib/utils';
import { useThreadInbox } from '../../hooks/useThreadInbox';
import { threadReplyLabel, threadRowSource, threadRowTitle } from '../../lib/threadInbox';
import { usePersistedPreference } from '../../hooks/usePersistedPreference';
import { APPLETS_FOLDER } from '../../lib/canvasApps';

// Which agents the DM section lists, remembered per workspace alongside the
// other view preferences (see src/lib/viewPreferences.ts).
const DM_FILTER_PREF = oneOf<DmFilter>(['active', 'idle', 'busy', 'all']);

const SIDEBAR_WIDTH_KEY = 'agensis_sidebar_width';
const AGENT_FAVORITES_KEY = 'agensis_sidebar_agent_favorites';
const COLLAPSED_SIDEBAR_WIDTH = 52;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 380;
// Full-height rail: the sidebar spans the entire viewport, flush to the left
// edge. Traffic-light clearance on desktop is handled with internal padding
// (see titlebarInset) rather than a top margin.
const SIDEBAR_FRAME_STYLE: React.CSSProperties = {
 height: '100%',
};

// Width of the macOS traffic-light cluster in the hidden_inset_tall band, from
// the WINDOW's left edge. The expanded header row (collapse button + workspace
// pill) is inset by this on the desktop shell so those controls sit just to the
// right of the window buttons — less whatever chrome (the workspace rail) is
// already covering that band to the sidebar's left.
const SIDEBAR_TITLEBAR_LEFT_INSET = 78;

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
 // Phone drawer mode: the sidebar floats as an off-canvas overlay, so it must
 // NOT inset the workspace viewport — the canvas keeps the full screen width.
 overlay?: boolean;
 // Desktop shell traffic-light band (~52px). Padded into the sidebar header so
 // the workspace controls sit below the macOS window buttons.
 titlebarInset?: number;
 // Width of chrome pinned to the LEFT of this sidebar — currently the workspace
 // switcher rail. The sidebar owns `--workspace-viewport-left`, which it derives
 // arithmetically from its own width; without this the fallback would be short
 // by the rail's width and every window measured from that fallback would land
 // one rail too far left.
 leadingInset?: number;
 onToggleCollapse: () => void;
 onOpenCommandPalette: () => void;
 onOpenWorkspaceGrid?: () => void;
 onNewChat: () => void;
 /** Re-enter an imported community to add or pause channel subscriptions. */
 onManageNostrCommunity?: (connection: NostrConnection) => void;
 onNewDocument: () => void;
 onUploadFile: (files: File[]) => void | Promise<unknown>;
 onCreateWorkspace: () => void;
 onDocumentOpen: (doc: Document) => void;
 onDocumentUpdate?: (id: string, updates: { title?: string; content?: string; folder?: string | null }) => void;
 onAddToCanvasApplet?: (doc: Document) => void;
 onSessionOpen: (session: ChatSession) => void;
 /** The session currently focused in a window — highlighted in the list so
  * "what am I looking at" reads back from the sidebar, not just the window. */
 activeSessionId?: string | null;
 onSessionUpdate?: (id: string, updates: Partial<ChatSession>) => void;
 onSessionArchive?: (id: string, archived?: boolean) => void;
 onSessionDelete?: (id: string) => void;
 onDirectMessageDelete?: (session: ChatSession) => void;
 onSessionSplit?: (session: ChatSession) => void;
 onSessionMerge?: (session: ChatSession) => void;
 /** Copy a thread's transcript into an existing channel — "escalate" out of a stranded DM. */
 onSessionEscalateToChannel?: (session: ChatSession, targetChannelId: string) => void;
 /** Hand a thread to a different agent: DM them, carry the context in, and dispatch. */
 onSessionEscalateToAgent?: (session: ChatSession, targetAgent: { id: string; name: string; handle: string | null }) => void;
 onOpenInbox?: () => void;
 /**
  * Put this desktop's open panels away (minimise, never close) so the wallpaper
  * and the home composer are all that is left — and bring them back on the next
  * press. Named for the gesture, not the noun: a *desktop* is a canvas layer you
  * switch between, and this switches nothing. See src/lib/showDesktop.ts.
  */
 onShowDesktop?: () => void;
 /** True while this desktop is bare because the row put its windows away. */
 showingDesktop?: boolean;
 /**
  * Open one message thread — the session it lives in, and the parent message
  * whose replies to show. The sidebar knows both; the app decides how to
  * present them (window, panel), which is why this is a prop and not a route.
  */
 onOpenThread?: (sessionId: string, parentMessageId: string) => void;
 onOpenMemory: () => void;
 onOpenSkills?: () => void;
 onOpenBrowser?: () => void;
 onOpenTerminal?: () => void;
 onOpenTasks?: () => void;
 onOpenActivity?: () => void;
 onOpenAgents?: () => void;
 onOpenResources?: () => void;
 onOpenUsers?: () => void;
 onOpenSchedules?: () => void;
 onOpenAutomations?: () => void;
 onAgentMessage?: (agent: SidebarAgentTarget) => void;
 onAgentProfile?: (agent: SidebarAgentTarget) => void;
 onOpenTemplates?: () => void;
 openTaskCount?: number;
 /** Unread inbox items — the "this needs you" badge above the channel list. */
 inboxUnreadCount?: number;
 recents: Document[];
 sessions: ChatSession[];
 nostrConnections?: NostrConnection[];
 /** False until imported-channel source metadata has resolved for this workspace. */
 nostrConnectionsResolved?: boolean;
 nostrConnectionsError?: string;
 onRetryNostrConnections?: () => void;
 agents?: WorkspaceAgent[];
 agentConnections?: AgentConnection[];
 floatingWindows: FloatingWindow[];
 documentPresence?: Record<string, ItemPresenceUser[]>;
 chatPresence?: Record<string, ItemPresenceUser[]>;
 agentStatusFeed?: AgentStatusFeedState;
 themeMode: ThemeMode;
 onThemeChange: (mode: ThemeMode) => void;
 userEmail: string;
 userId?: string | null;
 onSignOut: () => void;
 onOpenSettings: () => void;
 getStartedSlot?: React.ReactNode;
 notificationsSlot?: React.ReactNode;
 presenceSlot?: React.ReactNode;
}

export const Sidebar = React.memo(function Sidebar({
 workspace,
 activeLayerName,
 collapsed,
 overlay = false,
 titlebarInset = 0,
 leadingInset = 0,
 onToggleCollapse,
 onOpenCommandPalette,
 onOpenWorkspaceGrid,
 onNewChat,
 onManageNostrCommunity,
 onNewDocument,
 onUploadFile,
 onCreateWorkspace,
 onDocumentOpen,
 onDocumentUpdate,
 onAddToCanvasApplet,
 onSessionOpen,
 activeSessionId = null,
 onSessionUpdate,
 onSessionArchive,
 onSessionDelete,
 onDirectMessageDelete,
 onSessionSplit,
 onSessionMerge,
 onSessionEscalateToChannel,
 onSessionEscalateToAgent,
 onOpenInbox,
 onShowDesktop,
 showingDesktop = false,
 onOpenThread,
 onOpenMemory,
 onOpenSkills,
 onOpenBrowser,
 onOpenTerminal,
 onOpenTasks,
 onOpenActivity,
 onOpenAgents,
 onOpenResources,
 onOpenUsers,
 onOpenSchedules,
 onOpenAutomations,
 onAgentMessage,
 onAgentProfile,
 onOpenTemplates,
 openTaskCount = 0,
 inboxUnreadCount = 0,
 recents,
 sessions,
 nostrConnections = [],
 nostrConnectionsResolved = true,
 nostrConnectionsError = '',
 onRetryNostrConnections,
 agents = [],
 agentConnections = [],
 floatingWindows,
 documentPresence = {},
 chatPresence = {},
 agentStatusFeed,
 themeMode,
 onThemeChange,
 onOpenSettings,
 userEmail,
 userId,
 onSignOut,
 getStartedSlot,
 notificationsSlot,
 presenceSlot,
}: SidebarProps) {
 // Feeds the agent-work store for every live-elapsed badge in the app (sidebar
 // rows AND the thread indicator). Mounted here because the sidebar is the one
 // component that is always mounted inside a workspace — even collapsed, and
 // even behind the closed mobile drawer. It holds no state of its own.
 useAgentWorkFeed(workspace?.id);
 const [accountDialogOpen, setAccountDialogOpen] = React.useState(false);
 const [accountDialogTab, setAccountDialogTab] = React.useState<'profile' | 'billing'>('profile');
 const openAccountDialog = (tab: 'profile' | 'billing') => {
  setAccountDialogTab(tab);
  setAccountDialogOpen(true);
 };
 const openUploadPicker = React.useCallback(() => {
  uploadInputRef.current?.click();
 }, []);
 const handleUploadInputChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
  const files = Array.from(event.currentTarget.files || []);
  // Reset the input so selecting the same file twice still emits a change.
  event.currentTarget.value = '';
  if (files.length > 0) void onUploadFile(files);
 }, [onUploadFile]);
 const [sidebarWidth, setSidebarWidth] = React.useState(() => {
  if (typeof localStorage === 'undefined') return 280;
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved) ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, saved)) : 280;
 });
 const sidebarRef = React.useRef<HTMLElement | null>(null);
 const footerRef = React.useRef<HTMLDivElement | null>(null);
 const resizeRef = React.useRef<{ startX: number; startWidth: number } | null>(null);
 const resizeFrameRef = React.useRef<number | null>(null);
 const uploadInputRef = React.useRef<HTMLInputElement | null>(null);
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
 // Render a DM's split forks nested under it, recursively (split-of-a-split
 // nests deeper). Each fork gets the SPLIT chip + a Merge-into-parent action,
 // wired to the same handlers SessionTree uses for channels/threads.
 const renderDmForks = (parentId: string, depth: number): React.ReactNode =>
  (dmForksByParent.get(parentId) || []).map(fork => (
   <React.Fragment key={fork.id}>
    <SessionRow
     session={fork}
     archiveNoun="split"
     depth={depth}
     chip="SPLIT"
     canMerge
     active={fork.id === activeSessionId}
     onOpen={() => onSessionOpen(fork)}
     onMoveFolder={folder => onSessionUpdate?.(fork.id, { folder })}
     onArchive={() => onSessionArchive?.(fork.id, true)}
     onDelete={onSessionDelete ? () => onSessionDelete(fork.id) : undefined}
     onSplit={onSessionSplit ? () => onSessionSplit(fork) : undefined}
     onMerge={onSessionMerge ? () => onSessionMerge(fork) : undefined}
     escalateChannels={escalateChannels}
     onEscalateToChannel={onSessionEscalateToChannel ? targetId => onSessionEscalateToChannel(fork, targetId) : undefined}
     escalateAgents={escalateAgents.filter(a => !(fork.participants || []).some(p => p.agent_id === a.id))}
     onEscalateToAgent={onSessionEscalateToAgent ? targetAgent => onSessionEscalateToAgent(fork, targetAgent) : undefined}
     presenceUsers={chatPresence[fork.id] || []}
    />
    {renderDmForks(fork.id, depth + 1)}
   </React.Fragment>
  ));

 const userInitial = (userEmail[0] || 'U').toUpperCase();
 const uniqueSessions = React.useMemo(() => uniqueById(sessions), [sessions]);
 const uniqueRecents = React.useMemo(() => uniqueById(recents), [recents]);
 const directAgents = React.useMemo(
  () => buildDirectAgents(agents, agentConnections, favoriteAgentKeys),
  [agents, agentConnections, favoriteAgentKeys],
 );
 // Channels, DMs and threads belong to the WORKSPACE and are listed on every
 // desktop of it. A desktop is a window/wallpaper configuration, not a place
 // content lives, so nothing here is filtered by the open desktop — see
 // partitionSidebarSessions for why that filter was removed.
 // threadSessions is still partitioned OUT even though the Threads section no
 // longer renders it: those sessions must not fall through into the channel or
 // DM lists, which is what the partition is for. The section itself is now
 // driven by useThreadInbox (message threads), not by folder.
 const { activeChannelSessions, directSessions } = React.useMemo(() => {
  const { channels, direct, threads } = partitionSidebarSessions(uniqueSessions, {
   isDirect: isDirectSession,
   isThread: isThreadSession,
   exclude: isHuddleSession,
  });
  void threads;
  return { activeChannelSessions: channels, directSessions: direct };
 }, [uniqueSessions]);
 // Target list for "Move to channel" — every live (non-archived) channel this
 // thread could be escalated into. Kept as {id, title} so SessionRow doesn't
 // need the full ChatSession shape just to render a picker.
 const escalateChannels = React.useMemo(
  () => activeChannelSessions.map(channel => ({ id: channel.id, title: channel.title || 'Untitled' })),
  [activeChannelSessions],
 );
 // Target list for "Hand to agent" — every enabled agent this thread could be
 // handed off to, alongside the channel picker above.
 const escalateAgents = React.useMemo(
  () => (agents || [])
   .filter(agent => agent.enabled !== false)
   .map(agent => ({ id: agent.id, name: agent.name || agent.handle || 'Agent', handle: agent.handle ?? null })),
  [agents],
 );
 const archivedSessions = React.useMemo(() => uniqueSessions.filter(session => Boolean(session.archived_at)), [uniqueSessions]);
 // A split of a DM is itself a DM session (same agent participant), so the
 // per-agent dedup in buildDirectMessageTargets would otherwise swallow it and
 // its Merge action would never render. Pull forks out of the target input and
 // nest them under their parent's row instead (mirrors SessionTree for
 // channels/threads). Fork = split_parent_id pointing at another DM in-view.
 const { dmForksByParent, dmPrimarySessions } = React.useMemo(
  () => buildDmForkGroups(directSessions),
  [directSessions],
 );
 const directMessageTargets = React.useMemo(
  () => buildDirectMessageTargets(dmPrimarySessions, directAgents, favoriteAgentKeys),
  [dmPrimarySessions, directAgents, favoriteAgentKeys],
 );
 const [dmFilter, setDmFilter] = usePersistedPreference(
  viewPreferenceKey('sidebar.dm-filter', workspace?.id), DM_FILTER_PREF, 'all' as DmFilter,
 );
 const filteredDmTargets = React.useMemo(() => {
  if (dmFilter === 'all') return directMessageTargets;
  if (dmFilter === 'active') return directMessageTargets.filter(a => a.status === 'online');
  if (dmFilter === 'busy') return directMessageTargets.filter(a => a.status === 'busy');
  return directMessageTargets.filter(a => !a.status || (a.status !== 'online' && a.status !== 'busy'));
 }, [directMessageTargets, dmFilter]);


 // The Threads SECTION is about message threads — replies under a message —
 // not about sessions that happen to sit in a folder called Threads. Those are
 // different things (see server/thread-inbox.cjs), and it is the message
 // threads a person means when they ask what they still need to read.
 const threadInbox = useThreadInbox(workspace?.id ?? null);
 const refetchThreadInbox = threadInbox.refetch;
 // The Threads list fetches once per (workspace, reloadToken) and nothing ever
 // bumped the token, so it was a load-time snapshot frozen at whenever the page
 // opened while Activity kept moving. Refetch whenever the newest session
 // activity advances — that is exactly when a followed thread may have a new
 // reply — so the two views stop disagreeing.
 const latestActivitySig = React.useMemo(
  () => uniqueSessions.reduce((acc, session) => {
   const stamp = String(session.updated_at || session.created_at || '');
   return stamp > acc ? stamp : acc;
  }, ''),
  [uniqueSessions],
 );
 React.useEffect(() => {
  refetchThreadInbox();
 }, [latestActivitySig, refetchThreadInbox]);
 const nostrChannelGroups = React.useMemo(
  () => splitNostrChannelGroups(activeChannelSessions, nostrConnections),
  [activeChannelSessions, nostrConnections],
 );
 const groupedSessions = React.useMemo(
  () => groupSessionsByFolder(nostrChannelGroups.localSessions),
  [nostrChannelGroups.localSessions],
 );
 const groupedDocuments = React.useMemo(() => groupDocumentsByFolder(uniqueRecents), [uniqueRecents]);
 const focusedWindow = floatingWindows
  .filter(win => !win.minimized)
  .reduce<FloatingWindow | null>((topWindow, win) => (
   !topWindow || win.zIndex > topWindow.zIndex ? win : topWindow
  ), null);
 const focusedWindowType = focusedWindow?.type;
 const workspaceLabel = activeLayerName || workspace?.name || 'Personal';

 // Traffic-light clearance measured from the sidebar's OWN left edge: the rail
 // to its left already covers that much of the band, so inset by the remainder
 // or the header ends up parked 52px further right than the window buttons.
 const titlebarLeftInset = titlebarInset ? Math.max(0, SIDEBAR_TITLEBAR_LEFT_INSET - leadingInset) : 0;

 const setWorkspaceViewportLeft = React.useCallback((width: number, isCollapsed = collapsed) => {
  // Overlay (phone drawer): the sidebar floats above the canvas, so the
  // viewport's left inset is just the chrome gap — never the sidebar width.
  const sidebarFrameWidth = overlay ? 0 : (isCollapsed ? COLLAPSED_SIDEBAR_WIDTH : width);
  // Sidebar is flush to the left edge now, so the canvas starts one chrome gap
  // to the right of it (previously two gaps straddled a floating panel).
  // `leadingInset` is anything pinned further left still — the workspace rail.
  const left = overlay ? WORKSPACE_CHROME_GAP : leadingInset + sidebarFrameWidth + WORKSPACE_CHROME_GAP;
  document.documentElement.style.setProperty('--workspace-viewport-left', `${left}px`);
  // Canvas viewport clears only the chrome gap at top now — the titlebar band
  // is over the sidebar (left), not the canvas column, so panels reach the top
  // edge. (This var is the fallback used when the live viewport rect is 0.)
  document.documentElement.style.setProperty('--workspace-viewport-top', `${WORKSPACE_CHROME_GAP}px`);
  document.documentElement.style.setProperty('--workspace-viewport-right', `${WORKSPACE_CHROME_GAP}px`);
  document.documentElement.style.setProperty('--workspace-viewport-bottom', `${WORKSPACE_CHROME_GAP}px`);
 }, [collapsed, overlay, leadingInset]);

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
    // No shadow utility here: `[data-sidebar-panel]` in index.css sets
    // box-shadow unlayered, so it wins over any Tailwind shadow-* on the
    // element. Depth and elevation for all three shell columns live in that one
    // rule — see src/lib/chromeDepth.ts.
    className="sidebar-collapsed-panel flex h-full shrink-0 flex-col items-center gap-1 overflow-visible rounded-none border-r border-border bg-card/45 py-2 text-card-foreground"
   style={{ ...SIDEBAR_FRAME_STYLE, width: COLLAPSED_SIDEBAR_WIDTH, paddingTop: titlebarInset ? titlebarInset + 8 : undefined }}
   >
    <input
     ref={uploadInputRef}
     type="file"
     multiple
     className="sr-only"
     tabIndex={-1}
     onChange={handleUploadInputChange}
     aria-label="Upload files"
    />
    {/* Theme-accent wash on the chrome — see .sidebar-accent-wash in index.css.
        Decorative, non-interactive, and out of flow, so it is not a flex item. */}
    <div aria-hidden="true" className="sidebar-accent-wash" />
    <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleCollapse} aria-label="Expand sidebar">
     <PanelLeft />
    </Button>
    <Separator />
    {/* Desktops, not workspaces: this opens the desktop grid, and the workspace
        rail immediately to the left is what switches workspaces. Labelling both
        "workspace" is what made the two concepts indistinguishable. */}
    <SidebarRailButton icon={<Layers3 />} title="Switch desktop" onClick={onOpenWorkspaceGrid || onCreateWorkspace} />
    <SidebarRailButton icon={<Plus />} title="Create workspace" onClick={onCreateWorkspace} />
    <SidebarRailButton icon={<Settings />} title="Desktop settings" onClick={onOpenSettings} />
    <Separator />
    <SidebarRailButton icon={<Search />} title="Search" onClick={onOpenCommandPalette} />
    {onOpenInbox && <SidebarRailButton icon={<Inbox />} title="Inbox" count={inboxUnreadCount} onClick={onOpenInbox} />}
    {onShowDesktop && <SidebarRailButton icon={<Minimize2 />} title="Desktop" pressed={showingDesktop} onClick={onShowDesktop} />}
    {/* Same order as the expanded panel, and for the same reason — collapsing
        the sidebar must not reshuffle where things are. The two Separators sit
        where the expanded panel draws its two rules. */}
    {onOpenTasks && <SidebarRailButton icon={<RotateCcw />} title="Tasks" count={openTaskCount} onClick={onOpenTasks} />}
    <SidebarRailButton icon={<Brain />} title="Memory" onClick={onOpenMemory} />
    <Separator />
    <SidebarRailButton icon={<MessageSquare />} title="Threads" count={threadInbox.unreadCount} onClick={() => revealSection('threads')} />
    <SidebarRailButton icon={<Hash />} title="Channels" count={activeChannelSessions.length} onClick={() => revealSection('channels')} />
    <SidebarRailButton icon={<FileText />} title="Documents" count={uniqueRecents.length} onClick={() => revealSection('documents')} />
    <SidebarRailButton icon={<Upload />} title="Upload files" onClick={openUploadPicker} />
    <SidebarRailButton icon={<Bot />} title="Direct messages" count={directMessageTargets.length} onClick={() => revealSection('direct-messages')} />
    <SidebarRailButton icon={<Archive />} title="Archive" count={archivedSessions.length} onClick={() => revealSection('archive')} />
    <Separator />
    {onOpenSkills && <SidebarRailButton icon={<Sparkles />} title="Skills" onClick={onOpenSkills} />}
    {onOpenActivity && <SidebarRailButton icon={<RotateCcw />} title="Activity" onClick={onOpenActivity} />}
    {onOpenAgents && <SidebarRailButton icon={<Bot />} title="Agents" count={agents.length} onClick={onOpenAgents} />}
    {onOpenResources && <SidebarRailButton icon={<Database />} title="Resources" onClick={onOpenResources} />}
    {onOpenUsers && <SidebarRailButton icon={<Users />} title="Users" onClick={onOpenUsers} />}
    {onOpenSchedules && <SidebarRailButton icon={<Clock />} title="Schedules" onClick={onOpenSchedules} />}
    {onOpenAutomations && <SidebarRailButton icon={<Zap />} title="Automations" onClick={onOpenAutomations} />}
    {onOpenTemplates && <SidebarRailButton icon={<LayoutTemplate />} title="Applets" onClick={onOpenTemplates} />}
    {onOpenBrowser && <SidebarRailButton icon={<Globe />} title="Browser" onClick={onOpenBrowser} />}
    {onOpenTerminal && <SidebarRailButton icon={<SquareTerminal />} title="Terminal" onClick={onOpenTerminal} />}
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
  <>
   <input
    ref={uploadInputRef}
    type="file"
    multiple
    className="sr-only"
    tabIndex={-1}
    onChange={handleUploadInputChange}
    aria-label="Upload files"
   />
   <aside
    ref={sidebarRef}
    data-sidebar-panel
    // See the collapsed panel above: elevation is owned by index.css, not by a
    // shadow utility here.
    className="relative flex h-full shrink-0 flex-col overflow-hidden rounded-none border-r border-border bg-card/45 text-card-foreground"
    style={{ ...SIDEBAR_FRAME_STYLE, width: sidebarWidth }}
   >
    {/* Theme-accent wash on the chrome — see .sidebar-accent-wash in index.css.
        Decorative, non-interactive, and out of flow, so it is not a flex item. */}
    <div aria-hidden="true" className="sidebar-accent-wash" />
    <div
     data-sidebar-titlebar
     className="px-2 pt-2 pb-3"
     style={{
      paddingLeft: titlebarLeftInset || undefined,
      // Desktop traffic-light clearance, also exposed as a CSS var so themes
      // that reset the titlebar padding (neo/brutal) can still honour it.
      '--sidebar-titlebar-inset': `${titlebarLeftInset}px`,
     } as React.CSSProperties}
    >
     <div className="sidebar-workspace-pill flex min-w-0 w-full items-center gap-1 rounded-lg border border-border bg-popover/60 p-1 shadow-sm">
      <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleCollapse} aria-label="Collapse sidebar">
       <PanelLeftClose />
      </Button>
      <button
       type="button"
       className="sidebar-workspace-switch flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
       onClick={onOpenWorkspaceGrid || onCreateWorkspace}
       aria-label="Switch desktop"
      >
       <span className="min-w-0 truncate text-left">{workspaceLabel}</span>
      </button>
      {notificationsSlot}
      <Button type="button" variant="ghost" size="icon-sm" onClick={onCreateWorkspace} aria-label="Create workspace">
       <Plus />
      </Button>
     </div>
    </div>

    <div className="px-2 pt-2 pb-2">
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
     {/* gap-0.5, not gap-1: with ~14 entries the inter-row gap is counted
         thirteen times, so it moves the sidebar's overall height as much as
         any single row's height does. */}
     <div className="flex flex-col gap-0.5 pb-2">
      {/* Above the channels: whatever needs a human is the first thing in the
          sidebar, not something you scroll past. */}
      {onOpenInbox && (
       <ActionTile
        icon={<Inbox />}
        label="Inbox"
        count={inboxUnreadCount}
        active={focusedWindowType === 'inbox'}
        onClick={onOpenInbox}
       />
      )}
      {/* Directly under Inbox: the way back to a bare desktop — wallpaper and
          the home composer, with the open panels minimised into the dock. Not
          "Desktop": that word is already a canvas layer you switch between (the
          workspace pill above does that), and this switches nothing. */}
      {onShowDesktop && (
       <ActionTile
        icon={<Minimize2 />}
        label="Desktop"
        active={showingDesktop}
        pressed={showingDesktop}
        onClick={onShowDesktop}
       />
      )}
      {/* Tasks and Memory join the fixed top block rather than sitting below the
          sections. They are the two destinations you go to REPEATEDLY and by
          name — the rest of the standalone rows are occasional — and down there
          they were separated from Inbox and Desktop by five collapsible
          sections whose height changes every time one is opened, so their
          position on screen was never twice the same. */}
      {onOpenTasks && <ActionTile icon={<RotateCcw />} label="Tasks" count={openTaskCount} active={focusedWindowType === 'tasks'} onClick={onOpenTasks} />}
      <ActionTile icon={<Brain />} label="Memory" active={focusedWindowType === 'memory'} onClick={onOpenMemory} />
      {/* Closes the fixed block. Below it everything is a collapsible section;
          above it, nothing moves. See .sidebar-group-divider. */}
      <div aria-hidden="true" className="sidebar-group-divider" />
      <SidebarSection
       id="threads"
       label="Threads"
       icon={<MessageSquare />}
       count={threadInbox.unreadCount}
       open={openSections.has('threads')}
       onOpenChange={open => toggleSection('threads', open)}
      >
       {/* Threads a person FOLLOWS, unread first — the section exists so a
           reply you have not seen is the top row. An empty list is a real,
           good state and says so rather than rendering nothing. */}
       {threadInbox.items.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
         {threadInbox.loading ? 'Loading threads' : 'No threads yet'}
        </p>
       ) : (
        threadInbox.items.map(thread => (
         <button
          key={thread.parentId}
          type="button"
          data-thread-unread={thread.unread ? 'true' : undefined}
          className="sidebar-thread-row flex w-full min-w-0 items-start gap-1.5 rounded-md px-2 py-1 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
           // Read on OPEN, not on render: a thread scrolling past in the
           // sidebar has not been read by anyone.
           threadInbox.markThreadRead(thread.parentId);
           if (thread.sessionId) onOpenThread?.(thread.sessionId, thread.parentId);
          }}
         >
          {/* A LEADING ICON THAT SAYS SOMETHING. Every other list in this
              sidebar leads with one, and without it Threads is a wall of
              undifferentiated text. It is the thread's SOURCE — a hash for a
              thread in a channel, an at-sign for one in a DM — because that is
              the fact that separates two rows whose titles read alike. */}
          <span className="sidebar-item-icon mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
           {threadRowSource(thread) === 'dm' ? <AtSign /> : <Hash />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
           <span className="flex min-w-0 items-center gap-1.5">
            {/* The unread dot carries the state on its own, so the row does
                not depend on weight alone — weight is easy to miss against a
                wallpaper. */}
            {thread.unread && (
             <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
            )}
            {/* font-medium on EVERY row, not only unread ones. A title is a
                title; read rows still recede, but through colour, which is what
                the muted token is for. Weight-as-state left read rows rendering
                as thin grey text over a wallpaper and barely legible. */}
            <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', !thread.unread && 'text-muted-foreground')}>
             {threadRowTitle(thread)}
            </span>
           </span>
           <span className="truncate pl-0 text-xs text-muted-foreground">
            {thread.sessionTitle ? `${thread.sessionTitle} - ` : ''}{threadReplyLabel(thread.replyCount, thread.toolCount)}
           </span>
          </span>
         </button>
        ))
       )}
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
       {!nostrConnectionsResolved ? (
        <div className="rounded-md px-2 py-1.5 text-xs text-muted-foreground">
         <span>{nostrConnectionsError ? 'Could not verify imported channel sources.' : 'Checking imported channel sources…'}</span>
         {nostrConnectionsError && onRetryNostrConnections && (
          <button
           type="button"
           className="ml-1 font-medium text-foreground underline-offset-2 hover:underline"
           onClick={onRetryNostrConnections}
          >
           Retry
          </button>
         )}
        </div>
       ) : groupedSessions.map(group => (
        group.folder === 'General' ? (
         <SessionTree
          key={group.folder}
          sessions={group.sessions}
          icon={<Hash />}
          limit={8}
          chatPresence={chatPresence}
          activeSessionId={activeSessionId}
          onSessionOpen={onSessionOpen}
          onSessionUpdate={onSessionUpdate}
          onSessionArchive={onSessionArchive}
          onSessionDelete={onSessionDelete}
          onSessionSplit={onSessionSplit}
          onSessionMerge={onSessionMerge}
          escalateChannels={escalateChannels}
          onSessionEscalateToChannel={onSessionEscalateToChannel}
          escalateAgents={escalateAgents}
          onSessionEscalateToAgent={onSessionEscalateToAgent}
         />
        ) : (
         <SidebarFolderGroup
          key={group.folder}
          id={`channels-folder:${group.folder}`}
          label={group.folder}
          count={group.sessions.length}
          open={openSections.has(`channels-folder:${group.folder}`)}
          onOpenChange={open => toggleSection(`channels-folder:${group.folder}`, open)}
         >
          <SessionTree
           sessions={group.sessions}
           icon={<Hash />}
           limit={8}
           chatPresence={chatPresence}
           activeSessionId={activeSessionId}
           onSessionOpen={onSessionOpen}
           onSessionUpdate={onSessionUpdate}
           onSessionArchive={onSessionArchive}
           onSessionDelete={onSessionDelete}
           onSessionSplit={onSessionSplit}
           onSessionMerge={onSessionMerge}
           escalateChannels={escalateChannels}
           onSessionEscalateToChannel={onSessionEscalateToChannel}
           escalateAgents={escalateAgents}
           onSessionEscalateToAgent={onSessionEscalateToAgent}
          />
         </SidebarFolderGroup>
        )
       ))}
       {nostrConnectionsResolved && nostrChannelGroups.communities.map(group => {
        const sourceBySessionId = new Map(group.channels.map(channel => [channel.session.id, channel.subscription]));
        const groupId = `nostr-community:${group.connection.id}`;
        return (
         <SidebarFolderGroup
          key={group.connection.id}
          id={groupId}
          label={group.connection.name || group.connection.host || 'Nostr community'}
          count={group.channels.length}
          icon={<Globe />}
          actionLabel={`Manage ${group.connection.name || group.connection.host || 'Nostr'} Nostr community`}
          onAction={onManageNostrCommunity ? () => onManageNostrCommunity(group.connection) : undefined}
          open={openSections.has(groupId)}
          onOpenChange={open => toggleSection(groupId, open)}
         >
          {group.channels.length > 0 ? (
           <SessionTree
            sessions={group.channels.map(channel => channel.session)}
            icon={<Globe />}
            sourceBySessionId={sourceBySessionId}
            chatPresence={chatPresence}
            activeSessionId={activeSessionId}
            onSessionOpen={onSessionOpen}
            onSessionUpdate={onSessionUpdate}
            onSessionArchive={onSessionArchive}
            onSessionDelete={onSessionDelete}
            onSessionSplit={onSessionSplit}
            onSessionMerge={onSessionMerge}
            escalateChannels={escalateChannels}
            onSessionEscalateToChannel={onSessionEscalateToChannel}
            escalateAgents={escalateAgents}
            onSessionEscalateToAgent={onSessionEscalateToAgent}
           />
          ) : (
           <button
            type="button"
            className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onManageNostrCommunity?.(group.connection)}
           >
            No imported channels. Choose channels…
           </button>
          )}
         </SidebarFolderGroup>
        );
       })}
      </SidebarSection>
      <SidebarSection
       id="documents"
       label="Documents"
       icon={<FileText />}
       count={uniqueRecents.length}
       actionLabel="New document"
       onAction={onNewDocument}
       headerActions={(
        <button
         type="button"
         className="sidebar-section-action"
         aria-label="Upload files"
         title="Upload files"
         onClick={event => {
          event.stopPropagation();
          openUploadPicker();
         }}
        >
         <Upload className="size-4" />
        </button>
       )}
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
           onAddToCanvas={onAddToCanvasApplet}
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
       count={filteredDmTargets.length}
       open={openSections.has('direct-messages')}
       onOpenChange={open => toggleSection('direct-messages', open)}
       headerActions={<DmFilterButton filter={dmFilter} onChange={setDmFilter} />}
      >
       {filteredDmTargets.map(agent => (
        <React.Fragment key={getAgentKey(agent)}>
         <DirectAgentRow
          agent={agent}
          favorite={favoriteAgentKeys.has(getAgentKey(agent))}
          active={Boolean(agent.session && agent.session.id === activeSessionId)}
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
          onDelete={agent.session && onDirectMessageDelete ? () => onDirectMessageDelete(agent.session!) : undefined}
         />
         {agent.session && renderDmForks(agent.session.id, 1)}
        </React.Fragment>
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
         active={session.id === activeSessionId}
         onOpen={() => onSessionOpen(session)}
         onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
         onArchive={() => onSessionArchive?.(session.id, false)}
         onDelete={onSessionDelete ? () => onSessionDelete(session.id) : undefined}
         presenceUsers={chatPresence[session.id] || []}
        />
       ))}
      </SidebarSection>
      {/* Closes the band of collapsible sections. Everything below is a
          top-level destination, not a member of the section above it: flush
          against Archive's header they read as Archive's CONTENTS, which is
          exactly how they were reported. The rule is a sibling of the Archive
          <Collapsible>, not a child, so it lands below Archive's rows when
          Archive is open and directly below the ARCHIVE label when it is
          closed. Correct in both states, which is why it is placed here rather
          than "after the Archive header". Paired with the rule above THREADS —
          together they bracket the sections so the five read as one band. */}
      <div aria-hidden="true" className="sidebar-group-divider" />
      {onOpenSkills && <ActionTile icon={<Sparkles />} label="Skills" active={focusedWindowType === 'skills'} onClick={onOpenSkills} />}
      {onOpenActivity && <ActionTile icon={<RotateCcw />} label="Activity" active={focusedWindowType === 'activity'} onClick={onOpenActivity} />}
      {onOpenAgents && <ActionTile icon={<Bot />} label="Agents" count={agents.length} active={focusedWindowType === 'agents'} onClick={onOpenAgents} />}
      {onOpenResources && <ActionTile icon={<Database />} label="Resources" active={focusedWindowType === 'resources'} onClick={onOpenResources} />}
      {onOpenUsers && <ActionTile icon={<Users />} label="Users" active={focusedWindowType === 'users'} onClick={onOpenUsers} />}
      {onOpenSchedules && <ActionTile icon={<Clock />} label="Schedules" active={focusedWindowType === 'schedules'} onClick={onOpenSchedules} />}
      {onOpenAutomations && <ActionTile icon={<Zap />} label="Automations" active={focusedWindowType === 'automations'} onClick={onOpenAutomations} />}
      {onOpenTemplates && <ActionTile icon={<LayoutTemplate />} label="Applets" onClick={onOpenTemplates} />}
      {onOpenBrowser && <ActionTile icon={<Globe />} label="Browser" active={focusedWindowType === 'browser'} onClick={onOpenBrowser} />}
      {onOpenTerminal && <ActionTile icon={<SquareTerminal />} label="Terminal" active={focusedWindowType === 'terminal'} onClick={onOpenTerminal} />}
     </div>
    </ScrollArea>

    <div ref={footerRef} className="flex shrink-0 flex-col gap-2 border-t border-border p-2">
     {getStartedSlot}
     <div className="flex items-center gap-2">
      <DropdownMenu>
       <DropdownMenuTrigger asChild>
        <button
         type="button"
         className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition hover:bg-muted/60"
         aria-label="Account menu"
        >
         <Avatar size="sm">
          <AvatarFallback>{userInitial}</AvatarFallback>
         </Avatar>
         <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{userEmail}</div>
         </div>
        </button>
       </DropdownMenuTrigger>
       <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuItem onSelect={() => openAccountDialog('profile')}>
         <UserRound className="size-4" />
         Edit profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openAccountDialog('billing')}>
         <CreditCard className="size-4" />
         Billing
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}>
         <LogOut className="size-4" />
         Sign out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground/70">
         agensis v{APP_VERSION} · build {BUILD_ID.slice(0, 7)}
        </div>
       </DropdownMenuContent>
      </DropdownMenu>
      {presenceSlot}
      <ThemeToggle mode={themeMode} onModeChange={onThemeChange} />
      <Button type="button" variant="ghost" size="icon-sm" onClick={onOpenSettings} aria-label="App settings">
       <Settings className="size-4" />
      </Button>
     </div>
     <AccountDialog
      open={accountDialogOpen}
      onOpenChange={setAccountDialogOpen}
      userId={userId}
      userEmail={userEmail}
      defaultTab={accountDialogTab}
     />
    </div>
    <div
     role="separator"
     aria-orientation="vertical"
     aria-label="Resize sidebar"
     className="absolute top-0 right-0 bottom-0 z-10 w-3 cursor-col-resize touch-none"
     onPointerDown={handleResizeStart}
    />
   </aside>
   {agentStatusFeed && <AgentStatusFeedOverlay anchorRef={sidebarRef} footerRef={footerRef} feed={agentStatusFeed} />}
  </>
 );
});

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
 // A single agent participant only means "this is that agent's DM" when the
 // session is actually a DM (folder 'Direct messages') or the participant is
 // direct-flagged. A CHANNEL with one agent member is still a channel — the old
 // unconditional sole-agent fallback made it resolve a "direct participant",
 // which collapsed the channel onto the agent's DM row and shadowed the real DM.
 return agentParticipants.find(participant => participant.direct)
  || (session?.folder === 'Direct messages' && agentParticipants.length === 1 ? agentParticipants[0] : null);
}

function getParticipantAvatar(participant: ReturnType<typeof directAgentParticipantForSession>) {
 if (!participant || typeof participant !== 'object') return null;
 const record = participant as unknown as Record<string, unknown>;
 const value = record.avatar ?? record.avatar_url ?? record.image ?? record.icon;
 return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isDirectSession(session: ChatSession) {
 // Mirror the server's DM definition (server/index.cjs ~5736): a DM is the
 // 'Direct messages' folder OR a direct-flagged agent participant. The old code
 // also treated ANY single-agent session as a DM, which mis-filed one-agent
 // channels into the DM section — where the per-agent row collapse then hid the
 // real DM behind the newly-created channel. A channel is not a DM.
 if (session.folder === 'Direct messages') return true;
 const participants = Array.isArray(session.participants) ? session.participants : [];
 return participants.some(participant => participant?.kind === 'agent' && participant.direct);
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

type DmFilter = 'active' | 'idle' | 'busy' | 'all';

const DM_FILTER_OPTIONS: { label: string; value: DmFilter }[] = [
 { label: 'Active', value: 'active' },
 { label: 'Busy', value: 'busy' },
 { label: 'Idle', value: 'idle' },
 { label: 'All agents', value: 'all' },
];

function DmFilterButton({ filter, onChange }: { filter: DmFilter; onChange: (f: DmFilter) => void }) {
 const current = DM_FILTER_OPTIONS.find(f => f.value === filter) || DM_FILTER_OPTIONS[3];
 const isFiltered = filter !== 'all';
 return (
  <DropdownMenu>
   <DropdownMenuTrigger asChild>
    <button
     type="button"
     className={`sidebar-section-action flex items-center gap-1 ${isFiltered ? 'text-primary' : ''}`}
     aria-label={`Filter: ${current.label}`}
     title={`Filter: ${current.label}`}
     onClick={e => e.stopPropagation()}
    >
     <Filter className="size-3.5" />
     {isFiltered && <span className="text-[10px] font-medium leading-none">{current.label}</span>}
    </button>
   </DropdownMenuTrigger>
   <DropdownMenuContent align="end" className="w-36">
    {DM_FILTER_OPTIONS.map(opt => (
     <DropdownMenuItem key={opt.value} onSelect={() => onChange(opt.value)}>
      {opt.label}
      {/* A lucide icon, not a check GLYPH: a text tick renders in whatever the
          user's emoji font decides, which on some platforms is a coloured
          emoji — and this repo has an absolute no-emoji rule. An icon also
          inherits currentColor, so it follows the theme. */}
      {filter === opt.value && <Check className="ml-auto size-3.5 text-primary" aria-hidden />}
     </DropdownMenuItem>
    ))}
   </DropdownMenuContent>
  </DropdownMenu>
 );
}

function DirectAgentRow({
 agent,
 favorite,
 active = false,
 onMessage,
 onProfile,
 onCopyMention,
 onToggleFavorite,
 onDelete,
}: {
 agent: SidebarMessageTarget;
 favorite: boolean;
 /** This agent's DM session is the one currently open/focused. */
 active?: boolean;
 onMessage: () => void;
 onProfile: () => void;
 onCopyMention: () => void;
 onToggleFavorite: () => void;
 onDelete?: () => void;
}) {
 const handle = normalizeHandle(agent.handle);
 const status = agent.status || 'offline';
 const statusColor = status === 'online' ? 'bg-emerald-500' : status === 'busy' ? 'bg-amber-500' : 'bg-muted-foreground/40';
 const avatar = agent.avatar || null;
 const avatarSrc = avatar && isImageAvatar(avatar) ? renderablePetAssetUrl(avatar) : undefined;
 const avatarIsSpritesheet = isPetSpritesheetAvatar(avatar);
 const profileEnabled = Boolean(agent.agentId || handle);

 return (
  <div
   className="sidebar-agent-row group flex min-w-0 w-full items-center gap-1 flex-nowrap rounded-md px-1 py-0.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
   data-active={active ? 'true' : undefined}
  >
   <button
    type="button"
    className="sidebar-agent-primary min-w-0 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onClick={onMessage}
   >
    <span className="relative flex size-7 shrink-0 items-center justify-center">
     <Avatar size="default" className="size-7 rounded-md bg-muted">
      {avatarIsSpritesheet && avatar ? (
       <span className="animated-pet-avatar-shell size-full rounded-md">
        <span className="animated-pet-avatar" style={{ backgroundImage: `url(${renderablePetAssetUrl(avatar)})` }} />
       </span>
      ) : (
       <>
        {avatarSrc && <AvatarImage src={avatarSrc} alt="" className="rounded-md" />}
        <AvatarFallback className="rounded-md">
         <Bot className="size-4" />
        </AvatarFallback>
       </>
      )}
     </Avatar>
     {/* Inside the avatar bounds — parent .sidebar-agent-primary is overflow:hidden,
         so negative offsets + ring (box-shadow) only showed a clipped crescent. */}
     <span className={`absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-background ${statusColor}`} />
    </span>
    <span className="min-w-0 flex-1">
     {/* ONE line: name and handle side by side, not stacked. Two block spans
         made every DM row double height, and the name wrapped the moment it
         was long — which is most of them. */}
     <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate text-sm font-medium leading-tight text-foreground">{agent.name}</span>
      <span className="shrink-0 truncate text-xs leading-tight text-muted-foreground">
       {handle ? `@${handle}` : 'agent'}
      </span>
     </span>
    </span>
   </button>
   {/* Most agent work happens in DMs, so the elapsed badge belongs here too —
       keyed on the DM's session, same store, same conditional mount. */}
   {agent.session ? <SessionWorkBadge sessionId={agent.session.id} /> : null}
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
     {onDelete && (
      <>
       <DropdownMenuSeparator />
       <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onSelect={() => onDelete()}
       >
        <Trash2 data-icon="inline-start" />
        Delete conversation
       </DropdownMenuItem>
      </>
     )}
    </DropdownMenuContent>
   </DropdownMenu>
  </div>
 );
}

function SidebarRailButton({
 icon,
 title,
 count,
 pressed,
 onClick,
}: {
 icon: React.ReactNode;
 title: string;
 count?: number;
 /** Set only on toggles — a plain launcher must NOT report a pressed state. */
 pressed?: boolean;
 onClick: () => void;
}) {
 return (
  <Button
   type="button"
   variant="ghost"
   size="icon-sm"
   className="sidebar-rail-button relative"
   onClick={onClick}
   aria-pressed={pressed}
   data-active={pressed ? 'true' : undefined}
   aria-label={title}
   title={typeof count === 'number' && count > 0 ? `${title} (${count})` : title}
  >
   {icon}
   <span className="sidebar-rail-label">
    {title}
    {typeof count === 'number' && count > 0 ? ` (${formatCount(count)})` : ''}
   </span>
   {typeof count === 'number' && count > 0 && (
    <span className="sidebar-rail-count" aria-hidden />
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
 pressed,
 onClick,
}: {
 icon: React.ReactNode;
 label: string;
 count?: number;
 active?: boolean;
 /**
  * Set only on rows that are toggles. Left undefined everywhere else so a
  * launcher is not announced as a pressed/unpressed control it isn't.
  */
 pressed?: boolean;
 onClick: () => void;
}) {
 return (
  <button
   type="button"
   className="sidebar-action-row flex min-w-0 w-full items-center overflow-hidden rounded-md text-left text-sm font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
   data-active={active ? 'true' : undefined}
   aria-pressed={pressed}
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
 count,
 actionLabel,
 onAction,
 headerActions,
 open,
 onOpenChange,
 children,
}: {
 id: string;
 label: string;
 /**
  * Still accepted so every call site keeps compiling, but no longer rendered:
  * a section is a label now, and the icon duplicated the word next to it.
  * Left in the type deliberately rather than removed from ~8 call sites in
  * one styling change — deleting it is a separate, mechanical commit.
  */
 icon?: React.ReactNode;
 count: number;
 actionLabel?: string;
 onAction?: () => void;
 headerActions?: React.ReactNode;
 open: boolean;
 onOpenChange: (open: boolean) => void;
 children: React.ReactNode;
}) {
 const hasAction = Boolean(actionLabel && onAction);

 return (
  <Collapsible open={open} onOpenChange={onOpenChange} className="sidebar-section">
   <div className="sidebar-section-header">
    <CollapsibleTrigger asChild>
     <button
      type="button"
      className="sidebar-section-trigger flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-0.5 text-left"
      aria-controls={`${id}-content`}
     >
      {/* A section name is a LABEL for what follows, not a row you act on —
          so the chevron stays small and quiet, and the section icon is gone
          entirely. The icon was doing the same job as the word beside it,
          and at label size two glyphs competing for one meaning is noise.
          Item icons still carry per-row identity; this level does not need
          one. Kept as a button so the section still collapses by click and
          by keyboard. */}
      <ChevronRight className={`sidebar-section-chevron size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
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
      <Plus className="size-4" />
     </button>
    )}
    {headerActions}
   </div>
   {/* pl-1, not pl-6. The old indent aligned children under the header's
       ICON; with the icon gone there is nothing to align to, and a deep
       indent under a quiet label just wastes the width a sidebar has least
       of. Items now sit near the panel edge with the label above them. */}
   <CollapsibleContent id={`${id}-content`} className="sidebar-section-content pt-0.5 pl-1">
    {children}
   </CollapsibleContent>
  </Collapsible>
 );
}

function SidebarFolderGroup({
 id,
 label,
 count,
 icon,
 actionLabel,
 onAction,
 open,
 onOpenChange,
 children,
}: {
 id: string;
 label: string;
 count: number;
 icon?: React.ReactNode;
 actionLabel?: string;
 onAction?: () => void;
 open: boolean;
 onOpenChange: (open: boolean) => void;
 children: React.ReactNode;
}) {
 return (
  <Collapsible open={open} onOpenChange={onOpenChange} className="pt-1">
   <div className="flex items-center gap-0.5">
    <CollapsibleTrigger asChild>
     <button
      type="button"
     // text-sm, not text-xs. A folder is one of the things IN the workspace, the
     // same as the documents inside it and the same as Inbox/Tasks/Skills — it is
     // not a label for a group the way a section heading is. text-xs put it at
     // exactly the section-heading size (11.25px against the items' 13.125px at a
     // 15px UI font), so "Applets" read as a heading for its own contents.
      className="sidebar-folder-trigger flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-controls={`${id}-content`}
     >
      <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      <span className="size-4 shrink-0">{icon || <Folder className="size-4" />}</span>
      <span className="sidebar-section-label min-w-0 flex-1 truncate text-left">{label}</span>
      {count > 0 && (
       <span className="sidebar-section-count min-w-[1.25rem] rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-primary-foreground">
        {formatCount(count)}
       </span>
      )}
     </button>
    </CollapsibleTrigger>
    {onAction && (
     <button
      type="button"
      className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={actionLabel}
      title={actionLabel}
      onClick={event => {
       event.stopPropagation();
       onAction();
      }}
     >
      <Settings className="size-3.5" />
     </button>
    )}
   </div>
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
   className={`sidebar-item-row sidebar-item-row-${kind} group flex min-w-0 w-full items-center overflow-hidden rounded-md text-left text-sm font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring`}
   onClick={onClick}
  >
   <span className="sidebar-item-icon flex size-4 shrink-0 items-center justify-center">
    {icon}
   </span>
   <span className="sidebar-item-label min-w-0 truncate text-left">{label}</span>
   {presenceUsers.length > 0 && (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 transition-all duration-150 group-hover:gap-1">
     {presenceUsers.slice(0, 3).map(person => (
      <span
       key={person.userId}
       className="flex size-2 items-center justify-center overflow-hidden rounded-full text-[0px] font-semibold leading-none text-white ring-1 ring-background transition-all duration-150 group-hover:size-4 group-hover:text-[9px]"
       style={{ backgroundColor: person.color }}
       title={`${person.name}${person.typing ? ' is typing' : ' is active'}`}
      >
       {person.name.trim().charAt(0).toUpperCase()}
      </span>
     ))}
     {presenceUsers.length > 3 && (
      <span className="text-[10px] leading-none text-muted-foreground">+{presenceUsers.length - 3}</span>
     )}
    </span>
   )}
  </button>
 );
}

const ITEM_FOLDERS = ['General', 'Work', 'Research', 'Drafts', 'Ideas', 'Webhooks'];

// Lineage chip shown in front of a nested row. Fixed width so SPLIT and SUB
// align to the same column regardless of label.
function RowChip({ kind }: { kind: 'SPLIT' | 'SUB' }) {
 return (
  <span
   className="inline-flex w-9 shrink-0 items-center justify-center rounded-sm bg-primary/15 px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-primary"
   title={kind === 'SPLIT' ? 'Split of the thread above' : 'Sub-thread of the thread above'}
  >
   {kind}
  </span>
 );
}

// Separate DM split forks from their parents so the per-agent dedup in
// buildDirectMessageTargets never swallows a fork (which would hide its Merge
// action). A fork is a DM whose split_parent_id points at another DM in the
// same list; it's mapped under that parent and rendered nested. Forks whose
// parent isn't in view fall back to `primary` so they never vanish.
export function buildDmForkGroups(directSessions: ChatSession[]) {
 const ids = new Set(directSessions.map(session => session.id));
 const dmForksByParent = new Map<string, ChatSession[]>();
 const dmPrimarySessions: ChatSession[] = [];
 for (const session of directSessions) {
  const parentId = session.split_parent_id;
  if (parentId && ids.has(parentId)) {
   const list = dmForksByParent.get(parentId) || [];
   list.push(session);
   dmForksByParent.set(parentId, list);
  } else {
   dmPrimarySessions.push(session);
  }
 }
 return { dmForksByParent, dmPrimarySessions };
}

// Group a flat session list into a split hierarchy: a fork (split_parent_id set)
// nests under its source when the source is present in the same list; otherwise
// it falls back to a root so it never disappears. Order is preserved.
function buildSessionTree(sessions: ChatSession[]) {
 const ids = new Set(sessions.map(s => s.id));
 const childrenByParent = new Map<string, ChatSession[]>();
 const roots: ChatSession[] = [];
 for (const session of sessions) {
  const parentId = session.split_parent_id;
  if (parentId && ids.has(parentId)) {
   const list = childrenByParent.get(parentId) || [];
   list.push(session);
   childrenByParent.set(parentId, list);
  } else {
   roots.push(session);
  }
 }
 return { roots, childrenByParent };
}

function SessionTree({
 sessions,
 icon,
 archiveNoun,
 limit,
 sourceBySessionId,
 chatPresence,
 activeSessionId = null,
 onSessionOpen,
 onSessionUpdate,
 onSessionArchive,
 onSessionDelete,
 onSessionSplit,
 onSessionMerge,
 escalateChannels,
 onSessionEscalateToChannel,
 escalateAgents,
 onSessionEscalateToAgent,
}: {
 sessions: ChatSession[];
 icon?: React.ReactNode;
 archiveNoun?: string;
 limit?: number;
 sourceBySessionId?: Map<string, NostrChannelSubscription>;
 chatPresence: Record<string, ItemPresenceUser[]>;
 activeSessionId?: string | null;
 onSessionOpen: (session: ChatSession) => void;
 onSessionUpdate?: (id: string, updates: Partial<ChatSession>) => void;
 onSessionArchive?: (id: string, archived?: boolean) => void;
 onSessionDelete?: (id: string) => void;
 onSessionSplit?: (session: ChatSession) => void;
 onSessionMerge?: (session: ChatSession) => void;
 escalateChannels?: { id: string; title: string }[];
 onSessionEscalateToChannel?: (session: ChatSession, targetChannelId: string) => void;
 escalateAgents?: { id: string; name: string; handle: string | null }[];
 onSessionEscalateToAgent?: (session: ChatSession, targetAgent: { id: string; name: string; handle: string | null }) => void;
}) {
 const { roots, childrenByParent } = React.useMemo(() => buildSessionTree(sessions), [sessions]);
 const shownRoots = typeof limit === 'number' ? roots.slice(0, limit) : roots;

 const renderNode = (session: ChatSession, depth: number, chip: 'SPLIT' | 'SUB' | null): React.ReactNode => {
  const kids = childrenByParent.get(session.id) || [];
  return (
   <React.Fragment key={session.id}>
    <SessionRow
     session={session}
     // A channel that chose an icon wears it here too, so the sidebar and the
     // channel header agree. Threads and DMs pass no icon key and keep the
     // group's glyph.
     icon={session.icon ? React.createElement(channelIconGlyph(session.icon)) : icon}
     archiveNoun={archiveNoun}
     depth={depth}
     chip={chip}
     source={sourceBySessionId?.get(session.id)}
     canMerge={chip === 'SPLIT'}
     active={session.id === activeSessionId}
     onOpen={() => onSessionOpen(session)}
     onMoveFolder={folder => onSessionUpdate?.(session.id, { folder })}
     onArchive={() => onSessionArchive?.(session.id, true)}
     onDelete={onSessionDelete ? () => onSessionDelete(session.id) : undefined}
     onSplit={onSessionSplit ? () => onSessionSplit(session) : undefined}
     onMerge={onSessionMerge ? () => onSessionMerge(session) : undefined}
     escalateChannels={(escalateChannels || []).filter(channel => channel.id !== session.id)}
     onEscalateToChannel={onSessionEscalateToChannel ? targetId => onSessionEscalateToChannel(session, targetId) : undefined}
     escalateAgents={(escalateAgents || []).filter(a => !(session.participants || []).some(p => p.agent_id === a.id))}
     onEscalateToAgent={onSessionEscalateToAgent ? targetAgent => onSessionEscalateToAgent(session, targetAgent) : undefined}
     presenceUsers={chatPresence[session.id] || []}
    />
    {kids.map(kid => renderNode(kid, depth + 1, 'SPLIT'))}
   </React.Fragment>
  );
 };

 return <>{shownRoots.map(session => renderNode(session, 0, null))}</>;
}

function SessionRow({
 session,
 archived = false,
 icon,
 archiveNoun = 'channel',
 depth = 0,
 chip = null,
 source,
 canMerge = false,
 active = false,
 onOpen,
 onMoveFolder,
 onArchive,
 onDelete,
 onSplit,
 onMerge,
 escalateChannels = [],
 onEscalateToChannel,
 escalateAgents = [],
 onEscalateToAgent,
 presenceUsers = [],
}: {
 session: ChatSession;
 archived?: boolean;
 icon?: React.ReactNode;
 archiveNoun?: string;
 depth?: number;
 chip?: 'SPLIT' | 'SUB' | null;
 source?: NostrChannelSubscription;
 canMerge?: boolean;
 /** This session is the one currently open/focused — render it boxed. */
 active?: boolean;
 onOpen: () => void;
 onMoveFolder: (folder: string) => void;
 onArchive: () => void;
 onDelete?: () => void;
 onSplit?: () => void;
 onMerge?: () => void;
 /** Live channels this thread can be escalated (copied) into. */
 escalateChannels?: { id: string; title: string }[];
 onEscalateToChannel?: (targetChannelId: string) => void;
 /** Agents this thread can be handed off to (new/existing DM + dispatch). */
 escalateAgents?: { id: string; name: string; handle: string | null }[];
 onEscalateToAgent?: (targetAgent: { id: string; name: string; handle: string | null }) => void;
 presenceUsers?: ItemPresenceUser[];
}) {
 const actions = (
  <>
   {onSplit && !archived && (
    <DropdownMenuItem onSelect={() => onSplit()}>
     <Split data-icon="inline-start" />
     Split
    </DropdownMenuItem>
   )}
   {canMerge && onMerge && (
    <DropdownMenuItem onSelect={() => onMerge()}>
     <GitMerge data-icon="inline-start" />
     Merge into parent
    </DropdownMenuItem>
   )}
   <DropdownMenuItem onSelect={onArchive}>
    {archived ? <RotateCcw data-icon="inline-start" /> : <Archive data-icon="inline-start" />}
    {archived ? `Unarchive ${archiveNoun}` : `Archive ${archiveNoun}`}
   </DropdownMenuItem>
   {onDelete && (
    <>
     <DropdownMenuSeparator />
     <DropdownMenuItem
      className="text-destructive focus:text-destructive"
      onSelect={() => onDelete()}
     >
      <Trash2 data-icon="inline-start" />
      Delete
     </DropdownMenuItem>
    </>
   )}
  </>
 );

 return (
  <ContextMenu>
   <ContextMenuTrigger asChild>
    <div
     className="sidebar-session-row group flex min-w-0 w-full items-center gap-1 rounded-md pr-1 text-muted-foreground hover:bg-muted hover:text-foreground"
     data-active={active ? 'true' : undefined}
     style={depth ? { paddingLeft: depth * 12 } : undefined}
    >
     <button
      type="button"
      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-1 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
     >
      {chip ? (
       <RowChip kind={chip} />
      ) : (
       <span className="sidebar-item-icon flex size-4 shrink-0 items-center justify-center">
        {archived ? <Archive /> : icon || <MessageSquare />}
       </span>
      )}
      <span className="min-w-0 flex-1 truncate text-left">{session.title}</span>
      {source && (
       <>
        <span
         data-testid="nostr-source-chip"
         className="shrink-0 rounded border border-sky-500/30 bg-sky-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide text-sky-700 dark:text-sky-300"
         title="Mirrored from a Nostr community"
        >
         Nostr
        </span>
        {!source.enabled && (
         <span
          data-testid="nostr-subscription-state"
          className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide text-amber-700 dark:text-amber-300"
         >
          Paused
         </span>
        )}
       </>
      )}
      {/* "# general   5m 55s" while an agent is working in this session. Mounts
          its own 1s clock only while there IS work, so an idle sidebar runs no
          timers; the row itself never re-renders on that tick. */}
      <SessionWorkBadge sessionId={session.id} />
      {presenceUsers.length > 0 && (
       <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {presenceUsers.slice(0, 3).map(person => (
         <span
          key={person.userId}
          className="flex size-2 items-center justify-center overflow-hidden rounded-full text-[0px] font-semibold leading-none text-white ring-1 ring-background"
          style={{ backgroundColor: person.color }}
          title={`${person.name}${person.typing ? ' is typing' : ' is active'}`}
         >
          {person.name.trim().charAt(0).toUpperCase()}
         </span>
        ))}
        {presenceUsers.length > 3 && (
         <span className="text-[10px] leading-none text-muted-foreground">+{presenceUsers.length - 3}</span>
        )}
       </span>
      )}
     </button>
     <DropdownMenu>
      <DropdownMenuTrigger asChild>
       <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        aria-label={`More actions for ${session.title}`}
        onClick={event => event.stopPropagation()}
       >
        <MoreHorizontal className="size-4" />
       </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
       {actions}
      </DropdownMenuContent>
     </DropdownMenu>
    </div>
   </ContextMenuTrigger>
   <ContextMenuContent>
    <ContextMenuLabel>{session.title}</ContextMenuLabel>
    <ContextMenuSeparator />
    {onSplit && !archived && (
     <ContextMenuItem onSelect={() => onSplit()}>
      <Split data-icon="inline-start" />
      Split
     </ContextMenuItem>
    )}
    {canMerge && onMerge && (
     <ContextMenuItem onSelect={() => onMerge()}>
      <GitMerge data-icon="inline-start" />
      Merge into parent
     </ContextMenuItem>
    )}
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
    {onEscalateToChannel && escalateChannels.length > 0 && !archived && (
     <ContextMenuSub>
      <ContextMenuSubTrigger>
       <Hash data-icon="inline-start" />
       Move to channel
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
       {escalateChannels.map(channel => (
        <ContextMenuItem key={channel.id} onSelect={() => onEscalateToChannel(channel.id)}>
         {channel.title}
        </ContextMenuItem>
       ))}
      </ContextMenuSubContent>
     </ContextMenuSub>
    )}
    {onEscalateToAgent && escalateAgents.length > 0 && !archived && (
     <ContextMenuSub>
      <ContextMenuSubTrigger>
       <Bot data-icon="inline-start" />
       Hand to agent
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
       {escalateAgents.map(target => (
        <ContextMenuItem key={target.id} onSelect={() => onEscalateToAgent(target)}>
         {target.handle ? `@${target.handle}` : target.name}
        </ContextMenuItem>
       ))}
      </ContextMenuSubContent>
     </ContextMenuSub>
    )}
    <ContextMenuItem onSelect={onArchive}>
     {archived ? <RotateCcw data-icon="inline-start" /> : <Archive data-icon="inline-start" />}
     {archived ? `Unarchive ${archiveNoun}` : `Archive ${archiveNoun}`}
    </ContextMenuItem>
    {onDelete && (
     <>
      <ContextMenuSeparator />
      <ContextMenuItem
       className="text-destructive focus:text-destructive"
       onSelect={() => onDelete()}
      >
       <Trash2 data-icon="inline-start" />
       Delete
      </ContextMenuItem>
     </>
    )}
   </ContextMenuContent>
  </ContextMenu>
 );
}

function DocumentRow({
 doc,
 onOpen,
 onMoveFolder,
 onAddToCanvas,
 presenceUsers = [],
}: {
 doc: Document;
 onOpen: () => void;
 onMoveFolder: (folder: string) => void;
 onAddToCanvas?: (doc: Document) => void;
 presenceUsers?: ItemPresenceUser[];
}) {
 // Applet storage docs (folder === APPLETS_FOLDER) are source code, not prose —
 // a distinct icon flags that up front, and "Add to canvas" gives them a
 // one-click path onto the board without opening the doc first.
 const isApplet = doc.folder === APPLETS_FOLDER;
 return (
  <ContextMenu>
   <ContextMenuTrigger asChild>
    <div className="min-w-0 w-full">
     <ItemRow
      icon={isApplet ? <Code2 /> : <FileText />}
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
    {isApplet && onAddToCanvas && (
     <>
      <ContextMenuItem onSelect={() => onAddToCanvas(doc)}>
       <LayoutTemplate data-icon="inline-start" />
       Add to canvas
      </ContextMenuItem>
      <ContextMenuSeparator />
     </>
    )}
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
