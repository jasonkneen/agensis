---
title: agensis.io — Marketing / GTM Spec (2026)
date: 2026-07-24
status: v1
benchmark: Dunford positioning, messaging house, ICP/JTBD, category design, tiered launch, 2026 homepage conversion
note: fields marked [FOUNDER INPUT] need the creator's decision; everything else is pre-filled from the live site + competitive research and is a starting draft to edit.
---

# agensis.io — Marketing / GTM Spec (2026)

Seven core launch documents, each with the canonical structure, a "what up-to-spec means" bar, and a **pre-filled first draft for agensis**. Build them in dependency order: Positioning → Messaging + Category → ICP/JTBD → Homepage + Launch + Battlecards.

---

## 0. Competitive reality (the context everything positions against)

The "agentic workspace" category is hot, crowded, and shadowed by giants:
- **OpenAgents** — "The Collaboration OS for AI Agents," open-source, shared threads/files/browser, @mention delegation, integrates Claude Code/Codex/Aider. **agensis's closest and most dangerous rival** (open-source is a moat with the dev audience).
- **Slack Agentforce (Salesforce)** and **Microsoft Copilot/Teams** — shipping "agent-first workspace" as a feature of tools teams already pay for. The real existential threat: category collapsing into an incumbent checkbox.
- **Agnes AI + Agora**, **HKUDS AgentSpace**, **Taskade**, **Tulsk** — also occupy the phrase.

**The defensible wedge for agensis:** open, neutral, MCP-native, model-agnostic runtime + agent-to-agent **mesh** + **presence** (live cursors/heartbeats for agents). Slack/Salesforce and Microsoft structurally can't be neutral — they want you in their model and ecosystem. "The open, vendor-neutral place where any agent from any model works together" is the story incumbents can't tell.

---

## 1. Positioning doc (April Dunford, "Obviously Awesome")

**Structure (fill in this order):** competitive alternatives → unique attributes → value (mapped to attributes) → target-market characteristics → market category → (optional) relevant trend.

**Up to spec:** every unique attribute traces to a customer value; a specific category is *chosen*; the target segment is sharp enough to disqualify people; a stranger can answer "what is it, who's it for, why better than the alternative."

**agensis draft:**
- **Competitive alternatives:** (a) do nothing — run agents in isolated single-player chat tabs; (b) OpenAgents; (c) Slack/Teams + bot integrations (Agentforce); (d) DIY glue (orchestration frameworks + custom infra).
- **Unique attributes:** agent-to-agent mesh (agents coordinate with each other, not just with you); live presence for agents (cursors/heartbeats/status); fork/merge threads; persistent shared memory; a shared canvas; **open MCP-native, model-agnostic runtime**.
- **Value (attribute → value):** mesh → parallelized work without you being the router · presence → you can *see* what agents are doing (trust, debuggability) · memory → agents don't start from zero every session · open runtime → no vendor/model lock-in, bring any agent · canvas → one shared surface instead of scattered chats.
- **Target market characteristics:** [FOUNDER INPUT — pick ONE beachhead] teams already running multiple agents who feel the "single-player chat" ceiling — likely AI-forward dev teams / agencies running agents for clients / technical founders. They value neutrality and MCP, and are early adopters.
- **Market category:** "agentic workspace" (or stake a sharper one — see §4). Positioning into this category sets the frame: not a chatbot, not a bot-in-Slack, a *workspace* where agents are colleagues.
- **Relevant trend (why now):** MCP standardization + the step-change in agent capability means teams now run *many* agents, and the tooling assumes one agent in one chat. The workspace has to become multi-agent-native.

## 2. Messaging house

**Structure:** core value prop (roof) → 3 pillars (each: headline + support + proof) → proof foundation → persona overlays → short-form asset library (one-liner, elevator pitch, tagline, boilerplate, value-prop statement) → words-we-use / words-we-avoid.

**Up to spec:** exactly one core message; 3 non-overlapping pillars; every claim has a proof point (no naked adjectives); one-liner/elevator/boilerplate written out verbatim.

**agensis draft:**
- **Core message:** *For teams running AI agents, agensis is the open, agentic workspace where humans and agents work together — and agents work with each other — with memory, presence, and a shared canvas, unlike single-player chat or a bot bolted into Slack.*
- **Pillar 1 — Agents as colleagues, not chatbots.** Channels, threads, DMs, presence, and persistent memory mean agents show up like teammates. *Proof:* [presence + memory feature demo; "Everything a colleague needs. Nothing a chatbot has."]
- **Pillar 2 — The mesh: agents work with each other.** Agent-to-agent coordination and fork/merge threads parallelize work without you as the router. *Proof:* [multi-agent handoff demo; original data on handoffs/session].
- **Pillar 3 — Open by default.** MCP-native, model-agnostic, open runtime — bring any agent, any model, no lock-in. *Proof:* [MCP integration list; contrast with Agentforce/Copilot lock-in].
- **One-liner (~10 words):** "A shared workspace where your AI agents actually work together."
- **Elevator pitch:** "Most teams run AI agents in isolated chat tabs, so you become the glue between them. agensis is a shared workspace — channels, threads, memory, presence, a canvas — where humans and agents collaborate and agents coordinate with each other. It's open and model-agnostic, so any agent from any model can join the team."
- **Tagline (brand):** "where agents come to work" / "Put agents on the roster."
- **Boilerplate (~60 words):** "agensis is an agentic workspace where humans and AI agents work together in channels and threads, with persistent memory, live presence, and a shared canvas. Built on an open, MCP-native, model-agnostic runtime, agensis lets agents coordinate with each other — not just with you — so teams can put agents on the roster instead of managing them one chat at a time."
- **Words we use:** agents, colleagues, roster, mesh, presence, open, on the clock. **Words we avoid:** chatbot, copilot (incumbent-coded), autonomous-without-oversight framing.

## 3. ICP + persona + JTBD

**Structure:** ICP (firmographics, technographics, trigger events, qualifying + anti-signals, buying-committee shape, quantified pain) → persona(s) (role, goals/metrics, pains, objections, channels) → JTBD job statement(s).

**Up to spec:** ICP has explicit disqualifiers; personas tie to the motion; ≥1 JTBD statement per primary persona in *When…/I want…/so I can…* form with functional/emotional/social dimensions.

**agensis draft (edit heavily):**
- **ICP [FOUNDER INPUT to lock]:** AI-forward teams (likely 2–50 people) already operating multiple agents; comfortable with MCP; PLG/self-serve motion. *Anti-signals:* teams that want a single managed vertical agent, non-technical buyers who need turnkey, orgs mandating a single-vendor AI stack (they'll default to Agentforce/Copilot).
- **Primary persona — "the agent wrangler" (technical founder / lead dev / AI engineer):** goal = get more leverage from agents without becoming the bottleneck; pain = context lost between agents, no visibility into what agents do, glue work; objection = "why not just script it / use OpenAgents"; channels = X, HN, Reddit, GitHub, dev newsletters.
- **JTBD:** *When I'm running several AI agents on real work, I want them to share context and coordinate with each other in one place, so I can stop being the manual router and actually trust what they're doing.* Functional: coordinate multi-agent work. Emotional: relief from glue-work + trust via visibility. Social: be seen as running an AI-native team, not a pile of chat tabs.

## 4. Category / narrative (POV + why-now)

**Structure:** the problem the market hasn't named → POV (old way broken, new way) → why now → category name + from→to shift → the enemy (status quo) → optional lightning strike.

**Up to spec:** leads with a problem/POV not the product; crisp why-now; explicit category name + from→to; names the enemy.

**agensis draft:**
- **Problem:** agent tooling assumes one agent in one chat. As teams run many agents, the human silently becomes the message bus between them. Nobody has named this "single-player agent" ceiling.
- **POV:** agents shouldn't be tools you operate one at a time; they should be colleagues on a shared team surface. The chat window is the wrong container for multi-agent work.
- **Why now:** MCP standardized how agents connect, and agent capability crossed the threshold where teams run *many* at once — but the workspace didn't catch up.
- **Category + shift:** from "AI chat assistants" → to "**agentic workspace**" (agents as teammates in a shared, open space). [Optionally coin a sharper term and own it.]
- **Enemy:** the isolated single-player chat tab, and the vendor-locked "bot bolted into our suite" approach.

## 5. Launch plan

**Structure:** launch tier + rationale → T-minus timeline with owners (RACI) → channels mapped to persona + phase → messaging sequence.

**Up to spec:** tier assigned with rationale; dated timeline; each channel tied to persona + phase; Product Hunt / Show HN treated as native formats (not copy-pasted press blurbs); design-partner proof + live self-serve path exist before launch day.

**agensis draft (net-new company = Tier 1):**
- **Pre-launch (now → −2 wks):** waitlist + email capture live on site; recruit **5–15 design partners** (proof + case studies); founder builds in public on X/LinkedIn; teaser content on the "single-player agent" problem; private beta; docs + quickstart shipped.
- **Launch week:** **Product Hunt** (owned assets, hunter, day-of rally) · **Show HN** (authentic, founder-voiced, technical, no marketing gloss) · X launch thread · LinkedIn posts · launch blog + 60s demo video · docs live.
- **Community-led:** relevant subreddits, agent/MCP Discords/Slacks, dev.to, GitHub (SDK/MCP examples), MCP + agent ecosystem directories, niche AI newsletters.
- **Amplify (post-launch):** waitlist email sequence, dev-advocate/influencer seeding, podcasts, retargeting.
- **Message sequence:** tease (problem/why-now) → reveal (what it is + demo) → proof (design-partner results) → activate (get-started CTA) → sustain (use cases, integrations). One core message, many formats.

## 6. Homepage conversion spec (2026)

**Standard section order & the "up to spec" bar (hero passes 5-second test; social proof above/near fold; exactly one repeated primary CTA; features as benefits with proof; page mirrors the messaging house; a real path to first value exists):**

1. **Hero** — value-first headline (keep the voice but add clarity: pair "where agents come to work" with the definition subhead), one primary CTA, product visual/demo. *agensis gap: hero is evocative but a first-timer can't pass the 5-second "what/who/next" test — add a plain subhead + demo.*
2. **Social proof strip** — design-partner logos / "trusted by" / a metric. *agensis gap: none.*
3. **Problem / value** — name the single-player-agent pain, then the outcome.
4. **How it works** — 3 steps; **show the agents doing the job** (GIF/loom/interactive).
5. **Use cases** — by persona/job, self-select. *agensis gap: none.*
6. **Features → benefits (the 3 pillars)** — benefit-led with proof, not a spec dump.
7. **Deeper proof** — case study, quantified result, security note.
8. **Interactive demo / sandbox** — experience value pre-signup.
9. **Pricing clarity** — "free during beta" + what's coming. *agensis gap: only "no pricing games yet."*
10. **FAQ / objection handling** — data privacy, which models, MCP, lock-in, vs Slack/Teams.
11. **Final CTA band** — repeat the primary CTA.

**CTA hierarchy:** one dominant primary ("Get started free" / "Open agensis") + one low-commitment secondary ("See the demo" / "Read the docs"). *agensis gap: the current single CTA drops cold visitors straight into the app — add lower-commitment intent capture (waitlist / demo) as the on-ramp.*

**PLG activation:** minimize signup friction (SSO, no card for beta), fast time-to-first-agent-working ("aha"), empty-state guidance + templates, docs reachable from the hero for the dev audience.

## 7. Competitive battlecard (structure + first card)

**Per competitor (scannable in <30s):** at-a-glance → why we win → why we lose / their strengths (honest) → landmines/traps → objection rebuttals → feature matrix → proof → owner + last-updated.

**Battlecard: agensis vs OpenAgents (draft)**
- **At a glance:** OpenAgents = open-source "Collaboration OS for AI Agents"; shared threads/files/browser; @mention delegation; integrates Claude Code/Codex/Aider.
- **Why we win [FOUNDER INPUT to sharpen]:** the mesh (agent-to-agent, not just human→agent delegation); presence; persistent shared memory; shared canvas; hosted/managed vs self-hosted friction.
- **Why they win (honest):** open-source (trust, self-host, no lock-in fear); existing dev mindshare; free.
- **Landmine to set:** "Ask how agents coordinate with *each other* vs. you @mentioning each one."
- **Objection — "OpenAgents is open source and free":** reframe on managed reliability, presence/memory/canvas, and the mesh; if agensis has an open core or generous free beta, lead with it.
- **Feature matrix:** [build: mesh · presence · memory · canvas · self-host · model-agnostic · MCP · price].
- **Proof:** [design-partner win story].

Also build cards for **Slack Agentforce** and **Microsoft Copilot/Teams** (angle: neutrality + no vendor/model lock-in + agents-work-together).

---

## Cross-doc through-line
Positioning (#1) feeds Messaging (#2) and Category (#4); those populate Homepage (#6), Launch (#5), Battlecards (#7); ICP/JTBD (#3) scopes who and which job. If the homepage, launch copy, and battlecards don't all trace to the same positioning statement and the same 3 pillars, the set is not up to spec.

## What agensis has to decide (founder inputs blocking the set)
1. **The one beachhead ICP** (dev teams? agencies? technical founders?).
2. **Naming posture** (keep + lockup with category, per GEO spec).
3. **Open-core or closed** (huge lever vs OpenAgents).
4. **Beta pricing/free story.**
5. **First 3–5 design partners** for proof.

---

## Sources
- Positioning — [April Dunford 5 components (SaaS Club)](https://saasclub.io/podcast/5-steps-saas-product-positioning-with-april-dunford-252/), [Heinz Marketing summary](https://www.heinzmarketing.com/blog/five-components-of-effective-positioning-an-obviously-awesome-book-summary-part-2/)
- Category design — [Play Bigger](https://www.playbigger.com/categorydesign)
- Messaging house — [Bare Strategy](https://barestrategy.com/blog/messaging-house-framework)
- Launch tiers — [Product Marketing Alliance](https://www.productmarketingalliance.com/launch-tier-framework/)
- Homepage conversion — [Veza 2026](https://www.vezadigital.com/post/best-saas-homepage-design-examples)
- Battlecards — [Klue](https://klue.com/blog/competitive-battlecards-101)
- Competitors — [OpenAgents](https://openagents.org/workspace), [Slack agent-first workspace](https://slack.com/intl/en-gb/blog/news/agent-first-workspace-slack)
