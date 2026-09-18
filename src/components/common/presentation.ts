// Presentation constants shared across windows and panes. A class string
// lives here when two or more surfaces need to agree on it pixel-for-pixel;
// anything a single surface owns stays beside that surface.

/**
 * The band at the top of a window's content: search, filters, view toggles.
 * Fourteen windows wrote this by hand and drifted between h-10 and h-11, and
 * between `border-b` (theme-default colour) and `border-b border-border`.
 * Extras — a frosted `bg-card/65 backdrop-blur-md`, `justify-between`, a
 * semantic hook class — are appended by the caller through cn().
 */
/**
 * A selectable filter chip: the pill row above a list that narrows it. Three
 * surfaces drew the same pair of states by hand — agents (status and presence),
 * the channel-template picker, the marketplace type filter — six copies of two
 * strings that have to stay identical, because a user moving between those
 * surfaces is looking at the same control. The BASE is the caller's, because
 * the padding legitimately differs (a chip with a dot and a count is taller
 * than a bare label); the two STATES are not.
 */
export const FILTER_CHIP_ON = 'border-primary/60 bg-primary/15 text-foreground';
export const FILTER_CHIP_OFF = 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground';

export const WINDOW_TOOLBAR = 'flex h-11 shrink-0 items-center gap-2 border-b border-border px-3';

/**
 * The root element of a window's content: fills the frame, stacks its bands,
 * clips its own overflow, and paints NOTHING — the window shell behind it owns
 * the surface, which is why this is `bg-transparent` rather than `bg-card`.
 * Six windows agreed on it by hand. Inner containers are deliberately NOT this
 * (they carry `min-w-0` / `flex-1` for nested flex, and a branch that renders
 * an empty or editing state is doing a different job) — this is the ROOT only.
 */
export const WINDOW_SHELL = 'flex h-full flex-col overflow-hidden bg-transparent text-foreground';

/**
 * The 28px leading tile on a mention / command-picker row: an icon on a muted
 * square, or an agent's face at the same size. Seven rows across the chat and
 * task composers drew it inline, which is seven places for the size, the
 * radius and the muted pair to drift — and they must not, because the rows
 * interleave in one popover. Faces pass it to `AgentAvatar`'s `className`
 * rather than wrapping, so it stays a string and not a component.
 */
export const MENTION_TILE = 'grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground';

// --- Shared with every list/detail window (was inbox/inboxPresentation.ts;
// tenants imported it from there, which is how a feature-local file became
// the app's type scale) -------------------------------------------------

/** The app's body size. Matches `text-sm` everywhere else in the app. */
export const TEXT_BODY = 'text-sm';

/** One step down: metadata that must not compete with the body line. */
export const TEXT_META = 'text-xs';

/** Uppercase micro-labels only. Below this, type stops being readable. */
export const TEXT_MICRO = 'text-[0.65rem]';

/**
 * Caps and centres the row column, same move as the chat window's
 * CHAT_COLUMN_CLASS (src/components/windows/ChatWindowContent.tsx). Without
 * it, the single-column view (no item selected) stretches rows edge-to-edge
 * across the whole floating window — three short lines of text on a 32px face
 * reading as a thin ribbon across 900+px looks like a bug, not restraint. Has
 * no visible effect in two-pane mode, where the list pane itself is already
 * narrower than this (MAX_LIST_WIDTH in InboxWindowContent.tsx).
 *
 * In rem, not px: the comfortable measure for a column of text is a count of
 * CHARACTERS, so the cap has to grow when the type does. 42rem is 672px at the
 * 16px default and 714px at 17px.
 */
export const LIST_COLUMN_CLASS = 'mx-auto w-full max-w-[42rem]';

/**
 * Radix's ScrollArea.Viewport wraps whatever you put inside it in an injected
 * `<div style="min-width:100%; display:table">`, and that div is what actually
 * lays the content out.
 *
 * A `display: table` box with `width: auto` is sized shrink-to-fit, with a FLOOR
 * of its content's min-content width — so a single unbreakable token in one row
 * (a file path, a uuid, a stack frame, a URL) makes the whole column wider than
 * the pane it lives in. The viewport's own inline `overflow: hidden scroll` then
 * has no horizontal scrollbar to offer, so the excess is simply CLIPPED. Every
 * row in the list loses its right-hand side, mid-word, at once.
 *
 * Measured in the inbox list pane at a 700px window: viewport clientWidth 339px,
 * injected div width 575.34px — 236px of every row cut off.
 *
 * Forcing that div back to `display: block` makes it fill the viewport instead
 * of shrink-wrapping the content, and the text wraps. The `!` is needed because
 * the `display: table` is an inline style. Same fix as the sidebar's list
 * (src/components/layout/Sidebar.tsx).
 */
export const SCROLL_VIEWPORT_BLOCK = '[&_[data-radix-scroll-area-viewport]>div]:!block';

/** Drawn inside the row so an adjacent row never clips it. */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2';

/** Section headers and micro-labels — chrome, deliberately below row type size. */
export const MICRO_LABEL =
  'ui-section-label';

/**
 * The two panes' headers are the same band so they line up pixel-for-pixel
 * across the divider — the single most noticeable thing about a two-pane inbox
 * that has been built carelessly.
 */
export const PANE_HEADER =
  'flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5';

/** Hover-pill buttons: 24px circles, quiet until the row is under the pointer. */
export const PILL_BUTTON =
  'flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5';

/**
 * The row wash, derived from --foreground rather than --muted.
 *
 * This app ships six UI themes and in several of them --muted sits within 3% of
 * --card, which would make hover and selection literally invisible. Mixing a few
 * percent of --foreground into --card instead is self-correcting: it darkens in
 * a light theme and lightens in a dark one, by the same perceptual amount, in
 * every theme. Selected and hover are deliberately close — selection is also
 * carried by the detail pane and by aria-current, so the list does not need to
 * shout about it.
 */
export const ROW_WASH_HOVER = 'color-mix(in oklab, var(--card) 96%, var(--foreground))';

export const ROW_WASH_SELECTED = 'color-mix(in oklab, var(--card) 91%, var(--foreground))';

/**
 * Row metrics: three text lines against a 2rem face. Tailwind spacing is rem,
 * and the row has no fixed height, so a larger base font size grows the type
 * AND the padding and the row simply gets taller — ~102px at the 16px default,
 * ~108px at 17px. Nothing here clamps a line back down to fit.
 */
export const ROW_PADDING = 'px-3 py-3';
