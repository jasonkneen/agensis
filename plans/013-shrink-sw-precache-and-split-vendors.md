# Plan 013: Shrink the service-worker precache from ~10.7 MB to the app shell, drop the dev gallery from prod, split vendors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 871b535..HEAD -- vite.config.ts src/main.tsx`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `871b535`, 2026-07-04

## Why this matters

The PWA service worker precaches **~10.7 MB** on first visit and re-validates it
on every deploy, because `globPatterns: ['**/*.{js,css,html,svg,png,woff2}']`
matches every emitted chunk — including chunks that are only ever loaded via
runtime `import()`: the entire mermaid stack (`mermaid.core` 568 KB,
`cytoscape.esm` 443 KB, `katex` 261 KB, ~30 per-diagram chunks) and the 724 KB
dev-only `Showcase` gallery (which is also the only thing pulling `recharts`
into the build at all). Separately, there is no vendor chunk, so any app change
busts the cache on the whole 1.2 MB (344 KB gzip) main bundle. After this plan:
first-visit precache is just the app shell (~1.5 MB), the dev gallery and
recharts vanish from production builds entirely, and React/vendor code caches
independently of app code across deploys.

## Current state

- `vite.config.ts:104-108`:

```ts
workbox: {
  globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
  // Never precache the version manifest or release notes — they must be
  // fetched fresh so the update check reflects the true latest deploy.
  globIgnores: ['**/version.json', '**/release-notes.json'],
```

  There is no `build.rollupOptions` block anywhere in the file.

- `src/main.tsx:7-17` — Showcase is lazy but still emitted in prod:

```tsx
// Visit /#showcase to view the shadcn component gallery without signing in.
const Showcase = lazy(() => import('./showcase/Showcase.tsx').then(m => ({ default: m.Showcase })));
const isShowcase = typeof window !== 'undefined' && window.location.hash.replace('#', '') === 'showcase';
```

- Only importers of recharts (verified): `src/components/ui/chart.tsx` and
  `src/showcase/sections/Charts.tsx` — both reachable only from Showcase.
- Lazy-only heavyweights: `src/components/chat/MermaidDiagram.tsx:48` does
  `await import('mermaid')` at render time (correct — keep).
- Build output naming: all chunks land in `dist/assets/` with hashed names.
- `vite.config.ts:109-137` already has a `runtimeCaching` array (fonts, pexels) —
  extend it, don't replace it.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Typecheck | `npm run typecheck` | exit 0              |
| Build     | `npm run build`     | exit 0              |
| Unit tests| `npm run test:unit` | all pass            |

## Scope

**In scope**:
- `vite.config.ts`
- `src/main.tsx`

**Out of scope**:
- `src/components/chat/MermaidDiagram.tsx` — already correctly lazy.
- `src/showcase/**` — the gallery code itself stays; only its production
  emission is gated.
- The `emitVersionJson` plugin, manifest block, and existing font/pexels
  runtimeCaching entries in vite.config.ts — leave untouched.
- `src/components/ui/chart.tsx` — unused outside showcase but deleting it is a
  separate decision; do not remove.

## Git workflow

- Branch: `perf/013-sw-precache-vendor-split`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Gate the Showcase gallery to dev builds

In `src/main.tsx`, make the gallery branch statically dead in production so
Rollup drops the chunk (and recharts with it):

```tsx
const isShowcase = import.meta.env.DEV && typeof window !== 'undefined' && window.location.hash.replace('#', '') === 'showcase';
...
{isShowcase ? <Suspense fallback={null}><Showcase /></Suspense> : <App />}
```

Also guard the lazy factory itself so the static analyzer can't keep the chunk:

```tsx
const Showcase = import.meta.env.DEV
  ? lazy(() => import('./showcase/Showcase.tsx').then(m => ({ default: m.Showcase })))
  : () => null;
```

**Verify**: `npm run build` → exit 0, then `ls dist/assets/ | grep -i showcase` → no output. `ls dist/assets/ | grep -i recharts; grep -rl "recharts" dist/assets/*.js | head -1` → no Showcase/recharts chunk (recharts code absent from emitted JS).

### Step 2: Precache only the app shell

In `vite.config.ts` workbox block, replace the glob so only entry assets
precache, and route all other hashed chunks through runtime caching (hashed
filenames are immutable, so CacheFirst is safe):

```ts
workbox: {
  globPatterns: ['index.html', 'assets/index-*.{js,css}', '**/*.{svg,png,woff2}'],
  globIgnores: ['**/version.json', '**/release-notes.json'],
  runtimeCaching: [
    {
      // Hashed lazy chunks (mermaid, diagrams, etc.) — cache on first use only.
      urlPattern: /\/assets\/.*\.(?:js|css)$/,
      handler: 'CacheFirst',
      options: {
        cacheName: 'lazy-chunks',
        expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    ...(the three existing font/pexels entries, unchanged)
  ],
},
```

Note the PNG icons must stay precached (the manifest icons are PNGs at the dist
root, matched by `**/*.png`).

**Verify**: `npm run build` → exit 0. Then measure the precache:
`node -e "const m=require('fs').readFileSync('dist/sw.js','utf8').match(/\"url\":\"[^\"]+\"/g)||[];console.log(m.length,'entries');"`
and confirm the manifest no longer lists mermaid/cytoscape/katex chunks:
`grep -c "mermaid\|cytoscape\|katex" dist/sw.js` → `0`.

### Step 3: Split a vendor chunk

Add to `defineConfig`:

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'vendor-react': ['react', 'react-dom'],
        'vendor-ui': ['radix-ui', 'cmdk', 'sonner', 'vaul', 'lucide-react'],
      },
    },
  },
},
```

Then update step 2's precache glob to include the new vendor chunks:
`'assets/{index,vendor-react,vendor-ui}-*.{js,css}'`.

If the build errors because a listed package resolves nothing (e.g. an export
alias), remove just that package from the list and note it in the commit message.

**Verify**: `npm run build` → exit 0; `ls dist/assets/ | grep vendor-` → two chunks; total of `index-*.js` shrinks versus the 1,196 KB baseline (`ls -la dist/assets/index-*.js`).

### Step 4: Full verification

**Verify**: `npm run typecheck` → exit 0; `npm run test:unit` → all pass.

## Test plan

- No unit tests apply to build config. Acceptance is the build-output assertions
  in each step plus one manual PWA smoke if a browser is available:
  `npm run preview`, open the site, DevTools → Application → Service worker
  updates and activates; Cache Storage shows the small precache; open a chat
  message containing a ```mermaid fence — the diagram still renders (chunk loads
  over the network, then appears in `lazy-chunks` cache).
- Update-flow regression guard: `version.json` must remain excluded
  (`grep -c "version.json" dist/sw.js` → 0) — the what's-new update check
  depends on it being network-fresh.

## Done criteria

- [ ] `npm run build` exits 0; no `Showcase-*.js` in `dist/assets/`
- [ ] `grep -c "mermaid\|cytoscape\|katex" dist/sw.js` → 0
- [ ] `grep -c "version.json" dist/sw.js` → 0
- [ ] `vendor-react-*.js` and `vendor-ui-*.js` exist in `dist/assets/` and are precached in `dist/sw.js`
- [ ] `npm run typecheck` and `npm run test:unit` exit 0
- [ ] Only `vite.config.ts` and `src/main.tsx` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Removing Showcase from prod breaks the build because something outside
  `src/showcase/` imports from it (check with `grep -rn "from './showcase\|from '@/showcase\|from '../showcase" src/ | grep -v src/showcase/ | grep -v main.tsx`).
- The preview smoke shows mermaid diagrams failing to render offline-first —
  the runtimeCaching route pattern is wrong; one fix attempt, then report.
- The manifest PNG icons disappear from the precache (breaks installability).

## Maintenance notes

- Anyone adding a new eagerly-needed asset type must extend `globPatterns`
  deliberately — the default is now "not precached".
- If the team wants the gallery reachable in production again, revert step 1
  and instead add `'**/Showcase-*.js'` to `globIgnores` (keeps it out of the
  precache but shippable).
- Deferred to plan follow-ups: React.lazy for the windows themselves
  (BUNDLE-03 in the 2026-07-04 findings) — a bigger main-chunk win but MED risk.
