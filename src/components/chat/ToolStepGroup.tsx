import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  ChevronRight,
  FileText,
  FolderTree,
  Globe,
  ListTodo,
  PencilLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message as ChatMessage } from '../../types';
import {
  TOOL_STEP_SETTLE_MS,
  bucketToolSteps,
  isStaleStepGroup,
  toolStepLabel,
  toolStepParts,
} from './toolSteps';

type ToolIcon = ComponentType<{ className?: string }>;

const TOOL_ICONS: Record<string, ToolIcon> = {
  bash: Terminal,
  read: FileText,
  write: PencilLine,
  edit: PencilLine,
  notebookedit: PencilLine,
  grep: Search,
  glob: FolderTree,
  ls: FolderTree,
  webfetch: Globe,
  websearch: Globe,
  task: Sparkles,
  agent: Sparkles,
  todowrite: ListTodo,
};

function toolIcon(name: string): ToolIcon {
  return TOOL_ICONS[name.toLowerCase()] ?? Wrench;
}

// Indent so the rail lands exactly where the sibling message text starts — channel
// rows are px-4 + a size-8 avatar + gap-3 (3.75rem), side-panel rows px-2 + size-7 +
// gap-2 (2.75rem). Steps read as provenance hanging off the conversation, not beside it.
const CHANNEL_INDENT = 'pl-[3.75rem] pr-4';
const COMPACT_INDENT = 'pl-11 pr-2';

// Chips use the tokens at full strength rather than alpha-thinned ones. In the light
// themes --muted is oklch(97%) and --sh-border oklch(92.2%); knocking those back to
// 40%/60% over a white surface leaves a chip about 1% off the background — i.e.
// invisible. Full strength reads as a quiet chip in light and dark alike.
const CHIP_BASE = 'inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 font-mono text-[11px] leading-4';
const CHIP_IDLE = 'border-border bg-muted text-muted-foreground';
// Hover lights up the EDGE (--ring is mid-grey in every theme), so it reads the same
// way whether the surface is dark or light — a background shift would have to invert.
const CHIP_INTERACTIVE = 'transition-colors hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function callCountLabel(count: number): string {
  return `${count} tool ${count === 1 ? 'call' : 'calls'}`;
}

/**
 * A step group has two lives.
 *
 * LIVE — chips flow inline as they stream in so the run is watchable and
 * interruptible. SETTLED — once the run finishes or goes quiet the chips gather
 * into one summary chip, and the detail is available on demand three levels deep:
 * total -> per-tool counts -> individual calls.
 *
 * Settling is one-way. It fires on whichever comes first: a later non-step message
 * from the same agent (`endedByReply`), or a quiet window with no new step. Once
 * settled the group never re-expands on its own — from then on it is the reader's
 * choice.
 */
export function ToolStepGroup({
  steps,
  endedByReply = false,
  compact = false,
}: {
  steps: ChatMessage[];
  endedByReply?: boolean;
  compact?: boolean;
}) {
  const panelId = useId();
  // Scrollback and reopened threads start settled — they were never live here.
  const [settled, setSettled] = useState(() => endedByReply || isStaleStepGroup(steps));
  // Mirrors `settled` for the effect below, which must not re-arm a timer after the
  // group has already gathered up (and must not list `settled` as a dependency,
  // which would re-run it on the very state change it guards against).
  const settledRef = useRef(settled);
  const [expanded, setExpanded] = useState(false);
  const [openTools, setOpenTools] = useState<string[]>([]);

  const count = steps.length;
  const buckets = useMemo(() => bucketToolSteps(steps), [steps]);

  useEffect(() => {
    if (settledRef.current) return;
    if (endedByReply) {
      settledRef.current = true;
      setSettled(true);
      return;
    }
    // Re-armed on every new step (count changes) and cleared on unmount, so exactly
    // one timer is ever outstanding per group.
    const timer = window.setTimeout(() => {
      settledRef.current = true;
      setSettled(true);
    }, TOOL_STEP_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [count, endedByReply]);

  const toggleTool = (name: string) => {
    setOpenTools(current => (
      current.includes(name) ? current.filter(entry => entry !== name) : [...current, name]
    ));
  };

  return (
    <div
      role="group"
      aria-label={`Agent tool activity, ${callCountLabel(count)}`}
      className={cn('chat-tool-steps min-w-0 py-1', compact ? COMPACT_INDENT : CHANNEL_INDENT)}
    >
      <div className="min-w-0 border-l border-border pl-2.5">
        {!settled ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <LiveDot />
            {steps.map((step, index) => (
              <ToolStepChip key={step.id} step={step} active={index === count - 1} />
            ))}
          </div>
        ) : (
          <div className="min-w-0">
            <button
              type="button"
              aria-expanded={expanded}
              // Only reference the panel while it exists — a dangling aria-controls
              // points assistive tech at nothing.
              aria-controls={expanded ? panelId : undefined}
              onClick={() => setExpanded(value => !value)}
              className={cn(CHIP_BASE, 'pl-1 pr-2.5', CHIP_IDLE, CHIP_INTERACTIVE)}
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform duration-150', expanded && 'rotate-90')}
              />
              <span className="truncate">{callCountLabel(count)}</span>
            </button>

            {expanded && (
              <div id={panelId} className="mt-1 min-w-0 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  {buckets.map(bucket => {
                    const Icon = toolIcon(bucket.name);
                    const open = openTools.includes(bucket.name);
                    return (
                      <button
                        key={bucket.name}
                        type="button"
                        aria-expanded={open}
                        aria-controls={open ? `${panelId}-${bucket.name}` : undefined}
                        onClick={() => toggleTool(bucket.name)}
                        className={cn(
                          CHIP_BASE,
                          'pl-2 pr-2.5',
                          CHIP_INTERACTIVE,
                          open ? 'border-ring bg-muted text-foreground' : CHIP_IDLE,
                        )}
                      >
                        <Icon className="size-3 shrink-0 opacity-70" />
                        <span className="truncate">
                          {bucket.steps.length} {bucket.name}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {buckets
                  .filter(bucket => openTools.includes(bucket.name))
                  .map(bucket => (
                    <ul
                      key={bucket.name}
                      id={`${panelId}-${bucket.name}`}
                      className="min-w-0 space-y-0.5 border-l border-border/50 pl-2.5"
                    >
                      {bucket.steps.map(step => (
                        <li key={step.id} className="min-w-0">
                          <ToolStepChip step={step} />
                        </li>
                      ))}
                    </ul>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One call. Never wraps internally — the detail truncates and the untruncated text
 * lives in `title`, so four in a row read as four short units rather than four
 * paragraphs of shell.
 */
function ToolStepChip({ step, active = false }: { step: ChatMessage; active?: boolean }) {
  const { name, detail } = toolStepParts(step);
  const Icon = toolIcon(name);
  return (
    <span
      title={toolStepLabel(step)}
      className={cn(
        CHIP_BASE,
        'max-w-[22rem] pl-2 pr-2.5 whitespace-nowrap',
        'animate-in fade-in-0 slide-in-from-left-1 duration-200',
        active
          ? 'border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] text-foreground/80'
          : CHIP_IDLE,
      )}
    >
      <Icon className="size-3 shrink-0 opacity-70" />
      {name && <span className="shrink-0 font-medium text-foreground/70">{name}</span>}
      {detail && <span className="truncate opacity-80">{detail}</span>}
    </span>
  );
}

/** Quiet proof the run is still moving, so a long tool call doesn't read as a hang. */
function LiveDot() {
  return (
    <span aria-hidden className="relative mr-0.5 flex size-1.5 shrink-0 text-[color:var(--accent)]">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
      <span className="relative inline-flex size-1.5 rounded-full bg-current" />
    </span>
  );
}
