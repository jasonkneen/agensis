# Remote Agent Runtime Selection

## Outcome

Agensis separates where an agent runs from which executor handles its turns.
Creating or editing an agent first selects `Built-in` or `Remote`. A remote
agent then selects a runtime discovered by `agensis-agent`; the model selector
comes after the runtime. An Amp template preselects the `amp` runtime, but its
name and handle remain ordinary editable identity fields.

## Runtime contract

- `workspace_agents.run_mode` remains the execution location: `builtin` or
  `daemon`. No schema change is required.
- `workspace_agents.metadata.runtime` stores the selected remote runtime. The
  first supported ids are `claude`, `codex`, and `amp`.
- `agensis-agent` advertises a bounded descriptor for each supported runtime in
  `agent_connections.capabilities.runtimes`. Discovery reports unavailable
  runtimes with a stable reason instead of omitting them.
- A daemon profile may select one runtime with `--runtime <id>`. The selection
  is persisted in the local profile and declared during `agent_register`.
- The generated connect command derives `--runtime` from the stored agent. A
  daemon declaration is an assertion, not permission to rewrite an existing
  agent's configuration.
- The server rejects a selected-runtime mismatch before registering the
  connection or dispatching work. An Amp profile rejects every non-Amp job and
  never initializes the Claude Agent SDK.
- Legacy remote agents without `metadata.runtime`, and old daemons without a
  runtime declaration, retain today's configured coding-command behavior.
  Compatibility does not apply to an agent explicitly selecting `amp`.

## UI contract

The create/edit form shows controls in this order:

1. Location: `Built-in` or `Remote`.
2. Runtime, only for Remote: capability-backed `Claude`, `Codex`, or `Amp`.
3. Model, filtered or labelled for the selected runtime.

The workspace runtime catalog is the union of connected daemon capability
snapshots. A selected or template-required runtime remains visible when no host
is ready, with a setup-required state. This lets a user configure an agent
before connecting the machine that will run it.

Templates declare a `runtime` requirement directly. Instantiating the Amp
template writes `run_mode='daemon'` and `metadata.runtime='amp'`; renaming the
agent cannot alter that requirement.

## Amp lifecycle

- First message in a DM or channel thread starts `amp -o -x ... --stream-json`.
- Later messages in that same conversation lane continue the returned Amp
  thread with `amp threads continue <id> -x ... --stream-json`.
- One DM maps to one Amp thread. One channel thread maps to one Amp thread.
- Installation, authentication, account, project matching, credit, setup,
  timeout, cancellation, malformed stream, and missing-thread failures are
  reported as stable Amp errors. None falls back to another executor.
- Amp authentication, billing, repository access, and process execution remain
  on the connected host. Agensis stores only the validated thread id and URL.

## Skills

Runtime discovery and skill discovery remain separate capabilities. A template
can preconfigure skill ids. Repository-committed `.agents/skills` and
`.claude/skills` files are naturally present when Amp clones the repository.
Host-only or workspace-stored skill bodies are not claimed to exist inside an
orb until an explicit, scoped bridge is implemented.

## Safe rollout

Deploy the backward-compatible Fly backend before exposing the preview UI.
Existing unconfigured remote agents continue unchanged. The preview UI then
creates runtime-selected agents and generates runtime-locked commands. The
daemon package is released under a new version; version `0.1.32` is not
republished. A real paid orb smoke test requires explicit approval.
