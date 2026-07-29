# buzz feature packs — analysis index

Twelve packs from `repo-grab/out/extract-pack/`, one analysis document each, written
2026-07-29 against `main-next` (Fly v126, daemon npm 0.1.44). No code was written.

## Read this first: two packs are round-trips of our own code

`host-daemon-jobs` (#11) and `self-update-supervise` (#12) declare
`source_system: "agensis-agent"` and `target_systems: ["buzz"]` — they were extracted
**out of this product** as specs for buzz to build. Their anchors point at our own
files and the excerpts are our source verbatim. Each pack's `recommendation.json` then
says `target_system: "agensis"`, contradicting the pack it wraps.

The `host-daemon-jobs` analysis diagnoses why, and it matters for reading the rest: the
extractor treats `agensis-agent` as a third *system* peer to `agensis` and `buzz`, when
it is the host half of one product whose server half is this repo. So it reports a
"capability gap" between two halves of the same thing, which cannot exist. **Distrust
the recommendation layer on any pack sourced from `agensis-agent`.**

So there are **10 packs to evaluate, not 12**.

## Verdicts

| Rank | Pack | Pri | Verdict | Effort |
|---|---|---|---|---|
| 1 | [agent-harness-acp](agent-harness-acp.md) | 97 | Adopt-modified, much narrower | ~5 d |
| 2 | [agent-first-cli](agent-first-cli.md) | 93 | Adopt-modified, scoped down hard | ~3 d |
| 3 | [event-kind-registry](event-kind-registry.md) | 85 | Adopt-modified (declared surface, not numbered kinds) | ~4.25 d |
| 4 | [channel-scoped-messaging](channel-scoped-messaging.md) | 80 | Adopt-modified, heavily narrowed; premise rejected | ~2.5 d |
| 5 | [nostr-first-api](nostr-first-api.md) | 77 | **Reject as stated**; two narrow ideas adopted | ~1.5 d |
| 6 | [workflow-automation](workflow-automation.md) | 75 | Adopt-modified; YAML rejected | ~7-8 d |
| 7 | [presence-typing](presence-typing.md) | 60 | Adopt-modified; ~85% already built | ~2 d |
| 8 | [agent-persona-packs](agent-persona-packs.md) | 55 | Adopt-modified, ~1/10th the size implied | ~6-7 d |
| 9 | [audit-hash-chain](audit-hash-chain.md) | 45 | **Adopt the audit log, reject the hash chain** | ~4-6 d |
| 10 | [media-blossom](media-blossom.md) | 40 | **Reject** protocol; defer content-addressing | — |
| 11 | [host-daemon-jobs](host-daemon-jobs.md) | 30 | **Reject** — round-trip of our own code | — |
| 12 | [self-update-supervise](self-update-supervise.md) | 15 | **Reject** as import — already shipped today | — |

## The finding that outranks the packs

`audit-hash-chain` set out to evaluate a tamper-evident log and found something larger:
**agensis has no audit record at all** for its most sensitive actions. Not a weak one —
none. Role changes, member removal, invite creation and revocation, `permission_mode`
flips to `yolo` (which grants unrestricted shell on the daemon host), permanent tool
grants, connect-token minting and revocation, and every vault secret write all complete
without writing a durable row anywhere.

That is a security and compliance gap independent of buzz, and it is the single most
valuable thing this exercise surfaced. The hash chain is correctly rejected for v1 —
a chain whose head is anchored in the same Postgres an attacker already controls proves
very little.

## Defects found while analysing (not features — bugs, today)

- **Result metadata is discarded.** `connectionExecutors.mjs:394-403` reads only
  `subtype` from the SDK result and throws away `stop_reason`, `terminal_reason`,
  `permission_denials`, `usage` and `total_cost_usd`. Everything downstream sees one
  opaque error string. The data is already on the wire. (agent-harness-acp §A)
- **Two timeout clocks that do not know about each other.** The daemon has one flat
  30-minute timeout (`agensis.mjs:42`); the server independently reaps at 10 minutes of
  content-silence (`agent-jobs.cjs:303-323`). Only the daemon's can actually stop the
  work. (agent-harness-acp §B)
- **No worker pool, despite appearances.** (agent-harness-acp §C)
- **The typing lane is fully built and never wired.** `PresenceSnapshotItem.typing`,
  `ItemPresenceUser.typing` and `setTyping` all exist and ship; nothing calls them.
  (presence-typing)
- **`content_sha256` is computed on every upload and never read.**
  `server/files-routes.cjs:82`, stored at `:84-88`. (media-blossom)

## What was rejected, and why that is useful

Four rejections, each argued from evidence rather than taste:

- **media-blossom** — the durability hazard is already closed (`fly.toml:29-33` mounts
  a 3GB encrypted volume; `df -h /data` shows 15.1MB used, 1%). Dedup and tiering are
  optimisations for a data volume that does not exist.
- **nostr-first-api** — we already have a generic data + subscription surface behind one
  allowlist and one authorization function; adding a feature means adding a table to
  three sets in one file, not adding REST paths. The part we lack is the part that does
  not transfer (pubkey identity, relays).
- **host-daemon-jobs**, **self-update-supervise** — round-trips, see above.

Three more packs had their *premise* rejected while keeping a narrow slice:
`channel-scoped-messaging` (scoping is structural in our schema — `messages` has no
`workspace_id` at all, so it can only be reached through `chat_sessions`),
`workflow-automation` (we already have three automation systems; only one cell of the
trigger-action matrix is uncovered), and `agent-first-cli` (agents already have 30 MCP
tools; a CLI is for humans and CI, not agents).

## Suggested order

1. **Audit log** (#9) — security gap, independent of everything else.
2. **Result metadata + timeout unification** (#1 items A and B) — cheap, fixes live defects.
3. **Wire the typing lane** (#7) — small, already built.
4. **Workflow "internal action" cell** (#6) — the one genuinely missing capability.

Everything else is optional and can wait for a product reason.
