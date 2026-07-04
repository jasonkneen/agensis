# Plan 015: Stop the render-blocking Google Fonts @import

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 871b535..HEAD -- src/index.css index.html`
> On any drift, compare against "Current state" before proceeding; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `871b535`, 2026-07-04

## Why this matters

The first line of the app's CSS is a cross-origin `@import` fetching **six**
Google font families. A CSS `@import` is invisible to the browser's preload
scanner until the importing stylesheet has downloaded and parsed, so first
render serializes: main CSS → *then* Google CSS → *then* font files. Moving the
request into `index.html` as a preconnected `<link>` lets it start in parallel
with the app CSS, shaving a full cross-origin round-trip chain off first paint.
(The app additionally self-hosts Geist via fontsource — that one is fine and
stays.)

## Current state

- `src/index.css:1` (verified):

```css
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&family=Archivo+Black&family=IBM+Plex+Mono:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Press+Start+2P&display=swap');
```

- `src/index.css:3-9` — a comment records a prior lesson: the 13 font-picker
  families deliberately lazy-load one at a time via `ensureUiFontLoaded()` in
  `lib/settings.ts`. **Do not regress that.** Only the six families above move.
- `src/index.css:12` — `@import "@fontsource-variable/geist";` (self-hosted,
  bundled — keep).
- `index.html` `<head>` (lines 3-26) currently has no font links and no
  preconnect.
- `vite.config.ts:109-127` runtime-caches fonts.googleapis.com and
  fonts.gstatic.com in the service worker — unchanged by this plan and it keeps
  repeat visits offline-safe.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Build     | `npm run build`     | exit 0              |
| Typecheck | `npm run typecheck` | exit 0              |

## Scope

**In scope**:
- `src/index.css` — remove line 1 only
- `index.html` — add preconnect + stylesheet links in `<head>`

**Out of scope**:
- The lazy font-picker mechanism (`lib/settings.ts` / `ensureUiFontLoaded`).
- The fontsource Geist import.
- Trimming which families/weights load — tempting, but which are load-bearing
  is a design decision; leave the six families intact.
- vite.config.ts font runtimeCaching entries.

## Git workflow

- Branch: `perf/015-font-loading`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the links to `index.html`

In `<head>`, after the `<title>` block, add:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&family=Archivo+Black&family=IBM+Plex+Mono:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Press+Start+2P&display=swap"
  rel="stylesheet"
/>
```

The URL must be byte-identical to the one currently in `src/index.css:1`
(same families, same weights, same `display=swap`).

**Verify**: `grep -c "fonts.googleapis.com/css2" index.html` → 1.

### Step 2: Remove the @import from `src/index.css`

Delete line 1 (the `@import url('https://fonts.googleapis.com/...')` line) and
nothing else. The explanatory comment at lines 3-9 stays.

**Verify**: `grep -c "fonts.googleapis.com" src/index.css` → 0.

### Step 3: Build

**Verify**: `npm run build` → exit 0; `grep -c "fonts.googleapis.com" dist/index.html` → ≥1 (link survived the HTML pipeline); `grep -rc "fonts.googleapis.com/css2" dist/assets/*.css` → 0 (no @import left in built CSS).

## Test plan

- Manual smoke if a browser is available: `npm run preview`, hard-reload with
  cache disabled; the page's headings render in Space Grotesk (not a serif
  fallback), the mono surfaces in IBM Plex Mono, and the pixel status feed in
  Press Start 2P. Any font-picker-selected custom font still applies after
  changing it in Settings → Font.

## Done criteria

- [ ] `grep -c "fonts.googleapis.com" src/index.css` → 0
- [ ] `dist/index.html` contains the two preconnects and the stylesheet link
- [ ] `npm run build` and `npm run typecheck` exit 0
- [ ] Only `src/index.css` and `index.html` changed (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The live `src/index.css:1` differs from the excerpt (families changed since
  planning) — rebuild the link URL from the live line, and if that feels
  ambiguous, report.
- Fonts visibly fail to load in the preview smoke after one fix attempt.

## Maintenance notes

- Reviewer should confirm the URL wasn't retyped by hand (copy it) — a dropped
  weight silently changes typography.
- Follow-up worth a separate decision: self-host these six families via
  fontsource (like Geist) to remove the Google dependency entirely, and audit
  whether all six are still used anywhere.
