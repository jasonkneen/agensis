# The agent share policy (`.agensis-share`)

**Status:** server side implemented in this repo. The daemon half lives in
[`jasonkneen/agensis-agent`](https://github.com/jasonkneen/agensis-agent) and
needs to be built there — this document is the contract.

## What it is

A plain-text file in the agent's root folder saying what that **machine** is
willing to contribute to a workspace. Deliberately robots.txt-shaped: a known
filename, at a known location, written by the party that holds the content, for
the party that fetches it.

```
# .agensis-share — what this machine contributes to an agensis workspace.

share: documents
share: skills
withhold: memory
withhold: tools

# Path rules. FIRST MATCH WINS.
allow: docs/public/**
disallow: docs/**
disallow: **/CREDENTIALS.md
disallow: scratch/
```

## Why it exists

Before it, the only sharing control was `workspace_agents.sharing` — four
switches inside agensis. Those express what the **workspace** wants. They cannot
express what the owner of the laptop wants, and the person who runs the daemon is
frequently not the person clicking the switches.

## The rule that matters

The two halves **AND** together:

```
effective = workspace switch  AND  machine policy
```

Neither can widen the other. A workspace cannot switch on something the machine
withholds; a machine cannot force in something the workspace turned off. This is
written as an AND rather than a precedence order on purpose — precedence invites
"which one wins?", and the answer must always be "the more restrictive one".

The UI states both sides separately, because "we turned it off here" is a toggle
away and "that machine declines" needs a file change on someone else's computer.
Collapsing them into one blank list would send people to the wrong place.

## Where it is unlike robots.txt

robots.txt is advisory — a crawler chooses whether to honour it. This is not,
and it is enforced **twice**:

1. **The daemon** reads the file and never enumerates what it withholds. This is
   the real control: withheld bytes never leave the machine.
2. **The server** applies the same rules again at ingest
   (`server/agent-connections.cjs`), against the declaration the daemon reported
   on its capabilities sync. A daemon that is buggy, out of date, or modified
   cannot push a path its own declared policy forbids.

The second pass is what makes this a control rather than a convention.

## Grammar

One directive per line. `#` starts a comment and runs to end of line. Directive
names are case-insensitive; paths are not.

| Directive | Meaning |
| --- | --- |
| `share: <channel>` | this machine will contribute the channel |
| `withhold: <channel>` | it will not, whatever the workspace says |
| `allow: <glob>` | path exception — contribute matching paths |
| `disallow: <glob>` | path exception — never contribute matching paths |
| `deny: <glob>` | accepted synonym for `disallow` |

Channels are `memory`, `skills`, `tools`, `documents` — the same four as
`workspace_agents.sharing`.

### Semantics you must not get wrong

- **A channel the file never mentions has no opinion.** It defers to the
  workspace switch. It is *not* a grant and *not* a refusal.
- **Last mention of a channel wins**, so appending a `withhold:` does what its
  author obviously intends.
- **Path rules are first-match-wins**, in file order — the robots.txt rule. Put
  carve-outs *before* the broad rule or they are dead.
- **A path matching no rule is allowed.** The rules are exceptions carved out of
  "share what the channel allows", not an allowlist. For a true allowlist, write
  `disallow: **` first and carve back with `allow:`.
- **Path rules apply to documents and memory files only.** They deliberately do
  *not* apply to skills: a skill is addressed by name and its path is an advisory
  label, so filtering on it would drop skills for a reason the file's author was
  writing about documents.
- **No file at all means no machine-side restrictions.** Every agent that
  connected before this existed has no file, and reading that as "share nothing"
  would silently empty three browse surfaces.
- **A line that does not parse is an error, not a grant.** Somebody wrote it
  meaning to restrict something. `parseSharePolicy` returns `errors[]` and never
  silently discards a line it did not understand.

### Globs

`**` any depth including none · `*` one path segment · `?` one character. A
trailing `/` means the directory and everything under it. Everything else is
matched literally — a `.` is a dot, not a wildcard.

## Wire contract

The daemon parses the file locally and sends the **parsed shape** (not the file)
on its existing `agent_capabilities_sync` message:

```jsonc
{
  "action": "agent_capabilities_sync",
  // …existing fields…
  "sharePolicy": {
    "declared": true,
    "channels": { "documents": true, "memory": false },
    "rules": [
      { "allow": true,  "pattern": "docs/public/**" },
      { "allow": false, "pattern": "docs/**" }
    ]
  }
}
```

- Omit `sharePolicy` entirely when there is no file. Do not send
  `{"declared": false}` and do not send an empty object to mean "share nothing".
- The server re-validates everything (`normalizeSharePolicyMessage`): unknown
  channels are dropped, rules are capped at 500, patterns are coerced to strings,
  and unknown keys never survive. Do not rely on the server preserving anything
  outside the shape above.
- It rides the **existing** capabilities drift hash. Fold the policy into
  `capabilitiesHash` so an edited file re-pushes through the
  `agent_capabilities_refresh` nudge that already exists. No new sync channel.

## Reference implementation

`shared/agentSharePolicy.cjs` is the parser and evaluator, and it is pure — no
fs, no network, no clock. The daemon should **import it rather than reimplement
it**; a second parser is how the two sides start disagreeing about what a file
means, and the failure mode is a file that reads as a restriction and behaves as
a grant.

- `parseSharePolicy(text)` → `{ declared, channels, rules, errors }`
- `pathAllowed(policy, path)` → boolean, first-match-wins
- `channelAllowed(policy, channel)` → boolean
- `effectiveChannel(agentRow, policy, channel)` → the AND of both halves

Tests: `tests/agent-share-policy.test.cjs` (20 cases, including the ordering
trap and the escaping trap) and `tests/unit/agentSharePolicy.test.ts` (pins the
frontend twin against the server's).
