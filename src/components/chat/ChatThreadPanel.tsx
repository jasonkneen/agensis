import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Bot, Check, CornerDownRight, Pencil, Send, Trash2, User, X } from 'lucide-react';
import { ChatArtifact, extractHtmlArtifact } from './ChatArtifact';
import { ThreadWorkBadge } from './AgentWorkBadge';
import { ThreadStopButton } from './StopAgentButton';
import { MarkdownContent } from './MarkdownContent';
import { ReactionBar } from './ReactionBar';
import { QueuedPill } from './SeenPill';
import { ReadReceipt } from './ReadReceipt';
import { useMessageReactions } from '../../hooks/useMessageReactions';
import { useReadReceipts } from '../../hooks/useReadReceipts';
import { useWorkspaceUsers } from '../../hooks/useWorkspaceUsers';
import { isOwnReceiptMessage, receiptTargetForViewport } from '../../lib/readReceipts';
import { queuedState, type QueuedState } from '../../lib/queuedPill';
import { useThreadWork } from '../../hooks/useAgentWork';
import type { ReactionUse } from '../../lib/reactionBar';
import { ToolStepGroup } from './ToolStepGroup';
import { buildTranscriptRows } from './toolSteps';
import { usePermissionRequests } from '../../hooks/usePermissionRequests';
import { resolvePermissionRequest } from './permissionRequests';
import { EMPTY_STREAM_RESPONSE } from '../../lib/chatStream';
import { validAgentAccentColor } from '../../lib/agentAccent';
import type { Document, Message as ChatMessage, WorkspaceAgent } from '../../types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { clipToBlockBoundary } from '../../lib/threadParentPreview';

/** Roughly how much of the thread parent to show before offering "Show more". */
const PARENT_PREVIEW_CHARS = 220;

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
import { COMPOSER_ADDON_CLASS, COMPOSER_SHELL_CLASS, COMPOSER_TEXTAREA_CLASS, autosizeComposer } from '@/lib/composerStyles';
import { THREAD_COMPOSER_PLACEHOLDER } from '@/lib/composerPlaceholder';
import { useComposerAutosize } from '@/hooks/useComposerAutosize';
import { useOwnMessageMutation } from '../../hooks/useOwnMessageMutation';
import type { SendOutcome } from '@/lib/writeFeedback';

interface ChatThreadPanelProps {
 parentMessage: ChatMessage;
 threadMessages: ChatMessage[];
 /** Whether the owning session has older rows that can still be fetched. */
 hasMoreMessages?: boolean;
 loadingEarlier?: boolean;
 onLoadEarlier?: () => void;
 streaming: boolean;
  resolveMessageAccent?: (message: ChatMessage) => string;
  // May resolve `{ delivered: false }` — the reply was rejected and rolled back.
  onSendReply?: (content: string, broadcastToChannel?: boolean) => void | Promise<SendOutcome | void>;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  onClose: () => void;
  embedded?: boolean;
  agents?: WorkspaceAgent[];
  documents?: Document[];
  workspaceId?: string | null;
  currentUserId?: string | null;
  readOnly?: boolean;
}

export function ChatThreadPanel({
 parentMessage,
 threadMessages,
 hasMoreMessages = false,
 loadingEarlier = false,
 onLoadEarlier,
 streaming,
  resolveMessageAccent,
  onSendReply,
  onAgentProfile,
  onClose,
  embedded = false,
  agents,
  documents,
  workspaceId,
  currentUserId,
  readOnly = false,
}: ChatThreadPanelProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const m = useComposerMentions({ agents, documents, workspaceId, inputRef });
  const [autoScroll, setAutoScroll] = useState(true);
  // "Send to channel": a thread reply stays in the thread but is ALSO shown in
  // the channel. Off by default — a thread exists
  // precisely so the working conversation stays out of the channel — and reset
  // after each send so it can never silently broadcast the next reply too.
  const [broadcastToChannel, setBroadcastToChannel] = useState(false);
  // Memoized because the receipt hook takes it as `orderedMessages`: a fresh
  // array every render would re-run the equal-time ordering work on every
  // keystroke in the composer.
  const replies = useMemo(
    () => threadMessages.filter(reply => reply.id !== parentMessage.id),
    [threadMessages, parentMessage.id],
  );
  // Decided tool approvals fold into the chip for the call they gated, same as the
  // main window, so a thread doesn't accumulate settled permission rows either.
  const { byId: permissionRequestsById } = usePermissionRequests(workspaceId ?? null);
  // Steps land here (threaded under the agent's reply), so they must be chips in the
  // panel too — a run of four is one summary chip, not four bubbles. The agent's
  // "Thinking …" placeholder rides in that same strip rather than as a bubble of
  // its own; three of those stacked in a thread was the whole reason for this.
  const replyRows = buildTranscriptRows(replies, undefined, message =>
    resolvePermissionRequest(message, permissionRequestsById),
  );

  useComposerAutosize(inputRef, m.input);
  // For the Stop control's label: an agent id from a running job row, resolved
  // to the name this panel already shows.
  const resolveAgentName = useCallback(
    (agentId: string) => (agents ?? []).find(row => String(row.id) === String(agentId))?.name || null,
    [agents],
  );

  // Reactions and seen pills on thread replies.
  //
  // Unlike a sub-thread (its own chat_session), a reply thread lives INSIDE the
  // owning session under `thread_parent_id`. The receipt hook is therefore given
  // that scope explicitly: markers are already stored per (reader, session,
  // thread_parent_id), so a reply thread keeps its own high-water mark and
  // reading the channel does not silently mark the thread read, or vice versa.
  const threadSessionId = parentMessage.session_id ? String(parentMessage.session_id) : null;
  const reactionState = useMessageReactions(readOnly ? null : currentUserId);
  const { members: workspaceMembers } = useWorkspaceUsers(workspaceId ?? null);
  // A reader id is a human user id OR an agent id, so resolve against members
  // first and then the agent roster.
  const resolveReaderName = useCallback((readerId: string) => {
    const member = workspaceMembers.find(row => String(row.user_id) === String(readerId));
    if (member) return member.email ? member.email.split('@')[0] : null;
    const agent = (agents ?? []).find(row => String(row.id) === String(readerId));
    if (agent) return agent.name || null;
    return null;
  }, [workspaceMembers, agents]);

  const receipts = useReadReceipts({
    sessionId: threadSessionId,
    currentUserId: currentUserId || null,
    active: !readOnly,
    threadParentId: parentMessage.id ? String(parentMessage.id) : null,
    orderedMessages: replies,
  });
  const noteVisibleRead = receipts.noteVisible;
  // `nearBottom` is load-bearing: `replies` is the loaded data set, not the
  // viewport, so a realtime append while somebody has scrolled up exists in the
  // array but was never on screen.
  const newestVisibleReply = useMemo(
    () => receiptTargetForViewport(replies, currentUserId || null, {
      surfaceActive: !readOnly,
      nearBottom: autoScroll,
    }),
    [autoScroll, currentUserId, readOnly, replies],
  );
  useEffect(() => {
    noteVisibleRead(newestVisibleReply);
  }, [noteVisibleRead, newestVisibleReply]);

  // No anchoring: every one of your own replies keeps its eye for as long as
  // the receipt is true, matching the channel. A read receipt is standing
  // evidence of what was taken in, not a transient notification.

  // "Queued", scoped to THIS thread's running job (metadata.threadParentId), so
  // a turn running in the channel does not mark thread replies as queued.
  const panelWork = useThreadWork(parentMessage.id || null);

  const handleSend = async () => {
    if (readOnly || streaming || !onSendReply) return;
    const content = m.buildContent();
    if (!content) return;
    // Same contract as the channel composer: clear now, but keep the draft so a
    // rejected reply can be handed back rather than lost.
    const draft = m.snapshot();
    const previousBroadcast = broadcastToChannel;
    m.clear();
    setBroadcastToChannel(false);
    inputRef.current?.focus();

    const outcome = await onSendReply(content, previousBroadcast);
    if (outcome && outcome.delivered === false) {
      m.restore(draft);
      setBroadcastToChannel(previousBroadcast);
      inputRef.current?.focus();
    }
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
        {/* Same live working state as the "N replies" chip in the channel, so the
            open panel doesn't look idle while its agent is still going. */}
        <ThreadWorkBadge parentMessageId={parentMessage.id} className="text-xs" />
        {/* Stop, right next to the working state it cancels. Keyed by the
            thread's parent message id — agent_jobs.metadata.threadParentId —
            so it ends THIS thread's turn and not the channel's. Renders null
            unless a job is actually running here. */}
        <ThreadStopButton
          parentMessageId={parentMessage.id}
          resolveAgentName={resolveAgentName}
        />
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close thread">
          <X />
        </Button>
      </div>

      <div className="border-b border-border p-3">
        <ThreadBubble
          msg={parentMessage}
          accent={resolveMessageAccent?.(parentMessage)}
          onAgentProfile={onAgentProfile}
          currentUserId={readOnly ? null : currentUserId}
          isParent
        />
      </div>

      <MessageScrollerProvider autoScroll={autoScroll}>
        <MessageScroller className="channel-message-surface flex-1">
          <MessageScrollerViewport onScroll={handleScrollerScroll}>
            <MessageScrollerContent className="min-h-full gap-3 p-3">
              {hasMoreMessages && onLoadEarlier && (
                <div className="flex justify-center py-1">
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
                          <ToolStepGroup row={row} compact />
                        </MessageScrollerItem>
                      );
                    }
                    return (
                      <MessageScrollerItem key={row.message.id} scrollAnchor={isLastRow}>
                        <ThreadBubble
                          msg={row.message}
                          accent={resolveMessageAccent?.(row.message)}
                          onAgentProfile={onAgentProfile}
                          currentUserId={readOnly ? null : currentUserId}
                          isStreaming={streaming && isLastRow && row.message.role === 'assistant'}
                          reactions={reactionState.reactionsFor(row.message)}
                          reactionUses={reactionState.reactionUses}
                          onToggleReaction={readOnly || row.message.deleted_at
                            ? undefined
                            : (reaction, op) => reactionState.toggle(row.message, reaction, op)}
                          resolveReaderName={resolveReaderName}
                          readerIds={isOwnReceiptMessage(row.message, currentUserId || null)
                            ? receipts.readersOfMessage(row.message)
                            : undefined}
                          queued={queuedState(row.message, panelWork, currentUserId || null)}
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

      {!readOnly && <div className={`${COMPOSER_SHELL_CLASS} shrink-0`}>
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
              placeholder={THREAD_COMPOSER_PLACEHOLDER}
              disabled={streaming}
              rows={1}
              className={COMPOSER_TEXTAREA_CLASS}
              onInput={e => autosizeComposer(e.currentTarget)}
            />
            <InputGroupAddon align="block-end" className={COMPOSER_ADDON_CLASS}>
              <div className="flex min-w-0 items-center gap-2">
                <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Checkbox
                    checked={broadcastToChannel}
                    onCheckedChange={checked => setBroadcastToChannel(checked === true)}
                    disabled={streaming}
                    aria-label="Also send this reply to the channel"
                  />
                  <span className="truncate">Send to channel</span>
                </label>
              </div>
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
      </div>}
    </aside>
  );
}

// A stable identity, so a read-only reply's ReactionBar does not get a fresh
// callback on every render. It is never reachable: `reactions` is nulled on the
// same branch, so there are no pills to click.
const NOOP_TOGGLE = () => {};

export function ThreadBubble({
  msg,
  accent,
  onAgentProfile,
  isStreaming,
  isParent,
  currentUserId,
  reactions,
  reactionUses = [],
  onToggleReaction,
  resolveReaderName,
  readerIds,
  queued,
}: {
  msg: ChatMessage;
  accent?: string;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  isStreaming?: boolean;
  isParent?: boolean;
  currentUserId?: string | null;
  reactions?: Record<string, string[]>;
  reactionUses?: readonly ReactionUse[];
  onToggleReaction?: (reaction: string, op: 'add' | 'remove') => void;
  resolveReaderName?: (readerId: string) => string | null;
  /** Undefined on a reply that carries no seen pill; empty when nobody has read it. */
  readerIds?: string[];
  queued?: QueuedState;
}) {
  const isUser = msg.role === 'user';
  const rawContent = safeMessageText(msg.content);
  const ownMutation = useOwnMessageMutation(msg, currentUserId, rawContent);
  // The thread parent is shown as a compact header, but a blind character cut
  // lands mid-markdown — a 1355-char reply got sliced 16 chars into a table row
  // and rendered as "| Control |...", which reads as a broken/incomplete message.
  // A real user reported it as one and burned a round trip asking the agent why.
  // So: clip on a BLOCK boundary, never inside a table or fence, and let it expand.
  const [expanded, setExpanded] = useState(false);
  const clipped = isParent ? clipToBlockBoundary(ownMutation.content, PARENT_PREVIEW_CHARS) : null;
  const canExpand = !!clipped && clipped.length < ownMutation.content.length;
  const content = isParent && clipped && !expanded ? clipped : ownMutation.content;
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
  // Built here so the row can ask "is there anything to show?" before rendering
  // a bar at all — an empty bar carries `mt-1` and would add 4px under every
  // reply nobody has read.
  // Only "queued" rides in the reaction row. Read state is a different kind of
  // fact — an assertion about the AGENT rather than anything anybody chose — so
  // it draws as its own eye below, matching the channel. See ReadReceipt.tsx.
  const seenPill = queued?.queued ? <QueuedPill state={queued} /> : null;

  return (
    <div
      className={`chat-thread-message flex min-w-0 gap-2 rounded-md px-2 py-1.5 ${isParent ? 'opacity-80' : ''}`}
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
          {ownMutation.mutable && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Edit post"
                title="Edit post"
                disabled={ownMutation.busy}
                onClick={ownMutation.startEdit}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Delete post"
                title="Delete post"
                disabled={ownMutation.busy}
                onClick={() => void ownMutation.deleteMessage()}
              >
                <Trash2 />
              </Button>
            </span>
          )}
        </div>
        <div className="mt-0.5 text-sm leading-relaxed text-foreground">
          {ownMutation.editing ? (
            <div className="space-y-1.5">
              <textarea
                value={ownMutation.draft}
                onChange={event => ownMutation.setDraft(event.target.value)}
                className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                aria-label="Edit message"
                disabled={ownMutation.busy}
              />
              <div className="flex justify-end gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={ownMutation.cancelEdit} disabled={ownMutation.busy}>
                  <X />
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={() => void ownMutation.saveEdit()} disabled={ownMutation.busy || !ownMutation.draft.trim()}>
                  <Check />
                  Save
                </Button>
              </div>
            </div>
          ) : displayContent ? (
            <>
              <MarkdownContent content={displayContent} />
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
        {/* Reactions and the seen pill share one row, as in the channel — see
            src/lib/seenPill.ts for why the pill is derived from the read markers
            rather than stored as a reaction.

            NOT on the parent. The parent is rendered here as a clipped HEADER
            for context, not as a post: it already carries its own pills in the
            channel, and a second, independently-toggleable copy of the same
            message's reactions in two places is a bug waiting to be filed. */}
        {!isParent && !ownMutation.editing && (onToggleReaction || seenPill) && (
          <ReactionBar
            reactions={onToggleReaction ? reactions : null}
            currentUserId={currentUserId || null}
            resolveName={resolveReaderName || (() => null)}
            onToggle={onToggleReaction ?? NOOP_TOGGLE}
            reactionUses={reactionUses}
            leadingSlot={seenPill}
          />
        )}
        {/* "Has it been read" — its own signal, never a reaction pill. The
            emptiness check is here because the wrapper carries `mt-1`. */}
        {!isParent && readerIds !== undefined && readerIds.length > 0 && (
          <div className="mt-1 flex items-center justify-end">
            <ReadReceipt readerIds={readerIds} resolveName={resolveReaderName || (() => null)} />
          </div>
        )}
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
