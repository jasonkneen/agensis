# Agent file-memory — implementation plan

Goal: surface an agent's **file-backed memory** (the `~/.claude/projects/<slug>/memory/`
palace it actually uses) inside the app's Memory section — browsable, filterable by
agent, alongside the existing DB-native `memory_facts`. Phase 1 is a **read-only mirror
plus a comment layer**; two-way write-back is deferred to phase 2.

## Resolved design forks

1. **Push-mirror, not request/reply.** The daemon *pushes* file data up over the existing
   WS (same direction as `agent_job_result`). The server stores rows and calls
   `notifyDbSubscribers('agent_memory_files', …)`; the frontend just reads the table.
   The only server→daemon signal is a fire-and-forget `agent_memory_refresh` nudge — the
   answer comes back as a push. **No synchronous request/reply correlation over the WS.**
   The frontend never blocks on the daemon being online.

2. **Discovery vs content split.** "Ask the agent where its memory lives" (LLM, roots +
   summaries, persisted once) is separate from reading file *content* (deterministic fs,
   allowlisted). v1 derives the root deterministically from `cwd`
   (`~/.claude/projects/<cwd-with-slashes-as-dashes>/memory/`) and honors an explicit
   `memory_dir` override on the agent — no LLM round-trip needed for the mirror itself.

3. **Comments anchored to `(agent_id, path)`, not a FK to the file row.** Sync UPSERTs
   files by `UNIQUE(agent_id, path)` (never delete+reinsert), and comments key off the
   stable `(agent_id, path)` identity. Comments survive re-sync and even file deletion.

4. **Scope = local daemon path only.** Daemon-reads-fs only works for the local daemon
   (`run_mode='builtin'`, what this process is). External MCP agents (Cursor/Codex) have
   no daemon doing fs and are **explicitly deferred** — they'd volunteer files via an MCP
   tool in a later phase. Not silently unhandled.

## Security gate (non-negotiable)

The daemon exposes filesystem reads to the web UI. Hard constraints:
- Root = the derived palace dir (or explicit `memory_dir`), `fs.realpath`'d.
- Every target is `realpath`'d and must satisfy `resolved.startsWith(root + path.sep)`.
- **Reads only.** No writes in phase 1.
- Verified with a real `../../etc/passwd` rejection test against the actual filesystem.

## Build order (verify each before the next)

1. **Schema** — `agent_memory_files`, `memory_file_comments`, `workspace_agents.memory_dir`.
2. **Daemon** — palace-path derivation + allowlist + enumerate/read. Unit-tested incl.
   traversal rejection. *(security gate lives here)*
3. **Server** — `agent_memory_sync` ingest (UPSERT + notify) + `agent_memory_refresh`
   nudge + comment CRUD endpoints.
4. **Frontend** — MemorySection agent filter + file browser (reads `content_cache`) +
   comment thread panel (near-copy of `document_comments`). Requires `types` + the
   Supabase-style `backendClient` table whitelist to surface the new tables.

## Phase 2 (deferred)
- Two-way write-back when the file is in a repo attached with edit permission
  (carries edit-conflict reconciliation: app edit vs the agent rewriting the file).
- LLM-mediated discovery ("summarize your recent memories") populating per-file summaries.
- External (non-daemon) MCP agents volunteering files via an MCP tool.
