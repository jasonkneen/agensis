import { buildChannelRoster, participantAgentKey, toPersistedParticipant } from '../../lib/sessionParticipants';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Brain,
  ChevronDown,
  Code2,
  Command as CommandIcon,
  CornerDownRight,
  Database,
  Eraser,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Columns2,
  Globe,
  Layers,
  Link2,
  Loader2,
  MessageSquare,
  Mic,
  Monitor,
  MoreHorizontal,
  Settings2,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Rocket,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UserPlus,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ChatThreadPanel } from '../chat/ChatThreadPanel';
import { ModelSelector } from '../chat/ModelSelector';
import { SubThreadPanel } from '../chat/SubThreadPanel';
import {
  ComposerAddContent,
  FileChip,
  buildFileContext,
  linkedProjectFile,
  linkedUploadedFile,
  type LinkedFile,
  type ProjectFileEntry,
  type ProjectFileSource,
} from '../chat/ComposerAddContent';
import { FileDetailPanel, ProjectFileRow, UploadedFileRow } from '../files/FilePanelItems';
import { panelFileName, type SelectedPanelFile } from '../../lib/uploadedFiles';
import { ThreadWidgetRail } from './ThreadWidgetRail';
import {
  RAIL_ANIMATION_MS,
  parseRailPreference,
  railPreferenceKey,
  resolveRailState,
  toggledRailPreference,
  type RailPreference,
} from '@/lib/threadWidgetRail';
import { HuddleMarkerRow } from '../huddle/HuddleMarkerRow';
import { HuddleMarkerGroupRow } from '../huddle/HuddleMarkerGroupRow';
import { EditChannelDialog } from '../chat/EditChannelDialog';
import { ConversationAccessDialog } from '../chat/ConversationAccessDialog';
import { channelIconGlyph, normalizeChannelIcon, type ChannelProfileDraft } from '../../lib/channelProfile';
import {
  CHANNEL_MENTION_HANDLE,
  CHANNEL_MENTION_MAX_AGENTS,
  agentMentionHandles,
  mentionsChannel,
  normalizeConversationMode,
} from '../../lib/channelMentions';
import { HuddleSessionProvider } from '../huddle/HuddleSessionContext';
import { useHuddleDock } from '../huddle/HuddleDockContext';
import { HuddleToolbarButton } from '../huddle/HuddleToolbarButton';
import { ChatArtifact, extractHtmlArtifact } from '../chat/ChatArtifact';
import { MarkdownContent } from '../chat/MarkdownContent';
import { LinkPreviewCards } from '../chat/LinkPreviewCards';
import { MessageAttachmentList } from '../chat/MessageAttachments';
import {
  buildMessageAttachments,
  parseMessageAttachments,
  stripUploadedFileLinesFromDisplay,
} from '../../lib/messageAttachments';
import { ToolStepGroup } from '../chat/ToolStepGroup';
import { buildTranscriptRows } from '../chat/toolSteps';
import { PermissionRequestCard } from '../chat/PermissionRequestCard';
import { isPermissionRequestMessage, resolvePermissionRequest } from '../chat/permissionRequests';
import { usePermissionRequests } from '../../hooks/usePermissionRequests';
import { shouldOverlaySidePanel, type ChatSidePanel } from '../chat/sidePanelLayout';
import { isBroadcastFromThread } from '../chat/channelView';
import { ConnectFlowsDialog } from '../integrations/ConnectFlowsDialog';
import {
  BUILTIN_SLASH_ITEMS,
  matchSlashItems,
  groupSlashItems,
  slashInsertText,
  type SlashItem,
  type SlashActionId,
} from '../../lib/slashCommands';
import { apiAuthHeaders, apiUrl, backendClient, getSlashCommands, type SystemCapabilities } from '../../lib/backendClient';
import { ReactionBar, ReactionPicker } from '../chat/ReactionBar';
import { ReadReceipt } from '../chat/ReadReceipt';
import { frequentReactions, noteReactionUse, reactionPills, reactionToggleOp, type ReactionUse } from '../../lib/reactionBar';
import { useReadReceipts } from '../../hooks/useReadReceipts';
import { useUserProfile } from '../../hooks/useUserProfile';
import { useWorkspaceUsers } from '../../hooks/useWorkspaceUsers';
import { EMPTY_STREAM_RESPONSE } from '../../lib/chatStream';
import type {
  CanvasGroup,
  CanvasObject,
  ChannelParticipant,
  ChatSession,
  Document,
  MemoryFact,
  Message as ChatMessage,
  MessageAttachment,
  AgentConnection,
  UploadedFile,
  WorkspaceAgent,
} from '../../types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Spinner } from '@/components/ui/spinner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { useMyThreads } from '../../hooks/useMyThreads';
import { useGateways } from '../../hooks/useGateways';
import { isImageAvatar, isPetSpritesheetAvatar, renderablePetAssetUrl } from '../../lib/openpets';
import { agentAccentColor, agentAccentStyle, agentHandle, validAgentAccentColor } from '../../lib/agentAccent';
import { huddleAgentOptions } from '../../lib/huddleAgents';
import { englishVoiceIds } from '../../lib/agentVoice';
import { useCartesiaVoices } from '../../hooks/useCartesiaVoices';
import { groupHuddleMarkers, type HuddleMarkerGroup, isHuddleMarkerMessage } from '../../lib/huddleTranscript';
import {
  activityLine,
  extractActivityVerb,
  isActivityPlaceholderMessage,
  isLiveActivityPlaceholder,
} from '../../lib/activityStatus';
import { buildThreadReplySummaries, formatLastReplyTime, type ThreadReplySummary } from '../../lib/threadSummary';
import { useSharedNow } from '../../hooks/useSharedNow';
import { ThreadWorkBadge } from '../chat/AgentWorkBadge';
import { cn } from '@/lib/utils';
import { getSettings } from '../../lib/settings';
import { shouldAnnounceTyping } from '../../lib/typingPresence';
import { availableChatModelId, workspaceChatModels } from '../../lib/sharedModels';
import { COMPOSER_ADDON_CLASS, COMPOSER_SHELL_CLASS, COMPOSER_TEXTAREA_CLASS, autosizeComposer } from '@/lib/composerStyles';
import { channelComposerPlaceholder, directMessageComposerPlaceholder } from '@/lib/composerPlaceholder';
import { useComposerAutosize } from '@/hooks/useComposerAutosize';
import type { SendOutcome } from '@/lib/writeFeedback';

interface ChatWindowContentProps {
  messages: ChatMessage[];
  topLevelMessages?: ChatMessage[];
  // NET-05: paginated history. hasMoreMessages gates a "Load earlier" affordance
  // at the top of the transcript; onLoadEarlier pages backwards (session bound by
  // the caller). Absent on read-only/inactive windows.
  hasMoreMessages?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  threadMessages?: ChatMessage[];
  threadReplyCounts?: Record<string, number>;
  activeThreadId?: string | null;
  streaming: boolean;
  memoryFacts: MemoryFact[];
  documents: Document[];
  agents?: WorkspaceAgent[];
  agentConnections?: AgentConnection[];
  presenceUsers?: ChannelPresenceUser[];
  selectedAgent?: WorkspaceAgent | null;
  onSelectAgent?: (agent: WorkspaceAgent | null) => void;
  canvasGroups?: CanvasGroup[];
  canvasObjects?: CanvasObject[];
  // May resolve `{ delivered: false }` — the message was rejected and rolled
  // back, so the composer restores the draft instead of eating it.
  // `attachments` are structured references to uploaded_files rows, for
  // rendering. They are IN ADDITION to the "[Linked files]" text that
  // buildFileContext folds into `content` for the agent — not a replacement.
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[], attachments?: MessageAttachment[]) => void | Promise<SendOutcome | void>;
  onOpenThread?: (messageId: string) => void;
  onCloseThread?: () => void;
  // broadcastToChannel = the thread composer's "Send to channel" switch: post the
  // reply in the thread AND show it in the channel (messages.broadcast_to_channel).
  onSendThreadReply?: (content: string, model: string, broadcastToChannel?: boolean) => void | Promise<SendOutcome | void>;
  /**
   * Tell the app a channel's own row changed (title, icon, description,
   * intent, participants). The window keeps its own copy of the channel for
   * its header, but the SIDEBAR reads the app's session list — so without this
   * a rename showed in the header and nowhere else until a reload.
   */
  onSessionMetaSaved?: (sessionId: string, patch: Record<string, unknown>) => void;
  readOnly?: boolean;
  channelTitle?: string;
  workspaceId?: string | null;
  uploadedFiles?: UploadedFile[];
  onUploadFiles?: (files: File[]) => Promise<UploadedFile[]>;
  onCreateTask?: (input: CreateTaskInput) => void | Promise<unknown>;
  systemCapabilities?: SystemCapabilities | null;
  // Rendered INSIDE the channel overflow menu, so it must be menu-item-shaped
  // (a DropdownMenuItem / DropdownMenuSub), not a standalone button.
  contextControls?: React.ReactNode;
  isDirectMessage?: boolean;
  /**
   * Fired as the draft becomes non-empty and again when it empties, blurs or
   * sends. Safe to fire on every keystroke — the 4s re-arm throttle lives in
   * useItemPresence/typingPresence, not here.
   *
   * Never fired for a direct message: `item-presence:<workspaceId>` fans out to
   * every member with `read`, and the frame carries the session id, so emitting
   * for a DM would tell the whole workspace that a private session exists and
   * is active. The sidebar's presence filtering is a UI convenience, not an
   * access boundary, and must not be relied on as one.
   */
  onTypingChange?: (typing: boolean) => void;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  onUpdateAgent?: (id: string, updates: Partial<WorkspaceAgent>) => void | Promise<unknown>;
  subThreadsByMessage?: Record<string, ChatSession[]>;
  activeSubThread?: ChatSession | null;
  subThreadMessages?: ChatMessage[];
  subThreadStreaming?: boolean;
  onOpenSubThread?: (session: ChatSession) => void;
  onCloseSubThread?: () => void;
  onCreateSubThread?: (messageId: string, agent: WorkspaceAgent, messageContent?: string) => void;
  onSendSubThreadMessage?: (content: string) => void;
  onSplitThread?: () => void;
  currentUserId?: string;
}

type ChannelPresenceUser = {
  id: string;
  name: string;
  kind?: 'user' | 'agent';
  status?: string;
  isCurrentUser?: boolean;
};


type ChannelSessionMeta = Pick<ChatSession, 'id' | 'title' | 'folder' | 'description' | 'icon' | 'intent' | 'is_favorite' | 'archived_at' | 'participants' | 'conversation_mode'>;

const CHANNEL_META_COLUMNS = '*';

type DisplayParticipant = ChannelParticipant & {
  connected?: boolean;
};

type ParticipantCandidate = ChannelParticipant & {
  subtitle?: string;
  connected?: boolean;
};

type MessageOverrides = Record<string, Partial<ChatMessage> & { deleted?: boolean }>;
// Declared beside the layout rule that consumes it, so the panel list and the
// "is it wide enough to split?" decision cannot drift apart.
export type { ChatSidePanel };

// The chat column: message list and composer share ONE width so they line up.
// They were independent before — the composer was centred at max-w-[800px] while
// the message list ran the full width of the window, so messages sat left of the
// input they belong to. Change this in one place or they drift apart again.
//
// Sharing the cap is only half of sharing the measure: the box the column is
// centred INSIDE has to be the same on both sides too, which is why the scroll
// viewport carries the composer shell's own horizontal padding (see
// MessageScrollerViewport below). The literal has to stay a literal for
// Tailwind to emit it, and CHAT_COLUMN_MAX_WIDTH in threadWidgetRail.ts mirrors
// it — the rail's gutter maths is derived from the same number.
const CHAT_COLUMN_CLASS = 'mx-auto w-full max-w-[800px]';

export const ChatWindowContent = React.memo(function ChatWindowContent({
  messages,
  topLevelMessages,
  hasMoreMessages = false,
  loadingEarlier = false,
  onLoadEarlier,
  threadMessages = [],
  threadReplyCounts = {},
  activeThreadId,
  streaming,
  memoryFacts,
  documents,
  agents = [],
  agentConnections = [],
  presenceUsers = [],
  canvasGroups = [],
  canvasObjects = [],
  onSendMessage,
  onOpenThread,
  onCloseThread,
  onSendThreadReply,
  onSessionMetaSaved,
  readOnly = false,
  channelTitle = 'general',
  workspaceId = null,
  uploadedFiles = [],
  onUploadFiles,
  onCreateTask,
  systemCapabilities = null,
  contextControls,
  isDirectMessage: isDirectMessageProp = false,
  onTypingChange,
  onUpdateAgent,
  subThreadsByMessage = {},
  activeSubThread,
  subThreadMessages = [],
  subThreadStreaming = false,
  onOpenSubThread,
  onCloseSubThread,
  onCreateSubThread,
  onSendSubThreadMessage,
  onSplitThread,
  currentUserId = '',
}: ChatWindowContentProps) {
  const [subThreadPickerMessageId, setSubThreadPickerMessageId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState(() => getSettings().ai_default_model || 'auto');
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [linkedGroups, setLinkedGroups] = useState<CanvasGroup[]>([]);
  const [linkedFiles, setLinkedFiles] = useState<LinkedFile[]>([]);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [addContextOpen, setAddContextOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [docPickerQuery, setDocPickerQuery] = useState('');
  const [groupPickerQuery, setGroupPickerQuery] = useState('');
  const [slashQuery, setSlashQuery] = useState('');
  const [remoteSlashItems, setRemoteSlashItems] = useState<SlashItem[]>([]);
  const [atStartPos, setAtStartPos] = useState(-1);
  const [hashStartPos, setHashStartPos] = useState(-1);
  const [slashStartPos, setSlashStartPos] = useState(-1);
  const [autoScroll, setAutoScroll] = useState(true);
  const [sidePanel, setSidePanel] = useState<ChatSidePanel | null>(null);
  const [railPreference, setRailPreference] = useState<RailPreference>('auto');
  const [railHasContent, setRailHasContent] = useState(false);
  const [railSurfaceWidth, setRailSurfaceWidth] = useState<number | null>(null);
  const [profileAgentKey, setProfileAgentKey] = useState<string | null>(null);
  const [catchUpOpen, setCatchUpOpen] = useState(false);
  const [addParticipantsOpen, setAddParticipantsOpen] = useState(false);
  const [channelMeta, setChannelMeta] = useState<ChannelSessionMeta | null>(null);
  const [channelActionStatus, setChannelActionStatus] = useState('');
  const [flowConnectOpen, setFlowConnectOpen] = useState(false);
  const [flowConnectChannelId, setFlowConnectChannelId] = useState<string | null>(null);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<Set<string>>(() => new Set());
  const [messageOverrides, setMessageOverrides] = useState<MessageOverrides>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [messageActionBusy, setMessageActionBusy] = useState<string | null>(null);
  const [deleteMessageTarget, setDeleteMessageTarget] = useState<ChatMessage | null>(null);
  const [panelWidth, setPanelWidth] = useState(360);
  const [shellWidth, setShellWidth] = useState(0);
  // Thread replies read better as a near-even split than the narrow fixed
  // sidebar used for files/pins/profile/sub-thread panels, so it gets its own
  // width state. `null` means "not manually resized yet" — render at a CSS
  // percentage (auto-adjusts as the window resizes) rather than a stale px
  // value computed once at open time.
  const [threadPanelWidth, setThreadPanelWidth] = useState<number | null>(null);
  const [projectFiles, setProjectFiles] = useState<ProjectFileEntry[]>([]);
  const [projectRoot, setProjectRoot] = useState('');
  const [projectFileSources, setProjectFileSources] = useState<ProjectFileSource[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const sidePanelRef = useRef<HTMLElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useComposerAutosize(inputRef, input);

  const filteredDocs = useMemo(() => {
    const q = docPickerQuery.toLowerCase();
    return documents.filter(d => d.title.toLowerCase().includes(q));
  }, [documents, docPickerQuery]);

  const filteredAgents = useMemo(() => {
    const q = docPickerQuery.toLowerCase();
    return agents.filter(agent => {
      if (agent.enabled === false) return false;
      const handle = agentHandle(agent);
      return agent.name.toLowerCase().includes(q) || handle.includes(q);
    });
  }, [agents, docPickerQuery]);

  const filteredGroups = useMemo(() => {
    const q = groupPickerQuery.toLowerCase();
    return canvasGroups.filter(g => g.name.toLowerCase().includes(q));
  }, [canvasGroups, groupPickerQuery]);

  const composerProjectGroups = useMemo(() => {
    if (projectFileSources.length > 0) {
      return projectFileSources
        .map(source => ({ source, files: Array.isArray(source.files) ? source.files : [] }))
        .filter(group => group.files.length > 0);
    }
    if (projectFiles.length === 0) return [];
    return [{
      source: { id: 'workspace', kind: 'workspace' as const, label: 'Workspace folder', root: projectRoot, files: projectFiles },
      files: projectFiles,
    }];
  }, [projectFileSources, projectFiles, projectRoot]);

  const composerProjectFiles = useMemo(
    () => composerProjectGroups.flatMap(group => group.files.slice(0, 8).map(file => ({ file, source: group.source }))),
    [composerProjectGroups],
  );
  const { gateways } = useGateways(workspaceId || null);
  const modelOptions = useMemo(
    () => workspaceChatModels(workspaceId, agentConnections, gateways),
    [workspaceId, agentConnections, gateways],
  );

  useEffect(() => {
    setSelectedModel(current => availableChatModelId(current, modelOptions));
  }, [modelOptions]);

  const skillOptions = useMemo(() => {
    const fromCapabilities = systemCapabilities?.skills
      .filter(skill => skill.available && (skill.type === 'skills' || skill.type === 'agents'))
      .map(skill => ({
        id: skill.id,
        label: skill.label,
        detail: `${skill.count} item${skill.count === 1 ? '' : 's'}`,
      })) || [];
    const fromAgents = Array.from(new Set(agents.flatMap(agent => normalizeStringList(agent.skills))))
      .map(skill => ({ id: skill, label: skill, detail: 'Agent skill' }));
    return [...fromCapabilities, ...fromAgents].slice(0, 10);
  }, [agents, systemCapabilities]);

  const toolOptions = useMemo(() => {
    const packages = systemCapabilities?.packages
      .filter(pkg => pkg.available)
      .map(pkg => ({ id: pkg.name, label: pkg.name, detail: pkg.version || 'Package' })) || [];
    const commands = systemCapabilities?.clis
      .filter(cli => cli.available)
      .map(cli => ({ id: cli.id, label: cli.label, detail: cli.command })) || [];
    const agentTools = Array.from(new Set(agents.flatMap(agent => normalizeStringList(agent.tools))))
      .map(tool => ({ id: tool, label: tool, detail: 'Agent tool' }));
    const codexServer = systemCapabilities?.codexAppServer.available
      ? [{ id: 'codex-app-server', label: 'Codex app server', detail: systemCapabilities.codexAppServer.command }]
      : [];
    return [...packages, ...commands, ...codexServer, ...agentTools].slice(0, 10);
  }, [agents, systemCapabilities]);

  // Real slash commands the connected daemons enumerated on their own machines —
  // loose `.claude/commands`, folder-namespaced `parent:child` commands, and skills.
  // Fetched from the backend (which merges each daemon's capability push) since the
  // composer can't see the user's filesystem directly.
  useEffect(() => {
    if (!workspaceId) {
      setRemoteSlashItems([]);
      return;
    }
    let cancelled = false;
    getSlashCommands(workspaceId)
      .then(items => { if (!cancelled) setRemoteSlashItems(items); })
      .catch(() => { if (!cancelled) setRemoteSlashItems([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Insert-kind slash items: the real daemon-enumerated commands/skills, plus the
  // connected agents' advertised skill names as a fallback (deduped by id). The
  // `parent` field drives the nested display for skill-commands.
  const enumeratedSlashItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = [];
    const seen = new Set<string>();
    const push = (item: SlashItem) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      items.push(item);
    };
    for (const item of remoteSlashItems) push(item);
    for (const name of new Set(agents.flatMap(agent => normalizeStringList(agent.skills)))) {
      push({ id: `skill:${name}`, name, kind: 'skill', run: 'insert', detail: 'Skill' });
    }
    return items;
  }, [remoteSlashItems, agents]);

  const buildGroupContext = (groups: CanvasGroup[]): string => {
    return groups.map(group => {
      const groupObjects = canvasObjects.filter(object => object.group_id === group.id);
      const description = groupObjects.map(object => {
        if (object.type === 'text') return `Text: "${object.text_content}"`;
        if (object.type === 'image') return `Image: ${object.file_name || object.src || 'unnamed'}`;
        return `${object.type} shape`;
      }).join(', ');
      return `[Canvas Group "${group.name}": ${description || 'empty'}]`;
    }).join('\n');
  };

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    let content = input.trim();
    if (linkedFiles.length > 0) {
      content = `${buildFileContext(linkedFiles)}\n\n${content}`;
    }
    if (linkedGroups.length > 0) {
      content = `${buildGroupContext(linkedGroups)}\n\n${content}`;
    }
    // Stay optimistic — the message appears in the transcript immediately and
    // the box clears — but keep the draft until the write is confirmed. A
    // rejected send rolls its row back, and without this the user's text went
    // with it.
    const draft = { input, linkedDocs, linkedGroups, linkedFiles };
    setInput('');
    setLinkedDocs([]);
    setLinkedGroups([]);
    setLinkedFiles([]);
    inputRef.current?.focus();

    // Structured attachment references for the uploaded files, so the bubble can
    // draw a real thumbnail/chip. The "[Linked files]" text built above STAYS in
    // `content` — that is still the only way the agent learns a file came with
    // the turn. Project files contribute text only; there is nothing to fetch.
    const attachments = buildMessageAttachments(draft.linkedFiles);
    const outcome = await onSendMessage(
      content,
      selectedModel,
      memoryFacts,
      draft.linkedDocs.length > 0 ? draft.linkedDocs : undefined,
      attachments.length > 0 ? attachments : undefined,
    );
    if (outcome && outcome.delivered === false) {
      setInput(draft.input);
      setLinkedDocs(draft.linkedDocs);
      setLinkedGroups(draft.linkedGroups);
      setLinkedFiles(draft.linkedFiles);
      inputRef.current?.focus();
    }
  };

  const insertComposerText = (text: string) => {
    const target = inputRef.current;
    const start = target?.selectionStart ?? input.length;
    const end = target?.selectionEnd ?? input.length;
    const needsSpaceBefore = start > 0 && !/\s$/.test(input.slice(0, start));
    const needsSpaceAfter = end < input.length && !/^\s/.test(input.slice(end));
    const next = `${input.slice(0, start)}${needsSpaceBefore ? ' ' : ''}${text}${needsSpaceAfter ? ' ' : ''}${input.slice(end)}`;
    setInput(next);
    setAddContextOpen(false);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const cursor = start + text.length + (needsSpaceBefore ? 1 : 0);
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const addLinkedFile = (file: LinkedFile) => {
    setLinkedFiles(prev => prev.find(item => item.id === file.id) ? prev : [...prev, file]);
    setAddContextOpen(false);
    inputRef.current?.focus();
  };

  const addLinkedDoc = (doc: Document) => {
    if (!linkedDocs.find(item => item.id === doc.id)) setLinkedDocs(prev => [...prev, doc]);
    setAddContextOpen(false);
    inputRef.current?.focus();
  };

  const addLinkedGroup = (group: CanvasGroup) => {
    if (!linkedGroups.find(item => item.id === group.id)) setLinkedGroups(prev => [...prev, group]);
    setAddContextOpen(false);
    inputRef.current?.focus();
  };

  const uploadAndLinkFiles = async (files: File[]) => {
    if (!files.length || !onUploadFiles) return;
    setUploadStatus('Uploading...');
    try {
      const uploaded = await onUploadFiles(files);
      setLinkedFiles(prev => {
        const existing = new Set(prev.map(file => file.id));
        const next = [...prev];
        uploaded.forEach(file => {
          const linked = linkedUploadedFile(file);
          if (!existing.has(linked.id)) next.push(linked);
        });
        return next;
      });
      setUploadStatus(uploaded.length > 0 ? `${uploaded.length} file${uploaded.length === 1 ? '' : 's'} attached` : 'Upload failed');
      if (uploaded.length > 0) setAddContextOpen(false);
    } catch {
      setUploadStatus('Upload failed');
    } finally {
      inputRef.current?.focus();
    }
  };

  const handleUploadSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await uploadAndLinkFiles(files);
  };

  // Paste/drop scoped to the composer: stopPropagation so dropping or pasting
  // a file here attaches it to the message instead of falling through to the
  // canvas-wide CanvasDropZone, which would otherwise create a new canvas object.
  const handleComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadAndLinkFiles(files);
  };

  const handleComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadAndLinkFiles(files);
  };

  const insertMentionHandle = (handle: string) => {
    const selectionEnd = inputRef.current?.selectionStart || input.length;
    const before = input.slice(0, Math.max(0, atStartPos));
    const after = input.slice(selectionEnd);
    const suffix = after.startsWith(' ') || after.length === 0 ? after : ` ${after}`;
    setInput(`${before}@${handle} ${suffix}`.replace(/\s+$/, ' '));
    setShowDocPicker(false);
    setDocPickerQuery('');
    setAtStartPos(-1);
    inputRef.current?.focus();
  };

  const handleAgentSelect = (agent: WorkspaceAgent) => insertMentionHandle(agentHandle(agent));

  const handleDocSelect = (doc: Document) => {
    if (!linkedDocs.find(d => d.id === doc.id)) {
      setLinkedDocs(prev => [...prev, doc]);
    }
    const before = input.slice(0, atStartPos);
    const after = input.slice(inputRef.current?.selectionStart || input.length);
    setInput(before + after);
    setShowDocPicker(false);
    setDocPickerQuery('');
    setAtStartPos(-1);
    inputRef.current?.focus();
  };

  const handleGroupSelect = (group: CanvasGroup) => {
    if (!linkedGroups.find(g => g.id === group.id)) {
      setLinkedGroups(prev => [...prev, group]);
    }
    const before = input.slice(0, hashStartPos);
    const after = input.slice(inputRef.current?.selectionStart || input.length);
    setInput(before + after);
    setShowGroupPicker(false);
    setGroupPickerQuery('');
    setHashStartPos(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashPicker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashPicker();
        return;
      }
      // Tab or Enter completes the top-ranked command and closes the / menu.
      if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && filteredSlash.length > 0) {
        e.preventDefault();
        handleSlashSelect(filteredSlash[0]);
        return;
      }
    }

    if (showDocPicker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowDocPicker(false);
        return;
      }
      // Tab or Enter completes the top item and closes the @ menu. The order
      // mirrors what is RENDERED: agents, then Everyone, then documents. @channel
      // is deliberately behind the agents — someone typing "@sc" for Scout must
      // never get "ask all six" from a reflex Tab — but once the typed text rules
      // every agent out ("@chann"), it is the top item on screen and completing
      // anything else would mean the keyboard and the eye disagree.
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (filteredAgents.length > 0) {
          e.preventDefault();
          handleAgentSelect(filteredAgents[0]);
          return;
        }
        if (showChannelMentionOption && docPickerQuery.trim()) {
          e.preventDefault();
          insertMentionHandle(CHANNEL_MENTION_HANDLE);
          return;
        }
        if (filteredDocs.length > 0) {
          e.preventDefault();
          handleDocSelect(filteredDocs[0]);
          return;
        }
      }
    }

    if (showGroupPicker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowGroupPicker(false);
        return;
      }
      // Tab or Enter completes the top group and closes the # menu.
      if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && filteredGroups.length > 0) {
        e.preventDefault();
        handleGroupSelect(filteredGroups[0]);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    if (showDocPicker && atStartPos >= 0) {
      const afterAt = value.slice(atStartPos + 1);
      if (afterAt.indexOf(' ') === -1) {
        setDocPickerQuery(afterAt);
      } else {
        setShowDocPicker(false);
        setDocPickerQuery('');
        setAtStartPos(-1);
      }
    }

    if (showGroupPicker && hashStartPos >= 0) {
      const afterHash = value.slice(hashStartPos + 1);
      if (afterHash.indexOf(' ') === -1) {
        setGroupPickerQuery(afterHash);
      } else {
        setShowGroupPicker(false);
        setGroupPickerQuery('');
        setHashStartPos(-1);
      }
    }

    if (showSlashPicker && slashStartPos >= 0) {
      const afterSlash = value.slice(slashStartPos + 1);
      if (afterSlash.indexOf(' ') === -1) {
        setSlashQuery(afterSlash);
      } else {
        closeSlashPicker();
      }
    }

    const cursor = e.target.selectionStart || 0;
    if (value[cursor - 1] === '@' && !showDocPicker) {
      setShowDocPicker(true);
      setShowGroupPicker(false);
      setShowSlashPicker(false);
      setDocPickerQuery('');
      setAtStartPos(cursor - 1);
    }
    if (value[cursor - 1] === '#' && !showGroupPicker) {
      setShowGroupPicker(true);
      setShowDocPicker(false);
      setShowSlashPicker(false);
      setGroupPickerQuery('');
      setHashStartPos(cursor - 1);
    }
    // `/` opens the command menu, but only at the start of a word (start of input
    // or right after whitespace) so it never fires inside URLs like http://.
    if (
      value[cursor - 1] === '/' &&
      !showSlashPicker &&
      (cursor === 1 || /\s/.test(value[cursor - 2] || ''))
    ) {
      setShowSlashPicker(true);
      setShowDocPicker(false);
      setShowGroupPicker(false);
      setSlashQuery('');
      setSlashStartPos(cursor - 1);
    }
  };

  const visibleMessages = useMemo(() => applyMessageOverrides(messages, messageOverrides), [messages, messageOverrides]);
  const displayMessages = useMemo(
    () => applyMessageOverrides(topLevelMessages ?? messages, messageOverrides),
    [messages, messageOverrides, topLevelMessages],
  );
  const visibleThreadMessages = useMemo(
    () => applyMessageOverrides(threadMessages, messageOverrides),
    [messageOverrides, threadMessages],
  );
  const parentMessage = activeThreadId ? visibleMessages.find(m => m.id === activeThreadId) : null;
  const pinnedMessages = visibleMessages.filter(message => message.pinned);
  const subThreadCount = useMemo(
    () => Object.values(subThreadsByMessage).reduce((total, list) => total + list.length, 0),
    [subThreadsByMessage],
  );
  const inferredSessionId = useMemo(() => (
    messages[0]?.session_id ||
    topLevelMessages?.[0]?.session_id ||
    threadMessages[0]?.session_id ||
    null
  ), [messages, threadMessages, topLevelMessages]);

  // --- Reactions and read receipts ------------------------------------------
  //
  // The workspace roster is what turns a uuid into a name in a reaction tooltip
  // and a receipt tooltip. Where an id will not resolve the helpers render
  // "Someone" — a raw uuid is useless to the reader and a small identifier leak
  // into any screenshot of it.
  const { members: workspaceMembers } = useWorkspaceUsers(workspaceId || null);
  // A reader id is a human user id OR an agent id (read receipts now cover both),
  // so resolve against members first, then the agent roster — an agent's eye
  // needs its name in the tooltip exactly like a person's.
  const resolveUserName = useCallback((readerId: string) => {
    const member = workspaceMembers.find(row => String(row.user_id) === String(readerId));
    if (member) return member.email ? member.email.split('@')[0] : null;
    const agent = agents.find(row => String(row.id) === String(readerId));
    if (agent) return agent.name || null;
    return null;
  }, [workspaceMembers, agents]);

  // The user's own reciprocal opt-out. The SERVER enforces both halves — an
  // opted-out marker is never stored, and the read returns nothing — so this is
  // only what stops the client asking.
  const { profile: myProfile } = useUserProfile(currentUserId || null);
  const receiptsEnabled = myProfile ? myProfile.share_read_receipts !== false : true;

  const receipts = useReadReceipts({
    sessionId: inferredSessionId,
    currentUserId: currentUserId || null,
    // Only the focused conversation. A background window has been read by
    // nobody, and the indicator is only drawn where it is focused.
    active: !readOnly,
    enabled: receiptsEnabled,
  });

  // Picker history, per account and local only: nobody else's ranking is
  // affected by what you reach for.
  const [reactionUses, setReactionUses] = useState<ReactionUse[]>([]);

  // Advance the read marker as messages arrive while this conversation is on
  // screen. The POLICY decides whether anything is written (src/lib/readReceipts.ts):
  // a hidden tab, an unchanged newest id, your own message and the re-arm window
  // all suppress it. The model does the rest of the work — a high-water mark
  // means scrolling past two hundred messages is one write, not two hundred.
  const noteVisibleRead = receipts.noteVisible;
  const newestVisibleMessage = visibleMessages.length > 0
    ? visibleMessages[visibleMessages.length - 1]
    : null;
  useEffect(() => {
    noteVisibleRead(newestVisibleMessage);
  }, [noteVisibleRead, newestVisibleMessage]);

  // One flush on the way out of the PAGE, so closing a tab records what was
  // actually read rather than losing up to RECEIPT_REARM_MS of it.
  //
  // Deliberately not on unmount: by the time a conversation switch has
  // re-rendered, the newest message already belongs to the conversation being
  // opened, so a flush there would post the new session's message id against the
  // old session's route — which the server's `m.session_id = $1` guard correctly
  // refuses. Nothing is lost, because the marker advanced through the normal
  // path the whole time the conversation was being read.
  const newestVisibleRef = useRef(newestVisibleMessage);
  newestVisibleRef.current = newestVisibleMessage;
  useEffect(() => {
    const flush = () => noteVisibleRead(newestVisibleRef.current, { flush: true });
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [noteVisibleRead]);

  // Only the LAST message of each of your contiguous runs carries an indicator;
  // a five-message burst would otherwise draw five identical eyes.
  const receiptAnchors = useMemo(
    () => receipts.anchorIds(visibleMessages),
    [receipts, visibleMessages],
  );
  // Floating thread widgets. The rail shows itself once the session's widgets
  // have content and hides again on the toolbar toggle — see
  // `src/lib/threadWidgetRail.ts` for the whole decision, including why the
  // message column's width is identical whether the rail is open or shut.
  const showWidgetRail = !readOnly && !!inferredSessionId && !!workspaceId;
  // The huddle trigger in the channel toolbar. Bound to THIS session so the
  // call belongs to the conversation it was called from — but the call itself
  // lives in the app-level dock, not here.
  const showHuddle = !readOnly && !!inferredSessionId && !!workspaceId;
  const rail = useMemo(
    () => resolveRailState({
      hasContent: railHasContent,
      preference: railPreference,
      surfaceWidth: railSurfaceWidth,
      applies: showWidgetRail,
    }),
    [railHasContent, railPreference, railSurfaceWidth, showWidgetRail],
  );
  const railOpen = rail.open;
  // Space the chat body gives up so the rail can sit BESIDE the conversation.
  // Zero unless there's room for it without narrowing the message column.
  const railReserve = railOpen ? rail.reserve : 0;
  // Only while floating on top does anything inside a message row need to dodge
  // the cards — beside the conversation, the row never reaches them.
  const railOverlaying = railOpen && rail.layout === 'overlay';
  const toggleWidgetRail = useCallback(() => {
    const next = toggledRailPreference(rail.open);
    setRailPreference(next);
    if (inferredSessionId) {
      try { localStorage.setItem(railPreferenceKey(inferredSessionId), next); } catch { /* ignore quota */ }
    }
  }, [rail.open, inferredSessionId]);
  // A choice made by hand is per session and sticky: reload it when the session
  // changes, and drop the content flag so the new session's rail doesn't
  // inherit the last one's answer before its own items have loaded.
  useEffect(() => {
    setRailHasContent(false);
    if (!inferredSessionId) { setRailPreference('auto'); return; }
    try { setRailPreference(parseRailPreference(localStorage.getItem(railPreferenceKey(inferredSessionId)))); }
    catch { setRailPreference('auto'); }
  }, [inferredSessionId]);
  // "Clear my head": eject the current view without deleting anything. A per-session
  // cutoff timestamp (persisted) hides messages at/before it; "Show earlier" lifts it.
  const clearKey = inferredSessionId ? `agensis_channel_clear_${inferredSessionId}` : null;
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  useEffect(() => {
    setClearedAt(clearKey ? localStorage.getItem(clearKey) : null);
  }, [clearKey]);
  const clearView = useCallback(() => {
    if (!clearKey) return;
    const cutoff = new Date().toISOString();
    localStorage.setItem(clearKey, cutoff);
    setClearedAt(cutoff);
  }, [clearKey]);
  const restoreView = useCallback(() => {
    if (!clearKey) return;
    localStorage.removeItem(clearKey);
    setClearedAt(null);
  }, [clearKey]);
  const clearCutoffMs = clearedAt ? new Date(clearedAt).getTime() : 0;
  const shownMessages = useMemo(
    () => (clearCutoffMs ? displayMessages.filter(m => new Date(m.created_at).getTime() > clearCutoffMs) : displayMessages),
    [displayMessages, clearCutoffMs],
  );
  const hiddenCount = displayMessages.length - shownMessages.length;

  // Tool approvals. A permission_request message is only an ANCHOR — its state
  // (still open? granted for how long? by whom?) lives on the request row, which
  // arrives over realtime, so the card is looked up by id rather than rendered
  // from the message alone. A card whose row has not arrived yet falls back to
  // the message's own sentence, which is always true if less useful.
  const {
    byId: permissionRequestsById,
    busyId: permissionBusyId,
    decide: decidePermission,
  } = usePermissionRequests(workspaceId || null);

  // Consecutive tool steps collapse into one chip row; every other message keeps its
  // own row at its original position. Order is never changed. A permission request the
  // human already answered folds into the chip for the call it gated (resolver below),
  // so decided approvals stop stacking up as their own rows; still-pending ones stay
  // rows so their card keeps its buttons.
  const resolvePermissionForRow = useCallback(
    (message: ChatMessage) => resolvePermissionRequest(message, permissionRequestsById),
    [permissionRequestsById],
  );
  const shownRows = useMemo(
    () => buildTranscriptRows(shownMessages, undefined, resolvePermissionForRow),
    [shownMessages, resolvePermissionForRow],
  );

  // Marker runs, resolved once per message list rather than per row: the row
  // loop needs to know both "does a group START here" and "is this marker
  // already inside one", and asking that per row would be quadratic.
  const { huddleGroupByLeadId, huddleGroupedIds } = useMemo(() => {
    const byLead = new Map<string, HuddleMarkerGroup>();
    const swallowed = new Set<string>();
    for (const entry of groupHuddleMarkers(shownMessages)) {
      if ((entry as HuddleMarkerGroup).kind !== 'huddle-group') continue;
      const group = entry as HuddleMarkerGroup;
      byLead.set(group.messages[0].id, group);
      group.messages.slice(1).forEach(message => swallowed.add(message.id));
    }
    return { huddleGroupByLeadId: byLead, huddleGroupedIds: swallowed };
  }, [shownMessages]);

  // Slash menu: built-ins that actually have a home here + the enumerated inserts,
  // fuzzy-ranked and grouped for display. `/split` only when splitting is wired;
  // `/restore` only when there's a cleared view to bring back.
  const availableBuiltins = useMemo(
    () => BUILTIN_SLASH_ITEMS.filter(item => {
      if (item.action === 'split') return !!onSplitThread;
      if (item.action === 'restore') return !!clearedAt;
      return true;
    }),
    [onSplitThread, clearedAt],
  );
  const slashItems = useMemo(
    () => [...availableBuiltins, ...enumeratedSlashItems],
    [availableBuiltins, enumeratedSlashItems],
  );
  const filteredSlash = useMemo(() => matchSlashItems(slashItems, slashQuery), [slashItems, slashQuery]);
  const slashGroups = useMemo(() => groupSlashItems(filteredSlash), [filteredSlash]);

  const runSlashAction = useCallback((action: SlashActionId) => {
    if (action === 'clear') clearView();
    else if (action === 'restore') restoreView();
    else if (action === 'split') onSplitThread?.();
  }, [clearView, restoreView, onSplitThread]);

  const closeSlashPicker = useCallback(() => {
    setShowSlashPicker(false);
    setSlashQuery('');
    setSlashStartPos(-1);
  }, []);

  const handleSlashSelect = useCallback((item: SlashItem) => {
    const target = inputRef.current;
    const selectionEnd = target?.selectionStart ?? input.length;
    const before = input.slice(0, Math.max(0, slashStartPos));
    const after = input.slice(selectionEnd);
    if (item.run === 'action') {
      // Built-in: strip the /token entirely, then fire the app action.
      setInput(`${before}${after.replace(/^\s+/, '')}`);
      closeSlashPicker();
      if (item.action) runSlashAction(item.action);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    // Insert-kind: replace the /token with the command text the agent will read.
    const token = slashInsertText(item);
    const needsSpaceAfter = after.length === 0 || !/^\s/.test(after);
    setInput(`${before}${token}${needsSpaceAfter ? ' ' : ''}${after}`);
    closeSlashPicker();
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const cursor = before.length + token.length + (needsSpaceAfter ? 1 : 0);
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }, [input, slashStartPos, closeSlashPicker, runSlashAction]);

  // Open the sub-thread side panel whenever activeSubThread is set (e.g. after creation)
  useEffect(() => {
    if (activeSubThread) setSidePanel('sub-thread');
  }, [activeSubThread]);

  useEffect(() => {
    if (!inferredSessionId && (!workspaceId || !channelTitle)) {
      setChannelMeta(null);
      return;
    }

    let cancelled = false;
    const loadChannelMeta = async () => {
      try {
        if (inferredSessionId) {
          const { data } = await backendClient
            .from<ChannelSessionMeta>('chat_sessions')
            .select(CHANNEL_META_COLUMNS)
            .eq('id', inferredSessionId)
            .maybeSingle();
          if (!cancelled) {
            setChannelMeta(data ? normalizeChannelSessionMeta(data) : {
              id: inferredSessionId,
              title: channelTitle || 'general',
              is_favorite: false,
              archived_at: null,
              participants: [],
            });
          }
          return;
        }

        const { data } = await backendClient
          .from<ChannelSessionMeta[]>('chat_sessions')
          .select(CHANNEL_META_COLUMNS)
          .eq('workspace_id', workspaceId)
          .eq('title', channelTitle)
          .order('updated_at', { ascending: false })
          .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (!cancelled) setChannelMeta(row ? normalizeChannelSessionMeta(row) : null);
      } catch {
        if (!cancelled && inferredSessionId) {
          setChannelMeta({
            id: inferredSessionId,
            title: channelTitle || 'general',
            folder: null,
            is_favorite: false,
            archived_at: null,
            participants: [],
          });
        }
      }
    };

    void loadChannelMeta();
    return () => {
      cancelled = true;
    };
  }, [channelTitle, inferredSessionId, workspaceId]);

  const persistedParticipants = useMemo(
    () => normalizeChannelParticipants(channelMeta?.participants),
    [channelMeta?.participants],
  );
  const directAgent = useMemo(
    () => directAgentFromParticipants(persistedParticipants),
    [persistedParticipants],
  );
  // Live "who's working right now" for the status line above the composer —
  // derived only from this session's own messages, so it never leaks across
  // windows and auto-clears the instant real content replaces the placeholder.
  // A placeholder left behind by a job that died is NOT proof of work, so it is
  // filtered by age here as well as in the transcript's chips.
  const thinkingAgents = useMemo(() => {
    const entries: { name: string; activity: string }[] = [];
    for (const m of displayMessages) {
      if (!isLiveActivityPlaceholder(m)) continue;
      const name = (m.sender_name || directAgent?.name || 'Agent').trim();
      const activity = extractActivityVerb(safeMessageText(m.content));
      if (name && !entries.find(e => e.name === name)) entries.push({ name, activity });
    }
    return entries;
  }, [displayMessages, directAgent]);
  const isDirectMessage = isDirectMessageProp || Boolean(directAgent) || channelMeta?.folder === 'Direct messages';

  // Typing presence. The composer is the only thing that knows a human is
  // mid-sentence; the throttle, the TTL and the fan-out all live downstream in
  // useItemPresence / src/lib/typingPresence.ts, so this can fire freely.
  //
  // `input` is the whole trigger: emptying the box, sending (handleSend clears
  // it) and unmounting all resolve to "not typing". Whether this composer may
  // announce at all — DMs may not — is shouldAnnounceTyping's call, which is
  // where the reason is written down and where a test can reach it.
  const typingEnabled = shouldAnnounceTyping({
    hasSink: !!onTypingChange,
    isDirectMessage,
    readOnly,
  });
  const typingSinkRef = useRef<((typing: boolean) => void) | undefined>(undefined);
  useEffect(() => {
    typingSinkRef.current = typingEnabled ? onTypingChange : undefined;
  }, [onTypingChange, typingEnabled]);
  useEffect(() => {
    if (!typingEnabled) return;
    onTypingChange?.(input.trim().length > 0);
  }, [input, typingEnabled, onTypingChange]);
  // Closing the window or switching channels must not leave an indicator up on
  // someone else's screen for the rest of the TTL.
  useEffect(() => () => { typingSinkRef.current?.(false); }, []);
  const handleComposerBlur = () => {
    if (typingEnabled) onTypingChange?.(false);
  };

  const directProfileKey = directAgent?.agent_id || directAgent?.handle || directAgent?.name || null;
  const profileAgent = useMemo(() => {
    const key = profileAgentKey || directProfileKey;
    if (!key) return null;
    return agents.find(agent => agentMatchesLookupKey(agent, key)) || null;
  }, [agents, directProfileKey, profileAgentKey]);
  const profileParticipant = useMemo(() => {
    const key = profileAgentKey || profileAgent?.id || directProfileKey;
    if (!key) return directAgent;
    return persistedParticipants.find(participant => participantMatchesLookupKey(participant, key)) || directAgent;
  }, [directAgent, directProfileKey, persistedParticipants, profileAgent, profileAgentKey]);

  // Width of the chat shell itself, not the viewport. On the agents view the
  // chat is a floating window inside a large page, so `useIsMobile` answers the
  // wrong question — it would report "desktop" for a window too narrow to hold
  // a transcript and a panel side by side.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      // Ignore a transient 0 (the window is collapsed or being torn down):
      // treating it as "very narrow" would flip a panel to full width on the
      // way out and animate it back in on the way in.
      if (width > 0) setShellWidth(width);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  // A DM deliberately opens with NO side panel. Auto-opening the agent profile
  // spent half the width on a card nobody asked for — worst in a narrow window,
  // where it left the messages in a column a few words wide. The profile is one
  // click away on the toolbar, and that click is the request.

  const participantCandidates = useMemo(
    () => buildParticipantCandidates(presenceUsers, agents, agentConnections, persistedParticipants),
    [agentConnections, agents, persistedParticipants, presenceUsers],
  );

  // WHO IS IN THIS CHANNEL — the stored roster, and nothing else.
  //
  // This used to merge workspace PRESENCE in wholesale, so every agent that
  // happened to be online anywhere in the workspace appeared as a member of
  // every channel. The owner caught it exactly: "4 in the room, no one there
  // because they are not really there" — the header counted four while the
  // huddle, which reads the stored roster, correctly said one. The add dialog
  // was telling the truth all along by offering those agents as "Add"; the
  // dropdown was the liar, and the mismatch is what made adding them look like
  // it produced duplicates.
  //
  // Presence still contributes STATUS to a stored member (withLiveParticipantStatus
  // and the branch below) — being online is a property of someone in the room,
  // not a way into it. Humans present in the channel are a separate matter from
  // agents: a human who has the channel open IS in it, which is what the
  // presence feed means for people, so live humans are still merged.
  const participants = useMemo(
    () => buildChannelRoster<ChannelParticipant, DisplayParticipant>({
      stored: persistedParticipants,
      present: presenceUsers,
      decorate: participant => withLiveParticipantStatus(participant, agents, agentConnections),
    }),
    [agentConnections, agents, persistedParticipants, presenceUsers],
  );

  // Agents @mentioned in the current draft that aren't channel participants yet.
  // On send, the server adds them to the roster (ensureMentionedParticipants), so
  // we surface a small heads-up here. Uses the SAME parser the server dispatches
  // with (src/lib/channelMentions.ts, pinned to shared/channelMentions.cjs), and
  // is a no-op in 1:1 DMs. Matches on persisted participants (the roster the
  // server checks), not transient presence.
  const mentionedNotInChannel = useMemo(() => {
    if (isDirectMessage) return [] as string[];
    const names = new Map<string, string>();
    // `@channel` is excluded by agentMentionHandles: it addresses the roster
    // rather than adding to it, so there is never anyone to add for it.
    for (const handle of agentMentionHandles(input)) {
      const agent = agents.find(item => agentMatchesLookupKey(item, handle));
      if (!agent) continue;
      if (persistedParticipants.some(p => participantMatchesLookupKey(p, handle))) continue;
      names.set(agent.id, agent.name || agentHandle(agent));
    }
    return Array.from(names.values());
  }, [input, agents, persistedParticipants, isDirectMessage]);

  // Who `@channel` in the current draft will actually reach: the STORED agent
  // roster, capped the same way the server caps it. Shown because "pings
  // everyone" costs one model turn per agent, and the number is the only honest
  // way to say how much. Empty (and hidden) when the draft has no @channel, in a
  // DM, or when the channel has no agents in it.
  const channelMentionTargets = useMemo(() => {
    if (isDirectMessage || !mentionsChannel(input)) return [] as string[];
    return persistedParticipants
      .filter(participant => participant.kind === 'agent')
      .map(participant => {
        const agent = agents.find(item => agentMatchesLookupKey(item, participant.agent_id || participant.handle || participant.name));
        if (agent && agent.enabled === false) return '';
        return agent?.name || participant.name || '';
      })
      .filter(Boolean)
      .slice(0, CHANNEL_MENTION_MAX_AGENTS);
  }, [input, agents, persistedParticipants, isDirectMessage]);

  // `@channel` is offered in the composer's @ menu alongside the agent handles,
  // because a mention nobody can discover is a mention nobody uses. Not in a DM:
  // there is no roster there to address, and the one agent already answers a
  // plain message. Hidden once the typed query stops being a prefix of it.
  const showChannelMentionOption = !isDirectMessage
    && CHANNEL_MENTION_HANDLE.startsWith(docPickerQuery.trim().toLowerCase());
  // Enabled agents on the STORED roster — what `@channel` costs, in turns.
  const channelAgentCount = useMemo(() => persistedParticipants.filter(participant => {
    if (participant.kind !== 'agent') return false;
    const agent = agents.find(item => agentMatchesLookupKey(item, participant.agent_id || participant.handle || participant.name));
    return !agent || agent.enabled !== false;
  }).length, [agents, persistedParticipants]);

  const agentAvatarLookup = useMemo(
    () => buildAgentAvatarLookup(agents, persistedParticipants),
    [agents, persistedParticipants],
  );
  const agentAccentLookup = useMemo(
    () => buildAgentAccentLookup(agents, persistedParticipants),
    [agents, persistedParticipants],
  );
  // Who a huddle utterance can be addressed to, in roster order. Empty in a DM:
  // the single agent there already answers a plain message, so there is nothing
  // to switch between and nothing to @mention.
  // A DM's huddle has ONE agent, and it still needs to be in this list. This
  // returned [] for DMs — no strip is needed when there is no one to choose
  // between — but the list is also where the SPEAKER finds whose voice to use.
  // Empty meant activeAgent was null, voiceId fell back to '', and the server
  // derived a default voice: boris, who has a voice stored, came out sounding
  // like someone else entirely in every DM. The strip hides itself when there
  // is nothing to choose (below); the roster stays populated regardless.
  const { voices: cartesiaVoices } = useCartesiaVoices();
  const huddleVoiceIds = useMemo(
    () => englishVoiceIds(cartesiaVoices),
    [cartesiaVoices],
  );
  const huddleAgents = useMemo(
    () => huddleAgentOptions(agents, persistedParticipants, huddleVoiceIds),
    [agents, persistedParticipants, huddleVoiceIds],
  );
  // A huddle marker in the transcript ("You were in a huddle · 12:04 · Ada,
  // Sam") opens that huddle in the DOCK. There is no huddle side panel any
  // more: the channel had a strip, a side panel and a toolbar button all
  // showing the same call, which is how you end up with two surfaces
  // disagreeing about whether you are connected. One panel, one answer.
  const huddleDock = useHuddleDock();
  const openHuddleRecord = useCallback((huddleId?: string | null) => {
    if (!huddleId || !workspaceId || !huddleDock) return;
    huddleDock.openHuddleRecord({ workspaceId, huddleId, title: channelTitle || 'this conversation' });
  }, [huddleDock, workspaceId, channelTitle]);
  // Who replied and when, per parent message — derived from the messages already
  // in memory (threadReplyCounts stays the source of truth for the number itself).
  const threadReplySummaries = useMemo(
    () => buildThreadReplySummaries(messages, message => resolveMessageAvatar(message, agentAvatarLookup)),
    [messages, agentAvatarLookup],
  );

  const findChannelSession = async (): Promise<ChannelSessionMeta | null> => {
    if (channelMeta?.id) return channelMeta;
    if (inferredSessionId) {
      return {
        id: inferredSessionId,
        title: channelTitle || 'general',
        folder: null,
        is_favorite: false,
        archived_at: null,
        participants: [],
      };
    }
    if (!workspaceId || !channelTitle) return null;
    const { data } = await backendClient
      .from<ChannelSessionMeta[]>('chat_sessions')
      .select(CHANNEL_META_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('title', channelTitle)
      .order('updated_at', { ascending: false })
      .limit(1);
    const row = Array.isArray(data) ? data[0] : null;
    return row ? normalizeChannelSessionMeta(row) : null;
  };

  const persistChannelUpdates = async (updates: Partial<ChannelSessionMeta>) => {
    setChannelActionStatus('');
    const session = await findChannelSession();
    if (!session?.id) {
      setChannelActionStatus('Save unavailable until this channel exists.');
      return null;
    }
    const normalizedUpdates = normalizeChannelSessionUpdates(updates);
    const { data, error } = await backendClient
      .from<ChannelSessionMeta>('chat_sessions')
      .update({ ...normalizedUpdates, updated_at: new Date().toISOString() })
      .eq('id', session.id)
      .select(CHANNEL_META_COLUMNS)
      .single();
    if (error || !data) {
      setChannelActionStatus(error?.message || 'Could not save channel changes.');
      return null;
    }
    const next = normalizeChannelSessionMeta({ ...session, ...normalizedUpdates, ...data });
    setChannelMeta(next);
    // The sidebar reads the app's session list, not this window's channelMeta,
    // so it has to be told. Sent as the SAVED fields rather than the whole
    // row: the app's ChatSession and this window's ChannelSessionMeta are
    // different shapes, and pushing a foreign row into the list is how you get
    // a sidebar entry with half its fields missing.
    if (session.id) onSessionMetaSaved?.(session.id, normalizedUpdates as Record<string, unknown>);
    return next;
  };

  const handleOpenFlowConnect = async () => {
    setChannelActionStatus('');
    const session = await findChannelSession();
    if (!session?.id) {
      setChannelActionStatus('Connect unavailable until this channel exists.');
      return;
    }
    setFlowConnectChannelId(session.id);
    setFlowConnectOpen(true);
  };


/**
 * One id for one participant, whatever shape wrote it. Session rosters hold
 * both `agent:<uuid>` and bare `<uuid>` ids for agents (two historical
 * writers), while the dialog's options are keyed `agent:<uuid>` — compared
 * raw, an auto-added agent never matched its own dialog row, showed "Add"
 * while standing in the channel, and clicking Add duplicated it. The
 * duplicate then answered every turn twice, which a huddle read aloud twice.
 */
function dialogParticipantKey(participant: { id?: unknown; kind?: unknown; agent_id?: unknown; handle?: unknown }): string {
  if (participant?.kind === 'agent') {
    const bare = participantAgentKey(participant);
    if (bare) return `agent:${bare}`;
  }
  return String(participant?.id ?? '');
}

  const [editChannelOpen, setEditChannelOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);

  // The session the access dialog acts on. `channelMeta.id` FIRST, because
  // `inferredSessionId` is read off the messages and a direct message with no
  // messages yet has none — and a fresh DM is exactly the one somebody may need
  // to be let into. Falls back to the inferred id for the case where the meta
  // fetch has not landed.
  const accessSessionId = channelMeta?.id || inferredSessionId || null;

  // The dialog's seed. Built from the PERSISTED meta so a reopened dialog shows
  // what is stored, never what a previous cancelled edit left in state.
  const channelProfileBaseline = useMemo<ChannelProfileDraft>(() => ({
    title: channelMeta?.title || channelTitle || '',
    description: channelMeta?.description || '',
    icon: normalizeChannelIcon(channelMeta?.icon),
    intent: channelMeta?.intent || '',
    conversation_mode: normalizeConversationMode(channelMeta?.conversation_mode),
  }), [
    channelMeta?.title, channelMeta?.description, channelMeta?.icon, channelMeta?.intent,
    channelMeta?.conversation_mode, channelTitle,
  ]);

  // The channel's chosen glyph, or the hash. Capitalised because it is rendered
  // as a component.
  const ChannelIcon = useMemo(() => channelIconGlyph(channelMeta?.icon), [channelMeta?.icon]);

  const handleSaveChannelProfile = async (patch: Partial<ChannelProfileDraft>) => {
    const saved = await persistChannelUpdates(patch as Partial<ChannelSessionMeta>);
    return Boolean(saved);
  };

  const handleOpenParticipantsDialog = () => {
    const selected = new Set<string>();
    const saved = persistedParticipants.length > 0 ? persistedParticipants : participants;
    saved.forEach(participant => selected.add(dialogParticipantKey(participant)));
    setSelectedParticipantIds(selected);
    setAddParticipantsOpen(true);
  };

  const handleToggleParticipant = (participantId: string) => {
    setSelectedParticipantIds(prev => {
      const next = new Set(prev);
      if (next.has(participantId)) next.delete(participantId);
      else next.add(participantId);
      return next;
    });
  };

  // Remove one participant from the dropdown's X. Writes from the PERSISTED
  // roster (never the presence-merged display list), filtered by the canonical
  // key so an agent's historical shape-twin rows — `agent:<uuid>` and bare
  // `<uuid>` — leave together; removing one visual row must not leave a hidden
  // duplicate behind to keep answering turns. Reversible via the add dialog,
  // so no confirm. "You" gets no X: removing yourself is leaving, a different
  // action with different consequences, not roster tidying.
  const handleRemoveParticipant = async (participant: { id?: unknown; kind?: unknown; agent_id?: unknown; handle?: unknown }) => {
    const targetKey = dialogParticipantKey(participant);
    if (!targetKey) return;
    const source = persistedParticipants.length > 0 ? persistedParticipants : [];
    const next = source.filter(row => dialogParticipantKey(row) !== targetKey);
    if (next.length === source.length) return;
    await persistChannelUpdates({ participants: next });
  };

  const handleSaveParticipants = async () => {
    const selected = participantCandidates
      .filter(participant => selectedParticipantIds.has(dialogParticipantKey(participant)))
      .map(toPersistedParticipant);
    const saved = await persistChannelUpdates({ participants: selected });
    if (saved) setAddParticipantsOpen(false);
  };

  const setMessageOverride = (messageId: string, patch: Partial<ChatMessage> & { deleted?: boolean }) => {
    setMessageOverrides(prev => ({
      ...prev,
      [messageId]: { ...prev[messageId], ...patch },
    }));
  };

  // M9: an override is only a stand-in while the write is in flight. Left in place
  // it would mask every later realtime UPDATE for that row (someone else reacting,
  // unpinning, editing) for the lifetime of the window, so drop the keys we wrote
  // optimistically as soon as the server acknowledges and let realtime own the row
  // again. Only the keys this action touched are cleared, so a concurrent
  // in-flight action on the same message keeps its own override.
  const clearMessageOverride = (messageId: string, keys: Array<keyof (Partial<ChatMessage> & { deleted?: boolean })>) => {
    setMessageOverrides(prev => {
      const current = prev[messageId];
      if (!current) return prev;
      const remaining = { ...current };
      for (const key of keys) delete remaining[key];
      const next = { ...prev };
      if (Object.keys(remaining).length === 0) delete next[messageId];
      else next[messageId] = remaining;
      return next;
    });
  };

  const handleTogglePin = async (message: ChatMessage) => {
    const nextPinned = !message.pinned;
    setMessageOverride(message.id, { pinned: nextPinned });
    setMessageActionBusy(message.id);
    const { error } = await backendClient
      .from('messages')
      .update({ pinned: nextPinned })
      .eq('id', message.id)
      .eq('session_id', message.session_id);
    if (error) setMessageOverride(message.id, { pinned: message.pinned });
    else clearMessageOverride(message.id, ['pinned']);
    setMessageActionBusy(null);
  };

  // Reacting is ONE request naming ONE reaction and ONE operation. It is not a
  // whole-map PUT any more, and that is the fix for a live bug rather than a
  // tidy-up: the old version read the map out of React state, spliced this
  // user's id in or out and wrote the whole thing back, so two people reacting
  // inside the realtime propagation window each built a map from a stale base
  // and the second write silently erased the first. The same shape let any
  // client write any user's id into the map.
  //
  // The server now owns the mutation (one atomic statement, reactor bound from
  // the session), so the arithmetic below is only a PREDICTION for the moment
  // before the response lands. A wrong prediction is safe: the statement is a
  // no-op when the world already matches, and the acknowledgement lets realtime
  // put the row back to whatever actually holds.
  const handleToggleReaction = async (message: ChatMessage, reaction: string, op: 'add' | 'remove') => {
    const uid = currentUserId;
    if (uid) {
      const prev: Record<string, string[]> = message.reactions ?? {};
      const users = prev[reaction] ?? [];
      const next: Record<string, string[]> = {
        ...prev,
        [reaction]: op === 'add' ? [...new Set([...users, uid])] : users.filter(u => u !== uid),
      };
      if (next[reaction].length === 0) delete next[reaction];
      setMessageOverride(message.id, { reactions: next });
    }
    // Remember the pick for the picker's "Frequently used" row. Local only —
    // nobody else's ranking is affected by what you reach for.
    if (op === 'add') setReactionUses(prev => noteReactionUse(prev, reaction, Date.now()));
    try {
      const res = await fetch(apiUrl(`/backend/messages/${encodeURIComponent(message.id)}/reactions`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ reaction, op }),
      });
      if (!res.ok) throw new Error('reaction failed');
      // Drop the optimistic key rather than pinning the server's map in place:
      // an override left behind masks every later realtime UPDATE for this row,
      // including somebody else reacting to it. See clearMessageOverride.
      clearMessageOverride(message.id, ['reactions']);
    } catch {
      setMessageOverride(message.id, { reactions: message.reactions });
    }
  };

  const handleStartEdit = (message: ChatMessage) => {
    setEditingMessageId(message.id);
    setEditingContent(safeMessageText(message.content));
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditingContent('');
  };

  const handleSaveEdit = async () => {
    const messageId = editingMessageId;
    const nextContent = editingContent.trim();
    if (!messageId || !nextContent) return;
    const previous = visibleMessages.find(message => message.id === messageId);
    setMessageOverride(messageId, { content: nextContent });
    setMessageActionBusy(messageId);
    const updateQuery = backendClient
      .from('messages')
      .update({ content: nextContent })
      .eq('id', messageId);
    if (previous?.session_id) updateQuery.eq('session_id', previous.session_id);
    const { error } = await updateQuery;
    if (error && previous) setMessageOverride(messageId, { content: previous.content });
    else if (!error) clearMessageOverride(messageId, ['content']);
    setMessageActionBusy(null);
    setEditingMessageId(null);
    setEditingContent('');
  };

  const handleDeleteMessage = (message: ChatMessage) => {
    setDeleteMessageTarget(message);
  };

  const handleConfirmDeleteMessage = async () => {
    const message = deleteMessageTarget;
    if (!message) return;
    setDeleteMessageTarget(null);
    setMessageOverride(message.id, { deleted: true });
    setMessageActionBusy(message.id);
    const { error } = await backendClient
      .from('messages')
      .delete()
      .eq('id', message.id)
      .eq('session_id', message.session_id);
    // M9 does not apply to the delete override: the row is gone, so no later
    // realtime UPDATE can be masked by it. Clearing it here would only resurrect
    // the message until the realtime DELETE lands (forever, if realtime is down).
    if (error) setMessageOverride(message.id, { deleted: false });
    setMessageActionBusy(null);
  };
  const catchUpSummary = useMemo(() => buildCatchUpSummary(displayMessages, channelTitle), [displayMessages, channelTitle]);
  useEffect(() => {
    if (sidePanel !== 'files' || !workspaceId) return;
    let cancelled = false;
    setProjectFilesLoading(true);
    const participantQuery = persistedParticipants
      .filter(participant => participant.kind === 'agent')
      .map(participant => participant.agent_id || participant.handle || participant.name)
      .filter(Boolean)
      .map(value => `agent=${encodeURIComponent(String(value))}`)
      .join('&');
    const query = participantQuery ? `?${participantQuery}` : '';
    fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/project-files${query}`), {
      headers: apiAuthHeaders(),
    })
      .then(response => response.json())
      .then(payload => {
        if (cancelled) return;
        setProjectFiles(Array.isArray(payload?.data?.files) ? payload.data.files : []);
        setProjectFileSources(Array.isArray(payload?.data?.sources) ? payload.data.sources : []);
        setProjectRoot(typeof payload?.data?.root === 'string' ? payload.data.root : '');
      })
      .catch(() => {
        if (!cancelled) {
          setProjectFiles([]);
          setProjectFileSources([]);
          setProjectRoot('');
        }
      })
      .finally(() => {
        if (!cancelled) setProjectFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [persistedParticipants, sidePanel, workspaceId]);
  const handleScrollerScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromEnd = target.scrollHeight - target.scrollTop - target.clientHeight;
    setAutoScroll(distanceFromEnd < 32);
  };
  const handleJumpToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`chat-msg-${messageId}`);
    if (!el) return;
    setAutoScroll(false);
    // Scroll only — deliberately no highlight flash. The 1.6s animated
    // background this used to add read as a flicker, and it fought with the
    // row's own hover/agent-accent backgrounds while it ran. The thread toolbar
    // appearing is sufficient confirmation of where you landed.
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);
  const openThread = () => {
    setSidePanel('thread');
  };
  const openSubThreadPanel = (session: ChatSession) => {
    onOpenSubThread?.(session);
    setSidePanel('sub-thread');
  };
  const openAgentProfilePanel = (agentIdOrHandle?: string | null) => {
    const key = agentIdOrHandle || directProfileKey || profileAgent?.id || '';
    if (!key) return;
    setProfileAgentKey(key);
    setSidePanel('profile');
  };
  // Too narrow to split: the panel takes the whole shell and the transcript
  // steps aside, the way it already behaves on a phone. Derived from what the
  // MESSAGES would be left with rather than a fixed breakpoint, so it also
  // catches a panel dragged too wide inside a roomy window.
  const overlaySidePanel = shouldOverlaySidePanel({
    shellWidth,
    sidePanel,
    panelWidth,
    threadPanelWidth,
  });

  const closeSidePanel = () => {
    if (sidePanel === 'thread') onCloseThread?.();
    if (sidePanel === 'sub-thread') onCloseSubThread?.();
    setSidePanel(null);
  };
  const beginPanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const isThread = sidePanel === 'thread';
    const startX = event.clientX;
    // Read the actual on-screen width rather than trusting state — the thread
    // panel starts life as a CSS percentage (`45%`), not a px value, so
    // `threadPanelWidth` alone doesn't know the real width to drag from until
    // the user has resized it at least once.
    const startWidth = sidePanelRef.current?.getBoundingClientRect().width
      ?? (isThread ? threadPanelWidth ?? 360 : panelWidth);
    const maxWidth = isThread ? 900 : 680;
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.min(maxWidth, Math.max(280, startWidth + (startX - moveEvent.clientX)));
      if (isThread) setThreadPanelWidth(next);
      else setPanelWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  return (
    <div ref={shellRef} className="channel-shell flex h-full min-w-0 overflow-hidden text-card-foreground">
      {/* Wraps the message column AND the side panel, because the huddle panel
          is one of the side panels and drives off the same hook the toolbar
          button and the card do. It stays scoped to this channel rather than
          the app: the hook is realtime-driven and only re-renders on a real
          huddle event (start / join / leave / end), never per message — the
          transcript itself lives in the panel's own hook. */}
      <HuddleSessionProvider
        workspaceId={showHuddle ? workspaceId : null}
        sessionId={showHuddle ? inferredSessionId : null}
      >
      {/* `hidden`, not unmounted: the transcript keeps its scroll position, its
          loaded pages and any in-flight composer text, so closing the panel
          returns to exactly the conversation that was left, not the top of it. */}
      <div className={cn('flex min-w-0 flex-1 flex-col overflow-hidden', overlaySidePanel && 'hidden')}>
        <div className="channel-header relative z-20 shrink-0 border-b border-border">
          <div className="flex h-11 min-w-0 items-center gap-1.5 overflow-hidden px-3">
            {isDirectMessage ? (
              <Button
                type="button"
                variant={sidePanel === 'profile' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 px-2"
                onClick={() => sidePanel === 'profile' ? closeSidePanel() : openAgentProfilePanel()}
              >
                <Bot data-icon="inline-start" />
                <span className="max-w-48 truncate font-semibold">{directAgent?.name || channelTitle || 'Direct message'}</span>
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2" aria-label="Open channel menu">
                    <ChannelIcon data-icon="inline-start" />
                    <span className="max-w-48 truncate font-semibold">{channelTitle || 'general'}</span>
                    <ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  <DropdownMenuItem
                    onSelect={() => {
                      handleOpenParticipantsDialog();
                    }}
                  >
                    <UserPlus data-icon="inline-start" />
                    Add people or agents
                  </DropdownMenuItem>
                  {channelActionStatus && (
                    <div className="px-2 py-1 text-xs text-muted-foreground">{channelActionStatus}</div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button type="button" variant={sidePanel === null || sidePanel === 'thread' ? 'secondary' : 'ghost'} size="sm" className="h-8 px-2" onClick={() => setSidePanel(null)}>
              <MessageSquare data-icon="inline-start" />
              Messages
            </Button>
            <Button type="button" variant={sidePanel === 'files' ? 'secondary' : 'ghost'} size="sm" className="h-8 px-2" onClick={() => setSidePanel('files')}>
              <Paperclip data-icon="inline-start" />
              Files
            </Button>
            <Button
              type="button"
              variant={sidePanel === 'sub-threads' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 px-2"
              onClick={() => setSidePanel(sidePanel === 'sub-threads' ? null : 'sub-threads')}
            >
              <GitBranch data-icon="inline-start" />
              Threads
              {subThreadCount > 0 && (
                <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                  {subThreadCount}
                </span>
              )}
            </Button>
            {showHuddle && (
              <HuddleToolbarButton
                workspaceId={workspaceId}
                sessionId={inferredSessionId}
                title={channelTitle}
                agents={huddleAgents}
              />
            )}
            <div className="min-w-2 flex-1" />
            {!isDirectMessage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="participant-count-chip h-8 gap-1 px-2"
                    title={`${participants.length} participant${participants.length === 1 ? '' : 's'}`}
                  >
                    <Users data-icon="inline-start" />
                    {participants.length}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  {participants.map(participant => (
                    <DropdownMenuItem key={participant.id} className="gap-2">
                      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold">
                        {participant.kind === 'agent' ? <Bot className="size-3.5" /> : participant.name.slice(0, 2).toUpperCase()}
                        {participant.connected && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-card bg-emerald-500" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{participant.name}</span>
                        {participant.status && (
                          <span className="block truncate text-xs text-muted-foreground">{participant.status}</span>
                        )}
                      </span>
                      {participant.user_id !== currentUserId && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 opacity-60 hover:opacity-100"
                          aria-label={`Remove ${participant.name} from this channel`}
                          onClick={event => {
                            // Keep the menu open: removing three agents should
                            // be three clicks, not three menu reopenings.
                            event.preventDefault();
                            event.stopPropagation();
                            void handleRemoveParticipant(participant);
                          }}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {/* Thread widgets show themselves once they have content, so most of
                the time this is the "put it back" / "get it out of my way"
                control — which is why it sits next to the "..." menu rather than
                inside it. It is rendered for EVERY session the rail applies to,
                including one with no widgets yet: this button is the only thing
                on screen that says the feature exists, and pressing it opens the
                rail on its empty states. See rule 3 in lib/threadWidgetRail.ts. */}
            {rail.toggleVisible && (
              <Button
                type="button"
                variant={railOpen ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 px-2"
                disabled={!rail.toggleEnabled}
                aria-pressed={railOpen}
                title={!rail.toggleEnabled
                  ? 'Widen the window to show thread widgets'
                  : railOpen ? 'Hide thread widgets' : 'Show thread widgets'}
                aria-label={railOpen ? 'Hide thread widgets' : 'Show thread widgets'}
                onClick={toggleWidgetRail}
              >
                {railOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            )}
            {/* Overflow. Everything that isn't Messages / Files / Threads lives
                here — this row previously carried nine labelled ghost buttons
                inside a fixed h-11 strip with overflow-hidden, so on a narrow
                window the right-hand controls were simply clipped. This is the
                CHANNEL menu; FloatingWindowShell's own "..." owns WINDOW actions
                (share, maximize, close) and is not rendered at all for grouped
                panes, so channel actions cannot live there. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="h-8 px-2" aria-label="More channel actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {!isDirectMessage && (
                  <DropdownMenuItem onSelect={() => setEditChannelOpen(true)}>
                    <Settings2 data-icon="inline-start" />
                    Edit channel
                  </DropdownMenuItem>
                )}
                {/* DM ONLY, and shown to everyone in the DM rather than to
                    admins alone: the item is the only place the app says who
                    can read a private conversation, and hiding it from
                    non-admins would leave them unable to find out. The routes
                    behind it are manage-gated and the dialog says so plainly
                    when they refuse. */}
                {isDirectMessage && (
                  <DropdownMenuItem onSelect={() => setAccessOpen(true)}>
                    <ShieldCheck data-icon="inline-start" />
                    Who can read this
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setSidePanel('pins')}>
                  <Pin data-icon="inline-start" />
                  Pins
                </DropdownMenuItem>
                {!isDirectMessage && (
                  <DropdownMenuItem onSelect={() => setCatchUpOpen(true)}>
                    <RotateCcw data-icon="inline-start" />
                    Catch up
                  </DropdownMenuItem>
                )}
                {!isDirectMessage && (
                  <DropdownMenuItem onSelect={() => { void handleOpenFlowConnect(); }}>
                    <Link2 data-icon="inline-start" />
                    Connect
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {onSplitThread && (
                  <DropdownMenuItem onSelect={() => onSplitThread()}>
                    <Columns2 data-icon="inline-start" />
                    Split thread
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={clearView}>
                  <Eraser data-icon="inline-start" />
                  Clear this view
                </DropdownMenuItem>
                {!isDirectMessage && contextControls && (
                  <>
                    <DropdownMenuSeparator />
                    {contextControls}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <MessageScrollerProvider autoScroll={autoScroll}>
          <MessageScroller className="channel-message-surface flex-1">
            {/* The rail's width comes out of the SURFACE, never out of the
                message column: reserving it here shifts the centred column
                left and leaves its rendered width identical to the closed
                state (the reserve is only ever non-zero when the surface has
                the room). Padding the scroll viewport rather than the rows is
                the whole fix — `pr-[300px]` on each row used to take 220px
                straight off the 800px column, which is why code blocks grew a
                horizontal scrollbar and prose wrapped mid-window.

                `px-2` is what keeps the transcript and the composer on the
                same measure once the 800px cap stops binding — i.e. exactly
                when a side panel is open. The composer sits inside the shell's
                own `p-2`, so without a matching inset here the transcript ran
                flush to the surface edge while the composer sat one step in on
                each side: same centre line, 15px narrower, visibly two columns
                instead of one. It has to be the same `0.5rem` the shell uses,
                not a hardcoded 8 — this app's root font-size is 15px, so `p-2`
                computes to 7.5px and a literal would be half a pixel out. */}
            <MessageScrollerViewport
              onScroll={handleScrollerScroll}
              className="px-2 transition-[padding] ease-out motion-reduce:transition-none"
              style={{
                paddingRight: railReserve ? `calc(0.5rem + ${railReserve}px)` : undefined,
                transitionDuration: `${RAIL_ANIMATION_MS}ms`,
              }}
            >
              <MessageScrollerContent className={cn('min-h-full gap-0 py-2', CHAT_COLUMN_CLASS)}>
                {clearedAt && hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={restoreView}
                    className="mx-auto my-2 rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                  >
                    Show {hiddenCount} earlier message{hiddenCount === 1 ? '' : 's'}
                  </button>
                )}
                {shownMessages.length === 0 && !clearedAt ? (
                  <Empty className="min-h-full border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Sparkles />
                      </EmptyMedia>
                      <EmptyTitle>{isDirectMessage ? 'Direct message is open' : 'Channel is open'}</EmptyTitle>
                      <EmptyDescription>
                        {isDirectMessage ? 'Send a message below to talk to this agent.' : 'Post a message below to start this channel.'}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="flex min-w-0 flex-col">
                    {hasMoreMessages && !clearedAt && onLoadEarlier && (
                      <div className="flex justify-center py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground"
                          disabled={loadingEarlier}
                          onClick={onLoadEarlier}
                        >
                          {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
                        </Button>
                      </div>
                    )}
                    {shownRows.map(row => {
                      const isLastRow = row.index === shownMessages.length - 1;
                      if (row.kind === 'steps') {
                        return (
                          <MessageScrollerItem key={row.key} scrollAnchor={isLastRow}>
                            <ToolStepGroup row={row} />
                          </MessageScrollerItem>
                        );
                      }
                      const msg = row.message;
                      // An agent is BLOCKED on this one: its turn is parked
                      // waiting for a click, and with no click the tool call is
                      // refused. It gets a card with buttons, not a bubble.
                      if (isPermissionRequestMessage(msg)) {
                        // Live row when we still hold it; otherwise the settled
                        // one read back off the message. Either way this never
                        // falls through to a bubble for a decided approval — the
                        // server's sentence was rendering as full-width prose
                        // that read like something a person had said.
                        const request = resolvePermissionRequest(msg, permissionRequestsById);
                        if (request) {
                          return (
                            <MessageScrollerItem key={msg.id} id={`chat-msg-${msg.id}`} scrollAnchor={isLastRow}>
                              <PermissionRequestCard
                                request={request}
                                busy={permissionBusyId === request.id}
                                onDecide={async (behavior, scope) => {
                                  const { error } = await decidePermission(request.id, behavior, scope);
                                  if (error) throw new Error(error);
                                }}
                              />
                            </MessageScrollerItem>
                          );
                        }
                        // No row yet (still loading, or already pruned): the
                        // message's own content is a complete sentence, so fall
                        // through and render it as an ordinary line.
                      }
                      // "You were in a huddle" — a fact about the channel, not
                      // something anyone said in it. One quiet line where the
                      // whole voice conversation used to be dumped.
                      //
                      // A RUN of them collapses further: ten stacked lines was
                      // ten rows of chrome for one fact, so consecutive markers
                      // render as one dated row of numbered chips. A lone
                      // marker keeps its sentence.
                      if (isHuddleMarkerMessage(msg)) {
                        const group = huddleGroupByLeadId.get(msg.id);
                        if (group) {
                          return (
                            <MessageScrollerItem key={group.key} id={`chat-msg-${msg.id}`} scrollAnchor={isLastRow}>
                              <HuddleMarkerGroupRow group={group} onOpen={openHuddleRecord} />
                            </MessageScrollerItem>
                          );
                        }
                        // A marker swallowed by the group above it renders nothing.
                        if (huddleGroupedIds.has(msg.id)) return null;
                        return (
                          <MessageScrollerItem key={msg.id} id={`chat-msg-${msg.id}`} scrollAnchor={isLastRow}>
                            <HuddleMarkerRow message={msg} onOpen={openHuddleRecord} />
                          </MessageScrollerItem>
                        );
                      }
                      return (
                      <MessageScrollerItem key={msg.id} id={`chat-msg-${msg.id}`} scrollAnchor={isLastRow}>
                        <ChatMessageBubble
                          msg={msg}
                          avatar={resolveMessageAvatar(msg, agentAvatarLookup)}
                          accent={resolveMessageAccent(msg, agentAccentLookup)}
                          isStreaming={streaming && isLastRow && msg.role === 'assistant'}
                          replyCount={threadReplyCounts[msg.id]}
                          replySummary={threadReplySummaries[msg.id]}
                          isEditing={editingMessageId === msg.id}
                          editingContent={editingContent}
                          actionBusy={messageActionBusy === msg.id}
                          onTogglePin={() => void handleTogglePin(msg)}
                          onStartEdit={() => handleStartEdit(msg)}
                          onCancelEdit={handleCancelEdit}
                          onChangeEdit={setEditingContent}
                          onSaveEdit={() => void handleSaveEdit()}
                          onDelete={() => handleDeleteMessage(msg)}
                          onOpenThread={onOpenThread ? () => {
                            onOpenThread(msg.id);
                            openThread();
                          } : undefined}
                          // A broadcast reply's thread is rooted at its PARENT, not
                          // at itself — opening msg.id would open an empty thread on
                          // the answer instead of the conversation that produced it.
                          onOpenSourceThread={onOpenThread && msg.thread_parent_id ? () => {
                            onOpenThread(msg.thread_parent_id as string);
                            openThread();
                          } : undefined}
                          onAgentProfile={openAgentProfilePanel}
                          subThreads={subThreadsByMessage[msg.id]}
                          onOpenSubThread={openSubThreadPanel}
                          onCreateSubThread={onCreateSubThread ? () => setSubThreadPickerMessageId(msg.id) : undefined}
                          widgetsOverlaying={railOverlaying}
                          currentUserId={currentUserId}
                          onToggleReaction={(reaction, op) => void handleToggleReaction(msg, reaction, op)}
                          resolveUserName={resolveUserName}
                          reactionUses={reactionUses}
                          // The receipt is drawn only on your OWN messages, and
                          // only on the last of a run: it answers "did what I
                          // just said land", so an eye on somebody else's
                          // message is noise on every row.
                          readerIds={receiptAnchors.has(msg.id) ? receipts.readersOfMessage(msg) : undefined}
                          isDirectMessage={isDirectMessage}
                        />
                      </MessageScrollerItem>
                      );
                    })}
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            {showWidgetRail && (
              <ThreadWidgetRail
                workspaceId={workspaceId}
                sessionId={inferredSessionId}
                open={rail.open}
                layout={rail.layout}
                onSurfaceWidthChange={setRailSurfaceWidth}
                onContentChange={setRailHasContent}
                onJumpToMessage={handleJumpToMessage}
                onBlockerAnswered={(item, response) => {
                  // Post the answered blocker back into the chat so it's tracked
                  // in the thread and wakes the agent that raised it.
                  onSendMessage(`**Answered blocker:** ${item.content}\n\n${response}`, 'auto');
                }}
              />
            )}
            <MessageScrollerButton direction="end" behavior="auto" onClick={() => setAutoScroll(true)} />
          </MessageScroller>
        </MessageScrollerProvider>

        {readOnly ? (
          <div className="border-t border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            Read-only workspace instance
          </div>
        ) : (
          <>
            {thinkingAgents.length > 0 && (
              <div className="composer-status flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="composer-status-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
                <span className="truncate">
                  {thinkingAgents.map(({ name, activity }, i) => (
                    <React.Fragment key={name}>
                      {i > 0 && (i === thinkingAgents.length - 1 ? ' and ' : ', ')}
                      <span className="font-medium text-foreground">{name}</span>
                      {' '}is {activity}
                    </React.Fragment>
                  ))}
                  {'…'}
                </span>
              </div>
            )}
            {/* Match the message column's shift so the composer stays under the
                conversation rather than under the rail. The reserve is added on
                top of COMPOSER_SHELL_CLASS's own `p-2` — that's what keeps the
                two 800px columns on the same centre line. Same `0.5rem` the
                scroll viewport above uses, for the same reason. */}
            <div
              className={cn(COMPOSER_SHELL_CLASS, 'transition-[padding] ease-out motion-reduce:transition-none')}
              style={{ paddingRight: railReserve ? `calc(0.5rem + ${railReserve}px)` : undefined, transitionDuration: `${RAIL_ANIMATION_MS}ms` }}
            >
              {(linkedDocs.length > 0 || linkedGroups.length > 0 || linkedFiles.length > 0) && (
                <div className={cn('mb-2 flex flex-wrap gap-1.5', CHAT_COLUMN_CLASS)}>
                  {linkedFiles.map(file => (
                    <FileChip
                      key={file.id}
                      name={file.name}
                      onRemove={() => setLinkedFiles(prev => prev.filter(item => item.id !== file.id))}
                    />
                  ))}
                  {linkedDocs.map(doc => (
                    <FileChip
                      key={doc.id}
                      name={doc.title}
                      label={doc.title}
                      onRemove={() => setLinkedDocs(prev => prev.filter(d => d.id !== doc.id))}
                    />
                  ))}
                  {linkedGroups.map(group => (
                    <FileChip
                      key={group.id}
                      name={`${group.name}.canvas`}
                      label={group.name}
                      onRemove={() => setLinkedGroups(prev => prev.filter(g => g.id !== group.id))}
                    />
                  ))}
                </div>
              )}

              <div className={cn('relative', CHAT_COLUMN_CLASS)} onDrop={handleComposerDrop} onDragOver={handleComposerDragOver}>
                {/* Both pickers open UPWARD from the composer, so their height is
                    free space they are not using: nothing sits above them to
                    displace. Capped at 520px / 72vh — tall enough to show
                    several two-line rows at once instead of one row and a
                    scrollbar, and still short of covering the conversation.
                    The vh half of the min() matters because this composer lives
                    in a resizable WINDOW: a short window gets a proportional
                    picker rather than one taller than the window itself. */}
                {showSlashPicker && (
                  <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-[min(520px,72vh)] overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                    <CommandList className="max-h-[min(440px,64vh)]">
                      <CommandEmpty>No commands or skills match.</CommandEmpty>
                      {slashGroups.map(group => {
                        if (group.type === 'builtin') {
                          return (
                            <CommandGroup key="builtin" heading="Built-in">
                              {group.items.map(item => (
                                <SlashRow key={item.id} item={item} badge="runs" onSelect={() => handleSlashSelect(item)}>
                                  <Terminal className="size-4" />
                                </SlashRow>
                              ))}
                            </CommandGroup>
                          );
                        }
                        if (group.type === 'command') {
                          return (
                            <CommandGroup key="command" heading="Commands">
                              {group.items.map(item => (
                                <SlashRow key={item.id} item={item} badge="insert" onSelect={() => handleSlashSelect(item)}>
                                  <CommandIcon className="size-4" />
                                </SlashRow>
                              ))}
                            </CommandGroup>
                          );
                        }
                        return (
                          <CommandGroup key={`skill:${group.label}`} heading={group.label}>
                            {group.parent && (
                              <SlashRow item={group.parent} badge="insert" onSelect={() => handleSlashSelect(group.parent!)}>
                                <Sparkles className="size-4" />
                              </SlashRow>
                            )}
                            {group.children.map(child => (
                              <SlashRow key={child.id} item={child} badge="insert" indented onSelect={() => handleSlashSelect(child)}>
                                <CornerDownRight className="size-4" />
                              </SlashRow>
                            ))}
                          </CommandGroup>
                        );
                      })}
                    </CommandList>
                  </Command>
                )}

                {showDocPicker && (
                  <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-[min(500px,70vh)] overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                    <CommandList className="max-h-[min(420px,62vh)]">
                      <CommandEmpty>No agents or documents found.</CommandEmpty>
                      {filteredAgents.length > 0 && (
                        <CommandGroup heading="Agents">
                          {filteredAgents.map(agent => (
                            <CommandItem
                              key={agent.id}
                              value={`${agent.name} ${agentHandle(agent)}`}
                              // py-2.5, not py-1.5: this row is a name AND a
                              // description on two lines, and one-line padding
                              // made the pair read as one cramped block.
                              className="rounded-lg px-2 py-2.5"
                              onSelect={() => handleAgentSelect(agent)}
                            >
                              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                                <Bot className="size-4" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{agent.name}</span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {agent.description || agent.model || 'Agent'}
                                </span>
                              </span>
                              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">@{agentHandle(agent)}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                      {/* BELOW the agents on purpose. Tab/Enter completes the top
                          item, and asking every agent at once is a paid mistake to
                          make by reflex — so @channel is one deliberate step away,
                          never the accidental default. It still completes on
                          Tab/Enter once the typed text rules the agents out (see
                          handleKeyDown), so the keyboard and the list agree. */}
                      {showChannelMentionOption && (
                        <CommandGroup heading="Everyone">
                          <CommandItem
                            value={`${CHANNEL_MENTION_HANDLE} everyone all agents`}
                            className="rounded-lg px-2 py-1.5"
                            onSelect={() => insertMentionHandle(CHANNEL_MENTION_HANDLE)}
                          >
                            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                              <Users className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">Everyone in this channel</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {channelAgentCount === 0
                                  ? 'No agents in this channel yet'
                                  : `Asks all ${channelAgentCount} agent${channelAgentCount === 1 ? '' : 's'} here, one after another`}
                              </span>
                            </span>
                            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">@{CHANNEL_MENTION_HANDLE}</span>
                          </CommandItem>
                        </CommandGroup>
                      )}
                      <CommandGroup heading="Documents">
                        {filteredDocs.map(doc => (
                          <CommandItem
                            key={doc.id}
                            value={doc.title}
                            className="rounded-lg px-2 py-1.5"
                            onSelect={() => handleDocSelect(doc)}
                          >
                            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                              <FileText className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{doc.title}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {doc.folder || (doc.is_favorite ? 'Favorite document' : 'Document context')}
                              </span>
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                )}

                {showGroupPicker && (
                  <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-[min(280px,45vh)] rounded-2xl border border-border bg-popover p-2 pt-3 shadow-xl">
                    <CommandList className="max-h-[min(240px,40vh)]">
                      <CommandEmpty>No groups found.</CommandEmpty>
                      <CommandGroup heading="Canvas groups">
                        {filteredGroups.map(group => {
                          const objectCount = canvasObjects.filter(object => object.group_id === group.id).length;
                          return (
                            <CommandItem
                              key={group.id}
                              value={group.name}
                              className="min-h-14 rounded-xl px-3 py-2"
                              onSelect={() => handleGroupSelect(group)}
                            >
                              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                                <Layers className="size-4" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{group.name}</span>
                                <span className="block truncate text-xs text-muted-foreground">Canvas group context</span>
                              </span>
                              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                {objectCount} item{objectCount === 1 ? '' : 's'}
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                )}

                {mentionedNotInChannel.length > 0 && (
                  <div className="px-1 pb-1 text-xs text-muted-foreground">
                    {mentionedNotInChannel.length === 1
                      ? `${mentionedNotInChannel[0]} isn't in this channel yet — they'll be added when you send.`
                      : `${mentionedNotInChannel.join(', ')} aren't in this channel yet — they'll be added when you send.`}
                  </div>
                )}
                {/* Who @channel will reach, by name. One agent is one paid turn, so
                    the count is the cost — worth showing before Send, not after. */}
                {channelMentionTargets.length > 0 && (
                  <div className="px-1 pb-1 text-xs text-muted-foreground">
                    {`@channel asks ${channelMentionTargets.join(', ')} — ${channelMentionTargets.length} repl${channelMentionTargets.length === 1 ? 'y' : 'ies'}, one after another.`}
                  </div>
                )}
                {!isDirectMessage && channelMentionTargets.length === 0 && mentionsChannel(input) && (
                  <div className="px-1 pb-1 text-xs text-muted-foreground">
                    No agents are in this channel yet, so @channel reaches nobody. Add some from the members list.
                  </div>
                )}
                <InputGroup className="h-auto flex-col items-stretch">
                  <InputGroupTextarea
                    ref={inputRef}
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onBlur={handleComposerBlur}
                    onPaste={handleComposerPaste}
                    placeholder={isDirectMessage
                      ? directMessageComposerPlaceholder(directAgent?.name || channelTitle)
                      : channelComposerPlaceholder(channelTitle)}
                    disabled={streaming}
                    rows={1}
                    className={COMPOSER_TEXTAREA_CLASS}
                    onInput={e => autosizeComposer(e.currentTarget)}
                  />
                  <InputGroupAddon align="block-end" className={COMPOSER_ADDON_CLASS}>
                    <div className="flex items-center gap-1">
                      <Popover open={addContextOpen} onOpenChange={(open) => {
                        setAddContextOpen(open);
                        if (open) {
                          setShowDocPicker(false);
                          setShowGroupPicker(false);
                          closeSlashPicker();
                        }
                      }}>
                        <PopoverTrigger asChild>
                          <InputGroupButton size="icon-xs" aria-label="Add context">
                            <Plus />
                          </InputGroupButton>
                        </PopoverTrigger>
                        <PopoverContent
                          side="top"
                          align="start"
                          sideOffset={8}
                          className="z-[var(--z-nested-modal)] w-[min(460px,calc(100vw-32px))] max-h-[min(560px,calc(100vh-96px))] gap-0 overflow-hidden p-0"
                        >
                          <ComposerAddContent
                            documents={documents}
                            agents={agents}
                            uploadedFiles={uploadedFiles}
                            projectFiles={composerProjectFiles}
                            canvasGroups={canvasGroups}
                            skillOptions={skillOptions}
                            toolOptions={toolOptions}
                            uploadEnabled={Boolean(onUploadFiles)}
                            uploadStatus={uploadStatus}
                            onUploadFiles={() => fileInputRef.current?.click()}
                            onUploadFolder={() => folderInputRef.current?.click()}
                            onOpenFiles={() => {
                              setSidePanel('files');
                              setAddContextOpen(false);
                            }}
                            onAddUploadedFile={(file) => addLinkedFile(linkedUploadedFile(file))}
                            onAddProjectFile={(file, source) => addLinkedFile(linkedProjectFile(file, source))}
                            onAddDocument={addLinkedDoc}
                            onAddGroup={addLinkedGroup}
                            onAddAgent={(agent) => insertComposerText(`@${agentHandle(agent)} `)}
                            onAddSkill={(skill) => insertComposerText(`Use skill: ${skill.label}. `)}
                            onAddTool={(tool) => insertComposerText(`Use tool: ${tool.label}. `)}
                          />
                        </PopoverContent>
                      </Popover>
                      <InputGroupButton size="icon-xs" aria-label="Voice input">
                        <Mic />
                      </InputGroupButton>
                    </div>

                    <div className="flex min-w-0 items-center gap-1">
                      <ModelSelector value={selectedModel} onChange={setSelectedModel} models={modelOptions} />
                      <Button
                        type="button"
                        size="icon-sm"
                        onClick={handleSend}
                        disabled={!input.trim() || streaming}
                        aria-label="Send message"
                      >
                        {streaming ? <Spinner /> : <Send />}
                      </Button>
                    </div>
                  </InputGroupAddon>
                </InputGroup>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleUploadSelection}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleUploadSelection}
                  {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {!readOnly && sidePanel && (
        <aside
          ref={sidePanelRef}
          className={cn(
            'channel-side-panel relative flex h-full flex-col text-card-foreground',
            overlaySidePanel
              // Takes the window. No left border — there is nothing beside it to
              // divide from — and it slides in from the right so it reads as
              // arriving over the conversation rather than replacing it.
              ? 'w-full flex-1 animate-in slide-in-from-right-4 duration-200'
              : 'shrink-0 border-l border-border',
          )}
          style={overlaySidePanel
            ? undefined
            : { width: sidePanel === 'thread' ? (threadPanelWidth ?? '45%') : panelWidth }}
        >
          {/* No drag handle when the panel owns the whole shell: there is no
              split left to drag, and the handle sat on the window's own edge. */}
          {!overlaySidePanel && (
            <div
              className="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize"
              onPointerDown={beginPanelResize}
              aria-hidden
            />
          )}
          {sidePanel === 'profile' ? (
            <AgentProfileSidePanel
              agent={profileAgent}
              currentUserId={currentUserId}
              participant={profileParticipant}
              connections={agentConnections}
              lookupKey={profileAgentKey || directProfileKey}
              onClose={closeSidePanel}
              onUpdateAgent={onUpdateAgent}
            />
          ) : sidePanel === 'thread' && activeThreadId && parentMessage && onSendThreadReply ? (
            <ChatThreadPanel
              parentMessage={parentMessage}
              threadMessages={visibleThreadMessages}
              streaming={streaming}
              resolveMessageAccent={(message) => resolveMessageAccent(message, agentAccentLookup)}
              onSendReply={onSendThreadReply}
              models={modelOptions}
              agents={agents}
              workspaceId={workspaceId}
              onAgentProfile={openAgentProfilePanel}
              onClose={closeSidePanel}
              embedded
            />
          ) : sidePanel === 'sub-threads' ? (
            <SubThreadListPanel
              subThreadsByMessage={subThreadsByMessage}
              onOpenSubThread={openSubThreadPanel}
              onClose={closeSidePanel}
              workspaceId={workspaceId}
            />
          ) : sidePanel === 'sub-thread' && activeSubThread && onSendSubThreadMessage ? (
            <SubThreadPanel
              session={activeSubThread}
              messages={subThreadMessages}
              streaming={subThreadStreaming}
              resolveMessageAccent={(message) => resolveMessageAccent(message, agentAccentLookup)}
              onSendMessage={onSendSubThreadMessage}
              onAgentProfile={openAgentProfilePanel}
              onClose={closeSidePanel}
              embedded
              documents={documents}
              agents={agents}
              uploadedFiles={uploadedFiles ?? []}
              canvasGroups={canvasGroups}
              onUploadFiles={onUploadFiles}
              composerProjectFiles={composerProjectFiles}
              skillOptions={skillOptions}
              toolOptions={toolOptions}
            />
          ) : sidePanel === 'files' || sidePanel === 'pins' || sidePanel === 'thread' ? (
            <ChannelSidePanel
              type={sidePanel}
              workspaceId={workspaceId}
              pinnedMessages={pinnedMessages}
              uploadedFiles={uploadedFiles}
              projectFiles={projectFiles}
              projectFileSources={projectFileSources}
              projectRoot={projectRoot}
              agents={agents}
              loading={projectFilesLoading}
              onCreateTask={onCreateTask}
              onUploadFiles={uploadAndLinkFiles}
              onClose={closeSidePanel}
            />
          ) : null}
        </aside>
      )}
      </HuddleSessionProvider>


      <Dialog open={catchUpOpen} onOpenChange={setCatchUpOpen}>
        <DialogContent className="w-[min(92vw,44rem)] sm:max-w-[44rem]">
          <DialogHeader>
            <DialogTitle>Catch up on #{channelTitle || 'general'}</DialogTitle>
            <DialogDescription>Channel summary based on visible posts.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="max-h-[62vh] overflow-y-auto text-sm leading-relaxed text-foreground">
              <MarkdownContent content={catchUpSummary} />
            </div>
            <div className="text-xs text-muted-foreground">May miss nuance. Refresh after new activity.</div>
          </div>
        </DialogContent>
      </Dialog>

      <EditChannelDialog
        open={editChannelOpen}
        onOpenChange={setEditChannelOpen}
        baseline={channelProfileBaseline}
        onSave={handleSaveChannelProfile}
        status={channelActionStatus}
      />

      <ConversationAccessDialog
        open={accessOpen}
        onOpenChange={setAccessOpen}
        sessionId={accessSessionId}
        workspaceId={workspaceId ?? null}
        title={directAgent?.name || channelTitle || ''}
      />

      <Dialog open={addParticipantsOpen} onOpenChange={setAddParticipantsOpen}>
        <DialogContent className="max-h-[calc(100svh-2rem)] max-w-lg overflow-hidden">
          <DialogHeader>
            <DialogTitle>Add people or agents</DialogTitle>
            <DialogDescription>Participants for #{channelTitle || 'general'}.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-auto pr-1">
            {(['user', 'agent'] as const).map(kind => {
              const candidates = participantCandidates.filter(participant => participant.kind === kind);
              if (candidates.length === 0) return null;
              return (
                <div key={kind} className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {kind === 'user' ? 'People' : 'Agents'}
                  </div>
                  <div className="space-y-1">
                    {candidates.map(participant => {
                      const selected = selectedParticipantIds.has(dialogParticipantKey(participant));
                      return (
                        <button
                          key={participant.id}
                          type="button"
                          className={`flex w-full min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${selected ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-muted/50'
                            }`}
                          onClick={() => handleToggleParticipant(dialogParticipantKey(participant))}
                        >
                          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                            {participant.kind === 'agent' ? <Bot className="size-4" /> : participant.name.slice(0, 2).toUpperCase()}
                            {participant.connected && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-card bg-emerald-500" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-foreground">{participant.name}</span>
                            {participant.subtitle && (
                              <span className="block truncate text-xs text-muted-foreground">{participant.subtitle}</span>
                            )}
                          </span>
                          <Badge variant={selected ? 'default' : 'outline'}>{selected ? 'Added' : 'Add'}</Badge>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {participantCandidates.length === 0 && (
              <p className="text-sm text-muted-foreground">No people or agents are available.</p>
            )}
            {channelActionStatus && (
              <p className="text-xs text-muted-foreground">{channelActionStatus}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button type="button" variant="ghost" onClick={() => setAddParticipantsOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSaveParticipants()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteMessageTarget)} onOpenChange={open => {
        if (!open) setDeleteMessageTarget(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the post from the channel. Thread replies attached to it may also stop showing in context.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deleteMessageTarget && messageActionBusy === deleteMessageTarget.id)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(deleteMessageTarget && messageActionBusy === deleteMessageTarget.id)}
              onClick={event => {
                event.preventDefault();
                void handleConfirmDeleteMessage();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(subThreadPickerMessageId)} onOpenChange={open => { if (!open) setSubThreadPickerMessageId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Dispatch background task to…</DialogTitle>
            <p className="mt-1 text-xs text-muted-foreground">The agent receives this message as a task and works autonomously. View progress in the Threads panel.</p>
          </DialogHeader>
          <div className="flex flex-col gap-1 py-2">
            {agents.filter(a => a.enabled !== false).map(agent => (
              <button
                key={agent.id}
                type="button"
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-muted"
                onClick={() => {
                  if (subThreadPickerMessageId && onCreateSubThread) {
                    const parentMsg = visibleMessages.find(m => m.id === subThreadPickerMessageId);
                    const content = parentMsg ? (typeof parentMsg.content === 'string' ? parentMsg.content : JSON.stringify(parentMsg.content)) : undefined;
                    onCreateSubThread(subThreadPickerMessageId, agent, content);
                  }
                  setSubThreadPickerMessageId(null);
                  setSidePanel('sub-threads');
                }}
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Bot className="size-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{agent.name}</div>
                  {agent.handle && <div className="truncate text-xs text-muted-foreground">@{agent.handle}</div>}
                </div>
              </button>
            ))}
            {agents.filter(a => a.enabled !== false).length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">No agents available in this workspace.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConnectFlowsDialog
        workspaceId={workspaceId || null}
        channelId={flowConnectChannelId}
        open={flowConnectOpen}
        onOpenChange={setFlowConnectOpen}
      />
    </div>
  );
});

function MessageAvatar({ avatar, initials, isAgent }: { avatar?: string; initials: string; isAgent: boolean }) {
  if (avatar && isPetSpritesheetAvatar(avatar)) {
    return (
      <span className="animated-pet-avatar-shell size-full">
        <span className="animated-pet-avatar" style={{ backgroundImage: `url(${renderablePetAssetUrl(avatar)})` }} />
      </span>
    );
  }
  if (avatar && isImageAvatar(avatar)) {
    return <img src={renderablePetAssetUrl(avatar)} alt="" className="size-full object-contain" loading="lazy" draggable={false} />;
  }
  return isAgent ? <Bot className="size-4" /> : <span>{initials}</span>;
}

function ThinkingIndicator({ text = 'Thinking…' }: { text?: string }) {
  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      <Spinner className="size-3" />
      <span className="text-shimmer font-medium">{text}</span>
    </span>
  );
}

/**
 * The "3 replies · last reply 24 minutes ago" chip under a threaded message.
 *
 * Split out of ChatMessageBubble purely so the relative time can stay live: it
 * subscribes to the shared minute clock, and a tick re-renders every subscriber.
 * Kept at this leaf, a tick re-renders one small chip per threaded message —
 * not the message rows themselves (avatars, markdown, artifacts).
 */
function ThreadReplySummaryButton({
  parentMessageId,
  replyCount,
  summary,
  onOpenThread,
}: {
  parentMessageId: string;
  replyCount: number;
  summary?: ThreadReplySummary;
  onOpenThread: () => void;
}) {
  const now = useSharedNow();

  // replyCount stays authoritative for the number; summary only decorates it
  // (who spoke, how long ago) and can be absent for windows that were handed
  // counts but not the messages behind them.
  const replyLabel = `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;
  const replyParticipants = summary?.participants ?? [];
  const replyOverflow = summary?.overflow ?? 0;
  const lastReplyLabel = formatLastReplyTime(summary?.lastReplyAt, now);
  // Tool calls the agent made while working this thread — split from replyCount
  // in threadSummary.ts so a run full of Bash/Edit steps doesn't read as the
  // agent having said nine things back.
  const toolCount = summary?.toolCount ?? 0;

  // No `mt-1` on the root below — the shared row this now lives in owns the
  // spacing, and keeping it here too would double the gap the row exists to
  // remove.
  return (
    <button
      type="button"
      className="-ml-1 inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-1 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      onClick={onOpenThread}
      aria-label={lastReplyLabel
        ? `Open thread — ${replyLabel}, last reply ${lastReplyLabel}`
        : `Open thread — ${replyLabel}`}
    >
      {replyParticipants.length > 0 ? (
        <span className="flex shrink-0 items-center">
          {replyParticipants.map((participant, index) => (
            <span
              key={participant.key}
              className={cn(
                'flex size-5 items-center justify-center overflow-hidden rounded-md bg-muted text-[8px] font-semibold text-muted-foreground ring-1 ring-background',
                index > 0 && '-ml-1.5',
              )}
              title={participant.name}
            >
              <MessageAvatar
                avatar={participant.avatar}
                initials={participant.name.slice(0, 2).toUpperCase()}
                isAgent={participant.isAgent}
              />
            </span>
          ))}
          {replyOverflow > 0 && (
            <span className="-ml-1.5 flex size-5 items-center justify-center rounded-md bg-muted text-[8px] font-semibold text-muted-foreground ring-1 ring-background">
              +{replyOverflow}
            </span>
          )}
        </span>
      ) : (
        <CornerDownRight className="size-3 shrink-0" />
      )}
      <span className="shrink-0 font-medium">{replyLabel}</span>
      {/* "· working 1m 4s" while an agent has a running job in THIS thread.
          Self-contained: it subscribes to the agent-work store and owns the 1s
          clock internally, so the tick repaints one <span> and this chip (with
          its avatars + markdown-free labels) is untouched. */}
      <ThreadWorkBadge parentMessageId={parentMessageId} />
      {toolCount > 0 && (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/50">·</span>
          <span
            className="flex shrink-0 items-center gap-1 text-muted-foreground/70"
            title={`${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`}
          >
            <Wrench className="size-3" />
            {toolCount}
          </span>
        </>
      )}
      {lastReplyLabel && (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/50">·</span>
          <span className="truncate text-muted-foreground/70">last reply {lastReplyLabel}</span>
        </>
      )}
    </button>
  );
}

function ChatMessageBubble({
  msg,
  avatar,
  accent,
  isStreaming,
  replyCount,
  replySummary,
  isEditing,
  editingContent,
  actionBusy,
  onTogglePin,
  onStartEdit,
  onCancelEdit,
  onChangeEdit,
  onSaveEdit,
  onDelete,
  onOpenThread,
  onOpenSourceThread,
  onAgentProfile,
  subThreads,
  onOpenSubThread,
  onCreateSubThread,
  widgetsOverlaying,
  currentUserId,
  onToggleReaction,
  resolveUserName,
  reactionUses,
  readerIds,
  isDirectMessage,
}: {
  msg: ChatMessage;
  avatar?: string;
  accent?: string;
  isStreaming?: boolean;
  replyCount?: number;
  replySummary?: ThreadReplySummary;
  isEditing?: boolean;
  editingContent?: string;
  actionBusy?: boolean;
  onTogglePin?: () => void;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  onChangeEdit?: (value: string) => void;
  onSaveEdit?: () => void;
  onDelete?: () => void;
  onOpenThread?: () => void;
  onOpenSourceThread?: () => void;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  subThreads?: ChatSession[];
  onOpenSubThread?: (session: ChatSession) => void;
  onCreateSubThread?: () => void;
  widgetsOverlaying?: boolean;
  currentUserId?: string;
  onToggleReaction?: (reaction: string, op: 'add' | 'remove') => void;
  resolveUserName?: (userId: string) => string | null;
  reactionUses?: readonly ReactionUse[];
  /**
   * Who has read this message. `undefined` means "do not draw an indicator here"
   * — which is every message except the last of each of your own runs — and is
   * deliberately distinct from `[]`, which means "your message, nobody has read
   * it yet" and DOES draw one in a DM.
   */
  readerIds?: string[];
  isDirectMessage?: boolean;
}) {
  const isUser = msg.role === 'user';
  const rawContent = safeMessageText(msg.content);
  const attachments = parseMessageAttachments(msg.attachments);
  // The "[Linked files]" bullet list stays in the stored content for the agent.
  // Once there are chips standing in for the uploaded lines, showing both is the
  // duplication this feature removes — so strip for display, and ONLY when there
  // is something to strip it in favour of. Messages written before this column
  // existed render exactly as they always did.
  const contentForDisplay = attachments.length > 0 ? stripUploadedFileLinesFromDisplay(rawContent) : rawContent;
  const artifact = contentForDisplay ? extractHtmlArtifact(contentForDisplay) : null;
  const displayContent = artifact ? artifact.remainingText : contentForDisplay;
  const isThinkingPlaceholder = isActivityPlaceholderMessage(msg);
  const placeholderText = isThinkingPlaceholder ? activityLine(extractActivityVerb(rawContent), rawContent) : '';
  const unavailableMessage = msg.role === 'assistant' ? EMPTY_STREAM_RESPONSE : 'Message content is unavailable.';
  const senderName = msg.sender_name || (isUser ? 'You' : 'Assistant');
  const initials = senderName.slice(0, 2).toUpperCase() || (isUser ? 'ME' : 'AI');
  const createdAt = msg.created_at ? new Date(msg.created_at) : null;
  const timeLabel = createdAt && Number.isFinite(createdAt.getTime())
    ? createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const canOpenAgentProfile = msg.sender_kind === 'agent' && Boolean(msg.sender_id || msg.sender_name);
  const agentProfileKey = msg.sender_id || msg.sender_name || '';
  const isAgentMessage = msg.sender_kind === 'agent' && Boolean(accent);
  const accentStyle = isAgentMessage
    ? ({ '--agent-accent': validAgentAccentColor(accent) } as React.CSSProperties & { '--agent-accent': string })
    : undefined;

  const reactions = msg.reactions ?? {};
  // No 'me' fallback any more. The old default meant an anonymous or
  // not-yet-loaded viewer matched the literal string 'me' in the map, so every
  // pill rendered as though they had reacted.
  const uid = currentUserId || null;
  const pills = useMemo(() => reactionPills(reactions, uid), [reactions, uid]);
  // Quick picks in the hover rail: the three most-used reactions, so the common
  // case is one click instead of open-picker-then-click.
  const quickReactions = useMemo(() => frequentReactions(reactionUses ?? [], 3), [reactionUses]);

  return (
    <div
      className="chat-message-row group relative flex w-full min-w-0 gap-3 px-4 py-2 pr-20"
      data-agent-message={isAgentMessage ? 'true' : undefined}
      style={accentStyle}
    >
      <div className="chat-message-avatar mt-0.5 flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-[10px] font-semibold text-muted-foreground">
        <MessageAvatar avatar={avatar} initials={initials} isAgent={msg.sender_kind === 'agent' || msg.role === 'assistant'} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          {canOpenAgentProfile ? (
            <button
              type="button"
              className="truncate text-left text-sm font-semibold text-foreground underline-offset-2 hover:underline"
              style={accentStyle ? { color: 'var(--agent-accent)' } : undefined}
              onClick={() => onAgentProfile?.(agentProfileKey)}
            >
              {senderName}
            </button>
          ) : (
            <span className="truncate text-sm font-semibold text-foreground" style={accentStyle ? { color: 'var(--agent-accent)' } : undefined}>{senderName}</span>
          )}
          {timeLabel && <span className="shrink-0 text-xs text-muted-foreground">{timeLabel}</span>}
          {/* A broadcast reply was WRITTEN in a thread and only its answer was sent
              here, so without this it reads as a top-level message that lost its
              context — you cannot tell what it is replying to, or where the tool
              steps and intermediate blocks went. The chip says "there is a working
              conversation behind this" and opens it. */}
          {isBroadcastFromThread(msg) && (
            onOpenSourceThread ? (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                onClick={onOpenSourceThread}
                title="Written in a thread — open it to see the working"
              >
                <CornerDownRight className="size-3" />
                from a thread
              </button>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <CornerDownRight className="size-3" />
                from a thread
              </span>
            )
          )}
        </div>
        {isEditing ? (
          <div className="mt-2 max-w-4xl space-y-2">
            <textarea
              value={editingContent ?? ''}
              onChange={event => onChangeEdit?.(event.target.value)}
              className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus:border-ring"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Button type="button" size="xs" onClick={onSaveEdit} disabled={actionBusy || !(editingContent ?? '').trim()}>
                Save
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={onCancelEdit} disabled={actionBusy}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-1 max-w-4xl text-sm leading-relaxed text-foreground">
            {/* buildTranscriptRows now diverts activity placeholders into the chip
                strip, so this branch no longer fires from the transcript. Kept as the
                floor: anything that renders a bubble straight from a message (a thread
                parent, a future surface) must not print "Thinking 15s" as prose. */}
            {isThinkingPlaceholder ? (
              <ThinkingIndicator text={placeholderText} />
            ) : displayContent ? (
              <MarkdownContent content={displayContent} streaming={isStreaming} onMentionClick={onAgentProfile} />
            ) : isStreaming ? (
              <ThinkingIndicator />
            ) : attachments.length > 0 ? (
              // A message that is only files. Its content was the "[Linked
              // files]" stub and the chips below now say the same thing, so
              // "Message content is unavailable" would be a lie.
              null
            ) : (
              <span className="text-muted-foreground">{unavailableMessage}</span>
            )}
            {artifact && <ChatArtifact artifact={artifact} />}
            <MessageAttachmentList attachments={attachments} />
            {/* Link cards, once the message has settled. Deliberately NOT while
                streaming: the URL is still being typed a token at a time, so
                unfurling mid-stream would fire a request for a half-written link
                and flash a card that is about to be wrong. */}
            {!isStreaming && !isThinkingPlaceholder && displayContent && (
              <LinkPreviewCards content={displayContent} />
            )}
          </div>
        )}
        {isStreaming && msg.content && (
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Streaming
          </div>
        )}
        {/* ONE row: reply stats, sub-thread chips, and the create button all sit
            on the same line. They used to be two stacked blocks, and the second
            one rendered on EVERY message — `onCreateSubThread` is always set —
            holding an h-6 button at opacity-0. Invisible, but still reserving
            ~28px under every message in the timeline: a large gap with nothing
            in it until you happened to hover. Delegate has since moved into the
            floating action bar entirely, so this row now renders ONLY when there
            is real content — replies or sub-thread chips — to put in it. */}
        {(replyCount && onOpenThread) || (subThreads && subThreads.length > 0) ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {replyCount && onOpenThread ? (
              <ThreadReplySummaryButton
                parentMessageId={msg.id}
                replyCount={replyCount}
                summary={replySummary}
                onOpenThread={onOpenThread}
              />
            ) : null}
            {(subThreads || []).map(session => {
              const agentParticipants = normalizeChannelParticipants(session.participants).filter(p => p.kind === 'agent');
              const label = agentParticipants.length > 0
                ? agentParticipants.map(p => p.handle || p.name).join(', ')
                : session.title;
              return (
                <button
                  key={session.id}
                  type="button"
                  className="control-outer-ring inline-flex h-5 items-center gap-1 rounded-md border border-border bg-muted/60 px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onOpenSubThread?.(session)}
                >
                  <MessageSquare className="size-2.5" />
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
        {/* Reaction pills — rendered only when reactions exist, so a message
            with none costs no vertical space and hovering shifts nothing.
            Everything about ordering, own-reaction state and the tooltip lives
            in src/lib/reactionBar.ts, because logic in this file cannot be
            tested under this repo's runners. */}
        {onToggleReaction && (
          <ReactionBar
            reactions={reactions}
            currentUserId={uid}
            resolveName={resolveUserName || (() => null)}
            onToggle={onToggleReaction}
            reactionUses={reactionUses}
          />
        )}
        {/* "Seen". An SVG, never 👀 — nobody chose it, so it is chrome, and 👀
            is already in the reaction picker (the same glyph would mean two
            different things in one row). Never a per-reader timestamp. */}
        {/* The emptiness check is HERE and not only inside ReadReceipt: the
            wrapper carries `mt-1`, so rendering it around a component that
            returns null would add 4px under every one of your messages in a
            channel nobody has read yet. */}
        {readerIds !== undefined && (isDirectMessage || readerIds.length > 0) && (
          <div className="mt-1 flex items-center justify-end">
            <ReadReceipt
              readerIds={readerIds}
              resolveName={resolveUserName || (() => null)}
              isDirect={isDirectMessage}
            />
          </div>
        )}
      </div>
      {/* Full-height rail bounded to this message row; the toolbar inside is sticky so it
          rides into view as you scroll a tall message (top → mid-viewport → bottom-right)
          instead of scrolling off the top with the message header. */}
      <div className={cn('pointer-events-none absolute inset-y-0 flex items-start', widgetsOverlaying ? 'right-[288px]' : 'right-3')}>
        <div className="pointer-events-auto sticky top-2 hidden items-center gap-1 rounded-md border bg-popover p-0.5 shadow-sm group-hover:flex group-focus-within:flex">
          {/* The one-click quick picks, then the full picker. The quick row is
              the common case made cheap: reacting used to be two clicks every
              time, and the most-used reaction is nearly always one of these. */}
          {onToggleReaction && quickReactions.map(reaction => {
            const pill = pills.find(entry => entry.reaction === reaction);
            return (
              <Button
                key={reaction}
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-pressed={Boolean(pill?.mine)}
                aria-label={`React with ${reaction}`}
                title={`React with ${reaction}`}
                className={cn('text-base', pill?.mine && 'bg-primary/10')}
                onClick={() => onToggleReaction(reaction, reactionToggleOp(pill, uid))}
              >
                {reaction}
              </Button>
            );
          })}
          {onToggleReaction && (
            <ReactionPicker
              reactionUses={reactionUses}
              onPick={reaction => onToggleReaction(
                reaction,
                reactionToggleOp(pills.find(entry => entry.reaction === reaction), uid),
              )}
            />
          )}
          {onOpenThread && (
            <Button type="button" variant="ghost" size="icon-xs" onClick={onOpenThread} disabled={isStreaming || actionBusy} aria-label={replyCount ? 'Open thread' : 'Start thread'} title={replyCount ? 'Open thread' : 'Start thread'}>
              <CornerDownRight />
            </Button>
          )}
          {/* "Delegate", not "Sub-thread": this hands the message to an agent as a
              background task, which is what the picker it opens actually does. It
              lives in this floating bar with the other per-message actions rather
              than as a labelled button under the message — that placement is what
              made it either a permanent 28px gap (opacity-0) or a row that grew on
              hover. An icon in an existing bar costs no layout at all. */}
          {onCreateSubThread && (
            <Button type="button" variant="ghost" size="icon-xs" onClick={onCreateSubThread} disabled={isStreaming || actionBusy} aria-label="Delegate to an agent" title="Delegate to an agent">
              <UserPlus />
            </Button>
          )}
          {onTogglePin && (
            <Button type="button" variant="ghost" size="icon-xs" onClick={onTogglePin} disabled={actionBusy} aria-label={msg.pinned ? 'Unpin post' : 'Pin post'} title={msg.pinned ? 'Unpin post' : 'Pin post'}>
              <Pin fill={msg.pinned ? 'currentColor' : 'none'} />
            </Button>
          )}
          {onStartEdit && (
            <Button type="button" variant="ghost" size="icon-xs" onClick={onStartEdit} disabled={actionBusy || isStreaming} aria-label="Edit post" title="Edit post">
              <Pencil />
            </Button>
          )}
          {onDelete && (
            <Button type="button" variant="ghost" size="icon-xs" onClick={onDelete} disabled={actionBusy} aria-label="Delete post" title="Delete post">
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SubThreadRow({ session, onOpen, showChannel }: { session: ChatSession; onOpen: (s: ChatSession) => void; showChannel?: boolean }) {
  const agents = normalizeChannelParticipants(session.participants).filter(p => p.kind === 'agent');
  const ts = new Date(session.updated_at);
  const diffMins = Math.floor((Date.now() - ts.getTime()) / 60000);
  const timeLabel =
    diffMins < 1 ? 'just now'
      : diffMins < 60 ? `${diffMins}m ago`
        : diffMins < 1440 ? `${Math.floor(diffMins / 60)}h ago`
          : ts.toLocaleDateString();
  return (
    <button
      type="button"
      className="w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      onClick={() => onOpen(session)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{session.title || 'Sub-thread'}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{timeLabel}</span>
      </div>
      {showChannel && session.folder && (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground/80">{session.folder}</div>
      )}
      {agents.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1">
          {agents.map(a => (
            <span key={a.id} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
              @{a.handle ?? a.name}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function SubThreadListPanel({
  subThreadsByMessage,
  onOpenSubThread,
  onClose,
  workspaceId,
}: {
  subThreadsByMessage: Record<string, ChatSession[]>;
  onOpenSubThread: (session: ChatSession) => void;
  onClose: () => void;
  workspaceId?: string | null;
}) {
  const allThreads = useMemo(
    () =>
      Object.values(subThreadsByMessage)
        .flat()
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [subThreadsByMessage],
  );
  // Cross-channel: every thread the signed-in user is involved in, workspace-wide.
  const { threads: myThreads } = useMyThreads(workspaceId ?? null);
  // Threads already shown in this channel's sub-thread list — don't repeat them
  // in the "involving you" section.
  const channelThreadIds = useMemo(() => new Set(allThreads.map(t => t.id)), [allThreads]);
  const otherMyThreads = useMemo(
    () => myThreads.filter(t => !channelThreadIds.has(t.id)),
    [myThreads, channelThreadIds],
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          Sub-threads
          {allThreads.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
              {allThreads.length}
            </span>
          )}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {allThreads.length === 0 && otherMyThreads.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <GitBranch className="h-8 w-8 opacity-30" />
            <p className="text-sm">No sub-threads yet</p>
            <p className="text-center text-xs opacity-70">Delegate any message to an agent using the Delegate action on it</p>
          </div>
        ) : (
          <>
            {allThreads.length > 0 && (
              <div className="divide-y divide-border">
                {allThreads.map(session => (
                  <SubThreadRow key={session.id} session={session} onOpen={onOpenSubThread} />
                ))}
              </div>
            )}
            {otherMyThreads.length > 0 && (
              <div>
                <div className="sticky top-0 z-10 border-y border-border bg-card/85 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur-md">
                  Involving you · other channels
                </div>
                <div className="divide-y divide-border">
                  {otherMyThreads.map(session => (
                    <SubThreadRow key={session.id} session={session} onOpen={onOpenSubThread} showChannel />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ChannelSidePanel({
  type,
  workspaceId,
  pinnedMessages,
  uploadedFiles,
  projectFiles,
  projectFileSources,
  projectRoot,
  agents,
  loading,
  onCreateTask,
  onUploadFiles,
  onClose,
}: {
  type: 'files' | 'pins' | 'thread';
  workspaceId?: string | null;
  pinnedMessages: ChatMessage[];
  uploadedFiles: UploadedFile[];
  projectFiles: ProjectFileEntry[];
  projectFileSources: ProjectFileSource[];
  projectRoot: string;
  agents: WorkspaceAgent[];
  loading: boolean;
  onCreateTask?: (input: CreateTaskInput) => void | Promise<unknown>;
  onUploadFiles?: (files: File[]) => void | Promise<unknown>;
  onClose: () => void;
}) {
  const isPins = type === 'pins';
  const isFiles = type === 'files';
  const [selectedFile, setSelectedFile] = useState<SelectedPanelFile | null>(null);
  const [filesDropActive, setFilesDropActive] = useState(false);
  const [filesTab, setFilesTab] = useState<'files' | 'changes'>('files');

  // Scoped drop target: stopPropagation so dropping files here uploads/links
  // them instead of falling through to the canvas-wide drop handler.
  const handlePanelDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFiles || !onUploadFiles || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    setFilesDropActive(true);
  };
  const handlePanelDragLeave = () => setFilesDropActive(false);
  const handlePanelDrop = (event: React.DragEvent<HTMLDivElement>) => {
    setFilesDropActive(false);
    if (!isFiles || !onUploadFiles) return;
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void onUploadFiles(files);
  };
  const projectGroups = useMemo(() => {
    if (projectFileSources.length > 0) {
      return projectFileSources
        .map(source => ({ source, files: Array.isArray(source.files) ? source.files : [] }))
        .filter(group => group.files.length > 0);
    }
    if (projectFiles.length === 0) return [];
    return [{
      source: { id: 'workspace', kind: 'workspace' as const, label: 'Workspace folder', root: projectRoot, files: projectFiles },
      files: projectFiles,
    }];
  }, [projectFileSources, projectFiles, projectRoot]);

  useEffect(() => {
    if (isPins) setSelectedFile(null);
  }, [isPins]);

  const openUploadedFile = async (file: UploadedFile) => {
    const response = await fetch(apiUrl(`/backend/files/${encodeURIComponent(file.id)}/content`), {
      headers: apiAuthHeaders(),
    });
    if (!response.ok) return;
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    window.open(objectUrl, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  };

  const fileCount = uploadedFiles.length + projectGroups.reduce((sum, group) => sum + group.files.length, 0);

  return (
    <div
      className={cn('flex h-full min-w-0 flex-col', filesDropActive && 'outline-2 outline-dashed outline-primary -outline-offset-2')}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      <div className="channel-header flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        {!isPins && selectedFile ? (
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => setSelectedFile(null)} aria-label="Back to files">
            <ArrowLeft />
          </Button>
        ) : isPins ? (
          <Pin className="size-4 text-muted-foreground" />
        ) : (
          <Paperclip className="size-4 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {isPins ? 'Pinned messages' : selectedFile ? panelFileName(selectedFile) : 'Files'}
        </span>
        {isFiles && !selectedFile && (
          <div className="flex items-center gap-1 rounded-md border bg-muted/40 p-0.5">
            <Button
              type="button"
              size="xs"
              variant={filesTab === 'files' ? 'secondary' : 'ghost'}
              onClick={() => setFilesTab('files')}
            >
              Files
            </Button>
            <Button
              type="button"
              size="xs"
              variant={filesTab === 'changes' ? 'secondary' : 'ghost'}
              onClick={() => setFilesTab('changes')}
            >
              Changes
            </Button>
          </div>
        )}
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close side panel">
          <X />
        </Button>
      </div>
      <div className="channel-side-panel-body min-h-0 flex-1 overflow-auto p-2">
        {isFiles && filesTab === 'changes' && !selectedFile ? (
          <GitChangesView workspaceId={workspaceId} />
        ) : isPins ? (
          pinnedMessages.length > 0 ? (
            <div className="space-y-2">
              {pinnedMessages.map(message => {
                // Same two-part read as the transcript bubble: chips for the
                // uploaded files, and the text stub stripped only because a chip
                // is standing in for it.
                const pinnedAttachments = parseMessageAttachments(message.attachments);
                const pinnedText = safeMessageText(message.content);
                return (
                  <div key={message.id} className="rounded-md border bg-muted/40 p-2 text-sm">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">{message.sender_name || (message.role === 'user' ? 'You' : 'Assistant')}</div>
                    <MarkdownContent
                      content={pinnedAttachments.length > 0 ? stripUploadedFileLinesFromDisplay(pinnedText) : pinnedText}
                      compact
                    />
                    <MessageAttachmentList attachments={pinnedAttachments} />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No pinned messages yet.</p>
          )
        ) : selectedFile ? (
          <FileDetailPanel
            selectedFile={selectedFile}
            agents={agents}
            onOpenUploaded={openUploadedFile}
            onCreateTask={onCreateTask}
            onTaskCreated={() => setSelectedFile(null)}
          />
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading files...</p>
        ) : fileCount > 0 ? (
          <div className="file-tree">
            {uploadedFiles.length > 0 && (
              <FileTreeSection title="Uploaded" count={uploadedFiles.length} defaultOpen={false}>
                {uploadedFiles.map(file => (
                  <UploadedFileRow
                    key={file.id}
                    file={file}
                    onOpen={() => setSelectedFile({ kind: 'uploaded', file })}
                  />
                ))}
              </FileTreeSection>
            )}
            {projectGroups.map(group => {
              const rootFiles: ProjectFileEntry[] = [];
              const dirFiles = new Map<string, ProjectFileEntry[]>();
              for (const file of group.files) {
                const firstSlash = file.path.indexOf('/');
                if (firstSlash === -1) {
                  rootFiles.push(file);
                } else {
                  const dir = file.path.slice(0, firstSlash);
                  if (!dirFiles.has(dir)) dirFiles.set(dir, []);
                  dirFiles.get(dir)!.push(file);
                }
              }
              return (
                <FileTreeSection
                  key={group.source.id}
                  title={group.source.label}
                  detail={group.source.root}
                  count={group.files.length}
                >
                  {rootFiles.map(file => (
                    <ProjectFileRow
                      key={`${group.source.id}:${file.path}`}
                      file={file}
                      source={group.source}
                      onOpen={() => setSelectedFile({ kind: 'project', file, source: group.source })}
                    />
                  ))}
                  {Array.from(dirFiles.entries()).map(([dir, files]) => (
                    <FileTreeDirSection key={dir} name={dir} count={files.length}>
                      {files.map(file => (
                        <ProjectFileRow
                          key={`${group.source.id}:${file.path}`}
                          file={file}
                          source={group.source}
                          onOpen={() => setSelectedFile({ kind: 'project', file, source: group.source })}
                        />
                      ))}
                    </FileTreeDirSection>
                  ))}
                </FileTreeSection>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No uploaded, workspace, or agent files found.</p>
        )}
      </div>
    </div>
  );
}

interface GitChangeEntry {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
  agentId?: string | null;
  agentLabel?: string | null;
}

const GIT_STATUS_LABEL: Record<GitChangeEntry['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
};

const GIT_STATUS_CLASS: Record<GitChangeEntry['status'], string> = {
  modified: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  added: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  deleted: 'bg-red-500/15 text-red-700 dark:text-red-400',
  untracked: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  renamed: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
};

// Working-tree diff + stage/commit view for a workspace's git repo. Status/diff
// are read from /backend/workspaces/:id/git/status and /git/diff; staging and
// committing post to /git/stage, /git/unstage and /git/commit. All five are
// Express-only (no filesystem/git access from the browser, and no persistent
// working tree on the Netlify serverless deploy target) — requests there 404
// and surface as the inline error states below rather than crashing the panel.
function GitChangesView({ workspaceId }: { workspaceId?: string | null }) {
  const [loading, setLoading] = useState(true);
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<GitChangeEntry[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<GitChangeEntry | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffText, setDiffText] = useState('');
  const [diffIsUntracked, setDiffIsUntracked] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

  const refreshStatus = useCallback(() => {
    if (!workspaceId) return Promise.resolve();
    setError('');
    return fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/git/status`), {
      headers: apiAuthHeaders(),
    })
      .then(response => response.json())
      .then(payload => {
        setBranch(typeof payload?.data?.branch === 'string' ? payload.data.branch : '');
        setFiles(Array.isArray(payload?.data?.files) ? payload.data.files : []);
      })
      .catch(() => {
        setError('Could not load git status for this workspace.');
      });
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    refreshStatus().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshStatus]);

  const setPathPending = (paths: string[], pending: boolean) => {
    setPendingPaths(prev => {
      const next = new Set(prev);
      paths.forEach(path => (pending ? next.add(path) : next.delete(path)));
      return next;
    });
  };

  const setStaged = async (paths: string[], staged: boolean) => {
    if (!workspaceId || paths.length === 0) return;
    setActionError('');
    setPathPending(paths, true);
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/git/${staged ? 'stage' : 'unstage'}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ paths }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || 'Failed to update staging');
      setFiles(prev => prev.map(file => (paths.includes(file.path) ? { ...file, staged } : file)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update staging');
    } finally {
      setPathPending(paths, false);
    }
  };

  const submitCommit = async () => {
    if (!workspaceId || !commitMessage.trim()) return;
    setActionError('');
    setCommitting(true);
    try {
      const response = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/git/commit`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ message: commitMessage.trim() }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || 'Commit failed');
      setCommitMessage('');
      await refreshStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  };

  const openDiff = (entry: GitChangeEntry) => {
    setSelected(entry);
    if (!workspaceId) return;
    setDiffLoading(true);
    setDiffText('');
    fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/git/diff?path=${encodeURIComponent(entry.path)}`), {
      headers: apiAuthHeaders(),
    })
      .then(response => response.json())
      .then(payload => {
        setDiffIsUntracked(Boolean(payload?.data?.untracked));
        setDiffText(payload?.data?.untracked ? (payload?.data?.content || '') : (payload?.data?.diff || ''));
      })
      .catch(() => setDiffText('Could not load diff for this file.'))
      .finally(() => setDiffLoading(false));
  };

  if (!workspaceId) return <p className="text-sm text-muted-foreground">No workspace context for git changes.</p>;
  if (loading) return <p className="text-sm text-muted-foreground">Checking git status...</p>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;

  if (selected) {
    const isPending = pendingPaths.has(selected.path);
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => setSelected(null)} aria-label="Back to changes">
            <ArrowLeft />
          </Button>
          <Badge variant="outline" className={GIT_STATUS_CLASS[selected.status]}>{GIT_STATUS_LABEL[selected.status]}</Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected.path}</span>
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={selected.staged}
              disabled={isPending}
              onCheckedChange={checked => {
                const staged = checked === true;
                setSelected(prev => (prev ? { ...prev, staged } : prev));
                void setStaged([selected.path], staged);
              }}
            />
            Staged
          </label>
        </div>
        {diffLoading ? (
          <p className="text-sm text-muted-foreground">Loading diff...</p>
        ) : !diffText ? (
          <p className="text-sm text-muted-foreground">No changes to show for this file.</p>
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed">
            {diffText.split('\n').map((line, idx) => (
              <div
                key={idx}
                className={
                  diffIsUntracked
                    ? ''
                    : line.startsWith('+') && !line.startsWith('+++')
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : line.startsWith('-') && !line.startsWith('---')
                        ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                        : line.startsWith('@@')
                          ? 'text-muted-foreground'
                          : ''
                }
              >
                {line || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    );
  }

  const stagedFiles = files.filter(file => file.staged);
  const unstagedFiles = files.filter(file => !file.staged);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        {branch ? (
          <span className="text-xs text-muted-foreground">On branch <span className="font-mono">{branch}</span></span>
        ) : <span />}
        {files.length > 0 && (
          <div className="flex shrink-0 gap-1">
            {unstagedFiles.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setStaged(unstagedFiles.map(f => f.path), true)}>
                Stage all
              </Button>
            )}
            {stagedFiles.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setStaged(stagedFiles.map(f => f.path), false)}>
                Unstage all
              </Button>
            )}
          </div>
        )}
      </div>

      {files.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">Working tree clean — no changes.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex flex-col gap-0.5">
            {files.map(entry => (
              <div
                key={entry.path}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
              >
                <Checkbox
                  checked={entry.staged}
                  disabled={pendingPaths.has(entry.path)}
                  onCheckedChange={checked => setStaged([entry.path], checked === true)}
                  aria-label={entry.staged ? `Unstage ${entry.path}` : `Stage ${entry.path}`}
                />
                <button
                  type="button"
                  onClick={() => openDiff(entry)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <Badge variant="outline" className={cn('shrink-0', GIT_STATUS_CLASS[entry.status])}>{GIT_STATUS_LABEL[entry.status]}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
                  {entry.agentLabel && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">{entry.agentLabel}</Badge>
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {actionError && <p className="px-1 text-xs text-destructive">{actionError}</p>}

      {stagedFiles.length > 0 && (
        <div className="flex shrink-0 flex-col gap-1.5 border-t border-border pt-2">
          <Textarea
            value={commitMessage}
            onChange={e => setCommitMessage(e.target.value)}
            placeholder={`Commit message for ${stagedFiles.length} staged file${stagedFiles.length === 1 ? '' : 's'}...`}
            rows={2}
            className="resize-none text-sm"
          />
          <Button
            type="button"
            size="sm"
            onClick={submitCommit}
            disabled={committing || !commitMessage.trim()}
            className="self-end gap-1.5"
          >
            {committing ? <Loader2 className="size-3.5 animate-spin" /> : <GitCommitHorizontal className="size-3.5" />}
            {committing ? 'Committing…' : `Commit ${stagedFiles.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentProfileSidePanel({
  agent,
  currentUserId,
  participant,
  connections,
  lookupKey,
  onClose,
}: {
  currentUserId?: string;
  agent: WorkspaceAgent | null;
  participant: ChannelParticipant | null;
  connections: AgentConnection[];
  lookupKey?: string | null;
  onClose: () => void;
  // Accepted for API compatibility with the caller but not consumed here.
  onUpdateAgent?: (id: string, updates: Partial<WorkspaceAgent>) => void | Promise<unknown>;
}) {
  const handle = agent?.handle || participant?.handle || (agent ? agentHandle(agent) : normalizeAgentLookupKey(participant?.name));
  const name = agent?.name || participant?.name || 'Agent';
  const matchingConnections = useMemo(
    () => connections.filter(connection => connectionMatchesAgentProfile(connection, agent, participant, lookupKey)),
    [agent, connections, lookupKey, participant],
  );
  const activeConnection = matchingConnections.find(connection => connection.status !== 'offline') || matchingConnections[0] || null;
  const status = activeConnection?.status || participant?.status || (agent?.run_mode === 'daemon' ? 'daemon' : 'built-in');
  const tools = normalizeStringList(agent?.tools);
  const skills = normalizeStringList(agent?.skills);
  const metadataRows = activeConnection ? agentConnectionMetadataRows(activeConnection.metadata) : [];
  const AvatarIcon = getAgentAvatarIcon(agent?.avatar);

  return (
    <div className="flex h-full min-w-0 flex-col" style={agent ? agentAccentStyle(agent) : undefined}>
      <div className="channel-header flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Bot className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Profile</span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close profile">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="flex flex-col items-center text-center">
          <div className="agent-profile-avatar grid size-20 place-items-center overflow-hidden rounded-2xl bg-muted text-2xl font-semibold">
            {agent?.avatar && isPetSpritesheetAvatar(agent.avatar) ? (
              <span className="animated-pet-avatar-shell size-full">
                <span className="animated-pet-avatar" style={{ backgroundImage: `url(${renderablePetAssetUrl(agent.avatar)})` }} />
              </span>
            ) : isImageAvatar(agent?.avatar) ? (
              <img src={renderablePetAssetUrl(agent?.avatar || '')} alt="" className="size-full object-cover" draggable={false} />
            ) : AvatarIcon ? (
              <AvatarIcon className="size-9 text-muted-foreground" />
            ) : (
              <Bot className="size-9 text-muted-foreground" />
            )}
          </div>
          <div className="mt-3 text-base font-semibold">{name}</div>
          {handle && <div className="text-sm text-muted-foreground">@{handle}</div>}
          <Badge variant={status === 'online' || status === 'busy' ? 'default' : 'secondary'} className="mt-2 capitalize">
            {status}
          </Badge>
        </div>

        <div className="mt-5 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <AgentProfileStat label="Runtime" value={agent?.run_mode === 'daemon' || activeConnection ? 'Connected' : 'Built in'} />
            <AgentProfileStat label="Model" value={agent?.model || 'Auto'} />
            <AgentProfileStat label="Mode" value={formatRunMode(agent?.run_mode)} />
            <AgentProfileStat label="Access" value={formatPermissionMode(agent?.permission_mode)} />
          </div>

          <AgentProfileSection title="Identity">
            <AgentProfileField label="Name" value={name} />
            <AgentProfileField label="Handle" value={handle ? `@${handle}` : ''} />
            <AgentProfileField label="Agent ID" value={agent?.id ? shortId(agent.id) : ''} title={agent?.id} />
            <AgentProfileField label="Workspace ID" value={agent?.workspace_id ? shortId(agent.workspace_id) : ''} title={agent?.workspace_id} />
            {/* Whose agent this is. In a shared workspace it is the difference
                between "the AI said" and "Jason's agent said" — accountability
                when an agent does something surprising. */}
            <AgentProfileField
              label="Managed by"
              value={
                agent?.created_by
                  ? (currentUserId && agent.created_by === currentUserId ? 'you' : shortId(agent.created_by))
                  : ''
              }
              title={agent?.created_by || undefined}
            />
            <AgentProfileField label="Version" value={agent?.version ? `v${agent.version}` : ''} />
            <AgentProfileField label="Created" value={formatDateTime(agent?.created_at)} />
            <AgentProfileField label="Updated" value={formatDateTime(agent?.updated_at)} />
          </AgentProfileSection>

          {participant && (
            <AgentProfileSection title="Channel">
              <AgentProfileField label="Participant ID" value={shortId(participant.id)} title={participant.id} />
              <AgentProfileField label="Direct channel" value={participant.direct ? 'Yes' : 'No'} />
              <AgentProfileField label="Added" value={formatDateTime(participant.added_at)} />
            </AgentProfileSection>
          )}

          {activeConnection && (
            <AgentProfileSection title="Connection">
              <AgentProfileField label="Status" value={activeConnection.status} />
              <AgentProfileField label="Connection ID" value={shortId(activeConnection.id)} title={activeConnection.id} />
              <AgentProfileField label="Agent ID" value={activeConnection.agent_id ? shortId(activeConnection.agent_id) : ''} title={activeConnection.agent_id || undefined} />
              <AgentProfileField label="Host" value={activeConnection.host || 'Local'} />
              <AgentProfileField label="Working directory" value={activeConnection.cwd || 'Not reported'} />
              <AgentProfileField label="Connected" value={formatDateTime(activeConnection.connected_at)} />
              <AgentProfileField label="Last heartbeat" value={formatDateTime(activeConnection.last_seen_at)} />
              <AgentProfileField label="Updated" value={formatDateTime(activeConnection.updated_at)} />
            </AgentProfileSection>
          )}

          {metadataRows.length > 0 && (
            <AgentProfileSection title="Runtime metadata">
              {metadataRows.map(row => (
                <AgentProfileField key={row.label} label={row.label} value={row.value} />
              ))}
            </AgentProfileSection>
          )}

          <AgentProfileChipSection title="Tools" empty="No tools configured" items={tools} />
          <AgentProfileChipSection title="Skills" empty="No skills configured" items={skills} />

          {agent?.description && (
            <AgentProfileTextSection title="Description" value={agent.description} />
          )}
          {agent?.soul && agent.soul !== agent.description && (
            <AgentProfileTextSection title="Soul" value={agent.soul} />
          )}
          {agent?.system_prompt && (
            <AgentProfileTextSection title="System prompt" value={agent.system_prompt} tall />
          )}
          {agent?.instructions && agent.instructions !== agent.system_prompt && (
            <AgentProfileTextSection title="Instructions" value={agent.instructions} tall />
          )}
          {/* Agent-mesh invariant (F8): this list binds to hub-written agent_connections rows
              and is unaffected by whether a message to this agent went direct (daemon-to-daemon
              handoff) or hub-relayed — reach is server-redacted (publicAgentConnection) so it
              never reaches this component. */}
          {matchingConnections.length > 1 && (
            <AgentProfileSection title="Other connections">
              <div className="space-y-1.5">
                {matchingConnections.map(connection => (
                  <div key={connection.id} className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{connection.name || connection.handle}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge variant={connection.status === 'online' || connection.status === 'busy' ? 'default' : 'secondary'} className="capitalize">
                        {connection.status}
                      </Badge>
                      {connection.status === 'offline' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Remove dead connection"
                          title="Remove this dead connection"
                          onClick={() => void fetch(apiUrl(`/backend/agents/connections/${connection.id}`), { method: 'DELETE', headers: apiAuthHeaders() })}
                        >
                          <X />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </AgentProfileSection>
          )}
        </div>
      </div>
    </div>
  );
}

function normalizeStringList(value: unknown): string[] {
  const out: string[] = [];
  const add = (item: unknown) => {
    const text = String(item || '').trim();
    if (text) out.push(text);
  };
  const objectToken = (input: Record<string, unknown>) => {
    for (const key of ['label', 'name', 'id', 'type']) {
      const token = input[key];
      if (typeof token === 'string' && token.trim()) return token.trim();
    }
    return '';
  };
  if (Array.isArray(value)) {
    value.forEach(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) add(objectToken(item as Record<string, unknown>));
      else add(item);
    });
    return Array.from(new Set(out));
  }
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  if (value && typeof value === 'object') {
    add(objectToken(value as Record<string, unknown>));
    return Array.from(new Set(out));
  }
  return [];
}

function AgentProfileSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="agent-profile-card rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function AgentProfileTextSection({ title, value, tall = false }: { title: string; value: string; tall?: boolean }) {
  // Soul, system prompt, instructions and description are markdown documents,
  // and this rendered them pre-wrapped, so headings and lists arrived as
  // literal # and -. Same fix as the agent DETAIL pane in
  // AgentsWindowContent — both surfaces show the same four fields, and letting
  // one render markdown while the other shows source is how they drift.
  // MarkdownContent builds its own elements and never injects HTML, which
  // matters because an agent writes its own soul.
  return (
    <section className="agent-profile-card rounded-lg border bg-muted/30 p-3">
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</div>
      {/* min-w-0: .chat-markdown is a grid, and grid children default to
          min-width:auto, so a fenced code block would widen this card rather
          than scroll inside it. */}
      <div className={`min-w-0 overflow-auto text-sm leading-relaxed ${tall ? 'max-h-48' : 'max-h-32'}`}>
        <MarkdownContent content={value} compact />
      </div>
    </section>
  );
}

function AgentProfileChipSection({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return (
    <section className="agent-profile-card rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</div>
      {items.length > 0 ? (
        <div className="agent-token-row flex flex-wrap gap-1.5">
          {items.map(item => (
            <Badge key={item} variant="secondary" className="agent-token-chip" title={item}>
              {item}
            </Badge>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{empty}</div>
      )}
    </section>
  );
}

function AgentProfileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="agent-profile-stat min-w-0 rounded-lg border bg-muted/30 p-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold" title={value}>{value}</div>
    </div>
  );
}

function AgentProfileField({ label, value, title }: { label: string; value: string; title?: string }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border/60 pb-2 last:border-b-0">
      <span className="shrink-0 font-semibold text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium" title={title || value}>{value}</span>
    </div>
  );
}

function formatRunMode(value?: WorkspaceAgent['run_mode']) {
  return value === 'daemon' ? 'Daemon' : 'Built-in';
}

function formatPermissionMode(value?: WorkspaceAgent['permission_mode']) {
  if (value === 'accept_edits') return 'Accept edits';
  if (value === 'yolo') return 'YOLO';
  return 'Default';
}

function shortId(value?: string | null) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 13) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function formatDateTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function agentConnectionMetadataRows(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata || typeof metadata !== 'object') return [];
  return Object.entries(metadata)
    .map(([key, value]) => ({ label: humanizeMetadataKey(key), value: metadataValueText(value) }))
    .filter(row => row.value)
    .slice(0, 8);
}

function metadataValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  try {
    const json = JSON.stringify(value);
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    return String(value);
  }
}

function humanizeMetadataKey(value: string) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function FileTreeSection({
  title,
  detail,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  detail?: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="file-tree-section">
      <button
        type="button"
        className="file-tree-heading w-full cursor-pointer bg-transparent"
        title={detail || title}
        onClick={() => setOpen(v => !v)}
      >
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-150', !open && '-rotate-90')} />
        <Folder className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        <span className="file-tree-count">{count}</span>
      </button>
      {open && detail && <div className="file-tree-root truncate">{detail}</div>}
      {open && <div className="file-tree-children">{children}</div>}
    </section>
  );
}

function FileTreeDirSection({
  name,
  count,
  children,
}: {
  name: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="file-tree-section">
      <button
        type="button"
        className="file-tree-heading w-full cursor-pointer bg-transparent"
        onClick={() => setOpen(v => !v)}
      >
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-150', !open && '-rotate-90')} />
        <FolderOpen className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
        <span className="file-tree-count">{count}</span>
      </button>
      {open && <div className="file-tree-children">{children}</div>}
    </div>
  );
}

function applyMessageOverrides(messages: ChatMessage[], overrides: MessageOverrides): ChatMessage[] {
  return messages
    .map(message => ({ ...message, ...overrides[message.id] }))
    .filter(message => !overrides[message.id]?.deleted);
}

function normalizeChannelSessionMeta(meta: ChannelSessionMeta): ChannelSessionMeta {
  return {
    ...meta,
    folder: meta.folder ?? null,
    description: meta.description ?? '',
    icon: normalizeChannelIcon(meta.icon),
    intent: meta.intent ?? '',
    conversation_mode: normalizeConversationMode(meta.conversation_mode),
    is_favorite: Boolean(meta.is_favorite),
    archived_at: meta.archived_at ?? null,
    participants: normalizeChannelParticipants(meta.participants),
  };
}

function normalizeChannelSessionUpdates(updates: Partial<ChannelSessionMeta>): Partial<ChannelSessionMeta> {
  if (!('participants' in updates)) return updates;
  return {
    ...updates,
    participants: normalizeChannelParticipants(updates.participants),
  };
}

function normalizeChannelParticipants(value: unknown): ChannelParticipant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const kind: ChannelParticipant['kind'] = record.kind === 'agent' ? 'agent' : 'user';
    const entityId = stringValue(kind === 'agent' ? record.agent_id : record.user_id) || stringValue(record.id);
    const id = entityId.includes(':') ? entityId : `${kind}:${entityId || crypto.randomUUID()}`;
    const name = stringValue(record.name) || (kind === 'agent' ? 'Agent' : 'Person');
    return [{
      id,
      name,
      kind,
      status: stringValue(record.status) || null,
      handle: stringValue(record.handle) || null,
      user_id: kind === 'user' ? (stringValue(record.user_id) || id.replace(/^user:/, '')) : null,
      agent_id: kind === 'agent' ? (stringValue(record.agent_id) || id.replace(/^agent:/, '')) : null,
      added_at: stringValue(record.added_at) || null,
      direct: Boolean(record.direct),
    }];
  });
}

function directAgentFromParticipants(participants: ChannelParticipant[]): ChannelParticipant | null {
  const agentParticipants = participants.filter(participant =>
    participant.kind === 'agent' && (participant.agent_id || participant.handle)
  );
  return agentParticipants.find(participant => participant.direct) || (agentParticipants.length === 1 ? agentParticipants[0] : null);
}

function normalizeAgentLookupKey(value?: string | null): string {
  return stringValue(value)
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

function agentMatchesLookupKey(agent: WorkspaceAgent, key?: string | null): boolean {
  const normalizedKey = normalizeAgentLookupKey(key);
  if (!normalizedKey) return false;
  return [
    agent.id,
    agent.handle,
    agent.name,
    agentHandle(agent),
  ].some(value => normalizeAgentLookupKey(value) === normalizedKey);
}

function participantMatchesLookupKey(participant: ChannelParticipant, key?: string | null): boolean {
  const normalizedKey = normalizeAgentLookupKey(key);
  if (!normalizedKey || participant.kind !== 'agent') return false;
  return [
    participant.id,
    participant.agent_id,
    participant.handle,
    participant.name,
    participant.id.replace(/^agent:/, ''),
  ].some(value => normalizeAgentLookupKey(value) === normalizedKey);
}

function addAvatarAlias(map: Map<string, string>, alias: string | null | undefined, avatar: string | null | undefined) {
  const normalized = normalizeAgentLookupKey(alias);
  const value = stringValue(avatar);
  if (normalized && value) map.set(normalized, value);
}

function addAccentAlias(map: Map<string, string>, alias: string | null | undefined, accent: string | null | undefined) {
  const normalized = normalizeAgentLookupKey(alias);
  const value = validAgentAccentColor(accent);
  if (normalized) map.set(normalized, value);
}

function buildAgentAvatarLookup(agents: WorkspaceAgent[], participants: ChannelParticipant[]) {
  const map = new Map<string, string>();
  agents.forEach(agent => {
    const avatar = agent.avatar || '';
    addAvatarAlias(map, agent.id, avatar);
    addAvatarAlias(map, `agent:${agent.id}`, avatar);
    addAvatarAlias(map, agent.name, avatar);
    addAvatarAlias(map, agent.handle, avatar);
    addAvatarAlias(map, agentHandle(agent), avatar);
  });
  participants.forEach(participant => {
    if (participant.kind !== 'agent') return;
    const agent = agents.find(item => participantMatchesLookupKey(participant, item.id) || agentMatchesLookupKey(item, participant.agent_id || participant.handle || participant.name));
    if (!agent?.avatar) return;
    addAvatarAlias(map, participant.id, agent.avatar);
    addAvatarAlias(map, participant.agent_id, agent.avatar);
    addAvatarAlias(map, participant.handle, agent.avatar);
    addAvatarAlias(map, participant.name, agent.avatar);
  });
  return map;
}

function resolveMessageAvatar(message: ChatMessage, lookup: Map<string, string>) {
  if (message.role === 'user' && message.sender_kind !== 'agent') return '';
  for (const key of [message.sender_id, message.sender_name, message.sender_id ? `agent:${message.sender_id}` : '']) {
    const avatar = lookup.get(normalizeAgentLookupKey(key));
    if (avatar) return avatar;
  }
  return '';
}

function buildAgentAccentLookup(agents: WorkspaceAgent[], participants: ChannelParticipant[]) {
  const map = new Map<string, string>();
  agents.forEach(agent => {
    const accent = agentAccentColor(agent);
    addAccentAlias(map, agent.id, accent);
    addAccentAlias(map, `agent:${agent.id}`, accent);
    addAccentAlias(map, agent.name, accent);
    addAccentAlias(map, agent.handle, accent);
    addAccentAlias(map, agentHandle(agent), accent);
  });
  participants.forEach(participant => {
    if (participant.kind !== 'agent') return;
    const agent = agents.find(item => participantMatchesLookupKey(participant, item.id) || agentMatchesLookupKey(item, participant.agent_id || participant.handle || participant.name));
    if (!agent) return;
    const accent = agentAccentColor(agent);
    addAccentAlias(map, participant.id, accent);
    addAccentAlias(map, participant.agent_id, accent);
    addAccentAlias(map, participant.handle, accent);
    addAccentAlias(map, participant.name, accent);
  });
  return map;
}

function resolveMessageAccent(message: ChatMessage, lookup: Map<string, string>) {
  if (message.sender_kind !== 'agent') return '';
  for (const key of [message.sender_id, message.sender_name, message.sender_id ? `agent:${message.sender_id}` : '']) {
    const accent = lookup.get(normalizeAgentLookupKey(key));
    if (accent) return accent;
  }
  return '';
}

function getAgentAvatarIcon(value?: string | null): LucideIcon | null {
  switch (normalizeAgentLookupKey(value)) {
    case 'icon:bot':
      return Bot;
    case 'icon:sparkles':
      return Sparkles;
    case 'icon:brain':
      return Brain;
    case 'icon:terminal':
      return Terminal;
    case 'icon:code':
      return Code2;
    case 'icon:command':
      return CommandIcon;
    case 'icon:wrench':
      return Wrench;
    case 'icon:database':
      return Database;
    case 'icon:shield':
      return ShieldCheck;
    case 'icon:rocket':
      return Rocket;
    case 'icon:globe':
      return Globe;
    case 'icon:monitor':
      return Monitor;
    default:
      return null;
  }
}

function connectionMatchesAgentProfile(
  connection: AgentConnection,
  agent: WorkspaceAgent | null,
  participant: ChannelParticipant | null,
  key?: string | null,
): boolean {
  const normalizedKey = normalizeAgentLookupKey(key);
  const agentId = agent?.id || participant?.agent_id || participant?.id.replace(/^agent:/, '') || null;
  const handle = agent?.handle || participant?.handle || null;
  if (agentId && connection.agent_id === agentId) return true;
  return [
    connection.handle,
    connection.name,
    handle,
  ].some(value => Boolean(normalizedKey && normalizeAgentLookupKey(value) === normalizedKey));
}

function withLiveParticipantStatus(
  participant: ChannelParticipant,
  agents: WorkspaceAgent[],
  agentConnections: AgentConnection[],
): DisplayParticipant {
  if (participant.kind !== 'agent') return participant;
  const agentId = participant.agent_id || participant.id.replace(/^agent:/, '');
  const normalizedHandle = stringValue(participant.handle).toLowerCase();
  const normalizedName = stringValue(participant.name).toLowerCase();
  const agent = agents.find(item => {
    if (item.id === agentId) return true;
    const handle = agentHandle(item).toLowerCase();
    const name = stringValue(item.name).toLowerCase();
    return Boolean((normalizedHandle && handle === normalizedHandle) || (normalizedName && name === normalizedName));
  });
  const resolvedAgentId = agent?.id || agentId;
  const connection = agentConnections.find(item => {
    if (item.status === 'offline') return false;
    if (item.agent_id && item.agent_id === resolvedAgentId) return true;
    const handle = stringValue(item.handle).toLowerCase();
    const name = stringValue(item.name).toLowerCase();
    return Boolean((normalizedHandle && handle === normalizedHandle) || (normalizedName && name === normalizedName));
  });
  const handle = participant.handle || (agent ? agentHandle(agent) : null);
  return {
    ...participant,
    id: resolvedAgentId ? `agent:${resolvedAgentId}` : participant.id,
    name: participant.name || agent?.name || 'Agent',
    handle,
    agent_id: resolvedAgentId || participant.agent_id || null,
    status: connection?.status || participant.status || agent?.run_mode || 'built-in',
    connected: Boolean(connection),
  };
}

function buildParticipantCandidates(
  presenceUsers: ChannelPresenceUser[],
  agents: WorkspaceAgent[],
  agentConnections: AgentConnection[],
  persistedParticipants: ChannelParticipant[],
): ParticipantCandidate[] {
  const map = new Map<string, ParticipantCandidate>();

  persistedParticipants.forEach(participant => {
    const live = withLiveParticipantStatus(participant, agents, agentConnections);
    map.set(live.id, {
      ...live,
      subtitle: live.kind === 'agent'
        ? [live.handle ? `@${live.handle}` : null, live.status].filter(Boolean).join(' - ')
        : live.status || undefined,
    });
  });

  presenceUsers.forEach(participant => {
    const kind: ChannelParticipant['kind'] = participant.kind === 'agent' ? 'agent' : 'user';
    const id = kind === 'agent' ? `agent:${participant.id}` : `user:${participant.id}`;
    map.set(id, {
      id,
      name: participant.isCurrentUser ? 'You' : participant.name,
      kind,
      status: participant.status || null,
      user_id: kind === 'user' ? participant.id : null,
      agent_id: kind === 'agent' ? participant.id : null,
      subtitle: participant.status || undefined,
      connected: Boolean(participant.status && participant.status !== 'offline'),
    });
  });

  agentConnections.forEach(connection => {
    if (connection.status === 'offline') return;
    const id = connection.agent_id ? `agent:${connection.agent_id}` : `agent-connection:${connection.id}`;
    const handle = connection.handle || normalizeAgentLookupKey(connection.name);
    map.set(id, {
      id,
      name: connection.name || handle || 'Remote agent',
      kind: 'agent',
      agent_id: connection.agent_id || null,
      user_id: null,
      handle,
      status: connection.status,
      subtitle: [`@${handle}`, connection.host || null, connection.cwd || null].filter(Boolean).join(' - '),
      connected: true,
    });
  });

  agents.forEach(agent => {
    const connection = agentConnections.find(item => item.agent_id === agent.id && item.status !== 'offline');
    const handle = agentHandle(agent);
    map.set(`agent:${agent.id}`, {
      id: `agent:${agent.id}`,
      name: agent.name,
      kind: 'agent',
      agent_id: agent.id,
      user_id: null,
      handle,
      status: connection?.status || agent.run_mode || 'built-in',
      subtitle: [`@${handle}`, connection?.status || agent.run_mode || 'built-in'].filter(Boolean).join(' - '),
      connected: Boolean(connection),
    });
  });

  return dedupeParticipantCandidates(Array.from(map.values())).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'user' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function dedupeParticipantCandidates(candidates: ParticipantCandidate[]): ParticipantCandidate[] {
  const byKey = new Map<string, ParticipantCandidate>();
  const aliases = new Map<string, string>();
  candidates.forEach(candidate => {
    let key = participantCandidateKey(candidate);
    for (const alias of participantCandidateAliases(candidate)) {
      const existingKey = aliases.get(alias);
      if (existingKey) {
        key = existingKey;
        break;
      }
    }
    const previous = byKey.get(key);
    if (!previous || participantCandidateRank(candidate) > participantCandidateRank(previous)) {
      byKey.set(key, {
        ...previous,
        ...candidate,
        agent_id: previous?.agent_id || candidate.agent_id || null,
        user_id: previous?.user_id || candidate.user_id || null,
        handle: previous?.handle || candidate.handle || null,
        status: candidate.status || previous?.status || null,
        subtitle: candidate.subtitle || previous?.subtitle,
        connected: Boolean(candidate.connected || previous?.connected),
      });
      participantCandidateAliases(byKey.get(key)!).forEach(alias => aliases.set(alias, key));
    } else {
      participantCandidateAliases(previous).forEach(alias => aliases.set(alias, key));
    }
  });
  return Array.from(byKey.values());
}

function participantCandidateAliases(candidate: ParticipantCandidate): string[] {
  const aliases = new Set<string>();
  aliases.add(participantCandidateKey(candidate));
  if (candidate.kind === 'user') {
    if (candidate.user_id) aliases.add(`user-id:${candidate.user_id}`);
    const name = stringValue(candidate.name).toLowerCase();
    if (name === 'you') aliases.add('user:self');
    return Array.from(aliases);
  }
  if (candidate.agent_id) aliases.add(`agent-id:${candidate.agent_id}`);
  const handle = stringValue(candidate.handle).toLowerCase();
  if (handle) aliases.add(`agent-handle:${handle}`);
  const name = stringValue(candidate.name).toLowerCase();
  if (name) aliases.add(`agent-name:${name}`);
  return Array.from(aliases);
}

function participantCandidateKey(candidate: ParticipantCandidate): string {
  if (candidate.kind === 'user') {
    return candidate.user_id ? `user:${candidate.user_id}` : candidate.id;
  }
  if (candidate.agent_id) return `agent-id:${candidate.agent_id}`;
  const handle = stringValue(candidate.handle).toLowerCase();
  if (handle) return `agent:${handle}`;
  const name = stringValue(candidate.name).toLowerCase();
  return name ? `agent-name:${name}` : candidate.id;
}

function participantCandidateRank(candidate: ParticipantCandidate): number {
  let rank = 0;
  if (candidate.connected) rank += 8;
  if (candidate.agent_id || candidate.user_id) rank += 4;
  if (candidate.handle) rank += 2;
  if (candidate.subtitle) rank += 1;
  return rank;
}

function buildCatchUpSummary(messages: ChatMessage[], channelTitle: string) {
  const meaningful = messages
    .filter(message => safeMessageText(message.content).trim())
    .slice(-12);
  if (meaningful.length === 0) return `Nothing has happened yet in #${channelTitle || 'general'}.`;
  const userMessages = meaningful.filter(message => message.role === 'user').length;
  const agentMessages = meaningful.filter(message => message.role === 'assistant').length;
  const mentions = meaningful
    .flatMap(message => Array.from(safeMessageText(message.content).matchAll(/@[a-zA-Z0-9_.-]+/g)).map(match => match[0]))
    .filter((mention, index, all) => all.indexOf(mention) === index)
    .slice(0, 3);
  const last = meaningful[meaningful.length - 1];
  const mentionText = mentions.length > 0 ? ` Mentions included ${mentions.join(', ')}.` : '';
  return `Recent activity in #${channelTitle || 'general'} includes ${userMessages} user message${userMessages === 1 ? '' : 's'} and ${agentMessages} assistant or agent response${agentMessages === 1 ? '' : 's'}.${mentionText} Latest: ${safeMessageText(last.content).slice(0, 180)}`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeMessageText(value: unknown): string {
  if (typeof value === 'string') return value === '[object Object]' ? 'Message content is unavailable.' : value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map(item => safeMessageText(item))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'message', 'content', 'response', 'output', 'result', 'error', 'data'] as const) {
      const text = safeMessageText(record[key]);
      if (text) return text;
    }
    try {
      const json = JSON.stringify(value);
      return json && json !== '{}' ? json : 'Message content is unavailable.';
    } catch {
      return 'Message content is unavailable.';
    }
  }
  return String(value);
}

// One row in the `/` command menu. Built-ins show a "runs" badge (they execute);
// everything else shows "insert" (drops a text token). `indented` nudges skill
// sub-commands under their parent to make the parent→child relationship visible.
function SlashRow({
  item,
  badge,
  indented,
  onSelect,
  children,
}: {
  item: SlashItem;
  badge: string;
  indented?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <CommandItem
      value={item.id}
      // py-2.5 for the same reason as the mention rows: title plus
      // description is two lines and needs more than one line's padding.
      className={`rounded-lg px-2 py-2.5${indented ? ' ml-3' : ''}`}
      onSelect={onSelect}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        {children}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">/{item.name}</span>
        {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
      </span>
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{badge}</span>
    </CommandItem>
  );
}
