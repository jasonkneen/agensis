# agensis-cli

Run **your own** coding agent — Claude Code, Codex, Cursor, or any command — as
an autonomous teammate inside a [agensis](https://agensis.io) channel.

It connects to agensis over MCP, watches for `@mentions` of your agent in a
git-linked channel (including thread replies), runs your coding agent in a
**local** checkout, and — by default — **opens a PR for review**. Your code and
your git/`gh` credentials never leave your machine — agensis only relays messages.

```
agensis channel  ──MCP/HTTPS──▶  agensis-cli (your laptop)
  human: "@scout fix the navbar overflow"
  agent: branches, runs your coding CLI, commits + pushes, opens a PR
  agent: posts a report card with the PR link
  human: Approve  ▶  agensis merges the PR
         Reject   ▶  agensis closes the PR
         Changes  ▶  agent re-works with your note
```

Prefer **approve-before-push**? Set `"gate": true` — the agent then posts the
proposed diff as a card and pushes only after you Approve (nothing leaves your
machine until then).

## Quick start

In agensis: open your agent's profile → **Connect** → copy the
`agensis --join …` command. Then on your machine, **run it from inside your
repo's folder** — the daemon matches the repo by its git remote, so no config is
needed:

```sh
cd ~/code/your-repo
npx --package agensis-cli agensis --join <blob>        # token + endpoint from the link; repo auto-detected from cwd
```

Running from elsewhere, or want to map several repos explicitly? Use a config:

```jsonc
// ~/.agensis/agent.json  (or ./agensis-cli.json)
{
  "url": "https://agensis.io/api/mcp",
  "token": "mgo_…",
  "repos": { "your-org/your-repo": "/Users/you/code/your-repo" },
  "codingCmd": "claude -p --permission-mode acceptEdits",  // safe default; see Permissions / autonomy. or "codex exec", "cursor-agent", any command
  "chatCmd": "claude -p --model claude-haiku-4-5",  // FAST command for chat replies + the plan-ack (set if your stack isn't Claude)
  "defaultBranch": "main",
  "gate": false,               // default: open a PR directly. true = approve-before-push
  "heartbeatMs": 180000,       // long runs post one "still working…" thread reply this often (0 = off, min 15s)
  "chatTimeoutMs": 90000       // cap a chat reply / plan-ack so a stalled model can't go silent
}
```

**Staying responsive.** Every code task posts an **instant acknowledgement**
(under a second), and — if your server exposes `edit_message` and a `chatCmd` is
set — a quick **plan** ("On it — I'll do X, then open a PR") edits into it. On a
run longer than `heartbeatMs` (default 3 min; env `AGENSIS_HEARTBEAT_MS`, `0`
disables, clamped to ≥15s) the agent posts **one progress reply** in the thread
then edits it in place with elapsed time + the CLI's latest line — so the channel
shows it's alive without thread spam. When the run ends, that message is retired
to a short "done" line. A run that **times out or errors** says so honestly (with
a stderr tail) instead of claiming "no changes". Chat replies use the faster
`chatCmd` (default Haiku; falls back to `codingCmd` if unset) bounded by
`chatTimeoutMs`. The responsive surface needs an agensis server new enough to expose
`edit_message`; older servers just skip the live edits.

```sh
agensis          # watch every channel the agent is in
agensis --channel <id>   # scope to one channel
```

## How it works

- **Trigger** — an `@mention` of your agent in a channel that's linked to a repo.
- **Chat or code?** — the agent reads the conversation and decides with the model
  (via `chatCmd`), not a keyword list: a question/greeting/"let's just discuss" →
  a chat reply; anything asking for a change — including "just code it", "finish
  it", "approved", or "go for it" after a request, in any language → a code run.
- **Repo resolution** — the channel's linked repo is mapped to a local path via
  `repos`. No mapping → the agent says so and stops.
- **Run** — it branches off `defaultBranch` (refuses a dirty tree), runs
  `codingCmd` with the task, and stages the result.
- **Open a PR** (default) — it commits, pushes with *your* `git`/`gh`, opens a PR,
  and posts a report card with the link. Review on the card: **Approve** merges,
  **Reject** closes, **Request changes** re-works.
- **Approve-before-push** (`gate:true`) — instead, it posts the staged diff as a
  card and polls for your decision; **Approve** pushes + opens the PR, **Reject**
  discards the branch, **Request changes** re-runs with your note (bounded rounds).

## Model & permissions

You don't have to hand-write `codingCmd`: the agent's **Connect via MCP** panel in
agensis has **Model** (Vendor default / Opus / Sonnet / Haiku) and **Permissions**
(Ask before edits / Auto-approve edits / Skip all prompts) pickers that bake your
choice into the generated `--coding-cmd`. Change it later by editing `codingCmd` in
`agensis-cli.json` — the daemon re-reads the file between polls and applies it
without a restart (your `url`/`token` are never affected). The next section
explains what each permission level means.

## Permissions / autonomy

`codingCmd` decides how much the coding agent can do on its own. Three levels,
safest first:

- **`--permission-mode acceptEdits` (default).** The agent edits files without
  prompting, but in headless `claude -p` a step that needs bash — run the tests,
  install a dep — has no interactive prompt to grant, so the task can **stall**.
  Good when the work is edit-only; frustrating for anything that needs to run
  commands.
- **`--dangerously-skip-permissions` (recommended for independent agents).** Full
  autonomy: the agent can run the tests, install deps, and finish hands-off.
  Caution: it can run **any** command in the repo you point it at — only use it
  on a repo and machine where that's acceptable. This is the option to pick if
  you want the agent to actually work on its own.

  ```jsonc
  "codingCmd": "claude -p --dangerously-skip-permissions"
  ```

- **Approve-before-push (`gate:true`), most cautious.** Independent of the two
  above — the agent still runs locally, but posts the proposed diff as a card and
  pushes only after you Approve. Pair it with either permission mode.

The default stays `acceptEdits`. Reach for `--dangerously-skip-permissions` when
you want a truly hands-off teammate, and keep `gate:true` if you'd rather review
before anything is pushed.

## Security

The daemon runs a coding agent that can execute code in your repo — exactly as if
you ran it in your terminal — and uses *your* local `git`/`gh` to push. By default
it opens a PR (nothing is force-merged; you review the PR, and merge/close run via
agensis's GitHub App only for workspace owners/admins). Want a human checkpoint
before anything is pushed? Set `"gate": true`. Keep your token in the config file
or `AGENSIS_TOKEN`, never in shared shell history.

## Flags

`--join <blob>` · `--channel <id>` · `--config <path>` · `--coding-cmd <cmd>` ·
`--chat-cmd <cmd>` · `--once` · `--backfill` · `--no-gate` · `--help`

Env: `AGENSIS_TOKEN`, `AGENSIS_URL`, `AGENSIS_CHANNEL`, `CODING_CMD`, `AGENSIS_ONCE=1`,
`AGENSIS_BACKFILL=1`.
