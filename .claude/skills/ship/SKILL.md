---
name: ship
description: Ship a change all the way to production yourself across all four lanes — Fly (backend), Netlify (frontend), npm (@agensis/agensis-agent daemon), and the local daemon restart. Use this the moment you are about to write "this needs a fly deploy", "someone will need to publish this", "I can't do npm", "that's outside what I can do", "this isn't deployed yet", or "will pick this up on next restart", and whenever Jason says ship / deploy / publish / release / push it live. You have working credentials for every lane; none of them belong to somebody else. Punting a deploy back to Jason is the single most repeated complaint in this project.
---

# Ship it — all four lanes, yourself

**You have credentials for every lane. There is no lane that is "someone
else's job".** Verified working from an agent session on 2026-07-29:

| Lane | Auth | Proven by |
|---|---|---|
| GitHub | `git push` over HTTPS | pushed `main` on both repos |
| Fly | `fly auth whoami` → `jason@bouncingfish.com` | `fly status`, `fly releases` on `agensis-backend` |
| Netlify | `netlify status` → project `open-hatch` → agensis.io | linked via `netlify.toml` |
| npm | token in the agensis repo's root `.env` | published `@agensis/agensis-agent@0.1.40` |

Sentences to never write again unless a command actually failed and you pasted
the error: *"this needs a fly deploy"*, *"you'll need to publish this"*, *"I
can't do npm"*, *"that's someone else's job"*, *"this isn't deployed"*. If a
change is worth making, ship it. If a lane genuinely fails, show the error
output — don't convert a failure into a handoff.

The only reasons to stop short: Jason said "don't deploy yet", or the change is
unverified (tests not run / not green). Being unsure whether it's wanted is not
one — ask *while* the rest ships, not instead of shipping.

## The four lanes

Work out which lanes a diff touches, then run **all** of them. A single feature
routinely needs two or three; see the `deploy-targets` skill for the full
"which lane does this path belong to" mapping and the traps.

### 1. Backend → Fly (`agensis-backend`, region fra)

Triggered by `server/**` — especially **DDL inside `ensureRuntimeSchema()`**,
which only runs when the Fly process boots. Merging does nothing.

    fly deploy                      # from the agensis repo root
    fly status  --app agensis-backend
    fly logs    --app agensis-backend | tail -50

`fly deploy` ships the **local directory**, not a git ref — so deploying from a
worktree puts code live with no git involved. Deploy from the repo root on the
branch you mean. Always check the logs after: a lagging Fly has hidden broken
SQL before.

### 2. Frontend → Netlify (`open-hatch` → agensis.io)

Triggered by `src/**`, `index.html`, `vite.config.ts`, `public/**`. **Pushing to
`origin/main` IS the deploy** — no manual step. But "pushed" ≠ "live"; Netlify
still needs a build cycle. Confirm rather than assume:

    netlify status
    netlify deploy --build --prod      # only if you must bypass the git trigger

### 3. Daemon → npm (`@agensis/agensis-agent`)

Triggered by anything in the **agensis-agent repo** (`packages/agensis-cli/**`).
Full procedure — 8-place bump, `npm run verify`, token probe, tarball proof — is
in the **`publish-daemon-npm`** skill. Follow it; don't improvise a publish.

### 4. Local daemon → restart

The daemon process running your own session. `~/.bun/bin/agensis` symlinks into
the agensis-agent checkout, so a restart alone picks up source changes.

**If the daemon is running your session, you cannot restart it — you'd kill
yourself mid-turn.** Say so plainly and let Jason do that one. That is the *only*
lane you legitimately hand back, and it is a two-second action, not a task.

## Order matters

**Fly → Netlify → npm → daemon restart.**

Backend first so new UI never calls a route that 404s, and the daemon last so it
never talks to a hub that hasn't got its columns yet. Shipping the daemon ahead
of the UI is what produced the buttonless-approval-card state once: daemons
raised requests the browser had no buttons to answer.

## Network: github.com DNS fails while npm/fly work

macOS negative-caches `github.com` on this machine — `nslookup github.com
1.1.1.1` answers fine but `git push` and `curl` both die with `Could not resolve
host`. Flushing needs sudo we don't have. Don't report this as "the network is
down":

    IP=$(nslookup github.com 1.1.1.1 | awk '/^Address: /{print $2; exit}')
    git -c http.curloptResolve="github.com:443:$IP" push origin main

Bash calls that touch the network also need `dangerouslyDisableSandbox: true`.

## Verify, then report per lane

A command printing a success line is not proof the thing is live. Per lane:

- **Fly** — `fly releases` shows a new version; then probe a route. An unauth
  POST returns **401 if it exists, 404 if it's missing** (control with a
  made-up path). `/backend/health` lies — it answers before routes are wired.
- **Netlify** — fetch `agensis.io/app`, pull an `/assets/*.js`, grep for a
  marker from your change, **and grep a control** that must already be there.
- **npm** — pack the published tarball back down and grep the minified bundle,
  with a present-control and an absent-control.
- **Daemon** — the restart is Jason's; say which version he'll be on after it.

Then state each lane's status explicitly. "Shipped" with no lane breakdown is
what caused six features to be reported done while still inert.
