import { useRef, useState, type CSSProperties } from 'react';
import { Bot, MessageSquare, Send, User, X } from 'lucide-react';
import { ChatArtifact, extractHtmlArtifact } from './ChatArtifact';
import { MarkdownContent } from './MarkdownContent';
import { EMPTY_STREAM_RESPONSE } from '../../lib/chatStream';
import { validAgentAccentColor } from '../../lib/agentAccent';
import type { ChatSession, Message as ChatMessage } from '../../types';
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

interface SubThreadPanelProps {
  session: ChatSession;
  messages: ChatMessage[];
  streaming: boolean;
  resolveMessageAccent?: (message: ChatMessage) => string;
  onSendMessage: (content: string) => void;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  onClose: () => void;
  embedded?: boolean;
}

export function SubThreadPanel({
  session,
  messages,
  streaming,
  resolveMessageAccent,
  onSendMessage,
  onAgentProfile,
  onClose,
  embedded = false,
}: SubThreadPanelProps) {
  const [input, setInput] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const agentParticipants = participants.filter(p => p.kind === 'agent');

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    onSendMessage(input.trim());
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
        <MessageSquare className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {agentParticipants.length > 0
            ? agentParticipants.map(p => p.name || p.handle).join(', ')
            : session.title}
        </span>
        <span className="text-xs text-muted-foreground">
          {messages.length} {messages.length === 1 ? 'message' : 'messages'}
        </span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close sub-thread">
          <X />
        </Button>
      </div>

      {agentParticipants.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
          {agentParticipants.map(p => (
            <button
              key={p.id}
              type="button"
              className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => onAgentProfile?.(p.agent_id || p.handle || p.name || '')}
            >
              <Bot className="size-3" />
              {p.handle || p.name}
            </button>
          ))}
        </div>
      )}

      <MessageScrollerProvider autoScroll={autoScroll}>
        <MessageScroller className="channel-message-surface flex-1">
          <MessageScrollerViewport onScroll={handleScrollerScroll}>
            <MessageScrollerContent className="min-h-full gap-3 p-3">
              {messages.length === 0 ? (
                <Empty className="min-h-full border-0 p-4">
                  <EmptyHeader>
                    <EmptyTitle>Start the conversation</EmptyTitle>
                    <EmptyDescription>
                      {agentParticipants.length > 0
                        ? `@${agentParticipants[0]?.handle || agentParticipants[0]?.name} is here.`
                        : 'Send a message below.'}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex min-w-0 flex-col gap-1">
                  {messages.map((msg, idx) => (
                    <MessageScrollerItem key={msg.id} scrollAnchor={idx === messages.length - 1}>
                      <SubThreadBubble
                        msg={msg}
                        accent={resolveMessageAccent?.(msg)}
                        onAgentProfile={onAgentProfile}
                        isStreaming={streaming && idx === messages.length - 1 && msg.role === 'assistant'}
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
            placeholder="Message in sub-thread..."
            disabled={streaming}
            rows={1}
            className="max-h-24 min-h-12"
            onInput={e => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
            }}
          />
          <InputGroupAddon align="block-end" className="min-h-10 justify-end gap-2 border-t px-2 py-1.5">
            <Button
              type="button"
              size="icon-sm"
              onClick={handleSend}
              disabled={!input.trim() || streaming}
              aria-label="Send message"
            >
              {streaming ? <Spinner /> : <Send />}
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </aside>
  );
}

function SubThreadBubble({
  msg,
  accent,
  onAgentProfile,
  isStreaming,
}: {
  msg: ChatMessage;
  accent?: string;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  isStreaming?: boolean;
}) {
  const isUser = msg.role === 'user';
  const content = safeText(msg.content);
  const artifact = content ? extractHtmlArtifact(content) : null;
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
      className="chat-thread-message flex min-w-0 gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
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
            <span
              className="truncate text-xs font-semibold text-foreground"
              style={accentStyle ? { color: 'var(--agent-accent)' } : undefined}
            >
              {senderName}
            </span>
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

function safeText(value: unknown): string {
  if (typeof value === 'string') return value === '[object Object]' ? '' : value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(safeText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const r = value as Record<string, unknown>;
    for (const key of ['text', 'message', 'content'] as const) {
      const t = safeText(r[key]);
      if (t) return t;
    }
  }
  return String(value);
}
