import * as React from 'react';
import { Bot, X, ChevronRight } from 'lucide-react';
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
  if (kind === 'start') return 'running';
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
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm border-2 border-border bg-muted">
      {src ? (
        <img src={src} alt="" className="pixel-avatar size-full object-cover" />
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

export function AgentStatusFeed({ feed }: { feed: AgentStatusFeedState }) {
  const { current, pending } = feed;
  const { shown, done } = useTypewriter(current?.text ?? '');

  if (!current) return null;

  return (
    <div className="flex items-start gap-2 px-2 pt-1" aria-live="polite">
      <FeedAvatar avatar={current.avatar} kind={current.kind} />
      <div className="min-w-0 flex-1">
        <div className="pixel-bubble min-w-0">
          <div className="pixel-font flex items-center gap-1 text-[7px] uppercase text-muted-foreground">
            <span className="truncate">{current.handle ? `@${current.handle}` : current.name}</span>
            {pending > 0 && <span className="shrink-0 text-primary">+{pending}</span>}
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
  );
}
