# Plan 014: Re-encode the 8.6 MB of workspace background JPGs to WebP

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 871b535..HEAD -- src/lib/backgrounds.ts images/`
> On any drift, compare against "Current state" before proceeding; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `871b535`, 2026-07-04

## Why this matters

The seven selectable workspace backgrounds are raw camera-sized JPGs totalling
**8.6 MB** — `download-28.jpg` is 2.58 MB and `download-27.jpg` 2.27 MB. Picking
a background downloads a file that can outweigh the app's entire JavaScript.
Re-encoding to WebP at display resolution typically yields 5–10× smaller files
with no visible difference at canvas-backdrop opacity (~0.42 default).

## Current state

- `src/lib/backgrounds.ts:1-7` — static imports, verified:

```ts
import bg1 from '../../images/download-21.jpg';
import bg2 from '../../images/download-22.jpg';
import bg3 from '../../images/download-24.jpg';
import bg4 from '../../images/download-25.jpg';
import bg5 from '../../images/download-26.jpg';
import bg6 from '../../images/download-27.jpg';
import bg7 from '../../images/download-28.jpg';
```

  followed by `WORKSPACE_BACKGROUNDS` entries (`green-fields`, `red-canyon`,
  `palm-beach`, `forest-gate`, `night-battle`, `sky-meadow`, + one more).
- Source files live in `images/` at the repo root. Sizes: 545 KB – 2.58 MB.
- `sharp` `^0.33.5` is already a devDependency (used by `scripts/generate-icon.cjs`)
  — no new dependency needed.
- Vite fingerprints imported assets into `dist/assets/`; only imported files
  ship, so swapping the imports swaps the payload.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Typecheck | `npm run typecheck` | exit 0              |
| Build     | `npm run build`     | exit 0              |

## Scope

**In scope**:
- `images/` — add seven new `.webp` files (do NOT delete the JPGs in this plan)
- `src/lib/backgrounds.ts` — repoint imports
- `scripts/` — a small one-off conversion script (may be deleted after running, or kept as `scripts/convert-backgrounds.cjs`)

**Out of scope**:
- Deleting the original JPGs — they stop shipping the moment nothing imports
  them; removal from the repo is a separate housekeeping decision.
- Any component that *renders* backgrounds (App.tsx backdrop code) — the asset
  URL type is unchanged.
- The other large JPGs/PNGs in `images/` not referenced by `backgrounds.ts`.

## Git workflow

- Branch: `perf/014-background-webp`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Convert

Create `scripts/convert-backgrounds.cjs`:

```js
const sharp = require('sharp');
const path = require('path');
const files = ['download-21','download-22','download-24','download-25','download-26','download-27','download-28'];
(async () => {
  for (const name of files) {
    const src = path.join(__dirname, '..', 'images', `${name}.jpg`);
    const out = path.join(__dirname, '..', 'images', `${name}.webp`);
    await sharp(src).resize({ width: 1920, withoutEnlargement: true }).webp({ quality: 72 }).toFile(out);
    console.log(name, 'done');
  }
})();
```

Run: `node scripts/convert-backgrounds.cjs`

**Verify**: `ls -la images/*.webp` → 7 files, each **under 400 KB** (expected
~80–300 KB). If any exceeds 400 KB, lower quality to 65 and re-run for that file.

### Step 2: Repoint imports

In `src/lib/backgrounds.ts`, change all seven import extensions from `.jpg` to
`.webp`. Touch nothing else in the file.

**Verify**: `npm run typecheck` → exit 0 (if TS complains about `.webp` module
declarations, check `src/vite-env.d.ts` — Vite's client types cover `.webp` by
default; a missing reference there is a STOP condition, not something to hack
around with `any`).

### Step 3: Build check

**Verify**: `npm run build` → exit 0; `ls dist/assets/ | grep -i download | grep -i jpg` → no output; `ls -la dist/assets/*.webp` → 7 files totalling < 2 MB combined (vs 8.6 MB before).

## Test plan

- No unit tests apply. Acceptance: build assertions above, plus a visual smoke
  if dev is available — open Settings → workspace background, apply each of the
  7 backgrounds, confirm they render and look acceptable at both default and
  full opacity.

## Done criteria

- [ ] 7 `.webp` files exist in `images/`, each < 400 KB
- [ ] `src/lib/backgrounds.ts` imports only `.webp`
- [ ] `npm run build` exits 0 and emits no `download-*.jpg` into `dist/assets/`
- [ ] Only the in-scope files changed (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- A converted image is visibly degraded (banding/blocking at normal viewing) —
  report with the file name rather than silently shipping it.
- `backgrounds.ts` no longer matches the excerpt (drift).
- TypeScript cannot resolve `.webp` imports and `src/vite-env.d.ts` lacks the
  standard `/// <reference types="vite/client" />` — report, don't add ad-hoc
  module declarations.

## Maintenance notes

- Future backgrounds should be added as WebP (or AVIF) at ≤1920px from the
  start; note this in the PR description.
- Follow-up (deferred): delete the now-unshipped source JPGs once the team
  confirms nothing else wants them; consider AVIF for another ~30% saving.
