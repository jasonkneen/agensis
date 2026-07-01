# Plan 008: Fix the Host-header bypass in the loopback dev-agent auth fallback

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2e41d3..HEAD -- server/index.cjs`
> If it changed since this plan was written, re-read `allowLoopbackAgentDevFallback` against the
> excerpt below before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `a2e41d3`, 2026-07-01

## Why this matters

`allowLoopbackAgentDevFallback` is meant to let a local, same-machine dev agent connect without a
real token check, as a development convenience. But its loopback test ORs the `Host` header check
with the real `remoteAddress` check instead of requiring both — meaning a **non-loopback** client
can satisfy the "is this loopback" test purely by sending `Host: localhost:<port>` (or
`Host: 127.0.0.1:<port>`), a header value the client fully controls unless a reverse proxy strictly
overwrites it. Combined with the fact that the resulting token check only verifies a `aga_` string
prefix (not the token's actual validity), this means: on any deployment where `NODE_ENV` is unset
or not `'production'` and is internet-reachable (a plausible staging/self-hosted misconfiguration —
the documented Fly production deployment does set `NODE_ENV=production` and is unaffected), a
remote, fully unauthenticated client that already knows or guesses a valid `workspaceId`+`agentId`
pair can impersonate that agent.

## Current state

**`server/index.cjs:1327-1337`** (in full):

```js
function allowLoopbackAgentDevFallback(req, token) {
  if (process.env.NODE_ENV === 'production') return false;
  if (!String(token || '').startsWith('aga_')) return false;
  const remote = req?.socket?.remoteAddress || '';
  const host = String(req?.headers?.host || '');
  return remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1'
    || host.startsWith('127.0.0.1:')
    || host.startsWith('localhost:');
}
```

Confirmed: the Fly deployment config (`Dockerfile.fly:7`, `fly.toml:23`) sets
`NODE_ENV=production`, so the primary documented production path is not exposed to this bug
regardless of this fix — this plan closes the gap for any other deployment (staging, self-hosted,
a misconfigured environment) rather than the flagship production path specifically.

## Commands you will need

| Purpose         | Command                          | Expected on success           |
|------------------|-----------------------------------|--------------------------------|
| Typecheck        | `npm run typecheck`               | exit 0, no errors                |
| Node test suite  | `npm test`                        | all pass (baseline 119)          |

## Scope

**In scope** (the only files you should modify):
- `server/index.cjs` (`allowLoopbackAgentDevFallback` only)
- `tests/*.test.cjs` (new test for the fixed behavior)

**Out of scope** (do NOT touch, even though they look related):
- The `aga_`-prefix-only token check that follows this function in the call chain — tightening
  *that* (e.g. requiring the token to actually validate, not just have the right prefix) is a
  separate, larger change to the dev-agent connect flow; this plan only fixes the loopback
  detection logic itself, not the token check downstream of it.
- Anything under `NODE_ENV === 'production'` handling — unaffected either way; do not add new
  environment-detection logic beyond what's already here.

## Steps

### Step 1: Require an actual loopback remote address; drop the Host-header alternative

Replace the OR'd boolean with a check that requires the real `remoteAddress` to be loopback,
removing the `Host`-header-based alternatives entirely (an attacker fully controls the `Host`
header; they do not control `req.socket.remoteAddress`, which reflects the actual TCP peer):

```js
function allowLoopbackAgentDevFallback(req, token) {
  if (process.env.NODE_ENV === 'production') return false;
  if (!String(token || '').startsWith('aga_')) return false;
  const remote = req?.socket?.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}
```

If the actual dev workflow this fallback exists for relies on the `Host`-header path specifically
(e.g. a local reverse proxy that changes the apparent `remoteAddress` away from loopback even for
genuinely local traffic — check for any such proxy in `scripts/dev-full.mjs` or
`scripts/electron-dev.mjs` before assuming this isn't the case), gate the fallback behind an
explicit opt-in environment variable instead, so it can never silently apply to an unconfigured
non-production deploy:

```js
function allowLoopbackAgentDevFallback(req, token) {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.AGENSIS_ALLOW_DEV_AGENT_FALLBACK !== '1') return false;
  if (!String(token || '').startsWith('aga_')) return false;
  const remote = req?.socket?.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}
```

Prefer the **first** (simpler) version unless you find evidence in `scripts/dev-full.mjs`/
`scripts/electron-dev.mjs` that local dev traffic genuinely doesn't arrive with a loopback
`remoteAddress` (e.g. because of a proxy in the dev pipeline) — check this before choosing.

**Verify**: `grep -n "scripts/dev-full.mjs\|scripts/electron-dev.mjs" -e "proxy\|127.0.0.1"` (or
just read both files) to confirm local dev traffic reaches this function with a loopback
`remoteAddress` directly.

### Step 2: Confirm the fix doesn't break the local dev workflow it exists for

Manually (or via the new test below) confirm that a request whose `req.socket.remoteAddress` is
genuinely `127.0.0.1` still passes, regardless of what `Host` header it sends — this preserves the
intended local-dev convenience while removing the exploitable alternative path.

**Verify**: covered by the test in the Test plan section below.

## Test plan

Add to an existing relevant test file (or a new `tests/loopback-dev-fallback.test.cjs`):

- A mock request with `remoteAddress: '10.0.0.5'` (non-loopback) and `headers.host: 'localhost:3000'`
  (spoofed) is now rejected by `allowLoopbackAgentDevFallback` — this is the fixed bug; before the
  fix it would have passed.
- A mock request with `remoteAddress: '127.0.0.1'` and any `Host` header still passes (confirms the
  legitimate local-dev case still works).
- A mock request with `remoteAddress: '10.0.0.5'` and no spoofed `Host` header is rejected (sanity
  check — this was already rejected before the fix, confirming no regression).
- If `NODE_ENV=production` is set, the function returns `false` regardless of `remoteAddress`
  (confirms the production gate is untouched by this change).

Verification: `npm test` → all pass, including the new cases, no regressions in the 119-test
baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including a new test proving the Host-header spoof no longer passes
- [ ] A genuinely loopback `remoteAddress` request still passes the fallback check (no regression
      to the local-dev workflow)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `scripts/dev-full.mjs` or `scripts/electron-dev.mjs` reveals that local dev traffic is proxied in
  a way that changes `remoteAddress` away from loopback — in that case, use the opt-in
  environment-variable variant from Step 1 instead of the simpler fix, and note which one you chose
  and why in your final report.
- Any existing test relies on the `Host`-header path specifically passing for a non-loopback
  `remoteAddress` — that would indicate an intentional use case this plan's evidence didn't
  surface; stop and confirm with the plan owner before removing it.

## Maintenance notes

- This fallback only ever applies when `NODE_ENV !== 'production'` — the documented Fly production
  path is unaffected by both the bug and this fix. The residual risk this plan closes is specific to
  non-production deployments that are nonetheless internet-reachable (staging environments,
  self-hosted instances without `NODE_ENV` set) — worth a one-line note in deployment docs that
  `NODE_ENV=production` must always be set for any internet-facing instance, if such a doc exists or
  is created later.
