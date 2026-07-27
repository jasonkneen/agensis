# visual-dev-editor

A dev-time visual editor for static sites. Inject it into a locally-running
site and you get a Webflow-lite editor: click elements on the live page, edit
text / CSS / classes / attributes, reorder or delete elements — every change is
applied to the real DOM immediately **and** written back into the actual HTML
source files on disk (byte-precise: only the edited span changes).

> ⚠️ **DEV ONLY.** The edit endpoint rewrites files on disk with no auth. Never
> ship it to production, never expose the server beyond localhost.

No build step, no framework. CommonJS server, plain-script browser client.
The only runtime dependency is `parse5`.

## Usage

### 1. Standalone server

```bash
npx visual-dev-editor ./my-site --port 4399
# → http://localhost:4399
```

Serves the static files in `./my-site` and injects the editor script into
every HTML page just before `</body>`.

### 2. Middleware (connect / express)

```js
const { createEditorMiddleware } = require('visual-dev-editor');

app.use(createEditorMiddleware({ root: __dirname + '/public' }));
// then your normal static serving
app.use(express.static(__dirname + '/public'));
```

The middleware handles `GET /__visual-editor/client.js` and
`POST /__visual-editor/edit`; everything else falls through to `next()`.

### 3. Script-tag injection

With your own dev server, just make sure the client script is served at
`/__visual-editor/client.js` (via the middleware above) and add to your HTML:

```html
<script src="/__visual-editor/client.js"></script>
```

Tear the editor down at any time with `window.__visualEditor.disable()` or the
× button in the toolbar.

## What you can edit

- **Navigator (left panel)** — searchable element tree. Rows carry a per-type
  icon (container / text / media / interactive / table / list), `#id` and
  `.class` badges, text snippets for leaves, a child-count badge on collapsed
  parents, and a hover eye button that hides an element (inline
  `display: none`, written to source and undoable) or shows one that an
  inline `display: none` is hiding; stylesheet-hidden elements render dimmed.
  The search field filters by tag, `#id`, `.class`, or leaf text (matches
  keep their ancestors and are dot-marked; Esc clears). Header buttons
  expand/collapse the whole tree; hovering any row highlights the element on
  canvas. Rows are draggable both ways: onto the canvas, or onto **other
  rows** to reorder/reparent — top ~25% of a row = insert before, bottom ~25%
  = after, middle 50% = drop into as last child, with validity markers (red
  when invalid), tree edge auto-scroll, and auto-expansion after an "into"
  drop.
- **Inspector (right panel)** — header shows the selected element's tag,
  `#id`, first class, live W×H, and source file. Two tabs:
  - **Design** — collapsible sections of style controls that read the
    *computed* style (muted placeholder) and write *inline* styles via
    `setStyle` (bright value + blue dot + reset ×): Layout (display
    segmented control; flex/grid-aware direction / justify / align / wrap /
    gap sub-controls), Spacing (a click-to-edit, drag-to-scrub margin/padding
    box-model editor with live W×H core), Size (W/H/min/max/overflow),
    Position (type + inset + z-index when non-static), Typography (family /
    size / weight / line-height / letter-spacing / color picker / align /
    style / transform / decoration), Background (color picker, bg-image
    note), Border (width/style/color/radius) and Effects (opacity slider,
    box-shadow, cursor). Numeric inputs step with ↑/↓ (Shift=±10, Alt=±0.1)
    and scrub by dragging their labels; edits preview live and commit on
    blur/Enter, Esc cancels.
  - **Element** — id, classes as removable chips (type + ⏎ to add), text
    content (leaf elements), arbitrary attributes, and raw inline CSS rows.
- **Breadcrumbs** — a strip along the bottom of the canvas shows the ancestor
  chain of the selection; click to select, hover to highlight.
- **Toolbar** — Select-mode toggle (also the `V` key), Move up / Move
  down, Delete, Undo, dock toggle (pushes the page aside via root margins
  instead of overlapping it — fixed-position page elements may not shift),
  animated save status, close.
- **Selecting** — the editor starts in select mode and stays in it: clicking
  anything on the page selects it, and the page itself is inert (links,
  buttons and inputs don't respond to clicks or focus). Click a tree row or
  breadcrumb, or use the keyboard: ↑/↓ walk the visible tree, → expands /
  first child, ← collapses / parent, Esc clears the filter then the
  selection, Delete/Backspace removes the selected element (no confirm —
  undo covers it). Toggle the mode off (`V`, the Select button, or Esc with
  nothing selected) to browse the page normally again — or just **hold
  Space** to momentarily invert the mode: hold to test the live page while
  editing (or to edit while browsing), release and you're back.
- **Drag-and-drop** — with an element selected, press on it and drag (4px
  threshold): a semi-transparent ghost of the element follows the pointer and
  a live insertion marker shows where it would land (2px line for
  before/after, outline box for dropping into an empty container, red when the
  target is structurally invalid). Escape cancels. Validity follows a
  simplified HTML content model (`canContain`): void/embedded elements accept
  nothing, phrasing parents reject block children, `li` only into list
  parents, table parts only into their table contexts, `option`/`optgroup`
  only into `select`/`datalist`, and `html`/`head`/`body` are never draggable.
- **Undo** — Ctrl/Cmd+Z or the Undo button reverts the last edit in both the
  DOM and the source file (per-file in-memory stacks, ~50 deep). Redo is not
  supported.
- **Consistency** — if the server rejects an edit, the DOM mutation is rolled
  back automatically, so the page never diverges from the file on disk.
  Style edits from the Design tab always target the element's inline `style`
  attribute; stylesheet rules are read (as computed values) but never
  modified — the reset × on a control removes the inline declaration and
  falls back to the stylesheet.

## How source patching works

The browser computes the target element's *element-only child-index path* from
`<html>` (text/comment nodes skipped). The server re-parses the source file
with `parse5` (`sourceCodeLocationInfo: true`), walks the same path, and
patches the **original source string** using the node's source offsets — so
everything outside the edited span stays byte-identical. The patched result is
re-parsed as a sanity check before the file is written.

Ops: `setText` (leaf elements only), `setAttr` (double/single/unquoted/
valueless forms, `value: null` removes), `setStyle` (declaration-level
add/remove inside the `style` attribute), `move` (swap with previous/next
element sibling, whitespace preserved), `moveTo` (cut the element and
re-insert it as the `index`-th element child of the element at `parentPath`,
with indentation matched to the reference sibling / parent; `parentPath` and
`index` are resolved **after** the cut, so they always describe the
post-removal tree), `remove`. `POST /__visual-editor/undo` `{ file }` restores
the file's previous source from the in-memory per-file undo stack.

For single-file pages the edited file is inferred from `location.pathname`.
If your page is assembled from multiple source files, mark regions with
`data-ve-file="path/relative/to/root.html"` — the nearest ancestor's value
wins.

## Try the demo

A ready-made demo site lives in `examples/` (two pages, stylesheet included):

```bash
npm run demo
# → http://localhost:4399
```

Edits made through the editor are written into `examples/*.html`, so you can
inspect the byte-precise source patching afterwards (undo with Ctrl/Cmd+Z, or
`git checkout -- examples/` to reset everything).

## Tests

```bash
npm install
npm test
```
