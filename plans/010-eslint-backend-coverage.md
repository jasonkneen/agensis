# Plan 010: Add ESLint coverage for the backend (server/, scripts/, shared/, netlify/functions/)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- eslint.config.js`
> If it changed since this plan was written, re-read it against the excerpt below before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

`eslint.config.js` scopes its only rule-bearing block to `files: ['**/*.{ts,tsx}']`. Confirmed at
planning time via `npx eslint --print-config server/index.cjs` (and the same for
`netlify/functions/backend.mjs`, `scripts/migrate.mjs`, `shared/backend-core.mjs`): all resolve to
`"rules": {}` — completely unlinted. `tsconfig.app.json`'s `"include": ["src"]` means `tsc --noEmit`
doesn't touch these files either. `.github/workflows/test.yml` runs `npm run typecheck` +
`npm run lint` + the test commands as the entire CI gate — so `server/index.cjs`, the single
highest-git-churn file in the repo (28 commits in the last 100) and the file that owns auth, RBAC,
and the realtime WebSocket server, has **no static-analysis safety net in CI at all**. A class of
bugs ESLint's recommended rules catch for free — unused variables/params, accidental `==`,
unreachable code, redeclared bindings — is silently unchecked in exactly the highest-stakes file in
the codebase, and CI's green checkmark gives false confidence that "lint passed" covers it.

## Current state

**`eslint.config.js`** (in full):

```js
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  }
);
```

Confirmed: `npx eslint --print-config server/index.cjs` → `"rules": {}` (zero rules apply).

Files that need coverage under this plan (all currently unlinted): `server/index.cjs`,
`server/mcp.cjs`, `server/skills.cjs`, `shared/backend-core.mjs`, `scripts/*.cjs`/`*.mjs`,
`netlify/functions/backend.mjs`, `electron/main.cjs`.

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Lint (all)       | `npm run lint`                    | see Step 3 for the expected transitional state |
| Print effective config | `npx eslint --print-config server/index.cjs` | shows non-empty `rules` after this plan |
| Typecheck        | `npm run typecheck`               | exit 0, no errors (unaffected — `tsconfig.app.json`'s scope is untouched by this plan) |

## Scope

**In scope** (the only files you should modify):
- `eslint.config.js` (add a new config block)
- Whatever pre-existing violations Step 3 surfaces in `server/`, `scripts/`, `shared/`,
  `netlify/functions/` — fix genuine issues (unused vars, `==` vs `===`, etc.) as long as each fix
  is a safe, behavior-preserving cleanup; anything ambiguous gets `// eslint-disable-next-line
  <rule> -- <reason>` instead of a blind fix (see Step 3)

**Out of scope** (do NOT touch, even though they look related):
- `tsconfig.app.json`'s `include` scope — this plan is about ESLint, not TypeScript's own checker;
  do not attempt to bring `server/`/`scripts/` under `tsc --noEmit` type-checking as part of this
  plan, that's a separate, much larger effort (the backend is plain JS, not TypeScript).
- The existing `**/*.{ts,tsx}` block's rules or scope — do not change frontend linting behavior.
- `.github/workflows/test.yml` — no CI config change is needed; `npm run lint` already runs in CI,
  it will simply now also cover more files once `eslint.config.js` is updated.
- `landing/` — it has its own separate tooling/package.json; out of scope for this plan.
- `agent/agensis-cli/` — a separate package with (check first) possibly its own lint config; only
  bring it into the root config if it currently has no linting at all AND doing so doesn't
  conflict with a config it already has.

## Steps

### Step 1: Add a CommonJS/Node config block

Add a second block to `eslint.config.js` covering the backend files, using Node globals instead of
browser globals, and using `sourceType: 'commonjs'` for the `.cjs` files (the `.mjs` files are ESM):

```js
export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ['server/**/*.cjs', 'scripts/**/*.cjs', 'shared/**/*.mjs', 'netlify/functions/**/*.mjs', 'electron/**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs', // per-file override to 'module' below for the .mjs glob if needed
      globals: { ...globals.node },
    },
    rules: {
      // Start with eslint:recommended defaults; do not add stricter custom rules yet — this
      // plan's job is establishing coverage, not maximal strictness. Tighten later once the
      // team has lived with baseline coverage for a while.
    },
  }
);
```

Note `typescript-eslint`'s `tseslint.config()` helper accepts plain flat-config objects for
non-TS-specific blocks — the second block above doesn't need `tseslint.configs.recommended` since
these are `.cjs`/`.mjs` files, not TypeScript. If ESLint's flat-config resolution complains about
mixing `sourceType: 'commonjs'` across the `.cjs` and `.mjs` globs in one block (since `.mjs` is
always ESM regardless of `sourceType`), split into two blocks — one for `**/*.cjs` with
`sourceType: 'commonjs'`, one for `**/*.mjs` with `sourceType: 'module'`.

**Verify**: `npx eslint --print-config server/index.cjs` now shows a non-empty `rules` object
(e.g. `no-unused-vars`, `no-undef`, `eqeqeq` if in `recommended`, etc. — confirm at least a handful
of `eslint:recommended`'s rules appear, not zero).

### Step 2: Run lint and see what surfaces

Run `npm run lint`. Expect a batch of new warnings/errors from files that have never been linted
before — this is expected, not a sign the config is wrong.

**Verify**: the command completes (even if it exits non-zero due to new findings) and the output
now includes findings from files under `server/`, `scripts/`, `shared/`, or
`netlify/functions/` that weren't there before this plan.

### Step 3: Triage the new findings — fix or explicitly suppress, don't ignore

For each new finding:
- If it's a genuine, safe fix (an actually-unused variable, a stray `==` that should be `===` with
  no behavioral reliance on type coercion, etc.), fix it directly.
- If it's ambiguous — e.g. a variable that's unused but might be intentionally destructured for
  documentation purposes, or a pattern that's correct but trips a recommended rule in a
  backend-specific way — add a scoped `// eslint-disable-next-line <rule-name> -- <one-line reason>`
  rather than either blindly "fixing" it or leaving it as a silent failure to lint clean.
- Do **not** disable an entire rule globally in the new config block just to make the initial run
  pass — that defeats the purpose of this plan. Scoped, per-line disables with a reason are
  the correct escape hatch; use them liberally rather than weakening the ruleset.

Budget for this step scales with how much the initial run surfaces — if it's a large number
(dozens+), prioritize `server/index.cjs` and `server/mcp.cjs` first (highest-stakes, highest-churn)
and note any remaining files' findings in your final report rather than silently leaving them
unaddressed; do not let this step balloon into an unbounded refactor.

**Verify**: `npm run lint` exits with the **same or fewer** errors as when this step started (0 new
unaddressed errors); warnings are acceptable to leave as tracked, non-blocking (matching this
repo's existing convention of treating lint warnings as informational, per the current 23-warning
baseline on the frontend).

## Test plan

No new automated tests are needed for a lint-config change itself. The verification is `npm run
lint`'s own exit code and output, plus re-running the full existing suite to confirm none of the
Step 3 fixes changed runtime behavior:

- `npm run typecheck` — confirms no TypeScript-visible regression (frontend is unaffected by this
  plan, but re-run as a sanity check).
- `npm test` — confirms none of the Step 3 backend fixes broke existing behavior (this is the real
  regression check for any code changes made during triage).
- `npm run test:unit` — same, for the vitest suite.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx eslint --print-config server/index.cjs` shows a non-empty `rules` object
- [ ] `npm run lint` exits with 0 new unaddressed errors (existing 23-warning baseline may grow
      with new, legitimate warnings from newly-covered files — that's expected and fine; **errors**
      must all be either fixed or explicitly, individually suppressed with a reason)
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` and `npm run test:unit` exit 0, no regressions from any Step 3 fixes
- [ ] `.github/workflows/test.yml` requires no changes (it already runs `npm run lint`, which now
      covers more) — confirm by reading the workflow file, not by guessing
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The initial `npm run lint` run after Step 1 surfaces an overwhelming number of findings (say,
  100+) such that full triage would clearly exceed this plan's "M" effort budget by a wide margin —
  report the count and ask whether to proceed with a reduced scope (e.g. `server/index.cjs` and
  `server/mcp.cjs` only, deferring `scripts/`/`shared/`/`netlify/functions/` to a follow-up plan)
  rather than silently doing a partial job or ballooning the effort unilaterally.
- Any Step 3 "fix" changes behavior in a way a test catches — revert that specific fix and use the
  scoped-disable-with-reason escape hatch instead; do not force a passing test by changing the
  test's expectations.
- Applying Node globals/`sourceType: 'commonjs'` to `agent/agensis-cli/` (if you're tempted to
  include it) conflicts with an existing lint setup there — leave that package out of this plan's
  scope entirely per the Scope section.

## Maintenance notes

- This plan deliberately starts at `eslint:recommended` defaults rather than importing the
  frontend's stricter TypeScript-specific rules — the backend is plain JS, so `typescript-eslint`
  rules don't apply, and a first pass at establishing *any* coverage is more valuable than
  bikeshedding the exact ruleset. A follow-up, separate effort could add Node-specific plugins
  (e.g. `eslint-plugin-n`) for stricter backend-specific checks once the team has lived with this
  baseline.
- Once this lands, CI's `npm run lint` step genuinely covers the backend — worth a one-line mention
  in a future CLAUDE.md/AGENTS.md (a separate, already-tracked finding) so agents/contributors know
  lint now applies repo-wide, not just to `src/`.
