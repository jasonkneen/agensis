// The exit-code taxonomy. This is the whole point of the CLI existing: a shell
// pipeline has to be able to branch on WHY something failed, and until now the
// only signal any agensis entry point produced was "1".
//
// Codes 0-7 are the ones derivable today with no server change. 8 and 9 are
// RESERVED, not unused-by-accident: the MCP server currently returns tool
// failures as `{ isError: true, content: [{ type: 'text', text }] }` with no
// machine-readable code (server/mcp.cjs `toolError`), so "channel not found",
// "forbidden" and "bad argument" are indistinguishable without string-matching
// English error text, which this CLI refuses to do. When the server grows a
// `_meta.code`, those two split out of 5 WITHOUT renumbering anything else, so
// a script written against this table keeps working — it just stops seeing
// everything as 5.
export const EXIT = Object.freeze({
  OK: 0,
  // Catch-all. Preserved as the meaning of 1 so that "something went wrong" in a
  // script written against any older agensis binary still holds.
  INTERNAL: 1,
  // Local: unknown command, unknown flag, missing required argument, or an
  // alias whose arguments no longer match the server's schema. NO REQUEST SENT.
  USAGE: 2,
  // HTTP 401 from the MCP door, or no token resolvable at all.
  AUTH: 3,
  // HTTP 429. `Retry-After` is echoed to stderr.
  RATE_LIMITED: 4,
  // The tool ran and refused: JSON-RPC result with `isError: true`.
  TOOL_ERROR: 5,
  // DNS / connect / timeout / non-JSON body. Includes the very common "pointed
  // at agensis.io and got the SPA's HTML back" case, which must be a named
  // error and not a JSON parse crash.
  TRANSPORT: 6,
  // A JSON-RPC `error` object: -32601 unknown method, -32600 invalid request,
  // -32001 unauthorized-at-the-protocol-level.
  PROTOCOL: 7,
});

// Reserved for when server-side tool errors carry a machine code. Declared here
// so nobody reuses the numbers for something else in the meantime.
export const RESERVED_EXIT = Object.freeze({
  NOT_FOUND: 8,
  FORBIDDEN: 9,
});

export const EXIT_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(EXIT).map(([name, code]) => [code, name])),
);
