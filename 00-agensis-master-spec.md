---
title: agensis.io — Master Spec (Gap Analysis + SEO + GEO + Marketing)
date: 2026-07-24
status: v1
owner: Suavecito (working with the agensis creator)
benchmark: current 2026 best practice
companions: 01-gap-analysis · 02-seo-spec · 03-geo-spec · 04-marketing-spec
---

# agensis.io — Master Spec

One document to bring agensis.io's **information, SEO, GEO, and marketing** up to the latest 2026 spec. This is the standalone executive version; the four companion docs hold the full detail and templates.

---

## Executive summary

agensis.io is a well-voiced, server-rendered pre-launch marketing page for an "agentic workspace" (Slack for AI agents: channels, threads, memory, presence, canvas, open MCP-native runtime). The **foundation is better than most pre-launch sites**, but three things cap it hard:

1. **The brand name resolves to a medical term.** Search and AI engines read "agensis" as a misspelling of "agenesis" (an organ failing to develop). Zero brand SERP presence; LLMs auto-correct the name. This is a compounding tax on every recall/search/AI-citation channel. **P0.**
2. **Nothing is retrievable.** One indexable page, no entity node (no Wikidata/Organization schema), no third-party footprint (no Product Hunt, Crunchbase, G2, GitHub). AI answer engines have nothing to cite for the exact AI-native buyer agensis targets. **P0.**
3. **Soft-404 architecture.** Every non-root route returns HTTP 200 with a generic PWA app shell, and robots.txt / sitemap.xml / structured data appear absent. **P0 hygiene.**

The category is hot but crowded (OpenAgents is the closest rival; Slack Agentforce and Microsoft are the incumbent shadow). agensis's defensible wedge is **open, neutral, model-agnostic, MCP-native + agent-to-agent mesh + presence** — which the current site buries under vibe.

**90-day target:** clean technical foundation, an established disambiguated entity, a conversion-ready homepage with a named ICP and proof, and the first third-party corpus so agensis is findable by humans and citable by models.

---

## Current-state audit (verified 2026-07-24)

**Working:** homepage `/` is server-rendered with real content; single H1; clean H2s; canonical tag; og:title + og:description; strong, distinctive copy voice.

**Broken / missing:**
- Soft-404: all non-root paths return 200 + PWA shell ("agensis — AI Workspace" / "AI-powered workspace for documents, chat, and memory").
- Two conflicting site descriptions (marketing vs app shell).
- robots.txt, sitemap.xml, JSON-LD, og:image, Twitter cards — not detected [confirm via checklist in SEO spec].
- Brand SERP: "agensis" → medical "agenesis" + Agenus biotech; no brand results.
- No entity node, no third-party profiles, no reviews, no press.
- Marketing: no named ICP, no proof, no demo, no intent capture, positioning/wedge not explicit.

---

## Consolidated gap register (severity)

**P0 (blockers)**
Soft-404 fix · robots.txt · sitemap.xml · JSON-LD schema graph · Wikidata entity + name disambiguation · intent capture (waitlist) · canonical definition sentence · pick one beachhead ICP · explicit positioning.

**P1 (important)**
Real content pages (/about, /how-it-works, /use-cases, /pricing, /docs) · og:image + Twitter cards · CWV baseline · extractable copy + FAQ + comparison pages · messaging house · homepage conversion rebuild · demo · proof/logos · sharpen open-runtime wedge.

**P2 (compounding)**
Third-party corpus + reviews · llms.txt · AI-visibility tracking · tiered launch execution · battlecards · pricing signal.

---

## 90-day roadmap

**Phase 1 — Foundation & disambiguation (weeks 1–2)**
- Kill the soft-404: real 404/410 for unknown routes; move the app to `app.agensis.io`.
- Ship real `/robots.txt` (allow AI crawlers) and `/sitemap.xml`.
- Add the Organization + WebSite + SoftwareApplication JSON-LD graph with `sameAs[]` on every page.
- Create the **Wikidata item**; claim LinkedIn / Crunchbase / GitHub / Product Hunt / G2 with a byte-identical name lockup + description.
- Add the canonical definition sentence everywhere; unify the two site descriptions.
- Add waitlist/email + "become a design partner" capture.
- Decide the beachhead ICP and write the one-page positioning doc.

**Phase 2 — Depth, conversion, proof (weeks 3–6)**
- Build real content pages + FAQ blocks + comparison/alternatives pages (vs OpenAgents, vs Agentforce).
- Add og:image + Twitter cards; baseline Core Web Vitals (watch INP).
- Rebuild the homepage to the conversion spec (clarity subhead, social proof, use cases, demo, CTA hierarchy).
- Write the messaging house; sharpen the neutral/open-runtime wedge in all copy.
- Ship a 60-second demo + first design-partner logos.

**Phase 3 — Corpus & launch (weeks 7–12)**
- Product Hunt + Show HN launch; seed G2/Capterra reviews; earn listicle inclusion + mentions; participate on Reddit/HN/Discord.
- Publish original data/research on multi-agent coordination.
- Ship `/llms.txt` + `/llms-full.txt`.
- Stand up AI-visibility tracking + AI-crawler log monitoring + GA4 AI referral segment.
- Build battlecards; add a beta pricing/free story.

---

## Ready-to-paste assets (details in companion docs)

**robots.txt** — allow AI crawlers + list sitemap (SEO spec §2).
**sitemap.xml** — canonical 200 URLs only (SEO spec §3).
**JSON-LD graph** — Organization + WebSite + SoftwareApplication with sameAs[] (SEO spec §4).
**OG + Twitter meta** — 1200×630 shared image (SEO spec §6).
**llms.txt / llms-full.txt** — cheap insurance (GEO spec §6).

**Canonical definition (use verbatim everywhere — site, schema, Wikidata, LinkedIn, Crunchbase, G2):**
> agensis is an agentic workspace where humans and AI agents work together in channels and threads, with persistent memory, live presence, and a shared canvas, built on an open, MCP-native, model-agnostic runtime.

---

## The one-paragraph "why this matters"

Two problems dominate: the name reads as a birth defect to every engine, and there is nothing for humans or models to retrieve. Both are addressable in weeks, and the underlying product story (an open, neutral, multi-agent-native workspace) is genuinely differentiated against a field that's either open-but-thin (OpenAgents) or closed-and-locked-in (Slack/Microsoft). Fix the foundation, win the entity, name the buyer, and ship the corpus — in that order.

---

## Companion documents
- `01-agensis-gap-analysis.md` — full gap register with per-item fixes
- `02-agensis-seo-spec.md` — 2026 technical/on-page SEO + paste-ready code + audit checklist
- `03-agensis-geo-spec.md` — generative engine optimization play + entity + llms.txt
- `04-agensis-marketing-spec.md` — positioning, messaging, ICP/JTBD, category, launch, homepage, battlecards (pre-filled for agensis)
