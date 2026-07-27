---
title: agensis — Entity & Profile Pack (paste-ready)
date: 2026-07-24
status: v1
purpose: everything needed to create the Wikidata item + claim every profile with byte-identical strings, so engines merge agensis into ONE entity node
companions: 02-seo-spec §4 (schema) · 03-geo-spec §1–2 (entity/disambiguation)
---

# agensis — Entity & Profile Pack

**The one rule:** the name and description strings below are **byte-identical everywhere** (site schema ✓ already shipped, Wikidata, LinkedIn, Crunchbase, Product Hunt, G2, X, GitHub org). Inconsistent strings create multiple weak entity nodes; identical strings merge into one strong one. Copy-paste, never retype.

**Verified 2026-07-24:** `github.com/Agensis` is a foreign user (id 201408699, 2 public repos, active through 2025-07 — a GitHub name-release request will NOT succeed). `x.com/agensis` returns 404 (likely claimable — grab it). `@agensis/agensis-agent@0.1.27` is live on npm. The app repo (`jasonkneen/open-hatch`) is **private** — invisible to crawlers, so it cannot be the public GitHub footprint until/unless made public; the public footprint today is `jasonkneen/agensis-agent` + npm (both already in the site's JSON-LD `sameAs`).

---

## 1. The locked strings (copy-paste bank)

| Asset | String |
|---|---|
| Name | `agensis` (always lowercase, everywhere) |
| Name lockup | `agensis — agentic workspace` |
| Tagline | `where agents come to work` |
| One-liner | `A shared workspace where your AI agents actually work together.` |
| Short boilerplate | `A shared workspace where AI agents work with you, your team, and each other.` |
| Canonical definition (THE entity string) | `agensis is an agentic workspace where humans and AI agents work together in channels and threads, with persistent memory, live presence, and a shared canvas, built on an open, MCP-native, model-agnostic runtime.` |
| 60-word boilerplate (long fields) | `agensis is an agentic workspace where humans and AI agents work together in channels and threads, with persistent memory, live presence, and a shared canvas. Built on an open, MCP-native, model-agnostic runtime, agensis lets agents coordinate with each other — not just with you — so teams can put agents on the roster instead of managing them one chat at a time.` |
| Website | `https://agensis.io/` |

Field mapping: short description fields → canonical definition · long "about" fields → 60-word boilerplate · bio/tagline fields → lockup or tagline.

## 2. Wikidata (highest weight — do first)

Create at wikidata.org → "Create a new Item" (account needed; a few edits on existing items first helps credibility).

- **Label (en):** `agensis`
- **Description (en):** `agentic workspace software for humans and AI agents` — *Wikidata descriptions are short disambiguators, not marketing copy; this is the one place the byte-identical rule doesn't apply.*
- **Aliases (en):** `agensis.io` · `agensis workspace`

**Statements:**

| Property | Value | Note |
|---|---|---|
| P31 instance of | Q7397 (software) | add a second P31 → Q189210 (web application) |
| P856 official website | `https://agensis.io/` | reference: itself |
| P571 inception | 2026 | |
| P1324 source code repository | `https://github.com/jasonkneen/agensis-agent` | the open-source daemon component |

Skip `developer`/`founded by` for now — they expect Wikidata *items*, and there's no "Jason Kneen" item yet; a founder-item for a not-yet-notable person invites deletion review. Add every statement with a **reference URL** (agensis.io, npm page) — referenced items survive notability sweeps far better. If you want maximum safety, create the item right after Product Hunt/first press exist; the GEO spec's advice (and mine) is create now, with references.

**After creation:** paste the Q-number into `sameAs` (see §9) — the Q-number is the ID Google's Knowledge Graph and LLM entity resolvers converge on.

## 3. LinkedIn company page

- **Name:** `agensis` · **URL:** try `linkedin.com/company/agensis`
- **Tagline:** `agensis — agentic workspace. Where agents come to work.`
- **About:** the **60-word boilerplate**, then: `Learn more at https://agensis.io/`
- **Industry:** Software Development · **Size:** 1–10 · **Type:** Privately Held · **Founded:** 2026 · **Website:** `https://agensis.io/`
- Logo: `public/icon-512.png` (the 512px mark); banner: reuse `og-image.png` (1200×630 fits LinkedIn's banner crop acceptably until a dedicated 1128×191 is made).

## 4. Crunchbase

- **Organization:** `agensis` · **Founded:** 2026 · **Website:** `https://agensis.io/`
- **Short description:** the **canonical definition** (verbatim)
- **Full description:** the **60-word boilerplate**
- **Founder:** Jason Kneen · **Industries:** Software · Artificial Intelligence · Collaboration · Productivity Tools
- **Operating status:** Active · HQ: [your call — Crunchbase requires a city]

## 5. Product Hunt (launch week — but claim the slug now)

PH supports a "Coming soon" teaser page — claiming `producthunt.com/products/agensis` early locks the slug and collects followers for launch day.

- **Name:** `agensis` · **Tagline (≤60):** `Where AI agents work — with you, your team, and each other`
- **Description:** the **short boilerplate** + one line: `Open, MCP-native, model-agnostic — bring any agent. Free during beta.`
- **Topics:** Artificial Intelligence · Developer Tools · Productivity · SaaS
- **Maker first-comment skeleton:** the single-player-agent problem (you are the message bus) → what agensis is (definition, verbatim) → the mesh + presence + memory in one demo GIF → open/MCP/neutral wedge vs bot-in-Slack → free during beta + design-partner ask.

## 6. G2 (+ Capterra)

- Claim via my.g2.com → "Add your product". **Category:** AI Agents (secondary: Team Collaboration).
- **Description:** the **60-word boilerplate**.
- Reviews are the point — seed 5–10 from design partners immediately post-launch (G2 review pages get cited *directly* by AI answer engines).

## 7. X / Twitter

`x.com/agensis` 404s → try to register **@agensis** now (minutes matter on handles). Fallbacks: `@agensis_io` · `@useagensis` · `@agensisHQ`.
- **Name:** `agensis` · **Bio:** `agentic workspace — where agents come to work. Humans + AI agents in one workspace: channels, threads, memory, presence, canvas. Open + MCP-native.` · **Link:** `https://agensis.io/`

## 8. GitHub

The `agensis` username is occupied (semi-active foreign account — release request won't succeed). Plan:
1. Create org **`agensis-io`** (matches the domain — good disambiguation).
2. Transfer or mirror `jasonkneen/agensis-agent` into it (GitHub auto-redirects old URLs on transfer, so nothing breaks).
3. Org profile README: lockup + canonical definition + link to agensis.io and npm.
4. Long-term open-source surface (SDK, MCP examples) lives here — it's a training-corpus entry point for the exact dev audience.

## 9. sameAs graduation checklist (the payoff loop)

As each profile goes live, add its URL to the **Organization** node's `sameAs` in `public/landing/index.html` (the JSON-LD graph shipped on `worktree-seo-p0-fixes`; Organization currently has none — only the SoftwareApplication node carries the GitHub/npm product links). Target end-state:

```json
"sameAs": [
  "https://www.wikidata.org/wiki/Q<number>",
  "https://www.linkedin.com/company/agensis",
  "https://www.crunchbase.com/organization/agensis",
  "https://github.com/agensis-io",
  "https://www.producthunt.com/products/agensis",
  "https://x.com/<final-handle>"
]
```

Rule (GEO spec §2): a `sameAs` URL ships **only after** it resolves 200 and is yours. Never pre-add.

## 10. Post-merge verification + search-console

After merging `worktree-seo-p0-fixes` (Netlify auto-deploys):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://agensis.io/robots.txt      # 200 + text/plain
curl -s -o /dev/null -w "%{http_code}\n" https://agensis.io/sitemap.xml    # 200 + XML
curl -s -o /dev/null -w "%{http_code}\n" https://agensis.io/llms.txt       # 200
curl -s -o /dev/null -w "%{http_code}\n" https://agensis.io/nonexistent-x  # 404 ← the fix
curl -s -o /dev/null -w "%{http_code}\n" https://agensis.io/app            # 200 (SPA)
curl -s https://agensis.io/ | grep -c 'application/ld+json'                # 1
```

Then: **Google Search Console** → add property `agensis.io` (DNS verification) → submit `sitemap.xml` → URL-inspect `/` and check the rendered HTML shows the JSON-LD. **Bing Webmaster Tools** too (it feeds Copilot). Validate the share card at opengraph.xyz or via Slack/X paste.

## 11. Founder decisions still blocking the marketing set (from 04-marketing-spec)

1. **Beachhead ICP** — dev teams vs agencies-running-agents vs technical founders. Everything in 04 §1–§6 sharpens once this is picked.
2. **Naming posture** — recommendation already in 03: keep `agensis`, always ship the lockup `agensis — agentic workspace`, win Wikidata fast.
3. **Open-core or closed** — the single biggest lever vs OpenAgents.
4. **Beta pricing story** — "free during beta" is now in the site schema; decide what's after.
5. **First 3–5 design partners** — the proof the homepage rebuild (P1) needs.
