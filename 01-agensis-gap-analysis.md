---
title: agensis.io — Gap Analysis (Info, SEO, GEO, Marketing)
date: 2026-07-24
status: v1
scope: agensis.io marketing site + entity footprint
benchmark: current 2026 best-practice spec (see companion SEO / GEO / Marketing spec docs)
---

# agensis.io — Gap Analysis

This document measures the current state of agensis.io against the 2026 best-practice spec across four surfaces: **site information/content**, **technical + on-page SEO**, **GEO (generative engine optimization)**, and **marketing/GTM**. Each gap carries a severity (P0 blocker, P1 important, P2 compounding) and a one-line fix. The detailed "how" for each fix lives in the three companion spec docs.

Findings verified against the live site on 2026-07-24 via direct fetch. Items marked **[verify]** need a raw-HTML confirmation (view-source or the audit checklist in the SEO spec) because they were checked against rendered markdown, which can under-report head tags.

---

## Scoreboard

| Surface | Current maturity | Target | Biggest single gap |
|---|---|---|---|
| Site info / content | 3 / 10 | one indexable marketing page, strong voice, no depth | Only one real page; no /about, docs, use-cases, comparison, pricing |
| Technical SEO | 4 / 10 | homepage SSR & clean, but soft-404s + missing hygiene | Soft-404 app shell on every non-root route |
| GEO / AI answers | 1 / 10 | near-zero retrievable footprint + name collision | No entity, no third-party corpus, name reads as "agenesis" |
| Marketing / GTM | 3 / 10 | great copy voice, no ICP/proof/conversion system | No named ICP, no proof, no email capture, weak differentiation surfaced |

---

## A. Site information / content gaps

| # | Gap | Severity | Current state | Fix (one line) |
|---|---|---|---|---|
| A1 | Single indexable page | P1 | Only `/` is a real SSR page; all other paths are the app shell | Ship real routes: `/about`, `/how-it-works`, `/use-cases`, `/pricing`, `/docs`, `/vs-*` |
| A2 | No definitional "what is agensis" content | P0 (GEO) | Hero is evocative but abstract; no clean "agensis is a X that does Y for Z" | Add a canonical one-sentence definition, repeated verbatim everywhere |
| A3 | No concrete use case / demo | P1 | No screenshots, video, or "first 5 minutes" walkthrough | Add a 30–60s product demo + 2–3 named use cases |
| A4 | No proof / social proof | P1 | No logos, testimonials, design partners, metrics | Add design-partner logos + one quantified outcome as available |
| A5 | No pricing or model signal | P2 | "No pricing games yet" only | Add "free during beta" + explicit plan-later note |
| A6 | Two conflicting site descriptions | P1 | Marketing "where agents come to work" vs app "AI-powered workspace for documents, chat, and memory" | Unify to one canonical boilerplate across all surfaces |

## B. Technical SEO gaps

| # | Gap | Severity | Current state | Fix (one line) |
|---|---|---|---|---|
| B1 | Soft 404s on all non-root routes | P0 | Every unknown path returns HTTP 200 + PWA app shell | Return real 404/410; 301 for moved; kill the 200-shell fallback |
| B2 | robots.txt missing/served as app **[verify]** | P0 | `/robots.txt` returned app content, not a robots file | Add a real `/robots.txt` (plain text, allow AI crawlers, list sitemap) |
| B3 | sitemap.xml missing/served as app **[verify]** | P0 | `/sitemap.xml` returned app content, not XML | Add a real `/sitemap.xml` of canonical 200 URLs, submit in Search Console |
| B4 | No JSON-LD structured data **[verify]** | P0 (GEO+SEO) | No `application/ld+json` detected | Add Organization + WebSite + SoftwareApplication graph (see SEO spec §Schema) |
| B5 | No og:image **[verify]** | P1 | og:title/description present; no image | Add 1200×630 `og:image` (shared absolute HTTPS URL) |
| B6 | No Twitter/X Card tags **[verify]** | P1 | None detected | Add `twitter:card=summary_large_image` + title/description/image |
| B7 | Favicon / PWA manifest not confirmed **[verify]** | P2 | PWA meta seen on app shell; favicon not surfaced | Confirm favicon (48px multiples) + manifest (192/512/maskable) |
| B8 | Core Web Vitals unknown | P1 | Not measured (no field data access) | Baseline CrUX/PSI; SPA hydration is the usual INP risk |
| B9 | No canonical on sub-surfaces **[verify]** | P1 | App shell canonical points to `/` generically | Self-referencing, server-rendered canonical per real page |

Working well (keep): homepage is **server-rendered with real content**, has a clean single-H1 hierarchy, a canonical tag, and OG title/description. That's a genuine foundation.

## C. GEO / AI-answer gaps

| # | Gap | Severity | Current state | Fix (one line) |
|---|---|---|---|---|
| C1 | Brand name collides with "agenesis" | P0 | Search "agensis" returns medical "agenesis" + Agenus; zero brand results | Aggressive entity disambiguation (Wikidata, sameAs, co-occurrence anchors); decide naming posture |
| C2 | No entity / knowledge graph node | P0 | No Wikidata, no Organization schema, no sameAs | Create Wikidata item; ship Organization schema with sameAs[] everywhere |
| C3 | Zero third-party corroboration | P0 | No Product Hunt, Crunchbase, G2, GitHub, press, Reddit | Claim profiles + launch + seed reviews (earned mentions are the #1 lever) |
| C4 | No extractable/quotable content | P1 | Copy is abstract, not atomic/definitional, no stats | Add definitions, FAQ blocks, front-loaded answers, original data |
| C5 | No comparison/"vs"/alternatives pages | P1 | None | Build "agensis vs OpenAgents", "vs Slack Agentforce", "OpenAgents alternatives" |
| C6 | llms.txt absent | P2 | None | Ship `/llms.txt` + `/llms-full.txt` (cheap insurance) |
| C7 | No AI-visibility measurement | P2 | None | Track a prompt set + AI-crawler log hits + AI referral traffic |

## D. Marketing / GTM gaps

| # | Gap | Severity | Current state | Fix (one line) |
|---|---|---|---|---|
| D1 | No named ICP / beachhead | P0 | Copy speaks to "everyone" | Pick one beachhead segment; write the ICP + persona + JTBD doc |
| D2 | Positioning not explicit | P0 | Category ("agentic workspace") is contested; wedge buried | Write the Dunford positioning doc; lead with open/neutral/model-agnostic + mesh |
| D3 | No messaging house | P1 | Strong taglines, no structured pillars/proof | Build core message + 3 pillars + proof points; derive one-liner/boilerplate |
| D4 | No conversion system on homepage | P1 | Hero → app; no proof, use cases, demo, or CTA hierarchy | Rebuild homepage to the 2026 conversion spec (see Marketing spec §Homepage) |
| D5 | No intent capture | P0 | Only "Get started / Open app" (a heavy ask) | Add waitlist/email capture + "become a design partner" CTA |
| D6 | No launch plan | P1 | Unknown | Tiered launch: design partners → Product Hunt + Show HN → amplify |
| D7 | No competitive battlecards | P2 | None | One card per key rival (OpenAgents, Agentforce) |
| D8 | Differentiation vs incumbents unclear | P1 | Slack/Microsoft ship "agent-first workspace" as a feature | Sharpen the neutral-open-runtime story as the defensible wedge |

---

## Priority sequence (what to do, in order)

**P0 — foundation & disambiguation (week 1–2)**
B1 soft-404 fix · B2 robots.txt · B3 sitemap · B4 schema graph · C2 entity + C1 name disambiguation · D5 intent capture · A2 canonical definition · D1 pick a beachhead ICP · D2 explicit positioning.

**P1 — depth, conversion, proof (weeks 3–6)**
A1 real content pages · B5/B6 social share cards · B8 CWV baseline · C4/C5 extractable content + comparison pages · D3 messaging house · D4 homepage conversion rebuild · A3 demo · A4 proof · D8 sharpen wedge.

**P2 — compounding & measurement (quarter)**
C3 third-party corpus + reviews · C6 llms.txt · C7 AI-visibility tracking · D6 launch plan execution · D7 battlecards · A5 pricing signal.

---

## The two things that matter most

1. **The name resolves to a birth defect.** "agensis" is read by every search and AI engine as a misspelling of "agenesis" (the medical term for an organ failing to develop). This is a compounding tax on recall, search, and AI citation. It does not necessarily mean rename, but it does mean the entity/disambiguation work (C1, C2) is non-negotiable and urgent.
2. **There is nothing for anyone — human or model — to retrieve.** One indexable page, zero third-party footprint, no entity. Until the corpus exists (C3), agensis is invisible to the exact AI-native buyers it targets.

Everything else is fixable in weeks. The foundation (SSR homepage, strong voice, a real open-runtime wedge) is better than most pre-launch products.
