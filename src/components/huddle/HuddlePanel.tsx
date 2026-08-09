import React, { useMemo, useRef, useState } from 'react';
import { Bot, Send, User } from 'lucide-react';
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
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Spinner } from '@/components/ui/spinner';
import { MarkdownContent } from '../chat/MarkdownContent';
import { ToolStepGroup } from '../chat/ToolStepGroup';
import { buildTranscriptRows } from '../chat/toolSteps';
import { COMPOSER_ADDON_CLASS, COMPOSER_SHELL_CLASS, COMPOSER_TEXTAREA_CLASS } from '@/lib/composerStyles';
import { useComposerAutosize } from '@/hooks/useComposerAutosize';
import { useHuddleRecord } from '@/hooks/useHuddle';
import { useHuddleTranscript } from '@/hooks/useHuddleTranscript';
import { huddleComposerPlaceholder, canComposeInHuddle, huddleTranscriptTarget } from '@/lib/huddleTranscript';
import { withAgentMention, type HuddleAgentOption } from '@/lib/huddleAgents';
import { isActivityPlaceholderMessage, extractActivityVerb } from '@/lib/activityStatus';
import { EMPTY_STREAM_RESPONSE } from '@/lib/chatStream';
import { useHuddleSession } from './HuddleSessionContext';
import type { Message } from '@/types';

// The huddle, as a place.
//
// A huddle is ad-hoc; the channel is the record. Transcribed speech used to be
// posted into the host channel as ordinary messages, which made a live voice
// call part of the channel's permanent history — a dictation system. It now
// lands in the huddle's OWN session and is rendered here, and the channel gets
// one marker row when the call ends.
//
// This panel renders the conversation and lets you type into it. It does NOT
// own the call: LiveKit, the microphone and the speech pipeline all live in
// the huddle card, which stays mounted in the channel header for the whole call.
// Legacy huddles fall back to their host channel; new huddles use their private
// transcript session.

interface HuddlePanelProps {
  workspaceId: string | null;
  /**
   * Show this specific huddle rather than the channel's current one. Set by a
   * "You were in a huddle" marker, which may point at a huddle from months ago.
   */
  huddleId?: string | null;
  /** The channel's agents, in roster order. Empty in a DM. */
  agents?: HuddleAgentOption[];
  /** Which of them a typed message is addressed to. Mirrors the voice strip. */
  activeAgentId?: string;
  /**
   * 'chat' (default) is the interactive view — same content plus a composer to
   * type into the call. 'transcript' is the read-only record of everything
   * said and typed, minutes-style, with no composer: the dock's Chat and
   * Transcript tabs used to render this exact same component and were
   * genuinely indistinguishable, which is the bug this prop fixes.
   */
  mode?: 'chat' | 'transcript';
}

const NO_AGENTS: HuddleAgentOption[] = [];

export function HuddlePanel({
  workspaceId,
  huddleId = null,
  agents = NO_AGENTS,
  activeAgentId = '',
  mode = 'chat',
}: HuddlePanelProps) {
  const session = useHuddleSession();
  const current = session?.state ?? null;

  // A marker can point at a huddle that is not this channel's current one, so
  // fetch only in that case. Passing null keeps the hook inert rather than
  // making the call conditional.
  const needsFetch = Boolean(huddleId && huddleId !== current?.id);
  const fetched = useHuddleRecord(workspaceId, needsFetch ? huddleId : null);
  const state = needsFetch ? fetched.state : current;

  const transcriptSessionId = huddleTranscriptTarget(state, state?.sessionId ?? null) || null;
  const transcript = useHuddleTranscript(workspaceId, transcriptSessionId);

  const activeAgent = useMemo(
    () => agents.find(agent => agent.id === activeAgentId) || agents[0] || null,
    [agents, activeAgentId],
  );

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useComposerAutosize(inputRef, input);

  const rows = useMemo(() => buildTranscriptRows(transcript.messages), [transcript.messages]);

  const handleSend = async () => {
    const body = input.trim();
    if (!body) return;
    setInput('');
    inputRef.current?.focus();
    // Typing and speaking take the SAME path: the active agent's handle is
    // prefixed so the ordinary mention route dispatches it. Without this a
    // typed line in a channel huddle would wake nobody, exactly as a plain
    // channel message does.
    const sent = await transcript.send(activeAgent ? withAgentMention(body, activeAgent.handle) : body);
    if (!sent) setInput(body);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void handleSend();
  };

  return (
    // NO CHROME OF ITS OWN. This panel is only ever mounted inside HuddleDock
    // (tests/unit/huddleSingleCall.test.ts pins that), and the dock already
    // renders the title, the timer, the participant avatars and the close
    // button. Rendering them here too gave one huddle two headers, two running
    // timers and two close buttons stacked on top of each other, and pushed the
    // transcript — the only thing here that is not repeated somewhere else —
    // into the bottom third of the dock.
    //
    // The roster went with them: "1 in the huddle / God Emperor Jason / With
    // Coder" is three lines of text restating the avatar row directly above it.
    // The avatars carry each name in a title attribute.
    <div className="flex h-full min-w-0 flex-col text-card-foreground">
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="channel-message-surface flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="min-h-full gap-3 p-3">
              {!state ? (
                <PanelNotice
                  title={fetched.loading ? 'Loading the huddle' : 'No huddle here yet'}
                  body={fetched.loading
                    ? 'One moment.'
                    : 'Start one from the channel toolbar and the conversation appears here.'}
                />
              ) : !transcriptSessionId ? (
                <PanelNotice
                  title="This huddle has no transcript"
                  body="There is no conversation session attached to this huddle."
                />
              ) : transcript.loading ? (
                <PanelNotice title="Loading the transcript" body="One moment." />
              ) : transcript.messages.length === 0 ? (
                <PanelNotice
                  title={state.active ? 'Nothing said yet' : 'Nothing was said'}
                  body={state.active
                    ? (mode === 'transcript'
                      ? 'This fills in as the call happens.'
                      : activeAgent
                        ? `Talk or type — @${activeAgent.handle} is listening.`
                        : 'Talk or type and it lands here, not in the channel.')
                    : 'This huddle ended without anything being transcribed.'}
                />
              ) : (
                <div className="flex min-w-0 flex-col gap-1">
                  {rows.map(row => {
                    const isLastRow = row.index === transcript.messages.length - 1;
                    if (row.kind === 'steps') {
                      return (
                        <MessageScrollerItem key={row.key} scrollAnchor={isLastRow}>
                          <ToolStepGroup row={row} compact />
                        </MessageScrollerItem>
                      );
                    }
                    return (
                      <MessageScrollerItem key={row.message.id} scrollAnchor={isLastRow}>
                        <HuddleBubble msg={row.message} />
                      </MessageScrollerItem>
                    );
                  })}
                </div>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>

      {transcript.error && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-destructive">
          {transcript.error}
        </div>
      )}

      {/* Typing is offered only in Chat mode, while the huddle is live and has
          somewhere of its own to put the words. A composer over an ended huddle
          would write into a transcript nobody is reading, and Transcript mode
          is the read-only minutes view on purpose — that's what makes it a
          different tab from Chat instead of the same panel twice. */}
      {canComposeInHuddle(mode, state) && (
        <div className="shrink-0 border-t border-border p-2">
          <InputGroup className={COMPOSER_SHELL_CLASS}>
            <InputGroupTextarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={huddleComposerPlaceholder(activeAgent?.handle || '')}
              className={COMPOSER_TEXTAREA_CLASS}
            />
            <InputGroupAddon align="block-end" className={COMPOSER_ADDON_CLASS}>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                Stays in this huddle, not in the channel
              </span>
              <InputGroupButton
                type="button"
                size="icon-xs"
                disabled={!input.trim()}
                onClick={() => void handleSend()}
                aria-label="Send"
              >
                <Send />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      )}
    </div>
  );
}

function PanelNotice({ title, body }: { title: string; body: string }) {
  return (
    <Empty className="min-h-full border-0 p-4">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function HuddleBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user';
  const content = typeof msg.content === 'string' ? msg.content : '';
  const placeholder = isActivityPlaceholderMessage(msg);
  const verb = placeholder ? extractActivityVerb(content) : '';
  const senderName = msg.sender_name || (isUser ? 'You' : 'Assistant');
  const createdAt = msg.created_at ? new Date(msg.created_at) : null;
  const timeLabel = createdAt && Number.isFinite(createdAt.getTime())
    ? createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="chat-thread-message flex min-w-0 gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs font-semibold text-foreground">{senderName}</span>
          {timeLabel && <span className="shrink-0 text-[11px] text-muted-foreground">{timeLabel}</span>}
        </div>
        <div className="mt-0.5 text-sm leading-relaxed text-foreground">
          {placeholder ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3" />
              {verb.charAt(0).toUpperCase() + verb.slice(1)}
            </span>
          ) : content ? (
            <MarkdownContent content={content} />
          ) : !isUser ? (
            <span className="text-muted-foreground">{EMPTY_STREAM_RESPONSE}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
