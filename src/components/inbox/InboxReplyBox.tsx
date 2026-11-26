import { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from '@agensis/ui/components/input-group';
import { backendClient } from '../../lib/backendClient';
import { useComposerMentions } from '../../hooks/useComposerMentions';
import { useComposerAutosize } from '@/hooks/useComposerAutosize';
import { COMPOSER_ADDON_CLASS, COMPOSER_TEXTAREA_CLASS, autosizeComposer } from '@/lib/composerStyles';
import { ComposerMentionChips, ComposerMentionPicker } from '../chat/ComposerMentionUI';
import { ComposerSendButton } from '../chat/ComposerParts';
import { threadRootOf, type InboxReplyTarget } from './inboxSources';
import type { InboxOpenSession, InboxReplyInThread } from './inboxNavigation';
import type { WorkspaceAgent } from '../../types';

// ---------------------------------------------------------------------------
// "Write a comment…" at the foot of the reading pane.
//
// It is a thread reply and nothing else: the words go through the thread
// panel's own send path (App's sendMessage with a threadParentId), so an @agent
// in them is routed by the same mention router and the agent answers IN that
// thread. The inbox then opens the thread beside itself, which is where the
// conversation continues — the inbox does not grow a second transcript.
//
// The mention picker is the shared one (useComposerMentions + ComposerMentionUI)
// with documents left out: agents become @handle chips, and `@channel` typed as
// text addresses everyone in the channel exactly as it does in any composer.
//
// Send order matters. The thread opens BEFORE the send, not after it resolves,
// because sendMessage only resolves once the dispatch (or a direct-AI stream)
// is done, and holding the box frozen for a whole agent turn would be the bug. The draft
// is snapshotted first and put back if the message never reached the database.
// ---------------------------------------------------------------------------

interface InboxReplyBoxProps {
  target: InboxReplyTarget;
  workspaceId: string | null;
  agents?: WorkspaceAgent[];
  onReply: InboxReplyInThread;
  onOpenSession?: InboxOpenSession;
}

/** The root of the thread a mention's message lives in, or '' when it cannot be read. */
async function lookupThreadRoot(sessionId: string, messageId: string): Promise<string> {
  const result = await backendClient
    .from('messages')
    .select('id, thread_parent_id')
    .eq('session_id', sessionId)
    .eq('id', messageId)
    .limit(1);
  if (result.error || !Array.isArray(result.data) || result.data.length === 0) return '';
  return threadRootOf(result.data[0] as { id?: unknown; thread_parent_id?: unknown });
}

export function InboxReplyBox({ target, workspaceId, agents, onReply, onOpenSession }: InboxReplyBoxProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const m = useComposerMentions({ agents, workspaceId, inputRef });
  // Only true across the (short) thread-root lookup — never across the send.
  const [resolving, setResolving] = useState(false);
  useComposerAutosize(inputRef, m.input);

  const empty = !m.input.trim() && m.mentionedAgents.length === 0;

  const send = async () => {
    if (resolving) return;
    const content = m.buildContent();
    if (!content) return;

    let threadRootId = target.threadRootId;
    if (!threadRootId) {
      setResolving(true);
      threadRootId = await lookupThreadRoot(target.sessionId, target.messageId).catch(() => '');
      setResolving(false);
      if (!threadRootId) {
        toast.error('Could not find the message to reply to. Your comment is still in the box.');
        return;
      }
    }

    const draft = m.snapshot();
    m.clear();
    const thread = { sessionId: target.sessionId, threadParentId: threadRootId };
    onOpenSession?.({ ...thread, beside: true });
    // Let the open land first. useChat only keeps the optimistic row (and its
    // realtime INSERT) for the session that is ACTIVE when the send runs, and
    // opening makes it active on the next render — sent in the same tick, the
    // reply would be dropped from the thread that just opened until a refetch.
    // Same settle App's handleCreateCustomApplet gives a freshly opened chat.
    await new Promise(resolve => setTimeout(resolve, 100));

    const outcome = await onReply(thread, content);
    if (!outcome.delivered) {
      // Put the words back. If this pane has moved on to another item the
      // restore lands nowhere, so the toast is what tells the person.
      m.restore(draft);
      toast.error('Your comment was not sent.', {
        description: outcome.failure?.reason || 'It was put back in the box so you can try again.',
      });
    }
  };

  return (
    <div className="relative shrink-0 border-t border-border/60 p-2" data-inbox-reply="">
      <ComposerMentionPicker m={m} />
      <ComposerMentionChips m={m} />
      <InputGroup className="h-auto flex-col items-stretch">
        <InputGroupTextarea
          ref={inputRef}
          value={m.input}
          onChange={m.onInputChange}
          onKeyDown={event => {
            if ((event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') && m.handleNavKey(event.key)) {
              event.preventDefault();
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Write a comment… @ an agent to hand it over"
          aria-label="Write a comment"
          disabled={resolving}
          rows={1}
          className={COMPOSER_TEXTAREA_CLASS}
          onInput={event => autosizeComposer(event.currentTarget)}
        />
        <InputGroupAddon align="block-end" className={COMPOSER_ADDON_CLASS}>
          <span className="truncate text-2xs text-muted-foreground">Posts as a reply in the thread</span>
          <ComposerSendButton
            onClick={() => void send()}
            disabled={empty || resolving}
            busy={resolving}
            label="Send comment"
          />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
