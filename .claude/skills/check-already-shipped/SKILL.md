---
name: check-already-shipped
description: Verify whether work already exists on main BEFORE reporting status, starting a task, or telling a human something is blocked on them. Use this whenever you are about to say a branch is "waiting to merge", "ready for review", or "blocked on your word"; whenever you pick up a task from the board or a task-comment @mention; whenever someone asks "is this done?", "did you already do this?", "what's the status?", or "what are you working on"; and before estimating or planning any feature in this repo. This repo has 35+ merged branches and 19 worktrees whose names do not reliably describe their contents, so trusting a branch name or your own memory produces confidently wrong status reports.
---

# Check whether it already shipped

Status reports in this repo go wrong in one specific direction: claiming work is
pending when it already landed. That wastes a human's attention on a decision
that no longer exists, and it makes them stop trusting every other status line
you write. Both failure modes below have actually happened here.

**Failure 1 — reporting merged branches as blocked.** Three branches were
reported as "built, green, waiting on your word to merge." All three were
already in `main`. Nothing had been blocked on the human for days.

**Failure 2 — trusting the branch name.** Branch `worktree-auto-subthread`
contains commit `3f16dec` "Update ChatWindowContent.tsx" — a one-line
`defaultOpen={false}` files-collapse fix. It has nothing to do with
auto-subthreading. Reading the name instead of the diff produces the exact
opposite of the truth in both directions: work you think is pending is done, and
work you think is done was never started.

Your own memory of "I built this and it's waiting" is the least reliable source
here, because several agent loops commit to this repo concurrently and `main`
moves underneath you mid-session. Check git, not recall.

## The check

Run these before you write a status line. They're fast and they answer
different questions, so run them together.

```bash
cd /Users/jkneen/Documents/GitHub/agensis
git fetch origin --quiet                      # main may have moved under you
git branch --no-merged main --format='%(refname:short)'   # the ONLY real backlog
git merge-base --is-ancestor <branch> main && echo MERGED || echo unmerged
```

`git branch --no-merged main` is the load-bearing one. Anything absent from that
list is already shipped, whatever you remember about it. Everything present is
genuinely outstanding.

## Then confirm by content, not by name

A branch being unmerged doesn't prove the feature is missing — someone may have
implemented the same thing directly on `main`, which is how two of the three
"new" tasks turned out to be already done. Grep `main` for the behaviour itself:

```bash
git grep -n "<distinctive symbol or string>" main -- <likely/path>
git log --oneline -8 main -- <likely/path>
```

Pick a symbol that only exists if the feature exists — a prop, a function name,
a column name. Searching for a generic word like "collapse" will match unrelated
code and give you a false positive.

## What to report

State the evidence, not the impression. Compare:

- Weak: "I think the icons branch is still waiting to merge."
- Strong: "`worktree-agents-list-icons` is already in `main` (`git merge-base
  --is-ancestor` → merged); nothing is blocked on you. The only unmerged branch
  is `worktree-mesh-visual-polish`."

When the check contradicts something you said earlier in the conversation, say
so plainly and correct it. A human who catches the error before you do — "are
you sure they have not been done already?" — has to re-verify everything else
you claimed, which costs far more than the correction would have.

If a task turns out to be already shipped, say which commit shipped it and
recommend closing it on the board, rather than silently starting the work again.

## Where this doesn't apply

Skip the check for pure conversation, or when you're mid-task on code you have
open right now and already know the state of. It's aimed at status claims and
task pickup — the moments where you're reporting on work that happened outside
your current context.
