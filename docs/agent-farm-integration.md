# Agent Farm integration

Agensis is the workspace and relay for humans and agents. Agent Farm is an
optional distributed execution control plane that discovers workspace agents,
provisions managed sandboxes, dispatches coding jobs, and exposes shared models
through an OpenAI-compatible gateway.

## Trust boundary

Farm pairs through a short-lived device code. A signed-in workspace manager
selects the workspace and approves these scopes:

- `workspace:read`
- `agents:read`
- `agents:enroll`
- `agents:dispatch`
- `models:read`
- `models:invoke`

The exchanged `agf_` token is stored as a SHA-256 hash by Agensis. The plaintext
exists only in the paired Farm controller. Revoking the integration invalidates
it immediately, disables every child agent enrolled by that integration,
rotates away their connection hashes, and closes their live daemon sockets.

Farm-enrolled agents receive separate `aga_` child tokens. Provider credentials
are authenticated inside the machine or sandbox and are never copied through
Agensis or Farm.

## HTTP surface

```text
POST   /backend/integrations/farm/device/start
POST   /backend/integrations/farm/device/approve
POST   /backend/integrations/farm/device/deny
POST   /backend/integrations/farm/device/token
GET    /backend/integrations/farm
DELETE /backend/integrations/farm/:id

GET    /backend/integrations/farm/silos
POST   /backend/integrations/farm/agents
DELETE /backend/integrations/farm/agents/:id

POST   /backend/integrations/farm/jobs
GET    /backend/integrations/farm/jobs/:id
POST   /backend/integrations/farm/jobs/:id/cancel

GET    /backend/inference/v1/models?workspaceId=:id
POST   /backend/inference/v1/chat/completions
```

Integration tokens are workspace-bound. Supplying another workspace ID never
broadens access.

## Shared inference

An `agensis-cli` daemon may advertise selected local models. Agensis stores only
safe routing metadata, constructs a stable route ID, and brokers request events
to the live agent socket. The daemon calls the loopback model server and returns
unaltered OpenAI-compatible chunks, tool calls, finish reasons, and usage.

Use `--no-coding` for a presence/inference-only daemon. The flag, shared-model
config, and absolute config path persist in normal daemon profiles and
CursorBuddy reconnect caches, so a restart does not silently enable a default
coding command or lose the shared routes.

The same routes appear in the Agensis chat and thread model selectors. The
normal `/backend/ai-chat` stream recognizes them and uses the inference broker
instead of a managed Anthropic key.

## Coding jobs

Farm jobs reuse `agent_jobs` with `metadata.mode = "farm"` and a null chat
session. They never insert or update chat messages. Progress is retained on the
job row, completion is polled through the integration API, and cancellation is
authoritative even if a process races to send one last result frame.
