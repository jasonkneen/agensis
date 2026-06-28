// Pure daemon helpers — no I/O. (Mirror of the app's scripts/lib/daemon.mjs so
// the package stands alone; keep them equivalent.)

/** Branch name from a task: `hilos/<kebab-first-words>-<suffix>`. */
export function branchSlug(text, suffix) {
  const base =
    String(text || "")
      .toLowerCase()
      .replace(/@[a-z0-9-]+/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .filter(Boolean)
      .slice(0, 6)
      .join("-") || "task";
  return `hilos/${base}-${suffix}`;
}

/** Truncate a diff to a byte budget at a line boundary. */
export function truncateDiff(diff, maxBytes = 12000) {
  if (diff.length <= maxBytes) return { text: diff, truncated: false, omittedLines: 0 };
  const slice = diff.slice(0, maxBytes);
  const lastNl = slice.lastIndexOf("\n");
  const kept = lastNl > 0 ? slice.slice(0, lastNl) : slice;
  const omittedLines = diff.slice(kept.length).split("\n").length - 1;
  return { text: kept, truncated: true, omittedLines };
}

/** Local checkout path for a repo from config, or null. */
export function resolveRepoPath(config, repoFullName) {
  return (config && config.repos && config.repos[repoFullName]) || null;
}

/** Parse `git diff --shortstat` output into counts. */
export function parseShortstat(s) {
  const files = /(\d+) files? changed/.exec(s || "");
  const ins = /(\d+) insertions?\(\+\)/.exec(s || "");
  const del = /(\d+) deletions?\(-\)/.exec(s || "");
  return {
    files: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/** Read a decision kind off a report object, or null if undecided. */
export function decisionKind(report) {
  return report && report.decision && report.decision.kind ? report.decision.kind : null;
}

/** Commit message for an approved proposal. */
export function commitMessage(task) {
  const first = String(task || "").split("\n")[0].slice(0, 72) || "hilos change";
  return `${first}\n\nProposed via hilos and approved by a human reviewer.`;
}

/** PR title + body for an approved proposal. */
export function prTitleBody(task, branch) {
  const title = String(task || "").split("\n")[0].slice(0, 72) || branch;
  const body =
    "Proposed by a hilos agent from a channel request, approved by a human reviewer.\n\n" +
    `Task: ${String(task || "").trim()}`;
  return { title, body };
}

/** Build the post_report payload that serves as the approval card. */
export function buildProposalReport(o) {
  const firstLine = String(o.task || "").split("\n")[0].slice(0, 72) || "task";
  const statLine = `${o.stat.files} file(s), +${o.stat.insertions}/-${o.stat.deletions} on \`${o.branch}\` in ${o.repoFullName}`;
  const diffBlock =
    "```diff\n" +
    o.diffText +
    (o.truncated ? `\n… (+${o.omittedLines} more lines)` : "") +
    "\n```";
  // Tag whoever asked so the proposal lands in their notifications, not just
  // the channel. Handle matches the server's @-mention format (kebab of name).
  const handle = mentionHandle(o.requester);
  const lead = handle ? `@${handle} — proposed changes for: ${firstLine}` : `Proposed changes for: ${firstLine}`;
  const summary = `${lead}\n\n${statLine}\n\n${diffBlock}`;
  const caveats = ["Not pushed yet — approve to push + open a PR, or reject to discard."];
  if (o.runFailed) caveats.push("The coding agent exited non-zero; review the diff carefully.");
  return { title: `Proposal: ${firstLine}`, summary, caveats, todos: [] };
}

/** kebab handle from a display name (matches the server's mention handle). */
export function mentionHandle(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
