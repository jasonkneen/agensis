import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import { daemonProfileName, writeDaemonProfile } from "./connectProfiles.mjs";

const DEFAULT_SETUP_URL = "https://agensis.io";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 128 * 1024) {
        reject(new Error("setup callback body is too large"));
        req.destroy();
      }
    });
    req.on("error", reject);
    req.on("end", () => resolve(body));
  });
}

function normalizeSetupUrl(value) {
  const text = String(value || process.env.AGENSIS_URL || DEFAULT_SETUP_URL).trim();
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agensis setup URL must be http or https.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function validateDaemonArgs(payload) {
  const daemonArgs = payload?.daemonArgs || payload?.data?.daemonArgs || payload?.data || {};
  const required = ["url", "token", "workspace", "agent"];
  const missing = required.filter((key) => !String(daemonArgs[key] || "").trim());
  if (missing.length) throw new Error(`Setup callback did not include ${missing.join(", ")}`);
  return {
    ...daemonArgs,
    command: "connect",
  };
}

function setupQuery(args, callbackUrl, state) {
  const url = new URL(normalizeSetupUrl(args.url || args.baseUrl));
  url.searchParams.set("source", "agensis-cli");
  url.searchParams.set("referrer", "agensis-cli");
  url.searchParams.set("intent", "setup");
  url.searchParams.set("callback", callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("profile", daemonProfileName(args.profile || "default"));
  url.searchParams.set("host", os.hostname());
  url.searchParams.set("cwd", String(args.cwd || process.cwd()));
  if (args.handle) url.searchParams.set("handle", String(args.handle));
  if (args.name) url.searchParams.set("name", String(args.name));
  return url.toString();
}

export async function runSetupFlow(args = {}) {
  const profile = daemonProfileName(args.profile || "default");
  const state = crypto.randomBytes(24).toString("base64url");
  const timeoutMs = Number(args.setupTimeoutMs || process.env.AGENSIS_SETUP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  let server;
  const callbackPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Agensis setup timed out waiting for browser login.")), timeoutMs);
    if (timeout.unref) timeout.unref();

    server = http.createServer(async (req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST" || req.url !== "/agensis/setup-callback") {
        json(res, 404, { ok: false, error: "Unknown Agensis setup callback route" });
        return;
      }

      try {
        const payload = JSON.parse((await readBody(req)) || "{}");
        if (payload?.state !== state) {
          json(res, 403, { ok: false, error: "Setup state did not match" });
          return;
        }
        const daemonArgs = {
          ...validateDaemonArgs(payload),
          primaryDaemon: true,
          cursorBuddyBridge: args.cursorBuddyBridge !== false,
        };
        await writeDaemonProfile(profile, daemonArgs);
        clearTimeout(timeout);
        json(res, 200, { ok: true, profile });
        resolve(daemonArgs);
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message || error) });
      }
    });

    server.once("error", reject);
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });
  const { port } = server.address();
  const callbackUrl = `http://127.0.0.1:${port}/agensis/setup-callback`;
  const url = setupQuery(args, callbackUrl, state);

  process.stdout.write("[agensis] Opening Agensis to sign in and connect this machine.\n");
  process.stdout.write(`[agensis] If the browser did not open, visit:\n${url}\n`);
  openBrowser(url);

  try {
    const daemonArgs = await callbackPromise;
    process.stdout.write(`[agensis] Saved daemon profile "${profile}". Starting primary agent daemon.\n`);
    return daemonArgs;
  } finally {
    await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
  }
}
