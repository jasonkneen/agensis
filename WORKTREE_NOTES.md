# Enterprise overhaul worktree handoff

Snapshot: 2026-08-01

## Current follow-up: stewarded resource workflows (2026-08-01 14:05 BST)

Root is clean on `main` at `642f857`, pushed to `origin/main` and deployed to
Fly release **v157** (`deployment-01KYYPSPHNQCAZHGT0SSBCVF45`). The Fly health
check is passing. Keep the existing `deno.lock` change; it predates this
follow-up and is preserved in the deployed commit.

The implementation is in the root checkout, not the historical controller or
message-integrity worktrees. It adds dependency-checked operation plans,
lease-bound steward progress reports, an authorized
`resource-operation:<workspace>:<operation>` broadcast lane, UI checkpoint
rendering, schema parity/migration coverage, and focused tests. The resource
row lock plus captured version and lease fences remain the overwrite boundary:
the second stale `apply`/`publish` cannot advance the resource.

Checks completed: typecheck, production build, 2,828 frontend unit tests,
19 smoke tests, focused resource/MCP/dispatch/realtime/schema tests, and
`git diff --check`. The repository-wide Node suite remains at 2,481 passing /
24 pre-existing failures; `npm run ci` stops there, and full lint still has
the known generated Netlify edge-function `no-var` errors.

Current application release: `642f857` is pushed on `main`/`origin/main`, with
the final handoff snapshot at `96bee3d` and Neon current through the resource
soft-delete migration.
Fly release **v157** and the Netlify production deploy are live and healthy.
Fly is running image `deployment-01KYYPSPHNQCAZHGT0SSBCVF45`.
The automatic main deploy for this commit is
`6a6ddd4cf7097d0008f774eb`; the final manual function-packaging deploy was
`6a6ddd51bb695706dfd5421b`. The earlier
`pre-main` details below describe the reboot handoff before the merge and are
historical. See the current release section in `status.md` for verification
counts and deployment URLs.

The enterprise overhaul and resource follow-up are merged on `main`. The
historical `pre-main` details below are retained for audit context only. Do
not reset, clean, rebase, or discard the preserved worktrees.

- Historical active branch at the time of this handoff: `pre-main` (`eb55dbe`).
- The current root checkout is the deployed `main` release described above.
- Git metadata is shared with the other local worktrees; verify `git status`
  before staging any follow-up. The working tree is currently clean.
- See [`status.md`](status.md) for the verified gates, browser evidence, and
  remaining stop-ship work.
- Latest local gates include typecheck/build/smoke/lint, plus **2,824 unit
  tests across 202 files**; lint is 0 errors with 27 remaining structural
  warnings, and `git diff --check` is clean.
- The Playwright local fixture has exercised channel/private history, a
  sub-thread panel, the mobile drawer at 390px, and the Users invite/controller
  selector. It used mocked backend responses, so it is not hosted E2E proof.
- Netlify now forwards join/controller paths plus legacy member/invite flows,
  live agent controls, audit reads, authored templates, and public webhook
  triggers to the canonical Fly backend. Query strings, `Accept`, auth/body,
  CORS, and join security headers are preserved;
  `tests/netlify-join-forwarding.test.cjs` covers the contract (9/9), including
  bootstrap/messages/access, huddles, gateways, skills, schedules, Nostr,
  permissions, files, project-git, TTS, bridge, Farm, link-preview, MCP skill,
  Flow, workspace-MCP, agent-registration, and Agensis setup forwarding.
- The latest UI hardening wires the Sidebar Upload files affordance to the real
  `useFiles.uploadFiles` picker, exposes earlier pagination inside ordinary
  thread panels, makes embedded sketch Clear a native keyboard button, and
  prevents nested desktop-card controls from triggering their parent launcher.
  Participant rows no longer nest a Remove button inside a Radix menuitem, and
  icon-only close/delete controls have accessible names.
- The supplied `Continue`/`Ask` typography crop does not match any literal
  Agensis control in this checkout (only the generated document `Ask` block is
  present); identify that surface before changing the global UI font scale.

## Branch/worktree cleanup audit (2026-08-01)

All local refs and attached worktrees were inspected against `pre-main`; no
remote branch was changed and nothing was pushed.

- Clean, already integrated or patch-equivalent branches: `chore/drop-visual-editor`,
  `chore/publish-fixes`, `enterprise-agent-resource-taxonomy`,
  `enterprise-audit-documentation`, `enterprise-buzz-architecture`,
  `enterprise-conversation-foundation-2026-07-31`,
  `enterprise-generic-db-projections`, `enterprise-integration-2026-07-31`,
  `enterprise-legacy-invite-atomic`, `enterprise-netlify-no-ddl`,
  `enterprise-review-context`,
  `enterprise-review-size`, `enterprise-session-derived-scope`,
  `enterprise-uniform-batch-insert`, `feat/agent-read-receipts`,
  `feat/cross-instance-fanout`, `fix/channels-dm-threads-receipts`,
  `fix/connection-reliability`, `fix/deploy-guard`, and the three UI
  worktree branches. Their clean worktrees are candidates for local removal.
- Retain `enterprise-overhaul-2026-07-31` as the audit/review anchor even
  though it is fully merged.
- Retain for explicit review: `docs/readme-rewrite` and `feat/docker` have a
  separate four-commit history with Docker/README work; `enterprise-review-testing`
  has a unique permission-protocol commit that is not patch-equivalent and
  must not be deleted without a decision.
- Preserve untouched: `enterprise-controller-resources` (50 dirty paths),
  `enterprise-message-integrity` (155 dirty paths), `feat/docker-port` (8 dirty
  paths including Docker files), `fix/agent-receipt-daemon-finalize` (dirty
  `server/agent-jobs.cjs`), and `worktree-huddle-voice-defaults` (2 dirty
  files). The root `pre-main` edits are the active handoff changes.
- `/private/tmp/dep2` is already missing and is only a stale detached-worktree
  registration; it is safe to prune once Git metadata is writable.

This sandbox rejects `.git` lock creation (`Operation not permitted`), so
`git worktree remove`, `git branch -d`, and `git worktree prune` could not be
executed here. On a normal host, remove only the clean candidates above, then
prune the missing detached worktree; do not use `--force` on any dirty path.

## Resume first

```sh
cd /Users/jkneen/Documents/GitHub/agensis
git status --short --branch
npm run typecheck
npm run build
npm run test:unit
npm run smoke
```

## Worktree ownership

- `.worktrees/enterprise-integration` — clean integration foundation.
- `.worktrees/controller-resources` — controller/resource lane; read its
  `WORKTREE_NOTES.md` before touching it.
- `.worktrees/message-integrity` — message/session integrity lane; read its
  `WORKTREE_NOTES.md` before touching it.
- The sibling `../agensis-agent/.worktrees/enterprise-service` contains the
  supervisor work. Its ACP parser fix is still outside this writable root.

## Do not call complete yet

1. Run listener-based Node route tests on a host that permits loopback; this
   sandbox stops them at `listen(127.0.0.1)` `EPERM`.
2. Fix/test the sibling ACP `--acp-arg --stdio` parser.
3. Set `AGENSIS_DAEMON_BASE_URL` on the deployed Netlify function and run
   real-backend browser acceptance for invites, member access, audit, authored
   templates, live agent controls, webhooks, controller/resources, buttons,
   responsive layouts, and the hosted preview URL.
4. Review, stage, commit, deploy Fly then Netlify, and recheck hosted URLs.
