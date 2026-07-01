# Plan 007: Extract a realpath-validated path guard and apply it to the git-stage route

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- server/index.cjs`
> If it changed since this plan was written, re-read `resolveWithinRoot`/`resolveStagePaths`
> against the excerpts below before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security / tech-debt
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

A symlink-escape vulnerability in the git-diff endpoint's untracked-file-read branch was found and
patched ad hoc (commit `a00f874`, "Harden git/diff endpoint against symlink path escapes") — but
the fix was written **inline in that one branch**, not extracted into the shared
`resolveWithinRoot` helper every route calls. `resolveStagePaths` — used by the git-**stage** route
(`POST /backend/workspaces/:id/git/stage`, which runs `git add` on the resolved paths, i.e. a
*write* path, arguably higher-value to an attacker than the read-only diff route that got hardened)
— still calls only the lexical-only `resolveWithinRoot`, despite its own comment claiming it
"reuses the same traversal guard the read-only diff endpoint relies on." It does not: a symlink
inside the workspace root that points outside it would still pass `resolveStagePaths`'s check
today, exactly the bug class the sibling route was just fixed against.
`agent/agensis-cli/src/memory.mjs:56-67` independently implements a correctly realpath-validated
`resolveWithinRoot` for a different feature (agent file-memory) — the correct fix already exists in
the repo, just not centralized where this gap remains.

## Current state

**`server/index.cjs:3758-3763`** — the lexical-only helper every route (including the vulnerable
one) currently calls:

```js
function resolveWithinRoot(root, relativePath) {
  const resolved = path.resolve(root, String(relativePath || ''));
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}
```

**`server/index.cjs:3856-3871`** — the ad hoc, inline fix applied only to the diff route's
untracked-file-read branch:

```js
// resolveWithinRoot only checks the lexical path — a symlink inside the
// workspace root could still point outside it. This branch reads raw
// file content (unlike the git-diff branch below, which stays inside
// git's own repository boundary), so re-validate against the real path
// right before reading.
let realTarget;
try {
  realTarget = fs.realpathSync(target);
} catch {
  return jsonError(res, 404, new Error('File not found'));
}
const realRoot = fs.realpathSync(root);
const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) {
  return jsonError(res, 400, new Error('path must stay within the workspace project root'));
}
```

**`server/index.cjs:3903-3908`** — `resolveStagePaths`, the still-unpatched sibling (a write path):

```js
function resolveStagePaths(root, body) {
  const raw = Array.isArray(body?.paths) ? body.paths : (body?.path !== undefined ? [body.path] : []);
  const relativePaths = raw.map((value) => String(value || '').trim()).filter(Boolean);
  if (relativePaths.length === 0) throw badRequest('path or paths is required');
  for (const relativePath of relativePaths) {
    if (!resolveWithinRoot(root, relativePath)) throw badRequest('path must stay within the workspace project root');
  }
  return relativePaths;
}
```

**`agent/agensis-cli/src/memory.mjs:56-67`** — an existing, correct, realpath-validated
implementation of the same concept in a different package (read this before writing the fix, as a
second reference pattern in the same repo).

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Typecheck        | `npm run typecheck`               | exit 0, no errors                |
| Node test suite  | `npm test`                        | all pass (baseline 119)          |

## Scope

**In scope** (the only files you should modify):
- `server/index.cjs` (`resolveWithinRoot`, the diff route's inline block, `resolveStagePaths`)
- `tests/*.test.cjs` (new test for the stage-route symlink case)

**Out of scope** (do NOT touch, even though they look related):
- `agent/agensis-cli/src/memory.mjs` — it's already correct; read it as a reference, don't modify
  it or try to "share" code across the two packages (they're separate deployables with separate
  module systems — CJS server vs. the CLI package) unless separately asked to.
- The git-diff route's **tracked**-file branch (`execFileAsync('git', ['-C', root, 'diff', ...])`)
  — it stays inside git's own repository boundary via `execFile` array args (no shell
  interpolation) and was already confirmed sound in this review; do not add realpath checking
  there, it's unnecessary and would be scope creep.
- Any other route calling `resolveWithinRoot` beyond the diff route and `resolveStagePaths` — grep
  for all call sites first (Step 1) and confirm the full list before deciding what else needs the
  upgrade; don't assume there are exactly two.

## Steps

### Step 1: Find every call site of `resolveWithinRoot`

Run `grep -n "resolveWithinRoot(" server/index.cjs` to get the authoritative list of call sites
(the excerpts above cover the two known ones as of planning time, but confirm no third site was
missed).

**Verify**: the grep output matches (or is a superset you've now accounted for) the diff route and
`resolveStagePaths`.

### Step 2: Make `resolveWithinRoot` itself realpath-validated

Replace the lexical-only `resolveWithinRoot` (line 3758-3763) with a version that performs the
realpath check internally, so every call site gets the protection automatically instead of relying
on callers to remember it:

```js
function resolveWithinRoot(root, relativePath) {
  const resolved = path.resolve(root, String(relativePath || ''));
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  // Lexical containment isn't enough — a symlink inside root can point outside it.
  // Only realpath-check if the target exists; callers that need "path must exist"
  // semantics (e.g. resolveStagePaths, which stages an existing file) already get
  // that for free, and callers reading a possibly-new path should catch the ENOENT
  // case themselves the way the diff route's untracked-file branch already does.
  let realTarget;
  try {
    realTarget = fs.realpathSync(resolved);
  } catch {
    return resolved; // Path doesn't exist yet — lexical check already passed; let the
                      // caller's own existence check (if any) handle the not-found case.
  }
  const realRoot = fs.realpathSync(root);
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) return null;
  return resolved;
}
```

Note the deliberate design choice here: when the path doesn't exist yet, this returns the
lexically-resolved path rather than failing, so callers that are about to *create* a file (if any
exist) aren't broken by a nonexistent-path realpath error. Callers that require the path to already
exist (like `resolveStagePaths`, staging an existing file for git) get the real protection because
`fs.realpathSync` only succeeds for paths that exist, and a symlink escape will resolve to
somewhere outside root and get caught by the containment check above.

**Verify**: `npm run typecheck` passes; the diff route's untracked-file branch (3856-3871) can now
have its now-redundant inline realpath block **removed** (since `resolveWithinRoot` does it), and
still passes the same manual symlink-escape scenario the original `a00f874` fix addressed.

### Step 3: Remove the now-redundant inline block from the diff route

Delete the inline `realTarget`/`realpathSync` re-check block at lines ~3856-3871 (now handled
inside `resolveWithinRoot` itself from Step 2) and use `target` (the return value of
`resolveWithinRoot`, already realpath-validated) directly in the subsequent
`fs.readFileSync(target, ...)` call. Update the comment to reflect that the guard is now
centralized rather than removing the explanatory context entirely — future readers should still
understand *why* this route needs the guard.

**Verify**: the diff route's untracked-file-read behavior is unchanged for legitimate paths
(existing tests in this area, if any, still pass) and still correctly rejects a symlink escape
(covered by the new test in Step 4).

### Step 4: Confirm `resolveStagePaths` is now protected — no code change needed here

Because `resolveStagePaths` (3903-3908) already calls `resolveWithinRoot`, and Step 2 made that
function realpath-validated, `resolveStagePaths` is fixed automatically. Do not add a second,
separate realpath check inside `resolveStagePaths` — that would be the exact duplication this plan
is trying to eliminate. Just verify it via a new test (Step below).

## Test plan

Add to an existing relevant test file (or a new `tests/git-stage-symlink.test.cjs` following the
structure of `tests/backend-rbac.test.cjs` — real handler, mock/scratch DB and filesystem):

- Set up a workspace project root as a temp directory; inside it, create a symlink pointing to a
  path outside the root (e.g. `ln -s /etc/passwd insideRoot/escape`).
- Call the git-stage route (or directly unit-test `resolveStagePaths`/`resolveWithinRoot` if they're
  exported for testing — check `module.exports` at the bottom of `server/index.cjs`, or use the
  `__test` export pattern already used by `server/mcp.cjs` if `server/index.cjs` doesn't currently
  export test hooks; add one if needed, following that existing pattern) with a path that resolves
  through the symlink.
- Assert it's rejected with the "path must stay within the workspace project root" error, not
  silently allowed through.
- Add a positive-path test too: a normal (non-symlinked) relative path inside the root still
  resolves correctly and stages successfully — confirms Step 2 didn't break the common case.
- Re-run the existing diff-route symlink test (if one exists from commit `a00f874`'s original fix —
  check `tests/` for it) to confirm behavior is unchanged after Step 3's refactor.

Verification: `npm test` → all pass, including the new symlink-escape test for the stage route, no
regressions in the 119-test baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including a new test proving `resolveStagePaths` now rejects a
      symlink-escape path
- [ ] The diff route's inline realpath block is removed (logic centralized in
      `resolveWithinRoot`) and its existing behavior is unchanged per test
- [ ] `grep -n "realpathSync" server/index.cjs` shows exactly one call site inside
      `resolveWithinRoot` (not duplicated across routes)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A third call site of `resolveWithinRoot` exists (beyond the diff route and `resolveStagePaths`)
  and behaves in a way that assumes the *old* lexical-only, always-succeeds-even-for-nonexistent-
  paths semantics in a way the new version would break — describe the conflict rather than forcing
  a fix that might silently change that route's behavior.
- Making `resolveWithinRoot` realpath-validated breaks an existing passing test in a way that
  reveals a legitimate use case for symlinks within the workspace root (e.g. a documented feature
  that intentionally symlinks project files) — stop and report rather than either reverting the fix
  or forcing the test to pass by weakening the guard.

## Maintenance notes

- Any new route that resolves a user-supplied relative path against a workspace/project root should
  call this same `resolveWithinRoot` rather than reimplementing path containment — that's the whole
  point of this plan's centralization. A future code reviewer should flag any new `path.resolve(root,
  ...)` pattern that doesn't go through it.
- `agent/agensis-cli/src/memory.mjs`'s independent implementation was **not** consolidated with this
  one (different package/module system) — if a future refactor unifies shared logic across
  `server/` and `agent/agensis-cli/`, that's a larger, separate effort.
