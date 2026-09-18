# UI design-language audit

Snapshot: 2026-09-18, off `main` @ b5e35f9a. Branch `chore/ui-design-language`.

## Verdict

The repo already has ONE design language and it is in good shape:
shadcn `radix-nova` primitives in `packages/ui` (55 components, imported by 101
files) over the token ladders in `src/index.css` (radius, glass, transition,
z-index, `text-2xs`/`text-3xs`). There is nothing to "pick" and nothing to
rewrite. Standardising here means **closing the third path** — the places that
hand-roll what a primitive or a token already gives — not converting the 425
documented semantic classes into utilities or vice versa.

## What is NOT drift (deliberately left alone)

| Looks like drift | Why it stays |
| --- | --- |
| 33 hardcoded hex in `.tsx` | Canvas colour picker (serialized into the canvas data model) + `TerminalPanel` xterm theme. Both need literal hex. |
| `text-[7px]` / `[8px]` / `[9px]` (32 sites) | Documented exemption in AGENTS.md: Press Start 2P retro face + avatar initials, deliberately fixed. |
| `text-[0px]` (2 sites, `Sidebar`) | Collapsed count badge that grows to `text-[9px]` on hover. A transition, not a type size. |
| 425 semantic classes in `index.css` | Load-bearing and documented (GPU rationale on the glass ladder; z-index mirrored in `chromeDepth.ts` and asserted by `tests/unit/chromeDepth.test.ts`). |
| `lucide` icons | `components.json` sets it; one family throughout. taste-skill's preference does not override a project's existing choice. |
| `text-xs text-muted-foreground` x85 | An atom, not a component. A `<Muted>` wrapper would touch 85 sites and buy nothing. |

## Finding 1 — one control, four spellings (the real drift)

A pane-resize divider appears in **13 files**. The *behaviour* is already shared
(`useSplitResize`, `usePaneSplit`); only the **markup** was copy-pasted, because
`usePaneSplit` says in so many words: *"Spread onto a `<button>` sitting on the
seam. Styling stays with the caller."* Callers each invented that styling.

Four variants, on three tiers of accessibility:

| Variant | Files | Keyboard | Focus ring |
| --- | --- | --- | --- |
| `<button>` + `group/split` hairline | Agents(x2), Skills, AppletDoc, DocumentLibrary, Resources, GuideReview | yes | yes |
| `<button aria-label>` + `group/resize` | Inbox, AgentMemoryBrowser, Tenants | yes | via `FOCUS_RING` const |
| `<div role="separator" aria-label>` | Sidebar, WorkspaceRail, Tasks | no | no |
| bare `<div aria-hidden>` | ChatWindowContent | **no** | no |

`ChatWindowContent`'s divider is unreachable without a pointer. The `<div
role="separator">` three are announced but not focusable, which is arguably
worse than the honest `aria-hidden` one.

**Fix (done):** one `<ResizeHandle>` in `src/components/common/`, owning the
markup and classes. It renders the WAI-ARIA window-splitter element —
`role="separator"`, `tabIndex={0}`, `aria-orientation`, `aria-value*` — not a
`<button>`: a button announces "button" and invites Enter, which does nothing; a
separator announces its position and implies the arrow keys. `WorkspaceRail`
already had this exactly right and was the only one of the thirteen that did.
`usePaneSplit.dividerProps` now emits the `aria-value*` triple and is typed for
`HTMLElement`. The three sites with no hook (Sidebar, Tasks, Chat) each gained a
~10-line arrow-key handler so the tab stop actually does something.

Result: 13 of 13 migrated, `WorkspaceRail` included — it passes its
`data-workspace-rail-*` attributes and its own `aria-value*` straight through,
so nothing its drag code depends on moved. `grep cursor-col-resize src` now
matches the component and nothing else.

## Finding 2 — px type sizes (AGENTS.md convention, nearly done)

AGENTS.md says "roughly 300 px sites elsewhere are still waiting". **That is
stale.** Actual count is 44, of which 32 are the documented 7/8/9px exemption
and 2 are the `text-[0px]` badge trick. Ten real sites remain:

- `text-[13px]` x6 -> `text-[0.8125rem]` (App x1, WorkspaceRail x5) — done
- `text-[11px]` x2 -> `text-2xs` — done (all three carry an explicit `leading-*`,
  so the paired-line-height trap in AGENTS.md does not bite)
- `text-[11.5px]` x1 -> `text-2xs` — done

AGENTS.md's count corrected in the same change.

## Finding 3 — the same five shapes, hand-drawn per window (done)

A second sweep over every `className` repeated across three or more files
turned up compound patterns (a layout plus an icon plus a control), which are
components; single-atom repeats like `text-xs text-muted-foreground` x85 are not.

| Pattern | Before | After |
| --- | --- | --- |
| Search input with the glyph inside | 5 sites, 4 files, hand-positioned icon + `h-8 pl-8` | `common/SearchField` |
| Window toolbar band | 14 sites, 8 files, drifting h-10/h-11 and `border-b` with or without `border-border` | `WINDOW_TOOLBAR` token in `common/presentation.ts`; per-site extras via `cn()` |
| Onboarding card collapse/dismiss pair | 3 files, byte-identical apart from labels | `onboarding/CardActions` |
| Uppercase micro-label | 4 hand-rolls beside 59 uses of `.ui-section-label` | all on `.ui-section-label` |
| Hand-rolled `<input>` styled like `Input` | ReactionBar, CampaignComposer | `@agensis/ui` `Input` |

**Organise:** the app's type scale (`TEXT_BODY`/`TEXT_META`/`TEXT_MICRO`),
`PANE_HEADER`, `FOCUS_RING`, `PILL_BUTTON`, `LIST_COLUMN_CLASS`,
`SCROLL_VIEWPORT_BLOCK` and the row washes lived in
`inbox/inboxPresentation.ts` and were imported by five `tenants/` files via
`../inbox/…` — a feature-local file that had quietly become the app's design
tokens. Moved to `common/presentation.ts`; inbox keeps only its own
(`CATEGORY_ICON`, `categoryAccent`, `ROW_PADDING`, `ROW_AVATAR`).

Raw `<input>` left alone, on purpose: hidden/`sr-only` file pickers,
checkboxes/radios/colour, `ActivityWindowContent` (semantic
`.activity-tray-search`), `SkillChipsInput` (a combobox inside a chip
container), `InlineRename` and `ThreadWidgetRail` (bespoke inline editors).

## Finding 4 — file size

Six files carry 22,063 lines between them: `ChatWindowContent` 5179,
`AgentsWindowContent` 4729, `App.tsx` 4564, `TasksWindowContent` 2576,
`SettingsDialog` 2524, `Sidebar` 2491. Splitting these is pure-move
refactoring with real merge-conflict risk against the other 17 live worktrees.
**Deferred, not done** — logged here so it is not rediscovered.

## Not done in this pass, and why

Everything below is real and measured. None of it was attempted, because a
second agent was writing to this same worktree while the work was in flight
(see the note at the end of Finding 1) and each of these touches more shared
files than the resize seam did.

| Item | Count | Note |
| --- | --- | --- |
| Raw `<input>` -> `Input`/`Textarea`/`NativeSelect` | 23 lines | Lowest risk of the remaining set; start here. |
| Raw `<button>` -> `Button` | 203 lines | **Needs discrimination, not a sweep.** A raw `<button>` is drift only where it hand-rolls `variant="ghost" size="icon"`. Many are the targets of semantic selectors (`.sidebar-rail-button`, `.sidebar-agent-row>button`), and swapping those re-adds the frame the owner rejected twice. Hotspots: AgentsWindowContent 22, Sidebar 18, ChatWindowContent 12. |
| Icon tile (`grid size-7 place-items-center rounded-md bg-muted`) | 7 uses | Compound and behavioural; a real component. ChatWindowContent 5, Tasks 2. |
| Six files over 2,400 lines | 22,063 lines | `ChatWindowContent` 5179, `AgentsWindowContent` 4729, `App.tsx` 4564, `Tasks` 2576, `SettingsDialog` 2524, `Sidebar` 2491. Pure-move splits along the tab/section seams already visible in each. High conflict risk against the 17 other live worktrees. |

Deliberately NOT candidates: `text-xs text-muted-foreground` (x85) and the
other bare utility repeats. They are atoms. Wrapping them would touch 85 sites
and buy nothing.

## Second pass: the deferred list, worked

The blocker in the section above cleared (the other agent's refactor merged;
`main` went green), so the deferred items were re-measured on current `main`
and taken as far as the evidence supports.

**Native controls -> primitives (done).** Two sites rendered bare OS-default
controls in an app that ships `Checkbox` and `RadioGroup`:
`UsersWindowContent`'s controller-scope checkboxes and `AgentsWindowContent`'s
permission-mode radios. Both converted. `grep 'type="checkbox"|type="radio"'`
now matches only the HTML string `DocWindowContent` builds for the document
task list, which is generated markup, not JSX.

**`MENTION_TILE` (done).** The 28px leading tile on mention/command-picker
rows, drawn inline at 7 sites across `ChatWindowContent` (5) and
`TasksWindowContent` (2). A constant rather than a component because two of
the seven apply it to `AgentAvatar`'s `className` rather than wrapping.

**`WINDOW_SHELL` (done).** The root element of a window's content, byte-
identical at 6 sites. Only the roots: 4 near-misses drop `bg-transparent
text-foreground`, and on inspection 2 of those are early-return branches
rendering a different state and 2 are inner containers carrying `min-w-0` /
`flex-1` for nested flex. Different jobs, not drift. Left alone.

**Raw `<input>` x21: almost all legitimate.** 12 are `type="file"` behind
`hidden`/`sr-only` (a file trigger is not a styled control; `<Input>` would
style an invisible element), 1 is `type="color"` (the native picker IS the
control), 1 is inside an HTML string. The 2 `type="search"` are transparent
fields inside `PANE_HEADER` / `.activity-tray-search` semantic surfaces —
the same reason `SearchField`'s own header excludes the sidebar. Converting
them would nest a bordered input inside a header that already is the field.

**Raw `<button>` x191, worked through by classification.** Profiling every
raw button's `className` gives an almost flat distribution (most common shape:
3 occurrences), so there was never a sweep to do. Classified, all 191:

| Bucket | n | Verdict |
| --- | --- | --- |
| semantic-CSS targets | 27 | **Leave.** `sidebar-*`, `pixel-btn`, `file-tree-*`. CSS-driven by design; converting re-adds the row frame the owner rejected twice. |
| primary recipe | 6 | **5 fixed.** 1 was a hand-drawn `<Button>`; 3 were segmented controls; 2 are sub-primitive (below). |
| ghost recipe | 59 | **Leave — they are not buttons.** `w-full ... text-left` with full-width layout: these are list rows and menu items. `Button` is inline-flex, centred and fixed-height; it is the wrong control. The right target is the `Item` primitive, which is a separate and much larger semantic change. |
| link style | 12 | Candidates for `variant="link"`; each is a real visual change, unreviewed. |
| no className / other | 87 | One-offs and icon affordances; no shared recipe to extract. |

What that yielded:

- **`ComponentPickerOverlay`'s Cancel/Add pair** was a hand-drawn `<Button>`:
  `rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground`.
  Now `<Button size="xs">` + `variant="ghost"`. `size="xs"` is h-6/px-2/text-xs,
  so the conversion is near pixel-identical.
- **Three hand-rolled segmented controls became `ToggleGroup`**: the agents
  Yours/All owner filter, and the campaign composer's Match all/Match any.
  Both keep their exact appearance via `data-[state=on]:bg-primary` rather
  than taking the stock toggle's accent wash, and they gain roving focus and
  real single-select semantics. **The owner filter is the control the
  trap-state smoke gate recovers through** (the 2026-07-27 incident); the gate
  passes because `ToggleGroupItem` renders a `<button>`, which is the first
  entry in the harness's `CONTROL_SELECTOR`. Re-run and verified, not assumed.
- **`FILTER_CHIP_ON` / `FILTER_CHIP_OFF`**: the selectable filter chip's two
  states, six byte-identical copies across agents, the channel-template picker
  and the marketplace. The base stays with the caller (padding legitimately
  differs); the states do not.
- **`STATUS_CHIP`**: the agents status/presence chip shape, 3 copies in one
  file with 3 different selection rules.

The 2 primary-recipe buttons left are deliberately sub-primitive:
`ThreadWidgetRail`'s 20px send button sits in a `text-3xs` inline field and
`Button`'s smallest icon size is 24px, and `InboxSelectionBar`'s is a
select-all affordance drawn as a filled square. Both would get visibly larger.

Still deferred: the six files over 2,400 lines (unchanged reasoning).



taste-skill Section 13 puts dashboards, dense product UI and realtime collab
UIs (presence, cursors) out of scope. agensis is all three. Its *locks* (one
accent, one radius scale, one system, tokens over literals) were applied; its
landing-page rules (hero discipline, eyebrow counts, em-dash hunting) were not.
