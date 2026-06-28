import React, { useMemo, useRef, useState } from 'react';
import {
  Archive,
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
  Pin,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Star,
  User,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { ModelSelector } from '../chat/ModelSelector';
import { ChatThreadPanel } from '../chat/ChatThreadPanel';
import { ChatArtifact, extractHtmlArtifact } from '../chat/ChatArtifact';
import { MarkdownContent } from '../chat/MarkdownContent';
import type {
  CanvasGroup,
  CanvasObject,
  Document,
  MemoryFact,
  Message as ChatMessage,
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
  Bubble,
  BubbleContent,
} from '@/components/ui/bubble';
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
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
  selectedAgent,
  onSelectAgent,
  canvasGroups = [],
  canvasObjects = [],
  onSendMessage,
  onOpenThread,
  onCloseThread,
  onSendThreadReply,
  readOnly = false,
  channelTitle = 'general',
}: ChatWindowContentProps) {
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('auto');
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(360);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const filteredDocs = useMemo(() => {
    const q = docPickerQuery.toLowerCase();
    return documents.filter(d => d.title.toLowerCase().includes(q));
  }, [documents, docPickerQuery]);

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
    onSendMessage(content, selectedAgent?.model || selectedModel, memoryFacts, linkedDocs.length > 0 ? linkedDocs : undefined);
    setInput('');
    setLinkedDocs([]);
    setLinkedGroups([]);
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

  const displayMessages = topLevelMessages ?? messages;
  const parentMessage = activeThreadId ? messages.find(m => m.id === activeThreadId) : null;
  const pinnedMessages = messages.filter(message => message.pinned);
  const participants = useMemo(() => {
    const map = new Map<string, { id: string; name: string; kind: 'user' | 'agent' }>();
    messages.forEach(message => {
      if (message.sender_kind === 'agent' || message.role === 'assistant') {
        const id = message.sender_id || 'hatch-ai';
        map.set(id, { id, name: message.sender_name || 'Hatch AI', kind: 'agent' });
      } else {
        const id = message.sender_id || 'you';
        map.set(id, { id, name: message.sender_name || 'You', kind: 'user' });
      }
    });
    agents.forEach(agent => map.set(`agent:${agent.id}`, { id: `agent:${agent.id}`, name: agent.name, kind: 'agent' }));
    return Array.from(map.values()).slice(0, 6);
  }, [agents, messages]);
  const catchUpSummary = useMemo(() => buildCatchUpSummary(displayMessages, channelTitle), [displayMessages, channelTitle]);
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
    <div className="flex h-full min-w-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="channel-header relative shrink-0 border-b border-border bg-card">
          <div className="flex h-11 items-center gap-2 px-3">
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => setDetailsOpen(prev => !prev)}>
              <Hash data-icon="inline-start" />
              <span className="max-w-48 truncate font-semibold">{channelTitle || 'general'}</span>
              <ChevronDown className="size-3" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2">
              <Link2 data-icon="inline-start" />
              Connect
            </Button>
            <div className="flex-1" />
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => setCatchUpOpen(true)}>
              <RotateCcw data-icon="inline-start" />
              Catch up
            </Button>
            <div className="flex items-center gap-1">
              {participants.slice(0, 3).map(participant => (
                <span
                  key={participant.id}
                  className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold"
                  title={participant.name}
                >
                  {participant.kind === 'agent' ? <Bot className="size-3.5" /> : participant.name.slice(0, 2).toUpperCase()}
                </span>
              ))}
              <Badge variant="secondary" className="h-6 gap-1">
                <Users className="size-3" />
                {participants.length}
              </Badge>
            </div>
          </div>
          <div className="flex h-9 items-center gap-1 border-t border-border px-3">
            <Button type="button" variant={sidePanel === null || sidePanel === 'thread' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2" onClick={() => setSidePanel(null)}>
              <MessageSquare data-icon="inline-start" />
              Messages
            </Button>
            <Button type="button" variant={sidePanel === 'files' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2" onClick={() => setSidePanel('files')}>
              <Paperclip data-icon="inline-start" />
              Files
            </Button>
            <Button type="button" variant={sidePanel === 'pins' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2" onClick={() => setSidePanel('pins')}>
              <Pin data-icon="inline-start" />
              Pins
            </Button>
            <div className="flex-1" />
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Search channel">
              <Search />
            </Button>
          </div>
          {detailsOpen && (
            <div className="absolute z-[95] ml-3 mt-1 w-72 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl">
              <Button type="button" variant="ghost" className="w-full justify-start" size="sm"><Star data-icon="inline-start" />Add to favorites</Button>
              <Button type="button" variant="ghost" className="w-full justify-start" size="sm"><UserPlus data-icon="inline-start" />Add people or agents</Button>
              <Button type="button" variant="ghost" className="w-full justify-start" size="sm"><FileText data-icon="inline-start" />Edit channel</Button>
              <Button type="button" variant="ghost" className="w-full justify-start" size="sm"><Archive data-icon="inline-start" />Archive channel</Button>
            </div>
          )}
        </div>
        <MessageScrollerProvider autoScroll={autoScroll}>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport onScroll={handleScrollerScroll}>
              <MessageScrollerContent className="min-h-full gap-3 p-3">
                {displayMessages.length === 0 ? (
                  <Empty className="min-h-full border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Sparkles />
                      </EmptyMedia>
                      <EmptyTitle>Ready to chat</EmptyTitle>
                      <EmptyDescription>
                        Type a message below to start the conversation.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <MessageGroup className="gap-3">
                    {displayMessages.map((msg, idx) => (
                      <MessageScrollerItem key={msg.id} scrollAnchor={idx === displayMessages.length - 1}>
                        <ChatMessageBubble
                          msg={msg}
                          isStreaming={streaming && idx === displayMessages.length - 1 && msg.role === 'assistant'}
                          replyCount={threadReplyCounts[msg.id]}
                          onOpenThread={onOpenThread ? () => {
                            onOpenThread(msg.id);
                            openThread();
                          } : undefined}
                        />
                      </MessageScrollerItem>
                    ))}
                  </MessageGroup>
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
        <div className="border-t border-border bg-card p-2">
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
                  <CommandEmpty>No documents found.</CommandEmpty>
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
                placeholder={`Message #${channelTitle || 'general'}... @agent, @ documents, # canvas groups`}
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
                  <Marker className="ml-1 hidden max-w-28 sm:flex">
                    <MarkerIcon>
                      <Sparkles />
                    </MarkerIcon>
                    <MarkerContent>
                      {selectedAgent ? selectedAgent.name : 'Hatch AI'}
                    </MarkerContent>
                  </Marker>
                </div>

                <div className="flex min-w-0 items-center gap-2">
                  {agents.length > 0 && onSelectAgent && (
                    <NativeSelect
                      value={selectedAgent?.id || ''}
                      onChange={e => {
                        const agent = agents.find(a => a.id === e.target.value) || null;
                        onSelectAgent(agent);
                      }}
                      title="Select AI agent"
                      size="sm"
                      className="max-w-32"
                    >
                      <NativeSelectOption value="">Hatch AI</NativeSelectOption>
                      {agents.map(agent => (
                        <NativeSelectOption key={agent.id} value={agent.id}>
                          {agent.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                  <ModelSelector value={selectedAgent?.model || selectedModel} onChange={setSelectedModel} />
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
          className="relative flex h-full shrink-0 flex-col border-l border-border bg-card text-card-foreground"
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
              threadMessages={threadMessages}
              streaming={streaming}
              onSendReply={onSendThreadReply}
              onClose={closeSidePanel}
              embedded
            />
          ) : (
            <ChannelSidePanel
              type={sidePanel}
              pinnedMessages={pinnedMessages}
              onClose={closeSidePanel}
            />
          )}
        </aside>
      )}

      <Dialog open={catchUpOpen} onOpenChange={setCatchUpOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Catch up on #{channelTitle || 'general'}</DialogTitle>
            <DialogDescription>AI summary based on visible channel messages.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-foreground">{catchUpSummary}</p>
            <div className="text-xs text-muted-foreground">May miss nuance. Refresh after new activity.</div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChatMessageBubble({
  msg,
  isStreaming,
  replyCount,
  onOpenThread,
}: {
  msg: ChatMessage;
  isStreaming?: boolean;
  replyCount?: number;
  onOpenThread?: () => void;
}) {
  const isUser = msg.role === 'user';
  const rawContent = safeMessageText(msg.content);
  const artifact = rawContent ? extractHtmlArtifact(rawContent) : null;
  const displayContent = artifact ? artifact.remainingText : rawContent;
  const senderName = msg.sender_name || (isUser ? 'You' : 'Hatch AI');

  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageAvatar className="size-8">
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>{senderName}</MessageHeader>
        <Bubble variant={isUser ? 'default' : 'muted'} align={isUser ? 'end' : 'start'}>
          <BubbleContent>
            {displayContent ? (
              <MarkdownContent content={displayContent} />
            ) : isStreaming ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Spinner />
                Thinking
              </span>
            ) : null}
            {artifact && <ChatArtifact artifact={artifact} />}
          </BubbleContent>
        </Bubble>
        {isStreaming && msg.content && (
          <MessageFooter>
            <Spinner className="size-3" />
            Streaming
          </MessageFooter>
        )}
        {onOpenThread && msg.content && !isStreaming && (
          <MessageFooter>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onOpenThread}
            >
              <CornerDownRight data-icon="inline-start" />
              {replyCount ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}
            </Button>
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

function ChannelSidePanel({
  type,
  pinnedMessages,
  onClose,
}: {
  type: 'files' | 'pins' | 'thread';
  pinnedMessages: ChatMessage[];
  onClose: () => void;
}) {
  const isPins = type === 'pins';
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
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
        ) : (
          <p className="text-sm text-muted-foreground">Nothing shared yet.</p>
        )}
      </div>
    </div>
  );
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

function safeMessageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') {
    const record = value as { message?: unknown; content?: unknown; text?: unknown; error?: unknown };
    for (const key of ['message', 'content', 'text', 'error'] as const) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}
