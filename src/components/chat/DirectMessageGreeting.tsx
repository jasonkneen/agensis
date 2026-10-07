import { useEffect, useState } from 'react';
import { Compass, GitCommitHorizontal, Sparkles } from 'lucide-react';
import { AgentAvatar } from '../agents/AgentAvatar';

const STARTERS = [
  'Catch me up on what changed in this workspace today',
  'Review my open tasks and suggest what to do first',
  'Help me plan the next step',
];
const ICONS = [GitCommitHorizontal, Sparkles, Compass];

function partOfDay(hour: number): string {
  if (hour < 5) return 'tonight';
  if (hour < 12) return 'this morning';
  if (hour < 18) return 'this afternoon';
  return 'this evening';
}

/** "this afternoon" from the reader's clock; "today" until the first effect runs. */
function usePartOfDay(): string {
  const [part, setPart] = useState('today');
  useEffect(() => {
    const update = () => setPart(partOfDay(new Date().getHours()));
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return part;
}

/**
 * The start of an empty direct message: who is here and a few ways to begin.
 * Picking a starter drops it into the composer; it is never sent for the user.
 */
export function DirectMessageGreeting({
  name,
  avatar,
  onPick,
}: {
  name: string;
  avatar?: string | null;
  onPick: (text: string) => void;
}) {
  const part = usePartOfDay();
  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="flex flex-col items-center gap-3">
        <AgentAvatar
          avatar={avatar ?? undefined}
          name={name}
          initials={name.slice(0, 2).toUpperCase()}
          className="size-14 rounded-xl"
          fallbackClassName="bg-muted text-base text-muted-foreground"
        />
        <h2 className="text-lg font-medium">Hi, I&apos;m {name}.</h2>
        <p className="text-sm text-muted-foreground">What can we do for you {part}?</p>
      </div>
      <ul className="flex w-full flex-col gap-1.5" aria-label="Starter prompts">
        {STARTERS.map((text, index) => {
          const Icon = ICONS[index % ICONS.length]!;
          return (
            <li key={text}>
              <button
                type="button"
                onClick={() => onPick(text)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.7} />
                <span className="min-w-0">{text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
