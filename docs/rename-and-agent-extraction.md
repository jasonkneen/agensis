# Closed Agensis app + open-source agent extraction

> Status: agent extraction completed 2026-07-23. The website, backend, database,
> and desktop surfaces remain in this private repository. The host daemon lives
> in the public [`jasonkneen/agensis-agent`](https://github.com/jasonkneen/agensis-agent)
> repository and is published as `@agensis/agensis-agent`.

The GitHub rename from the private repository's historical `open-hatch` name is
a separate metadata operation. It is not required for the agent extraction or
the npm package and remains outside this migration record.

## Completed migration

1. Preserved the daemon's history with `git subtree split --prefix=agent`.
2. Created the public `jasonkneen/agensis-agent` repository.
3. Reorganized the public source as a small npm workspace:
   - `packages/agensis-cli` is the readable source of truth.
   - `packages/agensis-agent` builds the single-file published bundle.
4. Moved daemon tests and the `agent-v*` npm release workflow to the public
   repository.
5. Removed `agent/`, its root `file:` dependency, Docker copy step, tests, and
   release workflow from this private repository.
6. Kept the npm package name and wire contract stable, so existing hosts still
   install with `npm i -g @agensis/agensis-agent@latest`.

## Ongoing ownership rule

Daemon source, daemon tests, daemon documentation, release tags, and npm
publishing belong in `agensis-agent`. This private repo owns the server side of
the WebSocket protocol and the generated connect commands. Changes to that wire
contract must be verified against both repositories before release.

## Lean-context behavior introduced in 0.1.26

The investigation confirmed that host coding CLIs could inherit substantially
more user context than an Agensis job required. Version `0.1.26` makes isolated
execution the default for both supported CLIs:

- Claude starts in safe mode with no session persistence and a strict MCP
  configuration containing only the Agensis MCP server.
- Codex starts ephemerally, ignores user configuration and project instruction
  files, disables memories, plugins, hooks, and skill search, and receives only
  the Agensis MCP server.
- The complete daemon-generated prompt is capped at 10 KiB. Truncation preserves
  the newest request plus the mandatory identity and closing instructions.
- Daemon concurrency defaults to two coding CLI processes. Persisted legacy
  profiles carrying the former implicit value of eight migrate to two.
- Local Claude memory upload is off by default. A host operator must explicitly
  pass `--sync-memory` (or `AGENSIS_SYNC_MEMORY=1`) before the daemon sends memory
  file names, contents, sizes, and the absolute memory-root path to Agensis.
- `--full-cli-context` is the explicit compatibility escape hatch for agents
  that intentionally require the host's normal Claude or Codex customizations.

The daemon connection token is removed from the general child environment.
Lean MCP launches receive an agent-scoped token only through the child-only
`AGENSIS_MCP_TOKEN` variable required by the CLI MCP transport.

## Release record: `agent-v0.1.26`

Released on 2026-07-23:

- Public source: <https://github.com/jasonkneen/agensis-agent>
- npm package: `@agensis/agensis-agent@0.1.26`
- GitHub release: <https://github.com/jasonkneen/agensis-agent/releases/tag/agent-v0.1.26>
- Public source commit: `ac82c28c6f6eac59b844cba41d84097a7bdd8cbf`
- Private extraction commit: `2a3b1c7f78cbdc2a592719c06803802c00bc8993`

The npm package was published with public access and the `latest` dist-tag was
verified as `0.1.26`. A clean temporary-prefix installation successfully ran
both the `--version` and `--help` commands. The GitHub release contains the
31 kB `agensis-agensis-agent-0.1.26.tgz` artifact.

npm Trusted Publishing is bound to `jasonkneen/agensis-agent` and
`.github/workflows/publish-agent.yml` for future tokenless releases through
GitHub OIDC. At the time of this release, GitHub-hosted jobs remained queued at
the account level, so `0.1.26` was published through npm's browser-confirmed
local authentication. The workflow is idempotent and skips a version already
present in the registry.

## Verification evidence

The public repository passed:

- source syntax checks;
- 73 Node tests and 39 Vitest tests;
- Claude and Codex lean-argument tests;
- a real local WebSocket auth, registration, job, delta, and result contract
  test;
- version consistency checks across both packages, source constants, build
  constants, and the lockfile;
- the bundled package build;
- a packed-tarball installation and execution smoke test.

The public CI workflow also contains a Node 18 packed-artifact compatibility
lane. Its hosted run was still queued at handoff, alongside the trusted-publish
job described above; this is recorded as configured coverage, not a completed
hosted check.

After removing `agent/`, its file dependency, its Docker build input, its tests,
and its private release workflow, this private repository passed:

- TypeScript typechecking;
- `node --check server/index.cjs`;
- 317 Node tests and 203 Vitest tests;
- the production application build.

Both local working trees were clean and matched their pushed `main` branches at
handoff. The private repository remained `PRIVATE`; the agent repository was
verified `PUBLIC`. Private vulnerability reporting was enabled for the public
agent repository.
