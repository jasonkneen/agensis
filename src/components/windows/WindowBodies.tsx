// Window bodies: one component per window, so React.memo actually holds.
//
// A closure written inside App's `renderedWindows.map` is a brand-new reference
// on every render. React.memo compares props shallowly, so a single inline arrow
// misses the compare and re-renders the whole subtree — and ChatWindowContent is
// ~3.8k lines. Before this, the memo wraps on the window contents were paying
// nothing: every App state change (a streamed token, a cursor frame) re-rendered
// every open window.
//
// Hooks can't be called inside a map, so each window body is its own component:
// that makes useCallback legal per window and gives the memo stable references
// to compare against.
//
// App's EMPTY_MESSAGES const exists for the same reason — `messages={... : []}`
// allocated a fresh array for every non-active chat window on every render.
//
// tests/unit/windowBodies.test.ts fails if any of this regresses.

import { useCallback, useMemo, type ComponentProps } from 'react';
import { ChatWindowContent } from './ChatWindowContent';
import { DocWindowContent } from './DocWindowContent';
import { AppletDocWindowContent } from './AppletDocWindowContent';
import { TasksWindowContent } from './TasksWindowContent';
import { APPLETS_FOLDER } from '../../lib/canvasApps';
import type { SendMessageResult } from '../../hooks/useChat';
import { useSessionMessages } from '../../hooks/useSessionMessages';
import { channelMessages } from '../chat/channelView';
import { isToolStepMessage } from '../chat/toolSteps';
import type {
  ChatSession,
  Document,
  FloatingWindow,
  MemoryFact,
  Message,
  MessageAttachment,
} from '../../types';

const NO_MESSAGES: Message[] = [];

export type ChatWindowBodyProps = Omit<
  ComponentProps<typeof ChatWindowContent>,
  'sessionId' | 'onSendMessage' | 'onSendThreadReply' | 'onSplitThread' | 'onTypingChange'
> & {
  winSession: ChatSession | undefined;
  isActiveSession: boolean;
  /**
   * `useItemPresence().setTyping`. Bound to this window's session below, so
   * ChatWindowContent gets a stable `(typing: boolean) => void` and the memo
   * still holds.
   */
  onAppTypingChange?: (type: 'chat' | 'document', itemId: string, typing: boolean) => void;
  onAppSendMessage: (
    content: string,
    model: string,
    facts?: MemoryFact[],
    docs?: Document[],
    threadParentId?: string | null,
    targetSession?: ChatSession | null,
    // Thread composer's "Send to channel": also show this reply in the channel.
    broadcastToChannel?: boolean,
    // Structured uploaded-file references for rendering (messages.attachments).
    attachments?: MessageAttachment[],
    // `delivered: false` means the message was rolled back and is nowhere —
    // the composer has to put the draft back.
  ) => Promise<SendMessageResult>;
  onSetActiveSession: (session: ChatSession) => void;
  onAppSplitThread: (source: ChatSession) => void;
};

export function ChatWindowBody({
  winSession,
  isActiveSession,
  onAppSendMessage,
  onSetActiveSession,
  onAppSplitThread,
  onAppTypingChange,
  ...contentProps
}: ChatWindowBodyProps) {
  const { memoryFacts, activeThreadId } = contentProps;
  const sessionId = winSession?.id ?? null;
  const inactive = useSessionMessages(isActiveSession ? null : sessionId);
  const inactiveTopLevelMessages = useMemo(
    () => channelMessages(inactive.messages),
    [inactive.messages],
  );
  const inactiveThreadReplyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const message of inactive.messages) {
      if (message.thread_parent_id && !isToolStepMessage(message)) {
        counts[message.thread_parent_id] = (counts[message.thread_parent_id] || 0) + 1;
      }
    }
    return counts;
  }, [inactive.messages]);

  const handleSendMessage = useCallback(
    (content: string, mf?: MemoryFact[], docs?: Document[], attachments?: MessageAttachment[]) => {
      if (winSession && !isActiveSession) onSetActiveSession(winSession);
      return onAppSendMessage(content, 'auto', mf, docs, null, winSession || null, undefined, attachments);
    },
    [winSession, isActiveSession, onSetActiveSession, onAppSendMessage],
  );

  const handleSendThreadReply = useCallback(
    (content: string, broadcastToChannel?: boolean) => {
      if (winSession && !isActiveSession) onSetActiveSession(winSession);
      return onAppSendMessage(content, 'auto', memoryFacts, undefined, activeThreadId, winSession || null, broadcastToChannel);
    },
    [winSession, isActiveSession, onSetActiveSession, onAppSendMessage, memoryFacts, activeThreadId],
  );

  const handleSplitThread = useCallback(() => {
    if (winSession) onAppSplitThread(winSession);
  }, [winSession, onAppSplitThread]);

  const handleTypingChange = useCallback((typing: boolean) => {
    if (!sessionId || !onAppTypingChange) return;
    onAppTypingChange('chat', sessionId, typing);
  }, [sessionId, onAppTypingChange]);

  return (
    <ChatWindowContent
      {...contentProps}
      sessionId={sessionId || null}
      messages={isActiveSession ? contentProps.messages : inactive.messages}
      topLevelMessages={isActiveSession
        ? contentProps.topLevelMessages
        : inactiveTopLevelMessages}
      hasMoreMessages={isActiveSession
        ? contentProps.hasMoreMessages
        : inactive.hasMore}
      loadingEarlier={isActiveSession
        ? contentProps.loadingEarlier
        : inactive.loadingEarlier}
      onLoadEarlier={isActiveSession
        ? contentProps.onLoadEarlier
        : inactive.loadEarlier}
      threadMessages={isActiveSession ? contentProps.threadMessages : NO_MESSAGES}
      threadReplyCounts={isActiveSession
        ? contentProps.threadReplyCounts
        : inactiveThreadReplyCounts}
      activeThreadId={isActiveSession ? contentProps.activeThreadId : null}
      streaming={isActiveSession ? contentProps.streaming : false}
      onSendMessage={handleSendMessage}
      onSendThreadReply={handleSendThreadReply}
      onSplitThread={winSession ? handleSplitThread : undefined}
      onTypingChange={sessionId && onAppTypingChange ? handleTypingChange : undefined}
    />
  );
}

export type DocWindowBodyProps = Omit<
  ComponentProps<typeof DocWindowContent>,
  'onDelete' | 'onTitleChange'
> & {
  windowId: string;
  onDeleteDocument: (id: string) => void;
  onCloseWindow: (winId: string) => void;
  onUpdateWindow: (id: string, updates: Partial<FloatingWindow>) => void;
  onRequestConfirm: (confirm: {
    title: string;
    description: string;
    actionLabel: string;
    onConfirm: () => void | Promise<void>;
  }) => void;
  // Only used when document.folder === APPLETS_FOLDER (see below) — adds the
  // doc's saved HTML to the current canvas as an applet object.
  onAddToCanvasApplet?: (doc: Document) => void;
};

export function DocWindowBody({
  windowId,
  onDeleteDocument,
  onCloseWindow,
  onUpdateWindow,
  onRequestConfirm,
  onAddToCanvasApplet,
  ...contentProps
}: DocWindowBodyProps) {
  const handleDelete = useCallback(
    (id: string) => {
      onRequestConfirm({
        title: 'Delete this document?',
        description: 'This removes the document from the workspace.',
        actionLabel: 'Delete',
        onConfirm: async () => {
          await onDeleteDocument(id);
          onCloseWindow(windowId);
        },
      });
    },
    [onRequestConfirm, onDeleteDocument, onCloseWindow, windowId],
  );

  const handleTitleChange = useCallback(
    (title: string) => onUpdateWindow(windowId, { title }),
    [onUpdateWindow, windowId],
  );

  // Applets are stored as documents so the Canvas Apps picker can list them,
  // but their body is source code, not prose — DocWindowContent is a
  // contentEditable rich-text editor that sanitizes (and would strip
  // <script>/<style>) on every autosave. Route folder === APPLETS_FOLDER docs
  // to the plain-text code editor + live preview instead.
  if (contentProps.document.folder === APPLETS_FOLDER) {
    return (
      <AppletDocWindowContent
        {...contentProps}
        onDelete={handleDelete}
        onTitleChange={handleTitleChange}
        onAddToCanvas={onAddToCanvasApplet}
      />
    );
  }

  return (
    <DocWindowContent {...contentProps} onDelete={handleDelete} onTitleChange={handleTitleChange} />
  );
}

export type TasksWindowBodyProps = Omit<
  ComponentProps<typeof TasksWindowContent>,
  'onFocusTaskConsumed'
> & {
  windowId: string;
  onUpdateWindow: (id: string, updates: Partial<FloatingWindow>) => void;
};

export function TasksWindowBody({
  windowId,
  onUpdateWindow,
  ...contentProps
}: TasksWindowBodyProps) {
  const handleFocusTaskConsumed = useCallback(
    () => onUpdateWindow(windowId, { focusTaskId: undefined }),
    [onUpdateWindow, windowId],
  );

  return <TasksWindowContent {...contentProps} onFocusTaskConsumed={handleFocusTaskConsumed} />;
}
