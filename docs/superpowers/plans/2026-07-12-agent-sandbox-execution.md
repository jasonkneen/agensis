# Agent Sandbox Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third agent runtime — **Sandbox** — that runs an agent's coding CLI inside an isolated cloud environment (e2b first), selectable with one radio button and a sensible default, with an Advanced panel for power users.

**Architecture:** Refactor the daemon's single coding-CLI call site (`agent/agensis-cli/src/agensis.mjs:832`, `runCli`) behind an `Executor` interface. `LocalExecutor` preserves today's behavior byte-for-byte; `SandboxExecutor(provider)` runs the same `{cmd,args,prompt}` inside a remote sandbox via a pluggable `provider`. e2b is the first provider. The existing stdout→`onData`→`sendDelta`→WebSocket path is reused unchanged — we only move *where the process lives*.

**Tech Stack:** Node ESM (`.mjs`) daemon, `node:test` (`.cjs`) tests with `await import()` of the ESM modules, Postgres (`postgres.js`) via `server/index.cjs`, React+TS UI (`src/components/windows/AgentsWindowContent.tsx`), e2b Node SDK.

## Global Constraints

- **Daemon package deps stay lean.** `agent/agensis-cli` currently has exactly one runtime dep (`ws`). Only `e2b` is added, and only in Phase 1. It must survive the `agensis-agent` bundling step.
- **`builtin` and `daemon` behavior is unchanged.** `LocalExecutor` is a pure refactor; its output must be byte-identical to today's direct `runCli` call.
- **Tests are `tests/<name>.test.cjs`** using `require('node:test')` + `await import(pathToFileURL(...).href)` to load `.mjs` daemon modules. This is the only glob `npm test` runs (`node --experimental-test-module-mocks --test tests/*.test.cjs`).
- **DDL is idempotent and lives in two places:** a new `supabase/migrations/*.sql` file AND the inline `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` block in `server/index.cjs` (~line 548) — the inline block is what actually runs on fly.dev.
- **No secrets in the repo.** e2b + Anthropic keys are read from the daemon host's environment for the MVP (see Decisions).

---

## ⚠️ Finding that changes the spec (read before starting)

The spec's **Fork 1 chose "server-orchestrated."** Grounding in the code shows that is the *expensive* path, not the easy one:

- The server's `builtin` run mode (`server/index.cjs:2835`) is a **plain Anthropic chat completion** (`runAnthropicCompletion`) — it spawns **no** coding CLI, does no file work, and has none of the streaming/stream-json/delta machinery.
- The coding CLI (`claude`/`codex`) with real file edits runs **only in the daemon** (`agent/agensis-cli`), which already owns `runCli`, `buildAgentCommand`, the stream-json parser, and the `onData→sendDelta` WebSocket path.

Therefore the **single seam is the daemon's `runCli` call site**, and the cheapest MVP is **daemon-orchestrated**: the daemon spins up the e2b sandbox and supervises it, streaming deltas back over the WS path it already uses. The untrusted code still runs in the cloud sandbox (the safety/isolation win is intact); the laptop is only the *orchestrator*.

**Decision for this plan (flips spec Fork 1):**
- **MVP = daemon-orchestrated sandbox.** Requires a connected daemon (laptop up), same as `daemon` mode.
- **Server-orchestrated ("runs with laptop off") is deferred** to a later phase — it means teaching the server to spawn+stream a coding CLI from scratch, which is a much larger build. Out of scope here.

Also resolving the spec's three open questions (my calls, per Jason's "your calls, go"):
- **Q1 (e2b template):** MVP installs `@anthropic-ai/claude-code` + `git` on the e2b base image at sandbox-create time (no custom template-build pipeline). A baked template is a documented later optimization.
- **Q2 (diff-out):** **Return the `git diff` into the chat** as a fenced ```` ```diff ```` block appended to the agent's reply. Auto-PR is later.
- **Q3 (secrets):** MVP reads `E2B_API_KEY` and `ANTHROPIC_API_KEY` (and optional `GIT_TOKEN` for private clones) from the **daemon host's environment** — simplest, no secret-push protocol. `workspace_secrets`-backed, server-injected secrets are the Phase-2 (server-orchestrated) story.

---

## File Structure

**Create:**
- `supabase/migrations/20260712120000_agent_sandbox_execution.sql` — adds `sandbox_provider`, `sandbox_config` columns.
- `agent/agensis-cli/src/executor.mjs` — `createLocalExecutor`, `createSandboxExecutor`, `createExecutor` factory. The seam.
- `agent/agensis-cli/src/sandbox/e2b.mjs` — the e2b provider adapter (network I/O).
- `tests/agent-executor.test.cjs` — unit tests for the executor seam + sandbox orchestration (fake provider).
- `tests/agent-sandbox-e2b.test.cjs` — e2b adapter tests using `--experimental-test-module-mocks`.
- `tests/agent-sandbox-schema.test.cjs` — source-contract tests (DDL + payload passthrough + UI).

**Modify:**
- `server/index.cjs` — inline DDL (~548), agent SELECT columns (~1787/1798/2132), `agentRuntimePayload` (~2067), run-target routing (~2795/2835), and add `agentRuntimePayload` + `resolveRunTarget` to `module.exports.__test` (~7574).
- `agent/agensis-cli/src/agensis.mjs` — refactor the `runCli` call site in `runAgentJob` (~810–854) to use `createExecutor`; export new helpers via `__test` (~1424).
- `agent/agensis-cli/package.json` — add `e2b` dependency (Phase 1).
- `src/components/windows/AgentsWindowContent.tsx` — extend the `'builtin'|'daemon'` union to include `'sandbox'`, add the radio option + Advanced panel.
- `src/types/index.ts` / `src/hooks/useAgents.ts` — extend the `run_mode` type + carry `sandbox_provider`/`sandbox_config`.

---

# PHASE 0 — The seam (no provider). Ships identical behavior today.

### Task 1: Data model + payload passthrough

**Files:**
- Create: `supabase/migrations/20260712120000_agent_sandbox_execution.sql`
- Modify: `server/index.cjs` — inline DDL (~548), three agent SELECTs (~1787, ~1798, ~2132), `agentRuntimePayload` (~2067), exports (~7574)
- Test: `tests/agent-sandbox-schema.test.cjs`

**Interfaces:**
- Produces: `agentRuntimePayload(agent)` now includes `run_mode` (passes `'sandbox'` through, not collapsing to `'builtin'`), `sandbox_provider` (string|null), `sandbox_config` (object). Exposed as `__test.agentRuntimePayload`.

- [ ] **Step 1: Write the failing test**

```js
// tests/agent-sandbox-schema.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('server inline DDL adds sandbox columns', async () => {
  const src = await readFile(path.join(root, 'server/index.cjs'), 'utf8');
  assert.match(src, /ADD COLUMN IF NOT EXISTS sandbox_provider text/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS sandbox_config jsonb/);
});

test('agentRuntimePayload passes sandbox fields through', async () => {
  const { __test } = require('../server/index.cjs');
  const p = __test.agentRuntimePayload({
    id: 'a', workspace_id: 'w', name: 'S', handle: 's',
    run_mode: 'sandbox', sandbox_provider: 'e2b',
    sandbox_config: JSON.stringify({ template: 'base' }),
  });
  assert.equal(p.run_mode, 'sandbox');
  assert.equal(p.sandbox_provider, 'e2b');
  assert.deepEqual(p.sandbox_config, { template: 'base' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/agent-sandbox-schema.test.cjs`
Expected: FAIL — DDL regex not found; `p.run_mode` is `'builtin'`; `sandbox_provider` undefined.

- [ ] **Step 3: Add the migration file**

```sql
-- supabase/migrations/20260712120000_agent_sandbox_execution.sql
-- Sandbox runtime: a third run_mode ('sandbox') whose provider + config live here.
-- run_mode has no CHECK constraint today (app-level enum), so no change needed there.
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_provider text;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_config jsonb NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 4: Add the inline DDL in `server/index.cjs`**

Immediately after the existing `ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS run_mode text NOT NULL DEFAULT 'builtin';` (~line 548), add:

```js
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_provider text;
    ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_config jsonb NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 5: Add the columns to the three agent SELECT lists**

In each of the three `select id, workspace_id, ... run_mode, memory_dir, permission_mode, version, enabled` queries (~1787, ~1798, ~2132), add `sandbox_provider, sandbox_config` after `run_mode`:

```
run_mode, sandbox_provider, sandbox_config, memory_dir, permission_mode, version, enabled
```

- [ ] **Step 6: Pass the fields through `agentRuntimePayload`**

In `agentRuntimePayload` (~2085), change the `run_mode` line and add two fields. There is a `parseJsonObject` helper already used for `metadata`:

```js
    run_mode: agent.run_mode === 'daemon' ? 'daemon'
      : agent.run_mode === 'sandbox' ? 'sandbox'
      : 'builtin',
    sandbox_provider: agent.sandbox_provider || null,
    sandbox_config: parseJsonObject(agent.sandbox_config),
```

- [ ] **Step 7: Export `agentRuntimePayload` for tests**

In the `module.exports.__test` object (~7574), add `agentRuntimePayload,` to the exported set.

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test tests/agent-sandbox-schema.test.cjs`
Expected: PASS (both tests).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260712120000_agent_sandbox_execution.sql server/index.cjs tests/agent-sandbox-schema.test.cjs
git commit -m "feat(sandbox): add sandbox_provider/sandbox_config columns + payload passthrough"
```

---

### Task 2: Server routing — sandbox dispatches to a connected daemon

**Files:**
- Modify: `server/index.cjs` — extract `resolveRunTarget` helper, use it in `runAgentTurn` (~2795, ~2835), export it (~7574)
- Test: `tests/agent-sandbox-schema.test.cjs` (append)

**Interfaces:**
- Produces: `resolveRunTarget(agent)` → `'builtin'` for `run_mode==='builtin'`, `'daemon'` for `run_mode` of `'daemon'` **or** `'sandbox'`. Exposed as `__test.resolveRunTarget`. This makes sandbox agents take the daemon-dispatch path (find connected daemon → push `agent_job`) rather than the in-process builtin completion.

- [ ] **Step 1: Write the failing test (append to `tests/agent-sandbox-schema.test.cjs`)**

```js
test('resolveRunTarget routes sandbox to the daemon dispatch path', async () => {
  const { __test } = require('../server/index.cjs');
  assert.equal(__test.resolveRunTarget({ run_mode: 'builtin' }), 'builtin');
  assert.equal(__test.resolveRunTarget({ run_mode: 'daemon' }), 'daemon');
  assert.equal(__test.resolveRunTarget({ run_mode: 'sandbox' }), 'daemon');
  assert.equal(__test.resolveRunTarget({}), 'builtin');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/agent-sandbox-schema.test.cjs`
Expected: FAIL — `__test.resolveRunTarget is not a function`.

- [ ] **Step 3: Add the helper**

Above `runAgentTurn` (~2789) in `server/index.cjs`:

```js
// One agent turn runs in-process (builtin chat completion) or is dispatched to a
// connected daemon. 'sandbox' rides the daemon path — the daemon spins up the
// remote sandbox and supervises it — so only 'builtin' stays in-process.
function resolveRunTarget(agent) {
  return agent && agent.run_mode === 'builtin' ? 'builtin' : 'daemon';
}
```

Wait — current default is `'builtin'` when `run_mode` is neither `'daemon'` nor `'sandbox'`. Preserve that: only explicit `'daemon'`/`'sandbox'` dispatch. Use:

```js
function resolveRunTarget(agent) {
  const m = agent && agent.run_mode;
  return m === 'daemon' || m === 'sandbox' ? 'daemon' : 'builtin';
}
```

- [ ] **Step 4: Use the helper in `runAgentTurn`**

Replace `const runMode = agent.run_mode === 'daemon' ? 'daemon' : 'builtin';` (~2795) with:

```js
  const runMode = resolveRunTarget(agent);
```

The existing `if (runMode === 'builtin') { ... }` block (~2835) and the daemon-dispatch fall-through below it now correctly send sandbox agents to the daemon. The daemon receives the real `run_mode` (`'sandbox'`) via `agentRuntimePayload` from Task 1 and branches on it in Task 5/6.

- [ ] **Step 5: Export the helper**

Add `resolveRunTarget,` to `module.exports.__test` (~7574).

- [ ] **Step 6: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test tests/agent-sandbox-schema.test.cjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/index.cjs tests/agent-sandbox-schema.test.cjs
git commit -m "feat(sandbox): route sandbox run_mode to the daemon dispatch path"
```

---

### Task 3: Daemon Executor seam (LocalExecutor) — byte-identical refactor

**Files:**
- Create: `agent/agensis-cli/src/executor.mjs`
- Modify: `agent/agensis-cli/src/agensis.mjs` — call site in `runAgentJob` (~832), `__test` export (~1424)
- Test: `tests/agent-executor.test.cjs`

**Interfaces:**
- Produces:
  - `createLocalExecutor({ run } = {})` → `{ run(opts) }`. `run` defaults to `runCli` (from `./cli.mjs`); injectable for tests. Forwards `opts` unchanged and returns runCli's `{status,stdout,stderr,error}` shape.
  - `createExecutor(job, { makeProvider } = {})` → returns `createLocalExecutor()` unless `job.agent.run_mode === 'sandbox'` (Task 6 extends this branch). For Phase 0 the sandbox branch is not yet reachable via real config.

- [ ] **Step 1: Write the failing test**

```js
// tests/agent-executor.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () =>
  import(pathToFileURL(path.resolve(__dirname, '../agent/agensis-cli/src/executor.mjs')).href);

test('LocalExecutor forwards opts to the runner and returns its result', async () => {
  const { createLocalExecutor } = await load();
  const seen = [];
  const fakeRun = async (opts) => { seen.push(opts); return { status: 0, stdout: 'ok', stderr: '', error: null }; };
  const ex = createLocalExecutor({ run: fakeRun });
  const res = await ex.run({ cmd: 'claude', args: ['-p', 'hi'], cwd: '/tmp' });
  assert.equal(res.stdout, 'ok');
  assert.equal(seen[0].cmd, 'claude');
  assert.deepEqual(seen[0].args, ['-p', 'hi']);
});

test('createExecutor picks LocalExecutor for builtin/daemon', async () => {
  const { createExecutor } = await load();
  const ex = createExecutor({ agent: { run_mode: 'daemon' } });
  assert.equal(typeof ex.run, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/agent-executor.test.cjs`
Expected: FAIL — cannot find module `executor.mjs`.

- [ ] **Step 3: Create `executor.mjs` (Local + factory only)**

```js
// agent/agensis-cli/src/executor.mjs
// The single seam where an agent's coding CLI runs. LocalExecutor keeps today's
// behavior (spawn on the host). SandboxExecutor (Task 5) runs it in a remote
// sandbox via an injected provider. createExecutor picks one by run_mode.
import { runCli } from "./cli.mjs";

export function createLocalExecutor({ run = runCli } = {}) {
  return { run: (opts) => run(opts) };
}

// Extended in Task 6 to build a real provider for run_mode === 'sandbox'.
export function createExecutor(job, { makeProvider } = {}) {
  return createLocalExecutor();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test tests/agent-executor.test.cjs`
Expected: PASS.

- [ ] **Step 5: Refactor the `runAgentJob` call site**

In `agent/agensis-cli/src/agensis.mjs`, add the import near the top (with the other `./` imports, next to line 7 `import { runCli } from "./cli.mjs";`):

```js
import { createExecutor } from "./executor.mjs";
```

Replace the `const result = await runCli({ ... });` call (~832–854) with:

```js
  const executor = createExecutor(job);
  const result = await executor.run({
    cmd: command.cmd,
    args: [...command.args, prompt],
    cwd: job.cwd || config.cwd,
    timeoutMs: config.timeoutMs,
    heartbeatMs: config.heartbeatMs,
    label: "agent job",
    signal,
    job,
    onData: (chunk) => {
      if (parser) {
        parser.feed(chunk);
        fullContent = parser.live;
      } else {
        fullContent += String(chunk || "");
        latest = latestLine(`${latest}\n${chunk}`);
      }
      const now = Date.now();
      if (now - lastDeltaAt > 150) {
        lastDeltaAt = now;
        sendDelta(fullContent);
      }
    },
  });
```

(The extra `job` key is ignored by `runCli`, so `daemon`/`builtin` behavior is byte-identical.)

- [ ] **Step 6: Add `createExecutor` to the daemon `__test` export**

In `export const __test = { ... }` (~1424), add `createExecutor,`. Also `import { createLocalExecutor } from "./executor.mjs"` is not needed in agensis.mjs — only `createExecutor`.

- [ ] **Step 7: Run the full daemon test suite + syntax check**

Run: `cd agent/agensis-cli && npm run check` then `cd ../.. && node --experimental-test-module-mocks --test tests/agent-executor.test.cjs tests/agent-queue-cancel.test.mjs`
Expected: PASS — no regressions in existing daemon tests.

- [ ] **Step 8: Commit**

```bash
git add agent/agensis-cli/src/executor.mjs agent/agensis-cli/src/agensis.mjs tests/agent-executor.test.cjs
git commit -m "refactor(sandbox): route daemon coding CLI through Executor seam (byte-identical)"
```

---

### Task 4: UI — Sandbox radio option + Advanced panel

**Files:**
- Modify: `src/types/index.ts` (run_mode union), `src/hooks/useAgents.ts` (carry fields), `src/components/windows/AgentsWindowContent.tsx` (union ~94/143/550/564, selector ~823–830, Advanced panel)
- Test: `tests/agent-sandbox-schema.test.cjs` (append source-contract assertions)

**Interfaces:**
- Consumes: nothing new at runtime in Phase 0 — the panel only stores `sandbox_provider` (default `'e2b'`) + `sandbox_config` on create/edit.
- Produces: create/edit payloads include `run_mode: 'sandbox'`, `sandbox_provider`, `sandbox_config` when Sandbox is selected.

- [ ] **Step 1: Write the failing source-contract test (append)**

```js
test('AgentsWindowContent offers a Sandbox runtime option', async () => {
  const src = await readFile(path.join(root, 'src/components/windows/AgentsWindowContent.tsx'), 'utf8');
  assert.match(src, /'builtin' \| 'daemon' \| 'sandbox'/);
  assert.match(src, /value="sandbox"/);
  assert.match(src, /Advanced/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/agent-sandbox-schema.test.cjs`
Expected: FAIL — union + `value="sandbox"` not present.

- [ ] **Step 3: Widen the `run_mode` union everywhere it appears**

Replace every `'builtin' | 'daemon'` with `'builtin' | 'daemon' | 'sandbox'` in `AgentsWindowContent.tsx` (lines ~94, ~143, ~550, ~564, ~908, ~1257) and in the `Agent` type in `src/types/index.ts`. Update the two `onRunModeChange` casts (~824) so `'sandbox'` is preserved:

```tsx
onChange={e => {
  const v = e.target.value;
  onRunModeChange(v === 'daemon' ? 'daemon' : v === 'sandbox' ? 'sandbox' : 'builtin');
}}
```

- [ ] **Step 4: Add the radio option + Advanced panel**

After the `<NativeSelectOption value="daemon">Remote daemon</NativeSelectOption>` (~830) add:

```tsx
          <NativeSelectOption value="sandbox">Sandbox (isolated cloud)</NativeSelectOption>
```

Add state next to `newRunMode` (~143): `const [newSandboxProvider, setNewSandboxProvider] = useState('e2b');` and `const [newSandboxConfig, setNewSandboxConfig] = useState('{}');`. Render, only when `runMode === 'sandbox'`, a collapsed Advanced disclosure (match the file's existing disclosure/section components — use whatever the file already uses for collapsible sections; if none, a `<details>`):

```tsx
{runMode === 'sandbox' && (
  <details>
    <summary>Advanced</summary>
    <label>Provider
      <select value={sandboxProvider} onChange={e => onSandboxProviderChange(e.target.value)}>
        <option value="e2b">e2b (default)</option>
        <option value="vercel" disabled>Vercel Sandbox (coming soon)</option>
        <option value="daytona" disabled>Daytona (coming soon)</option>
        <option value="morph" disabled>Morph (coming soon)</option>
      </select>
    </label>
    <label>Config (JSON)
      <textarea value={sandboxConfig} onChange={e => onSandboxConfigChange(e.target.value)} placeholder='{"template":"base"}' />
    </label>
  </details>
)}
```

Thread `sandboxProvider`, `sandboxConfig`, `onSandboxProviderChange`, `onSandboxConfigChange` through the same prop plumbing that `runMode`/`onRunModeChange` already use (create form ~279, edit forms ~449/~995/~1384). Include them in the create/update payloads (~210, ~934, ~1317) as `sandbox_provider` and `sandbox_config: JSON.parse(sandboxConfig || '{}')`. Default `sandbox_provider` to `'e2b'` so picking Sandbox with no Advanced interaction Just Works.

- [ ] **Step 5: Run test + typecheck**

Run: `node --experimental-test-module-mocks --test tests/agent-sandbox-schema.test.cjs` then `npx tsc -p tsconfig.app.json --noEmit`
Expected: test PASS; no new type errors.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/hooks/useAgents.ts src/components/windows/AgentsWindowContent.tsx tests/agent-sandbox-schema.test.cjs
git commit -m "feat(sandbox): add Sandbox runtime option + Advanced provider/config panel"
```

**Phase 0 done: `run_mode='sandbox'` selectable, stored, routed to the daemon, seam in place. Behavior of builtin/daemon unchanged. Nothing runs in a sandbox yet.**

---

# PHASE 1 — e2b provider (daemon-orchestrated). First shippable slice.

### Task 5: SandboxExecutor orchestration (fake provider, no network)

**Files:**
- Modify: `agent/agensis-cli/src/executor.mjs`
- Test: `tests/agent-executor.test.cjs` (append)

**Interfaces:**
- Consumes: a `provider` object with `ensureEnv({job,signal}) → handle`, `putRepo(handle,{job,signal})`, `exec(handle,{cmd,args,onData,signal}) → {status,stdout,stderr,error}`, `getResult(handle,{job}) → {patch}`, `destroy(handle)`.
- Produces: `createSandboxExecutor(provider)` → `{ run(opts) }`. `run` calls the provider in order ensureEnv→putRepo→exec→getResult→destroy, forwards `onData` to `exec`, folds `patch` into stdout as a fenced diff, always calls `destroy` (even on throw), and returns the `runCli`-shaped `{status,stdout,stderr,error}`.

- [ ] **Step 1: Write the failing test (append to `tests/agent-executor.test.cjs`)**

```js
function fakeProvider(overrides = {}) {
  const calls = [];
  const p = {
    calls,
    ensureEnv: async () => { calls.push('ensureEnv'); return { id: 'sbx' }; },
    putRepo: async () => { calls.push('putRepo'); },
    exec: async (_h, { onData }) => { calls.push('exec'); onData?.('streamed '); onData?.('tokens'); return { status: 0, stdout: 'streamed tokens', stderr: '', error: null }; },
    getResult: async () => { calls.push('getResult'); return { patch: 'diff --git a b' }; },
    destroy: async () => { calls.push('destroy'); },
    ...overrides,
  };
  return p;
}

test('SandboxExecutor runs the provider lifecycle in order and folds the diff into stdout', async () => {
  const { createSandboxExecutor } = await load();
  const streamed = [];
  const p = fakeProvider();
  const ex = createSandboxExecutor(p);
  const res = await ex.run({ cmd: 'claude', args: ['-p', 'go'], onData: (c) => streamed.push(c) });
  assert.deepEqual(p.calls, ['ensureEnv', 'putRepo', 'exec', 'getResult', 'destroy']);
  assert.deepEqual(streamed, ['streamed ', 'tokens']);
  assert.match(res.stdout, /streamed tokens/);
  assert.match(res.stdout, /```diff\ndiff --git a b\n```/);
  assert.equal(res.status, 0);
});

test('SandboxExecutor always destroys the sandbox, even when exec throws', async () => {
  const { createSandboxExecutor } = await load();
  const p = fakeProvider({ exec: async () => { throw new Error('boom'); } });
  const ex = createSandboxExecutor(p);
  const res = await ex.run({ cmd: 'claude', args: [] });
  assert.ok(p.calls.includes('destroy'));
  assert.match(res.error.message, /boom/);
  assert.equal(res.status, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/agent-executor.test.cjs`
Expected: FAIL — `createSandboxExecutor` is not exported.

- [ ] **Step 3: Implement `createSandboxExecutor` in `executor.mjs`**

```js
export function createSandboxExecutor(provider) {
  return {
    async run({ cmd, args = [], onData, signal, job }) {
      let handle = null;
      try {
        handle = await provider.ensureEnv({ job, signal });
        await provider.putRepo(handle, { job, signal });
        const exec = await provider.exec(handle, { cmd, args, onData, signal });
        const result = await provider.getResult(handle, { job }).catch(() => ({}));
        const patch = result && result.patch ? String(result.patch).trim() : "";
        const stdout = patch
          ? `${exec.stdout || ""}\n\n\`\`\`diff\n${patch}\n\`\`\``
          : exec.stdout || "";
        return { status: exec.status, stdout, stderr: exec.stderr || "", error: exec.error || null };
      } catch (error) {
        return { status: null, stdout: "", stderr: "", error };
      } finally {
        if (handle) { try { await provider.destroy(handle); } catch { /* teardown must never throw */ } }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test tests/agent-executor.test.cjs`
Expected: PASS (all four executor tests).

- [ ] **Step 5: Commit**

```bash
git add agent/agensis-cli/src/executor.mjs tests/agent-executor.test.cjs
git commit -m "feat(sandbox): SandboxExecutor lifecycle orchestration with guaranteed teardown"
```

---

### Task 6: Wire the factory to build the e2b provider for sandbox mode

**Files:**
- Modify: `agent/agensis-cli/src/executor.mjs`
- Test: `tests/agent-executor.test.cjs` (append)

**Interfaces:**
- Consumes: `job.agent.run_mode`, `job.agent.sandbox_provider`, `job.agent.sandbox_config`, and daemon env (`process.env.E2B_API_KEY`, `ANTHROPIC_API_KEY`, `GIT_TOKEN`), plus a repo URL from `job` / config.
- Produces: `createExecutor(job, { makeProvider })` returns a `SandboxExecutor` when `job.agent.run_mode === 'sandbox'`, using `makeProvider(job)` (injectable) or the default e2b provider factory.

- [ ] **Step 1: Write the failing test (append)**

```js
test('createExecutor builds a SandboxExecutor for run_mode sandbox using makeProvider', async () => {
  const { createExecutor } = await load();
  let built = 0;
  const provider = fakeProvider();
  const ex = createExecutor(
    { agent: { run_mode: 'sandbox', sandbox_provider: 'e2b', sandbox_config: {} } },
    { makeProvider: () => { built++; return provider; } },
  );
  await ex.run({ cmd: 'claude', args: [] });
  assert.equal(built, 1);
  assert.ok(provider.calls.includes('ensureEnv'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/agent-executor.test.cjs`
Expected: FAIL — factory still always returns LocalExecutor, so `built === 0`.

- [ ] **Step 3: Extend `createExecutor`**

Replace the Phase-0 stub body with:

```js
export function createExecutor(job, { makeProvider } = {}) {
  const runMode = job && job.agent && job.agent.run_mode;
  if (runMode === "sandbox") {
    const factory = makeProvider || defaultSandboxProviderFactory;
    return createSandboxExecutor(factory(job));
  }
  return createLocalExecutor();
}

// Default factory: builds a provider from job.agent.sandbox_provider + env secrets.
// Kept out of the hot path so tests inject their own via makeProvider.
function defaultSandboxProviderFactory(job) {
  const providerName = (job.agent && job.agent.sandbox_provider) || "e2b";
  const config = (job.agent && job.agent.sandbox_config) || {};
  if (providerName !== "e2b") {
    throw new Error(`Sandbox provider "${providerName}" is not available yet (only e2b is wired).`);
  }
  // Lazy import so the e2b dep loads only when actually used.
  return createE2bProviderLazy({
    apiKey: process.env.E2B_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    gitToken: process.env.GIT_TOKEN || "",
    repoUrl: job.repoUrl || (job.agent && job.agent.repo_url) || config.repoUrl || "",
    template: config.template || "",
  });
}

function createE2bProviderLazy(opts) {
  // Defer the require so `import('./executor.mjs')` in unit tests never pulls e2b.
  let real = null;
  const ensureReal = async () => {
    if (!real) {
      const mod = await import("./sandbox/e2b.mjs");
      real = mod.createE2bProvider(opts);
    }
    return real;
  };
  return {
    ensureEnv: async (a) => (await ensureReal()).ensureEnv(a),
    putRepo: async (h, a) => (await ensureReal()).putRepo(h, a),
    exec: async (h, a) => (await ensureReal()).exec(h, a),
    getResult: async (h, a) => (await ensureReal()).getResult(h, a),
    destroy: async (h) => (await ensureReal()).destroy(h),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test tests/agent-executor.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/agensis-cli/src/executor.mjs tests/agent-executor.test.cjs
git commit -m "feat(sandbox): factory builds e2b provider for run_mode=sandbox (lazy-loaded)"
```

---

### Task 7: e2b provider adapter (the network I/O)

**Files:**
- Create: `agent/agensis-cli/src/sandbox/e2b.mjs`
- Modify: `agent/agensis-cli/package.json` (add `e2b` dep)
- Test: `tests/agent-sandbox-e2b.test.cjs` (uses `--experimental-test-module-mocks`)

**Interfaces:**
- Produces: `createE2bProvider({ apiKey, anthropicApiKey, gitToken, repoUrl, template })` implementing the provider contract from Task 5.

- [ ] **Step 1: Verify the current e2b Node SDK API before writing the adapter**

⚠️ This is the one task whose code depends on an external SDK. Do **not** guess the method names — confirm them first:

Run: `npm view e2b version` and fetch the current quickstart:
- `WebFetch https://e2b.dev/docs` (or `WebSearch "e2b Node SDK Sandbox.create commands.run onStdout kill"`).

Confirm the shapes for: create a sandbox (`Sandbox.create(template?, { apiKey, envs })`), run a command with a streamed stdout callback (`sandbox.commands.run(cmd, { cwd, onStdout, onStderr })` → `{ exitCode, stdout, stderr }`), and terminate (`sandbox.kill()`). Adjust the code in Step 4 to match the installed version.

- [ ] **Step 2: Add the dependency**

```bash
cd agent/agensis-cli && npm install e2b@latest && cd ../..
```

Confirm `e2b` now appears under `dependencies` in `agent/agensis-cli/package.json` and add it to the `files`/bundling allowlist if the `agensis-agent` build step needs it (check `agent/agensis-agent/build.mjs`).

- [ ] **Step 3: Write the failing test (module-mocked e2b)**

```js
// tests/agent-sandbox-e2b.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('e2b provider clones the repo, runs the CLI with streamed stdout, reads the diff, and kills', async () => {
  const runCalls = [];
  let killed = false;
  const fakeSandbox = {
    commands: {
      run: async (cmd, opts = {}) => {
        runCalls.push(cmd);
        if (/git diff/.test(cmd)) return { exitCode: 0, stdout: 'diff --git a b', stderr: '' };
        if (opts.onStdout) { opts.onStdout('hello '); opts.onStdout('world'); }
        return { exitCode: 0, stdout: 'hello world', stderr: '' };
      },
    },
    kill: async () => { killed = true; },
  };
  test.mock.module('e2b', {
    namedExports: { Sandbox: { create: async () => fakeSandbox } },
  });
  const mod = await import(pathToFileURL(path.resolve(__dirname, '../agent/agensis-cli/src/sandbox/e2b.mjs')).href);
  const provider = mod.createE2bProvider({ apiKey: 'k', anthropicApiKey: 'a', repoUrl: 'https://github.com/x/y.git' });

  const streamed = [];
  const handle = await provider.ensureEnv({ job: {} });
  await provider.putRepo(handle, { job: {} });
  const exec = await provider.exec(handle, { cmd: 'claude', args: ['-p', 'go'], onData: (c) => streamed.push(c) });
  const result = await provider.getResult(handle, { job: {} });
  await provider.destroy(handle);

  assert.ok(runCalls.some((c) => /git clone/.test(c)));
  assert.ok(runCalls.some((c) => /claude/.test(c)));
  assert.deepEqual(streamed, ['hello ', 'world']);
  assert.equal(exec.status, 0);
  assert.match(result.patch, /diff --git a b/);
  assert.equal(killed, true);
});
```

Run: `node --experimental-test-module-mocks --test tests/agent-sandbox-e2b.test.cjs`
Expected: FAIL — `e2b.mjs` does not exist.

- [ ] **Step 4: Write the adapter (adjust method names per Step 1)**

```js
// agent/agensis-cli/src/sandbox/e2b.mjs
// e2b provider: run the coding CLI inside a Firecracker microVM. Ephemeral —
// created per job, killed on teardown. Reads the repo via git clone, returns the
// resulting `git diff` as the artifact. All method names below are the current
// e2b Node SDK surface — reconfirm with `npm view e2b` before editing.
import { Sandbox } from "e2b";

const REPO_DIR = "/home/user/repo";

function shellQuote(a) {
  return `'${String(a).replace(/'/g, `'\\''`)}'`;
}

export function createE2bProvider({ apiKey, anthropicApiKey, gitToken = "", repoUrl = "", template = "" } = {}) {
  if (!apiKey) throw new Error("E2B_API_KEY is not set on the daemon host.");
  if (!repoUrl) throw new Error("Sandbox needs a repo URL (set sandbox_config.repoUrl or the agent's repo).");
  return {
    async ensureEnv() {
      const sbx = await Sandbox.create(template || undefined, {
        apiKey,
        envs: anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {},
      });
      // Ensure git + the claude CLI exist (MVP: install-on-boot, no baked template).
      await sbx.commands.run("bash -lc 'command -v claude >/dev/null || npm i -g @anthropic-ai/claude-code'");
      return { sbx, dir: REPO_DIR };
    },
    async putRepo(handle) {
      const authed = gitToken
        ? repoUrl.replace(/^https:\/\//, `https://x-access-token:${gitToken}@`)
        : repoUrl;
      const res = await handle.sbx.commands.run(`git clone ${shellQuote(authed)} ${shellQuote(handle.dir)}`);
      if (res.exitCode !== 0) throw new Error(`git clone failed: ${res.stderr || res.exitCode}`);
    },
    async exec(handle, { cmd, args = [], onData }) {
      const full = `${cmd} ${args.map(shellQuote).join(" ")}`;
      const res = await handle.sbx.commands.run(full, {
        cwd: handle.dir,
        onStdout: (d) => { try { onData?.(d); } catch { /* stream tracker must not break the run */ } },
      });
      return { status: res.exitCode, stdout: res.stdout || "", stderr: res.stderr || "", error: null };
    },
    async getResult(handle) {
      const res = await handle.sbx.commands.run("git add -A && git diff --cached", { cwd: handle.dir });
      return { patch: res.stdout || "" };
    },
    async destroy(handle) {
      await handle.sbx.kill();
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test tests/agent-sandbox-e2b.test.cjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/agensis-cli/src/sandbox/e2b.mjs agent/agensis-cli/package.json agent/agensis-cli/package-lock.json tests/agent-sandbox-e2b.test.cjs
git commit -m "feat(sandbox): e2b provider adapter (clone -> run claude -> diff -> kill)"
```

---

### Task 8: End-to-end verification (one real sandbox run)

**Files:** none (verification + a short note).

- [ ] **Step 1: Set daemon env**

```bash
export E2B_API_KEY=...        # from e2b.dev
export ANTHROPIC_API_KEY=...  # so `claude` can auth inside the sandbox
```

- [ ] **Step 2: Create a Sandbox agent**

In the app: create an agent, pick **Sandbox**, open **Advanced**, set Config `{"repoUrl":"https://github.com/<you>/<test-repo>.git","template":"base"}`. Save. Ensure the daemon is running and connected.

- [ ] **Step 3: Give it a trivial task**

DM the agent: "Add a line to README.md saying 'sandbox works' and show me the diff."

- [ ] **Step 4: Verify the observable outcome**

Expected: the chat streams the CLI's tokens (proving `onData→sendDelta` works from inside the sandbox), then the final message ends with a ```` ```diff ```` block showing the README change. The e2b dashboard shows a sandbox that was created and then killed (no leak).

- [ ] **Step 5: Commit the verification note**

```bash
# Append a short "Verified <date>: e2b sandbox run streamed + returned a diff" line
git add docs/superpowers/plans/2026-07-12-agent-sandbox-execution.md
git commit -m "docs(sandbox): record Phase 1 e2b end-to-end verification"
```

**Phase 1 done: an agent set to Sandbox runs its coding CLI in a fresh e2b microVM, streams output to chat, and returns a diff. Drivers A (isolation) + B (ephemeral cloud) shipped. Daytona/Morph are later providers behind the same Advanced dropdown — no seam changes.**

---

## Self-Review

**Spec coverage:**
- Default UX (one radio, e2b default, no thinking) → Task 4. ✅
- Advanced disclosure (provider + config) → Task 4. ✅
- The seam / `Executor` refactor → Task 3. ✅
- `run_mode='sandbox'` + `sandbox_provider` + `sandbox_config` columns → Task 1. ✅
- e2b provider (clone → run → stream → diff → destroy) → Tasks 5–7. ✅
- Diff-out into chat → Task 5 (fold) + Task 8 (verify). ✅
- Providers appear but marked "coming soon" → Task 4 (`disabled` options). ✅
- **Spec Fork 1 (server-orchestrated) is explicitly overridden** to daemon-orchestrated with rationale in the Finding section — flagged for Jason, not silently changed. Server-orchestration + `workspace_secrets`-injected keys move to a future phase.
- Out of scope (Vercel/Daytona/Morph runtime, desktop streaming, billing/quota) → untouched. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above". The only externally-dependent code (Task 7 e2b SDK calls) is gated behind an explicit "verify the SDK API first" step — that is a real action, not a placeholder.

**Type/name consistency:** `createExecutor`, `createLocalExecutor`, `createSandboxExecutor`, provider methods `ensureEnv/putRepo/exec/getResult/destroy`, `resolveRunTarget`, `agentRuntimePayload` — used identically across Tasks 1–8. Provider `exec` returns `{status,stdout,stderr,error}` (matching `runCli`); `getResult` returns `{patch}`; consistent everywhere.

**Open risk to watch:** the e2b SDK method names in Task 7 are the current surface but must be reconfirmed at execution time (Step 1 of Task 7). Everything else is unit-tested against fakes/mocks with no network.
