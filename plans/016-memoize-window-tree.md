# Plan 016: Stabilize App-level props and memoize the window tree

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 871b535..HEAD -- src/App.tsx src/components/windows/ src/components/layout/Sidebar.tsx`
> App.tsx especially churns; on any drift, re-locate the excerpted code by
> content (search for the identifiers, not the line numbers) before proceeding.
> If a cited structure no longer exists, STOP.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (plans 011/012 reduce render *frequency*; this plan reduces render *cost*. Land 011/012 first for easier before/after profiling.)
- **Category**: perf
- **Planned at**: commit `871b535`, 2026-07-04

## Why this matters

`App.tsx` (3,011 lines) holds ~29 `useState` hooks plus a dozen data hooks, and
renders every floating window inline. **No component in `src/components` is
wrapped in `React.memo`** (`grep -rln "memo(" src/components` → empty), and the
window tree receives freshly-allocated inline arrow functions and JSX elements
on every render — so memoization added naively would be defeated by prop
identity churn. Consequence: ANY App-level state change (a streamed token, a
cursor frame, a notification, a settings toggle) re-renders every open window,
the sidebar, and the canvas. This plan (a) memoizes derived collections, (b)
stabilizes the props App passes down, then (c) wraps the window-content
components in `React.memo` — in that order, because (c) is useless without (b).

This is the structural fix that multiplies plans 011 and 012: after it, a chat
stream flush re-renders one chat window instead of the world.

## Current state

- `src/App.tsx:798-817` — derived collections rebuilt every render, unmemoized:

```ts
const visibleCanvasObjects = canvasObjects.filter(
  obj => (obj.layer_id || 'base') === viewedLayerId,
);
const visibleGroupIds = new Set(visibleCanvasObjects.map(obj => obj.group_id).filter(Boolean));
const visibleCanvasGroups = canvasGroups.filter(group => visibleGroupIds.has(group.id));
const exactWorkspaceWindows = focusedRemotePresence ? ... : windows;
const activeWindows = exactWorkspaceWindows.filter(win => (win.canvasId || 'base') === viewedLayerId);
const dockWindows = windows.filter(win => (win.canvasId || 'base') === activeLayerId);
const focusedDockWindow = dockWindows.filter(...).reduce(...);
const dockEntries = groupDockWindows(dockWindows);
```

- `src/App.tsx:2043-2047` — per-window O(windows) scan inside the render map:

```tsx
{renderedWindows.map(win => {
  const presenceMode = getPresenceMode(win.ownerUserId);
  const isWindowOwner = !win.ownerUserId || win.ownerUserId === userId;
  const canControlWindow = isWindowOwner && !(win.locked && !isWindowOwner);
  const adjacentEdges = computeAdjacentEdges(win, windows);
```

- `src/App.tsx:1533+` — `CanvasLayerScene` receives dozens of props, several
  created inline per render, e.g. `onCreateSubThread` at `:1587` is an inline
  `async (messageId, agent, messageContent?) => {...}` closure; similar inline
  arrows exist for handlers like `onDeleteDocument` (~`:1616`) and `onAddFact`
  (~`:1630`). Per-chat-window `contextControls={<KnowledgeContextControl .../>}`
  JSX is rebuilt each render (~`:2089`, `:2125`).
- Window content components are plain functions: `ChatWindowContent`
  (`src/components/windows/ChatWindowContent.tsx`), `DocWindowContent`,
  `TasksWindowContent`, `ActivityWindowContent`, `AgentsWindowContent`,
  `UsersWindowContent`, plus `Sidebar` (`src/components/layout/Sidebar.tsx`).
- `FloatingWindowShell` drag/resize is already imperative (direct style
  transforms) — its interaction path needs no change.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Typecheck | `npm run typecheck` | exit 0              |
| Lint      | `npm run lint`      | exit 0 (react-hooks rules will catch bad dep arrays — heed them) |
| Unit tests| `npm run test:unit` | all pass            |
| Node tests| `npm test`          | all pass            |
| Build     | `npm run build`     | exit 0              |

## Suggested executor toolkit

- If the `vercel:react-best-practices` skill is available in your environment,
  read its memoization guidance before step 3.
- React DevTools Profiler (dev run) is the ground truth for "did the window
  stop re-rendering" — use it if a browser is available.

## Scope

**In scope**:
- `src/App.tsx`
- `src/components/windows/ChatWindowContent.tsx`, `DocWindowContent.tsx`,
  `TasksWindowContent.tsx`, `ActivityWindowContent.tsx`,
  `AgentsWindowContent.tsx`, `UsersWindowContent.tsx` (wrapping in `React.memo`
  only — no internal changes)
- `src/components/layout/Sidebar.tsx` (memo wrap only)

**Out of scope**:
- `src/components/windows/FloatingWindowShell.tsx` — drag path already optimal;
  memoizing the shell risks breaking z-order/selection updates.
- Any behavioral change to handlers — this plan only changes *identity
  stability*, never logic.
- `useChat.ts` / stream internals (plan 011), presence/cursors (plan 012).
- `DrawingLayer.tsx` — already imperative.

## Git workflow

- Branch: `perf/016-memoize-window-tree`
- Commit **per step** — each step is independently shippable and revertable.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Memoize derived collections (cheap, zero-risk warmup)

Wrap the `App.tsx:798-817` block in `useMemo`s with precise deps:

- `visibleCanvasObjects` → `useMemo(..., [canvasObjects, viewedLayerId])`
- `visibleGroupIds` + `visibleCanvasGroups` → one `useMemo` returning both, deps `[visibleCanvasObjects, canvasGroups]`
- `exactWorkspaceWindows`/`activeWindows` → `useMemo(..., [focusedRemotePresence, windows, viewedLayerId])`
- `dockWindows`/`focusedDockWindow`/`dockEntries` → one `useMemo`, deps `[windows, activeLayerId]`

In the `renderedWindows.map` (~`:2043`), hoist an adjacency lookup above the
map: `const adjacencyByWindowId = useMemo(() => new Map(windows.map(w => [w.id, computeAdjacentEdges(w, windows)])), [windows]);`
and use `adjacencyByWindowId.get(win.id)` inside the map. (Check
`computeAdjacentEdges`'s signature first; if it depends on more than `(win, windows)`, include those deps.)

**Verify**: `npm run typecheck` && `npm run lint` → exit 0 (lint's
react-hooks/exhaustive-deps must be clean on the new memos).

### Step 2: Stabilize the props App passes to the window tree

Convert the inline arrow props passed to `CanvasLayerScene` / window contents
into `useCallback`s declared before the JSX (search App.tsx for `={async (` and
`={(` occurrences inside the JSX from ~line 1499 down; the audit flagged
`onCreateSubThread` `:1587`, `onDeleteDocument` `:1616`, `onAddFact` `:1630` as
examples — convert ALL function-valued props passed to window/scene components,
there are on the order of dozens). Hoist the per-window
`contextControls={<KnowledgeContextControl .../>}` JSX into a
`useMemo`/`useCallback`-derived element or pass the underlying data and let the
child render the control.

Rules:
- Every `useCallback` dep array must satisfy `eslint-plugin-react-hooks` with no
  suppressions.
- Do not change any handler's body/behavior. Mechanical extraction only.
- Where a handler closes over a per-window variable inside `renderedWindows.map`,
  leave it inline for now and note it — per-item callbacks are step 4 material
  if profiling demands it; do not invent a registry pattern.

**Verify**: `npm run typecheck` && `npm run lint` → exit 0; `npm run test:unit` && `npm test` → pass.

### Step 3: Wrap the leaves in React.memo

Wrap the export of each in-scope window content component and `Sidebar`:
`export const ChatWindowContent = React.memo(function ChatWindowContent(...) {...})`
(preserving named exports — check each file's export form first and keep it).

**Verify**: `npm run typecheck` && `npm run lint` && `npm run build` → exit 0.

### Step 4: Profile & report (no code)

If a browser is available: `npm run dev`, React DevTools Profiler, record while
(a) a chat reply streams, (b) idle for 10s. Report which components still
re-render and why (the Profiler shows the changed props). Do NOT chase the
remaining ones in this plan — list them in the completion report for a
follow-up decision.

## Test plan

- Existing suites: `npm run test:unit` and `npm test` must stay green after
  every step.
- Behavioral smoke (dev): open chat + doc + tasks windows; type in chat; drag a
  window; switch layers; toggle a task; open Settings and change theme. All
  interactions must behave identically — this plan changes no behavior.
- The profiler evidence in step 4 stands in for automated render-count tests
  (the repo has no react render-count test infrastructure; do not add one here).

## Done criteria

- [ ] All five commands (typecheck, lint, test:unit, test, build) exit 0
- [ ] `grep -rln "memo(" src/components/windows src/components/layout/Sidebar.tsx` lists the 7 wrapped files
- [ ] The `App.tsx:798-817` derived block is inside `useMemo`s
- [ ] Zero eslint-disable suppressions added (`git diff | grep -c eslint-disable` → 0)
- [ ] No behavioral changes (smoke checklist above)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any smoke behavior differs (a handler acting on stale state is the classic
  useCallback-with-wrong-deps failure) — stop after one fix attempt and report
  the exact handler.
- You need an `eslint-disable react-hooks/exhaustive-deps` to make a dep array
  work — that means the handler genuinely depends on churning state and needs a
  design decision, not a suppression.
- A cited structure in App.tsx no longer exists (drift).
- The step-2 conversion balloons past ~40 handlers — report the count and land
  steps 1+3 for the components whose props are already stable.

## Maintenance notes

- New props added to memoized components MUST be identity-stable — a code-review
  checklist item from now on; one inline arrow silently reverts the win for that
  window.
- Follow-ups deferred from this plan: React.lazy code-splitting of the window
  components (BUNDLE-03), memoizing `ChatMessageBubble`'s ~20 callback props
  inside ChatWindowContent (same technique, applied one level down), and
  moving cursor rendering into a leaf subscriber component so cursor state
  leaves App entirely.
