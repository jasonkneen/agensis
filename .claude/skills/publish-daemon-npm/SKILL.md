---
name: publish-daemon-npm
description: Ship a daemon/CLI change all the way to npm yourself — bump, verify, push, publish `@agensis/agensis-agent`, and prove the published tarball contains the change. Use this whenever you edit anything under the agensis-agent repo (packages/agensis-cli/**), whenever you are about to say "needs a version bump and publish", "you'll need to publish this", "run npm publish when you're ready", or "not live until it's published", and whenever Jason says push/ship/publish/release the agent or daemon. YOU do the publish. Jason does not want to be handed a checklist of npm commands to run himself — being told to publish his own fix is a repeated complaint, not a safety measure.
---

# Publishing the daemon to npm

**You run the publish. Not Jason.** Stopping at "the fix is committed, you'll
need to bump and publish" is the failure this skill exists to prevent. He has
pushed back on it more than once. A daemon fix that is committed but unpublished
helps nobody: every remote daemon and every other machine still runs the old
bundle.

Only stop short of publishing if he explicitly said "don't publish yet" or
"just commit it". Otherwise "fix this" includes shipping it.

## The repo is NOT this one

The daemon lives in its own repo:

    /Users/jkneen/Documents/GitHub/agensis-agent   →  jasonkneen/agensis-agent

- `packages/agensis-cli/` — readable source, what you edit.
- `packages/agensis-agent/` — the single minified bundle that gets published,
  produced by `packages/agensis-agent/build.mjs`. **Never hand-edit it.**

Older notes describing `agent/agensis-cli/` inside the agensis repo are stale —
that path no longer exists.

`~/.bun/bin/agensis` is a **symlink into `packages/agensis-cli/bin/`**, so
Jason's own local daemon runs the readable source and picks up a change on
restart alone. Every *other* daemon runs the published bundle and needs the
publish. Both facts are true at once; don't let the symlink talk you out of
publishing.

## Procedure

Run everything from inside `/Users/jkneen/Documents/GitHub/agensis-agent`.

### 1. Bump the version in eight places

`scripts/check-version.mjs` enforces all eight — don't try to remember them,
just bump and run it until it passes:

    npm run version:check

The eight: root `package.json`, `packages/agensis-cli/package.json`,
`packages/agensis-agent/package.json`, three `package-lock.json` workspace
entries (`""`, `packages/agensis-cli`, `packages/agensis-agent`),
`AGENSIS_CLI_VERSION` in `packages/agensis-cli/src/agensis.mjs`, and
`SOURCE_VERSION` in `packages/agensis-agent/build.mjs`.

Check the registry first — `npm view @agensis/agensis-agent version` — because
a past release has left the repo's own versions inconsistent, so the highest
number in the repo is not reliably the published one. Bump past whichever is
higher.

### 2. Gate

    npm run verify

= `version:check` → `check` → `npm test` → `test:unit` → `build` →
`artifact:smoke`. Run it **from inside the repo**: a worktree placed outside
with a symlinked `node_modules` fails at `build` with `ERR_MODULE_NOT_FOUND`,
which is the setup being wrong, not the code. (That once cost a bogus "I can't
run this" claim.)

`verify` runs `build`, which rewrites the committed bundle — so commit *after*
verify, and include `packages/agensis-agent/bin/agensis.mjs` in the commit.

### 3. Push, and merge to main

Push the branch, then fast-forward `main` and push that too. Jason wants the
work on `main`, not parked on a feature branch.

### 4. Publish

The token lives in the **agensis** repo's root `.env` (not this repo's). That
file has held two `NPM_ACCESS_TOKEN=` lines with the live one commented, and
which one works **has flipped**, so probe rather than trust a line number:

    T=$(sed -n '4p' .env | sed -E 's/^#?NPM_ACCESS_TOKEN=//' | tr -d '\r"'"'"' ')
    umask 077
    printf '//registry.npmjs.org/:_authToken=%s\n' "$T" > /tmp/.npmrc-probe
    npm whoami --userconfig /tmp/.npmrc-probe    # want: jasonkneen

Then:

    npm publish --workspace=@agensis/agensis-agent --userconfig /tmp/.npmrc-probe --access public

**Delete the temp file afterwards. Never write the token to `~/.npmrc`.**

### 5. Prove the artifact, don't trust the `+ pkg@version` line

Publishing is public and effectively irreversible, and npm printing
`+ @agensis/agensis-agent@x.y.z` proves a tarball moved — not that it contains
your change. The source can be right while the bundle is stale.

    npm pack @agensis/agensis-agent@<v>   # into a scratch dir, then untar

Grep the unpacked `package/bin/agensis.mjs` for the thing you actually changed.
It is minified, so resolve identifiers first (`allowedTools:wn` only means
something once you find `wn=["mcp__agensis"]`). **Always grep a control too** —
one string that must already be there and one that must not — otherwise a
zero hit is indistinguishable from a broken grep.

## Network: github.com DNS fails while npm works

macOS's system resolver intermittently negative-caches `github.com` on this
machine: `nslookup github.com 1.1.1.1` answers fine, but `git push` and `curl`
both die with `Could not resolve host: github.com` — while `registry.npmjs.org`
resolves normally. Flushing needs sudo, which isn't available. Work around it
per-command instead of concluding the network is down:

    IP=$(nslookup github.com 1.1.1.1 | awk '/^Address: /{print $2; exit}')
    git -c http.curloptResolve="github.com:443:$IP" push origin main

Bash tool calls that touch the network also need `dangerouslyDisableSandbox`.

## After publishing

State plainly which lanes are now live and which are not:

- **npm** — live the moment the tarball verifies.
- **Jason's local daemon** — still running the OLD code in memory until the
  process restarts. If the daemon process is the one running your session,
  say so and let him restart it; don't kill your own parent.
- **Remote daemons / other machines** — need `npm i -g @agensis/agensis-agent`
  plus a restart.

See also the `deploy-targets` skill: npm is a *fourth* lane alongside Netlify
(frontend), `fly deploy` (backend), and the daemon restart. Publishing does not
imply any of the other three.
