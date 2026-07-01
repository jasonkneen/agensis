# Plan 001: Bump `ws` past its pre-auth-reachable DoS advisory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- package.json package-lock.json`
> If `package.json` or `package-lock.json` changed since this plan was written, re-run
> `npm audit --omit=dev` before proceeding and compare against "Current state" below.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

`ws` is the WebSocket library backing the app's entire realtime backbone (chat, canvas sync,
presence, cursors) — see `server/index.cjs:11` (`const { WebSocketServer } = require('ws')`) and
`attachRealtime` (`server/index.cjs:3398-3401`), which accepts connections on `/backend/ws`
**before** the app-level `{type:'auth'}` first-frame check runs. That means `ws`'s internal frame
decoder processes bytes from an unauthenticated remote client. The installed version, `8.20.0`, is
in the vulnerable range for a CVSS-7.5 memory-exhaustion DoS
(GHSA-96hv-2xvq-fx4p, "Memory exhaustion DoS from tiny fragments and data chunks", range
`>=8.0.0 <8.21.0`) and a moderate uninitialized-memory-disclosure bug (GHSA-58qx-3vcg-4xpx). Any
remote, unauthenticated client can open a socket and send crafted tiny fragments to exhaust server
memory. The fix is already inside the existing semver range in `package.json` — this is a
lockfile refresh, not a version bump decision.

## Current state

- `package.json:59` — `"ws": "^8.20.0"` (direct, production dependency).
- `package-lock.json` — locked at exactly `8.20.0`.
- `npm view ws versions` confirms `8.21.0` is published and satisfies `^8.20.0`.
- `npm audit --omit=dev --json` (re-run at planning time) reports:
  ```
  "ws": { "severity": "high", "isDirect": true, "range": "8.0.0 - 8.20.1", "fixAvailable": true }
  ```
- The repo's WebSocket test coverage lives in `tests/*.test.cjs` (node:test, run via `npm test`) —
  these exercise `server/index.cjs`'s HTTP routes and auth gating, not `ws` internals directly, so
  they are a safety net for "did the bump break anything observable," not a `ws`-specific test.

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Update lockfile  | `npm install ws@^8.21.0`          | exit 0, package-lock.json updated |
| Re-audit         | `npm audit --omit=dev`            | `ws` no longer listed           |
| Typecheck        | `npm run typecheck`               | exit 0, no errors                |
| Lint             | `npm run lint`                    | 0 errors (warnings unchanged)     |
| Node test suite  | `npm test`                        | all pass (currently 119)         |
| Vitest suite     | `npm run test:unit`               | all pass (currently 46)          |

## Scope

**In scope** (the only files you should modify):
- `package.json` (only if the version range itself needs bumping — it likely doesn't, see Step 1)
- `package-lock.json`

**Out of scope** (do NOT touch, even though they look related):
- `server/index.cjs`'s WebSocket handling logic — this plan is a dependency bump only, not a
  behavior change to `attachRealtime` or the auth-before-frames ordering. That ordering is tracked
  separately (see `plans/README.md` "Findings considered and rejected" — the pre-auth-window
  itself is accepted, documented behavior, not in scope here).
- Any other dependency in `npm audit`'s output (`esbuild`, `rollup`, `serialize-javascript`,
  `js-yaml`, `fast-uri`) — these are build/dev-tool-chain only, not reachable from the running
  production server, and were explicitly triaged out of this review as non-urgent.
- `qs` (also flagged in the audit as vulnerable via `GHSA-q8mj-m7cp-5q26`) — investigated and
  found **not reachable**: the CVE is in `qs.stringify()` with `encodeValuesOnly` on comma-format
  arrays; grepping the repo confirms no code calls `qs.stringify` or `qs.parse` directly (it's an
  internal transitive dependency of `express`'s `body-parser`, used only for incoming query-string
  parsing). Do not spend effort on `qs` in this plan; `npm audit fix` may bump it incidentally, which
  is fine but not the point of this plan.

## Steps

### Step 1: Bump `ws` and refresh the lockfile

Run `npm install ws@^8.21.0`. This should update `package-lock.json`'s `ws` entry to `8.21.0` (or
later, if a newer patch has since been published — any version `>=8.21.0 <9.0.0` satisfies both
the existing `package.json` range and the fix). Do **not** widen the `package.json` range beyond
`^8.20.0` unless npm forces a `package.json` edit to resolve; a lockfile-only change is expected.

**Verify**: `npm ls ws` → shows `ws@8.21.0` (or later) with no `invalid`/`extraneous` markers.

### Step 2: Confirm the advisory is gone

Run `npm audit --omit=dev`.

**Verify**: the `ws` entry is no longer present in the output. (Other advisories — `esbuild`,
`rollup`, `fast-uri`, `serialize-javascript`, `js-yaml` — are expected to remain; they are out of
scope per this plan.)

### Step 3: Confirm nothing broke

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:unit` in sequence.

**Verify**: typecheck exits 0 with no errors; lint shows 0 errors (23 warnings is the current
baseline, do not treat pre-existing warnings as a regression); `npm test` shows `pass 119, fail 0`
(the exact count may have grown if other work landed since this plan was written — any number of
failures is a STOP condition, any number of *new* passes is fine); `npm run test:unit` shows all
files passing.

## Test plan

No new tests are needed — this is a dependency version bump with no behavior change. The
existing `tests/*.test.cjs` suite already exercises the WebSocket-adjacent HTTP auth paths and
will catch any incompatibility. Do not add a `ws`-specific regression test; that would test the
dependency's internals, not this repo's code.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm ls ws` shows version `>=8.21.0`
- [ ] `npm audit --omit=dev` no longer lists `ws`
- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits with 0 errors
- [ ] `npm test` exits 0 (all suites pass)
- [ ] `npm run test:unit` exits 0 (all suites pass)
- [ ] `git status` shows only `package.json` (if applicable) and `package-lock.json` modified
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm install ws@^8.21.0` wants to change `package.json`'s range to something other than
  `^8.20.0`/`^8.21.0` (e.g. if it tries to pull in a new major) — that's a bigger decision than
  this plan covers.
- Any existing test in `tests/*.test.cjs` or `tests/unit/*.test.ts` starts failing after the bump.
- `npm audit --omit=dev` still lists `ws` as vulnerable after the install.

## Maintenance notes

- This is a point-in-time fix. Whoever owns dependency hygiene should periodically re-run
  `npm audit --omit=dev` (it's read-only and safe to run anytime) rather than waiting for the next
  full review.
- The pre-auth WebSocket connection window (client connects, then has ~10s to send the
  `{type:'auth'}` first frame before the server closes it, per `server/index.cjs:3439-3445`) is
  accepted, intentional behavior documented in the prior review (`code-review-update.md`, H3) — it
  is what made this specific `ws` advisory reachable pre-auth, but changing that design is out of
  scope for this plan and not recommended as a reaction to this fix alone.
