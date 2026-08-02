# Automation Run Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every automation step has at-most-once committed effects across crashes, lease reclamation, stale workers, and definition edits.

**Architecture:** Snapshot each validated definition onto its run at enqueue. Use the existing `automation_runs.steps` JSON array as a durable ledger: lock and fence the run, execute one local side effect, and append its result inside one PostgreSQL transaction. Fence final settlement by claim token and inflight status, and update aggregate counters only after the fenced settlement succeeds.

**Tech Stack:** Node.js CommonJS, postgres.js transactions, PostgreSQL JSONB, Node test runner.

## Global Constraints

- Keep `AUTOMATION_MAX_RUNS_PER_TICK = 20`, the one-second drain worker, and the 30-second lease sweep unchanged.
- Keep the closed action set (`post_message`, `create_task`), cycle brakes, feature flag, and no-model-call invariant unchanged.
- Do not change the existing terminal `error` retry policy; this batch only repairs crash/lease recovery.
- Add no dependency and no automation bookkeeping column to `messages` or `tasks`.
- Preserve all existing uncommitted workspace-isolation/FK work and create no commit unless explicitly requested.

---

### Task 1: Add failing lease and idempotency regressions

**Files:**
- Modify: `tests/automations.test.cjs`

**Interfaces:**
- Consumes: `createAutomations()` and its `runOneAutomation`, `finishRun`, and step-runner behavior.
- Produces: regression coverage for stale claims, atomic effects, resume, definition snapshots, counters, and post-commit fanout.

- [ ] **Step 1: Make the fake database transaction-aware**

Add `begin(callback)` that records transaction boundaries and invokes `callback(db)`, while retaining emitted SQL assertions as the source of truth.

- [ ] **Step 2: Add a stale-step fence test**

Make the fenced `SELECT ... FOR UPDATE` return no row and assert no message/task insert, settlement, or counter update occurs.

- [ ] **Step 3: Add atomic checkpoint and resume tests**

Assert the effect insert occurs between transaction begin and the `automation_runs.steps` append, and that a pre-existing successful result skips that step while the next step executes once.

- [ ] **Step 4: Add definition snapshot and settlement tests**

Assert enqueue binds the definition, the runner prefers `run.definition`, settlement includes `claim_token` plus `status = 'inflight'`, and a failed settlement cannot update counters.

- [ ] **Step 5: Run the focused test and confirm the new assertions fail**

Run: `node --require ./tests/helpers/test-env.cjs --test tests/automations.test.cjs`

Expected: failures showing unconditional effects, unfenced settlement, no definition snapshot, and counters before settlement.

### Task 2: Add the deploy-safe definition snapshot schema

**Files:**
- Modify: `database/neon-schema.sql`
- Modify: `server/index.cjs`
- Create: `supabase/migrations/20260802130000_automation_run_definition.sql`
- Modify: `tests/automations-surface.test.cjs`

**Interfaces:**
- Produces: nullable `automation_runs.definition jsonb`; null identifies an old run and falls back to the prior live-definition behavior.

- [ ] **Step 1: Extend three-place schema tests**

Require `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS definition jsonb` in canonical schema, runtime DDL, and the forward migration.

- [ ] **Step 2: Add the nullable column in every schema owner**

Use an additive nullable column with no default or backfill, keeping old-code/new-schema and new-code/old-row deployment order safe.

- [ ] **Step 3: Run schema tests**

Run: `node --require ./tests/helpers/test-env.cjs --test tests/automations-surface.test.cjs`

Expected: PASS.

### Task 3: Execute and checkpoint each step transactionally

**Files:**
- Modify: `server/automations.cjs`

**Interfaces:**
- Produces: `runAutomationStep(step, stepIndex, run, payload)` returning either a durable result or a claim-lost sentinel.
- Changes step runners to accept a database executor so target validation and inserts use the same transaction.

- [ ] **Step 1: Snapshot the definition during enqueue**

Insert `definition` alongside payload using the already validated/parsed definition for the matched automation.

- [ ] **Step 2: Add the fenced transaction helper**

Inside `getDb().begin`, select the run by id/token/inflight/live lease `FOR UPDATE`; reuse an existing ledger entry; otherwise execute the step, append one result to `steps`, and refresh the lease. Throw if the checkpoint update unexpectedly matches no row so the effect transaction rolls back.

- [ ] **Step 3: Defer notifications until commit**

Return effect rows from the transaction and call `notifyDbSubscribers` only after `begin()` resolves. Keep the best-effort channel timestamp update after commit.

- [ ] **Step 4: Resume from the ledger and stop stale workers**

Prefer the snapshotted definition when present. Replay ledger results without side effects; if the fence is lost, return a non-null synthesized result so the bounded drain continues but do not settle or update counters.

### Task 4: Fence settlement and aggregate counters

**Files:**
- Modify: `server/automations.cjs`

**Interfaces:**
- Changes `finishRun` to consume the claimed run (including its token), not only its id.

- [ ] **Step 1: Fence settlement**

Update only where `id`, `claim_token`, and `status = 'inflight'` still match. Keep a non-null fallback result when the row was deleted or ownership changed so the drain does not abort.

- [ ] **Step 2: Move counters after settlement**

Increment `run_count`/`fail_count` only when the fenced settlement returned a database row. A stale worker must not change run history or aggregate status.

- [ ] **Step 3: Run focused automation tests**

Run:

```bash
node --require ./tests/helpers/test-env.cjs --test \
  tests/automations.test.cjs \
  tests/automations-surface.test.cjs \
  tests/automations-worker-cadence.test.cjs
```

Expected: PASS, including unchanged cadence constants and bounds.

### Task 5: Review and verify the complete batch

**Files:**
- Review all modified automation/schema/test files and the pre-existing uncommitted isolation/FK files.

- [ ] **Step 1: Run static checks**

Run: `node --check server/automations.cjs && node --check server/index.cjs && git diff --check`

- [ ] **Step 2: Run the repository gate**

Run: `npm run ci`

Expected: typecheck, backend tests, unit tests, smoke tests, and lint all pass.

- [ ] **Step 3: Independent review**

Review for crash windows, stale-worker writes, transaction rollback behavior, old-row fallback, post-commit fanout, and preservation of the bounded drain/sweep invariants. Apply only high-confidence fixes, then rerun focused tests and `git diff --check`.
