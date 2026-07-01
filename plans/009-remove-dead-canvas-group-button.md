# Plan 009: Remove the non-functional canvas multi-window "Group" button

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- src/components/canvas/CanvasSelectionLayer.tsx src/hooks/useWindows.ts`
> If either file changed since this plan was written, re-read the excerpts below against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (dead feature)
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

When a user rubber-band-selects 2+ floating windows on the canvas, an action bubble appears with a
"Group" button. Clicking it calls `groupWindows`, which stamps a `layoutGroupId` field onto the
selected windows and clears the selection — and nothing else happens. That field is read in exactly
one other place in the entire codebase (a presence-broadcast payload nobody consumes for grouping
purposes), there is no dock clustering, no synced drag/resize, no visual indicator that windows are
grouped, and `ungroupWindows` (the only function that ever clears the field) has zero callers
anywhere. This is a shipped, user-facing button that does nothing observable — worse than not
having the feature, because it implies grouping happened when it didn't. This plan removes the
dead affordance now; wiring up real grouping behavior (if wanted) is a separate, larger feature
decision, not a bug fix, and is explicitly deferred (see Maintenance notes).

## Current state

**`src/components/canvas/CanvasSelectionLayer.tsx:134-159`** — the action bubble shown after a
multi-window rubber-band selection:

```tsx
{actionBubble && (
  <div
    className="absolute flex items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 shadow-md"
    style={{ left: actionBubble.x, top: actionBubble.y, transform: 'translateX(-50%)', zIndex: 9995 }}
    onPointerDown={e => e.stopPropagation()}
  >
    <span className="text-xs text-muted-foreground">{selectedWindowIds.length} windows selected</span>
    <button
      className="text-xs font-medium text-primary hover:underline"
      onClick={() => groupWindows(selectedWindowIds)}
    >
      Group
    </button>
    <button
      className="ml-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={clearSelection}
      aria-label="Clear selection"
    >
      ×
    </button>
  </div>
)}
```

**`src/hooks/useWindows.ts:557-568`** — `groupWindows`/`ungroupWindows`, in full:

```ts
const groupWindows = useCallback((ids: string[]) => {
  if (ids.length < 2) return;
  const groupId = `layout_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  setWindows(prev => prev.map(w => ids.includes(w.id) ? { ...w, layoutGroupId: groupId } : w));
  setSelectedWindowIds([]);
}, []);

const ungroupWindows = useCallback((groupId: string) => {
  setWindows(prev => prev.map(w => w.layoutGroupId === groupId ? { ...w, layoutGroupId: undefined } : w));
}, []);

return { windows, openWindow, closeWindow, focusWindow, updateWindow, minimizeWindow, selectedWindowIds, setSelectedWindowIds, groupWindows, focusWindowGroup, minimizeWindowGroup, ungroupTiledWindows, ungroupWindows };
```

Confirmed at planning time via repo-wide grep: `ungroupWindows` has **zero** call sites outside its
own definition and the `useWindows()` return object; `layoutGroupId` is read in exactly one other
place, `src/hooks/useItemPresence.ts:66` (`layoutGroupId: win.layoutGroupId,` inside a presence
broadcast payload that no other code reads for grouping purposes). This is distinct from the
*tiled*-window grouping concept (`win.groupId`, set by drag-to-split), which **is** fully wired up
(dock clustering, live drag-sync) — do not confuse the two fields.

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Typecheck        | `npm run typecheck`               | exit 0, no errors                |
| Lint             | `npm run lint`                    | 0 errors                          |
| Node test suite  | `npm test`                        | all pass (baseline 119)          |
| Vitest suite     | `npm run test:unit`               | all pass (baseline 46)           |

## Scope

**In scope** (the only files you should modify):
- `src/components/canvas/CanvasSelectionLayer.tsx` (remove the "Group" button only; keep the
  selection-count label and the "×" clear-selection button)
- `src/hooks/useWindows.ts` (remove `groupWindows`/`ungroupWindows` and their entries in the
  returned object, and the `layoutGroupId` field's write path — see Step 2 for how far to go)
- `src/types/index.ts` (remove the `layoutGroupId?: string` field from `FloatingWindow`, per Step 2)
- `src/hooks/useItemPresence.ts` (remove the now-dead `layoutGroupId: win.layoutGroupId` line from
  the presence payload, per Step 2)
- `src/providers/WindowManagerProvider.tsx` (remove `groupWindows`/`ungroupWindows` from the context
  value if this plan removes them from `useWindows.ts` — keep in sync)

**Out of scope** (do NOT touch, even though they look related):
- `win.groupId` / `ungroupTiledWindows` / `focusWindowGroup` / `minimizeWindowGroup` and the entire
  tiled-window dock-clustering system (`App.tsx`'s `computeAdjacentEdges`/`groupDockWindows`,
  `useWindows.ts`'s `maybeSplitPartner`/`mirrorResizeOntoSibling`/`syncGroupBounds`,
  `FloatingWindowShell.tsx`'s `groupSiblingShells`) — this is a **different, fully-functional**
  grouping concept (tile/split-based, not multi-window-selection-based); do not touch it, remove it,
  or rename it to "look less confusing" as part of this plan. Confirm you're not touching this by
  checking that every line you remove references `layoutGroupId` specifically, never `groupId`.
- The rubber-band multi-select mechanism itself (`toSelectionRect`/`rectsIntersect` in
  `CanvasSelectionLayer.tsx`) — keep multi-select working; only remove the non-functional "Group"
  action that appears once a selection exists. The "×" clear-selection button and the
  `{selectedWindowIds.length} windows selected` label should remain.

## Steps

### Step 1: Remove the "Group" button from the action bubble

In `CanvasSelectionLayer.tsx`, delete the `<button onClick={() => groupWindows(selectedWindowIds)}>
Group</button>` element (lines ~146-151 per the excerpt above), leaving the selection-count label
and the "×" clear-selection button in place. Remove the now-unused `groupWindows` from this
component's destructuring of `useWindowManager()` (~line 28) if it's not used elsewhere in the
file.

**Verify**: `npm run typecheck` passes; `grep -n "groupWindows" src/components/canvas/CanvasSelectionLayer.tsx`
returns no matches.

### Step 2: Remove the dead `groupWindows`/`ungroupWindows`/`layoutGroupId` plumbing

Remove `groupWindows` and `ungroupWindows` from `useWindows.ts` (the function definitions at
557-566 and their entries in the hook's returned object at line 568). Remove `groupWindows`/
`ungroupWindows` from `WindowManagerProvider.tsx`'s destructuring/context value/memo dependency
array (wherever they appear — check lines ~27, 31, 35-36 per the recon). Remove
`layoutGroupId?: string` from the `FloatingWindow` type in `src/types/index.ts`. Remove the
`layoutGroupId: win.layoutGroupId,` line from the presence payload in
`src/hooks/useItemPresence.ts:66`.

**Verify**: `npm run typecheck` passes (a lingering reference to a removed field/function anywhere
else in the codebase would surface as a type error here — that's the main safety net for this
step); `grep -rn "layoutGroupId\|groupWindows\|ungroupWindows" src/` returns no matches anywhere.

### Step 3: Confirm tiled-window grouping is untouched

Manually confirm (or rely on Step 2's typecheck) that `win.groupId`, `ungroupTiledWindows`,
`focusWindowGroup`, `minimizeWindowGroup`, `computeAdjacentEdges`, `groupDockWindows`,
`maybeSplitPartner`, `mirrorResizeOntoSibling`, and `syncGroupBounds` are all still present and
untouched in `useWindows.ts`/`App.tsx`/`FloatingWindowShell.tsx`.

**Verify**: `grep -n "groupId\b" src/hooks/useWindows.ts src/App.tsx src/components/windows/FloatingWindowShell.tsx`
still shows the same call sites as before this plan (i.e. this plan's diff shows zero lines removed
from any of those `groupId`-related — not `layoutGroupId`-related — functions).

## Test plan

No new automated tests are needed — this is a pure removal of dead code with no new behavior to
test. If the repo later gains React-component-test infrastructure (tracked as a separate finding,
"no component-test infra exists"), a regression test that a multi-window selection's action bubble
shows only the count label and clear button (no "Group" action) would be a reasonable addition at
that time — not required for this plan.

Run the existing suites to confirm no regression: `npm run typecheck`, `npm run lint`, `npm test`,
`npm run test:unit`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits with 0 errors
- [ ] `npm test` and `npm run test:unit` exit 0, no regressions
- [ ] `grep -rn "layoutGroupId\|groupWindows\|ungroupWindows" src/` returns no matches
- [ ] `grep -n "groupId\b" src/hooks/useWindows.ts` still shows the tiled-window grouping functions
      unchanged (this plan removed zero lines from that system)
- [ ] Multi-window rubber-band selection still works and shows the selection-count label + clear
      button (manually confirmed, since no automated UI test exists for this)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Removing `layoutGroupId` from `FloatingWindow` causes a typecheck error in a file not listed in
  Scope — that means the field is used somewhere this plan's recon missed; report back with the
  new location rather than expanding scope unilaterally.
- Any test (existing or new) fails after this removal in a way connected to windows/canvas/presence
  — stop and report which test and why, rather than modifying the test to pass.

## Maintenance notes

- If real multi-window grouping (synced drag/resize/dock-clustering for a rubber-band-selected set,
  as opposed to the existing tile/split-based grouping) is wanted as a product feature later, that
  is a new feature to design and build from scratch, informed by how the *tiled* grouping system
  already does it (`groupId`, dock clustering in `App.tsx`, drag-sync in `useWindows.ts`/
  `FloatingWindowShell.tsx`) — it is not a matter of "finishing" `layoutGroupId`, since this plan
  removes that half-built path entirely rather than leaving it as a foundation to build on.
