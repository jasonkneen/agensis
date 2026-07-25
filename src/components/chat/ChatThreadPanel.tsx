import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Bot, CornerDownRight, Send, User, X } from 'lucide-react';
import { ChatArtifact, extractHtmlArtifact } from './ChatArtifact';
import { MarkdownContent } from './MarkdownContent';
import { ToolStepGroup } from './ToolStepGroup';
import { buildTranscriptRows } from './toolSteps';
import { EMPTY_STREAM_RESPONSE } from '../../lib/chatStream';
import { validAgentAccentColor } from '../../lib/agentAccent';
import type { AIModel, Document, Message as ChatMessage, WorkspaceAgent } from '../../types';
import { ModelSelector } from './ModelSelector';
import { availableChatModelId } from '../../lib/sharedModels';
import { Button } from '@/components/ui/button';

/** Roughly how much of the thread parent to show before offering "Show more". */
const PARENT_PREVIEW_CHARS = 220;

/**
 * Clip to the last whole markdown block that fits, so a preview can never end
 * inside a table row or a code fence. Returns the full text when it already fits
 * (callers use length equality to decide whether "Show more" is needed).
 *
 * Blocks are separated by blank lines. A fenced block is kept whole or dropped
 * entirely — half a fence renders as an unterminated code block and swallows
 * everything after it.
 */
function clipToBlockBoundary(text: string, budget: number) {
  if (text.length <= budget) return text;

  const blocks = text.split(/\n{2,}/);
  const kept: string[] = [];
  let used = 0;
  let insideFence = false;

  for (const block of blocks) {
    const fenceCount = (block.match(/```/g) || []).length;
    const opensFence = fenceCount % 2 === 1;
    // Never stop while a fence is open — finish it or drop it with the rest.
    if (used + block.length > budget && kept.length > 0 && !insideFence) break;
    kept.push(block);
    used += block.length + 2;
    if (opensFence) insideFence = !insideFence;
    if (used >= budget && !insideFence) break;
  }

  // A single opening block longer than the budget would otherwise render whole;
  // fall back to a hard cut, but only when there is no block boundary to use.
  if (kept.length === 0) return `${text.slice(0, budget)}…`;
  return kept.join('\n\n');
}
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
import { useComposerMentions } from '../../hooks/useComposerMentions';
import { ComposerMentionPicker, ComposerMentionChips } from './ComposerMentionUI';
import { COMPOSER_ADDON_CLASS, COMPOSER_TEXTAREA_CLASS, autosizeComposer } from '@/lib/composerStyles';

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
  agents?: WorkspaceAgent[];
  documents?: Document[];
  workspaceId?: string | null;
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
  agents,
  documents,
  workspaceId,
}: ChatThreadPanelProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const m = useComposerMentions({ agents, documents, workspaceId, inputRef });
  const [model, setModel] = useState('auto');
  const [autoScroll, setAutoScroll] = useState(true);
  const replies = threadMessages.filter(reply => reply.id !== parentMessage.id);
  // Steps land here (threaded under the agent's reply), so they must be chips in the
  // panel too — a run of four is four chips, not four bubbles.
  const replyRows = buildTranscriptRows(replies);

  useEffect(() => {
    if (models) setModel(current => availableChatModelId(current, models));
  }, [models]);

  const handleSend = () => {
    if (streaming) return;
    const content = m.buildContent();
    if (!content) return;
    onSendReply(content, model);
    m.clear();
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
                  {replyRows.map(row => {
                    const isLastRow = row.index === replies.length - 1;
                    if (row.kind === 'steps') {
                      return (
                        <MessageScrollerItem key={row.key} scrollAnchor={isLastRow}>
                          <ToolStepGroup steps={row.steps} endedByReply={row.endedByReply} compact />
                        </MessageScrollerItem>
                      );
                    }
                    return (
                      <MessageScrollerItem key={row.message.id} scrollAnchor={isLastRow}>
                        <ThreadBubble
                          msg={row.message}
                          accent={resolveMessageAccent?.(row.message)}
                          onAgentProfile={onAgentProfile}
                          isStreaming={streaming && isLastRow && row.message.role === 'assistant'}
                        />
                      </MessageScrollerItem>
                    );
                  })}
                </div>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" behavior="auto" onClick={() => setAutoScroll(true)} />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="channel-composer shrink-0 border-t border-border p-3">
        <div className="relative">
          <ComposerMentionPicker m={m} />
          <ComposerMentionChips m={m} />
          <InputGroup className="h-auto flex-col items-stretch">
            <InputGroupTextarea
              ref={inputRef}
              value={m.input}
              onChange={m.onInputChange}
              onKeyDown={e => {
                if ((e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') && m.handleNavKey(e.key)) {
                  e.preventDefault();
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Reply in thread... @agent, / commands"
              disabled={streaming}
              rows={1}
              className={COMPOSER_TEXTAREA_CLASS}
              onInput={e => autosizeComposer(e.currentTarget)}
            />
            <InputGroupAddon align="block-end" className={COMPOSER_ADDON_CLASS}>
              <ModelSelector value={model} onChange={setModel} models={models} />
              <Button
                type="button"
                size="icon-sm"
                onClick={handleSend}
                disabled={(!m.input.trim() && m.mentionedAgents.length === 0) || streaming}
                aria-label="Send reply"
              >
                {streaming ? <Spinner /> : <Send />}
              </Button>
            </InputGroupAddon>
          </InputGroup>
        </div>
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
  // The thread parent is shown as a compact header, but a blind character cut
  // lands mid-markdown — a 1355-char reply got sliced 16 chars into a table row
  // and rendered as "| Control |...", which reads as a broken/incomplete message.
  // A real user reported it as one and burned a round trip asking the agent why.
  // So: clip on a BLOCK boundary, never inside a table or fence, and let it expand.
  const [expanded, setExpanded] = useState(false);
  const clipped = isParent ? clipToBlockBoundary(rawContent, PARENT_PREVIEW_CHARS) : null;
  const canExpand = !!clipped && clipped.length < rawContent.length;
  const content = isParent && clipped && !expanded ? clipped : rawContent;
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
            <>
              <MarkdownContent content={displayContent} compact />
              {canExpand && (
                <button
                  type="button"
                  onClick={() => setExpanded(value => !value)}
                  aria-expanded={expanded}
                  className="mt-0.5 rounded text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </>
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
