import { Eye } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import { describeReaders } from '../../lib/readReceipts';

// The "seen" indicator, on the trailing edge of your own message's meta row.
//
// WHY A LUCIDE `Eye` AND NOT 👀. The project rule is no decorative emoji in UI
// chrome, and reactions are the exception only because a reaction is content
// somebody chose. Nobody chose this — the app is asserting a fact — so it is
// chrome and it is an SVG. Three further reasons, in order:
//
//   * an SVG inherits currentColor, so it themes, dims to text-muted-foreground,
//     and sits on the pixel grid with the other 3.5px icons in the row. An emoji
//     glyph is full-colour, ignores the theme and cannot be muted.
//   * it renders identically everywhere. 👀 is one pair of cartoon eyes on
//     Apple, a different pair on Windows and something else again on Android;
//     the receipt would look like a different feature per platform.
//   * 👀 is ALREADY IN THE REACTION PICKER. Using the same glyph for chrome
//     would put a system assertion and a user's reaction side by side in the
//     same row, visually identical and meaning completely different things.
//
// WHY THERE IS NO TIMESTAMP, EVER. The data supports "read at 23:47" and the
// product must not show it. That is the specific behaviour people cite when they
// switch receipts off, and it undoes the one privacy property the high-water
// mark has: the model deliberately cannot record WHICH message was read, so the
// UI must not hand back a finer clock than the model kept.

export interface ReadReceiptProps {
  /** Ids of everyone who has read this message, excluding its author. */
  readerIds: readonly string[];
  resolveName: (userId: string) => string | null;
  /**
   * True for a two-person conversation. A DM shows an outline eye while unread
   * and a filled one once read, because "did it land" is the whole question. A
   * channel shows nothing until at least one person has read it — an eye on
   * every message in a 30-person channel is furniture, not information.
   */
  isDirect?: boolean;
  className?: string;
}

export function ReadReceipt({ readerIds, resolveName, isDirect = false, className }: ReadReceiptProps) {
  const count = readerIds.length;
  if (count === 0 && !isDirect) return null;

  const read = count > 0;
  // The icon is decorative; the FACT goes in text. A screen reader that only
  // reaches the glyph learns nothing, and the state here is the whole content.
  const label = read
    ? describeReaders(readerIds, resolveName)
    : 'Not read yet';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center gap-0.5 align-middle',
            read ? 'text-muted-foreground' : 'text-muted-foreground/40',
            className,
          )}
          aria-label={read ? `Read by ${count} ${count === 1 ? 'person' : 'people'}` : 'Not read yet'}
        >
          <Eye className="size-3.5" fill={read ? 'currentColor' : 'none'} aria-hidden="true" />
          {/* The count only earns its space in a group. In a DM "read" is
              binary, so a "1" beside the eye is noise. */}
          {!isDirect && count > 1 ? (
            <span className="text-[10px] font-medium tabular-nums">{count}</span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
