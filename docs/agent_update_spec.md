# Agent Update Spec — Amp as a real runtime + one-link agent onboarding

Status: proposed (nothing below is implemented yet unless marked DONE)
Date: 2026-07-27
Origin: live onboarding session connecting Amp to workspace
`3a9ce2ab-27e7-42db-90fa-7e1ba32cf62e` as agent `37b155f3-…` (`@amp`).
Related task in Agensis: `ebc9436a-baef-4bd1-8ccc-67626698f332`
("One-command agent onboarding via join link", status `todo`).

This spec covers TWO repositories:

- **agensis** (this repo) — invite/join onboarding, runtime identity surfaced in UI.
- **agensis-agent** (`../agensis-agent`, github.com/jasonkneen/agensis-agent) —
  the open-source daemon: runtime adapters, Amp executor.

---

## 1. What went wrong in the onboarding session (observed, not speculation)

1. **Desktop app minted a localhost invite URL.** The invite came out as
   `http://127.0.0.1:5173/app?invite=…` because
   `src/hooks/useWorkspaceUsers.ts:153` builds the link from
   `window.location.origin`. In the desktop/dev shell that origin is the Vite
   dev server, not `https://agensis.io`. The server should return the canonical
   URL (it knows `AGENSIS_APP_URL`); the client should never construct it.
2. **Connect-panel token rotation made pasted commands stale.** Opening or
   re-rendering the app's connection panel rotates the agent token, so a
   previously copied `agensis connect --token aga_…` command silently died.
   Two dead tokens were pasted into a transcript before a live one worked.
   (Those tokens are burned; the working credential lives only in the saved
   connect profile.)
3. **Loopback dev fallback masked bad credentials.** Local non-production
   `allowLoopbackAgentDevFallback` accepts any loopback `aga_` token, so an
   invalid token "worked" locally and failed only against Fly — a confusing
   failure mode during setup.
4. **The MCP invite lane was useful but not sufficient.** Via the invite-bearer
   MCP surface the agent could `whoami`, `register_agent`, and create tasks —
   but it could not obtain a durable daemon credential (`get_connect_command`
   is admin-only) and ended up in a `claim_job` polling posture. The join-link
   agent lane (`server/index.cjs` ~14085–14440) already does the right thing:
   creates the `workspace_agents` row, sets `mcp_approved: true`, mints a fresh
   `aga_` token, and returns credential + MCP config in one redemption.
5. **The daemon answered as Claude wearing an Amp name.** The `@amp` agent was
   backed by the default `codingCmd` (`claude -p`) with
   `--model claude-opus-4-8`. The handle/name said Amp; the runtime was Claude
   Code. Nothing in the wire protocol or UI distinguishes "the runtime that is
   actually answering" from the label.

## 2. Verified facts about the Amp CLI (checked live, 2026-07-27)

Amp CLI `0.0.1785170481` at `/Users/jkneen/.local/bin/amp`:

- `amp -x` / `amp --execute "<prompt>"` — headless one-shot mode. Prompt may be
  a positional argument or stdin. Verified working under the local login.
- `amp -x --stream-json` — **Claude Code-compatible stream JSON output**
  (per the Amp owner's manual, and verified by running it). Emits NDJSON:
  `{"type":"system","subtype":"init",…}` → `{"type":"user",…}` →
  `{"type":"assistant","message":{…complete content…}}` →
  `{"type":"result","subtype":"success","result":"…"}`.
  No token-level deltas by default; `--stream-json-thinking` extends the schema
  (not Claude-compatible — do not enable for the daemon parser).
- `--stream-json-input` — multi-turn conversations over stdin in one process
  (exit only when assistant is done AND stdin closed).
- `amp threads continue <thread-id-or-url>` — resumes an existing thread;
  combined with `-x` this gives cross-invocation session continuity. Every
  `-x` run creates/continues a real thread visible on ampcode.com under the
  operator's account.
- `--mcp-config <json-or-path>` — merge MCP servers at invocation time (the
  hook for agensis lean-MCP wiring).
- `-m, --mode <low|medium|high|ultra>` — agent mode. **Amp does not take
  `--model`**; a `--model claude-opus-4-8` arg must never be passed to it.

Why this matters: the daemon's stream parser (`createStreamJsonParser` in
`agensis-agent/packages/agensis-cli/src/agensis.mjs` ~line 1191) already
parses exactly this format, including a fallback for streams with complete
`assistant` messages and no deltas. And the daemon already passes the prompt
as the final positional arg (`args: [...command.args, prompt]`, ~line 923),
which is `amp -x "<prompt>"`'s contract. **The integration gap is ~30 lines.**

## 3. Feasibility matrix — "Amp actually answering"

| Guarantee | Feasible? | Mechanism |
|---|---|---|
| Same brand/model label only | today | `--model` costume — what we had; rejected |
| Real Amp process per job, operator's account | yes, small change | amp branch in `buildAgentCommand` + `--coding-cmd "amp -x"` |
| Live streaming into the channel | yes, free | `--stream-json` feeds the existing parser |
| Persistent Amp session per channel/agent | yes, phase 2 | persist an Amp thread ID per daemon `sessionKey`, run `amp threads continue <id> -x` |
| A specific pre-existing hosted conversation | almost | `threads continue` can target any thread ID the account owns, so agensis turns append to that thread and share its full context. Each turn is a new CLI process, but it is the same thread/memory. No hosted assistant can do better: an already-running hosted session has no inbound job API. |

## 4. Changes to `agensis-agent` (the daemon)

All in `packages/agensis-cli/src/agensis.mjs` unless noted.

### 4.1 Amp command detection

```js
function isAmpCommand(cmd) {
  return /(^|\/)amp(?:$|\.)/.test(String(cmd || ""));
}
```

Mirrors `isClaudeCommand` / `isCodexCommand` (~line 1731).

### 4.2 Amp branch in `buildAgentCommand` (~line 1061)

After the Claude and Codex branches:

- Ensure execute mode: if neither `-x` nor `--execute` is in the cleaned args,
  push `-x`. (Recommended default `codingCmd`: `amp -x`.)
- **Do not** push `--model`. If a model is set on the job/agent, map it to
  `-m <mode>` only when it names a valid Amp mode (`low|medium|high|ultra`);
  otherwise drop it and log once.
- Streaming: if the operator hasn't pinned an output flag, push `--stream-json`
  and return `streamJson: true` so the job path uses `createStreamJsonParser`.
  Never auto-add `--stream-json-thinking` (schema-incompatible).
- Permission mapping: `yolo` → Amp's dangerous-allow flag (verify the exact
  current flag name against `amp -x --help` at implementation time; do not
  hard-code from memory). `default`/`accept_edits` → no flag (Amp's own
  permission model applies).
- Lean MCP: when `config.leanCli`, push
  `--mcp-config '{"agensis":{"url":…,"headers":{"Authorization":"Bearer …"}}}'`
  using `leanMcpRuntime(config)` — same env-var indirection as the Claude
  branch (`AGENSIS_MCP_TOKEN`), never the literal token in argv.
- Host folders: Amp has no `--add-dir`; job `cwd` confinement applies. Document
  the gap; do not silently pretend parity with Claude.

### 4.3 Capabilities

Add `"amp"` to the hardcoded list in `detectClis()` (~line 1548) so heartbeats
advertise it and the workspace can see an Amp-capable host.

### 4.4 Runtime identity (fixes "costume" ambiguity)

The heartbeat/capabilities payload gains a `runtime` field describing what is
actually answering: `{ id: "amp" | "claude" | "codex" | "custom", cmd,
version }` — derived from `codingCmd`, not from the agent's display name or
model label. Version comes from `<cli> --version` at startup, cached.

### 4.5 Phase 2 — session continuity

- Persist `ampThreadId` keyed by the daemon's existing
  `sessionKey` (`${workspaceId}:${agent}`) in the connect profile state.
- First job: run plain `amp -x --stream-json`, capture `session_id` from the
  `init` event, store it.
- Subsequent jobs: `amp threads continue <ampThreadId> -x --stream-json …`.
- A `--amp-thread <id>` connect flag lets the operator pin a specific existing
  thread (including one started interactively on ampcode.com).
- On `thread not found` / permission errors, fall back to a fresh thread and
  overwrite the stored ID; never fail the job on continuity.

### 4.6 Refactor (optional but recommended)

Claude/Codex/Amp handling in `buildAgentCommand` is an if-chain of
special cases. Extract a small adapter registry — each adapter declares
`{ id, detect(cmd), build(config, job, cleanArgs), streamFormat,
supportsSessionContinuation }` — so the fourth runtime is a table row, not a
fourth branch. Keep behavior byte-identical for Claude/Codex (existing tests
must pass unchanged).

### 4.7 Tests

- `buildAgentCommand` with `codingCmd: "amp -x"`: asserts `--stream-json`
  added, `streamJson: true`, no `--model`, mode mapping, MCP config shape,
  operator-pinned output format respected.
- Parser fixture: a captured real `amp -x --stream-json` transcript (the four
  events above) through `createStreamJsonParser`, asserting live text,
  segments, and final result.
- Continuity: thread ID captured from `init`, reused on next job, discarded on
  a simulated `thread not found`.

## 5. Changes to `agensis` (this repo)

Extends task `ebc9436a-baef-4bc8-…` (join-link onboarding); items 5.1–5.4
restate it, 5.5–5.6 are new from this session.

### 5.1 Server-canonical invite URLs

`src/hooks/useWorkspaceUsers.ts:153` must stop building
`${window.location.origin}/app?invite=…`. The server returns the full URL
built from `AGENSIS_APP_URL` (join links already do this — reuse that path).
Desktop/dev/preview shells then always hand out `https://agensis.io/...`.

### 5.2 Desktop app mints agent JOIN links, not legacy workspace invites

The agent-invite affordance in the desktop app should mint a
`workspace_join_links` row (audience `agent` or `both`) and surface
`https://agensis.io/join/<token>` — 15-min TTL, single-use, hash at rest —
instead of the 14-day `workspace_invites` bearer.

### 5.3 Join redemption returns the daemon bootstrap

The agent-lane redemption response already returns credential + MCP config.
Add the ready-to-run daemon block:

```
agensis connect --url <fly-url> --workspace <id> --agent <id> \
  --handle <h> --name <n> --token TOKEN_PLACEHOLDER
```

One secret per response rule holds: the live token appears exactly once, in
`data.credential.token`; the command block uses `TOKEN_PLACEHOLDER`
(same convention as `server/skills.cjs`; enforced by test).

### 5.4 `agensis connect --join <url> [--runtime amp|claude|codex]`

One command from a pasted join URL: redeem (Accept: application/json), save
profile, connect. `--runtime` selects the adapter and sets the default
`codingCmd` (`amp` → `amp -x`). Without the flag: detect available CLIs and
offer, or default to `claude -p` as today.

### 5.5 Surface runtime identity in the UI

Wherever the workspace shows an agent's model/status (Agents window, channel
header), show the daemon-reported `runtime` (§4.4): "Amp CLI 0.0.x", not just
the model label. An agent whose display name says Amp but whose runtime says
`claude` should be visibly distinguishable.

### 5.6 Token-rotation footgun

Rendering the connection panel must not rotate a live agent token as a side
effect. Rotation should be an explicit button. (This burned two pasted
commands in the session; combined with the loopback dev fallback it produced
"works locally, fails on Fly" confusion.)

## 6. Security notes

- Invite/connect tokens were pasted into a chat transcript during this
  session; all pasted tokens are dead (rotated). Treat any `aga_` token that
  has appeared in a transcript as burned.
- The Amp adapter must never place the MCP bearer in argv (process lists are
  world-readable); use the env-var indirection the Claude branch already uses.
- `--stream-json-thinking` stays off: thinking blocks would flow into the
  channel as content and the schema breaks the shared parser.
- The join-link properties (single-use UPDATE-race-safe consumption, identical
  410s, no UA sniffing, one-secret-per-response) are load-bearing; §5 changes
  must not weaken them.

## 7. Verification plan

agensis-agent: `npm test` in that repo (new tests in §4.7), then a live run:
`agensis connect --profile amp --coding-cmd "amp -x"` against the existing
agent, send a channel message, confirm (a) streamed segments render, (b) the
answering thread appears on ampcode.com under the operator's account, (c) the
heartbeat advertises `runtime: amp`.

agensis: `npm run ci` (typecheck + both suites + smoke + lint). New tests:
join redemption returns the daemon block with exactly one live token;
invite URLs are server-canonical (no `window.location.origin` in the invite
path); release-notes entry for the user-visible invite change.

## 8. Rollout order

1. agensis-agent: §4.1–4.4 (adapter + identity) + tests → npm release.
2. Local proof: swap the `amp` profile to `--coding-cmd "amp -x"`, verify §7.
3. agensis: §5.1/5.6 (URL + rotation fixes — independent, ship early).
4. agensis: §5.2–5.4 (join-link bootstrap + `--join`).
5. agensis-agent: §4.5 continuity (phase 2), then §5.5 UI runtime badge.
