# `agensis-ops` — operator/CI client for the agensis MCP surface

**This is not an agent tool.** Agents running inside agensis already reach all 30
workspace tools over MCP — the daemon injects the MCP server into every coding
CLI it launches, so an agent doing a job today can already `list_channels`,
`read_channel`, `post_message` and `dispatch_agent` without this binary. Building
a CLI for *them* would be a second front door onto a house they are standing
inside.

This exists for the callers that have no MCP client: **humans at a shell, CI
jobs, and shell pipelines**. Before it, "post a build result into #releases from
CI" meant hand-rolling a JSON-RPC envelope with `fetch` and digging the payload
out of `result.content[0].text` — which is exactly what `scripts/_mcp_smoke.cjs`
is, 158 lines of it, written because there was no other way to drive the surface
from a shell.

## Running it

```sh
npm run ops -- whoami
npm run ops -- channels --limit 20
node cli/agensis-ops.mjs read <channel-id> --limit 100
```

There is **no npm publish lane and no global install**: this package is
`private: true`. Run it from a checkout. That is deliberate — see "Why it lives
here".

## Commands

```
agensis-ops whoami                          Which identity does this token authenticate as?
agensis-ops channels [--limit N]            List channels.
agensis-ops read <channel-id> [--limit N]   Read recent messages.
agensis-ops search <query>                  Search messages.
agensis-ops post <channel-id> <content>     Post a message.
agensis-ops dispatch <channel-id> <content> Post and wake the agents it addresses.
agensis-ops tasks                           List tasks.
agensis-ops agents                          List workspace agents.
agensis-ops tools                           Every tool this token can reach, with its arguments.
agensis-ops call <tool> [--arg value ...]   Call ANY tool. Arguments checked against its schema.
agensis-ops help
```

Global flags: `--json`, `--human`, `--raw`, `--quiet`, `--full-ids`,
`--profile <name>`, `--url <url>`, `--token <t>`, `--timeout-ms <n>`, and `--`
(everything after it is verbatim, so a message body may contain `--json`).

The eight verbs are sugar. `call` reaches all 30 tools, including any added
after this CLI was written — it builds its flag parser from the schema the
server publishes at runtime, so it has no independent knowledge of any tool.

## Auth — what a leaked credential grants

**No new credential type is introduced.** Every token accepted here is one the
MCP door already accepts (`verifyMcpToken`, `server/index.cjs`), and the only
store read is the daemon's existing 0600 profile file. Nothing is written,
cached, or minted.

Resolution order:

| | Token | URL |
|---|---|---|
| 1 | `--token` (**discouraged**) | `--url` |
| 2 | `AGENSIS_TOKEN` | `AGENSIS_MCP_URL` |
| 3 | `AGENSIS_MCP_TOKEN` | `AGENSIS_URL` |
| 4 | `~/.agensis/daemon-profiles/<profile>.json` | same profile |
| 5 | — | `https://agensis-backend.fly.dev` |

`--token` is accepted for parity with `agensis connect` and discouraged for a
specific reason: `connect --token` runs **once** at setup, whereas an operator
CLI runs **per invocation**, so the credential lands in `ps` output and shell
history every single time. Prefer the environment.

### What each token kind reaches if it leaks

Run `whoami` first. It is the documented first command because the identity you
are acting as is not obvious from the token, and the CLI prints a warning to
stderr when the kind is not `agent`.

- **`aga_` per-agent connect token** — you *are* that agent, in one workspace.
  A leak grants **read and write across that entire workspace**: every channel's
  messages, posting and dispatching as that agent, docs, tasks, thread items,
  workspace memory and skills. It is **not** channel-scoped. It also reaches the
  daemon WebSocket, so a holder can claim jobs as that agent. It does **not**
  reach `/backend/db/*` — those need a user session (`requireAuth`).
- **`agw_` workspace MCP token** — the workspace, not a single agent; can
  `register_agent` to become one.
- **`agx_` Flows connection token** — the narrowest. `runToolForIdentity` pins an
  `integration` identity to its channel, so a leak is scoped to that channel.
- **`agf_` farm token** — a farm integration identity.
- **A user login token** — **the worst thing to leak here, and the easiest
  mistake to make.** `verifyMcpToken` also accepts an agensis session token and
  resolves it to the workspace that user *owns* (`select ... from workspaces
  where user_id = $1 order by created_at asc limit 1`). So pasting your session
  token acts with owner reach — and unlike an agent token it *also* reaches
  `/backend/db/*` through the normal auth path. It carries no recognisable
  prefix, which is why redaction covers the exact resolved credential and not
  only the known prefixes.

The CLI grants **no new server authority**. `runToolForIdentity` is the single
chokepoint and every gate applies unchanged: workspace scoping off the verified
token, the per-tool `kinds` allowlist, Flows connection scopes, the integration
channel pin, invite-role capability checks, and the 120/min per-identity limiter.

### Redaction

Every write to stdout and stderr passes through one redactor, on every path
including `--raw`. It removes both the known credential prefixes and the exact
token this process resolved — the second is what covers an unprefixed user
session token. `--raw` prints the JSON-RPC **response** only; the request, which
is where the bearer lives, is never a candidate for printing.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected internal error |
| 2 | usage — unknown command/flag, missing required argument, or an alias that no longer matches the server's schema. **No request is sent.** |
| 3 | auth — HTTP 401, or no token resolvable |
| 4 | rate limited — HTTP 429, after one retry honouring `Retry-After` |
| 5 | tool error — the tool ran and refused |
| 6 | transport — DNS, connect, timeout, or a non-JSON body |
| 7 | protocol — a JSON-RPC `error` object |

**Honest limitation:** 5 is a single bucket. The server returns tool failures as
`{ isError: true, content: [{ type: 'text', text }] }` with no machine-readable
code, so "channel not found", "forbidden" and "bad argument" cannot be
distinguished without string-matching English error text, which this CLI refuses
to do. Codes **8 (not found)** and **9 (forbidden)** are reserved for when the
server grows a `_meta.code`; they will split out of 5 without renumbering
anything, so a script written against this table keeps working.

## Output

- **Default is TTY-dependent**: columns when stdout is a terminal, JSON when it
  is not. A pipe or a subprocess gets machine output with no flag. `--json` and
  `--human` force either.
- **In JSON mode stdout carries exactly one JSON document and nothing else.**
  Every note, warning and error goes to stderr. That is what makes `| jq` safe.
- **The JSON body is the tool's own result**, unwrapped from the MCP
  `content[0].text` envelope. No CLI-invented wrapper, no renamed fields — there
  is no second API to learn.
- **Errors in JSON mode**: stdout stays empty; stderr gets
  `{"error":{"code":"...","message":"..."}}`. Branch on the exit code first.

```sh
npm run ops -- channels --json | jq -r '.channels[].id'
```

## Pagination

v1 passes `--limit` through and, when a returned array is exactly that long,
writes one note to stderr saying the page may be short of the truth. There is no
cursor to offer: no read tool accepts `before` or an offset today
(`list_channels`, `read_channel` and `search_messages` cap at 200/200/100), so
anything more would be invented rather than reported. Without `--limit` the
server default (50) applies and truncation is silent — that is a **server-side
gap**, and fixing it with keyset pagination in `server/mcp.cjs` would benefit
every MCP client, not just this one.

## Why this cannot become a second API surface

That is the failure mode the design bends around, and it is enforced by tests,
not by convention:

1. **No hand-written tool schemas.** `call` builds its flag parser from the
   `inputSchema` fetched from `tools/list` at runtime. It cannot drift, because
   it has no independent knowledge of any tool. A tool added to `buildTools()`
   on Fly is callable from an unchanged CLI the moment it deploys.
2. **One network egress, one endpoint, three methods.** `cli/src/rpc.mjs` is the
   only thing in the CLI that performs I/O, it POSTs to one URL, and the set of
   JSON-RPC methods it will emit is a frozen allowlist. Passing anything else
   throws. `tests/ops-cli.test.cjs` drives every command while recording every
   request and asserts the URL and method set — so **adding a bespoke CLI route
   is a test failure**, not a code-review opinion.
3. **Aliases are validated against the live schema before dispatch.** The eight
   verbs are the only hand-written tool knowledge in the CLI. If a tool were
   renamed or a positional stopped being a real argument, the alias fails
   locally with exit 2 and a message naming the drift.
4. **The drift alarm lives in the repo that causes drift.**
   `tests/mcp-public-surface.test.cjs` pins the exact tool-name set and every
   `required` array against the real `buildTools()`.

**The rule: if a command needs something the MCP surface cannot do, add an MCP
tool — never a CLI-only route.** Everything the CLI can do, an MCP agent can do
too, and both go through the one authorization chokepoint.

## Why it lives here and not in the daemon

The originating plan put this in the `agensis-agent` repo under
`packages/agensis-cli/src/ops/`, so it would ride the `agensis` binary already on
`PATH` on every daemon host. That has a real advantage and one serious cost:
`bin/agensis.mjs` is the single entry point of the published bundle every daemon
runs, and the daemon auto-updates on a 30-minute registry poll. A parse
regression there breaks `connect` for every install, fast. It was the highest-
rated risk in the plan.

Putting the CLI here removes that risk class entirely — the daemon entry point is
not touched — and it puts the client in the same repo as the MCP server it wraps,
so the tool-surface pin test and the client cannot drift across a repo boundary.
CI for this project also runs here, which is where "post a build result into
#releases" actually happens.

The cost, stated plainly: **it is not on `PATH` on daemon hosts**, and the
daemon's `agentBackendUrl()` dev-port rewrite had to be reimplemented (ten lines
in `cli/src/auth.mjs`, covering the `5173`/`8888` → `127.0.0.1:3142` cases). If
the on-`PATH` ergonomics turn out to matter more than the blast radius, the six
modules are plain ESM with no dependency on anything in this repo and port to
`packages/agensis-cli/src/ops/` unchanged.

## Endpoint

Point at the **Fly backend**, not `agensis.io`. `/backend/mcp` is mounted in
`server/mcp-doors-routes.cjs` and is **not** in `netlify/functions/backend.mjs`,
so the MCP surface is Fly-only; `agensis.io/backend/mcp` returns the web app's
HTML. The CLI detects that specific case and says so rather than crashing on a
JSON parse. A saved daemon profile already holds the right base URL — hand-typing
`--url` is the failure mode.

## Layout

| File | Role |
|---|---|
| `cli/agensis-ops.mjs` | Binary. Wires real streams, exits with the returned code. |
| `cli/src/index.mjs` | `runOpsCommand(argv, io)` — returns an exit code, never calls `process.exit`. |
| `cli/src/rpc.mjs` | The only network egress. Method allowlist, timeout, one 429 retry, HTTP→exit-code mapping. |
| `cli/src/schema.mjs` | `tools/list` fetch, and the flag parser built from a tool's `inputSchema`. |
| `cli/src/aliases.mjs` | The eight verbs, plus validation against the live schema. |
| `cli/src/auth.mjs` | Token and URL resolution. Reads the daemon profile; never writes one. |
| `cli/src/render.mjs` | Pure output functions: redaction, tables, id truncation, format choice. |
| `cli/src/exitCodes.mjs` | The taxonomy, with 8 and 9 reserved. |
