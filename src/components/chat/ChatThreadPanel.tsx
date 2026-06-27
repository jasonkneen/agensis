import { useRef, useState } from 'react';
import { Bot, CornerDownRight, Send, User, X } from 'lucide-react';
import { ModelSelector } from './ModelSelector';
import { ChatArtifact, extractHtmlArtifact } from './ChatArtifact';
import { MarkdownContent } from './MarkdownContent';
import type { Message as ChatMessage } from '../../types';
import { Button } from '@/components/ui/button';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
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
  Message,
  MessageAvatar,
  MessageContent,
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
import { Spinner } from '@/components/ui/spinner';

interface ChatThreadPanelProps {
  parentMessage: ChatMessage;
  threadMessages: ChatMessage[];
  streaming: boolean;
  onSendReply: (content: string, model: string) => void;
  onClose: () => void;
}

export function ChatThreadPanel({
  parentMessage,
  threadMessages,
  streaming,
  onSendReply,
  onClose,
}: ChatThreadPanelProps) {
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('auto');
  const [autoScroll, setAutoScroll] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const replies = threadMessages.filter(m => m.id !== parentMessage.id);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    onSendReply(input.trim(), selectedModel);
    setInput('');
    inputRef.current?.focus();
  };

  const handleScrollerScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromEnd = target.scrollHeight - target.scrollTop - target.clientHeight;
    setAutoScroll(distanceFromEnd < 32);
  };

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-card text-card-foreground">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
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
        <ThreadBubble msg={parentMessage} isParent />
      </div>

      <MessageScrollerProvider autoScroll={autoScroll}>
        <MessageScroller className="flex-1">
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
                <MessageGroup className="gap-3">
                  {replies.map((msg, idx) => (
                    <MessageScrollerItem key={msg.id} scrollAnchor={idx === replies.length - 1}>
                      <ThreadBubble
                        msg={msg}
                        isStreaming={streaming && idx === replies.length - 1 && msg.role === 'assistant'}
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

      <div className="shrink-0 border-t border-border p-3">
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
          <InputGroupAddon align="block-end" className="justify-end border-t">
            <ModelSelector value={selectedModel} onChange={setSelectedModel} />
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
  isStreaming,
  isParent,
}: {
  msg: ChatMessage;
  isStreaming?: boolean;
  isParent?: boolean;
}) {
  const isUser = msg.role === 'user';
  const content = isParent && msg.content.length > 220
    ? `${msg.content.slice(0, 220)}...`
    : msg.content;
  const artifact = !isParent && content ? extractHtmlArtifact(content) : null;
  const displayContent = artifact ? artifact.remainingText : content;

  return (
    <Message align={isUser ? 'end' : 'start'} className={isParent ? 'opacity-80' : undefined}>
      <MessageAvatar className="size-7">
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </MessageAvatar>
      <MessageContent>
        {!isUser && <MessageHeader>Hatch AI</MessageHeader>}
        <Bubble variant={isUser ? 'default' : isParent ? 'outline' : 'muted'} align={isUser ? 'end' : 'start'}>
          <BubbleContent className="text-xs">
            {displayContent ? (
              <MarkdownContent content={displayContent} compact />
            ) : isStreaming ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-3" />
                Thinking
              </span>
            ) : null}
            {artifact && <ChatArtifact artifact={artifact} />}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
