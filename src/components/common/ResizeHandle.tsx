import { cn } from '@/lib/utils';

// The one pane-resize divider, shared by every split in the app.
//
// The BEHAVIOUR was already shared — `usePaneSplit` and `useSplitResize` own
// the pointer capture, the clamp, the persistence and the arrow-key parity.
// What was not shared is this markup, because `usePaneSplit` hands back
// `dividerProps` with the note "styling stays with the caller", and thirteen
// callers each answered that differently. The result was one control with four
// spellings on three tiers of accessibility: a `<button>` with a focus ring, a
// `<button>` without an accessible name, a `<div role="separator">` that is
// announced but cannot be focused, and in ChatWindowContent a bare
// `<div aria-hidden>` that a keyboard cannot reach at all.
//
// So the seam is always a real `<button>`: focusable, named by the hook's
// `aria-label`, and carrying the hook's arrow-key handlers. The grab line is a
// `<span aria-hidden>` because it is decoration — the button is the control.
//
// POSITIONING STAYS WITH THE CALLER. Where the seam sits (which edge, which
// inset, what negative margin pulls it over the border it straddles) is a fact
// about that layout, not about resizing, and every call site differs. Pass it
// through `className`; `orientation` covers the rest.

interface ResizeHandleProps extends React.ComponentPropsWithoutRef<'button'> {
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
    <button
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
    </button>
  );
}
