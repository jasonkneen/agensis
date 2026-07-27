# Converting the agensis backend to NestJS — assessment and migration plan

*2026-07-27. Two parts: (1) should we, (2) how, if we do anyway. Part 3 handles the
Netlify mirror question this raises. Part 4 costs it.*

---

## Recommendation, up front

**Don't convert to NestJS for the reason that prompted this.** "Enterprises prefer
NestJS" is true and irrelevant to agensis: it is a fact about hiring markets at
companies with large backend teams, not about whether this codebase works. Nothing
an enterprise buyer asks about — SSO, audit trail, RBAC, encryption at rest, data
residency, uptime, SOC2 — is answered by a framework name, and this repo already
has real answers to most of them (workspace RBAC, an encrypted vault, `activity_events`
audit rows, SSRF guards on every outbound fetch).

**Do the two things NestJS is being given credit for, directly:**

- **(a) Split `server/index.cjs` by domain** using the `mountXRoutes(app, deps)`
  pattern this repo already invented for `huddles.cjs` and `voice.cjs`. That
  pattern *is* dependency injection, written by hand, and it already works with
  every existing test.
- **(b) Add TypeScript to the backend** independently of any framework.

Together these deliver the maintainability and type-safety wins, at a fraction of
the cost, with no new runtime dependencies, no build step in the Fly image, and no
multi-month window where the codebase is half-migrated across a two-backend split
that has already shipped inert features more than once.

**What would flip this to yes:** hiring a backend team of three or more who
already know Nest; or a customer contractually requiring it. Neither is true today.

---

# Part 1 — Assessment

## 1.0 What the backend actually is

Every number here is reproducible. The commands are in §1.6.

| | |
|---|---|
| `server/index.cjs` | **15,737 lines**, 736 KB, **127 Express routes**, 336 top-level functions, **0 classes** |
| — of which routes | lines 10898–15444 ≈ **4,546 lines (29%)** |
| — the other 71% | business logic, WS realtime fanout, daemon orchestration, the builtin tool loop, `ensureRuntimeSchema` |
| `netlify/functions/backend.mjs` | 2,793 lines, hand-rolled `pathname`-match router, **subset** of the API — 16 route prefixes vs Fly's 31 |
| `shared/backend-core.cjs` | 1,790 lines — auth, RBAC allowlists, rate limiters, param binding. Imported by both backends |
| Remaining backend | **12,333 lines / 25 modules** (`mcp.cjs` 1,742, `huddles.cjs` 1,585, `sandbox-skills.cjs` 1,309, …) |
| **Total backend** | **~32,500 lines, 100% CommonJS `.cjs`, zero TypeScript** |
| Tests | 96 `tests/*.test.cjs`; **60 of them `require('../server/index.cjs')`** directly (74 reference it at all) and reach a **177-name `__test` export block** |
| Build step | **None.** `Dockerfile.fly` copies `server/` + `shared/` raw and runs `node server/index.cjs` |
| Long-running state | `attachRealtime` (WSS on `/backend/ws`), 3 `setInterval` loops, boot-time DDL |

Route distribution, by prefix — this is the map any module decomposition follows:

```
41 workspaces   12 integrations   7 tenants    7 agents     4 system
 4 schedules     4 db             4 cursorbuddy 3 users     3 files
 3 auth          2 tts            2 settings    2 invites   2 inference
 2 link-previews 2 campaign-messages           2 agent-webhooks
 + ~14 singleton routes (health, feedback, ai-chat, rpc, sessions, inbox, …)
```

## 1.1 Four findings that decide this

### Finding 1 — The data plane is not REST, so Nest's main value doesn't apply to it

The frontend's primary data path is **four generic RPC routes**:

```ts
// src/lib/backendClient.ts:415-448
postJson('/backend/db/select', { table, columns, filters, orderBy, limit, single })
postJson('/backend/db/insert', { table, values, returning, single })
postJson('/backend/db/update', { table, values, filters, returning, single })
postJson('/backend/db/delete', { table, filters, single })
```

Safety comes from runtime allowlists in `shared/backend-core.cjs` —
`ALLOWED_TABLES`, `WORKSPACE_SCOPED_TABLES`, `DB_TABLE_ACCESS` — not from typed
route signatures. Architecturally this is PostgREST/Supabase, not a REST resource API.

NestJS's headline value is per-resource controllers, DTO classes, `ValidationPipe`,
and generated Swagger. **All four are weakest exactly where agensis's traffic is
heaviest.** A `DbController` with a `SelectDto` still ends up checking a
caller-supplied table name against an allowlist at runtime. You get a decorator and
a class; you do not get a type.

The 127 named routes *would* benefit. But they are the thin layer, not the app.

### Finding 2 — The 177-name `__test` block is the current architecture, and replacing it is the whole cost

`server/index.cjs` ends with:

```js
module.exports = { startBackendServer, createApp, __test: { /* 177 names */ } };
```

60 of the 96 test files reach into it directly; 74 reference the module at all.
The exported surface is not incidental — it includes
`callProviderOperation`, `assertSafeOutboundUrl`, `runToolUseLoop`,
`authorizeRealtimeBinding`, `registerAgentConnection`, the rate limiters, the
cadence-wake bookkeeping. Tests then drive the module with `setTestDb(fakeDb)` and
`resetTestState()`.

Nest's DI container is genuinely the right replacement for this. It is also why
the migration's real cost is **rewriting most of a 334-test backend suite** against
`Test.createTestingModule`, not moving 127 routes. Moving routes is the cheap part
and the part that looks like progress.

There is a cheaper version of the same win: `mountHuddleRoutes(app, deps)` already
takes its dependencies as an explicit object. Generalising that gets injectable
seams without a container.

### Finding 3 — Nest restructures 29% and leaves the hard 71% exactly where it is

Controllers absorb the 4,546 lines of route handlers. Untouched unless separately
decomposed:

- `notifyDbSubscribers` / `sanitizeRealtimeRow` / `authorizeRealtimeBinding` — the WS fanout
- agent daemon orchestration, dispatch, job reaping, `connectedAgents`
- the builtin tool-use loop (`runToolUseLoop`, `streamAnthropicTurn`)
- reply cadence, mention routing, thread lineage
- `ensureRuntimeSchema`

You can decompose all of it today, in `.cjs`, without adopting a framework. Nest
does not do this work for you; it changes the wrapper around the 29% that was
already the easiest part to read.

### Finding 4 — A build step appears where there is none, and habits break with it

Nest requires decorators → TypeScript → compile before `node`. Today
`Dockerfile.fly` copies source and runs it. The following all assume
runnable-as-written `.cjs`:

- `Dockerfile.fly` (`CMD ["node", "server/index.cjs"]`)
- `npm run backend` (`node --env-file=.env server/index.cjs`)
- `node --check server/index.cjs` — in the AGENTS.md ship checklist
- `npm test` — node's runner over `tests/*.test.cjs` with `--require` preload
- `.githooks/pre-push`

Each is a small edit. Collectively they change the "can I just run it" property
that every operational habit in AGENTS.md is built on — including the deploy-target
rules that have historically been the repo's most repeated mistake.

## 1.2 What Nest would genuinely buy

Stated fairly, because these are real:

- **TypeScript on the backend.** The frontend is TS; the backend is not. This is the
  largest concrete gap and Nest forces it.
- **DI replacing the `__test` block.** The single biggest structural win available.
- **Guards and interceptors as first-class.** `requireAuth` / `requireUserOrFarm`
  become `CanActivate`; rate limiting and audit become interceptors instead of
  inline calls repeated per route.
- **A conventional layout.** A new engineer — or a new agent session — could
  navigate `src/workspaces/workspaces.controller.ts` without reading AGENTS.md
  first. Given how much of this repo's operating knowledge currently lives in a
  700-line AGENTS.md, that is not nothing.
- **`@nestjs/schedule`** for the three `setInterval` loops; `OnModuleInit` for
  `ensureRuntimeSchema`; `OnModuleDestroy` for the teardown currently hung off
  `server.on('close')`.
- **Dependency compatibility is good.** `@nestjs/platform-express@11.1.28` depends
  on `express@5.2.1` and `cors@2.8.6` — the exact versions already in
  `package.json`. No version conflict to resolve.

## 1.3 What it costs

- **~32,500 lines CJS → TS**, or a long-lived hybrid that is worse than either end state.
- **Most of the 334-test backend suite rewritten.** Budget this as the largest single line item.
- **A build step** in the Fly image, both test runners, and the pre-push hook.
- **7 new runtime dependencies** (`@nestjs/core`, `common`, `platform-express`,
  `platform-ws`, `schedule`, `reflect-metadata`, `rxjs`) against an explicit
  AGENTS.md convention: *"No new npm dependencies without a strong reason."*
- **A long half-migrated window.** This is the specific risk, not a generic one:
  the repo's two hardest invariants — the three-place schema-sync rule and
  Fly/Netlify parity — are hardest to hold when the same logic exists in two
  shapes. The failure mode is already documented in this repo's history: features
  merged, reported shipped, and still inert because the wrong deploy target ran.
- **Wire-contract risk with a separate repository.** The `agensis-agent` daemon
  (`jasonkneen/agensis-agent`) speaks a hand-rolled WS frame protocol. Every frame
  must survive byte-identical, and it's tested from the other side of a repo boundary.
- **Decorator timing risk (real, and specific to right now).** Nest still requires
  *legacy* decorators — `experimentalDecorators` + `emitDecoratorMetadata` — because
  it uses parameter decorators, which TC39 Stage-3 decorators do not support. A
  Stage-3-aligned Nest major was targeted for **May 2026** and has not shipped:
  latest is **`@nestjs/core@11.1.28`, published 2026-07-08**. Adopting now means
  adopting the legacy decorator model immediately before the framework's announced
  migration off it.

## 1.4 The cheaper alternatives

These are competitors to Nest, not consolation prizes.

### (a) Split `index.cjs` by domain — the pattern is already in this repo

```js
// server/index.cjs:12028
mountHuddleRoutes(app, {
  getDb, requireAuth, enforceWorkspaceRole, jsonError, notifyDbSubscribers,
  rateLimitBlocked, webhookRateLimiter, clientIpFromReq,
});
```

That is dependency injection with an object literal instead of a container. It
already isolates 1,585 lines of huddle logic into its own file with its own tests.

Generalising it to ~15 domain modules, following the route-prefix map in §1.0:
no new dependencies, no build step, no test rewrite (each module keeps exporting
its own seams the way `huddles.cjs` does), and each module lands independently with
`npm run ci` green. This captures most of Finding 3's value.

**Suggested first cut, largest wins first:** `workspaces` (41 routes),
`integrations/farm` (12), `tenants` (7 — `shared/tenant-admin.cjs` is already
factored out), `agents` (7), `schedules` (4), `files` (3), `db` (4 — the RPC core,
extract last and carefully).

### (b) TypeScript without Nest

Two viable routes:

1. **`checkJs` + JSDoc types.** Zero build step; `tsc --noEmit` in `npm run ci`
   next to the existing frontend typecheck. Files stay `.cjs` and stay runnable.
   This is the lowest-risk way to get types onto `shared/backend-core.cjs`, which
   is where a type error would matter most (auth, RBAC, allowlists).
2. **Incremental `.ts` with a build step.** Higher ceiling, but pays Finding 4's
   cost without any of Nest's benefits — only worth it as Phase 1 of an actual
   Nest migration.

Recommend route 1 first, targeted at `shared/backend-core.cjs` and the modules that
cross the Fly/Netlify boundary, where a type mismatch causes the parity bugs the
four parity tests exist to catch.

### (c) Fix the `__test` block without moving anything

Convert the modules with the widest test surface to take explicit dependency
objects, as `mountHuddleRoutes` does. Tests inject fakes directly instead of
reaching through `__test` + `setTestDb`. Incremental, per-module, reversible.

## 1.5 Verdict

| Goal | Nest | (a) split | (b) TS | (c) explicit deps |
|---|:--:|:--:|:--:|:--:|
| `index.cjs` navigable | ✓ | ✓ | — | partial |
| Backend type safety | ✓ | — | ✓ | — |
| Testable without `__test` | ✓ | partial | — | ✓ |
| Conventional for new hires | ✓ | — | — | — |
| No new deps | — | ✓ | ✓ | ✓ |
| No build step | — | ✓ | ✓ (JSDoc) | ✓ |
| Tests survive as-is | — | ✓ | ✓ | mostly |
| Ships incrementally, low risk | — | ✓ | ✓ | ✓ |

Nest wins one row nothing else wins: *conventional for new hires*. That is the
enterprise-perception argument, and it is a real benefit — for a team that doesn't
exist yet. Everything else on the list is obtainable for materially less.

## 1.6 Reproduce the numbers

```bash
wc -l server/index.cjs netlify/functions/backend.mjs shared/backend-core.cjs
grep -cE "^\s*app\.(get|post|put|patch|delete)\(" server/index.cjs        # 127
grep -cE "^(async )?function " server/index.cjs                            # 336
grep -oE "app\.(get|post|put|patch|delete)\('/backend/[a-z-]+" server/index.cjs \
  | sed "s/.*'\/backend\///" | sort | uniq -c | sort -rn                   # prefix map
grep -l "require('../server/index.cjs')" tests/*.test.cjs | wc -l          # 60
ls tests/*.test.cjs | wc -l                                                # 96
npm view @nestjs/platform-express dependencies                             # express 5.2.1

# the __test export block
sed -n '15537,15737p' server/index.cjs | grep -vE '^\s*//' \
  | grep -oE '^\s+[a-zA-Z_][a-zA-Z0-9_]*,' | tr -d ' ,' | sort -u | wc -l   # 177

# rest-of-backend modules
wc -l server/*.cjs shared/*.cjs | grep -vE '(index|backend-core)\.cjs|total' \
  | awk '{s+=$1} END {print s}'                                             # 12333
```

---

# Part 2 — Migration plan, if the answer is go anyway

Seven phases. Each is independently shippable, leaves `npm run ci` green, and has a
one-move revert. **Do not start Phase 1 before Phase 0 is decided** — the Netlify
question changes the size of every later phase.

### Phase 0 — Decide the Netlify mirror *(blocking)*

See Part 3. Output is a written decision, not code.

### Phase 1 — TypeScript toolchain, nothing else

- `tsconfig.server.json`: `experimentalDecorators: true`, `emitDecoratorMetadata: true`,
  `allowJs: true`, `outDir: dist-server`, target Node 22 (matches `Dockerfile.fly`).
- Build step added to `Dockerfile.fly` (`RUN npx tsc -p tsconfig.server.json`),
  `CMD` retargeted to the built entry.
- `npm run backend` and `node --check` replaced with build-then-run equivalents.
- `allowJs` means every existing `.cjs` still compiles and runs unchanged.
- **Green gate:** `npm run ci` + a Fly deploy to a preview app that serves `/backend/health`.
- **Revert:** delete the tsconfig, restore two lines in the Dockerfile.

### Phase 2 — Nest bootstrap alongside Express

`NestFactory.create(AppModule, new ExpressAdapter(existingApp))` over the app
`createApp()` already returns. Zero routes migrated. `attachRealtime(server)` is
untouched — Nest never sees the WSS.

- **Green gate:** every one of the 127 routes still answers; `tests/root-routing.test.cjs`
  and the four parity tests green.
- **Revert:** drop the bootstrap call.

### Phase 3 — Guards

`requireAuth` and `requireUserOrFarm(scope)` become `CanActivate` implementations
that **call the same `shared/backend-core.cjs` functions**. Do not reimplement
`verifyAuthToken`, `assertWorkspaceRole`, or the allowlists — a second
implementation of auth is how the Netlify mirror shipped unauthenticated the first
time.

- **Green gate:** `tests/backend-auth.test.cjs`, `backend-rbac.test.cjs`,
  `netlify-parity.test.cjs`.

### Phase 4 — Domain modules, in dependency order

Migrate in this order — least-coupled first, so the pattern is proven before it
touches `workspaces`:

1. `huddles`, `voice` — already modules with explicit deps; near-mechanical
2. `tenants` (7) — `shared/tenant-admin.cjs` already factored out
3. `schedules` (4), `files` (3), `link-previews` (2), `inbox`, `feedback`
4. `cursorbuddy` (4), `agent-webhooks` (2), `invites` (2), `inference` (2)
5. `integrations/farm` (12) — touches device pairing + job dispatch
6. `agents` (7) — touches the daemon connection map; highest blast radius
7. `workspaces` (41) — largest; split into sub-controllers (gateways, vault,
   git, project-files, bootstrap, sandbox-credentials)
8. `db` (4) — **last.** The generic RPC core. Everything in the app depends on it
   and it gains least from being a controller.

Each module: controller + service, service holds the logic moved out of
`index.cjs`, `shared/*` imports unchanged.

- **Green gate per module:** its own tests, plus the parity test if the route
  exists on Netlify too.

### Phase 5 — Realtime: keep raw `ws`

`@nestjs/platform-ws@11.1.28` exists, but **recommend not using it.** The daemon
wire contract (frame shapes, the first-message auth frame, the legacy query-param
credential path, the pong-liveness terminate) lives in `attachRealtime`, is
consumed by a separate repository, and gains nothing from a
`@WebSocketGateway()` abstraction. Expose the WSS as a Nest provider so services
can call `notifyDbSubscribers`; leave the socket handling alone.

### Phase 6 — Retire the `__test` block *(largest phase)*

Convert tests to `Test.createTestingModule` with a mock DB provider, in the same
order as Phase 4. Delete names from `__test` only as their last consumer moves.
Do not batch this — a half-converted test file is worse than an unconverted one.

- **Green gate:** `npm test` count never drops. A skipped test is a regression.

### Phase 7 — Delete the Express shim

Remove `createApp`'s manual route registration and the `ExpressAdapter` bridge.
`server/index.cjs` becomes `main.ts`.

---

# Part 3 — The Netlify mirror decision

## The facts

- `netlify/functions/backend.mjs` is 2,793 lines duplicating **16 of Fly's 31**
  route prefixes. Roughly 40 routes exist only on Fly (`integrations`, `schedules`,
  `files`, `invites`, `inference`, `link-previews`, `sessions`, `inbox`, `join`, `tts`, …).
- Four tests exist solely to police the drift: `netlify-parity`,
  `agents-projection-parity`, `channel-mention-parity`, `reaction-events-netlify`.
- Divergence has already reached production — the frontend calling Fly routes that
  404 on the live path is a documented failure in this repo's history.
- Netlify additionally proxies `/join/*` to Fly (`netlify.toml`), so the two hosts
  are already not peers.

## Option A — Keep both, Nest on Fly only

Netlify function stays hand-rolled `.mjs`. Cheapest for the migration; the
duplication gets *worse*, because Fly's routes now live in a shape Netlify's cannot
share. `shared/backend-core.cjs` remains the only common ground.

## Option B — Keep both, Nest on both

`serverless-express` pipes requests through an in-memory socket into Express, and
the Nest DI container bootstraps per cold start — reported at roughly **1–2 s cold,
5–20 ms warm** for typical module counts. It roughly doubles the migration and adds
a latency cliff to the host that exists to be the cheap always-on path.
**Not recommended.**

## Option C — Collapse to Fly only

Delete ~2,800 lines and the entire parity-test class. One implementation, one
deploy target, one place a schema change lands.

The cost is **an availability decision, not a code decision**: Fly becomes a hard
single point of failure. Today `fly.toml` runs `min_machines_running = 1` on a
single `shared-cpu-2x` machine in `fra`, with a volume that attaches to one machine
— so the current setup is already close to single-point. The honest question is
whether the Netlify mirror is genuinely serving traffic during a Fly outage, or
whether it is a 2,793-line liability maintained on the belief that it might.

## Recommendation

**Measure before deciding.** Instrument which host actually serves `/backend/db/*`
in production for a week. Two outcomes:

- Netlify serves a meaningful share → **Option A**, and treat closing the 40-route
  gap as its own project.
- Netlify serves ~nothing but static assets and the `/join` proxy → **Option C**,
  independent of NestJS. It is worth doing on its own merits and would remove more
  complexity than the Nest migration adds.

Either way, this decision should be made *before* a framework migration, not
during one.

---

# Part 4 — Cost

**These are estimates, and estimates before a spike are guesses.** Assume one
engineer or agent session, `npm run ci` green at every phase boundary, Option A
for Netlify (Option C adds a separate ~3–5 days and removes ~1 day from Phase 4).

| Phase | Work | Days |
|---|---|---:|
| 0 | Netlify decision (incl. a week of measurement, mostly waiting) | 1–2 |
| 1 | TS toolchain, Dockerfile, scripts, hooks | 2–3 |
| 2 | Nest bootstrap alongside Express | 1–2 |
| 3 | Guards over existing shared-core functions | 2–3 |
| 4 | 127 routes → ~15 modules, incl. splitting `workspaces` | 15–25 |
| 5 | Realtime exposed as a provider (keeping raw `ws`) | 1–2 |
| 6 | **Test suite: 334 tests off `__test` onto DI** | **15–30** |
| 7 | Delete the Express shim | 1–2 |
| | **Total** | **38–69 days** |

Compare:

| Alternative | Days |
|---|---:|
| (a) Split `index.cjs` into ~15 `mountX` modules | **6–10** |
| (b) `checkJs` + JSDoc on `shared/` + the parity-crossing modules | **4–8** |
| (c) Explicit dep objects for the widest-tested modules | **3–6** |
| **(a)+(b)+(c)** | **13–24** |

## Do a spike before committing to any of this

Convert **`tenants`** end-to-end — 7 routes, self-contained,
`shared/tenant-admin.cjs` already factored out, 4 test files
(`tenant-admin-access`, `tenant-admin-routes`, `tenant-campaigns`, `tenants-admin`).
Time-box to **3 days**. Measure:

1. Hours per route (× 127 = the real Phase 4 number)
2. Hours per test file (× 96 = the real Phase 6 number, the one that decides this)
3. Whether `shared/backend-core.cjs` can stay `.cjs` and be imported from Nest
   without a wrapper — if not, the shared core has to migrate too, and the Netlify
   mirror migrates with it whether you wanted it to or not

If the spike's per-test-file number extrapolates past ~30 days, stop: the framework
is not worth a month of rewriting tests that already pass.

---

## Sources

- Current versions read from the npm registry, 2026-07-27: `@nestjs/core`,
  `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/platform-ws` all
  **11.1.28** (published 2026-07-08); `@nestjs/schedule` 6.1.3.
- [Stage 3 vs Legacy TypeScript Decorators in a NestJS App](https://nestjscourses.com/article/5e6c6c90-986a-4df0-8add-414f5a9a7320) — Nest requires `experimentalDecorators` + `emitDecoratorMetadata`; parameter decorators are unsupported by TC39 Stage-3; Stage-3-aligned major targeted May 2026.
- [How Stage 3 Decorators Will Revolutionize NestJS and Modern TypeScript Backends](https://leapcell.io/blog/how-stage-3-decorators-will-revolutionize-nestjs-and-modern-typescript-backends)
- [TypeScript: TSConfig — emitDecoratorMetadata](https://www.typescriptlang.org/tsconfig/emitDecoratorMetadata.html)
- [AWS Lambda Cold Starts: The Case of a NestJS Mono-Lambda API](https://dev.to/aws-builders/aws-lambda-cold-starts-the-case-of-a-nestjs-mono-lambda-api-4j42)
- [Improve NestJS cold starts on Lambda](https://medium.com/@rudyard_55741/improve-nestjs-cold-starts-on-lambda-with-rxjs-5dde21675e54)
- [How I Built a Production-Ready Serverless NestJS API on AWS](https://dev.to/tyson_cung/how-i-built-a-production-ready-serverless-nestjs-api-on-aws-and-open-sourced-it-5b29) — ~1–2 s cold, 5–20 ms warm
- Repository facts: `server/index.cjs`, `netlify/functions/backend.mjs`,
  `shared/backend-core.cjs`, `src/lib/backendClient.ts`, `Dockerfile.fly`,
  `fly.toml`, `netlify.toml`, `AGENTS.md`, `tests/`.
