import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Bot, CornerDownRight, Send, User, X } from 'lucide-react';
import { ChatArtifact, extractHtmlArtifact } from './ChatArtifact';
import { MarkdownContent } from './MarkdownContent';
import { EMPTY_STREAM_RESPONSE } from '../../lib/chatStream';
import { validAgentAccentColor } from '../../lib/agentAccent';
import type { AIModel, Message as ChatMessage } from '../../types';
import { ModelSelector } from './ModelSelector';
import { availableChatModelId } from '../../lib/sharedModels';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Spinner } from '@/components/ui/spinner';

interface ChatThreadPanelProps {
  parentMessage: ChatMessage;
  threadMessages: ChatMessage[];
  streaming: boolean;
  resolveMessageAccent?: (message: ChatMessage) => string;
  onSendReply: (content: string, model: string) => void;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  onClose: () => void;
  embedded?: boolean;
  models?: AIModel[];
}

export function ChatThreadPanel({
  parentMessage,
  threadMessages,
  streaming,
  resolveMessageAccent,
  onSendReply,
  onAgentProfile,
  onClose,
  embedded = false,
  models,
}: ChatThreadPanelProps) {
  const [input, setInput] = useState('');
  const [model, setModel] = useState('auto');
  const [autoScroll, setAutoScroll] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const replies = threadMessages.filter(m => m.id !== parentMessage.id);

  useEffect(() => {
    if (models) setModel(current => availableChatModelId(current, models));
  }, [models]);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    onSendReply(input.trim(), model);
    setInput('');
    inputRef.current?.focus();
  };

  const handleScrollerScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromEnd = target.scrollHeight - target.scrollTop - target.clientHeight;
    setAutoScroll(distanceFromEnd < 32);
  };

  return (
    <aside className={embedded ? 'channel-side-panel flex h-full min-w-0 flex-1 flex-col text-card-foreground' : 'channel-side-panel flex h-full w-[320px] shrink-0 flex-col border-l border-border text-card-foreground'}>
      <div className="channel-header flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <CornerDownRight className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Thread</span>
        <span className="text-xs text-muted-foreground">
          {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        </span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close thread">
          <X />
        </Button>
      </div>

      <div className="border-b border-border p-3">
        <ThreadBubble msg={parentMessage} accent={resolveMessageAccent?.(parentMessage)} onAgentProfile={onAgentProfile} isParent />
      </div>

      <MessageScrollerProvider autoScroll={autoScroll}>
        <MessageScroller className="channel-message-surface flex-1">
          <MessageScrollerViewport onScroll={handleScrollerScroll}>
            <MessageScrollerContent className="min-h-full gap-3 p-3">
              {replies.length === 0 ? (
                <Empty className="min-h-full border-0 p-4">
                  <EmptyHeader>
                    <EmptyTitle>No replies yet</EmptyTitle>
                    <EmptyDescription>Start the thread below.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex min-w-0 flex-col gap-1">
                  {replies.map((msg, idx) => (
                    <MessageScrollerItem key={msg.id} scrollAnchor={idx === replies.length - 1}>
                      <ThreadBubble
                        msg={msg}
                        accent={resolveMessageAccent?.(msg)}
                        onAgentProfile={onAgentProfile}
                        isStreaming={streaming && idx === replies.length - 1 && msg.role === 'assistant'}
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

      <div className="channel-composer shrink-0 border-t border-border p-3">
        <InputGroup className="h-auto flex-col items-stretch">
          <InputGroupTextarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Reply in thread..."
            disabled={streaming}
            rows={1}
            className="max-h-24 min-h-12"
            onInput={e => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
            }}
          />
          <InputGroupAddon align="block-end" className="min-h-10 justify-between gap-2 border-t px-2 py-1.5">
            <ModelSelector value={model} onChange={setModel} models={models} />
            <Button
              type="button"
              size="icon-sm"
              onClick={handleSend}
              disabled={!input.trim() || streaming}
              aria-label="Send reply"
            >
              {streaming ? <Spinner /> : <Send />}
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </aside>
  );
}

function ThreadBubble({
  msg,
  accent,
  onAgentProfile,
  isStreaming,
  isParent,
}: {
  msg: ChatMessage;
  accent?: string;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  isStreaming?: boolean;
  isParent?: boolean;
}) {
  const isUser = msg.role === 'user';
  const rawContent = safeMessageText(msg.content);
  const content = isParent && rawContent.length > 220
    ? `${rawContent.slice(0, 220)}...`
    : rawContent;
  const artifact = !isParent && content ? extractHtmlArtifact(content) : null;
  const displayContent = artifact ? artifact.remainingText : content;
  const senderName = msg.sender_name || (isUser ? 'You' : 'Assistant');
  const canOpenAgentProfile = msg.sender_kind === 'agent' && Boolean(msg.sender_id || msg.sender_name);
  const agentProfileKey = msg.sender_id || msg.sender_name || '';
  const createdAt = msg.created_at ? new Date(msg.created_at) : null;
  const timeLabel = createdAt && Number.isFinite(createdAt.getTime())
    ? createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const isAgentMessage = msg.sender_kind === 'agent' && Boolean(accent);
  const accentStyle = isAgentMessage
    ? ({ '--agent-accent': validAgentAccentColor(accent) } as CSSProperties & { '--agent-accent': string })
    : undefined;

  return (
    <div
      className={`chat-thread-message flex min-w-0 gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 ${isParent ? 'opacity-80' : ''}`}
      data-agent-message={isAgentMessage ? 'true' : undefined}
      style={accentStyle}
    >
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {canOpenAgentProfile && onAgentProfile ? (
            <button
              type="button"
              className="truncate text-xs font-semibold text-foreground hover:underline"
              style={accentStyle ? { color: 'var(--agent-accent)' } : undefined}
              onClick={() => onAgentProfile(agentProfileKey)}
            >
              {senderName}
            </button>
          ) : (
            <span className="truncate text-xs font-semibold text-foreground" style={accentStyle ? { color: 'var(--agent-accent)' } : undefined}>{senderName}</span>
          )}
          {timeLabel && <span className="shrink-0 text-[11px] text-muted-foreground">{timeLabel}</span>}
        </div>
        <div className="mt-0.5 text-xs leading-relaxed text-foreground">
          {displayContent ? (
            <MarkdownContent content={displayContent} compact />
          ) : isStreaming ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3" />
              Thinking
            </span>
          ) : !isUser ? (
            <span className="text-muted-foreground">{EMPTY_STREAM_RESPONSE}</span>
          ) : null}
          {artifact && <ChatArtifact artifact={artifact} />}
        </div>
      </div>
    </div>
  );
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
