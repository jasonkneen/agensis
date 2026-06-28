import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  CornerDownRight,
  FileText,
  Hash,
  Layers,
  Link2,
  MessageSquare,
  Mic,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { ChatThreadPanel } from '../chat/ChatThreadPanel';
import { ChatArtifact, extractHtmlArtifact } from '../chat/ChatArtifact';
import { MarkdownContent } from '../chat/MarkdownContent';
import { apiAuthHeaders, apiUrl, backendClient } from '../../lib/backendClient';
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
import { useAuthenticatedObjectUrl } from '../../hooks/useAuthenticatedObjectUrl';

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
  contextControls?: React.ReactNode;
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
};

type ChannelSessionMeta = Pick<ChatSession, 'id' | 'title' | 'is_favorite' | 'archived_at' | 'participants'>;

const CHANNEL_META_COLUMNS = '*';

type DisplayParticipant = ChannelParticipant & {
  connected?: boolean;
};

type ParticipantCandidate = ChannelParticipant & {
  subtitle?: string;
  connected?: boolean;
};

type MessageOverrides = Record<string, Partial<ChatMessage> & { deleted?: boolean }>;

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
  contextControls,
}: ChatWindowContentProps) {
  const [input, setInput] = useState('');
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [linkedGroups, setLinkedGroups] = useState<CanvasGroup[]>([]);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [docPickerQuery, setDocPickerQuery] = useState('');
  const [groupPickerQuery, setGroupPickerQuery] = useState('');
  const [atStartPos, setAtStartPos] = useState(-1);
  const [hashStartPos, setHashStartPos] = useState(-1);
  const [autoScroll, setAutoScroll] = useState(true);
  const [sidePanel, setSidePanel] = useState<'thread' | 'files' | 'pins' | null>(null);
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
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const filteredDocs = useMemo(() => {
    const q = docPickerQuery.toLowerCase();
    return documents.filter(d => d.title.toLowerCase().includes(q));
  }, [documents, docPickerQuery]);

  const filteredAgents = useMemo(() => {
    const q = docPickerQuery.toLowerCase();
    return agents.filter(agent => {
      const handle = agentHandle(agent);
      return agent.name.toLowerCase().includes(q) || handle.includes(q);
    });
  }, [agents, docPickerQuery]);

  const filteredGroups = useMemo(() => {
    const q = groupPickerQuery.toLowerCase();
    return canvasGroups.filter(g => g.name.toLowerCase().includes(q));
  }, [canvasGroups, groupPickerQuery]);

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
    if (linkedGroups.length > 0) {
      content = `${buildGroupContext(linkedGroups)}\n\n${content}`;
    }
    onSendMessage(content, 'auto', memoryFacts, linkedDocs.length > 0 ? linkedDocs : undefined);
    setInput('');
    setLinkedDocs([]);
    setLinkedGroups([]);
    inputRef.current?.focus();
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
      if (e.key === 'Enter' && filteredDocs.length > 0) {
        e.preventDefault();
        handleDocSelect(filteredDocs[0]);
        return;
      }
    }

    if (showGroupPicker) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowGroupPicker(false);
        return;
      }
      if (e.key === 'Enter' && filteredGroups.length > 0) {
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

  const participantCandidates = useMemo(
    () => buildParticipantCandidates(presenceUsers, agents, agentConnections, persistedParticipants, visibleMessages),
    [agentConnections, agents, persistedParticipants, presenceUsers, visibleMessages],
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
    visibleMessages.forEach(message => {
      if (message.sender_kind === 'agent' || message.role === 'assistant') {
        const id = message.sender_id ? `agent:${message.sender_id}` : 'agent:hatch-ai';
        if (!map.has(id)) {
          map.set(id, {
            id,
            name: message.sender_name || 'Hatch AI',
            kind: 'agent',
            agent_id: message.sender_id || null,
          });
        }
      } else {
        const id = message.sender_id ? `user:${message.sender_id}` : 'user:you';
        if (!map.has(id)) {
          map.set(id, {
            id,
            name: message.sender_name || 'You',
            kind: 'user',
            user_id: message.sender_id || null,
          });
        }
      }
    });
    return Array.from(map.values()).slice(0, 6);
  }, [agentConnections, agents, persistedParticipants, presenceUsers, visibleMessages]);

  const findChannelSession = async (): Promise<ChannelSessionMeta | null> => {
    if (channelMeta?.id) return channelMeta;
    if (inferredSessionId) {
      return {
        id: inferredSessionId,
        title: channelTitle || 'general',
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
    const { data, error } = await backendClient
      .from<ChannelSessionMeta>('chat_sessions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', session.id)
      .select(CHANNEL_META_COLUMNS)
      .single();
    if (error || !data) {
      setChannelActionStatus(error?.message || 'Could not save channel changes.');
      return null;
    }
    const next = normalizeChannelSessionMeta({ ...session, ...updates, ...data });
    setChannelMeta(next);
    return next;
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
    fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/project-files`), {
      headers: apiAuthHeaders(),
    })
      .then(response => response.json())
      .then(payload => {
        if (cancelled) return;
        setProjectFiles(Array.isArray(payload?.data?.files) ? payload.data.files : []);
        setProjectRoot(typeof payload?.data?.root === 'string' ? payload.data.root : '');
      })
      .catch(() => {
        if (!cancelled) {
          setProjectFiles([]);
          setProjectRoot('');
        }
      })
      .finally(() => {
        if (!cancelled) setProjectFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sidePanel, workspaceId]);
  const handleScrollerScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromEnd = target.scrollHeight - target.scrollTop - target.clientHeight;
    setAutoScroll(distanceFromEnd < 32);
  };
  const openThread = () => {
    setSidePanel('thread');
  };
  const closeSidePanel = () => {
    if (sidePanel === 'thread') onCloseThread?.();
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
            <div className="min-w-2 flex-1" />
            {contextControls && (
              <div className="flex min-w-0 max-w-[40vw] shrink overflow-x-auto text-xs text-muted-foreground">
                {contextControls}
              </div>
            )}
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => setCatchUpOpen(true)}>
              <RotateCcw data-icon="inline-start" />
              Catch up
            </Button>
            <div className="flex items-center gap-1">
              {participants.slice(0, 3).map(participant => (
                <span
                  key={participant.id}
                  className="relative flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold"
                  title={[participant.name, participant.status].filter(Boolean).join(' - ')}
                >
                  {participant.kind === 'agent' ? <Bot className="size-3.5" /> : participant.name.slice(0, 2).toUpperCase()}
                  {participant.connected && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-card bg-emerald-500" />}
                </span>
              ))}
              <Badge variant="secondary" className="h-6 gap-1" title={`${participants.length} participants`}>
                <Users className="size-3" />
                {participants.length}
              </Badge>
            </div>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Search channel">
              <Search />
            </Button>
          </div>
        </div>
        <MessageScrollerProvider autoScroll={autoScroll}>
          <MessageScroller className="channel-message-surface flex-1">
            <MessageScrollerViewport onScroll={handleScrollerScroll}>
              <MessageScrollerContent className="min-h-full gap-0 py-2">
                {displayMessages.length === 0 ? (
                  <Empty className="min-h-full border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Sparkles />
                      </EmptyMedia>
                      <EmptyTitle>Channel is open</EmptyTitle>
                      <EmptyDescription>
                        Post a message below to start this channel.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="flex min-w-0 flex-col">
                    {displayMessages.map((msg, idx) => (
                      <MessageScrollerItem key={msg.id} scrollAnchor={idx === displayMessages.length - 1}>
                        <ChatMessageBubble
                          msg={msg}
                          isStreaming={streaming && idx === displayMessages.length - 1 && msg.role === 'assistant'}
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
                        />
                      </MessageScrollerItem>
                    ))}
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton direction="end" behavior="auto" onClick={() => setAutoScroll(true)} />
          </MessageScroller>
        </MessageScrollerProvider>

        {readOnly ? (
          <div className="border-t border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            Read-only workspace instance
          </div>
        ) : (
        <div className="channel-composer border-t border-border p-2">
          {(linkedDocs.length > 0 || linkedGroups.length > 0) && (
            <AttachmentGroup className="mb-2">
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

          <div className="relative">
            {showDocPicker && (
              <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-56 rounded-xl border border-border shadow-lg">
                <CommandList>
                  <CommandEmpty>No agents or documents found.</CommandEmpty>
                  {filteredAgents.length > 0 && (
                    <CommandGroup heading="Agents">
                      {filteredAgents.map(agent => (
                        <CommandItem
                          key={agent.id}
                          value={`${agent.name} ${agentHandle(agent)}`}
                          onSelect={() => handleAgentSelect(agent)}
                        >
                          <Bot />
                          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                          <span className="text-xs text-muted-foreground">@{agentHandle(agent)}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  <CommandGroup heading="Documents">
                    {filteredDocs.map(doc => (
                      <CommandItem
                        key={doc.id}
                        value={doc.title}
                        onSelect={() => handleDocSelect(doc)}
                      >
                        <FileText />
                        <span className="truncate">{doc.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            )}

            {showGroupPicker && (
              <Command className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-56 rounded-xl border border-border shadow-lg">
                <CommandList>
                  <CommandEmpty>No groups found.</CommandEmpty>
                  <CommandGroup heading="Canvas groups">
                    {filteredGroups.map(group => {
                      const objectCount = canvasObjects.filter(object => object.group_id === group.id).length;
                      return (
                        <CommandItem
                          key={group.id}
                          value={group.name}
                          onSelect={() => handleGroupSelect(group)}
                        >
                          <Layers />
                          <span className="min-w-0 flex-1 truncate">{group.name}</span>
                          <span className="text-xs text-muted-foreground">
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
                placeholder={`Post in #${channelTitle || 'general'}... @agent, @ documents, # canvas groups`}
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
                  <InputGroupButton size="icon-xs" aria-label="Attach file">
                    <Plus />
                  </InputGroupButton>
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
          </div>
        </div>
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
          {sidePanel === 'thread' && activeThreadId && parentMessage && onSendThreadReply ? (
            <ChatThreadPanel
              parentMessage={parentMessage}
              threadMessages={visibleThreadMessages}
              streaming={streaming}
              onSendReply={onSendThreadReply}
              onClose={closeSidePanel}
              embedded
            />
          ) : (
            <ChannelSidePanel
              type={sidePanel}
              pinnedMessages={pinnedMessages}
              uploadedFiles={uploadedFiles}
              projectFiles={projectFiles}
              projectRoot={projectRoot}
              loading={projectFilesLoading}
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
    </div>
  );
}

function ChatMessageBubble({
  msg,
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
}: {
  msg: ChatMessage;
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
}) {
  const isUser = msg.role === 'user';
  const rawContent = safeMessageText(msg.content);
  const artifact = rawContent ? extractHtmlArtifact(rawContent) : null;
  const displayContent = artifact ? artifact.remainingText : rawContent;
  const senderName = msg.sender_name || (isUser ? 'You' : 'Hatch AI');
  const initials = isUser ? 'YO' : (senderName.slice(0, 2).toUpperCase() || 'AI');
  const createdAt = msg.created_at ? new Date(msg.created_at) : null;
  const timeLabel = createdAt && Number.isFinite(createdAt.getTime())
    ? createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="group relative flex w-full min-w-0 gap-3 px-4 py-2 pr-20 hover:bg-muted/40">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
        {msg.sender_kind === 'agent' || msg.role === 'assistant' ? <Bot className="size-4" /> : initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{senderName}</span>
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
            {displayContent ? (
              <MarkdownContent content={displayContent} />
            ) : isStreaming ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-3" />
                Thinking
              </span>
            ) : (
              <span className="text-muted-foreground">Message content is unavailable.</span>
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
      </div>
      <div className="absolute top-2 right-3 hidden items-center gap-1 rounded-md border bg-popover p-0.5 shadow-sm group-hover:flex group-focus-within:flex">
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
  );
}

function ChannelSidePanel({
  type,
  pinnedMessages,
  uploadedFiles,
  projectFiles,
  projectRoot,
  loading,
  onClose,
}: {
  type: 'files' | 'pins' | 'thread';
  pinnedMessages: ChatMessage[];
  uploadedFiles: UploadedFile[];
  projectFiles: ProjectFileEntry[];
  projectRoot: string;
  loading: boolean;
  onClose: () => void;
}) {
  const isPins = type === 'pins';
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

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="channel-header flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {isPins ? <Pin className="size-4 text-muted-foreground" /> : <Paperclip className="size-4 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {isPins ? 'Pinned messages' : 'Files'}
        </span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close side panel">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {isPins ? (
          pinnedMessages.length > 0 ? (
            <div className="space-y-2">
              {pinnedMessages.map(message => (
                <div key={message.id} className="rounded-md border bg-muted/40 p-2 text-sm">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{message.sender_name || (message.role === 'user' ? 'You' : 'Hatch AI')}</div>
                  <MarkdownContent content={safeMessageText(message.content)} compact />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No pinned messages yet.</p>
          )
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading files...</p>
        ) : uploadedFiles.length > 0 || projectFiles.length > 0 ? (
          <div className="space-y-4">
            {uploadedFiles.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Uploaded</div>
                {uploadedFiles.map(file => (
                  <UploadedFileRow key={file.id} file={file} onOpen={() => void openUploadedFile(file)} />
                ))}
              </div>
            )}
            {projectFiles.length > 0 && (
              <div className="space-y-2">
                <div className="min-w-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Workspace folder
                  {projectRoot && <span className="ml-1 normal-case tracking-normal">({projectRoot})</span>}
                </div>
                {projectFiles.map(file => (
                  <div key={file.path} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
                    <span className="text-xs text-muted-foreground">{formatBytes(file.size || 0)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No workspace or uploaded files found.</p>
        )}
      </div>
    </div>
  );
}

function UploadedFileRow({ file, onOpen }: { file: UploadedFile; onOpen: () => void }) {
  const isImage = (file.type || '').startsWith('image/');
  const preview = useAuthenticatedObjectUrl(isImage ? apiUrl(`/backend/files/${encodeURIComponent(file.id)}/content`) : null);

  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-left text-sm hover:bg-muted/50"
      onClick={onOpen}
      title={`Open ${file.name}`}
    >
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md border bg-background">
        {isImage && preview.src ? (
          <img src={preview.src} alt="" className="size-full object-cover" draggable={false} />
        ) : (
          <Paperclip className="size-4 text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{file.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{file.type || 'File'}</span>
      </span>
      <span className="text-xs text-muted-foreground">{formatBytes(file.size || 0)}</span>
    </button>
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
    is_favorite: Boolean(meta.is_favorite),
    archived_at: meta.archived_at ?? null,
    participants: normalizeChannelParticipants(meta.participants),
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
    }];
  });
}

function withLiveParticipantStatus(
  participant: ChannelParticipant,
  agents: WorkspaceAgent[],
  agentConnections: AgentConnection[],
): DisplayParticipant {
  if (participant.kind !== 'agent') return participant;
  const agentId = participant.agent_id || participant.id.replace(/^agent:/, '');
  const agent = agents.find(item => item.id === agentId);
  const connection = agentConnections.find(item => item.agent_id === agentId && item.status !== 'offline');
  return {
    ...participant,
    name: participant.name || agent?.name || 'Agent',
    status: connection?.status || participant.status || agent?.run_mode || 'built-in',
    connected: Boolean(connection),
  };
}

function buildParticipantCandidates(
  presenceUsers: ChannelPresenceUser[],
  agents: WorkspaceAgent[],
  agentConnections: AgentConnection[],
  persistedParticipants: ChannelParticipant[],
  messages: ChatMessage[],
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

  messages.forEach(message => {
    if (message.sender_kind === 'agent' || message.role === 'assistant') {
      const id = message.sender_id ? `agent:${message.sender_id}` : 'agent:hatch-ai';
      if (!map.has(id)) {
        map.set(id, {
          id,
          name: message.sender_name || 'Hatch AI',
          kind: 'agent',
          agent_id: message.sender_id || null,
          user_id: null,
        });
      }
      return;
    }
    const id = message.sender_id ? `user:${message.sender_id}` : 'user:you';
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: message.sender_name || 'You',
        kind: 'user',
        user_id: message.sender_id || null,
        agent_id: null,
      });
    }
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
  candidates.forEach(candidate => {
    const key = participantCandidateKey(candidate);
    const previous = byKey.get(key);
    if (!previous || participantCandidateRank(candidate) > participantCandidateRank(previous)) {
      byKey.set(key, { ...previous, ...candidate });
    }
  });
  return Array.from(byKey.values());
}

function participantCandidateKey(candidate: ParticipantCandidate): string {
  if (candidate.kind === 'user') {
    return candidate.user_id ? `user:${candidate.user_id}` : candidate.id;
  }
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

function agentHandle(agent: WorkspaceAgent): string {
  return String(agent.handle || agent.name || 'agent')
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'agent';
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
