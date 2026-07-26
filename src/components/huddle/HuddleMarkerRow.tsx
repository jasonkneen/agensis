import { Headphones } from 'lucide-react';
import { cn } from '@/lib/utils';
import { huddleMarkerTarget } from '@/lib/huddleTranscript';
import type { Message } from '@/types';

// "You were in a huddle" — the ONE row a finished huddle leaves in the channel
// it was called from.
//
// The whole change is that a huddle's conversation no longer lands here. What
// replaces it is a single line: it happened, this long, these people. Rendered
// as a quiet strip rather than a chat bubble, because it is a fact about the
// channel and not something anyone said in it.
//
// The sentence comes from the server, stored verbatim in `content`. This
// component adds only the chrome and the link, so a marker written by a newer
// server still reads correctly here, and a marker read by an older client (or
// by search, or by an agent's context) is still a true sentence on its own.

interface HuddleMarkerRowProps {
  message: Message;
  /** Open this huddle's transcript. Omit and the row is a plain statement. */
  onOpen?: (huddleId: string) => void;
  className?: string;
}

export function HuddleMarkerRow({ message, onOpen, className }: HuddleMarkerRowProps) {
  const content = typeof message.content === 'string' ? message.content : '';
  const huddleId = huddleMarkerTarget(message);
  // No huddle id means the row cannot open anything — a marker whose huddle was
  // pruned, or one written before the column existed. It keeps its sentence and
  // loses only the link, rather than offering a button that does nothing.
  const canOpen = Boolean(huddleId && onOpen);

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 py-1 pl-2 text-xs text-muted-foreground',
        className,
      )}
      data-testid="huddle-marker"
    >
      <Headphones className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{content}</span>
      {canOpen && (
        <button
          type="button"
          className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
          onClick={() => onOpen?.(huddleId)}
        >
          Open transcript
        </button>
      )}
    </div>
  );
}
