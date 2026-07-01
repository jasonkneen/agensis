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
  GitCommitHorizontal,
  Globe,
  Hash,
  HardDrive,
  Layers,
  Link2,
  Loader2,
  MessageSquare,
  Mic,
  Monitor,
  Palette,
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
  Upload,
  UserPlus,
  Users,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { ChatThreadPanel } from '../chat/ChatThreadPanel';
import { SubThreadPanel } from '../chat/SubThreadPanel';
import { ThreadWidgetRail } from './ThreadWidgetRail';
import { ChatArtifact, extractHtmlArtifact } from '../chat/ChatArtifact';
import { MarkdownContent } from '../chat/MarkdownContent';
import { apiAuthHeaders, apiUrl, backendClient, type SystemCapabilities } from '../../lib/backendClient';
import { EMPTY_STREAM_RESPONSE } from '../../lib/chatStream';
import type {
  CanvasGroup,
  CanvasObject,
  ChannelParticipant,
  ChatSession,
  Document,
  MemoryFact,
  Message as ChatMessage,
  AgentConnection,
  UploadedFile,
  WorkspaceAgent,
} from '../../types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { CreateTaskInput } from '../../hooks/useTasks';
import { isImageAvatar, isPetSpritesheetAvatar, renderablePetAssetUrl } from '../../lib/openpets';
import { agentAccentColor, agentAccentStyle, agentHandle, validAgentAccentColor } from '../../lib/agentAccent';
import { cn } from '@/lib/utils';

interface ChatWindowContentProps {
  messages: ChatMessage[];
  topLevelMessages?: ChatMessage[];
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
  onSendMessage: (content: string, model: string, facts?: MemoryFact[], docs?: Document[]) => void;
  onOpenThread?: (messageId: string) => void;
  onCloseThread?: () => void;
  onSendThreadReply?: (content: string, model: string) => void;
  readOnly?: boolean;
  channelTitle?: string;
  workspaceId?: string | null;
  uploadedFiles?: UploadedFile[];
  onUploadFiles?: (files: File[]) => Promise<UploadedFile[]>;
  onCreateTask?: (input: CreateTaskInput) => void | Promise<unknown>;
  systemCapabilities?: SystemCapabilities | null;
  contextControls?: React.ReactNode;
  isDirectMessage?: boolean;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  onUpdateAgent?: (id: string, updates: Partial<WorkspaceAgent>) => void | Promise<unknown>;
  subThreadsByMessage?: Record<string, ChatSession[]>;
  activeSubThread?: ChatSession | null;
  subThreadMessages?: ChatMessage[];
  subThreadStreaming?: boolean;
  onOpenSubThread?: (session: ChatSession) => void;
  onCloseSubThread?: () => void;
  onCreateSubThread?: (messageId: string, agent: WorkspaceAgent) => void;
  onSendSubThreadMessage?: (content: string) => void;
}

type ChannelPresenceUser = {
  id: string;
  name: string;
  kind?: 'user' | 'agent';
  status?: string;
  isCurrentUser?: boolean;
};

type ProjectFileEntry = {
  path: string;
  name: string;
  size: number;
  mtime: string;
  kind: 'file';
  sourceId?: string;
  sourceKind?: 'workspace' | 'agent';
  sourceLabel?: string;
  sourceRoot?: string;
  agentId?: string | null;
  connectionId?: string | null;
  handle?: string;
  status?: string;
};

type ProjectFileSource = {
  id: string;
  kind: 'workspace' | 'agent';
  label: string;
  root: string;
  files: ProjectFileEntry[];
  agent_id?: string | null;
  connection_id?: string | null;
  handle?: string;
  host?: string;
  status?: string;
};

type LinkedFile = {
  id: string;
  kind: 'uploaded' | 'project';
  name: string;
  path: string;
  sourceLabel: string;
  size: number;
};

type ChannelSessionMeta = Pick<ChatSession, 'id' | 'title' | 'folder' | 'is_favorite' | 'archived_at' | 'participants' | 'conversation_mode'>;

const CHANNEL_META_COLUMNS = '*';

type DisplayParticipant = ChannelParticipant & {
  connected?: boolean;
};

type ParticipantCandidate = ChannelParticipant & {
  subtitle?: string;
  connected?: boolean;
};

type MessageOverrides = Record<string, Partial<ChatMessage> & { deleted?: boolean }>;
type ChatSidePanel = 'thread' | 'files' | 'pins' | 'profile' | 'sub-thread';

// A message is a live "thinking" placeholder while the daemon is still working:
// an agent/assistant row whose body is the bare "Thinking …" marker (the daemon
// updates this same row in place once real content streams in). This is the
// session-scoped busy signal — unlike a global connection status, it can't leak
// into other chat windows, and it clears itself the moment real content arrives.
const THINKING_PLACEHOLDER_RE = /^thinking[\s\d.ms]*$/i;
function isThinkingPlaceholderMessage(
  msg: Pick<ChatMessage, 'sender_kind' | 'role' | 'content'>,
): boolean {
  if (!(msg.sender_kind === 'agent' || msg.role === 'assistant')) return false;
  return THINKING_PLACEHOLDER_RE.test(safeMessageText(msg.content).trim());
}

export function ChatWindowContent({
  messages,
  topLevelMessages,
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
  readOnly = false,
  channelTitle = 'general',
  workspaceId = null,
  uploadedFiles = [],
  onUploadFiles,
  onCreateTask,
  systemCapabilities = null,
  contextControls,
  isDirectMessage: isDirectMessageProp = false,
  onUpdateAgent,
  subThreadsByMessage = {},
  activeSubThread,
  subThreadMessages = [],
  subThreadStreaming = false,
  onOpenSubThread,
  onCloseSubThread,
  onCreateSubThread,
  onSendSubThreadMessage,
}: ChatWindowContentProps) {
  const [subThreadPickerMessageId, setSubThreadPickerMessageId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [linkedGroups, setLinkedGroups] = useState<CanvasGroup[]>([]);
  const [linkedFiles, setLinkedFiles] = useState<LinkedFile[]>([]);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [addContextOpen, setAddContextOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [docPickerQuery, setDocPickerQuery] = useState('');
  const [groupPickerQuery, setGroupPickerQuery] = useState('');
  const [atStartPos, setAtStartPos] = useState(-1);
  const [hashStartPos, setHashStartPos] = useState(-1);
  const [autoScroll, setAutoScroll] = useState(true);
  const [sidePanel, setSidePanel] = useState<ChatSidePanel | null>(null);
  const [widgetsCollapsed, setWidgetsCollapsed] = useState(false);
  const [profileAgentKey, setProfileAgentKey] = useState<string | null>(null);
  const [catchUpOpen, setCatchUpOpen] = useState(false);
  const [addParticipantsOpen, setAddParticipantsOpen] = useState(false);
  const [channelMeta, setChannelMeta] = useState<ChannelSessionMeta | null>(null);
  const [channelActionStatus, setChannelActionStatus] = useState('');
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<Set<string>>(() => new Set());
  const [messageOverrides, setMessageOverrides] = useState<MessageOverrides>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [messageActionBusy, setMessageActionBusy] = useState<string | null>(null);
  const [deleteMessageTarget, setDeleteMessageTarget] = useState<ChatMessage | null>(null);
  const [panelWidth, setPanelWidth] = useState(360);
  const [projectFiles, setProjectFiles] = useState<ProjectFileEntry[]>([]);
  const [projectRoot, setProjectRoot] = useState('');
  const [projectFileSources, setProjectFileSources] = useState<ProjectFileSource[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const autoOpenedProfileForRef = useRef<string | null>(null);

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

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    let content = input.trim();
    if (linkedFiles.length > 0) {
      content = `${buildFileContext(linkedFiles)}\n\n${content}`;
    }
    if (linkedGroups.length > 0) {
      content = `${buildGroupContext(linkedGroups)}\n\n${content}`;
    }
    onSendMessage(content, 'auto', memoryFacts, linkedDocs.length > 0 ? linkedDocs : undefined);
    setInput('');
    setLinkedDocs([]);
    setLinkedGroups([]);
    setLinkedFiles([]);
    inputRef.current?.focus();
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

  const handleAgentSelect = (agent: WorkspaceAgent) => {
    const handle = agentHandle(agent);
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
    if (showDocPicker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowDocPicker(false);
        return;
      }
      // Tab or Enter completes the top item (agents render above docs) and closes the @ menu.
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (filteredAgents.length > 0) {
          e.preventDefault();
          handleAgentSelect(filteredAgents[0]);
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

    const cursor = e.target.selectionStart || 0;
    if (value[cursor - 1] === '@' && !showDocPicker) {
      setShowDocPicker(true);
      setShowGroupPicker(false);
      setDocPickerQuery('');
      setAtStartPos(cursor - 1);
    }
    if (value[cursor - 1] === '#' && !showGroupPicker) {
      setShowGroupPicker(true);
      setShowDocPicker(false);
      setGroupPickerQuery('');
      setHashStartPos(cursor - 1);
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
  const inferredSessionId = useMemo(() => (
    messages[0]?.session_id ||
    topLevelMessages?.[0]?.session_id ||
    threadMessages[0]?.session_id ||
    null
  ), [messages, threadMessages, topLevelMessages]);
  // Floating thread widgets overlay the message list's right gutter. Reserve
  // matching right padding on the message column (only while expanded) so a
  // card never sits on top of message text.
  const showWidgetRail = !readOnly && !!inferredSessionId && !!workspaceId;
  const reserveWidgetGutter = showWidgetRail && !widgetsCollapsed;
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
  const thinkingAgents = useMemo(() => {
    const names: string[] = [];
    for (const m of displayMessages) {
      if (!isThinkingPlaceholderMessage(m)) continue;
      const name = (m.sender_name || directAgent?.name || 'Agent').trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }, [displayMessages, directAgent]);
  const isDirectMessage = isDirectMessageProp || Boolean(directAgent) || channelMeta?.folder === 'Direct messages';
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

  useEffect(() => {
    if (!isDirectMessage || !directProfileKey || sidePanel !== null) return;
    if (autoOpenedProfileForRef.current === directProfileKey) return;
    autoOpenedProfileForRef.current = directProfileKey;
    setProfileAgentKey(directProfileKey);
    setSidePanel('profile');
  }, [directProfileKey, isDirectMessage, sidePanel]);

  const participantCandidates = useMemo(
    () => buildParticipantCandidates(presenceUsers, agents, agentConnections, persistedParticipants),
    [agentConnections, agents, persistedParticipants, presenceUsers],
  );

  const participants = useMemo(() => {
    const map = new Map<string, DisplayParticipant>();
    persistedParticipants.forEach(participant => {
      map.set(participant.id, withLiveParticipantStatus(participant, agents, agentConnections));
    });
    presenceUsers.forEach(participant => {
      const id = participant.kind === 'agent' ? `agent:${participant.id}` : `user:${participant.id}`;
      map.set(id, {
        id,
        name: participant.isCurrentUser ? 'You' : participant.name,
        kind: participant.kind === 'agent' ? 'agent' : 'user',
        status: participant.status,
        user_id: participant.kind === 'agent' ? null : participant.id,
        agent_id: participant.kind === 'agent' ? participant.id : null,
        connected: Boolean(participant.status && participant.status !== 'offline'),
      });
    });
    return Array.from(map.values()).slice(0, 6);
  }, [agentConnections, agents, persistedParticipants, presenceUsers]);

  const agentAvatarLookup = useMemo(
    () => buildAgentAvatarLookup(agents, persistedParticipants),
    [agents, persistedParticipants],
  );
  const agentAccentLookup = useMemo(
    () => buildAgentAccentLookup(agents, persistedParticipants),
    [agents, persistedParticipants],
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
    return next;
  };

  const conversationMode = channelMeta?.conversation_mode ?? 'mention';
  const autoInterject = conversationMode === 'auto';

  const handleToggleAutoInterject = async () => {
    const next: ChatSession['conversation_mode'] = autoInterject ? 'mention' : 'auto';
    // Optimistically reflect the new mode.
    setChannelMeta(prev => (prev ? { ...prev, conversation_mode: next } : prev));
    const saved = await persistChannelUpdates({ conversation_mode: next });
    if (!saved) {
      // Revert on failure.
      setChannelMeta(prev => (prev ? { ...prev, conversation_mode: conversationMode } : prev));
    }
  };

  const handleOpenParticipantsDialog = () => {
    const selected = new Set<string>();
    const saved = persistedParticipants.length > 0 ? persistedParticipants : participants;
    saved.forEach(participant => selected.add(participant.id));
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

  const handleSaveParticipants = async () => {
    const selected = participantCandidates
      .filter(participant => selectedParticipantIds.has(participant.id))
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
    setMessageActionBusy(null);
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
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('chat-msg-jump-highlight');
    window.setTimeout(() => el.classList.remove('chat-msg-jump-highlight'), 1600);
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
  const closeSidePanel = () => {
    if (sidePanel === 'thread') onCloseThread?.();
    if (sidePanel === 'sub-thread') onCloseSubThread?.();
    setSidePanel(null);
  };
  const beginPanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.min(680, Math.max(280, startWidth + (startX - moveEvent.clientX)));
      setPanelWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  return (
    <div className="channel-shell flex h-full min-w-0 overflow-hidden text-card-foreground">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="channel-header relative z-20 shrink-0 border-b border-border">
          <div className="flex h-11 min-w-0 items-center gap-1.5 overflow-hidden px-3">
            {isDirectMessage ? (
              <Button
                type="button"
                variant={sidePanel === 'profile' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 px-2"
                onClick={() => openAgentProfilePanel()}
              >
                <Bot data-icon="inline-start" />
                <span className="max-w-48 truncate font-semibold">{directAgent?.name || channelTitle || 'Direct message'}</span>
              </Button>
            ) : (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="h-8 px-2" aria-label="Open channel menu">
                      <Hash data-icon="inline-start" />
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
                <Button type="button" variant="ghost" size="sm" className="h-8 px-2">
                  <Link2 data-icon="inline-start" />
                  Connect
                </Button>
              </>
            )}
            <Button type="button" variant={sidePanel === null || sidePanel === 'thread' ? 'secondary' : 'ghost'} size="sm" className="h-8 px-2" onClick={() => setSidePanel(null)}>
              <MessageSquare data-icon="inline-start" />
              Messages
            </Button>
            <Button type="button" variant={sidePanel === 'files' ? 'secondary' : 'ghost'} size="sm" className="h-8 px-2" onClick={() => setSidePanel('files')}>
              <Paperclip data-icon="inline-start" />
              Files
            </Button>
            <Button type="button" variant={sidePanel === 'pins' ? 'secondary' : 'ghost'} size="sm" className="h-8 px-2" onClick={() => setSidePanel('pins')}>
              <Pin data-icon="inline-start" />
              Pins
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={clearView} title="Clear this view — messages stay; scroll up to restore">
              <Eraser data-icon="inline-start" />
              Clear
            </Button>
            <div className="min-w-2 flex-1" />
            {!isDirectMessage && contextControls && (
              <div className="flex min-w-0 max-w-[40vw] shrink overflow-x-auto text-xs text-muted-foreground">
                {contextControls}
              </div>
            )}
            {!isDirectMessage && (
              <>
                <Button
                  type="button"
                  variant={autoInterject ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 px-2"
                  aria-pressed={autoInterject}
                  title={autoInterject ? 'Auto: agents chime in automatically when relevant' : 'Mentions only: agents reply when @mentioned'}
                  onClick={() => { void handleToggleAutoInterject(); }}
                >
                  <Zap data-icon="inline-start" />
                  Auto
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => setCatchUpOpen(true)}>
                  <RotateCcw data-icon="inline-start" />
                  Catch up
                </Button>
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
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
        <MessageScrollerProvider autoScroll={autoScroll}>
          <MessageScroller className="channel-message-surface flex-1">
            <MessageScrollerViewport onScroll={handleScrollerScroll}>
              <MessageScrollerContent className={cn('min-h-full gap-0 py-2 transition-[padding]', reserveWidgetGutter && 'pr-[312px]')}>
                {clearedAt && hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={restoreView}
                    className="mx-auto my-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition hover:text-foreground"
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
                    {shownMessages.map((msg, idx) => (
                      <MessageScrollerItem key={msg.id} id={`chat-msg-${msg.id}`} scrollAnchor={idx === shownMessages.length - 1}>
                        <ChatMessageBubble
                          msg={msg}
                          avatar={resolveMessageAvatar(msg, agentAvatarLookup)}
                          accent={resolveMessageAccent(msg, agentAccentLookup)}
                          isStreaming={streaming && idx === shownMessages.length - 1 && msg.role === 'assistant'}
                          replyCount={threadReplyCounts[msg.id]}
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
                          onAgentProfile={openAgentProfilePanel}
                          subThreads={subThreadsByMessage[msg.id]}
                          onOpenSubThread={openSubThreadPanel}
                          onCreateSubThread={onCreateSubThread ? () => setSubThreadPickerMessageId(msg.id) : undefined}
                        />
                      </MessageScrollerItem>
                    ))}
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            {showWidgetRail && (
              <ThreadWidgetRail
                workspaceId={workspaceId}
                sessionId={inferredSessionId}
                collapsed={widgetsCollapsed}
                onToggleCollapsed={() => setWidgetsCollapsed(v => !v)}
                onJumpToMessage={handleJumpToMessage}
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
          <div className="composer-status flex items-center gap-2 border-t border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="composer-status-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
            <span className="truncate">
              <span className="font-medium text-foreground">{thinkingAgents.join(', ')}</span>{' '}
              {thinkingAgents.length === 1 ? 'is thinking…' : 'are thinking…'}
            </span>
          </div>
        )}
        <div className="channel-composer border-t border-border p-2">
          {(linkedDocs.length > 0 || linkedGroups.length > 0 || linkedFiles.length > 0) && (
            <AttachmentGroup className="mb-2">
              {linkedFiles.map(file => (
                <Attachment key={file.id} state="done" size="xs">
                  <AttachmentMedia variant="icon">
                    {file.kind === 'uploaded' ? <Paperclip /> : <HardDrive />}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{file.name}</AttachmentTitle>
                    {file.kind !== 'uploaded' && file.sourceLabel && (
                      <AttachmentDescription>{file.sourceLabel}</AttachmentDescription>
                    )}
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction
                      aria-label={`Remove ${file.name}`}
                      onClick={() => setLinkedFiles(prev => prev.filter(item => item.id !== file.id))}
                    >
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
              {linkedDocs.map(doc => (
                <Attachment key={doc.id} state="done" size="xs">
                  <AttachmentMedia variant="icon">
                    <FileText />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{doc.title}</AttachmentTitle>
                    <AttachmentDescription>Document context</AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction
                      aria-label={`Remove ${doc.title}`}
                      onClick={() => setLinkedDocs(prev => prev.filter(d => d.id !== doc.id))}
                    >
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
              {linkedGroups.map(group => (
                <Attachment key={group.id} state="done" size="xs">
                  <AttachmentMedia variant="icon">
                    <Layers />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{group.name}</AttachmentTitle>
                    <AttachmentDescription>Canvas group context</AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction
                      aria-label={`Remove ${group.name}`}
                      onClick={() => setLinkedGroups(prev => prev.filter(g => g.id !== group.id))}
                    >
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
            </AttachmentGroup>
          )}

          <div className="relative" onDrop={handleComposerDrop} onDragOver={handleComposerDragOver}>
            {showDocPicker && (
              <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-[min(320px,55vh)] overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                <CommandList className="max-h-[min(240px,40vh)]">
                  <CommandEmpty>No agents or documents found.</CommandEmpty>
                  {filteredAgents.length > 0 && (
                    <CommandGroup heading="Agents">
                      {filteredAgents.map(agent => (
                        <CommandItem
                          key={agent.id}
                          value={`${agent.name} ${agentHandle(agent)}`}
                          className="rounded-lg px-2 py-1.5"
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

            <InputGroup className="h-auto flex-col items-stretch">
              <InputGroupTextarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handleComposerPaste}
                placeholder={isDirectMessage
                  ? `Message ${directAgent?.name || channelTitle || 'agent'}...`
                  : `Post in #${channelTitle || 'general'}... @agent, @ documents, # canvas groups`}
                disabled={streaming}
                rows={1}
                className="max-h-28 min-h-12 px-3 py-2 text-sm leading-relaxed"
                onInput={e => {
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
                }}
              />
              <InputGroupAddon align="block-end" className="min-h-9 justify-between gap-2 border-t px-2 py-1.5">
                <div className="flex items-center gap-1">
                  <Popover open={addContextOpen} onOpenChange={(open) => {
                    setAddContextOpen(open);
                    if (open) {
                      setShowDocPicker(false);
                      setShowGroupPicker(false);
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
                      className="z-[12060] w-[min(460px,calc(100vw-32px))] max-h-[min(560px,calc(100vh-96px))] gap-0 overflow-hidden p-0"
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
          className="channel-side-panel relative flex h-full shrink-0 flex-col border-l border-border text-card-foreground"
          style={{ width: panelWidth }}
        >
          <div
            className="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize"
            onPointerDown={beginPanelResize}
            aria-hidden
          />
          {sidePanel === 'profile' ? (
            <AgentProfileSidePanel
              agent={profileAgent}
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
              onAgentProfile={openAgentProfilePanel}
              onClose={closeSidePanel}
              embedded
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
            />
          ) : (
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
          )}
        </aside>
      )}


      <Dialog open={catchUpOpen} onOpenChange={setCatchUpOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Catch up on #{channelTitle || 'general'}</DialogTitle>
            <DialogDescription>Channel summary based on visible posts.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-foreground">{catchUpSummary}</p>
            <div className="text-xs text-muted-foreground">May miss nuance. Refresh after new activity.</div>
          </div>
        </DialogContent>
      </Dialog>

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
                      const selected = selectedParticipantIds.has(participant.id);
                      return (
                        <button
                          key={participant.id}
                          type="button"
                          className={`flex w-full min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                            selected ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-muted/50'
                          }`}
                          onClick={() => handleToggleParticipant(participant.id)}
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
            <DialogTitle>Start a sub-thread with…</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1 py-2">
            {agents.filter(a => a.enabled !== false).map(agent => (
              <button
                key={agent.id}
                type="button"
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-muted"
                onClick={() => {
                  if (subThreadPickerMessageId && onCreateSubThread) {
                    onCreateSubThread(subThreadPickerMessageId, agent);
                  }
                  setSubThreadPickerMessageId(null);
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
    </div>
  );
}

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

// Live "Thinking Ns" timer for agent placeholders — ticks locally from the
// placeholder's created_at so it counts up even before any streamed content
// (or realtime update) arrives.
function ThinkingIndicator({ startedAt }: { startedAt?: string | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = startedAt ? new Date(startedAt).getTime() : Date.now();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      <Spinner className="size-3" />
      Thinking {elapsed}s
    </span>
  );
}

function ChatMessageBubble({
  msg,
  avatar,
  accent,
  isStreaming,
  replyCount,
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
  onAgentProfile,
  subThreads,
  onOpenSubThread,
  onCreateSubThread,
}: {
  msg: ChatMessage;
  avatar?: string;
  accent?: string;
  isStreaming?: boolean;
  replyCount?: number;
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
  onAgentProfile?: (agentIdOrHandle: string) => void;
  subThreads?: ChatSession[];
  onOpenSubThread?: (session: ChatSession) => void;
  onCreateSubThread?: () => void;
}) {
  const isUser = msg.role === 'user';
  const rawContent = safeMessageText(msg.content);
  const artifact = rawContent ? extractHtmlArtifact(rawContent) : null;
  const displayContent = artifact ? artifact.remainingText : rawContent;
  const isThinkingPlaceholder = isThinkingPlaceholderMessage(msg);
  const unavailableMessage = msg.role === 'assistant' ? EMPTY_STREAM_RESPONSE : 'Message content is unavailable.';
  const senderName = msg.sender_name || (isUser ? 'You' : 'Assistant');
  const initials = isUser ? 'You'.slice(0, 2).toUpperCase() : (senderName.slice(0, 2).toUpperCase() || 'AI');
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

  return (
    <div
      className="chat-message-row group relative flex w-full min-w-0 gap-3 px-4 py-2 pr-20 hover:bg-muted/40"
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
            {isThinkingPlaceholder ? (
              <ThinkingIndicator startedAt={msg.created_at} />
            ) : displayContent ? (
              <MarkdownContent content={displayContent} streaming={isStreaming} onMentionClick={onAgentProfile} />
            ) : isStreaming ? (
              <ThinkingIndicator startedAt={msg.created_at} />
            ) : (
              <span className="text-muted-foreground">{unavailableMessage}</span>
            )}
            {artifact && <ChatArtifact artifact={artifact} />}
          </div>
        )}
        {isStreaming && msg.content && (
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Streaming
          </div>
        )}
        {replyCount && onOpenThread ? (
          <button
            type="button"
            className="mt-1 inline-flex h-6 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={onOpenThread}
          >
            <CornerDownRight className="size-3" />
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </button>
        ) : null}
        {(subThreads && subThreads.length > 0) || onCreateSubThread ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {(subThreads || []).map(session => {
              const participants = Array.isArray(session.participants) ? session.participants : [];
              const agentParticipants = participants.filter(p => p.kind === 'agent');
              const label = agentParticipants.length > 0
                ? agentParticipants.map(p => p.handle || p.name).join(', ')
                : session.title;
              return (
                <button
                  key={session.id}
                  type="button"
                  className="inline-flex h-5 items-center gap-1 rounded-full border border-border bg-muted/60 px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onOpenSubThread?.(session)}
                >
                  <MessageSquare className="size-2.5" />
                  {label}
                </button>
              );
            })}
            {onCreateSubThread && (
              <button
                type="button"
                className="inline-flex h-5 items-center gap-1 rounded-full border border-dashed border-border px-2 text-[11px] text-muted-foreground hover:border-border hover:text-foreground"
                onClick={onCreateSubThread}
              >
                <Plus className="size-2.5" />
                Sub-thread
              </button>
            )}
          </div>
        ) : null}
      </div>
      {/* Full-height rail bounded to this message row; the toolbar inside is sticky so it
          rides into view as you scroll a tall message (top → mid-viewport → bottom-right)
          instead of scrolling off the top with the message header. */}
      <div className="pointer-events-none absolute inset-y-0 right-3 flex items-start">
        <div className="pointer-events-auto sticky top-2 hidden items-center gap-1 rounded-md border bg-popover p-0.5 shadow-sm group-hover:flex group-focus-within:flex">
          {onOpenThread && (
            <Button type="button" variant="ghost" size="icon-xs" onClick={onOpenThread} disabled={isStreaming || actionBusy} aria-label={replyCount ? 'Open thread' : 'Start thread'} title={replyCount ? 'Open thread' : 'Start thread'}>
              <CornerDownRight />
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
              {pinnedMessages.map(message => (
                <div key={message.id} className="rounded-md border bg-muted/40 p-2 text-sm">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{message.sender_name || (message.role === 'user' ? 'You' : 'Assistant')}</div>
                  <MarkdownContent content={safeMessageText(message.content)} compact />
                </div>
              ))}
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
              <FileTreeSection title="Uploaded" count={uploadedFiles.length}>
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
  participant,
  connections,
  lookupKey,
  onClose,
}: {
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
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).map(item => String(item || '').trim()).filter(Boolean);
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
  return (
    <section className="agent-profile-card rounded-lg border bg-muted/30 p-3">
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className={`overflow-auto whitespace-pre-wrap text-sm leading-relaxed ${tall ? 'max-h-48' : 'max-h-32'}`}>
        {value}
      </div>
    </section>
  );
}

function AgentProfileChipSection({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return (
    <section className="agent-profile-card rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map(item => (
            <Badge key={item} variant="secondary" className="max-w-full truncate" title={item}>
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

type SelectedPanelFile =
  | { kind: 'uploaded'; file: UploadedFile }
  | { kind: 'project'; file: ProjectFileEntry; source: ProjectFileSource };

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

function UploadedFileRow({ file, onOpen }: { file: UploadedFile; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="file-tree-row"
      onClick={onOpen}
      title={`Open ${file.name}`}
    >
      <Paperclip className="file-tree-icon" />
      <span className="file-tree-name">{file.name}</span>
      <span className="file-tree-meta">{file.type || 'File'}</span>
      <span className="file-tree-size">{formatBytes(file.size || 0)}</span>
    </button>
  );
}

type ComposerContextOption = {
  id: string;
  label: string;
  detail: string;
};

function ComposerAddContent({
  documents,
  agents,
  uploadedFiles,
  projectFiles,
  canvasGroups,
  skillOptions,
  toolOptions,
  uploadEnabled,
  uploadStatus,
  onUploadFiles,
  onUploadFolder,
  onOpenFiles,
  onAddUploadedFile,
  onAddProjectFile,
  onAddDocument,
  onAddGroup,
  onAddAgent,
  onAddSkill,
  onAddTool,
}: {
  documents: Document[];
  agents: WorkspaceAgent[];
  uploadedFiles: UploadedFile[];
  projectFiles: Array<{ file: ProjectFileEntry; source: ProjectFileSource }>;
  canvasGroups: CanvasGroup[];
  skillOptions: ComposerContextOption[];
  toolOptions: ComposerContextOption[];
  uploadEnabled: boolean;
  uploadStatus: string;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onOpenFiles: () => void;
  onAddUploadedFile: (file: UploadedFile) => void;
  onAddProjectFile: (file: ProjectFileEntry, source: ProjectFileSource) => void;
  onAddDocument: (doc: Document) => void;
  onAddGroup: (group: CanvasGroup) => void;
  onAddAgent: (agent: WorkspaceAgent) => void;
  onAddSkill: (skill: ComposerContextOption) => void;
  onAddTool: (tool: ComposerContextOption) => void;
}) {
  return (
    <div className="max-h-[inherit] overflow-y-auto p-2">
      <div className="px-2 pb-2">
        <div className="text-sm font-medium">Add to message</div>
        <div className="text-xs text-muted-foreground">Attach files, link context, or route the prompt.</div>
      </div>

      <ComposerAddSection title="Folder / files">
        <div className="grid grid-cols-2 gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={onUploadFiles} disabled={!uploadEnabled}>
            <Upload data-icon="inline-start" />
            Files
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onUploadFolder} disabled={!uploadEnabled}>
            <FolderOpen data-icon="inline-start" />
            Folder
          </Button>
        </div>
        {uploadStatus && <div className="px-1 pt-1 text-xs text-muted-foreground">{uploadStatus}</div>}
        <ComposerAddRow
          icon={<Paperclip />}
          label="Browse file list"
          detail="Uploaded, workspace, and connected agent files"
          onClick={onOpenFiles}
        />
        {uploadedFiles.slice(0, 4).map(file => (
          <ComposerAddRow
            key={file.id}
            icon={<Paperclip />}
            label={file.name}
            detail={`Uploaded · ${formatBytes(file.size || 0)}`}
            onClick={() => onAddUploadedFile(file)}
          />
        ))}
        {projectFiles.slice(0, 6).map(({ file, source }) => (
          <ComposerAddRow
            key={`${source.id}:${file.path}`}
            icon={source.kind === 'agent' ? <Bot /> : <HardDrive />}
            label={file.path}
            detail={`${source.label} · ${formatBytes(file.size || 0)}`}
            onClick={() => onAddProjectFile(file, source)}
          />
        ))}
      </ComposerAddSection>

      <ComposerAddSection title="Agents">
        {agents.length > 0 ? agents.slice(0, 8).map(agent => (
          <ComposerAddRow
            key={agent.id}
            icon={<Bot />}
            label={agent.name}
            detail={`@${agentHandle(agent)}`}
            onClick={() => onAddAgent(agent)}
          />
        )) : (
          <ComposerAddEmpty>No agents yet.</ComposerAddEmpty>
        )}
      </ComposerAddSection>

      <ComposerAddSection title="Documents and canvas">
        {documents.slice(0, 6).map(doc => (
          <ComposerAddRow
            key={doc.id}
            icon={<FileText />}
            label={doc.title}
            detail="Document context"
            onClick={() => onAddDocument(doc)}
          />
        ))}
        {canvasGroups.slice(0, 6).map(group => (
          <ComposerAddRow
            key={group.id}
            icon={<Layers />}
            label={group.name}
            detail="Canvas group context"
            onClick={() => onAddGroup(group)}
          />
        ))}
        {documents.length === 0 && canvasGroups.length === 0 && <ComposerAddEmpty>No documents or canvas groups yet.</ComposerAddEmpty>}
      </ComposerAddSection>

      <ComposerAddSection title="Skills">
        {skillOptions.length > 0 ? skillOptions.map(skill => (
          <ComposerAddRow
            key={skill.id}
            icon={<Sparkles />}
            label={skill.label}
            detail={skill.detail}
            onClick={() => onAddSkill(skill)}
          />
        )) : (
          <ComposerAddEmpty>No detected skills.</ComposerAddEmpty>
        )}
      </ComposerAddSection>

      <ComposerAddSection title="Tools">
        {toolOptions.length > 0 ? toolOptions.map(tool => (
          <ComposerAddRow
            key={tool.id}
            icon={tool.detail.includes('command') ? <CommandIcon /> : <Wrench />}
            label={tool.label}
            detail={tool.detail}
            onClick={() => onAddTool(tool)}
          />
        )) : (
          <ComposerAddEmpty>No detected tools.</ComposerAddEmpty>
        )}
      </ComposerAddSection>
    </div>
  );
}

function ComposerAddSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1 border-t border-border px-2 py-2 first:border-t-0">
      <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

function ComposerAddRow({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none"
      onClick={onClick}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function ComposerAddEmpty({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1 text-xs text-muted-foreground">{children}</div>;
}

function ProjectFileRow({ file, source, onOpen }: { file: ProjectFileEntry; source: ProjectFileSource; onOpen: () => void }) {
  const displayName = file.path.split('/').filter(Boolean).pop() || file.name || file.path;
  const folderPath = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : source.label;
  return (
    <button
      type="button"
      className="file-tree-row"
      onClick={onOpen}
      title={file.path}
    >
      {source.kind === 'agent' ? <Bot className="file-tree-icon" /> : <FileText className="file-tree-icon" />}
      <span className="file-tree-name">{displayName}</span>
      <span className="file-tree-meta">{folderPath}</span>
      <span className="file-tree-size">{formatBytes(file.size || 0)}</span>
    </button>
  );
}

function FileDetailPanel({
  selectedFile,
  agents,
  onOpenUploaded,
  onCreateTask,
  onTaskCreated,
}: {
  selectedFile: SelectedPanelFile;
  agents: WorkspaceAgent[];
  onOpenUploaded: (file: UploadedFile) => Promise<void>;
  onCreateTask?: (input: CreateTaskInput) => void | Promise<unknown>;
  onTaskCreated: () => void;
}) {
  const defaultAgentId = agents[0]?.id || '';
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [instructions, setInstructions] = useState(() => `Modify ${panelFileName(selectedFile)} based on the requested outcome. Preserve the existing style and report what changed.`);
  const [saving, setSaving] = useState(false);
  const fileName = panelFileName(selectedFile);
  const palette = filePalette(fileName);
  const haiku = fileHaiku(selectedFile);
  const sourceLabel = panelFileSourceLabel(selectedFile);
  const sourcePath = panelFilePath(selectedFile);
  const size = selectedFile.kind === 'uploaded' ? selectedFile.file.size : selectedFile.file.size;
  const selectedAgent = agents.find(agent => agent.id === agentId);

  const handleCreateTask = async () => {
    if (!onCreateTask || saving) return;
    setSaving(true);
    try {
      await onCreateTask({
        title: `Modify ${fileName}`,
        description: [
          `File: ${sourcePath}`,
          `Source: ${sourceLabel}`,
          selectedAgent ? `Assigned agent: ${selectedAgent.name}` : '',
          `Palette: ${palette.join(', ')}`,
          `Description:\n${haiku}`,
          `Instructions:\n${instructions.trim() || `Modify ${fileName}.`}`,
        ].filter(Boolean).join('\n\n'),
        status: 'in_progress',
        priority: 'normal',
        assignee_id: agentId || null,
        source_type: 'ai',
        source_id: selectedFile.kind === 'uploaded' ? selectedFile.file.id : `${selectedFile.source.id}:${selectedFile.file.path}`,
      });
      onTaskCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/25 p-3">
        <div className="mb-2 flex min-w-0 items-start gap-2">
          {selectedFile.kind === 'project' && selectedFile.source.kind === 'agent' ? <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{fileName}</div>
            <div className="truncate text-xs text-muted-foreground" title={sourcePath}>{sourcePath}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div className="truncate">Source: {sourceLabel}</div>
          <div>{formatBytes(size || 0)}</div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Palette className="size-3.5" />
          Palette
        </div>
        <div className="flex gap-2">
          {palette.map(color => (
            <span key={color} className="h-8 flex-1 rounded-md border shadow-inner" style={{ background: color }} title={color} />
          ))}
        </div>
      </div>

      <div className="rounded-lg border bg-background/50 p-3 text-sm leading-relaxed">
        {haiku.split('\n').map(line => <div key={line}>{line}</div>)}
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Assign agent</label>
        <NativeSelect value={agentId} onChange={event => setAgentId(event.target.value)} className="w-full">
          <NativeSelectOption value="">Unassigned</NativeSelectOption>
          {agents.map(agent => (
            <NativeSelectOption key={agent.id} value={agent.id}>
              {agent.name}{agent.handle ? ` (@${agent.handle})` : ''}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Instruction</label>
        <Textarea
          value={instructions}
          onChange={event => setInstructions(event.target.value)}
          rows={5}
          className="min-h-28 resize-none text-sm"
          placeholder="Tell the assigned agent how to modify this file..."
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        {selectedFile.kind === 'uploaded' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void onOpenUploaded(selectedFile.file)}>
            Open original
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Creates an active task from this file.</span>
        )}
        <Button type="button" size="sm" onClick={handleCreateTask} disabled={!onCreateTask || saving}>
          {saving ? <Spinner /> : null}
          Create task
        </Button>
      </div>
    </div>
  );
}

function panelFileName(selectedFile: SelectedPanelFile) {
  return selectedFile.kind === 'uploaded' ? selectedFile.file.name : selectedFile.file.name || selectedFile.file.path.split('/').pop() || selectedFile.file.path;
}

function panelFilePath(selectedFile: SelectedPanelFile) {
  return selectedFile.kind === 'uploaded' ? selectedFile.file.name : selectedFile.file.path;
}

function panelFileSourceLabel(selectedFile: SelectedPanelFile) {
  return selectedFile.kind === 'uploaded' ? 'Uploaded' : selectedFile.source.label;
}

function linkedUploadedFile(file: UploadedFile): LinkedFile {
  return {
    id: `uploaded:${file.id}`,
    kind: 'uploaded',
    name: file.name,
    path: file.name,
    sourceLabel: 'Uploaded file',
    size: file.size || 0,
  };
}

function linkedProjectFile(file: ProjectFileEntry, source: ProjectFileSource): LinkedFile {
  return {
    id: `project:${source.id}:${file.path}`,
    kind: 'project',
    name: file.name || file.path.split('/').pop() || file.path,
    path: file.path,
    sourceLabel: source.label,
    size: file.size || 0,
  };
}

function buildFileContext(files: LinkedFile[]) {
  return [
    '[Linked files]',
    ...files.map(file => `- ${file.name} (${file.sourceLabel}): ${file.path}`),
  ].join('\n');
}

function filePalette(seed: string) {
  const hash = hashText(seed);
  return [0, 48, 112, 184, 252].map(offset => `hsl(${(hash + offset) % 360} 78% ${offset === 0 ? 46 : 58}%)`);
}

function fileHaiku(selectedFile: SelectedPanelFile) {
  const name = panelFileName(selectedFile).replace(/\.[^.]+$/, '') || 'File';
  const source = selectedFile.kind === 'uploaded' ? 'Uploaded' : selectedFile.source.kind === 'agent' ? 'Agent cwd' : 'Workspace';
  return [
    `${shortHaikuWord(name)} waits in place`,
    `${source} light marks the path`,
    'Hands reshape the file',
  ].join('\n');
}

function shortHaikuWord(value: string) {
  return value.split(/[-_\s]+/).filter(Boolean).slice(0, 3).join(' ') || 'File';
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
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

function toPersistedParticipant(participant: ParticipantCandidate): ChannelParticipant {
  return {
    id: participant.id,
    name: participant.name,
    kind: participant.kind,
    status: participant.status || null,
    handle: participant.handle || null,
    user_id: participant.user_id || null,
    agent_id: participant.agent_id || null,
    added_at: new Date().toISOString(),
  };
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


function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}
