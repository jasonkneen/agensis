# FB-001 — Keyboard shortcut to cycle between canvas windows

- **Reference:** FB-001
- **Type:** Feature request
- **Source task:** `agensis://task/7a2e7225-a984-4dbe-87a7-c7d15f0812c9`
- **Reported by:** Jason (user feedback)
- **Date filed:** 2026-09-12
- **Status:** Ready for eng handoff — no code changed
- **Owner suggestion:** Frontend / window-manager

## Description

Agensis' internal canvas (floating) windows have **no dedicated keyboard shortcut for
cycling focus between them**. Today the only way to switch windows is by clicking in the
window dock. Power users expect an OS-style "cycle windows" keybind (e.g. `Ctrl`+`` ` ``
or `Cmd`+`` ` ``) to step through open windows without leaving the keyboard.

## Original message from the user

> Agensis' internal canvas windows do not currently have a dedicated keyboard shortcut
> for cycling between them. Use the window dock; adding a shortcut there would require an
> app change.
>
> Page: /Applications/agensis.app/Contents/Resources/app.asar/dist/index.html — Main

## Codebase findings

The floating-window system already exposes everything a cycle shortcut needs — this is an
additive change, not a rearchitecture.

- **`src/providers/WindowManagerProvider.tsx`** — wraps a single `useWindows()` call and
  exposes the full window API via `useWindowManager()`: `windows` (the ordered list),
  `focusWindow`, `focusWindowGroup`, `minimizeWindow`, `selectedWindowIds`, plus z-order
  and tiling helpers. A cycle action can be built purely on top of `windows` +
  `focusWindow`.
- **`src/hooks/useWindows.ts`** — owns window lifecycle, z-order and focus. Windows are
  tracked as an ordered collection, so "next/previous by z-order (or creation order)" is
  derivable here without new state.
- **`src/App.tsx`** (~line 1260–1266) — there is already a **global `keydown` handler**
  registered on `window`; it currently handles `Cmd/Ctrl+K`. This is the natural home for
  a new window-cycle binding — add a branch alongside the existing shortcut.
- **`src/components/windows/MobileWindowSwitcher.tsx`** — the dock UI (the current,
  mouse-only switch path). Useful as the reference for what "switching" should visually do.
- **`src/components/windows/WindowGroupFrame.tsx`** / `focusWindowGroup` — grouped/tiled
  windows exist, so the cycle logic should decide whether it steps window-by-window or
  group-by-group (recommendation below).

No existing keyboard shortcut cycles windows — confirmed by searching `keydown` /
`metaKey` / `ctrlKey` usage across `src`.

## Recommendation

Small, self-contained frontend change:

1. **Add a `focusNextWindow(direction)` / cycle helper** in `useWindows.ts` (or a thin
   wrapper in `WindowManagerProvider`) that orders visible, non-minimized windows and
   calls `focusWindow` on the next/previous one, wrapping around at the ends.
2. **Bind it in the existing global handler in `App.tsx`:**
   - `Ctrl`+`` ` `` → cycle forward, `Ctrl`+`Shift`+`` ` `` → cycle backward
     (mirrors macOS "cycle windows of app"; avoids clashing with `Cmd+K`).
   - Guard against firing while focus is in a text input / editor.
   - Skip minimized windows, or restore-then-focus them.
3. **Group behaviour:** step group-by-group using `focusWindowGroup` when a window belongs
   to a tiled group, so cycling doesn't feel "stuck" inside one composite frame.
4. **Discoverability:** show the shortcut hint in the window dock tooltip
   (`MobileWindowSwitcher`) and/or the command palette.
5. **Testing:** unit-test the ordering/wrap-around helper; add a light interaction test
   that the keybind moves focus and skips minimized windows.

**Effort:** low — reuses existing focus API and the existing global key handler.
**Risk:** low — additive; main care is not stealing keystrokes from inputs/editors.

## Open questions for eng / product

- Preferred keybind? (`Ctrl+`` ` `` vs `Cmd+`` ` `` — note `Cmd+`` ` `` is macOS system
  "cycle app windows" and may be intercepted by the OS in the desktop build.)
- Cycle **window-by-window** or **group-by-group** as the default?
- Include minimized windows in the cycle (restore on focus), or skip them?
