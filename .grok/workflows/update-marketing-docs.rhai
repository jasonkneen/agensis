// update-marketing-docs.rhai
//
// Re-sync marketing surfaces (landing, public/docs, sitemap, llms.txt) with the
// product that actually ships. Run after a feature-heavy week or before a
// marketing deploy.
//
// Invoke:
//   /workflow update-marketing-docs
//   or the workflow tool with name: "update-marketing-docs"
//
// Args (all optional):
//   args.deploy = true   — after a green verify, deploy Netlify prod
//   args.dry_run = true  — inventory + gaps only; no writes
//
// Surfaces owned by this workflow (do not invent parallel ones):
//   public/landing/index.html     — site root (/) via netlify rewrite
//   public/docs/**                — static HTML docs
//   public/sitemap.xml
//   public/llms.txt
//   public/release-notes.json     — hand-maintained; only check for staleness
//
// Hidden marketing (intentional; do not unhide without product sign-off):
//   #pricing on the landing page — billing not live
//
// Previously hidden, now intended live: #use-cases, Docs/Blog nav+footer links.

let meta = #{
    name: "update-marketing-docs",
    description: "Inventory product features vs landing/docs and update marketing surfaces",
    when_to_use: "After shipping user-visible features, before a Netlify marketing deploy, or when docs/FAQ lag the product",
    phases: [
        #{ title: "Inventory", detail: "code + release notes → feature list" },
        #{ title: "Gap analysis", detail: "landing, docs, sitemap, llms" },
        #{ title: "Apply", detail: "update surfaces (skipped if dry_run)" },
        #{ title: "Verify", detail: "routing tests + link checks" },
        #{ title: "Deploy", detail: "optional Netlify prod" },
    ],
};

let inventory_schema = #{
    "type": "object",
    "required": ["features", "sources"],
    "properties": #{
        "sources": #{ "type": "array", "items": #{ "type": "string" } },
        "features": #{
            "type": "array",
            "maxItems": 40,
            "items": #{
                "type": "object",
                "required": ["id", "title", "user_visible", "doc_path_hint"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "title": #{ "type": "string" },
                    "user_visible": #{ "type": "boolean" },
                    "doc_path_hint": #{ "type": "string" },
                    "landing_surface": #{ "type": "string" },
                    "notes": #{ "type": "string" },
                },
            },
        },
    },
};

let gaps_schema = #{
    "type": "object",
    "required": ["gaps", "ok"],
    "properties": #{
        "ok": #{ "type": "array", "items": #{ "type": "string" } },
        "gaps": #{
            "type": "array",
            "maxItems": 30,
            "items": #{
                "type": "object",
                "required": ["surface", "issue", "severity", "suggested_fix"],
                "properties": #{
                    "surface": #{ "type": "string" },
                    "issue": #{ "type": "string" },
                    "severity": #{ "type": "string" },
                    "suggested_fix": #{ "type": "string" },
                },
            },
        },
    },
};

let apply_schema = #{
    "type": "object",
    "required": ["changed_files", "summary"],
    "properties": #{
        "summary": #{ "type": "string" },
        "changed_files": #{ "type": "array", "items": #{ "type": "string" } },
        "left_hidden": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let dry = false;
let do_deploy = false;
if args != () {
    if args.dry_run == true { dry = true; }
    if args.deploy == true { do_deploy = true; }
}

// ---------------------------------------------------------------------------
phase("Inventory");
// ---------------------------------------------------------------------------

let inv_prompt = "";
inv_prompt += "You are inventorying USER-VISIBLE product features for the agensis marketing site.\n";
inv_prompt += "Use read-only tools. Do not edit files.\n\n";
inv_prompt += "Read these sources (all of them that exist):\n";
inv_prompt += "1. public/release-notes.json (newest first — user-visible language)\n";
inv_prompt += "2. AGENTS.md sections on recent features (join links, automations, templates, audit, vault, permissions, gateways, purpose/resources)\n";
inv_prompt += "3. public/docs/index.html (what docs already claim)\n";
inv_prompt += "4. public/landing/index.html — sections #caps, #faq, #use-cases, nav, footer\n";
inv_prompt += "5. Window components under src/components/windows/ for product surfaces\n";
inv_prompt += "6. tests/mcp-public-surface.test.cjs PUBLIC_TOOL_SURFACE for MCP tool count/names\n\n";
inv_prompt += "Return features that a visitor or admin would care about. Skip pure internal refactors.\n";
inv_prompt += "doc_path_hint should be like /docs/automations/ even if the page is missing.\n";
inv_prompt += "landing_surface: one of caps|faq|use-cases|hero|nav|none.\n";

let inv = agent(inv_prompt, #{
    label: "inventory",
    capability_mode: "read-only",
    output_schema: inventory_schema,
});

if inv == () || !inv.success || inv.output.features == () {
    pause("verification", "Inventory agent failed — resume after inspecting /workflows journal, or re-run.");
}

log("Inventory: " + inv.output.features.len().to_string() + " features from " + inv.output.sources.len().to_string() + " sources");

// ---------------------------------------------------------------------------
phase("Gap analysis");
// ---------------------------------------------------------------------------

let gap_prompt = "";
gap_prompt += "Compare the feature inventory below against the LIVE marketing surfaces and list GAPS only.\n";
gap_prompt += "Read public/landing/index.html, every public/docs/**/index.html, public/sitemap.xml, public/llms.txt.\n";
gap_prompt += "Use grep/read_file — do not answer from memory.\n\n";
gap_prompt += "Rules:\n";
gap_prompt += "- A feature is a gap if docs omit it, FAQ contradicts it, caps ignore a major surface, or sitemap misses a real page.\n";
gap_prompt += "- Pricing stays HIDDEN on purpose (billing not live) — do not flag that as a gap.\n";
gap_prompt += "- Docs/Blog should appear in landing nav+footer; use-cases should be visible if content is finished.\n";
gap_prompt += "- severity: high|medium|low\n";
gap_prompt += "- ok: surfaces that are accurate enough\n\n";
gap_prompt += "FEATURE INVENTORY JSON:\n";
gap_prompt += json_encode(inv.output.features);

let gaps = agent(gap_prompt, #{
    label: "gaps",
    capability_mode: "read-only",
    output_schema: gaps_schema,
});

if gaps == () || !gaps.success || gaps.output.gaps == () {
    pause("verification", "Gap analysis failed — resume or re-run.");
}

log("Gaps: " + gaps.output.gaps.len().to_string() + " · ok: " + gaps.output.ok.len().to_string());

if dry {
    let report = "DRY RUN — no files written.\n\nGaps:\n" + json_encode(gaps.output);
    let path = write_scratch_file("marketing-gaps.json", report);
    complete(#{ mode: "dry_run", path: path, gap_count: gaps.output.gaps.len(), gaps: gaps.output.gaps });
}

if gaps.output.gaps.len() == 0 {
    log("No gaps — still running verify for link hygiene.");
}

// ---------------------------------------------------------------------------
phase("Apply");
// ---------------------------------------------------------------------------

let apply_prompt = "";
apply_prompt += "Update agensis marketing surfaces to close the gaps below.\n";
apply_prompt += "WRITE only under: public/landing/, public/docs/, public/sitemap.xml, public/llms.txt.\n";
apply_prompt += "Do NOT touch server/, src/ app code, netlify.toml pricing 404 rules unless a gap explicitly requires it.\n";
apply_prompt += "Do NOT unhide #pricing (billing not live).\n";
apply_prompt += "Match existing prose: plain, accurate, no hype, same HTML/CSS idioms as neighboring docs pages.\n";
apply_prompt += "When adding a docs page: full HTML shell with shared sidenav groups (Start, Agents, Conversation, The workspace, Connect, Operate), docs.css, footer, canonical URL.\n";
apply_prompt += "After new pages: update public/docs/index.html cards, every page's sidenav, sitemap lastmod, llms.txt.\n";
apply_prompt += "Landing: keep root-entry.js script and an <a href=\"/app\">Open the app</a> (tests/root-routing.test.cjs).\n";
apply_prompt += "Style: Instrument Serif/Sans, IBM Plex Mono, accent #4f9cf9, dark bg #08090b.\n\n";
apply_prompt += "GAPS JSON:\n";
apply_prompt += json_encode(gaps.output.gaps);
apply_prompt += "\n\nFEATURE CONTEXT:\n";
apply_prompt += json_encode(inv.output.features);

let applied = agent(apply_prompt, #{
    label: "apply-updates",
    capability_mode: "read-write",
    output_schema: apply_schema,
});

if applied == () || !applied.success {
    pause("verification", "Apply agent failed — inspect partial edits before resuming.");
}

log("Changed: " + applied.output.changed_files.len().to_string() + " files — " + applied.output.summary);

// ---------------------------------------------------------------------------
phase("Verify");
// ---------------------------------------------------------------------------

let verify_prompt = "";
verify_prompt += "Verify marketing surfaces after the update.\n";
verify_prompt += "1. Run: node --test tests/root-routing.test.cjs\n";
verify_prompt += "2. Confirm every public/docs/*/index.html has a consistent sidenav linking new pages.\n";
verify_prompt += "3. Confirm public/sitemap.xml lists every docs page that exists on disk.\n";
verify_prompt += "4. Confirm public/landing/index.html nav+footer link to /docs/ and /landing/blog/.\n";
verify_prompt += "5. Confirm #pricing still has hidden attribute; #use-cases does not.\n";
verify_prompt += "6. Spot-check FAQ does not claim billing is live.\n";
verify_prompt += "If anything fails, FIX it under public/ only, then re-run the checks.\n";
verify_prompt += "Return a short text summary of pass/fail and any fixes you made.";

let verified = agent(verify_prompt, #{
    label: "verify",
    capability_mode: "execute",
});

if verified == () || !verified.success {
    pause("verification", "Verify step failed — fix tests or content before deploy.");
}

// ---------------------------------------------------------------------------
phase("Deploy");
// ---------------------------------------------------------------------------

if !do_deploy {
    let path = write_scratch_file("marketing-update-summary.md", applied.output.summary + "\n\nVerify:\n" + verified.output);
    complete(#{
        deployed: false,
        summary: applied.output.summary,
        changed_files: applied.output.changed_files,
        verify: verified.output,
        path: path,
        hint: "Re-run with args.deploy=true to netlify deploy --build --prod",
    });
}

let deploy_prompt = "";
deploy_prompt += "Deploy the frontend (landing + docs are static under public/, built by Vite into dist/) to Netlify production.\n";
deploy_prompt += "Working directory is the agensis repo root.\n";
deploy_prompt += "1. Confirm git status for public/landing public/docs public/sitemap.xml public/llms.txt is intentional.\n";
deploy_prompt += "2. Run: netlify deploy --build --prod\n";
deploy_prompt += "   (project open-hatch → https://agensis.io). Frontend only — no fly deploy for marketing HTML.\n";
deploy_prompt += "3. Return the deploy URL and whether the command exited 0.\n";
deploy_prompt += "Do not force-push git. Do not fly deploy unless the user already asked in this run's args (they did not).\n";

let deployed = agent(deploy_prompt, #{
    label: "deploy-netlify",
    capability_mode: "execute",
});

if deployed == () || !deployed.success {
    pause("infra", "Netlify deploy failed — check auth and build logs.");
}

complete(#{
    deployed: true,
    summary: applied.output.summary,
    changed_files: applied.output.changed_files,
    verify: verified.output,
    deploy: deployed.output,
});
