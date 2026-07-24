---
title: agensis.io — SEO Spec (2026)
date: 2026-07-24
status: v1
benchmark: Google 2026 technical + on-page SEO (CWV/INP, schema v30, JS rendering, AI Overviews)
---

# agensis.io — SEO Spec (2026)

The current-spec standard, agensis's state against it, and ready-to-paste fixes. Ends with a copy-paste audit checklist.

---

## 1. Rendering & indexation (the P0 block)

**Spec.** For a JS/SPA marketing site, the primary content, `<title>`, meta description, canonical, and JSON-LD must be present in the **initial HTML response** (SSR or SSG), not injected after client render. Googlebot renders in two waves and JS-only content is indexed slower and less reliably. Dynamic rendering is deprecated. Every URL must return a **correct HTTP status**: 200 for real pages, 404/410 for missing, 301 for moved. A SPA that shows a "not found" UI while returning 200 is a **soft 404** and pollutes the index.

**agensis now.** Homepage `/` is correctly SSR with real content. But **every non-root path returns HTTP 200 with the PWA app shell** (generic title "agensis — AI Workspace", meta "AI-powered workspace for documents, chat, and memory"). That is a soft-404 catch-all: `/how-it-works`, `/robots.txt`, `/sitemap.xml`, and random strings all resolve to the shell.

**Fix.**
- Serve real content routes (SSG/SSR): `/`, `/about`, `/how-it-works`, `/use-cases`, `/pricing`, `/docs`, comparison pages.
- Make unknown routes return a real **404** (or 410), not the 200 app shell.
- Keep the app (authenticated product) on its own path/subdomain (e.g. `app.agensis.io`) so the marketing site and app shell don't collide on meta and status.

**Rendering strategy (best → worst for SEO):** SSG for stable marketing pages → SSR/ISR for dynamic → CSR only for the logged-in app.

## 2. robots.txt

**Spec.** Root only, plain text/UTF-8, under 500 KiB. Don't block JS/CSS. **Allow AI crawlers** (blocking removes you from AI answer surfaces). Reference the sitemap.

**agensis now.** `/robots.txt` returns the app shell — **no real robots file** [verify with the checklist].

**Fix — paste this at `https://agensis.io/robots.txt`:**
```
User-agent: *
Allow: /

# AI answer engines — explicitly allowed (do not block)
User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /

Sitemap: https://agensis.io/sitemap.xml
```

## 3. XML sitemap

**Spec.** Up to 50,000 URLs / 50 MB uncompressed per file (index beyond that). Include only canonical, indexable, 200-status URLs. Accurate `<lastmod>` (used as a crawl hint — don't fake it). Submit in Search Console.

**agensis now.** `/sitemap.xml` returns the app shell — **no real sitemap** [verify].

**Fix — generate `https://agensis.io/sitemap.xml`:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agensis.io/</loc><lastmod>2026-07-24</lastmod></url>
  <url><loc>https://agensis.io/about</loc><lastmod>2026-07-24</lastmod></url>
  <url><loc>https://agensis.io/how-it-works</loc><lastmod>2026-07-24</lastmod></url>
  <url><loc>https://agensis.io/use-cases</loc><lastmod>2026-07-24</lastmod></url>
  <url><loc>https://agensis.io/pricing</loc><lastmod>2026-07-24</lastmod></url>
  <url><loc>https://agensis.io/docs</loc><lastmod>2026-07-24</lastmod></url>
  <url><loc>https://agensis.io/vs/openagents</loc><lastmod>2026-07-24</lastmod></url>
</urlset>
```

## 4. Structured data (schema.org, JSON-LD) — P0 for both SEO and GEO

**Spec (2026).** Emit JSON-LD in `<head>`, server-rendered, as one connected graph linked by `@id`. Live types that matter for SaaS: **Organization** (entity trust + Knowledge Panel + AI entity resolution), **WebSite**, **SoftwareApplication/WebApplication** (product entity), **BreadcrumbList** (still renders in SERPs). **Deprecated for rich results:** FAQPage (retired 7 May 2026) and HowTo (dead) — the markup is still valid and still useful for AI extraction, but expect no SERP rich result.

**agensis now.** No JSON-LD detected [verify].

**Fix — paste this graph into `<head>` on every marketing page** (swap founder/social values):
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://agensis.io/#org",
      "name": "agensis",
      "url": "https://agensis.io/",
      "logo": "https://agensis.io/logo.png",
      "description": "agensis is a shared workspace for humans and AI agents, with channels, threads, persistent memory, live presence, and a shared canvas on an open, MCP-native, model-agnostic runtime.",
      "foundingDate": "2026",
      "sameAs": [
        "https://www.linkedin.com/company/agensis",
        "https://www.crunchbase.com/organization/agensis",
        "https://github.com/agensis",
        "https://www.producthunt.com/products/agensis",
        "https://x.com/agensis",
        "https://www.wikidata.org/wiki/QXXXXXXX"
      ]
    },
    {
      "@type": "WebSite",
      "@id": "https://agensis.io/#website",
      "url": "https://agensis.io/",
      "name": "agensis",
      "publisher": { "@id": "https://agensis.io/#org" }
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://agensis.io/#app",
      "name": "agensis",
      "applicationCategory": "BusinessApplication",
      "applicationSubCategory": "Agentic Workspace",
      "operatingSystem": "Web",
      "description": "A shared workspace where AI agents work with you, your team, and each other, in channels and threads, with persistent memory, live presence, and a shared canvas. MCP-native and model-agnostic.",
      "publisher": { "@id": "https://agensis.io/#org" },
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD", "description": "Free during beta" }
    }
  ]
}
</script>
```
Rule: the `description` string here must be **byte-identical** to the one you use on Wikidata, LinkedIn, Crunchbase, and G2. Consistency is how LLMs merge you into one entity node (see GEO spec §Entity).

## 5. On-page

**Spec.** One `<h1>`; logical h2/h3; title ~50–60 chars (brand at end); meta description ~150–160 chars; descriptive `<a href>` internal links (not JS onClick); AVIF/WebP images with `alt`, dimensions (CLS), lazy-load below-fold only (never the LCP image).

**agensis now.** Homepage is clean here: single H1 ("A place where agents work."), coherent H2s, a good title and meta. Keep it. The gaps are the missing sub-pages (no internal linking graph yet) and unconfirmed image optimization.

## 6. Social share cards (Open Graph + X)

**Spec.** `og:title`, `og:description`, `og:image` (1200×630, absolute HTTPS), `og:url`, `og:type`, `og:site_name`, `og:image:alt`. X: `twitter:card=summary_large_image` + `twitter:title/description/image` (< 5 MB). Point `og:image` and `twitter:image` at the **same** absolute HTTPS URL.

**agensis now.** og:title + og:description present. **No og:image, no Twitter tags** [verify]. For a product that will spread through Slack/X/LinkedIn shares at launch, this is a live conversion leak — links render as bare text.

**Fix — add to `<head>`:**
```html
<meta property="og:type" content="website">
<meta property="og:site_name" content="agensis">
<meta property="og:title" content="agensis — where agents come to work">
<meta property="og:description" content="A shared workspace where AI agents work with you, your team, and each other — channels, threads, memory, presence, and a shared canvas.">
<meta property="og:url" content="https://agensis.io/">
<meta property="og:image" content="https://agensis.io/og-image.png">
<meta property="og:image:alt" content="agensis — a shared workspace for humans and AI agents">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="agensis — where agents come to work">
<meta name="twitter:description" content="A shared workspace where AI agents work with you, your team, and each other.">
<meta name="twitter:image" content="https://agensis.io/og-image.png">
<meta name="twitter:image:alt" content="agensis — a shared workspace for humans and AI agents">
```

## 7. Core Web Vitals

**Spec (2026, 75th-percentile field data, all three must pass):** LCP ≤ 2.5s · **INP ≤ 200ms** (replaced FID) · CLS ≤ 0.1. SPAs most often fail **INP** (hydration, long main-thread tasks). CWV are a tie-breaker signal, not an override.

**agensis now.** Unknown — no field data accessed. Action: baseline in PageSpeed Insights + CrUX. Given it's a modern SPA, watch INP: code-split, defer non-critical JS, minimize hydration; preload the LCP hero image with `fetchpriority="high"`; set explicit dimensions on all media for CLS.

## 8. AI Overviews implication

Rank ≠ citation. AI Overviews cite 3–5 sources chosen by structure, claim clarity, and entity authority — not purely position. Everything in the GEO spec (entity, extractable content, comparison pages, third-party corroboration) is the real lever; the technical items here make agensis eligible to be seen at all.

---

## Copy-paste audit checklist (run these to confirm the [verify] items)

Run in a browser console on `https://agensis.io/` (or view-source):

```js
// 1. Structured data present?
[...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent);

// 2. OG + Twitter image tags present?
['og:image','twitter:card','twitter:image'].map(p =>
  document.querySelector(`meta[property="${p}"],meta[name="${p}"]`)?.content || `MISSING: ${p}`);

// 3. Canonical
document.querySelector('link[rel=canonical]')?.href;

// 4. Favicon + manifest
[document.querySelector('link[rel~="icon"]')?.href, document.querySelector('link[rel="manifest"]')?.href];

// 5. H1 count (should be exactly 1)
document.querySelectorAll('h1').length;
```

Real HTTP-status checks (terminal, run by the creator):
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://agensis.io/robots.txt        # want 200 + real robots
curl -s -o /dev/null -w "%{http_code}\n" https://agensis.io/sitemap.xml        # want 200 + real XML
curl -s -o /dev/null -w "%{http_code}\n" https://agensis.io/nonexistent-xyz    # want 404, NOT 200
curl -sL https://agensis.io/robots.txt | head -5                                # inspect content
```
Also: Search Console → URL Inspection → "View crawled/rendered HTML" to confirm content, canonical, and schema survive rendering.

---

## Sources
- Core Web Vitals / INP thresholds — [corewebvitals.io](https://www.corewebvitals.io/core-web-vitals), [DigitalApplied 2026](https://www.digitalapplied.com/blog/core-web-vitals-2026-inp-lcp-cls-optimization-guide)
- FAQ rich-result retirement — [Search Engine Journal](https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/)
- Schema updates 2026 — [DigitalApplied](https://www.digitalapplied.com/blog/structured-data-after-io-2026-schema-updates)
- JavaScript SEO / rendering — [W3era](https://www.w3era.com/blog/seo/javascript-seo-guide/)
- OG / X card sizes — [Krumzi 2026](https://www.krumzi.com/blog/open-graph-image-sizes-for-social-media-the-complete-2026-guide)
- AI Overviews impact — [Stackmatix](https://www.stackmatix.com/blog/google-ai-overviews-impact-seo-2026)
