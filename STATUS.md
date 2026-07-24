# Status — landing page + visual-dev-editor

_Last updated: 2026-07-23 · HEAD `2d00c2a` (pushed, deployed)_

## Live state

- `https://agensis.io/` → **landing page** ("agensis — where agents come to work")
- `https://agensis.io/app` → **web app** (login / SPA)
- Login flow: landing CTAs → `/app`; desktop app loads its own bundle and logs in independently (no deep-link between website and desktop app).

## Landing page (`public/landing/index.html`)

Static, self-contained, no build step; `dist/` is kept in sync by `vite build`.

- Served at root via `netlify.toml` rewrite `/` → `/landing/index.html` with
  **`force = true`** — required, because `dist/index.html` is a real file and
  Netlify serves real files ahead of rewrites.
- Hero: "A place where / _agents work._" + "hub for distributed humans and
  agents" sub-copy.
- Section 01: "Agents in a team, / not in a box." + invite-don't-define copy,
  with the **hub network diagram** on the right (SVG+SMIL, no JS): agensis core,
  humans / agents / skills / code / knowledge / tools nodes, spokes + ring +
  cross-links, animated pulses, reduced-motion safe.
- Sections: ticker, mesh transcript, capabilities, CTA, footer.
- **Open nit:** `<title>`/og tags still say the old tagline "where agents come
  to work" (hero is now "A place where agents work").

## Service worker / caching (the "root keeps going to login" saga)

Root cause chain, all fixed and deployed:

1. Old PWA service worker served the cached SPA at `/` → login at the root URL.
2. `navigateFallbackDenylist: [/^\/$/]` in the Workbox config → `/` always goes
   to network (landing). Live in `sw.js`.
3. `skipWaiting` + `clientsClaim` → stale workers self-expire via the browser's
   routine update check; no user action needed.
4. `AppUpdateManager` mounted on the auth screen too (was post-auth only), so
   logged-out users get SW registration + update prompts.
5. Root-bounce guard in `index.html`: if the SPA shell is ever served at `/` or
   `/index.html`, it redirects to `/app` preserving query + hash (OAuth/invite
   callbacks and CLI launch params survive). Login structurally cannot run on
   the bare origin.

## visual-dev-editor (`visual-editor/`)

Independent package (dev-only), one dep (`parse5`), no build step.
Run: `node visual-editor/bin/cli.cjs <site-dir> --port 4399`, or middleware, or
script-tag injection. **34/34 unit tests.**

- Left — **Navigator**: searchable tree (tag/#id/.class/text filter w/ hit
  marks), per-type SVG icons, child-count badges, hidden-element dimming +
  hide/show eye (inline `display:none`, undoable), hover→canvas highlight,
  expand/collapse-all, keyboard nav (↑↓←→, Esc, Delete), agensis-branded
  dark theme (blue/mint/amber on near-black, frosted panels).
- Right — **Inspector**: header chip (tag #id .class + live W×H + file),
  Design tab (computed-aware style controls that write inline styles:
  display segmented + flex/grid sub-controls, margin/padding **box-model
  editor** w/ click-to-edit + drag-to-scrub, size, position, typography w/
  color picker, background, border, effects w/ opacity slider; ↑/↓ stepping,
  live preview, blur/Enter commit, Esc cancel, reset-× per control) and
  Element tab (id, class chips, attributes, text, raw inline CSS).
- **Breadcrumbs** strip along the canvas bottom (click to select ancestors).
- Bottom toolbar: Select (V), Move up/down, Delete, Undo, dock toggle
  (pushes page aside via root margins), animated save status, close.
- Selection: crosshair, dbl-click on page, tree row, breadcrumb, keyboard.
  Selection overlay shows devtools-style margin/padding rings + label.
- Edits apply to the live DOM **and** splice the HTML source byte-faithfully
  (parse5 source-location offsets); rollback on server error keeps DOM and
  source in sync.
- Drag-and-drop: on-canvas (selection-first, ghost follows pointer, live
  before/after/inside markers, content-model validity rules, edge auto-scroll)
  and tree-to-tree (top 25% = before, bottom 25% = after, middle 50% = into,
  on 22px rows — the old fiddly 6px band is gone).
- Undo: Ctrl/Cmd+Z + toolbar button; per-file server snapshot stacks,
  byte-exact restores. Delete no longer confirms (undo covers it).
- Ops: `setText`, `setAttr`, `setStyle`, `move` (sibling swap), `moveTo`
  (reparent), `remove`, `undo` — server untouched by the panel overhaul.

**Known nits:** server ops are tag-agnostic (validity rules are
client-advisory only); dock mode shifts the page with root margins, so
fixed-position page elements don't move; Design-tab edits write inline
styles only (stylesheets are read, never modified).

## Deploy flow (important)

**`git push` does NOT deploy.** There is no GitHub→Netlify auto-deploy hook.
Ship with:

```bash
git push origin main
netlify deploy --build --prod
```

## Key commits (this work)

| Commit | What |
|---|---|
| `f6b4d03` | Landing at root, app at /app |
| `5fd75ca` | `force = true` on the root rewrite |
| `de7d260` | AppUpdateManager on auth screen |
| `d757224` | SW self-expiry (skipWaiting/clientsClaim) |
| `13e476e` | SPA root-bounce guard |
| `12435c4` | Landing copy changes |
| `3030adf` | visual-dev-editor package |
| `cdaa6e4` | Move up/down path fix |
| `f213846` | Drag-drop, undo, moveTo fix (+ diagram swept in) |
| `dc4d675`–`2d00c2a` | Tree-to-tree drag + docs |

## Not done / open

- Landing `<title>`/og refresh to match new hero.
- Possible: Netlify continuous deployment from GitHub. (Tree "into" band and
  panel dock mode shipped with the panel overhaul.)
