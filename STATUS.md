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

- Left: element tree outline (auto-expands + scrolls to canvas selections).
- Right: properties (tag, id, classes, text, attributes, inline CSS).
- Bottom toolbar: Select, Move up/down, Delete, Undo, save status, close.
- Edits apply to the live DOM **and** splice the HTML source byte-faithfully
  (parse5 source-location offsets); rollback on server error keeps DOM and
  source in sync.
- Drag-and-drop: on-canvas (selection-first, ghost follows pointer, live
  before/after/inside markers, content-model validity rules, edge auto-scroll)
  and tree-to-tree (top 30% = before, bottom 30% = after, middle = into).
- Undo: Ctrl/Cmd+Z + toolbar button; per-file server snapshot stacks,
  byte-exact restores.
- Ops: `setText`, `setAttr`, `setStyle`, `move` (sibling swap), `moveTo`
  (reparent), `remove`, `undo`.

**Known nits:** tree "into" band is ~6px tall on 16px rows (fiddly); left panel
overlays the page's left ~240px (no dock mode); server ops are tag-agnostic
(validity rules are client-advisory only).

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
- Possible: widen tree "into" band; dock mode for panels; Netlify continuous
  deployment from GitHub.
