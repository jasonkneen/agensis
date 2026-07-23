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
