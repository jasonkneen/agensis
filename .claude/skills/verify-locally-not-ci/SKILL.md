---
name: verify-locally-not-ci
description: Never infer "tests passed" or "this is safe to merge" from GitHub Actions status in this repo — the CI gate has never actually run the test suites. Use this before citing CI as evidence of anything, before merging on the strength of a green check, and whenever asked "did CI pass" or "is this safe to ship". Run `npm run ci` (or `npm test && npm run test:unit`) locally and quote the real counts instead.
---

# CI is not a gate here — verify locally

`.github/workflows/test.yml` looks like a real gate (Install → Typecheck →
Lint → `npm test` → `npm run test:unit`) but it has never actually executed
both suites on `main` or any PR, for two independent, stacked reasons:

1. **Lint used to abort the job before the tests ran.** `npm run lint`
   exited `1` on pre-existing `_`-prefixed unused-var errors in
   `server/index.cjs`, and Lint ran *before* the test steps in the same job
   — so Actions aborted before `npm test` or `npm run test:unit` ever
   started. (Partially fixed on unmerged branch `worktree-quality-gate`,
   commit `21d3fbf`: lint now has its own job and `argsIgnorePattern: '^_'`
   makes it exit 0 — check whether that's merged before assuming this half
   is fixed.)

2. **The deeper cause: no runner is ever assigned.** `gh run view <id> --json
   jobs` on recent runs returns `steps: []` — zero steps executed, failing in
   5-40 seconds. That's the signature of exhausted Actions minutes / a
   spending limit on the private repo, not a code problem. **This half can't
   be fixed from inside the repo** — it needs Jason to restore Actions
   minutes or raise the spending limit. Fixing lint ordering alone changes
   nothing while this is true.

## What this means in practice

- A green check mark, a red X, or no check at all on a PR/commit tells you
  **nothing** about whether the tests pass. Don't cite it either way.
- The suites themselves are fine when run locally — this is a CI-plumbing
  problem, not a code-quality problem. Don't let a failing/absent CI status
  make you distrust code that you haven't actually tested yourself.
- **Never write "CI is green" or "tests should pass, CI will confirm" as a
  verification claim.** Those sentences are currently unfalsifiable from
  inside this repo — say what you actually ran instead.

## What to run instead

```bash
cd /Users/jkneen/Documents/GitHub/agensis   # or your worktree
npm run typecheck
npm test              # node suite
npm run test:unit     # vitest suite
npm run lint
```

Or, if `worktree-quality-gate` (or its merge) has landed, the single
combined gate: `npm run ci`.

Quote the actual numbers the run printed (e.g. "325 node tests, 205 vitest,
0 typecheck errors, lint clean"). AGENTS.md's documented counts (~363/~207)
are known stale — the real baseline as of 2026-07-24 was 325/205. A
recalled figure from an earlier session is not evidence; a number from a
run you just executed is.

## What to report

Weak: "Pushed, CI will verify." (implies a gate that doesn't function)
Strong: "Ran locally: typecheck 0 errors, 325/325 node, 205/205 vitest,
lint clean. Not relying on CI — it doesn't currently execute (see
`verify-locally-not-ci`)."

## Related

- `agensis-daemon-ops` — the broader "report the verification gap, don't
  paper over it" principle this skill is one specific application of.
- `check-already-shipped` — a different kind of status trap (trusting
  branch names/memory instead of git); this one is about trusting CI
  status instead of running the suites yourself.
