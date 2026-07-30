# Open-Source Provenance Cleanup

## Summary

Prepare `agensis` and `agensis-agent` for later open-source publication without
performing the cleanup or rewriting history until those phases are explicitly
authorized.

The current trees are blocked by explicit feature-transfer artifacts, competitor
research, source-attribution comments, private-project claims, and unresolved asset
provenance. Genuine runtime, dependency, provider, deployment, and integration names
remain where operationally necessary.

## Implementation

### 1. Public-source boundary

- Preserve the existing user changes in `package.json`,
  `src/hooks/useHuddleVoice.ts`, and untracked `build/`.
- Remove development-only research and work records from the eventual public
  snapshot: `plans/`, `cascade/`, `feedback/`, internal marketing specifications,
  review/status/scratch reports, and local agent configuration directories such as
  `.claude/`, `.qwen/`, and `.grok/`.
- Retain actual product documentation, distributable plugins, migrations, tests, and
  contributor instructions after sanitization.
- Remove all competitor comparison and battlecard material, including references to
  OpenAgents, Agentforce, and similar products.

### 2. Provenance cleanup

- Remove non-operational source-product identities and transfer terminology,
  including Buzz, OpenPath, Vibeclaw, Almostnode, Cluso, Blossom, “borrowed from,”
  “copied from,” “directly portable,” “port from,” “reimplement X,” and
  “reverse-engineer.”
- Rewrite active comments and tests to explain Agensis behavior directly. This
  includes the Inbox presentation, thread broadcasting, huddle state, audit-detail
  sanitization, permission matching, skills/avatar presentation, and stop-reason
  tests.
- Rename source-associated internal feature/theme identifiers such as TinyWorld while
  retaining backward-compatible reads for existing persisted settings.
- Regenerate the tracked `agensis-agent` bundle after its readable source strings
  change.

### 3. Independent implementation and licensing gate

- Independently reauthor the specifically contaminated surfaces: Inbox layout,
  visual-editor shadow presets, huddle state model, and shared-inference/Farm
  behavior. Use only Agensis requirements, public protocol documentation, and
  behavior-level tests; do not consult the named source products.
- Remove any feature whose independent provenance cannot be established without
  reproducing another implementation.
- Inventory every bundled image, avatar, font, icon, generated component, and
  vendored asset in an `ASSETS.md` or third-party notice with author, source, licence,
  and hash. Replace or remove anything without documented ownership.
- Preserve required copyright and dependency attribution; the cleanup must never
  delete legally required notices.
- Add or complete `CONTRIBUTING.md`, `SECURITY.md`, third-party notices, and
  consistent MIT/public-source language. Remove claims that the app, backend, or
  desktop repository is private.

### 4. Automated publication guard

- Add a `node:test` public-source hygiene test independently to both repositories and
  run it through `npm run ci` and `npm run verify`.
- Scan tracked and non-ignored untracked text files using
  `git ls-files --cached --others --exclude-standard`.
- Fail with `path:line`, category, and excerpt for:
  - source-pack/extraction markers and personal source paths;
  - copying, porting, reverse-engineering, imitation, or feature-transfer
    constructions;
  - prohibited competitor/source identities;
  - private/closed-source claims;
  - undocumented binary assets.
- Include positive and negative fixtures so ordinary `TextDecoder`, URL decoding,
  clipboard copying, Docker `COPY`, network ports, `git clone`, internal parity
  tests, licences, and operational provider/integration names remain allowed.
- Add anti-vacuity checks proving both repositories and their generated/public
  artifacts were actually scanned.

## Verification

- Run the focused hygiene tests in both repositories.
- Run `npm run ci` in `agensis`.
- Run `npm run verify`, artifact smoke tests, and `npm pack --dry-run` in
  `agensis-agent`.
- Run secret scanning, dependency-licence validation, asset-manifest validation, and
  `git diff --check`.
- Build both repositories from fresh clean checkouts and inspect the packed daemon
  contents.
- Manually review every remaining third-party name and classify it as an operational
  integration, dependency attribution, public protocol, or violation. No unclassified
  names pass.

## Deferred Publication History

- Do not rewrite, squash, regenerate, force-push, or publish history during the
  cleanup implementation.
- When separately authorized for publication, create a fresh sanitized
  orphan-root/squashed public history rather than exposing the existing commits.
- Publish no old branches or tags.
- Scan every blob and commit message reachable from the proposed public refs before
  pushing.
- Confirm the new public history contains none of the removed plans, competitor
  research, personal paths, session links, source-product names, or provenance
  language.

## Acceptance Criteria

- Both current public-source snapshots pass the automated hygiene policy.
- Competitor and source-product references are absent; genuine operational names
  remain.
- No active code, comment, test, document, commit message, or distributed artifact
  suggests copying, porting, decoding, reverse-engineering, or recreating another
  product.
- Every shipped asset and third-party component has documented redistribution
  rights.
- Both repositories pass their full verification suites from clean checkouts.
- Final reporting describes this as an engineering provenance and redistribution
  audit, not a guarantee of legal clearance.
