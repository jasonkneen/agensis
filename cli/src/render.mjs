// Output formatting. Every function here is pure: it takes values and returns a
// string. Nothing in this file touches process.stdout, the network or the clock,
// so the invariants below can be tested without a running anything.

// Every agensis credential prefix that exists today:
//   aga_  per-agent connect token   (server/index.cjs createAgentConnectToken)
//   agw_  workspace MCP token       (server/index.cjs createWorkspaceMcpToken)
//   agx_  Flows connection token    (server/flow-integration.cjs)
//   agf_  farm token                (server/farm-integration.cjs)
//   cbk_  cursor-buddy key          (server/index.cjs)
const TOKEN_PATTERN = /\b(?:aga|agw|agx|agf|cbk)_[A-Za-z0-9_-]+/g;

/**
 * Strip credentials from anything about to be written to a stream.
 *
 * Two mechanisms, and the second is the one that matters. The regex catches
 * prefixed tokens that arrive in a SERVER response we did not mint. But a user
 * login token — which `verifyMcpToken` accepts, resolving to the workspace that
 * user owns — has NO recognisable prefix, so a regex alone would print it in
 * full. `extraSecrets` is the exact token string this process resolved, so the
 * credential we are actually holding is redacted by identity rather than by
 * pattern.
 */
export function redact(text, extraSecrets = []) {
  let out = String(text ?? '');
  for (const secret of extraSecrets) {
    const s = String(secret || '');
    // A very short "secret" would turn the output into confetti; anything that
    // short is not a credential.
    if (s.length < 8) continue;
    out = out.split(s).join('[redacted]');
  }
  return out.replace(TOKEN_PATTERN, '[redacted]');
}

/** Ids are uuids; 8 chars is enough to eyeball and to paste back into a flag. */
export function truncateId(value, full = false) {
  const s = String(value ?? '');
  if (full || s.length <= 12) return s;
  return `${s.slice(0, 8)}…`;
}

export function formatTimestamp(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Machine output is the DEFAULT when stdout is not a terminal. A subprocess or a
 * pipe gets JSON with no flag; a human at a prompt gets columns. Explicit flags
 * win over both.
 */
export function chooseFormat({ json = false, human = false, isTTY = false } = {}) {
  if (json && human) return { ok: false, message: 'Pass either --json or --human, not both.' };
  if (json) return { ok: true, format: 'json' };
  if (human) return { ok: true, format: 'human' };
  return { ok: true, format: isTTY ? 'human' : 'json' };
}

function cell(value, fullIds) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  // Anything shaped like a uuid gets shortened unless asked otherwise.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return truncateId(s, fullIds);
  return s.replace(/\s+/g, ' ').trim();
}

/** Left-aligned columns sized to their content. No colour, no box drawing. */
export function formatTable(rows, columns, { fullIds = false, maxWidth = 60 } = {}) {
  if (!rows.length) return '(none)';
  const clip = (s) => (s.length > maxWidth ? `${s.slice(0, maxWidth - 1)}…` : s);
  const body = rows.map((row) => columns.map((c) => clip(cell(row[c], fullIds))));
  const widths = columns.map((c, i) => Math.max(
    c.length,
    ...body.map((r) => r[i].length),
  ));
  const line = (cells) => cells.map((s, i) => s.padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

/**
 * The human view of an arbitrary tool result. Deliberately dumb: if the result
 * is `{ <key>: [ ...rows ] }` it becomes a table, otherwise it is pretty JSON.
 * It must stay dumb — a renderer that knows the shape of `list_channels` is a
 * second place that has to be updated when the tool changes, which is exactly
 * the drift this CLI is built to avoid.
 */
export function renderHuman(value, { fullIds = false } = {}) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return renderRows(value, { fullIds });

  const keys = Object.keys(value);
  const arrayKeys = keys.filter((k) => Array.isArray(value[k]));
  if (arrayKeys.length === 1 && keys.length <= 3) {
    const rest = keys.filter((k) => k !== arrayKeys[0]);
    const head = rest.map((k) => `${k}: ${cell(value[k], fullIds)}`).join('\n');
    const table = renderRows(value[arrayKeys[0]], { fullIds });
    return head ? `${head}\n\n${table}` : table;
  }
  return keys.map((k) => `${k}: ${cell(value[k], fullIds)}`).join('\n');
}

function renderRows(rows, { fullIds }) {
  if (!Array.isArray(rows) || !rows.length) return '(none)';
  if (rows.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
    return rows.map((r) => cell(r, fullIds)).join('\n');
  }
  // Column order: first-seen wins, so the tool's own field order survives.
  const columns = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  return formatTable(rows, columns.slice(0, 8), { fullIds });
}
