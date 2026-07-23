---
name: root-landing-routing
description: Rules for touching what agensis.io serves at `/` vs `/app` — index.html, public/landing/index.html, public/root-entry.js, or the workbox config in vite.config.ts (navigateFallbackDenylist, skipWaiting/clientsClaim). Use this before changing which HTML entry loads at the root path, adding a new auth-callback or app-launch query/hash key, or touching service-worker precache/navigation-fallback config. This took 6+ commits to get right (f6b4d03, 5fd75ca, 13e476e, d757224, de7d260, 1b39747) because a stale service worker can override new routing logic — the fix has to live in both the redirect script AND the SW config, or it silently regresses for users with an old SW still controlling the tab.
---

# Root (`/`) vs `/app` routing

`agensis.io` serves a marketing landing page at `/` and the SPA at `/app`, but
both `index.html` (app shell) and `public/landing/index.html` (landing) get
requested at the bare root depending on build/deploy quirks, and a browser's
service worker can intercept navigation and serve whichever HTML it has
cached — independent of what the server would return today. Getting this
wrong repeatedly shipped one of: the SPA flashing at `/` before landing loads,
auth callbacks losing their token in the redirect, or a *previously* fixed
routing bug reappearing for users whose SW never updated.

## The two independent layers — both must agree

1. **`public/root-entry.js`** — a tiny script loaded by both HTML entries
   (`data-entry-kind="app"` in `index.html`, `data-entry-kind="landing"` in
   `public/landing/index.html`). Runs client-side, decides via
   `location.replace(...)` whether to bounce root visits to `/app` (auth
   callback or app-launch intent) or to `/landing/index.html` (ordinary
   visit hitting the app shell).
2. **`vite.config.ts` workbox config** — the *installed* service worker,
   which owns whether a repeat visitor's browser even asks the network for
   fresh HTML, or serves a cached SPA shell straight from precache without
   root-entry.js ever running.

A fix to layer 1 alone does not reach users with an already-installed SW from
before the fix — that SW keeps serving its own cached `index.html` at `/`
until `skipWaiting`/`clientsClaim` (already on) force it to take over, and even
then `navigateFallbackDenylist` (layer 2) is what stops the *new* SW from
substituting the SPA shell for landing routes on a fallback. If you change one
without checking the other, the bug looks fixed in a fresh incognito tab and
still broken for real returning users.

## The rule

**Any new "send this visit to `/app` instead of landing" condition goes in
`root-entry.js`'s `callbackKeys` / `hasAppLaunch` checks — not as a server
redirect or a new HTML file.** Auth providers and invite links append tokens
as query or hash params; adding a new provider means adding its param name to
one of those two lists, nothing else.

**Any change to what the service worker is allowed to precache or
fallback-substitute goes through `navigateFallbackDenylist` in
`vite.config.ts`, and must keep `/` and `/landing` (or their replacement)
excluded.** If landing gains a new path prefix, add its pattern to the
denylist array alongside the existing `/^\/$/` and `/^\/landing(?:\/|$)/`.

**Never assume a routing fix is live for existing users without the SW
self-healing comment's chain holding**: `skipWaiting: true` +
`clientsClaim: true` in `vite.config.ts` is what lets a stale SW get replaced
on the next visit without the user hard-refreshing — don't remove either
without re-checking this whole chain.

## Quick self-check before committing a change here

- Grep the diff: if you touched `root-entry.js`'s redirect conditions, did you
  also check whether `navigateFallbackDenylist` needs the same new path?
- Run `node --test tests/root-routing.test.cjs` — it drives `root-entry.js`
  in a `vm` sandbox with fake `location`/`URLSearchParams` per URL/entry-kind
  combination, and asserts the SW denylist string is present in
  `vite.config.ts`. Add a case here for any new callback key or app-launch
  intent instead of only eyeballing it.
- If you're adding a new HTML entry point at or near root, confirm it also
  loads `/root-entry.js` with the correct `data-entry-kind` — the routing
  guard only runs where it's included.
