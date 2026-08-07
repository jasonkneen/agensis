import { Bot, Check, MessageSquare, Pencil, Plus, Send, Trash2, User, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChatArtifact, extractHtmlArtifact } from './ChatArtifact';
import { SessionStopButton } from './StopAgentButton';
import { MarkdownContent } from './MarkdownContent';
import { ReactionBar } from './ReactionBar';
import { QueuedPill, SeenPill } from './SeenPill';
import { buildReaderFaces, type ReaderFace } from '../../lib/readerFaces';
import { useMessageReactions } from '../../hooks/useMessageReactions';
import { useReadReceipts } from '../../hooks/useReadReceipts';
import { useWorkspaceUsers } from '../../hooks/useWorkspaceUsers';
import { isOwnReceiptMessage, receiptTargetForViewport } from '../../lib/readReceipts';
import { queuedState, type QueuedState } from '../../lib/queuedPill';
import { useSessionWork } from '../../hooks/useAgentWork';
import type { ReactionUse } from '../../lib/reactionBar';
import { ToolStepGroup } from './ToolStepGroup';
import { buildTranscriptRows } from './toolSteps';
import { usePermissionRequests } from '../../hooks/usePermissionRequests';
import { resolvePermissionRequest } from './permissionRequests';
import {
  ComposerAddContent,
  FileChip,
  buildFileContext,
  linkedUploadedFile,
  linkedProjectFile,
  type ComposerContextOption,
  type LinkedFile,
  type ProjectFileEntry,
  type ProjectFileSource,
} from './ComposerAddContent';
import { EMPTY_STREAM_RESPONSE } from '../../lib/chatStream';
import { validAgentAccentColor } from '../../lib/agentAccent';
import { prependLinkedDocumentContext } from '../../lib/linkedDocumentContext';
import {
  extractActivityVerb,
  isActivityPlaceholderMessage,
  isLiveActivityPlaceholder,
} from '../../lib/activityStatus';
import type { CanvasGroup, ChatSession, Document, Message as ChatMessage, MessageAttachment, UploadedFile, WorkspaceAgent } from '../../types';
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
  InputGroupButton,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { useComposerMentions } from '../../hooks/useComposerMentions';
import { ComposerMentionPicker, ComposerMentionChips } from './ComposerMentionUI';
import { COMPOSER_ADDON_CLASS, COMPOSER_SHELL_CLASS, COMPOSER_TEXTAREA_CLASS, autosizeComposer } from '@/lib/composerStyles';
import { SUB_THREAD_COMPOSER_PLACEHOLDER } from '@/lib/composerPlaceholder';
import { useComposerAutosize } from '../../hooks/useComposerAutosize';
import { useOwnMessageMutation } from '../../hooks/useOwnMessageMutation';
import type { SendOutcome } from '../../lib/writeFeedback';
import { buildMessageAttachments } from '../../lib/messageAttachments';

interface SubThreadPanelProps {
  session: ChatSession;
  messages: ChatMessage[];
  hasMoreMessages?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  streaming: boolean;
  resolveMessageAccent?: (message: ChatMessage) => string;
  // May resolve `{ delivered: false }` — the message was rejected and rolled back.
  onSendMessage?: (content: string, attachments?: MessageAttachment[]) => void | Promise<SendOutcome | void>;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  onClose: () => void;
  embedded?: boolean;
  documents?: Document[];
  agents?: WorkspaceAgent[];
  uploadedFiles?: UploadedFile[];
  canvasGroups?: CanvasGroup[];
  onUploadFiles?: (files: File[]) => Promise<UploadedFile[]>;
  composerProjectFiles?: Array<{ file: ProjectFileEntry; source: ProjectFileSource }>;
  skillOptions?: ComposerContextOption[];
  toolOptions?: ComposerContextOption[];
  currentUserId?: string | null;
  readOnly?: boolean;
}

export function SubThreadPanel({
  session,
  messages,
  hasMoreMessages = false,
  loadingEarlier = false,
  onLoadEarlier,
  streaming,
  resolveMessageAccent,
  onSendMessage,
  onAgentProfile,
  onClose,
  embedded = false,
  documents = [],
  agents = [],
  uploadedFiles = [],
  canvasGroups = [],
  onUploadFiles,
  composerProjectFiles = [],
  skillOptions = [],
  toolOptions = [],
  currentUserId,
  readOnly = false,
}: SubThreadPanelProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentions = useComposerMentions({ agents, workspaceId: session.workspace_id, inputRef });
  const [autoScroll, setAutoScroll] = useState(true);
  const [linkedFiles, setLinkedFiles] = useState<LinkedFile[]>([]);
  const [linkedDocs, setLinkedDocs] = useState<Document[]>([]);
  const [linkedGroups, setLinkedGroups] = useState<CanvasGroup[]>([]);
  const [addContextOpen, setAddContextOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const agentParticipants = participants.filter(p => p.kind === 'agent');
  // Consecutive tool steps — and the live "Thinking …" placeholder between them —
  // collapse into one chip row here too: same rules as the channel transcript, just
  // the compact spacing of a side panel. Decided approvals fold into their call's chip.
  const { byId: permissionRequestsById } = usePermissionRequests(session.workspace_id ?? null);
  const messageRows = useMemo(
    () => buildTranscriptRows(messages, undefined, message =>
      resolvePermissionRequest(message, permissionRequestsById),
    ),
    [messages, permissionRequestsById],
  );
  useComposerAutosize(inputRef, mentions.input);

  // Reactions and seen pills in a sub-thread.
  //
  // A sub-thread IS its own chat_session, so nothing here is thread-scoped: the
  // receipt hook takes `session.id` with a null thread parent, exactly like the
  // channel transcript. That is why this works at all without a server change —
  // the markers and the reaction route were already reachable, the panel simply
  // never rendered either.
  const reactionState = useMessageReactions(readOnly ? null : currentUserId);
  const { members: workspaceMembers } = useWorkspaceUsers(session.workspace_id ?? null);
  // A reader id is a human user id OR an agent id, so resolve against members
  // first and then the agent roster: an agent's name belongs in the tooltip
  // exactly like a person's.
  // One lookup, shared with the channel and the reply-thread panel — see
  // src/lib/readerFaces.ts. A face rather than a name because the chips show
  // WHO; `resolveReaderName` is the name-only view of the same thing.
  const resolveReaderFace = useMemo(
    () => buildReaderFaces({ members: workspaceMembers, agents }),
    [workspaceMembers, agents],
  );
  const resolveReaderName = useCallback(
    (readerId: string) => resolveReaderFace(readerId).name,
    [resolveReaderFace],
  );

  const receipts = useReadReceipts({
    sessionId: session.id || null,
    currentUserId: currentUserId || null,
    active: !readOnly,
    orderedMessages: messages,
  });
  const noteVisibleRead = receipts.noteVisible;
  // `nearBottom` is load-bearing: `messages` is the loaded data set, not the
  // viewport. Somebody scrolled up has a realtime append in the array that is
  // physically off screen, and marking it would claim a read that never happened.
  const newestVisibleMessage = useMemo(
    () => receiptTargetForViewport(messages, currentUserId || null, {
      surfaceActive: !readOnly,
      nearBottom: autoScroll,
    }),
    [autoScroll, currentUserId, messages, readOnly],
  );
  useEffect(() => {
    noteVisibleRead(newestVisibleMessage);
  }, [noteVisibleRead, newestVisibleMessage]);

  // No anchoring: every one of your own posts keeps its eye for as long as the
  // receipt is true, matching the channel. A read receipt is standing evidence
  // of what was taken in, not a transient notification.

  // "Queued": you posted while a turn was already running here, so this one is
  // next. Derived from the running job's start time — see src/lib/queuedPill.ts
  // for why a 'queued' job row is the wrong signal.
  const panelWork = useSessionWork(session.id || null);

  // For the Stop control's label: an agent id from a running job row, resolved
  // to the name this panel already shows.
  const resolveAgentName = useCallback(
    (agentId: string) => agents.find(row => String(row.id) === String(agentId))?.name || null,
    [agents],
  );
  // Same rule as the channel's status line: a placeholder stranded by a job that
  // died is not evidence that anyone is working.
  const activityAgents = useMemo(() => {
    const entries: { name: string; activity: string }[] = [];
    for (const m of messages) {
      if (!isLiveActivityPlaceholder(m)) continue;
      const name = (m.sender_name || 'Agent').trim();
      const activity = extractActivityVerb(safeText(m.content));
      if (name && !entries.find(e => e.name === name)) entries.push({ name, activity });
    }
    return entries;
  }, [messages]);

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

  const uploadAndLink = async (files: File[]) => {
    if (!files.length || !onUploadFiles) return;
    setUploadStatus('Uploading...');
    try {
      const uploaded = await onUploadFiles(files);
      setLinkedFiles(prev => {
        const existing = new Set(prev.map(f => f.id));
        const next = [...prev];
        for (const f of uploaded) {
          const linked = linkedUploadedFile(f);
          if (!existing.has(linked.id)) next.push(linked);
        }
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

  const handleSend = async () => {
    if (readOnly || streaming || !onSendMessage) return;
    let content = mentions.buildContent();
    if (!content) return;
    if (linkedFiles.length > 0) content = `${buildFileContext(linkedFiles)}\n\n${content}`;
    content = prependLinkedDocumentContext(content, linkedDocs);
    if (linkedGroups.length > 0) {
      const groupContext = linkedGroups.map(g => `[Canvas Group "${g.name}"]`).join('\n');
      content = `${groupContext}\n\n${content}`;
    }
    // Clear now, restore if the write is rejected — the sub-thread composer had
    // the same "typed text disappears into nothing" hole as the others.
    const draft = mentions.snapshot();
    const previousFiles = linkedFiles;
    const previousDocs = linkedDocs;
    const previousGroups = linkedGroups;
    mentions.clear();
    setLinkedFiles([]);
    setLinkedDocs([]);
    setLinkedGroups([]);
    inputRef.current?.focus();

    const attachments = buildMessageAttachments(linkedFiles);
    const outcome = await onSendMessage?.(content, attachments);
    if (outcome && outcome.delivered === false) {
      mentions.restore(draft);
      setLinkedFiles(previousFiles);
      setLinkedDocs(previousDocs);
      setLinkedGroups(previousGroups);
      inputRef.current?.focus();
    }
  };

  const handleScrollerScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromEnd = target.scrollHeight - target.scrollTop - target.clientHeight;
    setAutoScroll(distanceFromEnd < 32);
  };

  const handleComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadAndLink(files);
  };

  const handleComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleUploadSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await uploadAndLink(files);
  };

  const hasAttachments = linkedFiles.length > 0 || linkedDocs.length > 0 || linkedGroups.length > 0;

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
              className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-2 text-[11px] text-muted-foreground hover:text-foreground"
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
                  {messageRows.map(row => {
                    const isLastRow = row.index === messages.length - 1;
                    if (row.kind === 'steps') {
                      return (
                        <MessageScrollerItem key={row.key} scrollAnchor={isLastRow}>
                          <ToolStepGroup row={row} compact />
                        </MessageScrollerItem>
                      );
                    }
                    return (
                      <MessageScrollerItem key={row.message.id} scrollAnchor={isLastRow}>
                        <SubThreadBubble
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
                          resolveReaderFace={resolveReaderFace}
                          // Same rule as the channel: only YOUR messages carry
                          // an eye, and every one of them does for as long as
                          // the receipt is true. "Who read their post" is not a
                          // fact you can act on and would mark every row.
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

      {activityAgents.length > 0 && (
        <div className="composer-status flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="composer-status-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span className="truncate">
            {activityAgents.map(({ name, activity }, i) => (
              <React.Fragment key={name}>
                {i > 0 && (i === activityAgents.length - 1 ? ' and ' : ', ')}
                <span className="font-medium text-foreground">{name}</span>
                {' '}is {activity}
              </React.Fragment>
            ))}
            {'…'}
          </span>
          {/* Stop. Driven by agent_jobs, not by the line beside it — the
              activity text comes from placeholder messages, which carry no job
              id. A sub-thread IS its own chat_session, so this is the session
              control and it stops exactly this panel's turn. */}
          {session.id && (
            <SessionStopButton
              sessionId={session.id}
              resolveAgentName={resolveAgentName}
              className="ml-auto"
            />
          )}
        </div>
      )}

      {!readOnly && <div className={`${COMPOSER_SHELL_CLASS} shrink-0`}>
        {hasAttachments && (
          <div className="mb-2 flex flex-wrap gap-1.5">
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

        <div className="relative" onDrop={handleComposerDrop} onDragOver={handleComposerDragOver}>
          <ComposerMentionPicker m={mentions} />
          <ComposerMentionChips m={mentions} />
          <InputGroup className="h-auto flex-col items-stretch">
            <InputGroupTextarea
              ref={inputRef}
              value={mentions.input}
              onChange={mentions.onInputChange}
              onKeyDown={e => {
                if ((e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') && mentions.handleNavKey(e.key)) {
                  e.preventDefault();
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={SUB_THREAD_COMPOSER_PLACEHOLDER}
              disabled={streaming}
              rows={1}
              className={COMPOSER_TEXTAREA_CLASS}
              onInput={e => autosizeComposer(e.currentTarget)}
            />
            <InputGroupAddon align="block-end" className={COMPOSER_ADDON_CLASS}>
              <div className="flex items-center gap-1">
                <Popover open={addContextOpen} onOpenChange={setAddContextOpen}>
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
                      onAddUploadedFile={(file) => addLinkedFile(linkedUploadedFile(file))}
                      onAddProjectFile={(file, source) => addLinkedFile(linkedProjectFile(file, source))}
                      onAddDocument={addLinkedDoc}
                      onAddGroup={addLinkedGroup}
                      onAddAgent={(agent) => {
                        mentions.selectAgent(agent);
                        setAddContextOpen(false);
                        inputRef.current?.focus();
                      }}
                      onAddSkill={(skill) => {
                        mentions.setInput(`${mentions.input}Use skill: ${skill.label}. `);
                        setAddContextOpen(false);
                        inputRef.current?.focus();
                      }}
                      onAddTool={(tool) => {
                        mentions.setInput(`${mentions.input}Use tool: ${tool.label}. `);
                        setAddContextOpen(false);
                        inputRef.current?.focus();
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon-sm"
                  onClick={handleSend}
                  disabled={(!mentions.input.trim() && mentions.mentionedAgents.length === 0) || streaming}
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
      </div>}
    </aside>
  );
}

// A stable identity, so a read-only post's ReactionBar does not get a fresh
// callback on every render. It is never reachable: `reactions` is nulled on the
// same branch, so there are no pills to click.
const NOOP_TOGGLE = () => {};

export function SubThreadBubble({
  msg,
  accent,
  onAgentProfile,
  isStreaming,
  currentUserId,
  reactions,
  reactionUses = [],
  onToggleReaction,
  resolveReaderName,
  resolveReaderFace,
  readerIds,
  queued,
}: {
  msg: ChatMessage;
  accent?: string;
  onAgentProfile?: (agentIdOrHandle: string) => void;
  isStreaming?: boolean;
  currentUserId?: string | null;
  reactions?: Record<string, string[]>;
  reactionUses?: readonly ReactionUse[];
  onToggleReaction?: (reaction: string, op: 'add' | 'remove') => void;
  resolveReaderName?: (readerId: string) => string | null;
  /** Face lookup for the chips that show WHO — readers, reactors, agents worked behind. */
  resolveReaderFace?: (readerId: string) => ReaderFace;
  /** Undefined on a post that carries no seen pill; empty when nobody has read it. */
  readerIds?: string[];
  queued?: QueuedState;
}) {
  const isUser = msg.role === 'user';
  const ownMutation = useOwnMessageMutation(msg, currentUserId, safeText(msg.content));
  const content = ownMutation.content;
  const artifact = content ? extractHtmlArtifact(content) : null;
  const displayContent = artifact ? artifact.remainingText : content;
  const isActivityPlaceholder = isActivityPlaceholderMessage(msg);
  const placeholderActivity = isActivityPlaceholder ? extractActivityVerb(content) : 'thinking';
  const placeholderLabel = placeholderActivity.charAt(0).toUpperCase() + placeholderActivity.slice(1);
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
  // post nobody has read.
  // Seen, then queued, then the reactions — one row saying what happened to
  // this post, matching the channel. SETTLED: see the block at the top of
  // src/lib/seenPill.ts before moving any of it.
  const hasSeen = !isActivityPlaceholder && readerIds !== undefined && readerIds.length > 0;
  const seenPill = hasSeen || queued?.queued ? (
    <>
      {hasSeen && (
        <SeenPill
          readerIds={readerIds as string[]}
          resolveName={resolveReaderName || (() => null)}
          resolveFace={resolveReaderFace}
        />
      )}
      {queued?.queued && <QueuedPill state={queued} resolveFace={resolveReaderFace} />}
    </>
  ) : null;

  return (
    <div
      className="chat-thread-message flex min-w-0 gap-2 rounded-md px-2 py-1.5"
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
          ) : isActivityPlaceholder ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3" />
              {placeholderLabel}
            </span>
          ) : displayContent ? (
            <MarkdownContent content={displayContent} />
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
        {/* Reactions and the queued chip share one row, as in the channel. A
            placeholder ("Thinking …") is excluded: it is a transient row that
            will be replaced, and reacting to it would attach the reaction to a
            message about to disappear. */}
        {!isActivityPlaceholder && !ownMutation.editing && (onToggleReaction || seenPill) && (
          <ReactionBar
            reactions={onToggleReaction ? reactions : null}
            currentUserId={currentUserId || null}
            resolveName={resolveReaderName || (() => null)}
            onToggle={onToggleReaction ?? NOOP_TOGGLE}
            reactionUses={reactionUses}
            leadingSlot={seenPill}
            resolveFace={resolveReaderFace}
          />
        )}
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
