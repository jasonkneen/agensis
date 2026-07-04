// Async CLI runner with a heartbeat. The coding CLI (`claude -p`, `codex`, …)
// runs for minutes and — with the default output format — buffers everything
// until it exits. The old blocking `spawnSync` froze the event loop, so the
// terminal sat dead-silent the whole time and people assumed it had hung and
// hit Ctrl+C (losing the run). This spawns asynchronously, captures output, and
// logs a periodic "still working…" heartbeat so the run visibly stays alive.

import { spawn } from "node:child_process";

/** Human-readable elapsed time: "45s", "2m 3s". */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Collapse to one trimmed, length-capped line (for a heartbeat's "Latest:" tail). */
export function oneLine(s, max = 140) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Low-noise "still working…" status body for a long run (pure; used by the
 * daemon's chat-facing heartbeat). Appends the CLI's latest output line when one
 * is available, else stays generic.
 * @param {{ branch: string, elapsedMs: number, repoFullName?: string, lastLine?: string }} o
 */
export function buildHeartbeat(o) {
  const { repoFullName, branch, elapsedMs, lastLine } = o;
  const where = repoFullName ? ` in ${repoFullName}` : "";
  const base = `Still working on \`${branch}\`${where} — ${fmtElapsed(elapsedMs)} elapsed. I'll post a report when it's done.`;
  const tail = oneLine(lastLine);
  return tail ? `${base}\n\nLatest: ${tail}` : base;
}

/**
 * The instant, template acknowledgement posted the moment a code task starts —
 * so the channel shows life in <1s, before any model call. A bounded plan-ack
 * may later edit this message in place with a sentence of specifics.
 */
export function ackText(repoFullName) {
  const where = repoFullName ? ` in ${repoFullName}` : "";
  return `On it — taking a look${where} now. I'll open a PR and report back.`;
}

// Guard against a pathological run flooding memory; the CLI's result is small.
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;

/**
 * @typedef {Object} RunCliOptions
 * @property {string} cmd - command to run
 * @property {string[]} [args] - arguments
 * @property {string} [cwd] - working directory
 * @property {number} [timeoutMs] - kill the child after this long (0 = no timeout)
 * @property {string} [label] - verb shown in the heartbeat ("coding"/"thinking")
 * @property {number} [heartbeatMs] - heartbeat interval (0 = no heartbeat)
 * @property {string} [input] - optional stdin written to the child process
 * @property {() => number} [now] - clock, injectable for tests
 * @property {{ log: (m: string) => void }} [log] - logger, injectable for tests
 * @property {AbortSignal} [signal] - abort to cancel the run (kills the child's
 *   whole process group: SIGTERM, then SIGKILL after a short grace)
 * @property {(chunk: string) => void} [onData] - called with each stdout chunk as
 *   it arrives (lets a caller track the latest output line for a heartbeat)
 */

/**
 * Run `cmd args` to completion without blocking the event loop.
 *
 * Returns a spawnSync-shaped result so callers can swap it in directly:
 *   { status: number|null, stdout: string, stderr: string, error: Error|null }
 * `status` is the exit code, or null if the process failed to start or was
 * killed (timeout). On timeout the child is SIGKILLed and `error` is set.
 *
 * @param {RunCliOptions} opts
 */
export function runCli(opts) {
  const {
    cmd,
    args = [],
    cwd,
    timeoutMs = 0,
    label = "working",
    heartbeatMs = 15000,
    input = "",
    now = Date.now,
    log = console,
    signal,
    onData,
  } = opts || {};
  return new Promise((resolve) => {
    // Already cancelled before we even start.
    if (signal?.aborted) {
      resolve({ status: null, stdout: "", stderr: "", aborted: true, error: new Error("cancelled") });
      return;
    }
    let child;
    try {
      // detached:true makes the child its own process-group leader, so we can
      // kill the WHOLE tree (claude → node → git …) with process.kill(-pid) on
      // cancel/timeout instead of orphaning its subprocesses.
      child = spawn(cmd, args, { cwd, detached: true });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error });
      return;
    }

    if (input) {
      child.stdin?.end(String(input));
    } else {
      child.stdin?.end();
    }

    let stdout = "";
    let stderr = "";
    // Decode at the stream level so a multibyte char split across chunks isn't
    // corrupted (the chat path posts stdout verbatim). Matches spawnSync's utf8.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const append = (buf, chunk) =>
      buf.length >= MAX_CAPTURE_BYTES ? buf : buf + chunk;
    child.stdout?.on("data", (c) => {
      stdout = append(stdout, c);
      if (onData) {
        try {
          onData(c);
        } catch {
          /* a heartbeat tracker must never break the run */
        }
      }
    });
    child.stderr?.on("data", (c) => (stderr = append(stderr, c)));

    const start = now();
    const beat =
      heartbeatMs > 0
        ? setInterval(() => {
            log.log(`  … still ${label} (${fmtElapsed(now() - start)}) — Ctrl+C to cancel`);
          }, heartbeatMs)
        : null;
    if (beat?.unref) beat.unref();

    // Kill the child's whole process group; fall back to a bare kill if the
    // group signal isn't permitted (e.g. Windows / unusual setups).
    const killGroup = (sig) => {
      if (child.pid == null) return; // never spawned a pid → nothing to kill
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup("SIGKILL");
          }, timeoutMs)
        : null;
    if (timer?.unref) timer.unref();

    // Cancel via AbortSignal: SIGTERM the group, then SIGKILL after a grace so a
    // well-behaved CLI can clean up but a stuck one still dies.
    let aborted = false;
    let graceTimer = null;
    const onAbort = () => {
      aborted = true;
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => killGroup("SIGKILL"), 3000);
      if (graceTimer?.unref) graceTimer.unref();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const finish = (status, error) => {
      if (beat) clearInterval(beat);
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        status,
        stdout,
        stderr,
        aborted,
        error:
          error ||
          (aborted
            ? new Error("cancelled")
            : timedOut
              ? new Error(`timed out after ${fmtElapsed(timeoutMs)}`)
              : null),
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}
