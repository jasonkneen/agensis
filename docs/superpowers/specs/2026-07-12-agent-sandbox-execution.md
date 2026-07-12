# Agent Sandbox Execution — Design Spec

**Status:** DRAFT — awaiting Jason's sign-off
**Date:** 2026-07-12
**Author:** @coder
**Driver:** Jason wants agents that do their work inside isolated cloud sandboxes/VMs (e2b, Vercel Sandbox, Daytona, Morph). "ALL" of the drivers eventually, but ship the **easiest thing first** with a **dead-simple default UX** and an **Advanced** disclosure for power users.

---

## 1. Product framing (the part Jason cares about)

**Default UX — zero thinking required.** When you create or edit an agent, there's a runtime mode selector that already exists today (`Built-in` / `Remote daemon`). We add one more option:

> **⚪ Sandbox** — runs this agent's work in an isolated cloud environment. Nothing touches your machine or the server.

That's it. No provider dropdown, no config. Picking "Sandbox" uses a **sensible default provider** (e2b) with a **default config** we ship. Create agent → it runs in a fresh sandbox → work happens → sandbox is torn down. Done.

**Advanced disclosure — for people who care.** A collapsed "Advanced" section under the mode selector (only rendered when Sandbox is selected) lets you override:
- **Provider** — `e2b` (default) · `vercel` · `daytona` · `morph`
- **Config** — provider-specific JSON: image/template, persist-between-jobs, snapshot, region, etc.

If you never open Advanced, you never see a provider name. If you open it, you get the full control surface.

**This is the whole ask, restated:** one more radio option that Just Works, plus an escape hatch. The four-provider ambition lives entirely behind the Advanced panel — we ship the seam + one provider now, add the other three behind the same panel later.

---

## 2. The seam (grounded in real code)

Today there is exactly **one** place an agent's work executes:

- `agent/agensis-cli/src/agensis.mjs:832` — `runAgentJob` calls `runCli({ cmd, args, prompt, cwd, timeoutMs, heartbeatMs, signal, onData })`. The coding CLI (`claude` / `codex`) is spawned **on the host**, and its stdout is streamed back over WebSocket via `sendDelta` → `agent_job_delta`.
- `agent/agensis-cli/src/agensis.mjs:940` — `buildAgentCommand(config, job)` returns `{ cmd, args, model, permissionMode, permissionFlags, streamJson }`.
- The environment axis already exists: `run_mode` on `workspace_agents`, added in `supabase/migrations/20260627162000_...sql:24` and re-affirmed in `20260628014500_agent_runtime_modes.sql:10`. Values today: `'builtin'` (fly.dev) / `'daemon'` (local subprocess).
- Provider API keys + repo tokens have a home already: the `workspace_secrets` table (`supabase/migrations/20260627194000_workspace_scoped_secrets.sql`).
- The runtime-mode UI already exists: `src/components/windows/AgentsWindowContent.tsx` renders a `'builtin' | 'daemon'` selector (create + edit forms). We extend its union and add the Advanced panel here — not greenfield.

**So the entire feature is:** add a third `run_mode = 'sandbox'`, and refactor the single `runCli` call site behind an `Executor` interface so the same `{ cmd, args, prompt }` can run **remotely** instead of on the host.

```
Executor.run({ cmd, args, prompt, cwd, signal, onData }) → { stdout, stderr, status, error }
   ├── LocalExecutor            // today's runCli, byte-identical — used by builtin + daemon
   └── SandboxExecutor(provider)
         provider: {
           ensureEnv(job)          → sandboxHandle      // create/reuse remote env
           putRepo(handle, source)                       // get the code in
           exec(handle, cmd, args, prompt, onData) → { stdout, stderr, status }
           getResult(handle)       → { patch?, artifacts? }
           snapshot?(handle)                             // optional (Morph)
           destroy(handle)
         }
```

The stdout→WS delta path (`onData` → `sendDelta`) already works for **any** source that hands us a stream. That's why this is tractable: we're not rebuilding streaming, just changing *where the process lives*.

---

## 3. First provider: e2b (the "easiest")

e2b is the MVP provider because it is the thinnest possible proof-of-seam:
- Firecracker microVMs, ~150ms boot, ephemeral by design → immediate **safety/isolation** win and **ephemeral-at-scale** win in one shot (drivers A + B).
- SDK gives us: create sandbox, write files, run a command with a streamed stdout callback, read files back, kill. That maps 1:1 onto the `provider` interface above — no persistence, snapshot, or desktop complexity to debug on day one.
- Everything harder (persistent envs = Daytona, VMs+desktop = Morph) is a **later provider behind the same Advanced panel**, not a rewrite.

---

## 4. Two design forks — resolved (flag if you disagree)

**Fork 1 — Where the sandbox orchestrator runs.**
Options: your **laptop daemon** calls e2b, vs. the **fly.dev server** calls e2b.
→ **Decision: server-orchestrated.** The whole point of "no local daemon required" (driver B) is that ephemeral cloud agents shouldn't need your laptop powered on. Server holds the e2b key (a `workspace_secrets` row), creates the sandbox, streams deltas over the existing WS path. The daemon path stays for `daemon` mode; `sandbox` mode is server-driven.

**Fork 2 — How the repo gets in and results come out.**
Options: **git-clone-in / patch-out** (clean; needs a repo URL + token) vs. **upload-working-tree / return-patch** (works on local uncommitted state).
→ **Decision: git-clone-in / patch-out for the MVP.** Sandbox clones the repo (token from `workspace_secrets`), runs the agent, and we return the resulting `git diff` as the artifact. Working-tree upload (for daemon-local uncommitted repos) is a Phase-2 add-on behind the same interface.

---

## 5. Build phases

- **Phase 0 — the seam (no provider).** Add `run_mode='sandbox'` + `sandbox_provider` + `sandbox_config` columns (migration). Refactor the `runCli` call site behind `Executor`. Ship `LocalExecutor` so `builtin`/`daemon` behavior is **byte-identical** today. Extend the `AgentsWindowContent` mode selector union + add the (empty-for-now) Advanced panel. **This is the load-bearing work — every provider rides on it.**
- **Phase 1 — e2b MVP.** Server-side `SandboxExecutor` + e2b provider: clone repo → run `claude -p` inside → stream stdout back over WS → return the diff → destroy. Advanced panel lets you paste an e2b template + toggle. Covers drivers **A + B**. **← first shippable slice.**
- **Phase 2 — Daytona.** Env reuse + lifecycle (persist/pause/resume) behind the provider interface. Working-tree upload option. Covers **C**.
- **Phase 3 — Morph.** Snapshot/branch (`snapshot()`) + desktop/browser, plugging into the existing CursorBuddy visible-surface path. Covers **D**.

Each later provider is a new `provider` object + an entry in the Advanced dropdown. No seam changes.

---

## 6. Data model changes (Phase 0)

```sql
-- workspace_agents already has: run_mode text NOT NULL DEFAULT 'builtin'
-- extend the allowed set to include 'sandbox' (no CHECK constraint exists today; app-level enum)
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_provider text;      -- 'e2b' | 'vercel' | 'daytona' | 'morph', null unless run_mode='sandbox'
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_config  jsonb NOT NULL DEFAULT '{}'::jsonb;
```

Provider secrets (e2b API key, git token) live as `workspace_secrets` rows keyed by name (e.g. `E2B_API_KEY`, `GIT_TOKEN`) — no schema change needed.

---

## 7. Explicit assumptions (tell me if any are wrong)

1. **Default provider = e2b.** Picking "Sandbox" with no Advanced interaction uses e2b + a default template. ✅ your "easiest first."
2. **Server-orchestrated**, not laptop-orchestrated, for sandbox mode (Fork 1).
3. **git-clone-in / patch-out** for the MVP; the agent operates on the repo's committed state, and the deliverable is a diff (Fork 2).
4. **`claude` is the coding CLI inside the sandbox** (same `buildAgentCommand` output, running `yolo`/`--dangerously-skip-permissions` is now *safe* because it's isolated).
5. The Advanced panel is **UI-only config** in Phase 0/1 — it stores `sandbox_provider` + `sandbox_config`; only e2b is wired to actually run. Other providers appear but are marked "coming soon" until their phase lands.
6. We are **not** removing or changing `builtin`/`daemon` behavior — `LocalExecutor` is a pure refactor with identical output.

---

## 8. Out of scope (this spec)

- Vercel / Daytona / Morph runtime wiring (Phases 2–3; UI stubs only for now).
- Desktop/GUI streaming (Morph, Phase 3).
- Billing / quota / concurrency caps on sandboxes.
- Persistent env lifecycle management UI.

---

## 9. Open questions for sign-off

- **Q1.** Default e2b template — plain Ubuntu + node + the `claude` CLI preinstalled? (I'll spec a default template build in the plan.)
- **Q2.** For the MVP diff-out: do you want the diff **auto-applied** back to a branch/PR, or just **returned into the chat** for you to review? (My rec: return-into-chat first, auto-PR later.)
- **Q3.** Confirm the e2b API key + a git token get stored as `workspace_secrets` (vs. env on the fly host).

---

**Next step after sign-off:** I turn this into a task-by-task implementation plan at `docs/superpowers/plans/2026-07-12-agent-sandbox-execution.md` (TDD, bite-sized, Phase 0 + Phase 1 only). **No code until you approve this spec.**
