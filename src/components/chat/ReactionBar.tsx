import { useMemo, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import {
  REACTION_PICKER_GROUPS,
  describeReactors,
  frequentReactions,
  reactionPillLabel,
  reactionPills,
  reactionToggleOp,
  searchReactions,
  type ReactionMap,
  type ReactionUse,
} from '../../lib/reactionBar';

// The reactions bar: the pills under a message, and the picker that adds one.
//
// EVERY DECISION IS IN src/lib/reactionBar.ts — ordering, own-reaction state,
// tooltip wording, search, the frequently-used ranking. Not for tidiness: the
// frontend runner only sees tests/unit/**/*.test.ts and `.test.tsx` is outside
// the glob, so logic left in this file would be untestable in this repo. This
// component renders and nothing else.
//
// THE EMOJI RULE. No decorative emoji in UI chrome. Reactions are the deliberate
// exception because the glyph here is USER-SELECTED CONTENT — so the pill glyph
// and the picker grid are emoji, and the "add reaction" trigger is a lucide
// Smile, the counts are numerals, and every label is words.

export interface ReactionBarProps {
  reactions: ReactionMap | null | undefined;
  currentUserId: string | null;
  /** Resolves a user id to a display name; returns null when unknown. */
  resolveName: (userId: string) => string | null;
  onToggle: (reaction: string, op: 'add' | 'remove') => void;
  /** Persisted per-account picker history, for the "Frequently used" row. */
  reactionUses?: readonly ReactionUse[];
  className?: string;
}

/**
 * The pills. Rendered ONLY when reactions exist, so a message with none costs
 * no vertical space and hovering does not shift the row.
 */
export function ReactionBar({
  reactions, currentUserId, resolveName, onToggle, reactionUses = [], className,
}: ReactionBarProps) {
  const pills = useMemo(() => reactionPills(reactions, currentUserId), [reactions, currentUserId]);
  if (pills.length === 0) return null;

  return (
    <div className={cn('mt-1 flex flex-wrap items-center gap-1', className)}>
      {pills.map(pill => (
        <Tooltip key={pill.reaction}>
          <TooltipTrigger asChild>
            <button
              type="button"
              // aria-pressed is the ONLY signal a screen reader has that this is
              // a toggle rather than a link; the tint that carries it visually
              // means nothing there.
              aria-pressed={pill.mine}
              aria-label={reactionPillLabel(pill)}
              onClick={() => onToggle(pill.reaction, reactionToggleOp(pill, currentUserId))}
              className={cn(
                'chat-reaction-chip control-outer-ring inline-flex h-6 items-center gap-1 rounded-md border px-2 text-sm transition-colors',
                pill.mine
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-border bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {pill.reaction}
              {/* The numeral is always shown, including at 1. "+1" and a hidden
                  count both make you hover to learn something the row could
                  just say. */}
              <span className="text-[11px] font-medium">{pill.count}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{describeReactors(pill, resolveName, currentUserId)}</TooltipContent>
        </Tooltip>
      ))}
      {/* A keyboard user must never have to reach the hover rail to add a
          reaction, so an existing pill row carries its own opener. */}
      <ReactionPicker
        onPick={reaction => onToggle(reaction, reactionToggleOp(pills.find(p => p.reaction === reaction), currentUserId))}
        reactionUses={reactionUses}
        trigger={(
          <button
            type="button"
            aria-label="Add a reaction"
            title="Add a reaction"
            className="control-outer-ring inline-flex h-6 items-center rounded-md border border-dashed border-border px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Smile className="size-3.5" />
          </button>
        )}
      />
    </div>
  );
}

export interface ReactionPickerProps {
  onPick: (reaction: string) => void;
  reactionUses?: readonly ReactionUse[];
  /** The element that opens the picker. Defaults to the rail's icon button. */
  trigger?: React.ReactNode;
}

/**
 * The picker: a search field, a frequently-used row, then the groups.
 *
 * KEYBOARD. The grid is a `role="grid"` with ROVING TABINDEX — exactly one cell
 * is tabbable and the arrow keys move between them. Without it the picker is
 * ~80 consecutive tab stops between the trigger and anything else on the page,
 * which is not an inconvenience so much as a reason never to use a keyboard here.
 *
 * A curated list plus search rather than a full emoji dataset: the datasets are
 * ~1 MB of names and keywords, and plans/013 exists because the bundle already
 * bit once. Growing the list is cheap; growing it to 1,800 entries is a decision.
 */
export function ReactionPicker({ onPick, reactionUses = [], trigger }: ReactionPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const frequent = useMemo(() => frequentReactions(reactionUses), [reactionUses]);
  const searching = query.trim().length > 0;
  const results = useMemo(() => (searching ? searchReactions(query) : []), [searching, query]);

  // One flat list of everything currently on screen, in visual order, so the
  // arrow keys move through what the eye sees rather than through the groups.
  const visible = useMemo(
    () => (searching ? results : [...frequent, ...REACTION_PICKER_GROUPS.flatMap(group => group.reactions)]),
    [searching, results, frequent],
  );

  const columns = 8;

  const pick = (reaction: string) => {
    onPick(reaction);
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  };

  const onGridKeyDown = (event: React.KeyboardEvent) => {
    const last = visible.length - 1;
    if (last < 0) return;
    const move = (next: number) => {
      event.preventDefault();
      const clamped = Math.max(0, Math.min(last, next));
      setActiveIndex(clamped);
      // Focus follows the roving index, or the arrow keys move a highlight the
      // screen reader never hears about.
      const cell = gridRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${clamped}"]`);
      cell?.focus();
    };
    if (event.key === 'ArrowRight') move(activeIndex + 1);
    else if (event.key === 'ArrowLeft') move(activeIndex - 1);
    else if (event.key === 'ArrowDown') move(activeIndex + columns);
    else if (event.key === 'ArrowUp') move(activeIndex - columns);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(last);
  };

  const cell = (reaction: string, index: number) => (
    <button
      key={`${reaction}-${index}`}
      type="button"
      role="gridcell"
      data-cell={index}
      // ROVING TABINDEX: exactly one cell is in the tab order at a time.
      tabIndex={index === activeIndex ? 0 : -1}
      aria-label={`React with ${reaction}`}
      onFocus={() => setActiveIndex(index)}
      onClick={() => pick(reaction)}
      className="flex h-7 w-7 items-center justify-center rounded text-base hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {reaction}
    </button>
  );

  let index = 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) { setQuery(''); setActiveIndex(0); }
      }}
    >
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Add a reaction" title="Add a reaction">
            <Smile />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[268px] p-2">
        <input
          type="search"
          value={query}
          onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
          placeholder="Search reactions"
          aria-label="Search reactions"
          className="mb-2 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div
          ref={gridRef}
          role="grid"
          aria-label="Reactions"
          onKeyDown={onGridKeyDown}
          className="max-h-[220px] overflow-y-auto"
        >
          {searching ? (
            results.length === 0 ? (
              <p className="px-1 py-3 text-center text-xs text-muted-foreground">No reactions match that</p>
            ) : (
              <div role="row" className="grid grid-cols-8 gap-0.5">
                {results.map(reaction => cell(reaction, index++))}
              </div>
            )
          ) : (
            <>
              <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Frequently used
              </div>
              <div role="row" className="grid grid-cols-8 gap-0.5">
                {frequent.map(reaction => cell(reaction, index++))}
              </div>
              {REACTION_PICKER_GROUPS.map(group => (
                <div key={group.name}>
                  <div className="px-1 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.name}
                  </div>
                  <div role="row" className="grid grid-cols-8 gap-0.5">
                    {group.reactions.map(reaction => cell(reaction, index++))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
