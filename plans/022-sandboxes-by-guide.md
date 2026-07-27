# 022 — Sandboxes by guide, not by integration

Status: LANE + WORKED EXAMPLE BUILT (`sandbox-setup` overall skill, `sandbox-setup-e2b`
guide, the `Sandbox Setup` agent template, and the cap/lane tests). The remaining five
guides — box, miosa, vercel, daytona, amp orb — are unwritten ON PURPOSE: see §4.1.
Priority: P2
Effort: S (content) + S (one scoping change) — no provider integration work
Depends on: nothing. The join link (`ae700c0`) and `loadSandboxSkillNote` are both
already shipped and are what make this cheap.
Planned at: `worktree-sandbox-plan`, branch off `main` @ `c5cc317`

Context: a design conversation about adding miosa.ai as a sandbox provider, which
ended by deleting most of the work it started with. This plan records the
conclusion and — more importantly — what we decided **not** to build and why.

---

## 1. The decision

**Two ways a user gets a sandboxed agent:**

1. **Agensis-hosted** — pick a ready-made agent, get inference + sandbox, one
   click. We choose the provider; the user never sees which. *Not built.*
2. **Bring your own** — their machine, their keys, their provider. A sandbox they
   own, running the daemon, connecting into the workspace. *Substantially exists.*

**One sandbox agent, not one per provider.** Providers are **skills it carries**,
not agents of their own.

The earlier argument for splitting (a Vercel deploy target and an e2b sandbox
don't share an operation vocabulary) was an artifact of `call_provider`'s fixed
capability list — `create/stop/pause/resume/fork/exec/files/expose`. Under the
guide model there is no vocabulary: the agent reads a document and runs CLI
commands, so a Vercel guide and an e2b guide are simply two documents. The
objection dissolves with the mechanism that produced it.

Budget is not a constraint: skill sync allows **64 KiB per document, 200
documents** (`SKILL_CONTENT_MAX_BYTES` / `SKILL_DOCUMENT_MAX_FILES` in
`server/skill-content.cjs:41,47`, matched exactly in the daemon's
`src/skills.mjs:31`). Six provider guides is nowhere near either ceiling.

---

## 2. What we are deliberately NOT building

This is the substance of the plan. Each of these was seriously considered and
rejected, and re-proposing one should require new information.

- **No `sandbox/<provider>.mjs` adapters.** Adding miosa/daytona/vercel as
  *execution* targets would mean an adapter per provider implementing the
  five-method interface next to `sandbox/e2b.mjs`. Not needed if the user's own
  box runs the daemon.
- **No provider-skill definitions for BYO.** The `server/sandbox-skills.cjs`
  framework (vault, `call_provider`, SSRF hardening, output fencing) exists
  because a server-side agent holds **our** credential. A user setting up their
  own box on their own machine needs none of it.
- **No credential custody, anywhere in BYO.** Not their sandbox key, not their
  git token, not their Anthropic key. Nothing to vault, leak, or rotate.
- **No agent per provider.** See §1.
- **No provisioning framework for BYO.** The setup is a person asking "how do I
  get a sandbox on Vercel" and an agent answering. That is not a system we need
  to build; it is a question a coding agent already answers.

The honest framing that drove all of the above: **the setup is not the value.**
What is ours is (a) the last step — connecting the box into a workspace, which no
general-purpose agent knows how to do — and (b) the guides being *current*, where
a model answering from memory is confidently wrong about a CLI that changed six
months ago. Effort belongs in the workspace the box joins, not the setup.

---

## 3. What already exists (verified, not assumed)

Checked against `agensis` @ `c5cc317` and `agensis-agent` @ `902714b`.

**A daemon inside a cloud sandbox is an anticipated deployment, not a hack.**
`isTrustedSandboxHost()` auto-detects a containerised host and keeps
`--dangerously-skip-permissions` with no per-host env setup; the comment calls it
*"the common remote-host deployment"* (`agensis-cli/src/agensis.mjs:1107`).

**Connect needs exactly one value:** `AGENSIS_TOKEN`
(`src/agensis.mjs:565`, `src/connectProfiles.mjs:72`). The join link reduces that
to pasting one URL, and an agent can redeem it **itself** — that is what shipped
in `ae700c0`.

**The daemon already reports which CLIs are on PATH.** `detectClis()`
(`src/agensis.mjs:1548`) rides the capabilities blob, so the specialist can open
with "you have the e2b CLI but not daytona" instead of asking.

**Server-authored instructions already reach daemon agents.**
`loadSandboxSkillNote` (`server/index.cjs:5091`) composes the sandbox skill layer
into one prompt block and — per its own comment — *"Both lanes get the same text
— builtin through the system prompt, daemon through the daemon prompt."* That is
the delivery path for the guides.

> **Correction (2026-07-27, same day).** An earlier draft of this plan said skill
> bodies sync *down* to the daemon as of agent `0.1.32`, and that this was the
> delivery mechanism. **That is backwards.** `agent_skill_sync` carries bodies
> **up**: the daemon scans the user's own skill directories and mirrors them to
> `agent_skill_documents` (`agensis-cli/src/skills.mjs:5`). There is no
> server→daemon skill-content push. Guides therefore belong in
> `BUNDLED_SANDBOX_SKILLS`, not in a synced skills directory — which is also why
> they inherit the 4000-char instruction cap in §5.1.

**`run_mode='sandbox'` exists and works, but is narrow.** `createSandboxExecutor`
(`agensis-cli/src/executor.mjs:64`) runs a full lifecycle — `ensureEnv → putRepo →
exec → getResult → destroy`, always destroying, folding the patch into stdout as a
fenced diff. Constraints: **only e2b is wired** (anything else throws,
`executor.mjs:102`), credentials come from the daemon's own `process.env`
(`executor.mjs:106-108`), inference runs *inside* the box via an injected
`ANTHROPIC_API_KEY` (`sandbox/e2b.mjs:25`), and a repo URL is **required**
(`sandbox/e2b.mjs:20`).

**The two sandbox systems do not talk.** `server/sandbox-skills.cjs` is a
*provisioning* agent that calls provider APIs. `executor.mjs` is what *runs a
coding job* in a box. Neither reads the other. A provider-skill definition does
not make that provider available for execution, and vice versa. This is the single
most misleading thing about the current code and cost most of the design
conversation.

---

## 4. What to build

### 4.1 Provider setup guides (the bulk of the work — content, not code)

One skill per provider: e2b, box, miosa, vercel, daytona, amp orb. Each covers:
install the CLI → log in → create a box → get a terminal → install/launch claude →
**where the key goes** → paste the join link.

Two things every guide must get right:

- **Where the key goes is the question that generates support load.** The daemon
  reads `process.env` of *the process that launched it*, so a key in `~/.zshrc` is
  invisible to a daemon started from launchd or a different shell. Say this
  explicitly.
- **Say plainly that we cannot stop an orphaned box.** We did not create it, so we
  have no stop button. The bundled provisioning skill already warns "an unstopped
  sandbox bills until someone notices" — under this model that warning has no
  mitigation behind it, so the guide has to carry it.

These guides have two consumers: a human reading docs, and the specialist agent
using them as instructions. Write once.

**Only e2b is written, deliberately.** The whole premise of §2 is that a maintained
guide beats a model answering from memory about a CLI that changed. Writing five
more guides from recollection of `vercel`/`daytona`/`miosa`/`amp` CLI syntax would
reproduce the exact failure this plan exists to avoid — and would do it with more
authority, because the wrong commands would arrive as a "verified" skill.

e2b is written because its facts are grounded in code in this repo
(`agensis-cli/src/sandbox/e2b.mjs`): the env var name, the Node floor, the
`IS_SANDBOX` root behaviour, the claude install command. It is the worked example
that proves the shape, exactly as Box is for the hosted lane.

The pattern the e2b guide establishes — **carry the agensis-specific truth, and
tell the agent to check the provider's live docs or `--help` for volatile syntax**
— is what makes the remaining five cheap and safe. Each needs one doc-verification
pass, and each is pure data: no deploy, no migration (see §1).

### 4.2 The sandbox specialist agent

One agent, running on the user's **local inference**, carrying the guides from
§4.1. It is an advisor that can act: it has shell on their machine, so it can
check `command -v`, install a CLI, drive a login, create the box, and hand over the
join link. A server-side agent could do none of that — it can only make HTTP calls
through `call_provider`.

Two properties worth designing around:

- **It can verify the key is visible to the daemon**, because it runs inside the
  daemon's own environment — without printing the value. A general-purpose claude
  cannot do this; it would be checking its own shell, not the daemon's.
- **Success verifies itself.** The box connecting back into the workspace *is* the
  proof. No API response to parse.

Be explicit in the guides that this agent runs real commands with their
credentials. It is their machine, but they should know that is what they are
agreeing to.

### 4.3 Scope the two "sandbox agents" apart

`server/sandbox-skills.cjs`'s bundled `sandbox-provisioning` skill currently reads
as *the* general answer to "sandbox agent". After this plan it belongs to the
**hosted** path only. Rename or scope it so it and the local specialist do not both
claim the name in the roster.

---

## 5. The sequencing trap (a real bug in the obvious flow)

The natural instruction — "generate a join link, then go set up your box" — **fails**.

Join links default to **15 minutes** (`JOIN_LINK_DEFAULT_TTL_MS`,
`server/index.cjs:2497`) and are single-use. Installing a CLI, logging in,
provisioning a box and installing claude very plausibly exceeds that.

It fails *confusingly*, because an expired link, a used one, a revoked one and one
that never existed are all answered **identically on purpose** so nobody can probe
for valid tokens (`server/join-page.cjs:171,214`). That is correct security design
and it means a legitimate user who was merely slow gets no useful error.

**Two mitigations, take both:**

1. Every guide orders the steps so the link is generated **last**, after the box
   has a terminal and claude is installed.
2. `AGENSIS_JOIN_LINK_TTL_MS` already overrides the default (clamped 60s–24h,
   `server/index.cjs:2498-2503`). Decide whether the setup flow warrants a longer
   link, and if so set it deliberately rather than leaving people to hit the wall.

---

### 5.1 The second trap: guides are silently truncated at 4000 chars

`normalizeSandboxSkill` clamps `instructions` to `SANDBOX_MAX_INSTRUCTION_CHARS`
(4000) with **no truncation marker** — unlike the daemon's skill-body sync, which
appends one. A guide that outgrows the cap loses its ending and still reads as
complete.

That is worse than it sounds here, because these guides put the load-bearing
parts **last**: where the key goes, and generate the link last. Truncation would
remove exactly the instructions that stop a setup failing.

`tests/unit/sandboxSkills.test.ts` guards every bundled skill against the cap, and
a second test pins the premise (that truncation really is silent), so if a marker
is ever added the guard can be relaxed deliberately rather than by accident. Both
were mutation-checked: padding a guide to 5559 chars turns the guard red.

## 6. Hosted (option 1) — what it would take, when we get to it

Not this plan, but recorded so it is not re-derived:

**Method 1 is method 3 with different credentials and a different supervisor.**
The provision → clone → exec → collect-patch → destroy machinery already works.
Two changes: read the credential from the workspace vault instead of
`process.env`, and run the supervisor somewhere that is not the user's laptop.

**The blocker is the repo, not the sandbox.** `putRepo` git-clones using a
`GIT_TOKEN`, and a sandbox with no repo currently throws (`sandbox/e2b.mjs:20`).
So either we hold the user's git credential to clone their private repo — worse
custody than the sandbox key — or v1 is scoped to scratch sandboxes and public
repos, which means making no-repo a valid case in code that currently refuses it.
That is a product call.

---

## 7. Open questions

- **Hosted supervisor: where does it run?** Fly, or separate infrastructure.
- **Private repos in hosted mode** — hold a git credential, or scope v1 to
  scratch/public? (§6)
- **Does `run_mode='sandbox'` survive?** Under this plan BYO users run the daemon
  *inside* the box (`run_mode='daemon'`), which is simpler than the daemon
  supervising a box remotely. The `sandbox` mode may be redundant for BYO and only
  needed for hosted. Decide before writing guides that mention it.
- **`sandbox_provider` is a free-text field in the Agents window that hard-fails
  for anything but e2b.** That is a bug today regardless of this plan — either
  constrain it to what is wired, or wire what it offers.

---

## 8. Not covered: computers

Everything above is sandboxes. Computer-use is unsolved for a different reason:
`fenceProviderOutput` is text-only (stringify + char-cap), so a screenshot arrives
as base64 that either blows the cap or is useless. Routing computers through an
MCP server rather than `call_provider` sidesteps it, but that is a separate piece
of work and the `kind` vocabulary (`['overall','provider']`) has no computer
concept.
