# Amp Orb Runtime Implementation Plan

## Goal

Let an Agensis daemon agent run a persistent Amp thread in an Amp-managed orb,
stream the turn into its Agensis chat, and continue the same Amp thread on later
turns. Amp authentication, project access, billing, and subprocess execution stay
on the machine running `agensis-agent`.

## Contract

- An Amp agent is still a daemon agent. Its `workspace_agents.metadata.runtime`
  is `amp`; the browser and backend never run the Amp CLI.
- A conversation lane is `(workspace, agent, session, thread parent)`. The latest
  successful job in that lane carries `ampThreadId` and `ampThreadUrl` in its
  metadata and is the durable continuation binding.
- The first turn runs `amp -o -x <prompt> --stream-json` in the connected repo.
  Later turns run `amp threads continue <thread-id> -x <prompt> --stream-json`.
- A missing previous Amp thread is an error. It never silently creates a new
  thread, and Amp failures never fall back to Claude, Codex, or another runtime.
- The daemon advertises Amp availability and its structured reason through the
  existing capabilities snapshot.

## Phase 1 — daemon runtime

1. Add a focused Amp runtime module with command construction, a non-provisioning
   preflight, repository/cwd validation, stream thread-id extraction, and a closed
   error-code mapping.
2. Add fake-CLI tests for new and continued turns, streaming, missing Amp,
   unsupported capability, auth/project failures, timeout/cancel, and no fallback.
3. Route jobs whose agent metadata selects `runtime: amp` through that module.
   Keep the existing job delta/step/segment/result wire; add sanitized result
   metadata containing only runtime, thread ID, URL, and error code.
4. Include the Amp runtime state in daemon capability snapshots.

## Phase 2 — hub persistence and UI

1. Add the Amp template as a thin daemon profile. Store only `runtime: amp` in
   agent metadata; no shell command, credential, or project token enters the app.
2. Before dispatch, load the latest successful Amp job for the exact lane and
   send its thread ID to the daemon. Merge sanitized daemon result metadata into
   the terminal job row.
3. Extend capability ingestion/types and the agent detail pane to show Amp
   available/unavailable, version, reason, and the connected repo.
4. Surface a safe Amp thread link from job metadata in the existing work feed or
   message result without rendering arbitrary daemon URLs.

## Phase 3 — remove the incorrect webhook “Orbs” surface

1. Keep historical migrations immutable and retain generic inbound agent
   webhooks.
2. Remove Orb-specific webhook configuration, routing/provider/signing-secret UI,
   routes, dispatch composition, and vault labels.
3. Leave old table columns/data dormant; do not drop production data.

## Verification

- Daemon: focused Amp tests, then `npm test`, `npm run test:unit`, `npm run check`,
  and `npm run build`.
- App: focused backend/frontend tests, `node --check server/index.cjs`,
  `npm run ci`, and `npm run build`.
- Optional real-orb smoke only with explicit approval because it can consume Amp
  credit. Routine tests use fake Amp executables.
