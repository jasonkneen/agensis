# Amp Orb Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote runtime selection explicit, capability-backed, and fail-closed so an Amp agent can never execute through the Claude Agent SDK.

**Architecture:** `run_mode` selects Built-in versus Remote; `metadata.runtime` selects the remote executor. The daemon discovers supported executors, locks each connection profile to one selected runtime, and the server validates that selection at registration and dispatch.

**Tech Stack:** React 19, TypeScript, Node.js/CommonJS backend, Node.js ESM daemon, WebSocket capability sync, Node test runner, Vitest.

## Global Constraints

- No database schema change; use `workspace_agents.metadata.runtime`.
- Preserve legacy remote agents that have no selected runtime.
- An explicit Amp selection never falls back to Claude, Codex, or a custom CLI.
- Do not republish daemon version `0.1.32`; release this work under a new version.
- Do not run a real paid Amp orb in automated verification.

---

### Task 1: Runtime-locked daemon profiles

**Files:**
- Modify: `../agensis-agent/packages/agensis-cli/bin/agensis.mjs`
- Modify: `../agensis-agent/packages/agensis-cli/src/agensis.mjs`
- Modify: `../agensis-agent/packages/agensis-cli/src/connectProfiles.mjs`
- Test: `../agensis-agent/tests/amp-runtime.test.mjs`
- Test: `../agensis-agent/tests/agensis-cli-profiles.test.cjs`
- Test: `../agensis-agent/tests/daemon-wire-contract.test.cjs`

**Interfaces:**
- Consumes: CLI `--runtime claude|codex|amp`.
- Produces: persisted `config.runtime`, registration `metadata.executionRuntime`, and runtime-mismatch job errors.

- [ ] Add failing tests proving `--runtime amp` persists, declares Amp, refuses a normal job, and never invokes the configured coding command.
- [ ] Add runtime parsing and validation; infer `claude` or `codex` only for legacy profiles without the flag.
- [ ] Keep `metadata.runtime='agensis'` for wire compatibility and add the distinct `metadata.executionRuntime` field.
- [ ] Gate `runAgentJob`: the selected profile runtime must match the dispatched job runtime before any warm executor is requested.
- [ ] Run `npm test -- --test-name-pattern='Amp|profile|wire'` and confirm the new tests pass.

### Task 2: Capability-backed runtime catalog

**Files:**
- Modify: `../agensis-agent/packages/agensis-cli/src/agensis.mjs`
- Modify: `server/agent-connections.cjs`
- Modify: `src/types/index.ts`
- Test: `../agensis-agent/tests/amp-runtime.test.mjs`
- Test: `tests/amp-runtime.test.cjs`

**Interfaces:**
- Consumes: discovered `claude`, `codex`, and Amp preflight state.
- Produces: bounded `capabilities.runtimes[id]` descriptors with `id`, `label`, `available`, and stable failure details.

- [ ] Add failing daemon tests for all three normalized runtime descriptors.
- [ ] Advertise Claude and Codex from executable discovery and Amp from its structured preflight.
- [ ] Add failing server tests proving unknown runtime ids and fields are discarded.
- [ ] Sanitize the runtime catalog at capability ingestion and expose the bounded result to browsers.
- [ ] Run both focused runtime test files and confirm they pass.

### Task 3: Server registration and command fail-closed contract

**Files:**
- Modify: `server/index.cjs`
- Modify: `server/agent-connections.cjs`
- Modify: `server/builtin-turn.cjs`
- Test: `tests/amp-runtime.test.cjs`
- Test: the existing connection-command and agent-connection tests selected by `npm test`.

**Interfaces:**
- Consumes: stored `agent.metadata.runtime` and daemon `metadata.executionRuntime`.
- Produces: `agensis connect --runtime <id>` and registration refusal on explicit mismatch.

- [ ] Add failing tests proving an Amp agent's command contains `--runtime amp`, explicit mismatches are rejected, and legacy unselected agents remain accepted.
- [ ] Derive the generated flag only from the server-stored agent runtime; never accept a caller-provided override.
- [ ] Validate explicit runtime selection before inserting `agent_connections`.
- [ ] Select only a matching live connection for runtime-specific dispatch and retain the existing Amp capability preflight.
- [ ] Run focused backend tests and `node --check server/index.cjs`.

### Task 4: Separate location, runtime, and model in the Agents UI

**Files:**
- Modify: `src/lib/agentTemplates.ts`
- Modify: `src/components/windows/AgentsWindowContent.tsx`
- Modify: `src/types/index.ts`
- Test: `tests/unit/agentTemplates.test.ts`
- Test: a focused source/behavior test under `tests/unit/` for runtime option aggregation and form persistence.

**Interfaces:**
- Consumes: `AgentConnection.capabilities.runtimes` and template `runtime`.
- Produces: ordered Location → Runtime → Model controls and persisted `metadata.runtime`.

- [ ] Add failing tests for runtime catalog aggregation, template preselection, create persistence, and edit sparse updates.
- [ ] Add an explicit `runtime` field to daemon templates; set the Amp template to `amp`.
- [ ] Render Built-in/Remote first, a capability-backed runtime selector for Remote second, and Model third.
- [ ] Keep the selected runtime visible with setup-required copy when no connected host reports it ready.
- [ ] Run the focused Vitest files.

### Task 5: Conversation continuity and rollout verification

**Files:**
- Modify: `server/builtin-turn.cjs`
- Test: `tests/amp-runtime.test.cjs`
- Modify: `public/release-notes.json`

**Interfaces:**
- Consumes: a DM session id or stable channel thread parent.
- Produces: one durable Amp thread per DM and one per channel thread.

- [ ] Add failing tests showing two top-level turns in one DM load the same Amp binding while separate DMs do not.
- [ ] Normalize the Amp lane key to a DM sentinel for direct-message sessions and the stable thread parent for channel threads.
- [ ] Update release notes with explicit runtime selection and fail-closed behavior.
- [ ] Run daemon `npm run verify`.
- [ ] Run app `npm run ci`, `node --check server/index.cjs`, and `npm run build`.
- [ ] Commit both clean worktrees; push the authorized Agensis feature branch only.
- [ ] Deploy Fly only after confirming the diff is backward-compatible and existing unselected agents remain on the legacy path.
