# Enterprise overhaul reboot handoff

Snapshot: 2026-08-01 (latest live verification). Nothing has been merged, reset, pushed, or deployed. Preserve every dirty worktree.

## Plain answer

This is **not complete** and is not ready to call enterprise-grade or deploy. The integration branch is still a staging point; controller/resources and message-integrity contain uncommitted work, and ACP still has a known CLI parser blocker. No browser/visual end-to-end pass has been proven.

The controller lane was resumed after reboot and now includes registration intent fields (`purpose`/`resource_facets`), transactional approval, generic-write protection for `workspace_agents.controller_id`, composite tenant-lineage constraints, safe connect-command projection/audit attribution, workspace requesters, and lease renewal. Those changes are still uncommitted.

Latest verification (2026-08-01): controller/resource syntax and `git diff --check` pass; the focused controller/resource/MCP/connect safety suite is **51 passing, 1 optional PostgreSQL test skipped, 0 failing**. This is not a full application or browser pass. The controller worktree remains dirty and uncommitted.

## Branches and worktrees

- Main: `enterprise-overhaul-2026-07-31` at `260286e` (`fix(nostr): mirror invite preview on Netlify`). Existing dirty files: `docs/enterprise-overhaul-audit-2026-07-31.md`, `public/release-notes.json`, `status.md`.
- Integration: `.worktrees/enterprise-integration`, `enterprise-integration-2026-07-31` at `55ebd943`, clean before this handoff. Foundation work is integrated here.
- Controller/resources: `.worktrees/controller-resources`, `enterprise-controller-resources` at `55ebd943`, large substantive uncommitted diff. Read its `WORKTREE_NOTES.md`. Do not reset or clean.
- Message integrity: `.worktrees/message-integrity`, `enterprise-message-integrity` at `eff5f069`, large substantive uncommitted diff. Read its `WORKTREE_NOTES.md`. Do not reset or clean.
- Daemon/ACP: `/Users/jkneen/Documents/GitHub/agensis-agent/.worktrees/enterprise-service`, `enterprise-supervisor-service-2026-07-31` at `aba6859`; supervisor commits are saved, ACP work is substantive and uncommitted. Read its `WORKTREE_NOTES.md`.

## Current outcome

- Concrete hosted 404: the Nostr community modal called `POST /backend/nostr-communities/preview`, but the Netlify mirror had no route. Main now contains commit `260286e`, which adds the authenticated Netlify preview route and parity coverage. The hosted URL will remain 404 until that commit is deployed; this local fix does not deploy Fly or Netlify.
- Unified `/join/<token>` human, agent, and workspace-controller flow is substantially implemented.
- Controller/resource schema, Fly routes, MCP tools, Netlify resource mirror, Resources UI, controller ownership, resource operations, fencing, auditing, and tests are present.
- Join redemption was hardened: the link is consumed in an outer transaction and provisioning runs in a savepoint, preventing orphan identities while keeping a failed one-time link spent. Focused controller/resource suite: 149 pass, 1 optional PostgreSQL test skipped.
- Message-integrity lane contains extensive chat/subthread/private-session/realtime/offline/read-receipt hardening. Latest permission revoke race and canonical session-close fanout fixes are present and focused tests pass.
- Daemon supervisor work is committed. ACP integration is largely implemented against verified `@agentclientprotocol/sdk@1.3.0`; focused ACP tests pass 42/42 and unit tests pass 129/129.

## Stop-ship work remaining

Controller/resources (implemented but still uncommitted unless marked otherwise):

1. Registration intent, transactional approval, lease renewal, requester `RESTRICT` semantics, tenant-lineage FKs, safe controller connect responses, audit attribution, workspace requesters, and removal of inert `placements:request` are implemented and covered by the latest focused suite.
2. Netlify still lacks complete join/redemption/controller route parity; hosted clean invite URLs require the updated Fly backend to be deployed. Local Vite `/join` proxy is now present.
3. Resources UI still needs the stale-operation, launcher, role-control, polling, and state/visual fixes reviewed in the worktree notes.
4. No real browser/visual end-to-end pass has been proven.

Message integrity:

1. Deterministic offline routing is now implemented: queued sends persist `agent`, `direct_ai`, or `post_only`, capture model/participant/reply ids, preserve an agent-to-direct-AI fallback, and sub-thread sends explicitly persist the agent lane. Replay is idempotent, consumes the persisted AI stream, and fails closed on an absent/error stream.
2. Verified on 2026-08-01: offline intent/replay Vitest **11/11**, frontend unit suite **2,774/2,774**, `npm run typecheck` pass, production `npm run build` pass, segmented-agent plus source-hygiene Node tests **25/25**. Route tests that bind `127.0.0.1` remain blocked by sandbox `listen EPERM`; the Fly canonical session-closure test still needs a host with loopback permission.
3. The lane is still uncommitted. Do not treat the passing local gates as a merged/deployed result.

ACP:

1. CLI parser rejects normal `--acp-arg --stdio` and `--acp-arg=--stdio`; fix and add a real CLI parser/spawn test before committing.
2. Add daemon-level ACP routing/result and cancel/restart tests, then run `npm ci && npm run verify` and packed-artifact smoke.

## Resume order

1. Read this file and all three `WORKTREE_NOTES.md` files.
2. Commit the verified controller/resource worktree (the current sandbox denied linked-worktree index/object writes).
3. Commit the verified message-integrity worktree (same Git write boundary here).
4. Fix ACP CLI parsing, run its gates, and commit the daemon worktree.
5. Merge committed lanes into `enterprise-integration-2026-07-31` without resetting any worktree; resolve overlaps there.
6. Run full CI, production build, real browser chat/subthread/button/visual testing, and route-manifest smoke.
7. Deploy Fly before Netlify. The hosted Buzz/community and new join endpoints can continue returning 404 until the current Fly backend is deployed.
