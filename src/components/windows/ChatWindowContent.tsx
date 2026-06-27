import React, { useMemo, useRef, useState } from 'react';
import {
  Bot,
  CornerDownRight,
  FileText,
  Layers,
  Mic,
  Plus,
  Send,
  Sparkles,
  User,
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
  const handleScrollerScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromEnd = target.scrollHeight - target.scrollTop - target.clientHeight;
    setAutoScroll(distanceFromEnd < 32);
  };

  return (
    <div className="flex h-full min-w-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
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
                          onOpenThread={onOpenThread ? () => onOpenThread(msg.id) : undefined}
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
                placeholder="Chat with AI... @ documents, # canvas groups"
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

      {!readOnly && activeThreadId && parentMessage && onCloseThread && onSendThreadReply && (
        <ChatThreadPanel
          parentMessage={parentMessage}
          threadMessages={threadMessages}
          streaming={streaming}
          onSendReply={onSendThreadReply}
          onClose={onCloseThread}
        />
      )}
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
  const artifact = msg.content ? extractHtmlArtifact(msg.content) : null;
  const displayContent = artifact ? artifact.remainingText : msg.content;

  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageAvatar className="size-8">
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </MessageAvatar>
      <MessageContent>
        {!isUser && <MessageHeader>Hatch AI</MessageHeader>}
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
