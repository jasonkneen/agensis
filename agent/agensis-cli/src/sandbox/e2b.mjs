// agent/agensis-cli/src/sandbox/e2b.mjs
// e2b provider: run the coding CLI inside a Firecracker microVM. Ephemeral —
// created per job, killed on teardown. Clones the repo via git, returns the
// resulting `git diff` as the artifact. Method names match the e2b Node SDK
// (v2.x): Sandbox.create(opts) / Sandbox.create(template, opts), sandbox.commands
// .run(cmd, { cwd, envs, onStdout }) -> { exitCode, stdout, stderr }, sandbox.kill().
import { Sandbox } from "e2b";

const REPO_DIR = "/home/user/repo";

function shellQuote(a) {
  return `'${String(a).replace(/'/g, `'\\''`)}'`;
}

export function createE2bProvider({ apiKey, anthropicApiKey, gitToken = "", repoUrl = "", template = "" } = {}) {
  if (!apiKey) throw new Error("E2B_API_KEY is not set on the daemon host.");
  if (!repoUrl) throw new Error("Sandbox needs a repo URL (set sandbox_config.repoUrl or the agent's repo).");
  return {
    async ensureEnv() {
      const opts = {
        apiKey,
        envs: anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {},
      };
      const sbx = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
      // Ensure the claude CLI exists (MVP: install-on-boot, no baked template).
      await sbx.commands.run("bash -lc 'command -v claude >/dev/null || npm i -g @anthropic-ai/claude-code'");
      return { sbx, dir: REPO_DIR };
    },
    async putRepo(handle) {
      const authed = gitToken
        ? repoUrl.replace(/^https:\/\//, `https://x-access-token:${gitToken}@`)
        : repoUrl;
      // commands.run throws CommandExitError on non-zero exit; the error carries
      // exitCode/stdout/stderr (it implements CommandResult), so surface stderr.
      try {
        const res = await handle.sbx.commands.run(`git clone ${shellQuote(authed)} ${shellQuote(handle.dir)}`);
        // Defensive: if a future SDK returns instead of throwing on non-zero.
        if (res && typeof res.exitCode === "number" && res.exitCode !== 0) {
          throw new Error(`git clone failed: ${res.stderr || `exit ${res.exitCode}`}`);
        }
      } catch (err) {
        if (err && String(err.message || "").startsWith("git clone failed:")) throw err;
        const detail = err && (err.stderr || err.exitCode != null) ? (err.stderr || `exit ${err.exitCode}`) : String(err?.message || err);
        throw new Error(`git clone failed: ${detail}`);
      }
    },
    async exec(handle, { cmd, args = [], onData }) {
      const full = `${cmd} ${args.map(shellQuote).join(" ")}`;
      const opts = {
        cwd: handle.dir,
        onStdout: (d) => { try { onData?.(d); } catch { /* stream tracker must not break the run */ } },
      };
      // A coding CLI exiting non-zero is a normal outcome (tests failed, lint
      // errors) — e2b throws CommandExitError for it, but the error IS the
      // CommandResult (exitCode/stdout/stderr), so preserve those like runCli
      // instead of collapsing to status:null.
      try {
        const res = await handle.sbx.commands.run(full, opts);
        return { status: res.exitCode, stdout: res.stdout || "", stderr: res.stderr || "", error: null };
      } catch (err) {
        if (err && typeof err.exitCode === "number") {
          return { status: err.exitCode, stdout: err.stdout || "", stderr: err.stderr || "", error: null };
        }
        return { status: null, stdout: "", stderr: String(err?.message || err), error: err };
      }
    },
    async getResult(handle) {
      try {
        const res = await handle.sbx.commands.run("git add -A && git diff --cached", { cwd: handle.dir });
        return { patch: res.stdout || "" };
      } catch (err) {
        // A diff command that exits non-zero still carries stdout on the error.
        return { patch: (err && err.stdout) || "" };
      }
    },
    async destroy(handle) {
      await handle.sbx.kill();
    },
  };
}
