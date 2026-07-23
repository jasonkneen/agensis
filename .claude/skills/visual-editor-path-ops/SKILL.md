---
name: visual-editor-path-ops
description: Rules for touching element-path or DOM-ordering code in visual-editor/src/client.js and server.cjs (move, moveTo, remove, drag-drop, or anything that calls elementPath/opFor/adjustPathForRemoval). Use this before adding a new op type, changing how a path or index is computed, adding a new place that reads el.children, or fixing a "wrong element moved / server picked the wrong sibling" bug. This subsystem has already shipped one bug from computing the path after mutating the DOM, and the fix pattern (snapshot path before mutating, adjust indices explicitly when parent changes) is easy to reintroduce in a new op if you don't know it's the rule.
---

# Path/order ops in the visual editor

`visual-editor/README.md` documents *what* each op does (`move`, `moveTo`,
`remove`, undo). This skill covers the one rule that isn't obvious from
reading the ops table: **when** in the mutation you're allowed to compute a
path or index.

## The failure that already happened

Commit `cdaa6e4`: "move up/down" computed the element's path *after*
`insertBefore` had already repositioned it in the DOM. `elementPath()` walks
current sibling order, so the path it produced described the post-move tree —
the server then patched whatever source element happened to sit at that index
now, not the element the user actually dragged. Wrong element got moved, or an
out-of-bounds sibling error if the move was at an edge.

## The rule

**Compute `elementPath()` / `opFor()` / any index from the DOM *before* you
call `insertBefore`, `appendChild`, or `.remove()` for that op — never after.**
Capture it into a local (`var op = opFor(el, {...})`) first, mutate the DOM
second, `sendEdit(op, ...)` third. See `move()` and `finishDrop()` in
`client.js` for the pattern in practice — both have a comment marking the
capture-before-mutate line; keep that comment if you touch either function.

**When the move crosses parents or reorders siblings, the raw pre-mutation
path is not enough — you also need to adjust indices for the cut.**
`adjustPathForRemoval()` (`client.js`) shifts a `parentPath` index down by one
when the removed element was an earlier sibling anywhere along that path;
`finishDrop()` separately decrements `index` when reordering within the same
parent past the removal point. The server independently re-derives
post-removal coordinates for `moveTo` (`server.cjs` around the `parentPath`
handling) — if you add a new cross-parent op, both sides need this adjustment
or they'll disagree about where element N ends up.

**Never index `el.children` directly when walking the page tree — use
`pageChildren(el)`.** Raw `.children` includes the editor's own injected
elements (the shadow host, the drag ghost tagged `data-ve-editor-el`, the
injected `<script>` tag). `pageChildren()` / `isOurs()` filter those out so
indices match the server's `parse5` walk of the *source file*, which never
had the editor injected into it. If you add a new tree-walking helper, route
it through `pageChildren`, not `el.children`.

## Quick self-check before committing a change here

- Grep the diff for `insertBefore(`, `appendChild(`, `.remove()` — for each
  one, confirm the op's path/index was captured on an earlier line, not
  computed from `el`/`parent` after that call.
- If the op can move an element to a different parent, confirm both ends
  (client `adjustPathForRemoval`-style logic, server `parentPath` handling)
  agree on whether coordinates are pre- or post-removal.
- If you added a new DOM query, confirm it went through `pageChildren`/
  `isOurs`, not raw `.children`.
- Run `npm test` in `visual-editor/` — `test/patcher.test.cjs` covers `moveTo`
  and undo tracking and will catch most index-off-by-one regressions.
