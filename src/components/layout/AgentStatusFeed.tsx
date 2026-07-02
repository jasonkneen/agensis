import * as React from 'react';
import { Bot, X, ChevronRight, ChevronDown } from 'lucide-react';
import { isImageAvatar, isPetSpritesheetAvatar, renderablePetAssetUrl } from '../../lib/openpets';
import type { AgentStatusFeedState, AgentStatusUpdate } from '../../hooks/useAgentStatusFeed';

/**
 * Pixel-styled agent status bubble pinned to the bottom of the sidebar. Shows
 * the current agent's avatar and types out its latest status line in a bitmap
 * font, notification-queue style. All pixel chrome is CSS (see .pixel-* in
 * index.css); the avatar reuses the app's spritesheet/image/fallback branches so
 * animated pets still animate here.
 */
// Let the pet act out the update: acting busy = running, wrapped up = waving,
// anything else = idle. The kind already rides on every queued update, so this
// is expression for free — no new data, no new assets.
function petStateForKind(kind: AgentStatusUpdate['kind']) {
  if (kind === 'start' || kind === 'activity') return 'running';
  if (kind === 'done') return 'waving';
  return 'idle';
}

function FeedAvatar({ avatar, kind }: { avatar: string | null; kind: AgentStatusUpdate['kind'] }) {
  if (avatar && isPetSpritesheetAvatar(avatar)) {
    return (
      <span className="animated-pet-avatar-shell size-8 shrink-0 rounded-sm">
        <span
          className="animated-pet-avatar pixel-avatar"
          data-pet-state={petStateForKind(kind)}
          style={{ backgroundImage: `url(${renderablePetAssetUrl(avatar)})` }}
        />
      </span>
    );
  }
  const src = avatar && isImageAvatar(avatar) ? renderablePetAssetUrl(avatar) : undefined;
  // Whatever the agent was assigned, show it. Image → the image; a short text
  // avatar (e.g. "MI", "AI") → those initials, not a generic robot; only a
  // truly empty avatar falls back to the Bot glyph.
  const initials = !src && avatar ? avatar.trim().slice(0, 2).toUpperCase() : '';
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm border-2 border-border bg-muted">
      {src ? (
        <img src={src} alt="" className="pixel-avatar size-full object-cover" />
      ) : initials ? (
        <span className="pixel-font text-[8px] leading-none text-foreground">{initials}</span>
      ) : (
        <Bot className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

/** Types the text out one character at a time; resets when the line changes. */
function useTypewriter(text: string, speed = 28) {
  const [shown, setShown] = React.useState('');
  React.useEffect(() => {
    setShown('');
    if (!text) return;
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(timer);
    }, speed);
    return () => window.clearInterval(timer);
  }, [text, speed]);
  const done = shown.length >= text.length;
  return { shown, done };
}

/** One row in the expanded notification tray — its own bubble, its own dismiss. */
function FeedRow({ update, onDismiss }: { update: AgentStatusUpdate; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-2">
      <FeedAvatar avatar={update.avatar} kind={update.kind} />
      <div className="min-w-0 flex-1">
        <div className="pixel-bubble min-w-0">
          <div className="pixel-font flex items-center gap-1 text-[7px] uppercase text-muted-foreground">
            <span className="truncate">{update.handle ? `@${update.handle}` : update.name}</span>
            <button type="button" className="pixel-btn ml-auto" onClick={onDismiss} aria-label="Dismiss update">
              <X className="size-2.5" />
            </button>
          </div>
          <div className="pixel-font mt-1 break-words text-[8px] text-foreground">{update.text}</div>
        </div>
      </div>
    </div>
  );
}

export function AgentStatusFeed({ feed }: { feed: AgentStatusFeedState }) {
  const { current, queue, pending, expanded } = feed;
  const { shown, done } = useTypewriter(current?.text ?? '');

  if (!current) return null;

  if (expanded) {
    // flex-col-reverse: DOM order stays oldest→newest (current last, matching
    // the collapsed view's anchor point) but renders bottom-to-top, so the
    // newest update sits at the top of the stack and the tray visibly grows
    // upward off the bottom-anchored portal as more updates queue in.
    const rest = queue.slice(1);
    return (
      <div className="flex flex-col-reverse gap-1.5 px-2 pt-1" aria-live="polite">
        <FeedRow update={current} onDismiss={feed.dismiss} />
        {rest.map(update => (
          <FeedRow key={update.id} update={update} onDismiss={() => feed.dismissOne(update.id)} />
        ))}
        <div className="flex items-center gap-2 pl-10">
          <button type="button" className="pixel-btn" onClick={feed.toggleExpanded} aria-label="Collapse updates">
            <ChevronDown className="size-2.5" />
          </button>
          <span className="pixel-font text-[7px] uppercase text-muted-foreground">
            {queue.length} update{queue.length === 1 ? '' : 's'}
          </span>
          {queue.length > 1 && (
            <button type="button" className="pixel-btn ml-auto" onClick={feed.dismissAll} aria-label="Clear all updates">
              CLR ALL
            </button>
          )}
        </div>
      </div>
    );
  }

  // Ghost cards peeking out behind the current bubble hint at the queued
  // backlog, notification-stack style, without needing the count badge read.
  const stackDepth = Math.min(pending, 2);

  return (
    <div className="flex items-start gap-2 px-2 pt-1" aria-live="polite">
      <FeedAvatar avatar={current.avatar} kind={current.kind} />
      <div className="min-w-0 flex-1">
        <div className="relative min-w-0">
          {Array.from({ length: stackDepth }).map((_, i) => (
            <div
              key={i}
              aria-hidden
              className="pixel-bubble pointer-events-none absolute inset-x-0 top-0 z-0"
              style={{
                transform: `translateY(${-4 * (i + 1)}px) scale(${1 - 0.04 * (i + 1)})`,
                opacity: 0.45 - i * 0.15,
              }}
            />
          ))}
          <div className="pixel-bubble relative z-10 min-w-0">
            <div className="pixel-font flex items-center gap-1 text-[7px] uppercase text-muted-foreground">
              <span className="truncate">{current.handle ? `@${current.handle}` : current.name}</span>
              {pending > 0 && (
                <button
                  type="button"
                  className="pixel-btn shrink-0"
                  style={{ borderColor: 'var(--primary)', color: 'var(--primary)' }}
                  onClick={feed.toggleExpanded}
                  aria-label={`Show ${pending} more update${pending === 1 ? '' : 's'}`}
                >
                  +{pending}
                </button>
              )}
            </div>
            <div className={`pixel-font mt-1 break-words text-[8px] text-foreground ${done ? '' : 'pixel-caret'}`}>
              {shown}
            </div>
            <div className="mt-2 flex items-center gap-1">
              {pending > 0 && (
                <button type="button" className="pixel-btn" onClick={feed.next} aria-label="Next update">
                  <ChevronRight className="size-2.5" />
                </button>
              )}
              <button type="button" className="pixel-btn" onClick={feed.dismiss} aria-label="Dismiss update">
                <X className="size-2.5" />
              </button>
              {pending > 0 && (
                <button type="button" className="pixel-btn ml-auto" onClick={feed.dismissAll} aria-label="Clear all updates">
                  CLR
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
