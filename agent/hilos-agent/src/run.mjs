// The poll loop: connect over MCP, watch for @mentions of this agent, and hand
// each one to the task handler. Prefers the workspace-wide list_mentions tool
// (one poll, cursor-based); falls back to per-channel scanning on older servers.

import { makeClient } from "./mcp.mjs";
import { mentionHandle } from "./daemon.mjs";
import { handleTask } from "./handler.mjs";
import { createQueue, looksLikeCancel, dedupeKey } from "./queue.mjs";
import { reloadConfig } from "./config.mjs";

export async function run(cfg, { handler = handleTask, log = console } = {}) {
  if (!cfg.token) {
    log.error("No token. Run `hilos-agent init`, set HILOS_TOKEN, or use --join <blob>.");
    process.exit(1);
  }

  const { tool, listToolNames } = makeClient({ url: cfg.url, token: cfg.token });

  const who = await tool("whoami");
  const me = { ...who, handle: mentionHandle(who.agentName) };
  if (!me.handle) {
    log.error("This agent has no display name / handle — set one in hilos, then reconnect.");
    process.exit(1);
  }
  log.log(`hilos-agent: ${me.agentName} (@${me.handle}) — ${cfg.url}`);
  if (cfg.channelId) log.log(`scope: channel ${cfg.channelId}`);
  log.log(`repos: ${Object.keys(cfg.repos).join(", ") || "(none configured)"}`);

  const since = cfg.backfill ? 0 : Date.now();
  const toolNames = await listToolNames();
  const useMentions = !cfg.channelId && toolNames.includes("list_mentions");
  // Capabilities of THIS server, so the handler degrades gracefully on older
  // deploys (e.g. no edit_message → no live heartbeat, rather than erroring).
  const caps = { editMessage: toolNames.includes("edit_message") };

  let channelIds = [];
  if (!useMentions) {
    if (cfg.channelId) channelIds = [cfg.channelId];
    else channelIds = ((await tool("list_channels"))?.channels ?? []).map((c) => c.id);
  }
  log.log(useMentions ? "watching: @-mentions" : `watching: ${channelIds.length} channel(s)`);

  const seen = new Set();
  const cursor = { value: since ? new Date(since).toISOString() : null };

  // Live config: re-read between polls so model/permission/codingCmd edits to
  // hilos-agent.json take effect without a restart. Identity stays pinned.
  let liveCfg = cfg;

  // One-at-a-time worker so the poll loop NEVER blocks on a multi-minute run.
  // The loop only fetches + enqueues; the queue runs jobs in order. This is what
  // lets a "stop" (and new mentions) be picked up while a task is still running.
  const queue = createQueue({
    concurrency: cfg.queueConcurrency || 1,
    runJob: (job, { signal }) => safeHandle(job.message, job.channelId, signal),
  });

  async function safeHandle(message, channelId, signal) {
    try {
      log.log(`→ task in ${channelId}: "${(message.body || "").slice(0, 80)}"`);
      // liveCfg so a job uses the latest model/permission/codingCmd at run time.
      await handler({ message, channelId, tool, me, caps }, liveCfg, undefined, { signal });
    } catch (e) {
      log.error(`handler error: ${e.message}`);
      await tool("post_message", {
        channelId,
        body: `Hit an error working on that: ${e.message}`,
      }).catch(() => {});
    }
  }

  // Route one fresh mention: a "stop" cancels the active run; anything else is
  // enqueued (deduped against an identical in-flight/queued ask), with an ack
  // when it lands behind work already in progress.
  async function intake(m, channelId) {
    if (looksLikeCancel(m.body) && (queue.active() || queue.size())) {
      queue.cancelActive("user asked to stop");
      await tool("post_message", {
        channelId,
        parentId: m.parentId ?? null,
        body: "Stopping the current task.",
      }).catch(() => {});
      return;
    }
    const r = queue.enqueue({ message: m, channelId, key: dedupeKey(m, channelId) });
    if (r.deduped) {
      log.log("  (deduped a repeat of an in-flight/queued ask)");
      return;
    }
    if (liveCfg.queueAcks && !r.startedImmediately) {
      await tool("post_message", {
        channelId,
        parentId: m.parentId ?? null,
        body: "Got it — queued behind the current task.",
      }).catch(() => {});
    }
  }

  async function passViaMentions() {
    const out = await tool("list_mentions", cursor.value ? { since: cursor.value } : {});
    const mentions = (out?.mentions ?? []).slice().reverse();
    for (const m of mentions) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      await intake(m, m.channelId);
      // Compare numerically — created_at formats differ (Z vs +00:00 offset),
      // so a lexicographic string compare can fail to advance the cursor.
      if (!cursor.value || new Date(m.created_at).getTime() > new Date(cursor.value).getTime()) {
        cursor.value = m.created_at;
      }
    }
  }

  async function passViaScan() {
    for (const channelId of channelIds) {
      const out = await tool("read_channel", { channelId, limit: 30 });
      for (const m of out?.messages ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.author === me.agentName) continue;
        const isMention = new RegExp(`@${me.handle}\\b`, "i").test(m.body || "");
        if (isMention && new Date(m.created_at).getTime() >= since) await intake(m, channelId);
      }
    }
  }

  do {
    // Pick up live edits to hilos-agent.json (model/permission/codingCmd/etc.)
    // before each pass. Guarded: a bad file leaves liveCfg untouched.
    try {
      const next = reloadConfig(liveCfg);
      if (next.codingCmd !== liveCfg.codingCmd) log.log(`daemon: coding command → ${next.codingCmd}`);
      liveCfg = next;
    } catch (e) {
      log.error(`config reload error (keeping previous): ${e.message}`);
    }
    try {
      if (useMentions) await passViaMentions();
      else await passViaScan();
    } catch (e) {
      log.error(`poll error: ${e.message}`);
    }
    // --once is for cron-style single passes: drain the queued work before exit.
    if (cfg.once) {
      await queue.idle();
      break;
    }
    await new Promise((r) => setTimeout(r, liveCfg.pollMs));
  } while (true);
}
