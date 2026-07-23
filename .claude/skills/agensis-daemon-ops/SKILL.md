---
name: agensis-daemon-ops
description: Operating rules for agents working on the agensis repo as a background daemon or long-running loop, where several agents share one checkout and commits may be auto-pushed. Use this before editing any file in this repo, before committing or pushing, when the working tree has changes you did not make, when a human shares a screenshot or uploaded image, and when reporting what you did or did not verify. Covers worktree isolation, avoiding collisions with other agent loops, finding chat-uploaded images on disk, and reporting verification gaps honestly instead of claiming a UI change looks right.
---

# Working this repo as a daemon

`AGENTS.md` in the repo root covers the codebase itself — architecture, the
three-places schema rule, tests, deploy targets. Read it for anything about the
code. This skill covers the part it doesn't: you are one of several agents
operating on a shared checkout, often with no human watching in real time.

## Work in a worktree, not the shared checkout

Multiple agent loops edit `/Users/jkneen/Documents/GitHub/agensis` at the same
time, and `main` moves underneath you mid-session. Two concrete consequences:

- If your commit step stages broadly, you will sweep up **another agent's
  uncommitted work** and push it under your commit message. That work then
  ships unreviewed and is attributed to your change.
- A human reviewing your branch can't tell your diff from the noise around it.

So branch into a worktree first:

```bash
cd /Users/jkneen/Documents/GitHub/agensis
git worktree add .claude/worktrees/<short-name> -b worktree-<short-name>
```

That matches the existing convention (`.claude/worktrees/agents-list-icons` on
branch `worktree-agents-list-icons`). Do all edits, builds, and tests inside the
worktree. The shared checkout stays untouched, so whatever the other loops have
in flight survives.

Name the branch after **what the change does**, and make the first commit
message describe the actual diff. Branch names here have drifted from their
contents before, which makes later status checks unreliable — see the
`check-already-shipped` skill.

If the shared checkout has modifications you didn't make, leave them alone and
mention them in your report. They belong to another loop or to the human.

## Chat-uploaded images are on disk — look before saying you can't see

When a human shares a screenshot, the message may reach you as a bare filename
like `image.png (Uploaded file)` with no path and no image data. That is not
proof you can't see it. Uploaded and downloaded images land in `~/Downloads`.

```bash
ls -t ~/Downloads/*.png ~/Downloads/*.jpg 2>/dev/null | head -5
```

Take the most recent file matching the name or timestamp and read it directly.

macOS screenshots often carry HEIC data inside a `.png` extension, so if the
read fails, convert first rather than concluding it's unreadable:

```bash
sips -s format png <input> --out /tmp/shot.png
```

Only say you can't see an image after that lookup comes back empty — and then
ask for a path, since telling a human you're blind when the file is sitting in
`~/Downloads` costs a round trip for nothing.

## Report the verification gap, don't paper over it

You have no browser and your branch isn't deployed, so you cannot confirm how
anything looks in the running app. `npm run typecheck`, `npm test`,
`npm run test:unit`, and `npm run build` prove the code compiles and the logic
holds — they prove nothing about spacing, contrast, or whether a popover still
clips.

State both halves. What you verified, with the actual result; and what you
couldn't, with the reason:

> `typecheck` 0 errors, unit suite green (paste the real counts), build clean.
> Not eyeballed live — headless, branch not deployed. The 8px gap above the
> pill is a looks-right call you'll need to confirm.

Quote the counts the run actually printed. Numbers recalled from an earlier
session drift as tests are added, and a stale figure reads as a fresh
measurement.

This matters more than it sounds. A UI change reported as "done and verified"
sends the human off to other work; the same change reported with its gap named
gets a ten-second glance that catches the problem. Overstating verification is
the fastest way to lose the value of everything else you report.

## Before you say it's live

Frontend and backend ship separately — `AGENTS.md` § *Deploy targets* has the
split. The one that catches people: schema changes written as idempotent DDL in
`ensureRuntimeSchema` do not exist in the database until `fly deploy` runs, so a
merged backend branch can be fully green and still inert in production. Say
which deploy a change is waiting on rather than calling a merge "shipped".
