# Backend refactor: reducing `server/index.cjs` without a framework

*2026-07-27. Companion to [`nestjs-assessment.md`](./nestjs-assessment.md), which
recommended this over a NestJS migration. This is the actionable version.*

---

## The headline

`server/index.cjs` is 15,737 lines, but **it is not tangled.** Two measurements
decide the whole approach:

**1. The routes are already contiguous domain blocks.** `createApp()` spans lines
10854–15443 and registers 127 routes in ~31 blocks that never interleave. Farm
integrations are lines 10954–11141 and nowhere else. Tenants are 12770–12944.
Schedules are 12944–13101. Nobody planned this; it's what happens when features
get appended. It means most extraction is *cut here, paste there*, not untangling.

**2. The file has a thin waist.** Ranked by internal call count:

```
333 getDb            306 jsonError        121 notifyDbSubscribers
 77 enforceWorkspaceRole   59 slugHandle      55 parseJsonObject
 37 forbidden         28 clientIpFromReq   26 badRequest
 23 sendWs            22 isAgentEnabled    18 textFromValue
```

**~12 functions carry nearly all cross-cutting calls.** Everything else is local
to its block. That set *is* the dependency-injection contract, and this repo has
already written it down — `mountHuddleRoutes(app, deps)` at `server/index.cjs:12028`
passes 8 of those 12.

So: the god file is a stack of coherent blocks sharing a dozen utilities. That's
the easy kind of big file.

## Target

| | Now | After |
|---|---:|---:|
| `server/index.cjs` | 15,737 | **~2,500–3,500** |
| Largest other file | `mcp.cjs` 1,742 | ~800 |
| New modules | — | ~20 |
| Test files changed | — | **0 during the refactor** |
| New dependencies | — | **0** |
| Build step | none | **none** |

`index.cjs` keeps: bootstrap, `createApp()` wiring (the `mountX` calls), auth +
RBAC glue, the `/backend/db/*` RPC core, and the `__test` facade.

## The rule that makes this zero-risk

**`__test` becomes a re-export facade, not a deletion.**

60 of 96 test files reach into `module.exports.__test`; 41 call `setTestDb` and
`resetTestState`. When a function moves to `server/lib/foo.cjs`, `index.cjs`
re-exports it:

```js
const foo = require('./lib/foo.cjs');
module.exports = { ..., __test: { ...existing, someFn: foo.someFn } };
```

Every test keeps passing **unchanged**. Facade entries are deleted later, one
module at a time, as tests are pointed at the real module. Refactor and test
migration are decoupled — that is the whole trick, and it's why this doesn't need
a big-bang window.

**Corollary:** inject `getDb` (the function), never `db` (the value). `setTestDb`
mutates the module-level `db`; a module that captured the value at require time
would hold a stale handle and silently talk to the wrong database. Every
extracted module calls `getDb()` per request. `mountHuddleRoutes` already does this.

---

## What's extractable, in order

### Wave 0 — Make the seam explicit *(~0.5 day, no behaviour change)*

Add one function to `index.cjs`:

```js
function coreDeps() {
  return {
    getDb, jsonError, forbidden, badRequest,
    requireAuth, requireUserOrFarm, enforceWorkspaceRole, enforceDbOperationAccess,
    notifyDbSubscribers, sendWs,
    rateLimitBlocked, dbRateLimitBlocked, clientIpFromReq,
    parseJsonObject, parseJsonArray, slugHandle, textFromValue, isAgentEnabled,
  };
}
```

Every `mountX` call becomes `mountX(app, { ...coreDeps(), ...extras })`. Retrofit
`mountHuddleRoutes` and `mountVoiceRoutes` onto it so there is exactly one shape.

**Gate:** `npm run ci`. **Revert:** delete one function.

### Wave 1 — Stateless leaves *(~2 days, near-zero risk)*

Helper clusters with no module-level mutable state and their own tests. Move the
functions; routes stay put for now.

| New module | Moves from | ~Lines | Existing tests |
|---|---|---:|---|
| `server/lib/net-guard.cjs` | `ipv4ToInt`, `ipv6Groups`, `isBlockedAddress`, `assertSafeOutboundUrl` (10671–10777) | 110 | `gateway-ssrf` |
| `server/lib/storage-paths.cjs` | `safeFileName`, `getUploadRoot`, `storagePathFor`, `resolveStoragePath*`, `getUploadExtension`, `lookupUploadContentType` (9065–9180) | 115 | `fileUploadContentType` |
| `server/lib/project-fs.cjs` | `projectFsAllowed`, `allowedProjectRootPrefixes`, `isWithinAllowedProjectRoot`, `workspaceProjectRoot`, `listProjectFiles` (9189–9340) | 150 | `git-stage-symlink` |
| `server/lib/capabilities.cjs` | `probeCommand`, `packageStatus`, `detectSkillLibraries`, `mergeSlashCommands`, `createTtlPromiseCache`, `detectCapabilities*` (9380–9680) | 300 | `ttlPromiseCache`, `slash-commands-merge` |
| `server/lib/codex-pets.cjs` | `listCodexPets`, `mergeLocalCodexPets`, `codexPetAssetUrl`, `contentTypeForImageAsset` (2937–3050) | 115 | — |
| `server/lib/db-sql.cjs` | `quoteIdent`, `ensureTable`, `normalizeColumns`, `isJsonColumn`, `normalizeJsonParam`, `bindDbParam`, `buildWhereClause`, `buildOrderClause`, `mapDbError` (1993–2140) | 150 | `jsonb-bind-hygiene`, `backend-client-contract` |

**~940 lines out.** `net-guard` and `db-sql` are security-critical — add both to
`MUST_BE_LINTED` in `tests/lint-coverage.test.cjs` in the same commit. That test
exists because `shared/backend-core.cjs` sat unlinted for months.

**Gate per module:** `npm run ci` + `node --check server/index.cjs`.

### Wave 2 — Contiguous route blocks *(~4 days, the bulk of the win)*

Each becomes `server/<domain>.cjs` exporting `mount<Domain>Routes(app, deps)`,
carrying its routes *and* its domain helpers. Ordered least- to most-coupled.

| Module | Route lines | Routes | Helpers that move with it |
|---|---|---:|---|
| `feedback.cjs` | 12709–12770 | 1 | — |
| `inference-routes.cjs` | 12397–12458 | 2 | `sharedModelsFromMessage`, `publicInferenceModel`, `createOpenAIInferenceStreamRelay`, `bindInferenceAbort` (7741–7900) |
| `codex-pets.cjs` (routes) | 11141–11183 | 2 | Wave-1 module |
| `system-routes.cjs` | 11183–11253 | 4 | `capabilities.cjs`, `inspectProjectPath`, `buildSystemPrompt` |
| `files.cjs` | 11253–11397 | 3 | `storage-paths.cjs` |
| `project-git.cjs` | 11397–11690 | 6 | `project-fs.cjs`, `shellQuote`, `isPathInside` |
| `tenants-routes.cjs` | 12770–12944 | 9 | `shared/tenant-admin.cjs` + `tenant-campaigns.cjs` already factored |
| `schedules.cjs` | 12944–13101 | 7 | `runDueSchedules`, `reconcileSchedulesAtStartup` (7085–7168) |
| `cursorbuddy.cjs` | 12211–12397 | 4 | 8 `*CursorBuddy*` helpers (2500–2900) |
| `farm-routes.cjs` | 10954–11141 | 12 | `farmDeviceRecord`, `farmIntegrationRecord`, `dispatchFarmAgentJob`, `cancelFarmAgentJob`, `publicFarmAgentJob` |
| `join-routes.cjs` | 14078–14528 | 6 | `createJoinLinkToken`, `isJoinLinkToken`, `joinLinkTtlMs`, `loadJoinLinkForDisplay`, `logJoinLinkActivity` — joins existing `join-page.cjs` |
| `members-invites.cjs` | 13797–14078 | 11 | `verifyInviteToken`, `inviteTokenLookupParams` |
| `vault-routes.cjs` | 14958–15189 | 8 | `listManagedSecrets`, `resolveSecret`, `encryptVaultSecret`, `decryptVaultSecret` |
| `flow-routes.cjs` | 14528–14614 | 3 | joins existing `flow-integration.cjs` |
| `agent-webhooks.cjs` | 11738–11857 | 2 | — |
| `agents-routes.cjs` | 13101–13357 | 6 | connection-command + disconnect + refresh helpers |

**~2,600 route lines out**, plus the helpers they drag with them.

**Gate per module:** its own test file(s), plus the parity test if the route also
exists on Netlify (`netlify-parity`, `agents-projection-parity`,
`channel-mention-parity`, `reaction-events-netlify`).

### Wave 3 — The three fat single routes *(~1.5 days)*

Three handlers are large enough to be modules on their own:

| Route | Lines | New module |
|---|---:|---|
| `POST /backend/webhooks/:token` | 13357–13615 = **258** | `server/inbound-webhooks.cjs` |
| `POST /backend/ai-chat` | 15228–15443 = **215** | `server/ai-chat.cjs` |
| `POST /backend/agents/dispatch` | 13196–13357 = **161** | into `agents-routes.cjs` |

`ai-chat` pulls the gateway-streaming branch with it — a discrete surface with its
own security story (`gateway_configs`, encrypted `api_key_cipher`).

### Wave 4 — The stateful cores *(~4 days, the only genuinely risky wave)*

These own the module-level mutable state, which is why they go last:

```
204  let db                          10 Maps/Sets:
205  let websocketClients            tokenVersionCache, mcpAgentPresence,
206  const connectedAgents           conversationLocks, cadenceWakes,
331  let cachedAuthSecret            recentTaskDispatches, taskQueueStrikes,
6040 let builtinToolsetInstance      taskQueueSelecting, pendingPeerTickets,
7084 let scheduleRunnerRunning       workspaceIdBySessionCache
```

`resetTestState()` currently resets 13 of these, and 41 test files call it. When
state moves, `resetTestState` must **delegate** into the new module — that is the
one thing in this plan that can silently break tests (a leaked Map makes tests pass
in isolation and fail in sequence, or vice versa).

| Module | Owns | Moves |
|---|---|---|
| `server/realtime.cjs` | `websocketClients` | `sendWs`, `parseFilter`, `matchesFilter`, `sanitizeRealtimeRow`, `notifyDbSubscribers`, `relayBroadcast`, `broadcastGlobal`, `authorizeRealtimeBinding/Broadcast`, `attachRealtime` (9764–10670, ~900 lines) |
| `server/agent-connections.cjs` | `connectedAgents`, `mcpAgentPresence` | `registerAgentConnection`, `findConnectedAgent`, `disconnectAgentDaemons`, `markAgentConnectionOffline`, `updateAgentHeartbeat`, `handleAgentMemorySync`, `handleAgentSkillSync`, `capabilitiesDriftNudges` |
| `server/task-dispatch.cjs` | `recentTaskDispatches`, `taskQueueStrikes`, `taskQueueSelecting`, `conversationLocks`, `cadenceWakes` | `dispatchTaskAssignment`, `drainAgentTaskQueue`, `claimTaskDispatch`, `scheduleCadenceWake`, `continueConversation` |
| `server/agent-jobs.cjs` | — | `insertActiveAgentJob`, `reapStuckAgentJobs`, `finalizeStuckJob`, `handleAgentJobResult/Delta/Step/Segment`, `claimMcpJob`, `reapStuckMcpJobs` |
| `server/builtin-turn.cjs` | `builtinToolsetInstance` | `runToolUseLoop`, `runAgentTurn`, `streamAnthropicTurn`, `runAnthropicCompletion`, `mcpToolDeps`, `getBuiltinToolset` |

**Mandatory extra gate for this wave:** run the suite in a randomised order
*and* run each affected test file alone. Divergence between the two means state
leaked. Suggested one-off check:

```bash
for f in tests/*.test.cjs; do node --require ./tests/helpers/test-env.cjs --test "$f" >/dev/null \
  || echo "FAILS ALONE: $f"; done
```

### Not in scope — deliberately

- **`/backend/db/*` RPC (14705–14958) stays in `index.cjs`.** It's the security
  core, it's 4 routes, and it already delegates to `shared/backend-core.cjs`.
  Splitting it buys nothing and risks everything.
- **Auth, RBAC, token verification stay put.** A second implementation of auth is
  how the Netlify mirror shipped unauthenticated the first time.
- **`ensureRuntimeSchema` stays put.** It's the runtime half of the three-place
  schema rule; moving it would make that rule harder to follow, not easier.

---

## Sequencing and cost

| Wave | Work | Days | Risk |
|---|---|---:|---|
| 0 | `coreDeps()`, retrofit the two existing mounts | 0.5 | none |
| 1 | 6 stateless leaf modules (~940 lines) | 2 | very low |
| 2 | 16 contiguous route modules (~2,600 lines) | 4 | low |
| 3 | 3 fat single routes (~630 lines) | 1.5 | low |
| 4 | 5 stateful cores (~2,500 lines) | 4 | **medium** |
| | **Total** | **12** | |

Waves 0–3 (8 days) take `index.cjs` from 15,737 to roughly **7,500** with
essentially no risk. Wave 4 is where judgement is needed and where it's fine to
stop if the return has flattened.

Add **(b) from the assessment — `checkJs` + JSDoc types on `shared/backend-core.cjs`
and the parity-crossing modules — 4–8 days**, done after Wave 1 when the seams are
visible. Total 16–20 days versus 38–69 for NestJS, for most of the same benefit.

---

## Rules for whoever does this

1. **One module per commit.** `npm run ci` green before the next one. Every commit
   is independently revertible.
2. **Move code, don't improve it.** No renames, no signature changes, no "while I'm
   here". A diff that is provably pure motion is reviewable; one that isn't, isn't.
   Improvements are a separate pass afterwards.
3. **Inject `getDb`, never `db`.**
4. **`__test` re-exports everything moved.** Tests change in a later, separate pass.
5. **Security-critical module → `MUST_BE_LINTED`** in `tests/lint-coverage.test.cjs`,
   same commit. eslint reports nothing for a file it doesn't match, so "green" and
   "never looked" are indistinguishable.
6. **Netlify parity:** if a route exists on both backends, the parity test runs in
   the same commit. Extracting on Fly must not change what Netlify answers.
7. **Deploy target:** every wave touches `server/index.cjs`, so every wave needs
   `fly deploy` — not Netlify, not a daemon restart. Confirm `git rev-parse HEAD`
   matches pushed `main` afterwards, and read the Fly logs.
8. **Work in a git worktree**, not the shared checkout — a background process
   auto-commits and pushes from it.

## Verification, end to end

```bash
npm run ci                                    # typecheck + both suites + smoke + lint
node --check server/index.cjs
wc -l server/index.cjs                        # should fall every wave
grep -cE "^\s*app\.(get|post|put|patch|delete)\(" server/index.cjs   # 127, unchanged
npm test 2>&1 | tail -5                       # test COUNT must not drop — a skip is a regression
```

After each wave, confirm on the deployed backend, not just locally: `/backend/health`,
one route from each extracted module, and one open WebSocket that receives a
realtime update. Mocked-DB tests cannot catch a column or route that doesn't exist
in production — that failure has happened in this repo before.
