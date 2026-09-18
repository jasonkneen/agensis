import { cn } from '@/lib/utils';

// The one pane-resize divider, shared by every split in the app.
//
// The BEHAVIOUR was already shared — `usePaneSplit` and `useSplitResize` own
// the pointer capture, the clamp, the persistence and the arrow-key parity.
// What was not shared is this markup, because `usePaneSplit` handed back
// `dividerProps` with the note "styling stays with the caller", and thirteen
// callers each answered that differently. One control ended up with four
// spellings on three tiers of accessibility, from a focus-ringed `<button>`
// down to a bare `<div aria-hidden>` in ChatWindowContent that a keyboard
// could not reach at all.
//
// THE ELEMENT IS A SEPARATOR, NOT A BUTTON. This is the WAI-ARIA window
// splitter: `role="separator"` with `tabIndex={0}`, an orientation, and the
// `aria-value*` triple the hook supplies. The difference is not pedantry — a
// button announces as "Resize file list, button", so the natural thing to try
// is Enter, and Enter does nothing. A separator announces as "Resize file
// list, separator, 240", which names the gesture (arrows) AND the current
// position. WorkspaceRail already had this right and was the only one of the
// thirteen that did; canonicalising on `<button>` would have meant downgrading
// the one correct implementation to match twelve worse ones.
//
// The grab line is a `<span aria-hidden>` because it is decoration. The
// separator is the control.
//
// POSITIONING STAYS WITH THE CALLER. Which edge the seam sits on, what inset
// it takes, what negative margin pulls it over the border it straddles — those
// are facts about that layout, not about resizing, and every call site
// differs. Pass them through `className`; `orientation` covers the rest.

interface ResizeHandleProps extends React.ComponentPropsWithoutRef<'div'> {
  /**
   * `vertical` is a vertical seam between side-by-side panes: it drags left and
   * right and shows `col-resize`. `horizontal` is a seam between stacked panes:
   * it drags up and down and shows `row-resize`. This names the LINE, which is
   * also how `usePaneSplit` reads `direction` ('row' packs panes side by side,
   * so its seam is vertical).
   */
  orientation: 'vertical' | 'horizontal';
  /**
   * Keeps the grab line lit while the pointer is down, including after it has
   * left the strip. Without it the line vanishes mid-drag, because hover has
   * long since moved on to whatever is under the cursor.
   */
  dragging?: boolean;
}

export function ResizeHandle({ orientation, dragging = false, className, ...props }: ResizeHandleProps) {
  const vertical = orientation === 'vertical';
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      {...props}
      className={cn(
        'group/split absolute z-30 touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        vertical ? 'w-3 cursor-col-resize' : 'flex h-3 items-center cursor-row-resize',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block bg-transparent transition-colors group-hover/split:bg-border group-focus-visible/split:bg-primary/70',
          vertical ? 'mx-auto h-full w-px' : 'my-auto h-px w-full',
          dragging && 'bg-border',
        )}
      />
    </div>
  );
}
