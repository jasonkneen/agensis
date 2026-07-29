# Plan 020 — UI polish queue (5 outstanding items)

Captured 2026-07-25. Five requests from Jason that are **not started**. Each is
self-contained; do them one at a time and verify each before starting the next.

**Done-criteria rule (see [[backend-core-unlinted]]): a plan item is not DONE
until someone has run the stated command and read its output.**

Three of these come from a reference desktop app (Jason shared screenshots).
The reference app is available locally — read the real
implementation rather than guessing from the screenshots.

---

## 1. Accent / theme fade on the app background

**Reference:** the reference app sidebar — a soft olive/yellow wash bleeding from the
top-left into the dark surface, so the theme accent tints the chrome instead of
appearing only on controls.

**Where:** `src/index.css`, plus `src/showcase/neoThemes.ts` (730 lines) which
already defines per-theme accents. The sidebar is
`src/components/layout/Sidebar.tsx`.

**Approach:** a fixed, non-interactive gradient layer behind the sidebar and
window chrome, driven by the existing accent custom property, e.g.
`radial-gradient(at 0% 0%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 60%)`.
Must be theme-aware (every theme in neoThemes), must not tint content surfaces,
and must be a separate layer so it can't interfere with `backdrop-filter` on
`[data-window-surface]` (see the window chrome notes in [[window-group-composite]]).

**Done criteria:** `npm run build` clean, and a screenshot in both light and
dark for at least neo + default themes.

---

## 2. Dark outer ring on light-lined buttons and chips (dark mode)

**Reference:** the avatar/presence pill — a light 1px inner line PLUS a dark
outer ring, giving separation against a mid-tone background.

**The ask:** every button/chip that currently has only the light line should
also get the dark outer ring, in dark mode.

**Where:** `src/components/ui/button.tsx`, `badge`, and the chip styles in
`src/index.css`. The existing treatment is already on the presence pill — find
it and lift it into a shared token rather than repeating the box-shadow.

**Approach:** one utility (e.g. `--ring-outer`) applied via
`box-shadow: 0 0 0 1px var(--border-light) inset, 0 0 0 1px var(--ring-outer)`.
Scope to `:root[data-theme="dark"]`. Audit: search for `border-border` on
interactive elements and confirm each either adopts the token or is
deliberately excluded.

**Done criteria:** `npx eslint .` exit 0, `npm run build` clean, and a
side-by-side dark-mode screenshot of buttons, badges, chips, tabs, and the
presence pill.

---

## 3. Simplify window/channel title bars

**Reference:** the reference app — `# general` on the left, then only three compact
controls (members count, huddle, `⋯`). Everything else lives in the overflow.

**Current state:** `FloatingWindowShell.tsx` renders a control cluster of up to
five buttons (`⋯`, minimise, maximise, full-expand, close) plus the breadcrumb,
and `ChatWindowContent.tsx` adds a second toolbar row (Coder / Messages / Files
/ Pins / Threads / Split / Clear / Knowledge / Catch up / members).

**The ask:** assume everything is in the `⋯`. Keep at most 2–3 affordances
visible; move the rest into the overflow menu.

**Careful:** the group-frame work ([[window-group-composite]], branch
`worktree-group-frame`) also changes this chrome — the frame is meant to own a
single title bar and member panes get label strips. **Do that first or these
two will conflict.**

**Done criteria:** the tour manifest test still passes
(`tests/cursorbuddy-manifest.test.cjs` asserts guided-tour selectors exist in
source — moving a button into a menu can break it), plus `npm run ci`.

---

## 4. Reply summary instead of "+ Sub-thread"

**Reference:** the reference app — overlapping participant avatars, then
`6 replies · last reply 24 minutes ago`, as one clickable row under the parent
message.

**Current state:** every message renders a bare `+ Sub-thread` link regardless
of whether replies exist (visible in several of Jason's screenshots — it is the
single most repeated element on screen and carries no information).

**Where:** `src/components/windows/ChatWindowContent.tsx` (the message row,
~line 2114 onward). `threadReplyCounts` and `subThreadsByMessage` already exist
and are passed in — the data is there.

**Approach:** when a message has replies, render the summary row (distinct
participant avatars capped at ~3, count, relative time of the newest reply).
When it has none, show `+ Sub-thread` only on hover, matching how the reference app keeps
the timeline quiet.

**Done criteria:** `npm run test:unit`, plus a screenshot of a thread with 0, 1
and 6+ replies.

---

## 5. Normalise thread vs sub-thread composers

**The ask:** same height, same padding, same internal spacing, aligned on the
same horizontal lines.

**Observed difference:** the main composer has an attach/mic row and a
pencil + send pair; the sub-thread composer sits higher, has no attach/mic row,
a differently-positioned model selector, and a lone send button — so the two
inputs do not share a baseline.

**Where:** the composer in `ChatWindowContent.tsx` (`CHAT_COLUMN_CLASS` region,
~line 1546) and `src/components/chat/SubThreadPanel.tsx` (525 lines) /
`ChatThreadPanel.tsx`.

**Approach:** extract ONE composer shell component that both use, parameterised
by which affordances it shows — the same fix pattern as `CHAT_COLUMN_CLASS` in
commit 52f669f, where two independent literals had drifted apart.

**Done criteria:** `npm run ci`, plus a screenshot with the main and sub-thread
composers side by side.
