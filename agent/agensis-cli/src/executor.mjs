// agent/agensis-cli/src/executor.mjs
// The single seam where an agent's coding CLI runs. LocalExecutor keeps today's
// behavior (spawn on the host). SandboxExecutor runs it in a remote sandbox via
// an injected provider. createExecutor picks one by run_mode.
import { runCli } from "./cli.mjs";

export function createLocalExecutor({ run = runCli } = {}) {
  return { run: (opts) => run(opts) };
}

// Orchestrates one sandbox run through a provider: ensureEnv -> putRepo -> exec
// -> getResult -> destroy. Streams onData through exec, folds the resulting patch
// into stdout as a fenced diff, ALWAYS destroys (even on throw), and returns the
// runCli-shaped { status, stdout, stderr, error }.
export function createSandboxExecutor(provider) {
  return {
    async run({ cmd, args = [], onData, signal, job }) {
      let handle = null;
      try {
        handle = await provider.ensureEnv({ job, signal });
        await provider.putRepo(handle, { job, signal });
        const exec = await provider.exec(handle, { cmd, args, onData, signal });
        const result = await provider.getResult(handle, { job }).catch(() => ({}));
        const patch = result && result.patch ? String(result.patch).trim() : "";
        const stdout = patch
          ? `${exec.stdout || ""}\n\n\`\`\`diff\n${patch}\n\`\`\``
          : exec.stdout || "";
        return { status: exec.status, stdout, stderr: exec.stderr || "", error: exec.error || null };
      } catch (error) {
        return { status: null, stdout: "", stderr: "", error };
      } finally {
        if (handle) { try { await provider.destroy(handle); } catch { /* teardown must never throw */ } }
      }
    },
  };
}

export function createExecutor(job, { makeProvider } = {}) {
  const runMode = job && job.agent && job.agent.run_mode;
  if (runMode === "sandbox") {
    const factory = makeProvider || defaultSandboxProviderFactory;
    return createSandboxExecutor(factory(job));
  }
  return createLocalExecutor();
}

// Default factory: builds a provider from job.agent.sandbox_provider + env secrets.
// Kept out of the hot path so tests inject their own via makeProvider.
function defaultSandboxProviderFactory(job) {
  const providerName = (job.agent && job.agent.sandbox_provider) || "e2b";
  const config = (job.agent && job.agent.sandbox_config) || {};
  if (providerName !== "e2b") {
    throw new Error(`Sandbox provider "${providerName}" is not available yet (only e2b is wired).`);
  }
  return createE2bProviderLazy({
    apiKey: process.env.E2B_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    gitToken: process.env.GIT_TOKEN || "",
    repoUrl: job.repoUrl || (job.agent && job.agent.repo_url) || config.repoUrl || "",
    template: config.template || "",
  });
}

// Defer the e2b import so `import('./executor.mjs')` in unit tests never pulls the
// e2b SDK — it loads only when a sandbox job actually runs.
function createE2bProviderLazy(opts) {
  let real = null;
  const ensureReal = async () => {
    if (!real) {
      const mod = await import("./sandbox/e2b.mjs");
      real = mod.createE2bProvider(opts);
    }
    return real;
  };
  return {
    ensureEnv: async (a) => (await ensureReal()).ensureEnv(a),
    putRepo: async (h, a) => (await ensureReal()).putRepo(h, a),
    exec: async (h, a) => (await ensureReal()).exec(h, a),
    getResult: async (h, a) => (await ensureReal()).getResult(h, a),
    destroy: async (h) => (await ensureReal()).destroy(h),
  };
}
