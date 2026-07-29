# self-update-supervise — Daemon self-update + supervise

Pack rank 12, priority 15 (lowest). Source pack:
`/Users/jkneen/Documents/GitHub/repo-grab/out/extract-pack/self-update-supervise/`.

This is a gap analysis and verification review, not an implementation plan. The
capability the pack describes shipped in daemon 0.1.43/0.1.44 earlier today
(2026-07-29).

---

## 1. Verdict

**Reject the pack as an import. Adopt four small follow-ups, one of which is a
live defect.**

The pack is a round-trip artifact. `pack.json:6-9` declares
`source_system: "agensis-agent"` and `target_systems: ["buzz"]` — it was
extracted *out of our repo* as a spec for buzz to build. Every code excerpt in
`anchors.json` is our own source, verbatim: the `selfUpdate.mjs` excerpt is
`packages/agensis-cli/src/selfUpdate.mjs:1-45` and the `supervise.mjs` excerpt
is `packages/agensis-cli/src/supervise.mjs:1-40`, comments and all.
`recommendation.json:6` then says `target_system: "agensis"`, which contradicts
the pack it wraps.

**Resolution of the target_system question:** the pack is right, the
recommendation is wrong. The extractor's ranking layer re-pointed a buzz-ward
export back at its own source. There is nothing here to import — building it
would mean reimplementing our own module against a truncated copy of its own
header comment. The only line in the recommendation that reads as a genuinely
new idea is `target_surface: "agensis server/ + src/ feature module"`, and only
under the charitable reading "surface daemon version state in the web app" —
which is Gap 3 below, and is worth doing.

### What already exists

| Pack requirement | Where it lives |
| --- | --- |
| Side-by-side version installs | `packages/agensis-cli/src/selfUpdate.mjs:74-92` (`defaultInstallVersion`, one `npm install --prefix` per version under `~/.agensis/versions/<v>/`) |
| `current` symlink | `selfUpdate.mjs:55-69` (`resolveCurrentLink`, `linkCurrent`) |
| Install before stopping the old daemon | `selfUpdate.mjs:240` (install) precedes `:251` (stop) |
| Health via heartbeat | `selfUpdate.mjs:134-150` (`defaultHealthCheck` — fresh + `connected` + pid-pinned, 30s default, 10s freshness) |
| Rollback without a second install | `selfUpdate.mjs:264-285` (symlink flip back + respawn; `fs.existsSync` on the previous entry is deliberately *not* injectable, `selfUpdate.mjs:271`) |
| Supervisor process | `packages/agensis-cli/src/supervise.mjs:70-190` (`runSupervisor`) |
| Crash respawn with backoff | `supervise.mjs:48,110-122` (`[1s, 5s, 15s, 30s]`) |
| Update trigger, no new network surface | `supervise.mjs:142` reads `update-request.json`; `state.mjs:351,379,408` |
| Registry auto-update, idle-gated | `supervise.mjs:151-163`; idle guard `state.mjs:287-295` (`isDaemonIdle` — missing/stale beat counts as idle, deliberately) |
| Numeric version compare | `selfUpdate.mjs:169-179` (`compareVersions`; a string compare would rank 0.1.9 above 0.1.10) |
| CLI surface | `packages/agensis-cli/bin/agensis.mjs:220-240` — `agensis supervise [--profile] [--poll-ms] [--no-auto-update] [--auto-check-ms]`, auto-update defaults ON |
| Tests on the real entry point | `tests/unit/selfUpdate.test.ts` (239 lines), `tests/unit/supervise.test.ts` (222 lines) |
| Docs | `AGENTS.md:22-51` |

Every pack acceptance check is already met, with one exception: `AGENTS.md:22-51`
documents the file-request flow but says nothing about the automatic registry
polling, the idle guard, or `--no-auto-update`. The pack's own acceptance bar is
"docs mention how agents/humans use it", and today's behaviour change is
undocumented. Fixing that is part of Slice A.

---

## 2. What the pack proposes

Side-by-side installs keyed by version, a `current` symlink naming the live one,
a separate dumb supervisor process that owns install/spawn/health/rollback, and
recovery by symlink flip rather than reinstall — so a broken release can never
block recovery of the last-known-good one, because recovering it does not
execute any code from the broken version.

Its `recreation_prompt` targets buzz's stack (Rust crates, Nostr kinds,
Postgres/Redis relay, `buzz-cli`/`buzz-acp`) and instructs a reimplementation
with different structure and names. None of that is a fit question for us — it is
an instruction aimed at a different repository. The only architecture assumption
worth naming is that buzz would need a per-node install layout equivalent to
`~/.agensis/versions/`; a Rust binary distribution has no npm registry to poll
and would need its own artifact source, which is buzz's problem, not ours.

**No buzz source is present in the pack.** The team-lead brief asked for a
comparison of buzz's approach against ours. That comparison cannot be made from
these artifacts: buzz is the *target*, and the pack's only code is ours. Section 3
therefore evaluates the named candidate gaps on their own merits rather than
against a real buzz implementation. Where I could not determine something, I say
so rather than inventing a buzz behaviour to compare against.

---

## 3. Gap analysis

### 3.1 Rollback is not sticky — a bad release causes a repeating downtime cycle (LIVE DEFECT)

This is the headline finding, and it is a live behaviour bug in 0.1.44, not a
missing feature.

`supervise.mjs:151-163` decides to auto-update on exactly one input: is `latest`
strictly newer than `state.currentVersion`, and is the daemon idle. It never
consults `lastAttempt`.

Consequence 1 — **rollback is undone.** If 0.1.45 fails its health check, the
supervisor rolls back to 0.1.44 and records
`lastAttempt.result = 'rolled_back'` in `update.json` (`selfUpdate.mjs:278-283`).
Thirty minutes later the registry still says `latest = 0.1.45`, `0.1.45 > 0.1.44`
is still true, and the daemon is still idle — so it tries again. And again, every
30 minutes, forever. Each attempt stops the running daemon, spawns a version
already known to be broken *on this host*, waits out the full 30s health timeout,
and respawns the old one. That is a recurring outage cycle on every supervised
host, self-inflicted, until a human intervenes.

Consequence 2 — **an operator downgrade is silently reverted.** An operator
escaping a bad release writes `update-request.json` with an older version.
`performSelfUpdate` does not gate on newness, so the downgrade lands and
`state.currentVersion` becomes the old version. The next auto-check sees `latest`
is newer and rolls forward onto the release the operator was escaping. The only
defence today is `--no-auto-update`, which requires restarting the supervisor —
i.e. the operator must know about a flag, and must have shell access at the
moment things are going wrong.

There is no pinning or downgrade policy of any kind. This is the pack candidate
"downgrade/pinning policy" and it is not merely absent; its absence actively
fights the operator.

### 3.2 No fleet staging, no jitter

Every supervised daemon independently polls `registry.npmjs.org/.../latest`
(`selfUpdate.mjs:193-210`) and takes whatever it finds. There is no canary, no
cohort, no rollout percentage. A bad publish reaches the entire fleet inside
30 minutes. Combined with 3.1, it reaches the entire fleet *repeatedly*.

Worth noting what does contain the blast radius today: the idle guard means no
in-flight turn is destroyed, and rollback means each host self-recovers within
one health-check window. So the failure mode is "the fleet flaps" rather than
"the fleet dies". That is the difference between a Sev-2 and a Sev-1, and it is
why I rate staged rollout as lower priority than 3.1.

A cheap 80% mitigation is available and does not require any fleet
infrastructure: (a) fix 3.1 so a rollback is sticky, which stops the flapping
outright; (b) add per-host jitter to `lastAutoCheckAt` so hosts do not
synchronise their check window; (c) point the poll at a `stable` dist-tag rather
than `latest`, so promoting a release to the fleet is a deliberate `npm dist-tag`
act separate from publishing it. (c) is one string change plus a release-process
change, and it gives us a manual canary for free: publish, run it ourselves,
then promote.

Real staged/canary rollout across a fleet (cohorts, percentages, automatic
promotion gates) is a genuine capability we lack, and I would not build it. It
needs a server-side fleet registry and a policy engine; the daemon population is
small and (b)+(c) covers the realistic risk.

### 3.3 Artifact integrity: partly covered, one real hole

The pack candidate was "signature/integrity verification of the downloaded
artifact — we do a plain registry GET and npm install, no signature check". That
framing overstates the gap in one direction and understates it in another.

Overstated: `defaultFetchLatestVersion` only fetches a *version string* over
TLS — it downloads no artifact. The artifact fetch is `npm install`
(`selfUpdate.mjs:83-87`), which already verifies each tarball against the
integrity hash in the registry metadata over TLS. We are not running unverified
bytes. What we lack is *provenance* — npm publish attestations / sigstore, via
`npm audit signatures`. Given we control the publishing pipeline and the package
is ours, I rate that low value.

Understated, and a real hole: `defaultInstallVersion` does **not** pass
`--ignore-scripts`. `selfUpdate.mjs:83-87` passes `--no-audit --no-fund
--no-save --omit=dev` only. So any dependency (including a transitive one)
with an `install`/`postinstall` script executes arbitrary code as the daemon
user, on every host, automatically, triggered by a registry poll nobody
authorised. That is a supply-chain execution path opened by the auto-update
feature specifically — before 0.1.43 a human ran the install. It is worth
closing, and it is a two-word change plus a check that our own package does not
rely on lifecycle scripts.

### 3.4 Update windows

None. The idle guard (`state.mjs:287-295`) is the only timing control. I do not
think we need maintenance windows: idle-gating is a strictly better predicate
than wall-clock for this workload, because it keys on the thing that actually
gets destroyed (an in-flight turn) rather than on a proxy for it. Not a gap
worth closing.

### 3.5 No fleet version visibility (see Gap 3 below)

Covered in full in section 4.2. Short version: the data already reaches the
browser and nothing renders it.

---

## 4. The three named gaps

### 4.1 Zero-downtime updates — do not build

The premise is right: `performSelfUpdate` stops the old daemon
(`selfUpdate.mjs:251`) before spawning and health-checking the new one
(`:255-256`), so there is a downtime window. Its size is spawn + register +
first heartbeat — the slow part (`npm install`, `:240`) already happens with the
old daemon alive, which is the right call and is already made.

The brief names the M15 one-active-job unique index as the collision. That index
(`server/index.cjs:1600`, `uq_agent_jobs_active_per_session_agent`) is keyed on
`(session, agent)`, not on connection, so it does not by itself forbid two live
connections. **The sharper blockers are two others, and they are worse:**

1. **Registering supersedes.** `server/agent-connections.cjs:625-645` enforces
   one live daemon per agent: a new register takes over and the loser is sent
   `agent_disabled`, which every released daemon treats as **terminal** — it logs
   and stops, and does not reconnect. So "register the new daemon alongside the
   old one" is not an additive step; it *kills the old daemon* as a side effect
   of the health check we were using it as a safety net for. If the new version
   then fails, we have already cut the rope.
2. **Permission delivery is connection-scoped.** Requests are keyed
   `(connection_id, request_key)` with a unique index
   (`server/agent-permissions.cjs:86`, insert at `:268-271`), routed to an exact
   connection (`:191`), and expired per connection (`:516-522`). Two live
   connections would split one agent's approval queue in two, and a human
   approving in chat could be answering a daemon that is about to be discarded.

True zero-downtime would therefore need: a drain/handover protocol replacing the
newest-wins supersede rule; permission delivery re-homed from connection scope to
agent scope (today's `rehomePendingPermissionRequests` at
`agent-permissions.cjs:476-500` moves requests *after* the fact, which is not the
same as serving two connections at once); and a new handover message type. That
is multi-day work in the most safety-critical part of the connection layer, to
remove a few seconds of downtime that only ever occurs while the agent is idle.

**Verdict: not worth it.** The cost/benefit is not close. If we ever want to
narrow the window further, the cheap move is tightening
`HEALTH_POLL_INTERVAL_MS` (`selfUpdate.mjs:42`, currently 1s) so a healthy new
daemon is confirmed faster — not restructuring the connection model.

### 4.2 Daemon version in the UI — yes, worth a slice, and it is nearly free

An operator genuinely cannot tell which daemons are stale. But the plumbing is
already complete end to end; only the render is missing:

- The daemon puts its version in the register frame's metadata —
  `packages/agensis-cli/src/agensis.mjs:380` (`version: AGENSIS_CLI_VERSION`).
- The server persists register metadata verbatim —
  `server/agent-connections.cjs:597-600`.
- Heartbeats **merge** rather than replace (`metadata = coalesce(metadata,
  '{}'::jsonb) || $3::jsonb`, `server/agent-connections.cjs:799`), so the
  version survives even though `heartbeatMetadata`
  (`packages/agensis-cli/src/agensis.mjs:1792+`) does not resend it.
- `publicAgentConnection` ships the whole metadata object to the browser —
  `server/index.cjs:3106`.
- The frontend type already allows it — `src/types/index.ts:687`
  (`metadata: Record<string, unknown>`).
- A render site already exists — `src/components/windows/AgentsWindowContent.tsx:2094`
  and `:2101` render `connection.host` / `connection.cwd` on the connection row.

So this is a **frontend-only change on the Netlify lane**: no DDL, no
`fly deploy`, no npm publish, no daemon restart. Read `connection.metadata.version`,
render it next to the host, and mark it stale when it trails the newest version
seen across the workspace's own connections (a client-side max — do not add a
server call to the npm registry for this).

What I would deliberately *not* do in v1: surface `update.json`
(`currentVersion`/`previousVersion`/`lastAttempt`) in the UI. That would let an
operator see "this host rolled back off 0.1.45", which is genuinely valuable
once 3.1 is fixed — but it requires the daemon to fold update state into
`heartbeatMetadata`, which means a daemon change, an npm publish, and a fleet
that has taken it. Ship the version chip first from data that is already
flowing.

### 4.3 The flaky SIGKILL test

`tests/unit/selfUpdate.test.ts:180-195`, "escalates to SIGKILL when the child
ignores SIGTERM". Reported failing roughly 2 runs in 3 under load, and also on a
clean HEAD. **This is a test defect, not a product defect** —
`defaultStopDaemon` (`selfUpdate.mjs:110-128`) is correct. Two independent flake
sources, both load-sensitive, which matches "fails on clean HEAD too":

1. **The fixed sleep at `:189`.** The test waits 200ms for the spawned child to
   install its SIGTERM handler. Node cold start routinely exceeds 200ms on a
   loaded machine, and the test's own comment at `:184-188` names exactly this
   hazard while still using a sleep to guard it. When it loses, SIGTERM arrives
   before the handler exists, the child dies on the default disposition, and
   `child.signalCode` is `'SIGTERM'` — the assertion at `:194` fails.
   **Fix:** replace the sleep with a readiness handshake. Have the `-e` script
   write a byte to stdout after installing the handler, spawn with
   `stdio: ['ignore', 'pipe', 'ignore']`, and await the first stdout chunk. The
   existing 10s test timeout (`:195`) already bounds it, so no new timeout logic
   is needed and the test gets *faster* on an unloaded machine.
2. **The elapsed-time assertion at `:193`,**
   `expect(Date.now() - before).toBeGreaterThanOrEqual(300)` against a 300ms
   `graceMs`. Timer coalescing and clock granularity can return 299.
   **Fix:** drop this assertion, or relax it to `>= 250`. Dropping it loses
   nothing: `signalCode === 'SIGKILL'` at `:194` already proves escalation
   happened, because a child that installed a no-op SIGTERM handler cannot have
   died any other way.

Runner: `tests/unit/**` runs under `npm run test:unit` (`vitest run tests/unit`,
root `package.json:12`) in the agensis-agent repo, which is the correct lane —
the glob problem that has bitten the agensis repo twice does not apply here.

---

## 5. Recommended work

No DB schema changes. Nothing belongs in `ensureRuntimeSchema()`. No new routes,
no new WS message types, no RBAC surface change — Slices A, C and D are
daemon-local and touch no server-authenticated path; Slice B reads a field the
`read` role already receives.

### Slice A — make rollback sticky and pinning honest (vertical slice, do first)

Fixes 3.1. This is the only item I would call urgent.

| File | Change |
| --- | --- |
| `packages/agensis-cli/src/supervise.mjs` | Before auto-updating, read `update.json`; skip any `targetVersion` whose last attempt on this host was `rolled_back` or `failed_no_fallback`. Honour an operator pin: after a file-requested update to a version older than `state.currentVersion`, record a pin and let auto-update take nothing above it until the pin is cleared. |
| `packages/agensis-cli/src/state.mjs` | Extend the `update.json` shape with the deny-list of locally-failed versions and the pin; keep it additive so an existing file parses. Add a `clearUpdatePin` helper for the operator escape hatch. |
| `packages/agensis-cli/bin/agensis.mjs` | `--pin <version>` / `--unpin` on `supervise`, and mention the deny-list in `--help`. |
| `AGENTS.md` (agensis-agent) | Document automatic updates, the idle guard, `--no-auto-update`, pinning, and the locally-failed deny-list. Closes the pack's own docs acceptance check, which today's release left open. |

Design note for the implementer: keep the deny-list keyed by version string and
host-local. Do not try to make it expire — a version that failed health here
should stay refused here until a human says otherwise. That is the whole point.

### Slice B — daemon version chip in the connections list

Fixes 4.2. Frontend only.

| File | Change |
| --- | --- |
| `src/components/windows/AgentsWindowContent.tsx` | At the connection row (`:2094-2101`), render `String(connection.metadata?.version ?? '')` as a small chip beside host/cwd. Mark it stale when it trails the max version across the workspace's own connections. Reuse `compareVersions`-equivalent numeric logic — do **not** string-compare, for the 0.1.9-vs-0.1.10 reason already documented at `selfUpdate.mjs:161-168`. |
| `src/types/index.ts` | Optional: narrow `AgentConnection['metadata']` with a known-keys interface rather than leaving it `Record<string, unknown>`. Cosmetic; skip if it ripples. |

### Slice C — `--ignore-scripts` on the versioned install

Fixes 3.3. One file.

| File | Change |
| --- | --- |
| `packages/agensis-cli/src/selfUpdate.mjs` | Add `--ignore-scripts` to the `npm install` argv at `:83-87`. Verify first that `@agensis/agensis-agent` and its runtime deps need no lifecycle script — it is a bundled single-file artifact, so this should hold, but check rather than assume, and note the check in the commit message. |

### Slice D — jitter and a `stable` dist-tag

Partial mitigation for 3.2. Do after A; A alone removes the flapping.

| File | Change |
| --- | --- |
| `packages/agensis-cli/src/supervise.mjs` | Seed `lastAutoCheckAt` (`:136`) with a random offset within the check interval so hosts desynchronise. |
| `packages/agensis-cli/src/selfUpdate.mjs` | Make the dist-tag in `defaultFetchLatestVersion` (`:197`) a parameter defaulting to `stable`; supervise passes it through. Requires adding a `stable` dist-tag to the release process — until it exists, the fetch must fall back to leaving the daemon alone (the function already returns `null` on a non-OK response, `:201`, so an absent tag is safe by construction). |

**Build order:** A, then B, then C, then D. A is the vertical slice — it is the
only one that changes an outcome an operator would notice today.

---

## 6. Test plan

All of these are in the **agensis-agent** repo, vitest lane
(`npm run test:unit`, glob `tests/unit`), except Slice B which is agensis-repo
frontend and must live under `tests/unit/**/*.test.ts` to run at all.

### `tests/unit/supervise.test.ts` (extend — Slices A, D)

| Invariant | Mutation that must break it |
| --- | --- |
| A version that previously rolled back on this host is never auto-taken again | Remove the deny-list check in the auto-update branch; the test must then see a second `performSelfUpdate` call for the same version |
| An operator pin below `latest` survives the next auto-check | Drop the pin comparison; the test must then observe an update to `latest` |
| An operator's explicit `update-request.json` still overrides the deny-list | Extend the deny-list check to cover file requests too; the test must then see the request ignored |
| Auto-check start time is jittered within the interval | Restore the fixed `Date.now()` seed; a test asserting variance across N constructed supervisors must then see zero spread |

Use the existing seams — `fetchLatestVersionFn`, `readHeartbeatFn`,
`maxIterations` (`supervise.mjs:88-93`) — rather than adding new ones. Note that
the existing auto-update tests at `:181-212` already establish the fake-registry
pattern; follow it.

### `tests/unit/selfUpdate.test.ts` (fix — 4.3; extend — Slice C)

- Rewrite `:180-195` per section 4.3: readiness handshake instead of the 200ms
  sleep, and drop or relax the elapsed-time assertion.
- New: assert the `npm install` argv contains `--ignore-scripts`. The mutation
  that must break it is removing the flag. This needs the `execFile` call to be
  observable — either inject the exec function or assert via a spawn wrapper.
  Prefer injection, matching the module's existing convention
  (`selfUpdate.mjs:14-17`).

### Slice B — agensis repo, `tests/unit/`

One component test asserting the chip renders `connection.metadata.version` and
that `0.1.10` sorts above `0.1.9`. The mutation that must break it is swapping
the numeric compare for a string compare. Keep it a real render assertion — a
test that only exercises the compare helper tests the helper, not the chip.

**Anti-vacuity note:** these are all daemon-side and use injected fakes rather
than a mock DB, so the "a mock that restates the SQL tests the mock" hazard does
not apply. The equivalent hazard here is a fake `installFn` that never asserts
its own arguments — which is exactly why the Slice C test must inspect argv, and
why `performSelfUpdate` deliberately keeps the rollback-availability
`fs.existsSync` un-injectable (`selfUpdate.mjs:271`, and the test file's comment
at `:31-34` explains why).

---

## 7. Migration and rollout

**No data migration. No backfill. Nothing is irreversible.**

Deploy lanes, per slice:

| Slice | Lane |
| --- | --- |
| A (sticky rollback, pinning, docs) | `npm publish` of `@agensis/agensis-agent` + version bumps per `AGENTS.md:12-20`. Reaches existing supervised daemons via their own auto-update — which is the recursive part: see the risk register. |
| B (version chip) | Netlify auto-deploy on push. Frontend only. |
| C (`--ignore-scripts`) | `npm publish` — bundle with A. |
| D (jitter + dist-tag) | `npm publish` + a release-process change to set the `stable` tag. |

No `fly deploy` and no local daemon restart are required by any slice. Say so
explicitly in the completion report rather than defaulting to "shipped".

**Rollback, concretely:** for A/C/D, publish the prior version and move the
dist-tag back; supervised hosts take it on their next check, and unsupervised
hosts are unaffected because they never auto-update. For B, revert the commit —
Netlify redeploys. There is no state to unwind in either direction.

**Feature flag:** none needed. A and C are strictly-safer behaviour changes with
no new surface. D's dist-tag change is self-flagging: until `stable` exists the
fetch returns `null` and nothing updates.

---

## 8. Risks and effort

Ranked. None of these can cause data loss.

1. **Slice A must ship correctly the first time, because it ships through the
   mechanism it is fixing.** A supervised daemon takes A via auto-update; if A
   itself fails its health check, the host rolls back to 0.1.44 — which has the
   3.1 defect and will retry A every 30 minutes. The bug protects itself.
   *Mitigation:* land A alongside D's `stable` tag so promotion is deliberate,
   and verify on one host manually before promoting. This is the single reason
   to do a real canary by hand for this one release.
2. **Security regression risk — none identified, one closed.** No slice touches
   auth, RBAC, the connect-token model, or the read-only client tables in
   `shared/backend-core.cjs`. Slice C *closes* an execution path (3.3). Slice B
   renders a field the `read` role already receives via
   `publicAgentConnection` (`server/index.cjs:3106`) — confirm during review
   that no other metadata key gets rendered alongside it by accident, since that
   object is a merge target for daemon-supplied data.
3. **Pin semantics could strand a host on an old version.** A pin that is never
   cleared means a daemon that never updates again. *Mitigation:* surface the
   pin in the Slice B chip (a pinned host reads differently from a merely stale
   one), and log it on every skipped auto-check so it appears in supervisor
   output.
4. **The deny-list could refuse a version that was only transiently unhealthy**
   (a health check lost to a slow host, not a bad build). *Mitigation:* accept
   it. Refusing to retry automatically is the correct default; `--unpin` plus an
   explicit `update-request.json` is the human override, and section 6 pins that
   override with a test.
5. **Interaction with work in flight:** none found. Slice B touches
   `AgentsWindowContent.tsx`, which is large and actively edited — check for
   conflicts before starting, and note this repo has other agent loops writing
   to the same checkout.

**Effort:** 2.0-3.0 engineer-days total — A ~1.0-1.5d (most of it tests and the
pin's edge cases), B ~0.5d, C ~0.25d, D ~0.5d. Confidence: high for B/C/D,
medium for A. **Biggest unknown:** the exact pin semantics an operator actually
wants — "pin to this version" versus "do not go above this version" versus
"stop auto-updating entirely" are three different features, and I have picked
the second because it is the one that fixes 3.1's downgrade case. That choice is
worth 10 minutes of Jason's time before implementation.

**Deliberately not built in v1:**

- Zero-downtime handover (section 4.1) — rejected on cost/benefit, not deferred.
- Real staged/canary rollout with cohorts and promotion gates (3.2) — the
  dist-tag gives us a manual canary; automated fleet rollout needs a server-side
  fleet registry we do not have and do not need at this population.
- Maintenance windows (3.4) — idle-gating is the better predicate.
- `update.json` state in the UI (4.2) — needs a daemon change and a fleet that
  has taken it; ship the version chip from already-flowing data first.
- npm provenance/attestation verification (3.3) — low value for a package we
  publish ourselves; revisit if we ever accept third-party daemon builds.
- Reporting update state to the server as a new WS message type — the existing
  `metadata` merge on register/heartbeat already carries everything v1 needs, and
  adding a message type for this would be new surface for no gain.
