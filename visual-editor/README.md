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

- **Left panel** — element hierarchy outline (lazy-collapsible, text snippets
  for leaf elements). Click a row to select.
- **Right panel** — for the selected element: id, classes, text content (for
  text-leaf elements), arbitrary attributes, and inline styles, all two-way.
- **Bottom toolbar** — Select (crosshair click-to-pick), Move up / Move down
  (reorder among element siblings), Delete (with confirm), save status, close.

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
element sibling, whitespace preserved), `remove`.

For single-file pages the edited file is inferred from `location.pathname`.
If your page is assembled from multiple source files, mark regions with
`data-ve-file="path/relative/to/root.html"` — the nearest ancestor's value
wins.

## Tests

```bash
npm install
npm test
```
