import { Headphones } from 'lucide-react';
import { huddleGroupLabel, huddleMarkerTarget, HUDDLE_MARKER_KIND, type HuddleMarkerGroup } from '@/lib/huddleTranscript';

// ---------------------------------------------------------------------------
// A run of huddles, as one row.
//
// Ten stacked "You were in a huddle - 0:26  Open transcript" lines is ten rows
// of chrome for one fact, and it buried the conversation they sat in. A run of
// consecutive markers collapses to this: one quiet line, dated, with a small
// chip per huddle that still opens that huddle's own transcript.
//
// Chips wrap rather than scroll — a horizontal scroller inside a message list
// hides content behind a gesture nobody thinks to try, and the count here is
// small enough that two or three lines of chips is the worst case.
// ---------------------------------------------------------------------------

/** Same clock format the chat rows use — see ChatThreadPanel. */
function clockTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface Props {
  group: HuddleMarkerGroup;
  onOpen: (huddleId: string) => void;
}

export function HuddleMarkerGroupRow({ group, onOpen }: Props) {
  // The run's own span: first huddle's time through the last. Markers arrive
  // oldest-first, so the ends of the array are the ends of the period.
  const first = group.messages[0];
  const last = group.messages[group.messages.length - 1];
  const started = clockTime(first?.created_at ?? null);
  const ended = clockTime(last?.created_at ?? null);
  const period = started && ended && started !== ended ? `${started} - ${ended}` : started || ended;

  return (
    <div
      data-testid="huddle-marker-group"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1 py-1 text-xs text-muted-foreground"
    >
      <Headphones aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">
        {huddleGroupLabel(group)}
        {period ? ` - ${period}` : ''}
      </span>
      {group.messages.map((message, index) => {
        const target = huddleMarkerTarget({ ...message, message_kind: HUDDLE_MARKER_KIND });
        const label = `Open transcript ${index + 1} of ${group.messages.length}`;
        // A marker whose huddle row is gone keeps its place in the count as a
        // plain chip: the huddle happened, its transcript just cannot be opened.
        if (!target) {
          return (
            <span
              key={message.id}
              className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] opacity-60"
            >
              {index + 1}
            </span>
          );
        }
        return (
          <button
            key={message.id}
            type="button"
            onClick={() => onOpen(target)}
            aria-label={label}
            title={label}
            className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground"
          >
            {index + 1}
          </button>
        );
      })}
    </div>
  );
}
