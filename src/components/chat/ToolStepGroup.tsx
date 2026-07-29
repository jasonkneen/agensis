import { useEffect, useId, useMemo, useState, type ComponentType } from 'react';
import {
  Brain,
  ChevronRight,
  FileText,
  FolderTree,
  Globe,
  ListTodo,
  PencilLine,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { activityChipLabel, activityElapsed, thoughtChipLabel } from '../../lib/activityStatus';
import type { Message as ChatMessage, PermissionRequest } from '../../types';
import { permissionOutcomeBadge, permissionOutcomeLabel } from './permissionRequests';
import {
  bucketToolSteps,
  rememberThinkingElapsed,
  resolveGroupChips,
  shortenToolPaths,
  toolStepLabel,
  toolStepParts,
  type ThoughtChip as ThoughtChipData,
  type TranscriptStepRow,
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
const CHIP_BASE = 'inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 font-mono text-[11px] font-semibold leading-4';
const CHIP_IDLE = 'border-border bg-muted text-muted-foreground';
// Hover lights up the EDGE (--ring is mid-grey in every theme), so it reads the same
// way whether the surface is dark or light — a background shift would have to invert.
const CHIP_INTERACTIVE = 'transition-colors hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function callCountLabel(count: number): string {
  return `${count} tool ${count === 1 ? 'call' : 'calls'}`;
}

/**
 * One run of agent work, rendered as a single strip of chips.
 *
 * The strip is ALWAYS gathered: the summary chip appears on the first step and its
 * count climbs live ("3 tool calls" -> "4 tool calls") rather than the group sitting
 * open and tidying itself up afterwards. Detail is available on demand, three levels
 * deep: total -> per-tool counts -> individual calls.
 *
 * Expansion is therefore only ever the reader's choice. Nothing in here opens or
 * closes the disclosure on its own, so a group cannot fold shut under someone who
 * opened it while more steps are still landing.
 *
 * Beside the summary sit the agent's thinking chips — live "Thinking 15s" while it
 * reasons, settled "Thought for 15s" once that period is over — so the whole turn
 * reads as one continuous strip instead of chips, a bubble, then more chips.
 */
export function ToolStepGroup({ row, compact = false }: { row: TranscriptStepRow; compact?: boolean }) {
  const { steps, approvals } = row;
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [openTools, setOpenTools] = useState<string[]>([]);

  const count = steps.length;
  const buckets = useMemo(() => bucketToolSteps(steps), [steps]);
  // How many calls in this run the human had to approve — drives the shield on the
  // summary chip, so a reader sees "this had approvals" without expanding anything.
  const approvedCount = useMemo(
    () => steps.filter(step => approvals[step.id]?.status === 'allowed').length,
    [steps, approvals],
  );
  // Liveness is derived, never stored: a new step or a placeholder tick re-renders
  // this and the answer is recomputed. No timer ticks in the background to decide it.
  // Every chip below is drawn from this one decision, so nothing can claim to be
  // live while the dot beside it says the run is over.
  const { live, thinking, thoughts } = resolveGroupChips(row);

  const toggleTool = (name: string) => {
    setOpenTools(current => (
      current.includes(name) ? current.filter(entry => entry !== name) : [...current, name]
    ));
  };

  // A settled group whose only member was an undurated placeholder has nothing left
  // to say — it measured no period and ran no tools. Render the rail and its border
  // anyway and it reads as an empty box the reader has to wonder about.
  if (count === 0 && thinking.length === 0 && thoughts.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={count > 0 ? `Agent activity, ${callCountLabel(count)}` : 'Agent activity'}
      className={cn('chat-tool-steps min-w-0 py-1', compact ? COMPACT_INDENT : CHANNEL_INDENT)}
    >
      <div className="min-w-0 border-l border-border pl-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {/* A live thinking chip already says "still moving" — and says it better —
              so the dot only stands in when there isn't one. */}
          {live && thinking.length === 0 && <LiveDot />}

          {count > 0 && (
            <button
              type="button"
              aria-expanded={expanded}
              // Only reference the panel while it exists — a dangling aria-controls
              // points assistive tech at nothing.
              aria-controls={expanded ? panelId : undefined}
              onClick={() => setExpanded(value => !value)}
              className={cn(CHIP_BASE, 'pl-1 pr-2', CHIP_IDLE, CHIP_INTERACTIVE)}
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform duration-150', expanded && 'rotate-90')}
              />
              <span className="truncate">{callCountLabel(count)}</span>
              {/* A run that needed a human's yes carries a quiet shield here, so the
                  approval is visible before anyone expands the strip. Who allowed it
                  waits on the individual call chip inside. */}
              {approvedCount > 0 && (
                <ShieldCheck
                  className="size-3 shrink-0 text-emerald-500"
                  aria-label={`${approvedCount} approved tool ${approvedCount === 1 ? 'call' : 'calls'}`}
                />
              )}
            </button>
          )}

          {thoughts.map(thought => <ThoughtChip key={thought.id} thought={thought} />)}
          {thinking.map(placeholder => <ThinkingChip key={placeholder.id} placeholder={placeholder} />)}
        </div>

        {expanded && count > 0 && (
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
                      'pl-1.5 pr-2',
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
                      <ToolStepChip step={step} approval={approvals[step.id]} />
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Thinking 15s" while the agent reasons — the elapsed is the daemon's own, read
 * straight off the placeholder it already re-posts about once a second. No clock
 * runs here.
 *
 * It also RECORDS that elapsed. The placeholder row is rewritten in place into the
 * agent's reply, so this render is the last moment the duration exists anywhere;
 * the settled chip beside it is drawn from what was captured here.
 */
function ThinkingChip({ placeholder }: { placeholder: ChatMessage }) {
  const content = typeof placeholder.content === 'string' ? placeholder.content : '';
  const elapsed = activityElapsed(content);

  useEffect(() => {
    // "0s" is a period nobody noticed — the built-in chat inserts its placeholder
    // and streams into it in the same breath — so it leaves no chip behind.
    if (elapsed !== '0s') rememberThinkingElapsed(placeholder.id, elapsed);
  }, [placeholder.id, elapsed]);

  return (
    <span
      className={cn(
        CHIP_BASE,
        'max-w-full pl-1.5 pr-2 whitespace-nowrap',
        'border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)]',
        'animate-in fade-in-0 duration-200',
      )}
    >
      <Brain className="size-3 shrink-0 text-[color:var(--accent)]" />
      {/* The shimmer is the only motion — it reads as alive without a second
          spinner competing with the chip's own ticking number. Weight comes
          from CHIP_BASE now, so this matches the tool-call chip exactly
          instead of reading one notch bolder. */}
      <span className="text-shimmer truncate">{activityChipLabel(content)}</span>
    </span>
  );
}

/** The same period once it is over, kept as provenance exactly like a tool call. */
function ThoughtChip({ thought }: { thought: ThoughtChipData }) {
  const label = thoughtChipLabel(thought.elapsed);
  return (
    <span title={label} className={cn(CHIP_BASE, 'max-w-full pl-1.5 pr-2 whitespace-nowrap', CHIP_IDLE)}>
      <Brain className="size-3 shrink-0 opacity-70" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * One call, shown only once the reader opens a tool bucket. Never wraps internally —
 * the detail truncates and the untruncated text lives in `title`, so four in a row
 * read as four short units rather than four paragraphs of shell.
 *
 * Long absolute paths are cut to their last two segments for display. A chip is
 * one line, and a checkout prefix repeated on every row is the least useful part
 * of it; `title` still carries the path in full.
 */
function ToolStepChip({ step, approval }: { step: ChatMessage; approval?: PermissionRequest }) {
  const { name, detail } = toolStepParts(step);
  const Icon = toolIcon(name);
  const allowed = approval?.status === 'allowed';
  const ApprovalIcon = allowed ? ShieldCheck : ShieldAlert;
  return (
    <span
      title={approval ? `${toolStepLabel(step)} — ${permissionOutcomeLabel(approval)}` : toolStepLabel(step)}
      className={cn(
        CHIP_BASE,
        'max-w-[26rem] pl-1.5 pr-2 whitespace-nowrap',
        'animate-in fade-in-0 slide-in-from-left-1 duration-200',
        CHIP_IDLE,
      )}
    >
      <Icon className="size-3 shrink-0 opacity-70" />
      {name && <span className="shrink-0 font-medium text-foreground/70">{name}</span>}
      {detail && <span className="truncate opacity-80">{shortenToolPaths(detail)}</span>}
      {/* The call the human unblocked carries its shield here, right where the
          folded permission card used to be a whole row of its own. One word for
          the scope granted — WHICH grant is the part that outlives the
          conversation; who granted it is in the chip's title. */}
      {approval && (
        <>
          <ApprovalIcon className={cn('size-3 shrink-0', allowed ? 'text-emerald-500' : 'text-amber-500')} />
          <span className={cn('shrink-0 font-sans', allowed ? 'text-emerald-600/90 dark:text-emerald-400/90' : 'text-muted-foreground')}>
            {permissionOutcomeBadge(approval)}
          </span>
        </>
      )}
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
