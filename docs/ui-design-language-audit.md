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

## Finding 3 — file size

Six files carry 22,063 lines between them: `ChatWindowContent` 5179,
`AgentsWindowContent` 4729, `App.tsx` 4564, `TasksWindowContent` 2576,
`SettingsDialog` 2524, `Sidebar` 2491. Splitting these is pure-move
refactoring with real merge-conflict risk against the other 17 live worktrees.
**Deferred, not done** — logged here so it is not rediscovered.

## Scope note

taste-skill Section 13 puts dashboards, dense product UI and realtime collab
UIs (presence, cursors) out of scope. agensis is all three. Its *locks* (one
accent, one radius scale, one system, tokens over literals) were applied; its
landing-page rules (hero discipline, eyebrow counts, em-dash hunting) were not.
