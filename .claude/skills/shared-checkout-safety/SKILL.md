---
name: shared-checkout-safety
description: Concrete moves for the moment you discover another process is live-editing the same repo you are — a second Coder daemon/loop attached to the same workspace, or the background auto-commit+push hook. Use this when a file you didn't touch shows unexpected diffs, when the Edit tool warns "file modified on disk since you last read it", when a commit appears that you didn't make, when a file won't compile from changes you didn't write, or before claiming you control whether/when something gets pushed to origin/main.
---

# When you're not the only writer

This repo has two sources of concurrent writes that aren't you, and both have
already caused real damage in past sessions:

1. **A background process auto-commits staged changes and auto-pushes to
   `origin/main`.** Running `git add` alone (not `git commit`) has been
   observed to result in a commit with an auto-generated message appearing
   and landing on the real remote within seconds — verified via
   `git ls-remote`, not assumed. See [[repo-auto-commit-push]].

2. **A second Coder daemon/loop can be attached to the same workspace agent
   at the same time**, sharing the same working tree. One has been observed
   live-editing files another session was simultaneously touching, and
   repeatedly overwriting the agent's own `~/.agensis/<ws>/<agent>/status.json`
   with unrelated task notes. See [[concurrent-coder-daemon-hazard]].

## Before and during edits to a shared file

Run `git diff <file>` before you edit anything you didn't just create, and
again if something looks off mid-session. This tells you whether someone
else's uncommitted change is already sitting in that file.

**If a file references an undefined symbol, won't compile, or otherwise
looks broken from changes you didn't make** — that is very likely another
process mid-write, not a bug for you to fix. Do not "fix" or overwrite it:

- Do not revert it to what you think it should be.
- Do not complete what looks like an unfinished edit on their behalf.
- Leave files the other process is actively touching alone; keep your own
  work confined to files it isn't in.
- If you already made an edit to a file that turns out to be contested,
  revert *your* edit rather than fighting over the file.
- Surface the collision plainly in your report rather than staying silent
  about it or claiming you "fixed" something you didn't understand.

This is the same "never silently revert or overwrite another writer's
uncommitted work" rule `agensis-daemon-ops` states for the general worktree
case — this skill is the harder case where you didn't choose to share the
checkout and can't tell from a branch name that you are.

## `status.json` is best-effort, not yours alone

If you write your own status to `~/.agensis/<ws>/<agent>/status.json`,
expect a second loop to overwrite it with different content on its own
schedule. Treat it as advisory/best-effort — write once per update, don't
retry-loop to "win" the file, and don't treat its current contents as
authoritative evidence of what you were doing.

## Before claiming you control a push

"I haven't pushed" or "this is only local" is not automatically true here —
staging alone can trigger the auto-commit+push hook. If a human says "don't
push" or "I'll push this", say plainly that staging may push it anyway
rather than promising control you don't have. Verify actual remote state
read-only, don't just trust your own git history:

```bash
git ls-remote origin -h refs/heads/main
git log origin/main..HEAD          # empty means everything is already on the remote
```

## What to report

Weak: silence about a collision, or "fixed a syntax error" for code you
didn't recognize as someone else's in-progress edit.
Strong: "`Sidebar.tsx` had an unrelated in-flight edit from another process
(undefined `AgentConnectDialog` ref) — left it alone, kept my changes to
`AgentsWindowContent.tsx` only. Flagging in case that's a live collision."

## Related

- `agensis-daemon-ops` — worktree isolation as the primary defense; this
  skill is what to do when isolation wasn't enough or wasn't possible.
- `deploy-targets` — the auto-push hook means "not pushed yet" is often
  wrong; check remote state the same way before claiming a deploy target
  hasn't been reached.
