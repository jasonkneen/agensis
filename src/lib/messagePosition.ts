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
  return String(left.id).localeCompare(String(right.id));
}
