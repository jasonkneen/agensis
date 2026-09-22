export type PositionedMessage = {
  id: string;
  created_at: string;
};

/**
 * Canonical message order. Postgres timestamps are not unique (one transaction
 * commonly stamps several rows identically), so every consumer must use the
 * same `(created_at, id)` tuple as the backend keyset queries.
 */
export function compareMessagePosition(
  left: PositionedMessage,
  right: PositionedMessage,
): number {
  const time = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (time !== 0) return time;
  // Date.parse truncates fractional seconds to milliseconds. History cursors
  // preserve Postgres microseconds, which must sort before the UUID tie-break.
  const micros = fractionalMicros(left.created_at) - fractionalMicros(right.created_at);
  if (micros !== 0) return micros;
  return String(left.id).localeCompare(String(right.id));
}

function fractionalMicros(timestamp: string): number {
  const fraction = timestamp.match(/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1] ?? '';
  return Number(fraction.padEnd(6, '0').slice(3, 6));
}
