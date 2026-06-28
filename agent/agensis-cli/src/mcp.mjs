// Minimal MCP-over-HTTP client (JSON-RPC 2.0). Dependency-free: uses global
// fetch (Node >= 18). One bearer token, one endpoint.
import os from "node:os";

// Best-effort host label so agensis can show "whose machine" this daemon runs on.
const CLIENT = (() => {
  try {
    return `${os.userInfo().username}@${os.hostname()}`;
  } catch {
    return os.hostname?.() || "";
  }
})();

export function makeClient({ url, token }) {
  let id = 0;

  async function rpc(method, params) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(CLIENT ? { "x-agensis-client": CLIENT } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "token rejected — generate a fresh one in agensis (Connect)"
          : await res.text().catch(() => "");
      throw new Error(`agensis ${res.status}: ${hint.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result;
  }

  // Call a tool and parse its first text block (agensis tools return JSON text).
  async function tool(name, args = {}) {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r?.content?.[0]?.text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function listToolNames() {
    try {
      return ((await rpc("tools/list"))?.tools ?? []).map((t) => t.name);
    } catch {
      return [];
    }
  }

  return { rpc, tool, listToolNames };
}
