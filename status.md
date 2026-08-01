# Enterprise overhaul reboot handoff

Snapshot: 2026-08-01. The release is committed on `main` and deployed. Do not reset, clean, rebase, or discard the historical worktrees below.

## Current uncommitted follow-up (2026-08-01 13:45 BST)

The checkout is on `main` at `054b9d1`, with the stewarded-resource workflow
implementation intentionally uncommitted and not pushed. The pre-existing
`deno.lock` edit is preserved unchanged. This follow-up adds:

- bounded dependency-ordered operation steps (`steps`, `dependsOn`, `stopOnError`)
  to the shared resource-operation contract and MCP request tool;
- a lease-bound `report_resource_operation_progress` MCP tool that persists
  sequence-numbered, credential-free checkpoints and renews the active lease;
- an operation-scoped realtime channel authorized through the existing resource
  viewer policy, with polling retained as the reconnect fallback;
- live/last-checkpoint rendering in the Resources window and a steward seed
  message that explicitly reads the operation plan before using normal tools;
- runtime, canonical, and forward migration schema parity for progress fields;
- focused contract, service, dispatch, realtime, MCP, and schema tests plus a
  release note/gallery slide.

Guarantee: concurrent `apply`/`publish` operations are still fenced by the
resource row lock, captured resource version, lease version, and compare-and-set
settlement. A stale operation becomes terminally failed before it advances the
resource; no server-authoritative version can be silently overwritten.

Verification for this follow-up:

- `npm run typecheck` passed;
- `npm run build` passed (existing Vite `__dirname` and large-chunk warnings);
- `npm run test:unit` passed: 2,828 tests across 202 files;
- `npm run smoke` passed: 19 tests across 2 files;
- focused resource/MCP/realtime/dispatch/schema tests passed (with only the
  optional PostgreSQL lock test skipped when no test database is configured);
- `git diff --check` passed.

`npm run ci` is not green because the existing Node suite still reports 24
unrelated session/huddle/message/schedule/source-hygiene failures; it reaches
2,481 passing and 24 failing tests before lint. Full lint also retains the
pre-existing generated Netlify edge-function `no-var` errors. No deployment or
push was performed for this follow-up.

## Current release (2026-08-01 12:52)

The application release is `c096ebd` (`Pin Nostr runtime to
CommonJS-compatible release`); the final handoff snapshot is `96bee3d`, and
both are pushed on `main`/`origin/main`. Neon migration tracking is current through
`20260801090000_workspace_resources_soft_delete.sql`.

- Fly backend: release **v156**, healthy at `https://agensis-backend.fly.dev`
  from image `deployment-01KYYJXKDK1TWFHE49W83H4P88`.
- Netlify production: live at `https://agensis.io`; the automatic main deploy
  for `c096ebd` is `6a6ddd4cf7097d0008f774eb` (the final manual packaging
  deploy was `6a6ddd51bb695706dfd5421b`). The handoff-only `96bee3d` build is
  also ready as deploy `6a6dddfaa0a42c0008742f65`.
- The `requestText` resource-operation contract is now present in the
  deployed frontend, Fly backend, and Netlify function mirror. The production
  lazy resource chunk contains the plain-language `requestText` field and
  “Ask the steward” surface.
- Coordinated live checks returned HTTP 200 from both Fly and the same-origin
  Netlify `/backend/health` route. The unauthenticated resource-operation
  contract returned the expected HTTP 401 JSON response rather than a 404,
  502, or unsupported-field error.
- The same HTTP 401 contract was checked independently against Fly v156, so
  the two backends agree on the request shape and authentication boundary.
- Netlify’s mirror now statically imports the shared Nostr adapter and pins
  `nostr-tools` to the CommonJS-compatible `2.20.0` release. This keeps the
  Fly CJS runtime and Netlify’s Node 22 function on the same loadable crypto
  dependency graph.
- The migration runner initially found an existing-data edge case in the
  agent read-receipt transition. The migration now skips its temporary
  session-wide index when the newer thread-scoped shape is already present;
  the production migration completed successfully after that fix.
- Release checks: typecheck, production build, resource/MCP matrix (**162
  pass, 1 optional PostgreSQL lock skip**), read-receipt/migration matrix
  (**30/30**), and `git diff --check` passed.

## Resource relay follow-up (2026-08-01 12:15)

The live checkout was `main` at `1ff006e` (the earlier `pre-main` handoff
below is historical). The resource relay and soft-delete follow-up is now
committed in the release above. Resource requests now use the steward/agensis proxy boundary:
the UI accepts plain-language work, the server stores a bounded request
artifact, and the steward runs it with its ordinary built-in tools or connected
agent CLI. Per-resource names such as `infinity_read` are no longer presented.

Shared resources now have manager-only soft delete and restore. Deleted rows
are excluded from normal reads, queued work is cancelled, live claims block the
delete, operation history remains retained and is visible in the recovery view,
and delete/restore are audited. Runtime DDL, canonical schema, and the new
forward migration all carry `deleted_at` and its index; Fly, Netlify, HTTP, MCP,
and the resource window use the same service.

Focused verification: **163 passing, 1 optional PostgreSQL lock test skipped**
across the MCP/resource/schema/route/dispatch matrix; typecheck, production
build, focused ESLint, Vitest model/smoke, and `git diff --check` passed before
deployment. The full Node suite remains **2,472 passing / 24 failing** on
unrelated existing listener/session/message/schedule/source-hygiene tests; no
resource/MCP test is in that failure set. The current release details are
above.

The remainder of this file is the earlier reboot/handoff snapshot and is kept
for audit context; it is not the current branch or deployment state.

The enterprise overhaul is merged on `main` at `4235d6a`. This review is on
the local `pre-main` branch at `eb55dbe`, with the forwarding and
conflict-resolution follow-ups applied. No remote push has been performed; the
branch has no unmerged paths or conflict markers.

## Current answer

The local integration is materially further along, but it is not complete. The
pre-main checkout contains the integration baseline plus the
controller/resources and message-integrity lanes. The remaining release work
is documented below; no remote publication has been done.

## Branch/worktree cleanup

All local refs and attached worktrees were inspected against `pre-main`. No
remote branch was changed and nothing was pushed. Clean integrated or
patch-equivalent branches are candidates for removal: the old enterprise
feature/review refs, `chore/drop-visual-editor`, `chore/publish-fixes`,
`feat/agent-read-receipts`, `feat/cross-instance-fanout`,
`fix/channels-dm-threads-receipts`, `fix/connection-reliability`,
`fix/deploy-guard`, and the three clean UI worktree refs. Keep
`enterprise-overhaul-2026-07-31` as the audit/review anchor even though it is
fully merged.

Retain `docs/readme-rewrite`, `feat/docker`, and `enterprise-review-testing`
until their separate/unique commits receive an explicit decision. Preserve
the dirty worktrees `enterprise-controller-resources`,
`enterprise-message-integrity`, `feat/docker-port`,
`fix/agent-receipt-daemon-finalize`, and `worktree-huddle-voice-defaults`;
their uncommitted changes were not touched. `/private/tmp/dep2` is a missing,
detached worktree registration that can be pruned.

This sandbox rejects `.git` lock creation, so branch/worktree removal and
pruning could not be executed here. On a normal host, remove only clean
candidates and never use `--force` on a dirty worktree.

## Verified locally

- `npm run typecheck` passes after the final UI continuation.
- `npm run build` passes after the final UI continuation (Vite emits only the
  existing `__dirname`/large-chunk warnings).
- `npm run smoke`: **19/19 passing** after hardening `UsersWindowContent` to
  tolerate callers that have not loaded controller data yet (the Members
  surface previously crashed while evaluating the controller expiry effect).
  The gate now also mounts populated Resources, Thread, and Sub-thread surfaces.
- Nostr invite preview errors now distinguish a stale Agensis `/preview` route
  from a 404 returned by the remote community host; the settings unit suite
  covers both messages.
- The enterprise audit now reflects the integrated scoped-controller/resource
  lane instead of the earlier broad-credential design.
- `npm run lint` has **0 errors** and 27 remaining warnings; the high-confidence
  stale-closure warnings in the touched app surfaces were fixed in this
  continuation. The remaining warnings are primarily Fast Refresh export
  boundaries plus one unused server/test suppression.
- `npm run test:unit`: **2,827/2,827 passing (202 files)** after the latest
  thread-pagination, sidebar upload, document-control, desktop-chooser,
  icon-only accessibility, and participant-menu keyboard tests.
- Netlify parity/auth suite: **56/56 passing**.
- Netlify's explicit-backend mirror now forwards unified join preview,
  redemption, join-link management, workspace-controller list/revoke, legacy
  member/invite compatibility, live agent controls, audit reads, authored
  templates, and public webhook triggers to the canonical Fly service. It
  preserves query/Accept negotiation, bearer/body forwarding, CORS, and the
  join page's no-store/referrer security headers. The forwarding contract is
  covered by `tests/netlify-join-forwarding.test.cjs` (**9/9 passing**); Fly
  remains the only credential-minting, audit, live-daemon-control, and
  template-validation implementation.
- Controller/resources/MCP/connect suite: **80 passing, 1 optional PostgreSQL lock test skipped, 0 failing**.
- Expanded no-listener agent/template/controller/resource/MCP/Nostr suite:
  **201 passing, 1 optional PostgreSQL lock test skipped, 0 failing**.
- Realtime schedules/gateways path: **10/10 passing**.
- Runtime/canonical/migration schema parity and Netlify no-DDL checks: **5/5 passing**.
- All merged production JavaScript modules and remaining test files pass `node --check`; no conflict markers remain in the worktree.

Latest continuation verification (2026-08-01):

- Re-ran `npm run typecheck`, `npm run build`, `npm run test:unit` (**2,827/2,827 across 202 files**), `npm run smoke` (**19/19**), focused ESLint (0 errors), and `git diff --check`; all passed. The build still emits only the existing Vite `__dirname`/large-chunk warnings.
- Re-ran the focused session-lineage/security tests with Node's module-mock flag: **16/17 passed**. The only failure is the generic-route test blocked at `listen(127.0.0.1)` `EPERM`; the six Netlify lineage tests and all pure session-scope tests pass.
- Re-ran the combined no-listener security/parity/resource matrix with the required Node module-mock flag: **165 passing, 1 environment-blocked listener test, 2 optional PostgreSQL skips**. No application assertion failed.
- Added Fly and Netlify pre-transaction `sessionLineageKind` validation so a malformed request containing both parent forms is rejected before `BEGIN`, and updated the Netlify contract tests to the current query shape.
- Hardened `useWorkspaceKnowledge` against incomplete or malformed capability payloads; capability counts now fail closed to zero instead of crashing the shell, with a focused unit test.
- Fixed high-confidence React dependency hazards in presence window opening,
  thread-inbox refresh, document metadata/listener effects, agent manifest
  loading, workspace seeding, canvas applet message delivery, and reaction
  memoization. Re-ran typecheck, unit, smoke, build, lint, and diff checks after
  the changes.
- After the Netlify control-plane forwarding addition, the dedicated forwarding
  suite is **9/9 passing** and `git diff --check` remains clean. The matcher now
  covers all currently identified Fly-owned HTTP surfaces, including bootstrap,
  messages/access, huddles, gateways, skills, schedules, Nostr, permissions,
  files, project-git, TTS, bridge, Farm, link-preview, MCP skill, Flow,
  workspace-MCP, agent-registration, Agensis setup, and agent connection-
  command operations.
- Resolved two merge-resolution TypeScript errors (duplicate onboarding
  metadata and duplicate wireframe scene keys) and kept the release gallery to
  six highlights so it remains a highlight reel rather than a changelog.
- Closed three concrete UI interaction gaps: sidebar file upload now opens a
  real picker and calls `useFiles.uploadFiles`, ordinary thread panels expose
  the owning session's earlier-history pagination, and embedded sketch Clear
  plus desktop chooser cards have native/guarded keyboard behavior. Focused
  tests cover each path.
- Closed the participant-popover accessibility gap: informational rows are no
  longer Radix `DropdownMenuItem`s with nested buttons, so Remove controls stay
  in the normal keyboard tab order. Icon-only sub-thread close and automation
  delete controls also expose accessible names.
- Used the Playwright connector against a local Vite fixture with mocked backend responses. The rendered app opened a channel, displayed persisted channel history, opened the Sub-threads panel and a sub-thread, and opened a private/direct-message window with its history. This is browser/render evidence only; the backend was mocked, realtime had no local WS server, and it is not production E2E proof.
- At a 390x844 viewport the mobile drawer opened, the private chat filled the viewport, its composer remained reachable, and the Users window rendered the unified “Person or agent / Person only / Agent only / Workspace controller” invite selector plus controller copy. The same mocked-backend limitation applies.
- A user-supplied typography screenshot shows `Continue`/`Ask`, but that literal control is not present in this Agensis checkout. No blind global font-size change was made; the exact surface needs to be identified before changing typography.

The forwarding paths require `AGENSIS_DAEMON_BASE_URL` in a deployed Netlify
runtime. If it is absent, the function fails closed with a 503 for Fly-owned
controls rather than returning a misleading 404 or pretending a live operation
completed. This is a deployment/configuration gate, not local proof of hosted
parity.

The route suites that create loopback HTTP listeners (huddles, Fly/Netlify message routes, several invite/link-preview paths) cannot run in this sandbox because `listen(127.0.0.1)` is denied with `EPERM`. That is an environment limitation, not a passing end-to-end proof. A real host with loopback permission must run them.

The attempted real local stack boot confirmed the same boundary from a second
angle: the backend cannot bind `127.0.0.1:3142` here, and the configured Neon
hostname cannot resolve from this sandbox. No local server remained running
and no database-backed browser claim is being made.

The required `npm run ci` was started after reboot. Its typecheck, unit suite,
smoke gate, build, and lint components are green; the top-level Node route
runner cannot complete here because those listener-based tests fail at socket
creation (`EPERM`) and the process leaves later files pending. Do not treat
that as a full CI pass until it is rerun on a host with loopback permission.

## What is in the tree

- Unified short-lived, one-use `/join/<token>` redemption for human, agent, and workspace-controller intent.
- Scoped `agc_` controller credentials, controller-owned agents, resource purpose/facets (`context`, `knowledge`, `tooling`, `code`), dedicated resource service/routes/MCP/UI, Netlify mirror, fenced idempotent operations, lease renewal, audit attribution, and schema parity.
- Private-session/derived-session inheritance, message authorship and tombstone guards, deterministic offline routing/replay, read-receipt/session/realtime scoping, huddle transcript isolation, schedule/job access checks, and fanout allowlist coverage.
- Fly and Netlify session creation now validate the derived-session parent shape before starting the transaction, avoiding a needless transaction for an ambiguous request.
- Chat/subthread window rendering is typechecked and built; a local Playwright
  fixture has now exercised channel history, private history, and sub-thread
  panels, but real-backend browser/visual interaction remains unproven.
- The latest continuation also makes read-only shared chats genuinely readable:
  the body is no longer blanket-disabled, thread/sub-thread panels and earlier
  pagination are available, message mutations/composer are gated, and channel
  mutation actions are hidden. These changes are covered by the unit/smoke
  gates above but still need a real browser pass.
- The Members/People surface now renders safely before controller data arrives;
  the smoke fixture covers the populated-member path.
- The hosted community preview 404 has a local Netlify mirror fix in commit `260286e`, plus actionable UI diagnostics for stale backend versus remote-host 404s; the hosted service will remain 404 until Fly/Netlify deployments are updated. No deployment was performed here.
- The public `/join/*` Netlify rewrite still targets the configured Fly
  deployment in `netlify.toml`; update that rewrite together with
  `AGENSIS_DAEMON_BASE_URL` if the backend origin changes. No hosted deploy was
  performed here, so the reported public 404 remains unverified until release.
- The screenshot was taken on `localhost:5174`; with the current empty local
  backend override, `/backend/*` is proxied to `127.0.0.1:3142`. A 404 there
  means the process listening on 3142 is stale or not this checkout; the current
  source mounts the preview route. The hosted Fly route still needs deployment.
- The ACP blocker is now isolated to the sibling CLI parser: its `--acp-arg`
  branch rejects values beginning with `--` (including the required
  `--acp-arg --stdio` form). The correct one-line guard is known, but this
  session cannot persist edits outside the Agensis writable root; no sibling
  file was changed.

## Worktrees

- Root: branch `enterprise-overhaul-2026-07-31`, HEAD `60584a7`, dirty by design.
- `.worktrees/enterprise-integration`: `enterprise-integration-2026-07-31` at `55ebd943`, clean foundation.
- `.worktrees/controller-resources`: `enterprise-controller-resources` at `55ebd943`, substantive dirty lane; see its `WORKTREE_NOTES.md`.
- `.worktrees/message-integrity`: `enterprise-message-integrity` at `eff5f069`, substantive dirty lane; see its `WORKTREE_NOTES.md`.
- `../agensis-agent/.worktrees/enterprise-service`: supervisor work is committed; ACP work remains uncommitted and still has the CLI parser blocker for normal `--acp-arg --stdio` forms. This sibling is outside the writable root, so it was not edited here.

## Remaining stop-ship work

1. On a host that permits loopback, run the complete Node route suite and fix any genuine failures rather than treating `EPERM` as coverage.
2. Fix and test the ACP argument parser in the daemon sibling, then run its package/verification gates.
3. Run browser/visual acceptance for viewing chats, subthreads, buttons, invite redemption, controller/resource UI, and responsive layouts. Include the legacy member/invite, audit, template, agent-control, and webhook paths through an explicit Netlify backend.
4. Review the resulting diff, stage/commit the coherent lanes, and deploy Fly before Netlify. Recheck the hosted preview and join URLs after deployment.

### UI findings addressed in the latest continuation

- Shared read-only chat bodies now remain interactive for scrolling, selection,
  copying, and thread links; window-level controls remain gated
  (`FloatingWindowShell.tsx`, `tests/unit/chatWindowPersistence.test.ts`).
- The dead generic Duplicate item was removed because there is no safe generic
  duplicate semantic for a window.
- Resource operation detail polling now merges fresh operation status without
  losing artifact fields (`src/features/workspace-resources/model.ts`).
- Mobile chat switching now promotes the selected session/thread.
- The channel header scrolls horizontally on narrow windows instead of clipping
  controls; read-only channel menus no longer expose edit/add/connect/split or
  participant-removal mutations.
- Controller loading is included in the aggregate connection state and is shown
  in Members before the empty state.
- Sub-thread attachments are preserved as structured message attachments, and
  earlier sub-thread pagination is available.

### UI verification still required

- A real-backend browser/visual pass is still required for every header/window
  button, invite redemption, controller and resource flows, keyboard focus,
  responsive layouts, and visual regressions. The mocked local pass covered
  chat history, private history, and sub-thread rendering only.
- Read-only behavior has source/unit coverage, but browser-level assertions are
  still needed to prove rendered scrolling, selection, and side-panel behavior.

## Resume commands

```sh
cd /path/to/agensis
git status --short --branch
npm run typecheck
npm run build
npm run test:unit
node --require ./tests/helpers/test-env.cjs --test tests/netlify-parity.test.cjs tests/workspace-resources-service.test.cjs tests/schedules-gateways-realtime.test.cjs
```

The current state is recoverable: all substantive files are in the root or their named worktrees, and no destructive Git operation was run.
