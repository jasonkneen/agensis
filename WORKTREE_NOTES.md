# Enterprise overhaul worktree handoff

Snapshot: 2026-08-01

- Active branch: `enterprise-overhaul-2026-07-31`.
- The root checkout is intentionally dirty and not deployed. Do not reset,
  clean, rebase, or discard changes.
- Git index writes are denied in this environment (`.git/index.lock:
  Operation not permitted`), so the root edits cannot be staged or committed
  here. The audit document may still appear as `UU` even though its worktree
  file has no conflict markers.
- See [`status.md`](status.md) for the verified gates, browser evidence, and
  remaining stop-ship work.
- Latest local gates include typecheck/build/smoke/lint, plus **2,814 unit
  tests across 198 files**; lint is 0 errors with 27 remaining structural
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
  permissions, files, and project-git forwarding.
- The latest UI hardening wires the Sidebar Upload files affordance to the real
  `useFiles.uploadFiles` picker, exposes earlier pagination inside ordinary
  thread panels, makes embedded sketch Clear a native keyboard button, and
  prevents nested desktop-card controls from triggering their parent launcher.
  Participant rows no longer nest a Remove button inside a Radix menuitem, and
  icon-only close/delete controls have accessible names.
- The supplied `Continue`/`Ask` typography crop does not match any literal
  Agensis control in this checkout (only the generated document `Ask` block is
  present); identify that surface before changing the global UI font scale.

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
