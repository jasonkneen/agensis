// CANONICAL HANDLER — this is what the published `hilos-agent` package ships and
// runs. Bias-to-PR by default (gate:false opens a PR; gate:true falls back to
// approve-before-push). The legacy, propose-only reference lives at
// scripts/examples/coding-agent-handler.mjs and is NOT what users run.
//
// Turn an @mention in a git-linked channel into a branch + a coding-agent run.
// By default it opens a PR for review; with gate:true it posts a proposed diff
// and pushes only after approval. Your code + credentials stay local.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  branchSlug,
  truncateDiff,
  resolveRepoPath,
  parseShortstat,
  buildProposalReport,
  decisionKind,
  commitMessage,
  prTitleBody,
  mentionHandle,
} from "./daemon.mjs";
import { runCli, buildHeartbeat, ackText, oneLine } from "./cli.mjs";

/** `@handle` for the person who asked, so the report tags them. */
function requesterTag(author) {
  const handle = mentionHandle(author);
  return handle ? `@${handle}` : "";
}

function defaultDeps() {
  return {
    git: (cwd, args) =>
      spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }),
    openPR: (cwd, { title, body, branch, base }) => {
      const r = spawnSync(
        "gh",
        ["pr", "create", "--title", title, "--body", body, "--head", branch, "--base", base],
        { cwd, encoding: "utf8" },
      );
      const url = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || null;
      return { ok: r.status === 0, url, stderr: r.stderr || "" };
    },
    // The open PR for a branch, if one already exists — so when the CLI opened a
    // PR itself we report THAT instead of opening a duplicate.
    findPR: (cwd, branch) => {
      const r = spawnSync(
        "gh",
        ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"],
        { cwd, encoding: "utf8" },
      );
      const url = (r.stdout || "").trim();
      return r.status === 0 && url ? url : null;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

async function awaitDecision({ tool, channelId, reportMessageId, cfg, deps, parentId, signal }) {
  if (!reportMessageId) return { kind: "timeout" };
  const deadline = deps.now() + cfg.decisionTimeoutMs;
  while (deps.now() < deadline) {
    // A "stop" while we wait for review must end the wait — otherwise a later
    // Approve would still commit/push/open a PR despite the cancel.
    if (signal?.aborted) return { kind: "cancelled" };
    let report = null;
    const gr = await tool("get_report", { messageId: reportMessageId }).catch(() => null);
    if (gr && gr.found && gr.report) report = gr.report;
    if (!report) {
      // Fallback for servers without get_report. In a thread the report lives
      // under the thread root (read_channel only returns top-level), so scan the
      // thread there; otherwise scan the channel tail.
      let candidates = [];
      if (parentId) {
        const t = await tool("get_thread", { parentId }).catch(() => null);
        candidates = t && t.found ? [t.root, ...(t.replies ?? [])].filter(Boolean) : [];
      } else {
        const { messages = [] } = await tool("read_channel", { channelId, limit: 200 }).catch(
          () => ({ messages: [] }),
        );
        candidates = messages;
      }
      const m = candidates.find((x) => x.id === reportMessageId);
      report = m && m.report ? m.report : null;
    }
    const kind = report ? decisionKind(report) : null;
    if (kind) return { kind, note: report.decision?.note || null };
    await deps.sleep(cfg.decisionPollMs);
  }
  return { kind: "timeout" };
}

/** Attach a just-opened PR to the channel (best-effort) so its live pill shows. */
async function linkPrFromUrl({ tool, channelId, url }) {
  if (!url) return;
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return;
  await tool("link_pr", { channelId, repoFullName: m[1], prNumber: Number(m[2]) }).catch(() => {});
}

async function applyDecision({ decision, repoPath, branch, task, requester, cfg, tool, channelId, deps, parentId }) {
  const tag = requesterTag(requester);
  const lead = tag ? `${tag} — ` : "";
  if (decision.kind === "approved") {
    // Guard: nothing staged → don't push an empty branch and falsely report "shipped".
    if (deps.git(repoPath, ["diff", "--cached", "--quiet"]).status === 0) {
      await tool("post_message", {
        channelId,
        parentId,
        body: `Approved, but there are no staged changes to commit on \`${branch}\`.`,
      });
      return { status: "nothing-staged", branch };
    }
    const commit = deps.git(repoPath, ["commit", "-m", commitMessage(task)]);
    if (commit.status !== 0) {
      await tool("post_message", {
        channelId,
        parentId,
        body: `Approved, but the commit failed: ${(commit.stderr || "").trim().slice(0, 300)}`,
      });
      return { status: "commit-failed", branch };
    }
    const push = deps.git(repoPath, ["push", "-u", "origin", branch]);
    if (push.status !== 0) {
      await tool("post_message", {
        channelId,
        parentId,
        body: `Approved, but the push failed: ${(push.stderr || "").trim().slice(0, 300)}`,
      });
      return { status: "push-failed", branch };
    }
    const { title, body } = prTitleBody(task, branch);
    const pr = deps.openPR(repoPath, { title, body, branch, base: cfg.defaultBranch });
    await tool("post_report", {
      channelId,
      parentId,
      title: `Shipped: ${title}`,
      summary:
        pr.ok && pr.url
          ? `${lead}pushed \`${branch}\` and opened a pull request.`
          : `${lead}pushed \`${branch}\`. Open a PR manually — \`gh\` failed.`,
      prUrl: pr.ok && pr.url ? pr.url : undefined,
      caveats: pr.ok ? [] : [`gh pr create failed: ${(pr.stderr || "").trim().slice(0, 200)}`],
    });
    // Work produced a PR → attach it to the channel so its live pill shows up.
    await linkPrFromUrl({ tool, channelId, url: pr.ok ? pr.url : null });
    return { status: "pushed", branch, prUrl: pr.ok ? pr.url : null };
  }

  if (decision.kind === "rejected") {
    deps.git(repoPath, ["reset", "--hard", "HEAD"]);
    deps.git(repoPath, ["clean", "-fd"]);
    deps.git(repoPath, ["switch", "-"]);
    deps.git(repoPath, ["branch", "-D", branch]);
    await tool("post_message", { channelId, parentId, body: `Rejected — discarded \`${branch}\`.` });
    return { status: "discarded", branch };
  }

  if (decision.kind === "changes") {
    await tool("post_message", {
      channelId,
      parentId,
      body: `Got it${decision.note ? `: ${decision.note}` : ""}. Leaving \`${branch}\` for a follow-up.`,
    });
    return { status: "changes", branch, note: decision.note };
  }

  await tool("post_message", {
    channelId,
    parentId,
    body: `Still awaiting review on \`${branch}\`. Re-mention me once you've decided.`,
  });
  return { status: "timeout", branch };
}

/**
 * The coding CLI committed the work itself (autonomous run with skip-permissions
 * in a repo whose docs prescribe a commit+PR flow), so the working tree is clean
 * and the daemon's diff is empty. Don't claim "no changes": adopt what it did —
 * push the branch it's on (no-op if already pushed), reuse the PR it opened or
 * open one, and report it. Used only when NOT gated (bias-to-action).
 */
async function shipSelfDriven({ repoPath, branch, task, requester, cfg, tool, channelId, deps, parentId }) {
  const tag = requesterTag(requester);
  const lead = tag ? `${tag} — ` : "";
  // The agent may have committed on the daemon's branch or switched to one of its
  // own — push whatever HEAD is on now.
  const cur =
    (deps.git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout || "").trim() || branch;
  const push = deps.git(repoPath, ["push", "-u", "origin", cur]);
  let prUrl = deps.findPR ? deps.findPR(repoPath, cur) : null;
  if (!prUrl && push.status === 0) {
    const { title, body } = prTitleBody(task, cur);
    const pr = deps.openPR(repoPath, { title, body, branch: cur, base: cfg.defaultBranch });
    prUrl = pr.ok && pr.url ? pr.url : null;
  }
  const { title } = prTitleBody(task, cur);
  await tool("post_report", {
    channelId,
    parentId,
    title: `Shipped: ${title}`,
    summary: prUrl
      ? `${lead}the coding agent committed on \`${cur}\` and opened a pull request.`
      : push.status === 0
        ? `${lead}the coding agent committed and pushed \`${cur}\`. Open a PR manually — \`gh\` didn't return one.`
        : `${lead}the coding agent committed on \`${cur}\` locally, but pushing it failed.`,
    prUrl: prUrl || undefined,
    caveats: push.status === 0 ? [] : [`git push failed: ${(push.stderr || "").trim().slice(0, 200)}`],
  });
  if (prUrl) await linkPrFromUrl({ tool, channelId, url: prUrl });
  return { status: push.status === 0 ? "pushed" : "commit-local", branch: cur, prUrl };
}

// Sentinel the router model emits when the latest message is a request to change
// code. Unusual on purpose so it can't be confused with a real chat reply.
const CODE_SIGNAL = "__CODE__";

/**
 * Decide — with the LLM, not a word list — whether the latest message wants a
 * code change or a conversational reply, and produce the payload in the SAME
 * call. The model reads the whole conversation, so it judges by intent and
 * context, in any language: "just code it", "dale, hazlo", "yeah go for it" after
 * a request → code; "how does this work?", "thoughts?", "thanks" → chat.
 *
 * For a code request it ALSO distills an imperative task brief — resolving
 * references like "this" / "keep working on it" against the conversation — so the
 * coding agent gets a clean spec instead of a noisy transcript (which, with the
 * agent's own past "no changes" messages in it, made it reply instead of edit).
 *
 * Returns one of:
 *   { aborted: true }
 *   { code: true, task }           → run the coding flow with `task` as the spec
 *   { code: false, reply, error }  → post `reply` as a chat message
 *
 * `error` is set when the model produced nothing (so the caller can be honest
 * about a timeout vs a missing binary instead of inventing a reply).
 */
async function routeIntent({ name, repoFullName, transcript, workspaceMemory, cfg, signal }) {
  const cmd = cfg.chatCmd || cfg.codingCmd;
  const parts = cmd.split(" ").filter(Boolean);
  const prompt =
    `You are ${name}, a teammate in a team chat (hilos) connected to the git repository ` +
    `${repoFullName}. Read the conversation and judge what the LATEST message wants from you.\n\n` +
    `If it is asking you to make a code or repository change — implement/fix/refactor/adjust ` +
    `something, continue or finish work discussed above, or give a go-ahead to act ("yeah, do ` +
    `it", "go for it", "just code it", "approved", "dale", in ANY language) — respond with the ` +
    `token ${CODE_SIGNAL} on the FIRST line, then on the next lines a short, imperative spec of ` +
    `exactly what to build or change, resolving any references ("this", "keep working on it") ` +
    `using the conversation. Example:\n${CODE_SIGNAL}\nAdd a hover popover to message reactions ` +
    `that lists who reacted with each emoji.\n\n` +
    `Otherwise — a question, a greeting, general discussion, or they explicitly don't want code ` +
    `yet — just reply to them concisely and directly as a single chat message (no preamble, no ` +
    `headings). When unsure, prefer to act (${CODE_SIGNAL}); this is a build channel.\n\n` +
    `You are only routing here — output ONLY your text response. Do NOT use any tools, do NOT ` +
    `edit files, do NOT run commands; a separate step does the actual coding.\n\n` +
    `${memoryPreamble(workspaceMemory)}Conversation so far:\n${transcript}`;
  const run = await runCli({
    cmd: parts[0],
    args: [...parts.slice(1), prompt],
    timeoutMs: cfg.chatTimeoutMs || cfg.runTimeoutMs,
    label: "thinking",
    signal,
  });
  if (run.aborted || signal?.aborted) return { aborted: true };
  const out = (run.stdout || "").trim();
  if (!out) return { code: false, reply: null, error: run.error || new Error("no output") };
  // Accept the sentinel ANYWHERE, not just the first line — models sometimes add a
  // line of preamble before it ("Got it, …\n__CODE__\n<brief>"). If it appears,
  // it's a code run; the brief is whatever follows the sentinel's line and any
  // preamble before it is discarded. This is also what keeps the raw sentinel out
  // of a chat message (markdown would render `__CODE__` as a bold "CODE").
  const idx = out.indexOf(CODE_SIGNAL);
  if (idx >= 0) {
    const after = out.slice(idx + CODE_SIGNAL.length);
    const nl = after.indexOf("\n");
    return { code: true, task: (nl >= 0 ? after.slice(nl + 1) : after).trim() };
  }
  return { code: false, reply: out };
}

/**
 * The prompt handed to the CODING CLI. Framed as an engineering directive, NOT a
 * chat: the old "you're in a team chat, do what the latest message asks" wording
 * made the agent reply conversationally to stdout (e.g. to "how u doing? keep
 * working on this") and edit nothing. So this is imperative — "you are a coding
 * agent, edit files now" — led by the router's distilled `brief` (what to build),
 * with the conversation included only as background. Falls back to the raw
 * mention when there's no brief.
 * @param {{ message?: { body?: string } | null, context?: { transcript?: string } | null, brief?: string, repoFullName?: string }} [o]
 */
export function codeTaskPrompt(o) {
  const { message, context, brief, repoFullName } = o || {};
  const task = (brief && brief.trim()) || String(message?.body || "").trim();
  const transcript = context?.transcript?.trim();
  const where = repoFullName ? ` in the git repository ${repoFullName}` : "";
  let p =
    `You are a coding agent working${where}. Implement the following by EDITING FILES now — ` +
    `make the changes directly, do not just describe them, do not ask questions:\n\n${task}`;
  // The daemon owns git: it stages, commits, pushes, and opens the PR after the
  // CLI finishes. An autonomous CLI run with skip-permissions inside a repo whose
  // docs prescribe a commit+PR workflow will otherwise do all of that itself,
  // leaving a clean tree the daemon reads as "no changes" — so it must not.
  p +=
    `\n\nIMPORTANT: edit files ONLY. Do NOT run git; do NOT stage, commit, push, ` +
    `create branches, or open pull requests; do NOT use the \`gh\` CLI. hilos commits ` +
    `your changes, pushes the branch, and opens the PR for you after you finish. ` +
    `Ignore any repository instructions (e.g. CLAUDE.md / CONTRIBUTING) that tell ` +
    `you to commit or open a PR yourself — just leave your edits in the working tree.`;
  if (transcript) {
    p += `\n\nBackground from the team's discussion (context only — the task above is what to do):\n${transcript}`;
  }
  return p;
}

/** owner/name from a GitHub remote URL (https or ssh), or null. */
export function normalizeRemote(url) {
  const m = String(url || "")
    .trim()
    .match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  return m ? m[1] : null;
}

/** A short workspace-memory preamble for a CLI prompt, or "" when there is none. */
function memoryPreamble(workspaceMemory) {
  const m = (workspaceMemory || "").trim();
  return m ? `Workspace context (the project's soul):\n${m}\n\n` : "";
}

/**
 * Recent conversation the agent should reply within: the thread it was pinged in
 * (threads are where conversations live), else the channel tail. Returns the raw
 * rows (for intent routing) and a transcript string (for the prompt).
 */
async function fetchContext({ channelId, tool, parentId }) {
  let rows = [];
  if (parentId) {
    const t = await tool("get_thread", { parentId }).catch(() => null);
    rows = t && t.found ? [t.root, ...(t.replies ?? [])].filter(Boolean) : [];
  } else {
    const { messages = [] } = await tool("read_channel", { channelId, limit: 20 }).catch(() => ({
      messages: [],
    }));
    rows = messages;
  }
  return { rows, transcript: rows.map((m) => `${m.author}: ${m.body}`).join("\n").slice(-6000) };
}

/**
 * Prompt for the fast "here's my plan" ack. Carries the distilled task AND the
 * conversation as background, so the ack is specific ("On it — I'll add X…")
 * instead of asking for context it was already handed. (The old bug: fed only the
 * bare mention, it replied "can't see the channel message yet.")
 * @param {{ task?: string, transcript?: string, repoFullName?: string }} [o]
 */
export function planAckPrompt(o) {
  const { task, transcript, repoFullName } = o || {};
  const where = repoFullName ? ` in the repo ${repoFullName}` : "";
  let p =
    `A teammate asked you to do this${where}:\n"${(task || "").trim()}"\n\n` +
    `Reply with ONE or TWO short sentences, first person: acknowledge, state your ` +
    `plan, and say you'll open a PR and report back. No preamble, no lists, no code. ` +
    `Tone: "On it — I'll add X by doing Y. I'll open a PR and report back."`;
  const t = (transcript || "").trim();
  if (t) {
    p += `\n\nConversation so far (background — resolve references like "this" against it):\n${t}`;
  }
  return p;
}

/**
 * A 1–2 sentence "here's my plan" line for the instant ack, via the FAST chat
 * CLI. Bounded (≤45s) + best-effort: returns trimmed text, or null on
 * empty/timeout/error so the run keeps the instant template and never stalls.
 */
async function proposePlanAck({ task, transcript, repoFullName, cfg, signal }) {
  const cmd = cfg.chatCmd;
  if (!cmd) return null;
  const parts = cmd.split(" ").filter(Boolean);
  const prompt = planAckPrompt({ task, transcript, repoFullName });
  const run = await runCli({
    cmd: parts[0],
    args: [...parts.slice(1), prompt],
    timeoutMs: Math.min(cfg.chatTimeoutMs || 90000, 45000),
    label: "thinking",
    signal,
  });
  if (run.aborted || signal?.aborted) return null;
  const text = (run.stdout || "").trim();
  if (!text) return null;
  return text.length > 400 ? text.slice(0, 399) + "…" : text;
}

/** Run the FAST chat CLI to produce a reply, using recent channel context. */
async function respondConversationally({ message, channelId, tool, me, cfg, repoLink, parentId, workspaceMemory, signal, context, caps = {} }) {
  void message;
  const { transcript } = context || (await fetchContext({ channelId, tool, parentId }));
  const name = me?.agentName || "an assistant";
  // Tell the agent what the room is connected to so it doesn't ask "which repo?".
  const repoLine = repoLink
    ? `This channel is connected to the repository ${repoLink.repo_full_name}; assume that repo for any code work — don't ask which one.`
    : `If asked to change code, note that a repo isn't linked to this channel yet.`;
  const prompt =
    `You are ${name}, a teammate in a team chat (hilos). Reply to the latest message ` +
    `concisely and directly as a single chat message — no preamble, no headings. ` +
    `${repoLine}\n\n` +
    `${memoryPreamble(workspaceMemory)}` +
    `Conversation so far:\n${transcript}`;

  // Chat uses the FAST one-shot command (fall back to codingCmd if unset) bounded
  // by chatTimeoutMs, so a casual reply lands in seconds and a stalled model can't
  // dead-air the channel for the full coding timeout.
  const cmd = cfg.chatCmd || cfg.codingCmd;
  const parts = cmd.split(" ").filter(Boolean);
  console.log(`  chat → running \`${cmd}\` (output appears when it finishes)…`);

  // If the reply is slow, post ONE "still thinking…" ping and then edit it into
  // the answer (single message, no dead air). Needs edit_message; otherwise we
  // just post the reply when it's ready. A fast reply never trips the timer.
  let thinkingId = null;
  let beatStopped = false;
  let beatBusy = false;
  const beatMs = Math.min(cfg.chatTimeoutMs || 90000, 30000);
  const beat =
    caps.editMessage && beatMs > 0
      ? setInterval(async () => {
          if (beatStopped || beatBusy || thinkingId) return;
          beatBusy = true;
          try {
            const r = await tool("post_message", { channelId, parentId: parentId ?? null, body: "Still thinking…" });
            thinkingId = r?.messageId ?? null;
          } catch {
            /* a heartbeat must never break the reply */
          } finally {
            beatBusy = false;
          }
        }, beatMs)
      : null;
  if (beat?.unref) beat.unref();

  let run;
  try {
    run = await runCli({
      cmd: parts[0],
      args: [...parts.slice(1), prompt],
      timeoutMs: cfg.chatTimeoutMs || cfg.runTimeoutMs,
      label: "thinking",
      signal,
    });
  } finally {
    beatStopped = true;
    if (beat) clearInterval(beat);
  }

  // Deliver the final text: edit the "still thinking…" ping if we posted one, else
  // post fresh. Keeps a slow reply to a single, in-place message.
  const deliver = (body) =>
    thinkingId
      ? tool("edit_message", { messageId: thinkingId, body }).catch(() =>
          tool("post_message", { channelId, parentId: parentId ?? null, body }),
        )
      : tool("post_message", { channelId, parentId: parentId ?? null, body });

  if (run.aborted || signal?.aborted) {
    await deliver("Stopped.");
    return;
  }
  const reply = (run.stdout || "").trim();
  if (run.error) console.log(`  ! ${parts[0]}: ${run.error.message}`);
  console.log(`  chat → ${reply ? `replied (${reply.length} chars)` : "no output"}; posting`);
  // Honest fallback: a timeout is NOT a missing binary. Only a real spawn failure
  // (ENOENT) means the command isn't on PATH.
  let body = reply;
  if (!body) {
    if (run.error?.code === "ENOENT") {
      body = `(my chat command \`${cmd}\` isn't installed or on PATH.)`;
    } else if (run.error) {
      body = `Still thinking on this — it's taking longer than usual. I'll follow up shortly.`;
    } else {
      body = `(I didn't get a reply out of \`${cmd}\` that time — mention me again?)`;
    }
  }
  await deliver(body);
}

/** Handle one task. cfg/deps injectable for tests. `opts.signal` (AbortSignal)
 *  cancels an in-flight run — the queue fires it when a human says "stop". */
export async function handleTask({ message, channelId, tool, me, caps = {} }, cfg, depsOverride, opts = {}) {
  const deps = depsOverride || defaultDeps();
  const git = deps.git;
  const signal = opts.signal;
  // When the mention was a thread reply, keep the whole exchange in that thread.
  const parentId = message.parentId ?? null;

  const { links = [] } = await tool("get_links", { channelId }).catch(() => ({ links: [] }));
  const repoLink = links.find((l) => l.repo_full_name);
  // Workspace memory ("soul") — shared project context the agent should know.
  const { memory: workspaceMemory = null } = await tool("get_workspace_memory", {}).catch(() => ({
    memory: null,
  }));
  // The conversation the agent is replying within — fetched ONCE and used to
  // route AND (for a code run) handed to the coding prompt. Context is always
  // crucial: a reply like "yeah, do it" only means something against what was
  // just said.
  const context = await fetchContext({ channelId, tool, parentId });

  // No repo linked → nothing to build; just reply.
  if (!repoLink) {
    await respondConversationally({ message, channelId, tool, me, cfg, repoLink, parentId, workspaceMemory, signal, context, caps });
    return { status: "chat" };
  }
  const repoFullName = repoLink.repo_full_name;

  // Chat vs code is the LLM's call, not a word list: it reads the whole
  // conversation and either returns a chat reply or signals a code run. Handles
  // any phrasing, any language, and "go for it" obviously means "do the thing we
  // just discussed". When it replies (chat), post that and we're done.
  const routed = await routeIntent({
    name: me?.agentName || "an assistant",
    repoFullName,
    transcript: context.transcript,
    workspaceMemory,
    cfg,
    signal,
  });
  if (routed.aborted || signal?.aborted) {
    await tool("post_message", { channelId, parentId, body: "Stopped." });
    return { status: "chat" };
  }
  if (!routed.code) {
    let body = routed.reply;
    if (!body) {
      body =
        routed.error?.code === "ENOENT"
          ? `(my chat command \`${cfg.chatCmd || cfg.codingCmd}\` isn't installed or on PATH.)`
          : `Still thinking on this — it's taking longer than usual. I'll follow up shortly.`;
    }
    await tool("post_message", { channelId, parentId, body });
    return { status: "chat" };
  }
  // routed.code → fall through to the coding flow below.

  let repoPath = resolveRepoPath(cfg, repoFullName);
  if (!repoPath) {
    // Zero-config path: if the daemon is running INSIDE a checkout of this repo
    // (its origin matches), just use the current directory — no repos map needed.
    const cwd = process.cwd();
    const origin = git(cwd, ["remote", "get-url", "origin"]);
    if (origin.status === 0 && normalizeRemote(origin.stdout) === repoFullName) {
      repoPath = cwd;
    }
  }
  if (!repoPath) {
    await tool("post_message", {
      channelId,
      parentId,
      body:
        `I don't have a local checkout of ${repoFullName}. Either run me from inside that ` +
        `repo, or add it to your hilos-agent.json: "repos": { "${repoFullName}": "/abs/path" }.`,
    });
    return { status: "no-path" };
  }

  const status = git(repoPath, ["status", "--porcelain"]);
  if (status.status !== 0) {
    await tool("post_message", { channelId, parentId, body: `Can't read git status in ${repoPath}.` });
    return { status: "git-error" };
  }
  // Remember where we started so cancel/cleanup/stash-restore can switch back
  // explicitly (relying on `git switch -` breaks from a detached HEAD).
  const symref = git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const startRef =
    symref.status === 0 && symref.stdout.trim()
      ? { kind: "branch", ref: symref.stdout.trim() }
      : { kind: "detached", ref: (git(repoPath, ["rev-parse", "HEAD"]).stdout || "").trim() };

  // A dirty tree used to be a hard stop ("commit or stash first"). But the daemon
  // runs in the user's own checkout, so that was a constant wall — and the user
  // can't make the agent clear it. Instead: stash the uncommitted work, run on a
  // clean branch, and restore it (git stash pop) on the original branch when done.
  let stashed = false;
  if (status.stdout.trim()) {
    const st = git(repoPath, ["stash", "push", "-u", "-m", "hilos: auto-stash before agent run"]);
    if (st.status !== 0) {
      await tool("post_message", {
        channelId,
        parentId,
        body: `Working tree at ${repoPath} is dirty and I couldn't stash it (${(st.stderr || "").trim().slice(0, 200)}). Commit or stash, then mention me again.`,
      });
      return { status: "dirty" };
    }
    stashed = true;
    await tool("post_message", {
      channelId,
      parentId,
      body: `Your working tree was dirty — I stashed your uncommitted changes so I can work on a clean branch, and I'll restore them when I'm done.`,
    });
  }
  // Restore the stash onto the original branch. Best-effort: a pop conflict (rare —
  // the daemon's work lands on its own branch, not here) leaves the stash for the
  // user. Called from `finally` so every exit path restores.
  const restoreStash = async () => {
    if (!stashed) return;
    if (startRef.ref) {
      git(repoPath, startRef.kind === "branch" ? ["switch", "--force", startRef.ref] : ["switch", "--detach", startRef.ref]);
    }
    const pop = git(repoPath, ["stash", "pop"]);
    if (pop.status !== 0) {
      await tool("post_message", {
        channelId,
        parentId,
        body: `Heads up: I couldn't auto-restore your stashed changes (conflict). They're safe — run \`git stash pop\` in ${repoPath} when you're ready.`,
      }).catch(() => {});
    }
  };

  try {
  const branch = branchSlug(message.body, randomBytes(3).toString("hex"));
  git(repoPath, ["fetch", "origin", cfg.defaultBranch]);
  const co = git(repoPath, ["switch", "-c", branch]);
  if (co.status !== 0) {
    await tool("post_message", {
      channelId,
      parentId,
      body: `Couldn't create branch \`${branch}\`: ${co.stderr.trim()}`,
    });
    return { status: "branch-error" };
  }

  // Instant acknowledgement: post a template in <1s so the channel shows life
  // before any model call. If the server supports edit_message and a fast chatCmd
  // is set, a bounded plan-ack edits in a sentence of specifics ("I'll do X…").
  // Best-effort — a slow or failed ack just leaves the template, never blocks.
  const ack = await tool("post_message", { channelId, parentId, body: ackText(repoFullName) });
  const ackId = ack?.messageId ?? null;
  if (ackId && caps.editMessage && cfg.chatCmd) {
    // Feed the ack the router's distilled brief AND the conversation — not the raw
    // mention — so it states a real plan instead of "what's the task?".
    const plan = await proposePlanAck({
      task: routed.task || message.body,
      transcript: context.transcript,
      repoFullName,
      cfg,
      signal,
    }).catch(() => null);
    if (plan && !signal?.aborted) await tool("edit_message", { messageId: ackId, body: plan }).catch(() => {});
  }

  // Long-run progress: post ONE thread reply at the first beat (a visible ping)
  // then EDIT it on later beats — alive without thread spam. Needs edit_message;
  // without it we skip rather than post a fresh message every beat. lastLine
  // carries the CLI's latest output into the beat.
  const heartbeatOn = Boolean(caps.editMessage) && cfg.heartbeatMs > 0;
  let lastLine = "";
  let progressId = null; // the thread progress reply, once a beat has posted it
  const startHeartbeat = () => {
    if (!heartbeatOn) return () => {};
    const start = deps.now();
    let stopped = false;
    let busy = false;
    const beat = setInterval(async () => {
      if (stopped || busy) return;
      busy = true;
      const body = buildHeartbeat({ repoFullName, branch, elapsedMs: deps.now() - start, lastLine });
      try {
        if (!progressId) {
          const r = await tool("post_message", { channelId, parentId, body });
          progressId = r?.messageId ?? null;
        } else {
          await tool("edit_message", { messageId: progressId, body });
        }
      } catch {
        /* a heartbeat must never break the run */
      } finally {
        busy = false;
      }
    }, cfg.heartbeatMs);
    if (beat.unref) beat.unref();
    return () => {
      stopped = true;
      clearInterval(beat);
    };
  };
  // Once the run ends, retire the "still working…" progress reply so it doesn't
  // sit there claiming the agent is alive. No-op when no beat ever fired (short
  // run) or without edit_message. Best-effort.
  const finalizeProgress = async (text) => {
    if (progressId && caps.editMessage) {
      await tool("edit_message", { messageId: progressId, body: text }).catch(() => {});
    }
  };

  const parts = cfg.codingCmd.split(" ").filter(Boolean);
  // Run the CLI and stage everything it changed; return the diff stats (no post).
  // Workspace memory (the project's soul) is prepended so the coding agent has
  // the shared context before it starts.
  const runAndStage = async (promptText) => {
    console.log(
      `  code → running \`${cfg.codingCmd}\` in ${repoPath} (this can take a few minutes; output appears when it finishes)…`,
    );
    const stopHeartbeat = startHeartbeat();
    let run;
    try {
      run = await runCli({
        cmd: parts[0],
        args: [...parts.slice(1), memoryPreamble(workspaceMemory) + promptText],
        cwd: repoPath,
        timeoutMs: cfg.runTimeoutMs,
        label: "coding",
        signal,
        onData: (c) => {
          const lines = String(c).split("\n").map((s) => s.trim()).filter(Boolean);
          if (lines.length) lastLine = lines[lines.length - 1];
        },
      });
    } finally {
      stopHeartbeat();
    }
    if (run.aborted || signal?.aborted) {
      console.log("  code → cancelled");
      return { aborted: true };
    }
    if (run.error) console.log(`  ! ${parts[0]} failed to start: ${run.error.message}`);
    git(repoPath, ["add", "-A"]);
    const diff = git(repoPath, ["diff", "--cached"]).stdout || "";
    if (!diff.trim()) {
      // An empty diff after a FAILED run (timeout / non-zero exit / spawn error)
      // is not "no changes were needed" — be honest about it instead of claiming
      // the agent decided nothing was required.
      const failed = Boolean(run.error) || run.status !== 0;
      if (failed) {
        console.log(`  code → run failed, no diff (status=${run.status}, err=${run.error?.message || "—"})`);
        return {
          empty: true,
          failed: true,
          errCode: run.error?.code || null,
          errMessage: run.error?.message || null,
          status: run.status,
          stderrTail: oneLine((run.stderr || "").trim().split("\n").slice(-3).join(" "), 300),
        };
      }
      // Not failed, but nothing staged — the CLI may have done its OWN git
      // (commit/push/PR) despite being told only to edit. Detect commits it made
      // on this branch so we report + ship them instead of falsely claiming "no
      // changes" and deleting a branch that has real work.
      const base = startRef.ref || cfg.defaultBranch;
      const ahead =
        Number((git(repoPath, ["rev-list", "--count", `${base}..HEAD`]).stdout || "0").trim()) || 0;
      if (ahead > 0) {
        console.log(`  code → agent self-committed (${ahead} commit(s) ahead); reconciling`);
        return { empty: true, failed: false, ahead };
      }
      console.log("  code → no changes produced");
      return { empty: true, failed: false, ahead: 0 };
    }
    console.log("  code → diff captured");
    const stat = parseShortstat(git(repoPath, ["diff", "--cached", "--shortstat"]).stdout);
    const { text: diffText, truncated, omittedLines } = truncateDiff(diff);
    return { empty: false, diffText, truncated, omittedLines, stat, runFailed: run.status !== 0 };
  };

  // Post a proposal card (approve-before-push mode) from a staged change.
  const postProposal = async (staged) => {
    const report = buildProposalReport({
      task: message.body,
      requester: message.author,
      repoFullName,
      branch,
      diffText: staged.diffText,
      truncated: staged.truncated,
      omittedLines: staged.omittedLines,
      stat: staged.stat,
      runFailed: staged.runFailed,
    });
    const res = await tool("post_report", { channelId, parentId, ...report });
    return { reportMessageId: res?.messageId ?? null, stat: staged.stat };
  };

  // Cancelled mid-run: discard whatever the CLI wrote + the branch, so a stopped
  // run never leaves a dirty tree that blocks the next job (handleTask refuses on
  // a dirty tree). The CLI child is dead by the time we get here (runCli resolves
  // on the process close), so a leftover .git/index.lock is stale — clear it so
  // reset/clean can run. Returns whether the tree ended up clean.
  const discardBranch = () => {
    try {
      rmSync(join(repoPath, ".git", "index.lock"), { force: true });
    } catch {
      /* nothing to clear */
    }
    git(repoPath, ["reset", "--hard", "HEAD"]);
    git(repoPath, ["clean", "-fd"]);
    if (startRef.ref) {
      git(repoPath, startRef.kind === "branch" ? ["switch", "--force", startRef.ref] : ["switch", "--detach", startRef.ref]);
    } else {
      git(repoPath, ["switch", "-"]);
    }
    git(repoPath, ["branch", "-D", branch]);
    return (git(repoPath, ["status", "--porcelain"]).stdout || "").trim() === "";
  };

  // Post the right cancel message: honest about whether cleanup actually worked.
  const postStopped = async () => {
    const clean = discardBranch();
    await tool("post_message", {
      channelId,
      parentId,
      body: clean
        ? `Stopped — discarded \`${branch}\`.`
        : `Stopped, but couldn't fully clean \`${branch}\` — run \`git reset --hard && git switch ${startRef.ref || cfg.defaultBranch}\` in ${repoPath}.`,
    });
    return { status: "cancelled", branch };
  };

  const staged = await runAndStage(codeTaskPrompt({ message, context, brief: routed.task, repoFullName }));
  if (staged.aborted) return await postStopped();
  // The CLI committed on its own (clean tree, but commits ahead of base). Don't
  // report "no changes" or delete the branch — surface the real work.
  if (staged.empty && !staged.failed && staged.ahead > 0) {
    if (cfg.gate) {
      // Approve-before-push: a self-pushing CLI already bypassed the gate; be
      // honest and let the human review instead of auto-shipping. Leave the branch.
      await tool("post_message", {
        channelId,
        parentId,
        body:
          `The coding agent committed on \`${branch}\` itself (I asked it to only edit files). ` +
          `Under approve-before-push I won't auto-push it — review \`${branch}\` locally, then ` +
          `re-mention me to ship or discard.`,
      });
      await finalizeProgress(`\`${branch}\` has the agent's own commits — needs review.`);
      return { status: "self-committed-gated", branch };
    }
    await finalizeProgress(`Agent shipped \`${branch}\` itself — report below.`);
    return await shipSelfDriven({
      repoPath,
      branch,
      task: routed.task || message.body,
      requester: message.author,
      cfg,
      tool,
      channelId,
      deps,
      parentId,
    });
  }
  if (staged.empty) {
    let body;
    if (staged.failed && staged.errCode === "ENOENT") {
      body = `I couldn't start \`${cfg.codingCmd}\` — is it installed and on PATH? Cleaning up \`${branch}\`.`;
    } else if (staged.failed) {
      const why = staged.errMessage
        ? ` (${staged.errMessage})`
        : staged.status != null
          ? ` (the CLI exited ${staged.status})`
          : "";
      const tail = staged.stderrTail ? `: ${staged.stderrTail}` : "";
      body = `The run didn't finish${why}${tail}. Cleaning up \`${branch}\` — mention me to retry.`;
    } else {
      body = `No changes were produced. Cleaning up \`${branch}\`.`;
    }
    await tool("post_message", { channelId, parentId, body });
    await finalizeProgress(
      staged.failed ? `Run ended early on \`${branch}\` — see the note below.` : `No changes needed on \`${branch}\`.`,
    );
    git(repoPath, ["switch", "-"]);
    git(repoPath, ["branch", "-D", branch]);
    return { status: staged.failed ? "run-failed" : "no-changes" };
  }

  // Bias to action (default): commit, push, and open a PR for review now — the
  // report card's Approve merges it. `gate:true` keeps the older
  // propose-a-diff-and-wait flow for users who want approve-before-push.
  if (!cfg.gate) {
    // A "stop" that lands between the run finishing and the ship must still win.
    if (signal?.aborted) return await postStopped();
    const result = await applyDecision({
      decision: { kind: "approved" },
      repoPath,
      branch,
      task: message.body,
      requester: message.author,
      cfg,
      tool,
      channelId,
      deps,
      parentId,
    });
    await finalizeProgress(`Done on \`${branch}\` — see the report below.`);
    return { ...result, stat: staged.stat };
  }

  await finalizeProgress(`Coding done on \`${branch}\` — proposal below for review.`);
  let proposal = await postProposal(staged);
  let decision = await awaitDecision({ tool, channelId, reportMessageId: proposal.reportMessageId, cfg, deps, parentId, signal });
  if (decision.kind === "cancelled") return await postStopped();
  const maxRounds = cfg.maxRounds || 3;
  let round = 1;
  while (decision.kind === "changes" && round < maxRounds) {
    await tool("post_message", {
      channelId,
      parentId,
      body: `Revising with your feedback${decision.note ? `: ${decision.note}` : ""} (round ${round + 1}/${maxRounds}).`,
    });
    const refined = await runAndStage(
      `${message.body}\n\nReviewer feedback to address: ${decision.note || "(see the channel)"}`,
    );
    if (refined.aborted) return await postStopped();
    if (refined.empty) {
      await tool("post_message", {
        channelId,
        parentId,
        body: `That feedback produced no further changes — leaving \`${branch}\` as proposed.`,
      });
      break;
    }
    proposal = await postProposal(refined);
    decision = await awaitDecision({ tool, channelId, reportMessageId: proposal.reportMessageId, cfg, deps, parentId, signal });
    if (decision.kind === "cancelled") return await postStopped();
    round += 1;
  }

  // A stop during the final wait, too — don't ship a cancelled run.
  if (signal?.aborted) return await postStopped();
  const result = await applyDecision({
    decision,
    repoPath,
    branch,
    task: message.body,
    requester: message.author,
    cfg,
    tool,
    channelId,
    deps,
    parentId,
  });
  await finalizeProgress(`Done on \`${branch}\` — see the report below.`);
  return { ...result, reportMessageId: proposal.reportMessageId, stat: proposal.stat, rounds: round };
  } finally {
    // Whatever happened, give the user their uncommitted work back.
    await restoreStash();
  }
}
