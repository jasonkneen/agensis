# FB-001 — Overlapping windows lack depth/contrast (shadow difference)

- **Task ID:** `5ffd16d1-dcea-47b3-8d66-af17179adbb4`
- **Reporter:** workspace member (e7210cdf-104b-49df-8a13-85d380f7dceb)
- **Page:** /app — Workspace 1
- **Status:** todo → done (this writeup only; no code changed)

## Original message

> overlapping windows doesn't give a good depth/contrast / shadow differnce
>
> Page: /app — Workspace 1
>
> Elements:
> - `div:nth-of-type(1) > div > div:nth-of-type(3)` — "What's on your mind? Summarize my documents / Help me brainstorm / Write a draft / Explain a concept / Workspace 1 > Explain a concept …"

## What I found in the codebase

Every floating window gets the exact same shadow, regardless of stacking order:

- `src/index.css:2452-2454` — the single rule applied to *all* floating windows:
  ```css
  [data-window-view-mode="floating"] {
    box-shadow: var(--shadow-window);
  }
  ```
- `--shadow-window` is a fixed per-theme token (`src/index.css:153` base, `:208` light, `:246`/`:291`/`:2016-2024` neo/tinyworld variants), e.g. `0 10px 24px -14px rgba(0,0,0,0.7)`. A code comment at lines 149-152 explains this was deliberately kept as one tight, negative-spread layer "to prevent... compounding into a muddy pool where windows overlap" — i.e. overlap contrast was explicitly designed *against*, not for.
- `isSelected` (threaded into `FloatingWindowShell.tsx:787`) only adds a `ring-2 ring-primary/40` border — that's a multi-user "another collaborator has this selected" concept, not local focus/z-order.
- `zIndex` (`FloatingWindowShell.tsx:709`, bumped in `useWindows.ts` on focus, e.g. lines 569/635/794) is a pure stacking value — it's never read to vary shadow or darkness.
- `WindowGroupFrame.tsx:56` (tiled-group wrapper) sets `shadow-none`, and `FloatingWindowShell.tsx:785` forces the inner `[data-window-surface]` to `shadow-none` too — all elevation lives on one outer wrapper, identically, for every window whether it's on top or buried underneath.

Net effect: the topmost/focused window and everything stacked behind it render with identical shadow weight, so there's no visual depth cue telling you which window is "up front" besides overlap itself.

### Related existing backlog

`plans/020-ui-polish-queue.md` doesn't have this exact item, but two of its five open items are adjacent and reusable:
- Item 1 "Accent/theme fade" — ambient tinted wash behind chrome/windows.
- Item 2 "Dark outer ring on light-lined buttons/chips" — an already-proven separation technique (1px inner light line + dark outer ring) used elsewhere for the presence pill; the same trick would read as elevation on a focused window.

## Recommendation

Add a focus-aware elevation tier instead of one flat shadow token:

1. Thread an `isTopWindow`/`isFocused` boolean into `FloatingWindowShell` (compare `win.zIndex` to the max across `windows` in `useWindows.ts` — same pattern already used to pass `isSelected` in).
2. Add a stronger `--shadow-window-active` token (bigger spread, darker alpha), applied only to the focused window; keep the current `--shadow-window` for background windows, optionally dialing it down further (lower alpha, or reuse the existing `isDimmed`/`dimmedOpacity` pattern already in `FloatingWindowShell.tsx:684-685, 698-699`).
3. Borrow plan 020 item 2's dark-outer-ring token for the focused window only, for contrast against a mid-tone/glass background, instead of inventing a new visual language.

This is pure CSS/prop-threading — no data model changes — and slots naturally into the existing plans/020 polish queue as a sixth item.
