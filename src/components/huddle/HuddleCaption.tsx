import { useEffect, useRef } from 'react';
import { Mic, MicOff, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { trailingCaption } from '@/lib/huddleVoice';

/**
 * The live voice line: what we are hearing, and who is talking back.
 *
 * Deliberately one row of small text rather than a panel — it has to be
 * readable at a glance mid-sentence and invisible the rest of the time. It
 * lived inside the huddle card until the call moved into the dock; it is its
 * own file now because it is rendered next to the call, wherever that is.
 */
export function HuddleCaption({
  transcribing,
  micEnabled,
  listening,
  interim,
  inputError,
  inputUnavailable,
  outputUnavailable,
  outputMuted,
  speakingName,
  activeHandle,
  engineNotice,
  transcriptInHuddle = true,
  className,
}: {
  transcribing: boolean;
  micEnabled: boolean;
  listening: boolean;
  interim: string;
  inputError: string;
  inputUnavailable: string;
  outputUnavailable: string;
  outputMuted: boolean;
  speakingName: string;
  /** Handle of the agent your voice is addressed to, or '' in a DM. */
  activeHandle: string;
  /** '' when Deepgram and Cartesia are both in use; otherwise which one is not. */
  engineNotice: string;
  /** Legacy huddles persist voice in the host channel rather than a private session. */
  transcriptInHuddle?: boolean;
  className?: string;
}) {
  // Input is suppressed while a reply plays, so "listening" must not claim
  // otherwise — the indicator has to match what the mic is actually doing.
  const hearing = transcribing && listening && micEnabled && !speakingName && !inputUnavailable;

  let status = '';
  let tone = 'text-muted-foreground';
  // True only for the live transcript, which is the one line that must follow
  // its own tail rather than showing its beginning.
  let follow = false;
  if (inputError) {
    status = inputError;
    tone = 'text-destructive';
  } else if (transcribing && inputUnavailable) {
    status = inputUnavailable;
  } else if (!micEnabled) {
    status = activeHandle
      ? `Mic muted — unmute to talk to @${activeHandle}.`
      : 'Mic muted — unmute to talk in this huddle.';
  } else if (speakingName) {
    status = 'Paused while the reply plays.';
  } else if (interim) {
    status = trailingCaption(interim);
    tone = 'text-foreground/80 italic';
    follow = true;
  } else if (engineNotice) {
    // A downgrade is a persistent state, not a toast, so it holds the line
    // whenever nothing more urgent is happening. Silently running on the
    // fallback engine is the bug class this pipeline exists to remove: the
    // difference between Cartesia and speechSynthesis is audible, and someone
    // who cannot see why will report it as "the voice changed".
    status = engineNotice;
  } else if (hearing) {
    // Naming the addressee here is the cheapest place to answer "who am I
    // talking to" in words, and it teaches the say-a-name switch by example.
    status = activeHandle
      ? `Listening — @${activeHandle} hears you. Use the agent switcher to change the floor.`
      : transcriptInHuddle
        ? 'Listening — what you say goes in the huddle, not the channel.'
        : 'Listening — what you say goes in the channel.';
  } else if (transcribing) {
    status = 'Starting the microphone…';
  } else if (outputUnavailable) {
    status = outputUnavailable;
  }

  // Live captions scroll: `truncate` clips the END, which in a narrow window
  // hides the words being said RIGHT NOW and freezes the line on the start of
  // the sentence — the opposite of what this row is for. Fixed statuses read
  // from the beginning, so they only scroll back.
  const trackRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollLeft = follow ? el.scrollWidth : 0;
  }, [status, follow]);

  return (
    <div
      className={cn('flex w-full min-w-0 items-center gap-2 text-[11px] leading-tight', className)}
      data-testid="huddle-caption"
    >
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 font-medium',
          hearing ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
        )}
      >
        {hearing ? (
          <Mic className="size-3 animate-pulse motion-reduce:animate-none" aria-hidden />
        ) : (
          <MicOff className="size-3" aria-hidden />
        )}
        {hearing ? 'Hearing you' : 'Mic idle'}
      </span>

      <span
        ref={trackRef}
        className={cn('min-w-0 flex-1 overflow-hidden whitespace-nowrap', follow ? '' : 'text-ellipsis', tone)}
        aria-live="polite"
      >
        {status}
      </span>

      {speakingName && !outputMuted && (
        <span className="flex shrink-0 items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
          <Volume2 className="size-3 animate-pulse motion-reduce:animate-none" aria-hidden />
          <span className="max-w-24 truncate">{speakingName}</span>
        </span>
      )}
    </div>
  );
}
