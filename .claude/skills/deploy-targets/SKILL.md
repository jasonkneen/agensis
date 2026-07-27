---
name: deploy-targets
description: Figure out which of the three separate deploy/restart mechanisms a change actually needs before calling it "live" or "shipped" — Netlify auto-deploy (frontend, src/**), an explicit `fly deploy` (backend, server/index.cjs + server/mcp.cjs + DB schema DDL), or a local daemon restart (agent/agensis-cli, the process running THIS session). Use this before writing "shipped", "live", "deployed", or "will pick this up on next restart" in any status report, after merging a branch, and whenever a change touches server/index.cjs, server/mcp.cjs, ensureRuntimeSchema, or agent/agensis-cli. Getting this wrong is the single most repeated mistake in this repo's history — at least six shipped features were reported done while still inert because the wrong (or no) deploy step had run.
---

# Which deploy target does this change need?

A merged, typechecked, green-tests branch in this repo is not "live" until the
right one of three *independent* mechanisms has run. They don't overlap and
none of them implies another. Confusing them is how "backend+tests done" gets
reported as shipped while the feature is still inert in production — this has
happened repeatedly ([[thread-widget-rail-feature]], [[agent-state-files-feature]],
[[comment-mention-dm-dispatch]], [[thread-split-merge-feature]],
[[heartbeat-capability-drift-sync]]).

## The three targets

1. **Frontend — Netlify, auto-deploys on push to `origin/main`.**
   Anything under `src/**`, `index.html`, `vite.config.ts`. No manual step —
   pushing to `origin/main` is the deploy. But "pushed" is not "built and
   live yet"; Netlify still takes a build cycle.

2. **Backend — Fly, needs an explicit `fly deploy`.**
   `server/index.cjs`, `server/mcp.cjs`, and — the one that catches people —
   **DB schema changes written as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE`
   inside `ensureRuntimeSchema()`**. That DDL runs when the Fly process boots,
   not when you merge or push. `fly.toml` app = `agensis-backend`, region `fra`.
   A merged backend branch can be fully green locally and still completely
   inert in production until someone runs `fly deploy`.

3. **Local daemon — needs a manual restart of the daemon process, not a deploy at all.**
   `agent/agensis-cli/**` (`agensis.mjs`, `state.mjs`, capability/memory sync,
   `buildPrompt()`) is the code running the *local* Coder/agent process itself
   — the one you may be running as right now. It isn't served by Netlify or
   Fly. New code there only takes effect once the daemon process is stopped
   and reconnected; there is no auto-deploy for it at all.

## The trap: these are not substitutes for each other

- A local daemon restart does **not** apply backend DDL — the schema lives on
  Fly's Postgres/Neon connection, reached only through `server/index.cjs`
  running on Fly. [[thread-split-merge-feature]] got this exactly backwards:
  "a local daemon restart does NOT land columns."
- A `fly deploy` does **not** update the frontend, and pushing frontend code
  does **not** touch the backend.
- Restarting your own daemon does **not** make a backend or frontend change
  live for the human — it only affects what *this* agent process sees.

## What to check before claiming "live"

- Which paths did the diff touch? Match against the three targets above —
  a single feature (e.g. thread widgets: new table + new component) often
  needs **two** of the three simultaneously.
- For frontend: has it actually reached Netlify? `git log origin/main..HEAD`
  should be empty if you believe it's pushed (see [[repo-auto-commit-push]]
  for why "I haven't pushed" can still be wrong).
- For backend: don't infer from `node --check` or local `npm test` that
  production behaves differently — those only prove the code parses/passes
  locally. State plainly that a **`fly deploy`** is the missing step, and
  that you likely can't run it yourself (confirm access before promising it).
- For local daemon: if you edited `agent/agensis-cli/**`, say so explicitly —
  "needs a daemon restart to pick this code up" — rather than letting the
  human assume it's already active in this very session.

## What to report

Weak: "Backend+tests done." (leaves target implicit — reads as shipped)
Strong: "Code merged and unit-tested locally. Needs `fly deploy` before the
new column/endpoint exists in production — nothing has run that yet."

State the target by name, not just "needs a restart" or "needs a deploy" —
say *which* of the three, since guessing wrong here is what caused this
skill to exist.

## Related

- `agensis-daemon-ops` — worktree isolation and the same Fly-deploy warning
  in brief; this skill is the fuller version with the third (local daemon)
  target added.
- `check-already-shipped` — checks whether code *merged*; this skill checks
  whether merged code is actually *running* anywhere a human can see it.
